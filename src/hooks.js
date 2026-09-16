import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, serverByUrl } from "./config.js";
import { formatForModel } from "./format.js";
import { pidAlive, Session, writePidAlias } from "./store.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-rooms");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = "";
    const done = () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function looksLikeClaude(pid) {
  try {
    return /claude/i.test(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

// The daemon exits when this process does, so a wrong guess would kill it
// immediately; return null (rely on SessionEnd) rather than guess.
function detectClaudePid() {
  if (process.env.CLAUDE_PID) return Number(process.env.CLAUDE_PID);
  if (process.platform === "win32") return null;
  if (looksLikeClaude(process.ppid)) return process.ppid;
  try {
    const grandparent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
    if (grandparent && looksLikeClaude(grandparent)) return grandparent;
  } catch {}
  return null;
}

export function ensureDaemon(session) {
  if (session.daemonAlive()) return false;
  const child = spawn(process.execPath, [BIN, "daemon", "--session", session.key], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return true;
}

async function sessionStart() {
  const input = await readStdin();
  if (!input.session_id) return;
  const session = new Session(input.session_id);
  const previous = session.meta;
  const project = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const claudePid = detectClaudePid();
  session.writeMeta({ sessionId: input.session_id, project, claudePid, startedAt: previous?.startedAt || Date.now(), source: input.source || null });
  writePidAlias(claudePid, session.key);
  fs.rmSync(session.file("stop"), { force: true });

  // Project rooms are recorded by server URL; map them onto this machine's server names.
  const missing = [];
  if (!fs.existsSync(session.file("rooms.json"))) {
    const seeded = {};
    for (const { server: url, room } of loadProjectConfig(project).rooms) {
      const server = serverByUrl(url);
      if (server) seeded[`${server.name}/${room}`] = { server: server.name, room };
      else missing.push(`${room} on ${url}`);
    }
    session.writeRooms(seeded);
  }
  if (process.env.CLAUDE_ENV_FILE) {
    try {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export AGENT_ROOMS_SESSION=${session.key}\n`);
    } catch {}
  }

  const note = missing.length
    ? `agent-rooms: this project's rooms ${missing.join(", ")} can't be joined because no server with that URL is configured on this machine. The user can add it with: agent-rooms server add <name> --url <url> --token <token>`
    : "";
  const rooms = Object.keys(session.rooms);
  if (!rooms.length) return note && emit("SessionStart", note);
  ensureDaemon(session);
  const unread = session.unsurfaced();
  session.markSurfaced(unread);
  emit(
    "SessionStart",
    [
      `agent-rooms: you are an agent in room(s) ${rooms.map((r) => `${r}${session.rooms[r].handle ? ` as @${session.rooms[r].handle}` : ""}`).join(", ")}. ` +
        `Other agents reach you via @mentions/@all; use the \`agent-rooms\` CLI (skill: agent-rooms:rooms) to reply, check \`agent-rooms status\`, or share files. Session: ${session.key}`,
      note,
      unread.length ? formatForModel(unread) : "",
    ]
      .filter(Boolean)
      .join("\n\n")
  );
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

async function inject() {
  const input = await readStdin();
  if (!Session.exists(input.session_id)) return;
  const session = new Session(input.session_id);
  const unread = session.unsurfaced();
  if (!unread.length) return;
  session.markSurfaced(unread);
  emit(input.hook_event_name || "PostToolUse", formatForModel(unread));
}

// asyncRewake hook: sits in the background until something arrives for this
// agent, then exits 2 so Claude Code wakes the (possibly idle) session.
// Re-armed at every SessionStart and Stop; a newer waiter retires older ones.
async function wait() {
  const input = await readStdin();
  if (!input.session_id) return 0;
  // Headless runs (claude -p, Agent SDK) wait for async hooks before exiting,
  // and there is no idle prompt to wake anyway.
  const headless = /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || "");
  if (headless && process.env.AGENT_ROOMS_WAKE !== "1") return 0;
  const session = new Session(input.session_id);
  for (let i = 0; i < 30 && !session.meta; i++) await sleep(500);
  const meta = session.meta;
  if (!meta || !Object.keys(session.rooms).length) return 0;

  session.writePid("waiter.pid");
  for (;;) {
    await sleep(1000);
    if (session.readPid("waiter.pid") !== process.pid) return 0;
    if (fs.existsSync(session.file("stop"))) return 0;
    if (meta.claudePid && !pidAlive(meta.claudePid)) return 0;
    if (!Object.keys(session.rooms).length) return 0;
    const unread = session.unsurfaced();
    // Intros alone aren't worth waking an idle agent; they ride along with the
    // next mention or get injected on the next prompt/tool call.
    if (unread.some((e) => e.kind !== "intro")) {
      session.markSurfaced(unread);
      process.stderr.write(formatForModel(unread) + "\n");
      return 2;
    }
  }
}

async function sessionEnd() {
  const input = await readStdin();
  if (!Session.exists(input.session_id)) return;
  const session = new Session(input.session_id);
  fs.writeFileSync(session.file("stop"), String(Date.now()));
  const pid = session.readPid("daemon.pid");
  if (pidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
  }
}

export async function runHook(name) {
  try {
    switch (name) {
      case "session-start":
        await sessionStart();
        return 0;
      case "inject":
        await inject();
        return 0;
      case "wait":
        return await wait();
      case "session-end":
        await sessionEnd();
        return 0;
      default:
        process.stderr.write(`unknown hook ${name}\n`);
        return 0;
    }
  } catch (e) {
    // Never break the user's session because of agent-rooms.
    process.stderr.write(`agent-rooms hook ${name}: ${e.message}\n`);
    return 0;
  }
}
