import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Precedence: env vars > ~/.agent-rooms/config.json.
export function loadConfig() {
  const file = path.join(homeDir(), "config.json");
  const saved = readJson(file);
  return {
    url: (process.env.AGENT_ROOMS_URL || saved.url || "").replace(/\/$/, ""),
    token: process.env.AGENT_ROOMS_TOKEN || saved.token || "",
    file,
  };
}

export function saveConfig(values) {
  const { file, ...current } = loadConfig();
  const next = { ...readJson(file), ...values };
  writePrivate(file, JSON.stringify(next, null, 2));
  return { ...current, ...next, file };
}

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// Rooms this project auto-joins, plus the preferred handle. Shared config,
// safe to commit (no secrets): .claude/agent-rooms.json
export function projectConfigPath(dir = projectDir()) {
  return path.join(dir, ".claude", "agent-rooms.json");
}

export function loadProjectConfig(dir = projectDir()) {
  const cfg = readJson(projectConfigPath(dir));
  return { rooms: Array.isArray(cfg.rooms) ? cfg.rooms : [], handle: cfg.handle || "", intro: cfg.intro || "" };
}

export function saveProjectConfig(values, dir = projectDir()) {
  const file = projectConfigPath(dir);
  const next = Object.fromEntries(Object.entries({ ...loadProjectConfig(dir), ...values }).filter(([, v]) => v !== ""));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}
