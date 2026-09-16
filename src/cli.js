import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { normalizeRoom, openRoom, profileFor, receiveAttachment, requireConfig, shareAttachment } from "./agent.js";
import { MAX_FILE_BYTES, RoomConnection } from "./client.js";
import { loadConfig, loadProjectConfig, saveConfig, saveProjectConfig } from "./config.js";
import { fingerprint, loadIdentity } from "./crypto.js";
import { runDaemon } from "./daemon.js";
import { formatEntry } from "./format.js";
import { ensureDaemon, runHook } from "./hooks.js";
import { entryKey, humanSession, resolveSession } from "./store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const BOOLEAN_FLAGS = new Set(["help", "version", "unread", "keep", "no-remember", "rotate-token", "yes"]);

const HELP = `agent-rooms ${VERSION}: rooms where Claude Code agents @mention each other

Setup
  agent-rooms deploy [--name agent-rooms]      Deploy the relay worker to your Cloudflare account (wrangler)
  agent-rooms setup --url <url> --token <tok>  Connect this machine to an existing worker
  agent-rooms doctor                           Check config, connectivity, session and daemon

Rooms (run by an agent inside Claude Code, or by you in a terminal)
  agent-rooms join <room> [--intro "..."] [--handle name] [--no-remember]
  agent-rooms leave <room> [--keep]
  agent-rooms status [room]                    Members, who is online, your @handle
  agent-rooms send <room> <message> [--context "..." | --context - | --context-file f] [--reply-to N]
  agent-rooms share-file <room> <path> <message>
  agent-rooms share-secret <room> <name> <message> (--env VAR | --file path)
  agent-rooms inbox [room] [--limit N] [--unread]
  agent-rooms history <room> [--limit N]
  agent-rooms rooms                            All rooms on the worker
  agent-rooms whoami
  agent-rooms listen [room...]                 Stay online in a terminal and print what arrives (humans)

Messages only notify who they @mention: @handle, @all. Files and secrets are
end-to-end encrypted to the mentioned agents.

Common flags: --session <id> (defaults to the current Claude Code session)`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length) flags[key] = true;
        else flags[key] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function need(value, usage) {
  if (value === undefined || value === true || value === "") throw new Error(`usage: agent-rooms ${usage}`);
  return value;
}

function currentSession(flags) {
  return resolveSession(flags.session) || humanSession();
}

async function readAllStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function memberLine(m, me) {
  const state = m.online ? "online" : `offline (last seen ${new Date(m.lastSeen).toISOString().slice(0, 16)}Z)`;
  return `  @${m.handle}${m.agentId === me ? " (you)" : ""}  ${state}  ${m.machine}/${m.project}${m.intro ? `\n      ${m.intro}` : ""}`;
}

async function withRoom(session, room, fn, overrides) {
  const conn = await openRoom(session, room, overrides);
  try {
    return await fn(conn);
  } finally {
    conn.stop();
  }
}

function requireJoined(session, room) {
  if (!session.rooms[room]) throw new Error(`not in room "${room}"; run: agent-rooms join ${room} --intro "..."`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { shell: process.platform === "win32", encoding: "utf8", ...opts });
}

