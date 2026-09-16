const PROTOCOL_VERSION = 1;
const MAX_MESSAGES = 500;
const MAX_REPLAY = 50;
const MEMBER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MENTION_RE = /(^|[^a-z0-9._-])@([a-z0-9][a-z0-9._-]{0,31})/gi;
const MAX_TEXT = 4000;
const MAX_CONTEXT = 16000;
const MAX_CHUNK_B64 = 400_000;
const MAX_BLOB_CHUNKS = 80;
const BLOB_TTL_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(12, "0");

function sanitizeHandle(raw) {
  const h = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return HANDLE_RE.test(h) ? h : "agent";
}

// Every agent only ever receives: @mentions of itself, @all, and intros.
// Routing happens here, so plain chatter never leaves the Durable Object.
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.name = (await this.state.storage.get("name")) || null;
    this.members = new Map(Object.entries((await this.state.storage.get("members")) || {}));
    this.seq = (await this.state.storage.get("seq")) || 0;
    this.loaded = true;
  }

  saveMembers() {
    return this.state.storage.put("members", Object.fromEntries(this.members));
  }

  online(agentId) {
    return this.state.getWebSockets(agentId).length > 0;
  }

  memberView(m, agentId) {
    return {
      handle: m.handle,
      agentId,
      publicKey: m.publicKey,
      machine: m.machine,
      project: m.project,
      intro: m.intro,
      online: this.online(agentId),
      lastSeen: m.lastSeen,
    };
  }

  roster() {
    return [...this.members].map(([id, m]) => this.memberView(m, id));
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const roomName = decodeURIComponent(url.pathname.split("/")[2] || "");
    if (!this.name && roomName) {
      this.name = roomName;
      await this.state.storage.put("name", roomName);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId || agentId.length > 128) return new Response("agentId required", { status: 400 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [agentId]);
      server.serializeAttachment({ agentId });
      const headers = new Headers();
      if (request.headers.get("Sec-WebSocket-Protocol")) headers.set("Sec-WebSocket-Protocol", "agent-rooms");
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    if (url.pathname.endsWith("/status") && request.method === "GET") {
      return Response.json({
        room: this.name,
        members: this.roster(),
        messages: this.seq,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    const { agentId } = ws.deserializeAttachment() || {};
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ type: "error", error: "bad json" }));
    }
    const reply = (payload) => ws.send(JSON.stringify({ ...payload, reqId: msg.reqId }));
    const now = Date.now();
    const me = this.members.get(agentId);

    if (msg.type !== "hello" && !me) return reply({ type: "error", error: "send hello first" });

    switch (msg.type) {
      case "hello":
        return this.hello(ws, agentId, msg, reply, now);

      case "heartbeat":
        me.lastSeen = now;
        return this.saveMembers();

      case "send":
        return this.send(agentId, me, msg, reply, now);

      case "ack": {
        const upTo = Math.min(Number(msg.upTo) || 0, this.seq);
        if (upTo > (me.acked || 0)) {
          me.acked = upTo;
          await this.saveMembers();
        }
        return;
      }

      case "who":
        return reply({ type: "who", room: this.name, members: this.roster() });

      case "history": {
        const limit = Math.min(Number(msg.limit) || 20, MAX_REPLAY);
        const list = await this.state.storage.list({ prefix: "msg:", reverse: true, limit });
        const messages = [...list.values()].reverse().map((e) => publicMessage(e, agentId));
        return reply({ type: "history", room: this.name, messages });
      }

      // Encrypted attachment relay. The worker only ever holds ciphertext;
      // content keys are wrapped per recipient public key by the sender.
      case "blob_put": {
        const { blobId, n, total, data } = msg;
        if (!/^[a-f0-9]{32}$/.test(blobId || "")) return reply({ type: "error", error: "bad blobId" });
        if (!(total >= 1 && total <= MAX_BLOB_CHUNKS && n >= 0 && n < total)) return reply({ type: "error", error: "file too large" });
        if (typeof data !== "string" || data.length > MAX_CHUNK_B64) return reply({ type: "error", error: "chunk too large" });
        const metaKey = `blob:${blobId}:meta`;
        const meta = (await this.state.storage.get(metaKey)) || { owner: agentId, total, createdAt: now, allowed: [] };
        if (meta.owner !== agentId) return reply({ type: "error", error: "not your blob" });
        await this.state.storage.put({ [metaKey]: meta, [`blob:${blobId}:${n}`]: data });
        await this.ensureAlarm(now);
        return reply({ type: "blob_put", ok: true, blobId, n });
      }

      case "blob_get": {
        const meta = await this.state.storage.get(`blob:${msg.blobId}:meta`);
        if (!meta || !meta.allowed.includes(agentId)) return reply({ type: "error", error: "blob not found" });
        const data = await this.state.storage.get(`blob:${msg.blobId}:${msg.n}`);
        if (data === undefined) return reply({ type: "error", error: "chunk missing" });
        return reply({ type: "blob_chunk", blobId: msg.blobId, n: msg.n, total: meta.total, data });
      }

      case "leave": {
        this.members.delete(agentId);
        await this.saveMembers();
        reply({ type: "left", room: this.name });
        return ws.close(1000, "left");
      }

      default:
        return reply({ type: "error", error: `unknown type ${msg.type}` });
    }
  }

  async hello(ws, agentId, msg, reply, now) {
    for (const [id, m] of this.members) {
      if (id !== agentId && !this.online(id) && now - m.lastSeen > MEMBER_EXPIRY_MS) this.members.delete(id);
    }

    let member = this.members.get(agentId);
    const isNew = !member;
    const wanted = sanitizeHandle(msg.handle);
    const taken = (h) => [...this.members].some(([id, m]) => id !== agentId && m.handle === h);
    let handle = wanted;
    for (let i = 2; taken(handle); i++) handle = `${wanted.slice(0, 28)}-${i}`;

    member = {
      ...(member || { joinedAt: now, acked: this.seq }),
      handle,
      publicKey: String(msg.publicKey || member?.publicKey || "").slice(0, 200),
      machine: String(msg.machine || "").slice(0, 64),
      project: String(msg.project || "").slice(0, 128),
      intro: String(msg.intro || member?.intro || "").slice(0, 500),
      lastSeen: now,
    };
    this.members.set(agentId, member);
    await this.saveMembers();

    if (isNew) {
      if (this.members.size === 1) this.registerRoom();
      await this.post(agentId, { kind: "intro", text: member.intro || `${handle} joined`, context: "" }, now);
    }

    const pending = await this.pendingFor(agentId, member);
    reply({ type: "welcome", protocol: PROTOCOL_VERSION, room: this.name, you: { handle, agentId }, members: this.roster(), pending });
  }

  async send(agentId, me, msg, reply, now) {
    const text = String(msg.text || "").slice(0, MAX_TEXT);
    if (!text.trim()) return reply({ type: "error", error: "empty message" });
    const context = String(msg.context || "").slice(0, MAX_CONTEXT);

    const handles = new Set();
    for (const [, , h] of text.matchAll(MENTION_RE)) handles.add(h.toLowerCase());
    const toAll = handles.has("all") || handles.has("everyone");
    const byHandle = new Map([...this.members].map(([id, m]) => [m.handle, id]));
    const to = toAll ? [] : [...handles].map((h) => byHandle.get(h)).filter((id) => id && id !== agentId);
    const unknown = toAll ? [] : [...handles].filter((h) => !byHandle.has(h));

    let attachment = null;
    if (msg.attachment) {
      const a = msg.attachment;
      const metaKey = `blob:${a.blobId}:meta`;
      const meta = await this.state.storage.get(metaKey);
      if (!meta || meta.owner !== agentId) return reply({ type: "error", error: "upload the attachment first" });
      const recipients = toAll ? [...this.members.keys()].filter((id) => id !== agentId) : to;
      if (!recipients.length) return reply({ type: "error", error: "attachments need @mentions or @all" });
      meta.allowed = recipients.filter((id) => a.keys?.[id]);
      await this.state.storage.put(metaKey, meta);
      attachment = {
        blobId: a.blobId,
        name: String(a.name || "file").slice(0, 200),
        size: Number(a.size) || 0,
        secret: !!a.secret,
        iv: String(a.iv || ""),
        tag: String(a.tag || ""),
        keys: a.keys || {},
        sha256: String(a.sha256 || ""),
      };
    }

    const entry = await this.post(
      agentId,
      { kind: toAll ? "all" : to.length ? "mention" : "note", text, context, to, replyTo: msg.replyTo || null, attachment },
      now
    );
    me.lastSeen = now;
    await this.saveMembers();

    const delivered = toAll
      ? [...this.members.keys()].filter((id) => id !== agentId).map((id) => this.members.get(id).handle)
      : to.filter((id) => id !== agentId).map((id) => this.members.get(id).handle);
    reply({ type: "sent", seq: entry.seq, delivered, unknown });
  }

  // Persist, then push to online recipients. Offline recipients get it from
  // pendingFor() on their next hello, based on their ack cursor.
  async post(agentId, { kind, text, context, to = [], replyTo = null, attachment = null }, now) {
    const from = this.members.get(agentId);
    const entry = {
      seq: ++this.seq,
      kind,
      room: this.name,
      from: from.handle,
      fromMachine: from.machine,
      to: to.map((id) => this.members.get(id)?.handle).filter(Boolean),
      toIds: to,
      fromId: agentId,
      text,
      context,
      replyTo,
      attachment,
      ts: now,
    };
    await this.state.storage.put({ seq: this.seq, [`msg:${pad(entry.seq)}`]: entry });
    if (this.seq > MAX_MESSAGES) await this.state.storage.delete(`msg:${pad(this.seq - MAX_MESSAGES)}`);

    for (const id of this.recipients(entry)) {
      const payload = JSON.stringify({ type: "deliver", message: publicMessage(entry, id) });
      for (const sock of this.state.getWebSockets(id)) {
        try {
          sock.send(payload);
        } catch {}
      }
    }
    return entry;
  }

  async ensureAlarm(now) {
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(now + BLOB_TTL_MS);
  }

  async alarm() {
    const now = Date.now();
    const metas = await this.state.storage.list({ prefix: "blob:" });
    const expired = new Set();
    let remaining = false;
    for (const [key, value] of metas) {
      if (!key.endsWith(":meta")) continue;
      const id = key.split(":")[1];
      if (now - value.createdAt >= BLOB_TTL_MS) expired.add(id);
      else remaining = true;
    }
    const doomed = [...metas.keys()].filter((k) => expired.has(k.split(":")[1]));
    for (let i = 0; i < doomed.length; i += 128) await this.state.storage.delete(doomed.slice(i, i + 128));
    if (remaining) await this.state.storage.setAlarm(now + 60 * 60 * 1000);
  }

  recipients(entry) {
    if (entry.kind === "all" || entry.kind === "intro") {
      return [...this.members.keys()].filter((id) => id !== entry.fromId);
    }
    if (entry.kind === "mention") return entry.toIds.filter((id) => id !== entry.fromId);
    return [];
  }

  async pendingFor(agentId, member) {
    const start = `msg:${pad((member.acked || 0) + 1)}`;
    const list = await this.state.storage.list({ prefix: "msg:", start, limit: 500 });
    const out = [];
    for (const entry of list.values()) {
      if (this.recipients(entry).includes(agentId)) out.push(publicMessage(entry, agentId));
    }
    return out.slice(-MAX_REPLAY);
  }

  registerRoom() {
    const stub = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    this.state.waitUntil(
      stub
        .fetch("https://registry/rooms", { method: "POST", body: JSON.stringify({ name: this.name }) })
        .catch(() => {})
    );
  }

  async webSocketClose(ws) {
    await this.load();
    const { agentId } = ws.deserializeAttachment() || {};
    const m = this.members.get(agentId);
    if (m) {
      m.lastSeen = Date.now();
      await this.saveMembers();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}

function publicMessage(e, recipientId) {
  const { toIds, fromId, attachment, ...rest } = e;
  if (!attachment) return rest;
  const { keys, ...att } = attachment;
  return { ...rest, attachment: { ...att, key: keys[recipientId] || null } };
}
