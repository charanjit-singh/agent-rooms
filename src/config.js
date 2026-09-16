import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ROOM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function homeDir() {
  const dir = process.env.AGENT_ROOMS_HOME || path.join(os.homedir(), ".agent-rooms");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export const normalizeUrl = (url) => String(url || "").trim().replace(/\/+$/, "");

// ---------- servers: ~/.agent-rooms/servers/<name>.json (PROTOCOL.md §7.1) ----------

function serversDir() {
  return path.join(homeDir(), "servers");
}

function globalConfigFile() {
  return path.join(homeDir(), "config.json");
}

export function validateServerName(name) {
  const n = String(name || "").toLowerCase();
  if (!SERVER_NAME_RE.test(n)) throw new Error(`invalid server name "${name}": use a-z 0-9 - (max 32, start alphanumeric)`);
  return n;
}

export function listServers() {
  let files = [];
  try {
    files = fs.readdirSync(serversDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => readJson(path.join(serversDir(), f), null))
    .filter((s) => s && SERVER_NAME_RE.test(s.name || "") && s.url)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getServer(name) {
  if (!name || !SERVER_NAME_RE.test(name)) return null;
  const s = readJson(path.join(serversDir(), `${name}.json`), null);
  return s && s.url ? s : null;
}

export function serverByUrl(url) {
  const u = normalizeUrl(url);
  return listServers().find((s) => normalizeUrl(s.url) === u) || null;
}

export function saveServer(server) {
  const name = validateServerName(server.name);
  const existing = getServer(name) || {};
  const next = { ...existing, ...server, name, url: normalizeUrl(server.url || existing.url), addedAt: existing.addedAt || Date.now() };
  writePrivate(path.join(serversDir(), `${name}.json`), JSON.stringify(next, null, 2) + "\n");
  if (!getServer(readJson(globalConfigFile()).defaultServer)) setDefaultServer(name);
  return next;
}

export function removeServer(name) {
  fs.rmSync(path.join(serversDir(), `${validateServerName(name)}.json`), { force: true });
  if (readJson(globalConfigFile()).defaultServer === name) {
    const next = listServers()[0]?.name || null;
    writePrivate(globalConfigFile(), JSON.stringify({ ...readJson(globalConfigFile()), defaultServer: next }, null, 2) + "\n");
  }
}

export function setDefaultServer(name) {
  const n = validateServerName(name);
  writePrivate(globalConfigFile(), JSON.stringify({ ...readJson(globalConfigFile()), defaultServer: n }, null, 2) + "\n");
}

// Default server: AGENT_ROOMS_SERVER > config.json defaultServer > the only server.
export function defaultServerName() {
  const fromEnv = process.env.AGENT_ROOMS_SERVER;
  if (fromEnv && getServer(fromEnv)) return fromEnv;
  const saved = readJson(globalConfigFile()).defaultServer;
  if (saved && getServer(saved)) return saved;
  const all = listServers();
  return all.length === 1 ? all[0].name : null;
}

export const NOT_CONFIGURED =
  "no agent-rooms server configured.\n  Deploy your own relay:   agent-rooms deploy   (needs a Cloudflare account; uses wrangler)\n  Or add an existing one:  agent-rooms server add <name> --url <url> --token <token>";

// "[server/]room" -> { server, room, key: "server/room" }
export function parseRoomRef(ref) {
  const raw = String(ref || "").trim().toLowerCase();
  const slash = raw.indexOf("/");
  const serverName = slash === -1 ? defaultServerName() : raw.slice(0, slash);
  const room = slash === -1 ? raw : raw.slice(slash + 1);
  if (!ROOM_RE.test(room)) throw new Error(`invalid room "${ref}": use [server/]room with room a-z 0-9 . _ - (max 64)`);
  if (!serverName) throw new Error(listServers().length ? `"${ref}" has no server and no default is set: use <server>/${room} or agent-rooms server default <name>` : NOT_CONFIGURED);
  const server = getServer(serverName);
  if (!server) throw new Error(`unknown server "${serverName}" (see: agent-rooms server list)`);
  return { server, room, key: `${server.name}/${room}` };
}

// ---------- project: .claude/agent-rooms.json ----------
// Rooms are recorded by server URL (never local names or tokens) so the file
// can be committed and works on machines that named the server differently.

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function projectConfigPath(dir = projectDir()) {
  return path.join(dir, ".claude", "agent-rooms.json");
}

export function loadProjectConfig(dir = projectDir()) {
  const cfg = readJson(projectConfigPath(dir));
  const rooms = (Array.isArray(cfg.rooms) ? cfg.rooms : []).filter((r) => r && typeof r.server === "string" && typeof r.room === "string");
  return { rooms, handle: cfg.handle || "", intro: cfg.intro || "" };
}

export function saveProjectConfig(values, dir = projectDir()) {
  const file = projectConfigPath(dir);
  const next = Object.fromEntries(Object.entries({ ...loadProjectConfig(dir), ...values }).filter(([, v]) => v !== ""));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function rememberProjectRoom(dir, server, room) {
  const { rooms } = loadProjectConfig(dir);
  const url = normalizeUrl(server.url);
  if (!rooms.some((r) => normalizeUrl(r.server) === url && r.room === room)) {
    saveProjectConfig({ rooms: [...rooms, { server: url, room }] }, dir);
  }
}

export function forgetProjectRoom(dir, server, room) {
  const { rooms } = loadProjectConfig(dir);
  const url = normalizeUrl(server.url);
  saveProjectConfig({ rooms: rooms.filter((r) => !(normalizeUrl(r.server) === url && r.room === room)) }, dir);
}
