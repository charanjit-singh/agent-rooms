import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { homeDir } from "./config.js";

const MAX_SURFACED = 2000;

export const safeKey = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);

export function sessionsRoot() {
  return path.join(homeDir(), "sessions");
}

export function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function entryKey(e) {
  return `${e.room}#${e.seq}`;
}

// Everything one Claude Code session (= one agent) keeps locally.
// Layout is part of the documented contract, see PROTOCOL.md §7.
export class Session {
  constructor(key) {
    this.key = safeKey(key);
    this.dir = path.join(sessionsRoot(), this.key);
  }

  static exists(key) {
    return !!key && fs.existsSync(path.join(sessionsRoot(), safeKey(key), "session.json"));
  }

  file(name) {
    return path.join(this.dir, name);
  }

  get meta() {
    return readJson(this.file("session.json"), null);
  }

  writeMeta(meta) {
    atomicWrite(this.file("session.json"), JSON.stringify(meta, null, 2));
  }

  // Desired membership: { room: { handle, intro } }. Written by the CLI, read by the daemon.
  get rooms() {
    return readJson(this.file("rooms.json"), {});
  }

  writeRooms(rooms) {
    atomicWrite(this.file("rooms.json"), JSON.stringify(rooms, null, 2));
  }

  updateRoom(room, values) {
    const rooms = this.rooms;
    if (values === null) delete rooms[room];
    else rooms[room] = { ...(rooms[room] || {}), ...values };
    this.writeRooms(rooms);
  }

  get status() {
    return readJson(this.file("status.json"), null);
  }

  writeStatus(status) {
    atomicWrite(this.file("status.json"), JSON.stringify({ ...status, updatedAt: Date.now() }, null, 2));
  }

  appendInbox(entry) {
    fs.appendFileSync(this.file("inbox.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  readInbox() {
    let raw = "";
    try {
      raw = fs.readFileSync(this.file("inbox.jsonl"), "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }

  unsurfaced() {
    const seen = new Set(readJson(this.file("surfaced.json"), []));
    return this.readInbox().filter((e) => !seen.has(entryKey(e)));
  }

  markSurfaced(entries) {
    if (!entries.length) return;
    const all = [...readJson(this.file("surfaced.json"), []), ...entries.map(entryKey)];
    atomicWrite(this.file("surfaced.json"), JSON.stringify([...new Set(all)].slice(-MAX_SURFACED)));
  }

  readPid(name) {
    try {
      return Number(fs.readFileSync(this.file(name), "utf8").trim()) || null;
    } catch {
      return null;
    }
  }

  writePid(name, pid = process.pid) {
    atomicWrite(this.file(name), String(pid));
  }

  daemonAlive() {
    return pidAlive(this.readPid("daemon.pid"));
  }

  log(name, line) {
    try {
      fs.appendFileSync(this.file(name), `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
}

function aliasFile(claudePid) {
  return path.join(homeDir(), "pids", safeKey(claudePid));
}

export function writePidAlias(claudePid, key) {
  if (claudePid) atomicWrite(aliasFile(claudePid), key);
}

// CLI commands run by Claude via Bash have to figure out which session they
// belong to. Order: --session flag, AGENT_ROOMS_SESSION (set via CLAUDE_ENV_FILE
// by the SessionStart hook), CLAUDE_CODE_SESSION_ID, CLAUDE_PID alias.
export function resolveSession(flag) {
  const candidates = [flag, process.env.AGENT_ROOMS_SESSION, process.env.CLAUDE_CODE_SESSION_ID];
  for (const c of candidates) if (Session.exists(c)) return new Session(c);
  if (process.env.CLAUDE_PID) {
    try {
      const key = fs.readFileSync(aliasFile(process.env.CLAUDE_PID), "utf8").trim();
      if (Session.exists(key)) return new Session(key);
    } catch {}
  }
  return null;
}

// A person using the CLI outside Claude Code gets a stable pseudo-agent so they
// can join, send and read history as themselves.
export function humanSession() {
  const user = safeKey(os.userInfo().username || "user");
  const s = new Session(`human-${user}-${safeKey(os.hostname().split(".")[0])}`);
  if (!s.meta) s.writeMeta({ sessionId: s.key, human: true, project: process.cwd(), startedAt: Date.now() });
  return s;
}
