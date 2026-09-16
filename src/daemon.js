import fs from "node:fs";
import process from "node:process";
import { profileFor, receiveAttachment } from "./agent.js";
import { RoomConnection } from "./client.js";
import { loadConfig } from "./config.js";
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
  let config = loadConfig();
  const connections = new Map();
  const seen = new Set(session.readInbox().map(entryKey));
  log(`daemon started for session ${session.key} (project ${meta.project})`);

  const writeStatus = () => {
    const rooms = {};
    for (const [room, c] of connections) {
      rooms[room] = { handle: c.welcome?.you?.handle || null, connected: c.connected, error: c.connected ? null : c.lastError };
    }
    session.writeStatus({ pid: process.pid, rooms });
  };

  const deliver = async (conn, m) => {
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

  const onState = (conn) => {
    const handle = conn.welcome?.you?.handle;
    if (conn.connected && handle && session.rooms[conn.room] && session.rooms[conn.room].handle !== handle) {
      session.updateRoom(conn.room, { handle });
    }
    writeStatus();
  };

  const shutdown = (reason) => {
    log(`daemon stopping: ${reason}`);
    for (const c of connections.values()) c.stop();
    connections.clear();
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
    if (!config.url) config = loadConfig();
    if (!config.url) return;

    const wanted = session.rooms;
    for (const [room, c] of connections) {
      if (!wanted[room]) {
        c.stop();
        connections.delete(room);
        log(`left ${room}`);
      }
    }
    for (const room of Object.keys(wanted)) {
      if (connections.has(room)) continue;
      const conn = new RoomConnection({
        url: config.url,
        token: config.token,
        room,
        agentId: session.key,
        profile: profileFor(session, room),
        onDeliver: deliver,
        onState,
        log,
      }).start();
      connections.set(room, conn);
      log(`connecting to ${room}`);
    }
    writeStatus();
  };

  reconcile();
  setInterval(reconcile, TICK_MS);
}