const commands = {
  async setup({ flags }) {
    let { url, token } = flags;
    if ((!url || !token) && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      url ||= (await rl.question("Worker URL (https://agent-rooms.<you>.workers.dev): ")).trim();
      token ||= (await rl.question("Room token: ")).trim();
      rl.close();
    }
    need(url, "setup --url <worker-url> --token <token>");
    url = String(url).replace(/\/$/, "");
    const res = await fetch(`${url}/rooms`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch((e) => {
      throw new Error(`cannot reach ${url}: ${e.message}`);
    });
    if (res.status === 401) throw new Error("the worker rejected that token");
    if (!res.ok) throw new Error(`unexpected response from ${url}: HTTP ${res.status}`);
    const saved = saveConfig({ url, token: token || "" });
    console.log(`Saved to ${saved.file}. This machine can now join rooms on ${url}.`);
  },

  async deploy({ flags }) {
    const workerDir = path.join(ROOT, "worker");
    if (!fs.existsSync(path.join(workerDir, "wrangler.toml"))) throw new Error(`worker sources not found at ${workerDir}`);
    const nameArgs = flags.name ? ["--name", String(flags.name)] : [];

    console.log("Checking Cloudflare login (wrangler whoami)…");
    const who = run("npx", ["--yes", "wrangler", "whoami"], { cwd: workerDir });
    if (who.error) throw new Error("npx not found: install Node.js 22+ (includes npm/npx)");
    if (/not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
      if (!process.stdin.isTTY) throw new Error("not logged in to Cloudflare: run `npx wrangler login` in a terminal first");
      run("npx", ["--yes", "wrangler", "login"], { cwd: workerDir, stdio: "inherit" });
    }

    console.log("Deploying worker…");
    const dep = run("npx", ["--yes", "wrangler", "deploy", ...nameArgs], { cwd: workerDir });
    process.stderr.write(dep.stdout || "");
    process.stderr.write(dep.stderr || "");
    if (dep.status !== 0) throw new Error("wrangler deploy failed (output above)");
    const url = (`${dep.stdout}`.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
    if (!url) throw new Error("deployed, but couldn't find the workers.dev URL in wrangler's output; run agent-rooms setup manually");

    const existing = loadConfig();
    const token = flags.token || (existing.url === url && existing.token && !flags["rotate-token"] ? existing.token : crypto.randomBytes(24).toString("hex"));
    console.log("Setting ROOMS_TOKEN secret…");
    const sec = run("npx", ["--yes", "wrangler", "secret", "put", "ROOMS_TOKEN", ...nameArgs], { cwd: workerDir, input: `${token}\n` });
    if (sec.status !== 0) throw new Error(`wrangler secret put failed:\n${sec.stderr}`);

    saveConfig({ url, token });
    console.log(`\nDone. Worker: ${url}\nThis machine is configured. On every other machine run:\n\n  agent-rooms setup --url ${url} --token ${token}\n\nKeep the token private: anyone with it can join your rooms.`);
  },

  async doctor({ flags }) {
    const ok = (b) => (b ? "ok  " : "FAIL");
    const major = Number(process.versions.node.split(".")[0]);
    console.log(`${ok(major >= 22)} node ${process.versions.node} (need 22+)`);
    const config = loadConfig();
    console.log(`${ok(!!config.url)} worker url: ${config.url || "(not set: agent-rooms setup/deploy)"}`);
    console.log(`${config.token ? "ok  " : "warn"} token: ${config.token ? "set" : "not set"}`);
    if (config.url) {
      try {
        const health = await fetch(`${config.url}/health`).then((r) => r.json());
        console.log(`${ok(health.ok)} worker reachable (protocol v${health.protocol ?? "?"})`);
        const auth = await fetch(`${config.url}/rooms`, { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} });
        console.log(`${ok(auth.ok)} token accepted (HTTP ${auth.status})`);
      } catch (e) {
        console.log(`FAIL worker unreachable: ${e.message}`);
      }
    }
    console.log(`ok   identity fingerprint ${fingerprint(loadIdentity().publicKey)}`);
    const session = resolveSession(flags.session);
    if (!session) {
      console.log("info not inside a Claude Code session (commands act as your human identity)");
      return;
    }
    const status = session.status;
    console.log(`ok   session ${session.key} (project ${session.meta.project})`);
    console.log(`${ok(session.daemonAlive() || !Object.keys(session.rooms).length)} daemon ${session.daemonAlive() ? `running (pid ${session.readPid("daemon.pid")})` : "not running"}`);
    for (const [room, s] of Object.entries(status?.rooms || {})) {
      console.log(`${ok(s.connected)} room ${room} as @${s.handle || "?"}${s.error ? ` (${s.error})` : ""}`);
    }
  },

  async rooms() {
    const config = requireConfig();
    const res = await fetch(`${config.url}/rooms`, { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rooms } = await res.json();
    const names = Object.keys(rooms).sort();
    console.log(names.length ? names.map((n) => `${n}  (created ${new Date(rooms[n].createdAt).toISOString().slice(0, 10)})`).join("\n") : "No rooms yet.");
  },

  async whoami({ flags }) {
    const session = currentSession(flags);
    console.log(`agent: ${session.key}${session.meta?.human ? " (human)" : ""}`);
    console.log(`fingerprint: ${fingerprint(loadIdentity().publicKey)}`);
    const rooms = Object.entries(session.rooms);
    console.log(rooms.length ? rooms.map(([r, v]) => `room ${r} as @${v.handle || "?"}`).join("\n") : "not in any rooms");
  },

  async join({ positional, flags }) {
    const room = normalizeRoom(need(positional[0], 'join <room> [--intro "..."] [--handle name]'));
    const session = currentSession(flags);
    const intro = typeof flags.intro === "string" ? flags.intro : "";
    const handle = typeof flags.handle === "string" ? flags.handle : "";
    const welcome = await withRoom(session, room, async (conn) => conn.welcome, { intro, handle });
    session.updateRoom(room, { handle: welcome.you.handle, ...(intro ? { intro } : {}) });

    const meta = session.meta;
    if (!meta.human && !flags["no-remember"]) {
      const project = loadProjectConfig(meta.project);
      saveProjectConfig({ rooms: [...new Set([...project.rooms, room])] }, meta.project);
    }
    if (!meta.human) ensureDaemon(session);

    console.log(`Joined "${room}" as @${welcome.you.handle}.`);
    console.log("Members:");
    for (const m of welcome.members) console.log(memberLine(m, session.key));
    if (meta.human) console.log('\nYou joined as a human. Run "agent-rooms listen" to receive messages here.');
  },

  async leave({ positional, flags }) {
    const room = normalizeRoom(need(positional[0], "leave <room>"));
    const session = currentSession(flags);
    await withRoom(session, room, (conn) => conn.request({ type: "leave" }).catch(() => {}));
    session.updateRoom(room, null);
    const meta = session.meta;
    if (!meta.human && !flags.keep) {
      const project = loadProjectConfig(meta.project);
      saveProjectConfig({ rooms: project.rooms.filter((r) => r !== room) }, meta.project);
    }
    console.log(`Left "${room}".`);
  },

  async status({ positional, flags }) {
    const session = currentSession(flags);
    const rooms = positional[0] ? [normalizeRoom(positional[0])] : Object.keys(session.rooms);
    if (!rooms.length) return console.log('Not in any rooms. Join one: agent-rooms join <room> --intro "what you are working on"');
    const daemon = session.status?.rooms || {};
    for (const room of rooms) {
      requireJoined(session, room);
      const { members } = await withRoom(session, room, (conn) => conn.request({ type: "who" }));
      const d = daemon[room];
      const live = session.meta.human ? "" : d?.connected ? " · receiving" : " · NOT receiving (daemon offline; agent-rooms doctor)";
      console.log(`Room "${room}" · you are @${session.rooms[room].handle}${live}`);
      for (const m of members) console.log(memberLine(m, session.key));
    }
  },

  async send({ positional, flags }) {
    const room = normalizeRoom(need(positional[0], "send <room> <message>"));
    const message = need(positional.slice(1).join(" "), 'send <room> "<@handle message>"');
    const session = currentSession(flags);
    requireJoined(session, room);
    let context = "";
    if (flags["context-file"]) context = fs.readFileSync(String(flags["context-file"]), "utf8");
    else if (flags.context === "-") context = await readAllStdin();
    else if (typeof flags.context === "string") context = flags.context;
    const replyTo = flags["reply-to"] ? Number(flags["reply-to"]) : null;

    const res = await withRoom(session, room, (conn) => conn.request({ type: "send", text: message, context, replyTo }));
    console.log(`Sent #${res.seq} to "${room}".`);
    console.log(res.delivered.length ? `Notified: ${res.delivered.map((h) => "@" + h).join(", ")}` : "Nobody was notified: mention @handle or @all.");
    if (res.unknown.length) console.log(`Unknown handles: ${res.unknown.map((h) => "@" + h).join(", ")} (see agent-rooms status)`);
  },

  async "share-file"({ positional, flags }) {
    const room = normalizeRoom(need(positional[0], "share-file <room> <path> <message>"));
    const file = path.resolve(need(positional[1], "share-file <room> <path> <message>"));
    const message = need(positional.slice(2).join(" "), 'share-file <room> <path> "@handle what it is"');
    const session = currentSession(flags);
    requireJoined(session, room);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${file} is not a file`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file is ${stat.size} bytes; max is ${MAX_FILE_BYTES}`);
    const r = await withRoom(session, room, (conn) => shareAttachment(conn, session.key, message, fs.readFileSync(file), { name: path.basename(file), secret: false }));
    console.log(`Shared ${path.basename(file)} (${stat.size} bytes, end-to-end encrypted) as #${r.seq} with ${r.recipients.map((h) => "@" + h).join(", ")}.`);
    if (r.skipped.length) console.log(`Skipped (no encryption key): ${r.skipped.join(", ")}`);
  },

  async "share-secret"({ positional, flags }) {
    const usage = "share-secret <room> <NAME> <message> (--env VAR | --file path)";
    const room = normalizeRoom(need(positional[0], usage));
    const name = need(positional[1], usage);
    const message = need(positional.slice(2).join(" "), usage);
    const session = currentSession(flags);
    requireJoined(session, room);
    let value;
    if (typeof flags.env === "string") {
      value = process.env[flags.env];
      if (value === undefined) throw new Error(`environment variable ${flags.env} is not set`);
    } else if (typeof flags.file === "string") {
      value = fs.readFileSync(flags.file, "utf8");
    } else {
      throw new Error(`${usage}\nSecrets are read from an env var or file so the value never appears in a conversation.`);
    }
    const payload = Buffer.from(JSON.stringify({ name, value }));
    const r = await withRoom(session, room, (conn) => shareAttachment(conn, session.key, message, payload, { name, secret: true }));
    console.log(`Shared secret ${name} (end-to-end encrypted) as #${r.seq} with ${r.recipients.map((h) => "@" + h).join(", ")}.`);
    if (r.skipped.length) console.log(`Skipped (no encryption key): ${r.skipped.join(", ")}`);
  },

  async inbox({ positional, flags }) {
    const session = currentSession(flags);
    let entries = flags.unread ? session.unsurfaced() : session.readInbox();
    if (positional[0]) entries = entries.filter((e) => e.room === normalizeRoom(positional[0]));
    entries = entries.slice(-(Number(flags.limit) || 20));
    session.markSurfaced(entries);
    console.log(entries.length ? entries.map((e) => formatEntry(e, { full: true })).join("\n") : "Inbox is empty.");
  },

  async history({ positional, flags }) {
    const room = normalizeRoom(need(positional[0], "history <room>"));
    const session = currentSession(flags);
    requireJoined(session, room);
    const { messages } = await withRoom(session, room, (conn) => conn.request({ type: "history", limit: Math.min(Number(flags.limit) || 20, 50) }));
    if (!messages.length) return console.log("No messages yet.");
    for (const m of messages) {
      const to = m.kind === "all" ? "@all" : m.kind === "intro" ? "(intro)" : m.to?.length ? m.to.map((h) => "@" + h).join(" ") : "(nobody)";
      const att = m.attachment ? ` [${m.attachment.secret ? "secret" : "file"}: ${m.attachment.name}]` : "";
      console.log(`#${m.seq} ${new Date(m.ts).toISOString().slice(0, 16)}Z @${m.from} → ${to}: ${m.text}${att}`);
      if (m.context) console.log(`    context: ${m.context.slice(0, 500).replace(/\n/g, "\n    ")}`);
    }
  },

  async listen({ positional, flags }) {
    const config = requireConfig();
    const session = currentSession(flags);
    const rooms = positional.length ? positional.map(normalizeRoom) : Object.keys(session.rooms);
    if (!rooms.length) throw new Error("join a room first: agent-rooms join <room>");
    const seen = new Set(session.readInbox().map(entryKey));
    const projectDir = session.meta.project || process.cwd();
    for (const room of rooms) {
      new RoomConnection({
        url: config.url,
        token: config.token,
        room,
        agentId: session.key,
        profile: profileFor(session, room),
        onDeliver: async (conn, m) => {
          if (seen.has(entryKey(m))) return;
          if (m.attachment) {
            try {
              m.attachment.savedTo = await receiveAttachment(conn, m, projectDir);
            } catch (e) {
              m.attachment.error = e.message;
            }
            delete m.attachment.key;
          }
          seen.add(entryKey(m));
          session.appendInbox(m);
          session.markSurfaced([m]);
          console.log(formatEntry(m, { full: true }));
        },
        onState: (conn) => console.error(`[${room}] ${conn.connected ? `online as @${conn.welcome.you.handle}` : "reconnecting…"}`),
      }).start();
    }
    await new Promise(() => {});
  },

  async daemon({ flags }) {
    await runDaemon(need(flags.session, "daemon --session <id>"));
    await new Promise(() => {});
  },

  async hook({ positional }) {
    process.exitCode = await runHook(positional[0]);
  },
};

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "--version" || cmd === "version") return console.log(VERSION);
  const handler = commands[cmd];
  if (!handler) {
    console.error(`unknown command "${cmd}"\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) {
    console.error(`agent-rooms needs Node.js 22 or newer (found ${process.versions.node})`);
    process.exitCode = 1;
    return;
  }
  try {
    await handler(parseArgs(rest));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
