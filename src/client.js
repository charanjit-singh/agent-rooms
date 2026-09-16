import crypto from "node:crypto";

export const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
export const CHUNK_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MENTION_RE = /(^|[^a-z0-9._-])@([a-z0-9][a-z0-9._-]{0,31})/gi;

export function mentionsIn(text) {
  return [...String(text).matchAll(MENTION_RE)].map((m) => m[2].toLowerCase());
}

// A self-reconnecting WebSocket to one room.
// passive: for one-shot CLI commands. Never processes or acks deliveries, so
// messages stay pending for the session daemon that actually stores them.
export class RoomConnection {
  constructor({ url, token, room, agentId, profile, onDeliver = async () => {}, onState, log = () => {}, passive = false, reconnect = true }) {
    Object.assign(this, { url, token, room, agentId, profile, onDeliver, onState, log, passive, reconnect });
    this.pending = new Map();
    this.backoff = 1000;
    this.stopped = false;
    this.connected = false;
    this.welcome = null;
    this.failures = 0;
    this.lastError = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
  }

  start() {
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped) return;
    const wsUrl = `${this.url.replace(/^http/, "ws")}/rooms/${encodeURIComponent(this.room)}/connect?agentId=${encodeURIComponent(this.agentId)}`;
    const protocols = ["agent-rooms"];
    if (this.token) protocols.push(`token.${this.token}`);
    let ws;
    try {
      ws = new WebSocket(wsUrl, protocols);
    } catch (e) {
      return this.fail(e.message);
    }
    this.ws = ws;
    let opened = false;

    ws.addEventListener("open", async () => {
      opened = true;
      this.backoff = 1000;
      this.failures = 0;
      try {
        const welcome = await this.request({ type: "hello", v: PROTOCOL_VERSION, ...this.profile });
        this.welcome = welcome;
        this.connected = true;
        this.lastError = null;
        if (!this.passive) {
          let maxSeq = 0;
          for (const m of welcome.pending || []) {
            await this.onDeliver(this, m);
            maxSeq = Math.max(maxSeq, m.seq);
          }
          if (maxSeq) this.ack(maxSeq);
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => this.sendRaw({ type: "heartbeat" }), HEARTBEAT_MS);
        }
        this.onState?.(this);
        this.resolveReady(welcome);
      } catch (e) {
        this.lastError = e.message;
        this.log(`[${this.room}] hello failed: ${e.message}`);
        ws.close();
      }
    });

    ws.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString());
      } catch {
        return;
      }
      if (msg.reqId && this.pending.has(msg.reqId)) {
        const { resolve, reject, timer } = this.pending.get(msg.reqId);
        clearTimeout(timer);
        this.pending.delete(msg.reqId);
        return msg.type === "error" ? reject(new Error(msg.error)) : resolve(msg);
      }
      if (msg.type === "deliver" && !this.passive) {
        try {
          await this.onDeliver(this, msg.message);
          this.ack(msg.message.seq);
        } catch (e) {
          this.log(`[${this.room}] deliver failed: ${e.message}`);
        }
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(this.heartbeat);
      const wasConnected = this.connected;
      this.connected = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("connection closed"));
      }
      this.pending.clear();
      if (wasConnected) this.onState?.(this);
      if (!opened) this.failures++;
      this.fail(event.reason || `closed (code ${event.code})`);
    });

    ws.addEventListener("error", () => {});
  }

  fail(reason) {
    if (this.stopped) return;
    // A handshake that never opens is almost always a bad URL or token.
    if (!this.welcome && (this.failures >= 3 || !this.reconnect)) {
      this.lastError = `cannot connect to ${this.url} (check the worker URL and token: agent-rooms doctor)`;
      this.rejectReady(new Error(this.lastError));
    }
    if (!this.reconnect) return;
    this.log(`[${this.room}] disconnected (${reason}), retrying in ${this.backoff / 1000}s`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  sendRaw(payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
  }

  ack(upTo) {
    this.sendRaw({ type: "ack", upTo });
  }

  request(payload, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== 1) return reject(new Error(`not connected to room "${this.room}"`));
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("request timed out"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, reqId }));
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    try {
      this.ws?.close(1000, "bye");
    } catch {}
  }
}
