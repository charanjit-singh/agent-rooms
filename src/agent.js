import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHUNK_BYTES, mentionsIn, RoomConnection } from "./client.js";
import { homeDir, loadProjectConfig, parseRoomRef, writePrivate } from "./config.js";
import { loadIdentity, openSealed, sealForRecipients } from "./crypto.js";

export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";

export function profileFor(session, key, overrides = {}) {
  const meta = session.meta || {};
  const projectDir = meta.project || process.cwd();
  const project = loadProjectConfig(projectDir);
  const rooms = session.rooms;
  const saved = rooms[key] || {};
  const host = os.hostname().split(".")[0];
  const fallbackHandle = meta.human ? os.userInfo().username : `${path.basename(projectDir)}-${host}`;
  // An agent keeps one identity: reuse the handle it already has in other rooms.
  const handleElsewhere = Object.values(rooms).find((r) => r.handle)?.handle;
  const introElsewhere = Object.values(rooms).find((r) => r.intro)?.intro;
  return {
    handle: overrides.handle || saved.handle || handleElsewhere || project.handle || fallbackHandle,
    intro: overrides.intro || saved.intro || introElsewhere || project.intro || "",
    machine: host,
    project: path.basename(projectDir),
    publicKey: loadIdentity().publicKey,
  };
}

export function connectionFor({ server, room, key }, session, profile, extra = {}) {
  return new RoomConnection({ url: server.url, token: server.token, room, agentId: session.key, profile, ...extra });
}

// One-shot, passive connection for CLI commands. `ref` is "[server/]room".
export async function openRoom(session, ref, overrides = {}) {
  const target = typeof ref === "string" ? parseRoomRef(ref) : ref;
  const conn = connectionFor(target, session, profileFor(session, target.key, overrides), { passive: true, reconnect: false }).start();
  conn.target = target;
  let timer;
  try {
    await Promise.race([
      conn.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out connecting to ${target.key}`)), 20_000);
      }),
    ]);
  } catch (e) {
    conn.stop();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return conn;
}

export async function receiveAttachment(conn, m, projectDir) {
  const a = m.attachment;
  const chunks = [];
  let total = 1;
  for (let n = 0; n < total; n++) {
    const res = await conn.request({ type: "blob_get", blobId: a.blobId, n });
    total = res.total;
    chunks.push(Buffer.from(res.data, "base64"));
  }
  const plaintext = openSealed({ ciphertext: Buffer.concat(chunks), iv: a.iv, tag: a.tag, key: a.key, sha256: a.sha256 }, loadIdentity());

  if (a.secret) {
    const { value } = JSON.parse(plaintext.toString("utf8"));
    const file = path.join(homeDir(), "secrets", safeName(m.server), safeName(m.room), safeName(a.name));
    writePrivate(file, value);
    return file;
  }
  const roomsDir = path.join(projectDir, ".claude", "rooms");
  const file = path.join(roomsDir, safeName(m.server), safeName(m.room), "files", `${m.seq}-${safeName(a.name)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ignore = path.join(roomsDir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  fs.writeFileSync(file, plaintext);
  return file;
}

export async function shareAttachment(conn, agentId, message, plaintext, { name, secret }) {
  const handles = new Set(mentionsIn(message));
  const { members } = await conn.request({ type: "who" });
  const others = members.filter((m) => m.agentId !== agentId);
  const chosen = handles.has("all") || handles.has("everyone") ? others : others.filter((m) => handles.has(m.handle));
  if (!chosen.length) throw new Error("mention at least one other member (@handle or @all); see: agent-rooms status");
  const recipients = chosen.filter((m) => m.publicKey);
  const skipped = chosen.filter((m) => !m.publicKey).map((m) => m.handle);
  if (!recipients.length) throw new Error("none of the mentioned members have published an encryption key");

  const sealed = sealForRecipients(plaintext, recipients);
  const blobId = crypto.randomBytes(16).toString("hex");
  const total = Math.max(1, Math.ceil(sealed.ciphertext.length / CHUNK_BYTES));
  for (let n = 0; n < total; n++) {
    const data = sealed.ciphertext.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES).toString("base64");
    await conn.request({ type: "blob_put", blobId, n, total, data });
  }
  const res = await conn.request({
    type: "send",
    text: message,
    attachment: { blobId, name, size: plaintext.length, secret, iv: sealed.iv, tag: sealed.tag, keys: sealed.keys, sha256: sealed.sha256 },
  });
  return { seq: res.seq, recipients: recipients.map((r) => r.handle), skipped };
}
