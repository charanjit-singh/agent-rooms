import fs from "node:fs";
import process from "node:process";
import { connectionFor, profileFor, receiveAttachment } from "./agent.js";
import { getServer } from "./config.js";
import { entryKey, pidAlive, Session } from "./store.js";

const TICK_MS = 2000;

export async function runDaemon(sessionKey) {
  const session = new Session(sessionKey);
  const meta = session.meta;
  if (!meta) throw new Error(`unknown session ${sessionKey}`);
  if (session.daemonAlive() && session.readPid("daemon.pid") !== process.pid) return;
  session.writePid("daemon.pid");
  fs.rmSync(session.file("stop"), { force: true });

  const log = (line) => session.log("daemon.log", line);
  const connections = new Map(); // "server/room" -> RoomConnection
  const problems = new Map(); // "server/room" -> reason it isn't connected
  const seen = new Set(session.readInbox().map(entryKey));
  log(`daemon started for session ${session.key} (project ${meta.project})`);

  const writeStatus = () => {
    const rooms = {};
    for (const key of Object.keys(session.rooms)) {
      const c = connections.get(key);
      rooms[key] = c
        ? { handle: c.welcome?.you?.handle || null, connected: c.connected, error: c.connected ? null : c.lastError }
        : { handle: null, connected: false, error: problems.get(key) || "not connected" };
    }
    session.writeStatus({ pid: process.pid, rooms });
  };

  const deliver = (serverName) => async (conn, m) => {
    m.server = serverName;
    const key = entryKey(m);
    if (seen.has(key)) return;
    if (m.attachment) {
      try {
        m.attachment.savedTo = await receiveAttachment(conn, m, meta.project);
      } catch (e) {
        m.attachment.error = e.message;
      }
      delete m.attachment.key;
      delete m.attachment.iv;
      delete m.attachment.tag;
    }
    seen.add(key);
    session.appendInbox(m);
    log(`stored ${key} from @${m.from} (${m.kind})`);
  };

  const onState = (key) => (conn) => {
    const handle = conn.welcome?.you?.handle;
    const entry = session.rooms[key];
    if (conn.connected && handle && entry && entry.handle !== handle) session.updateRoom(key, { handle });
    writeStatus();
  };

  const stopConn = (key) => {
    connections.get(key)?.stop();
    connections.delete(key);
  };

  const shutdown = (reason) => {
    log(`daemon stopping: ${reason}`);
    for (const key of [...connections.keys()]) stopConn(key);
    writeStatus();
    fs.rmSync(session.file("daemon.pid"), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const reconcile = () => {
    if (fs.existsSync(session.file("stop"))) return shutdown("stop requested");
    if (meta.claudePid && !pidAlive(meta.claudePid)) return shutdown("claude process exited");
    if (session.readPid("daemon.pid") !== process.pid) return shutdown("replaced by another daemon");

    const wanted = session.rooms;
    for (const key of [...connections.keys()]) {
      if (!wanted[key]) {
        stopConn(key);
        log(`left ${key}`);
      }
    }
    for (const [key, entry] of Object.entries(wanted)) {
      const server = getServer(entry.server);
      const existing = connections.get(key);
      if (!server) {
        if (existing) stopConn(key);
        problems.set(key, `server "${entry.server}" is not configured on this machine`);
        continue;
      }
      problems.delete(key);
      // Server URL or token edited under us: reconnect with the new settings.
      if (existing && (existing.url !== server.url || existing.token !== server.token)) {
        stopConn(key);
        log(`server ${server.name} changed, reconnecting ${key}`);
      }
      if (connections.has(key)) continue;
      const conn = connectionFor({ server, room: entry.room, key }, session, profileFor(session, key), {
        onDeliver: deliver(server.name),
        onState: onState(key),
        log,
      }).start();
      connections.set(key, conn);
      log(`connecting to ${key}`);
    }
    writeStatus();
  };

  reconcile();
  setInterval(reconcile, TICK_MS);
}
