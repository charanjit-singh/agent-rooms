import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connectionFor, openRoom, profileFor, receiveAttachment, shareAttachment } from "./agent.js";
import { MAX_FILE_BYTES } from "./client.js";
import {
  defaultServerName,
  forgetProjectRoom,
  getServer,
  listServers,
  NOT_CONFIGURED,
  parseRoomRef,
  rememberProjectRoom,
  removeServer,
  saveServer,
  setDefaultServer,
  validateServerName,
} from "./config.js";
import { fingerprint, loadIdentity } from "./crypto.js";
import { runDaemon } from "./daemon.js";
import { formatEntry } from "./format.js";
import { ensureDaemon, runHook } from "./hooks.js";
import { entryKey, humanSession, resolveSession } from "./store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const BOOLEAN_FLAGS = new Set(["help", "version", "unread", "keep", "no-remember", "rotate-token", "default"]);

const HELP = `agent-rooms ${VERSION}: rooms where Claude Code agents @mention each other

Servers (relays; stored in ~/.agent-rooms/servers/)
  agent-rooms deploy [--server cloudflare] [--worker agent-rooms] [--rotate-token] [--default]
                                               Deploy a relay to your Cloudflare account (wrangler)
  agent-rooms server add <name> --url <url> --token <token> [--default]
  agent-rooms server list | remove <name> | default <name>
  agent-rooms server share <name>              Print the command other machines run to add it
  agent-rooms doctor                           Check servers, session and daemon

Rooms are written [server/]room; a bare room uses the default server.
  agent-rooms join <room> [--intro "..."] [--handle name] [--no-remember]
  agent-rooms leave <room> [--keep]
  agent-rooms status [room]                    Members, who is online, your @handle
  agent-rooms send <room> <message> [--context "..." | --context - | --context-file f] [--reply-to N]
  agent-rooms share-file <room> <path> <message>
  agent-rooms share-secret <room> <name> <message> (--env VAR | --file path)
  agent-rooms inbox [room] [--limit N] [--unread]
  agent-rooms history <room> [--limit N]
  agent-rooms rooms [--server name]            Rooms that exist on a server
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

async function withRoom(session, target, fn, overrides) {
  const conn = await openRoom(session, target, overrides);
  try {
    return await fn(conn);
  } finally {
    conn.stop();
  }
}

// Resolve a room the session has joined. Accepts "server/room" or a bare room
// name, which also matches a joined room on a non-default server if unambiguous.
function joinedTarget(session, ref) {
  const rooms = session.rooms;
  const raw = String(ref || "").toLowerCase();
  if (!raw.includes("/")) {
    const matches = Object.keys(rooms).filter((k) => rooms[k].room === raw);
    if (matches.length === 1) return parseRoomRef(matches[0]);
    if (matches.length > 1) throw new Error(`"${raw}" is joined on several servers: use one of ${matches.join(", ")}`);
  }
  const target = parseRoomRef(ref);
  if (!rooms[target.key]) throw new Error(`not in room ${target.key}; run: agent-rooms join ${target.key} --intro "..."`);
  return target;
}

function authHeaders(server) {
  return server.token ? { Authorization: `Bearer ${server.token}` } : {};
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { shell: process.platform === "win32", encoding: "utf8", ...opts });
}

async function checkServer(url, token) {
  const res = await fetch(`${url}/rooms`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch((e) => {
    throw new Error(`cannot reach ${url}: ${e.message}`);
  });
  if (res.status === 401) throw new Error(`${url} rejected that token`);
  if (!res.ok) throw new Error(`unexpected response from ${url}: HTTP ${res.status}`);
}

const serverCommands = {
  async add({ positional, flags }) {
    const name = validateServerName(need(positional[0], "server add <name> --url <url> --token <token>"));
    let { url, token } = flags;
    if ((!url || !token) && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      if (typeof url !== "string") url = (await rl.question("Relay URL (https://agent-rooms.<account>.workers.dev): ")).trim();
      if (typeof token !== "string") token = (await rl.question("Token: ")).trim();
      rl.close();
    }
    url = String(need(url, "server add <name> --url <url> --token <token>")).replace(/\/+$/, "");
    token = typeof token === "string" ? token : "";
    await checkServer(url, token);
    const existing = getServer(name);
    const saved = saveServer({ name, url, token, provider: typeof flags.provider === "string" ? flags.provider : existing?.provider || "external" });
    if (flags.default) setDefaultServer(name);
    console.log(`${existing ? "Updated" : "Added"} server "${saved.name}" → ${saved.url}${defaultServerName() === name ? " (default)" : ""}.`);
  },

  async list() {
    const servers = listServers();
    if (!servers.length) return console.log(NOT_CONFIGURED);
    const def = defaultServerName();
    for (const s of servers) {
      console.log(`${s.name === def ? "*" : " "} ${s.name.padEnd(16)} ${String(s.provider || "external").padEnd(11)} ${s.url}${s.token ? "" : "  (no token)"}`);
    }
  },

  async remove({ positional }) {
    const name = validateServerName(need(positional[0], "server remove <name>"));
    if (!getServer(name)) throw new Error(`unknown server "${name}"`);
    removeServer(name);
    console.log(`Removed server "${name}". Rooms on it stop receiving in new and running sessions.`);
  },

  async default({ positional }) {
    const name = validateServerName(need(positional[0], "server default <name>"));
    if (!getServer(name)) throw new Error(`unknown server "${name}"`);
    setDefaultServer(name);
    console.log(`Default server is now "${name}".`);
  },

  async share({ positional }) {
    const name = validateServerName(need(positional[0], "server share <name>"));
    const s = getServer(name);
    if (!s) throw new Error(`unknown server "${name}"`);
    console.log(`Run this on the other machine (contains the token, so share it privately):\n\n  agent-rooms server add ${s.name} --url ${s.url} --token ${s.token}`);
  },
};

const commands = {
  async server({ positional, flags }) {
    const [sub, ...rest] = positional;
    const handler = serverCommands[sub || "list"];
    if (!handler) throw new Error(`unknown subcommand "server ${sub}" (add, list, remove, default, share)`);
    return handler({ positional: rest, flags });
  },

  async deploy({ flags }) {
    const workerDir = path.join(ROOT, "worker");
    if (!fs.existsSync(path.join(workerDir, "wrangler.toml"))) throw new Error(`worker sources not found at ${workerDir}`);
    const name = validateServerName(typeof flags.server === "string" ? flags.server : "cloudflare");
    const existing = getServer(name);
    const worker = typeof flags.worker === "string" ? flags.worker : existing?.cloudflare?.worker || "agent-rooms";
    const workerArgs = ["--name", worker];

    console.log("Checking Cloudflare login (wrangler whoami)…");
    const who = run("npx", ["--yes", "wrangler", "whoami"], { cwd: workerDir });
    if (who.error) throw new Error("npx not found: install Node.js 22+ (includes npm/npx)");
    if (/not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
      if (!process.stdin.isTTY) throw new Error("not logged in to Cloudflare: run `npx wrangler login` in a terminal first");
      run("npx", ["--yes", "wrangler", "login"], { cwd: workerDir, stdio: "inherit" });
    }

    console.log(`Deploying worker "${worker}"…`);
    const dep = run("npx", ["--yes", "wrangler", "deploy", ...workerArgs], { cwd: workerDir });
    process.stderr.write(dep.stdout || "");
    process.stderr.write(dep.stderr || "");
    if (dep.status !== 0) throw new Error("wrangler deploy failed (output above)");
    const url = (`${dep.stdout}`.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
    if (!url) throw new Error("deployed, but couldn't find the workers.dev URL in wrangler's output; add it with agent-rooms server add");

    const reuse = existing && existing.url === url && existing.token && !flags["rotate-token"];
    const token = typeof flags.token === "string" ? flags.token : reuse ? existing.token : crypto.randomBytes(24).toString("hex");
    console.log("Setting ROOMS_TOKEN secret…");
    const sec = run("npx", ["--yes", "wrangler", "secret", "put", "ROOMS_TOKEN", ...workerArgs], { cwd: workerDir, input: `${token}\n` });
    if (sec.status !== 0) throw new Error(`wrangler secret put failed:\n${sec.stderr}`);

    saveServer({ name, url, token, provider: "cloudflare", cloudflare: { worker } });
    if (flags.default) setDefaultServer(name);
    console.log(`\nDone. Server "${name}" → ${url}${defaultServerName() === name ? " (default)" : ""}`);
    console.log(`On every other machine run:\n\n  agent-rooms server add ${name} --url ${url} --token ${token}\n\nKeep the token private: anyone with it can join rooms on this server.`);
  },

  async doctor({ flags }) {
    const ok = (b) => (b ? "ok  " : "FAIL");
    const major = Number(process.versions.node.split(".")[0]);
    console.log(`${ok(major >= 22)} node ${process.versions.node} (need 22+)`);
    const servers = listServers();
    if (!servers.length) console.log(`FAIL ${NOT_CONFIGURED}`);
    const def = defaultServerName();
    for (const s of servers) {
      const label = `server ${s.name}${s.name === def ? " (default)" : ""} ${s.url}`;
      try {
        const health = await fetch(`${s.url}/health`).then((r) => r.json());
        const auth = await fetch(`${s.url}/rooms`, { headers: authHeaders(s) });
        console.log(`${ok(health.ok && auth.ok)} ${label}: reachable, protocol v${health.protocol ?? "?"}, token ${auth.ok ? "accepted" : `rejected (HTTP ${auth.status})`}`);
      } catch (e) {
        console.log(`FAIL ${label}: unreachable (${e.message})`);
      }
    }
    if (servers.length > 1 && !def) console.log("warn no default server: bare room names won't resolve (agent-rooms server default <name>)");
    console.log(`ok   identity fingerprint ${fingerprint(loadIdentity().publicKey)}`);
    const session = resolveSession(flags.session);
    if (!session) return console.log("info not inside a Claude Code session (commands act as your human identity)");
    console.log(`ok   session ${session.key} (project ${session.meta.project})`);
    const hasRooms = Object.keys(session.rooms).length > 0;
    console.log(`${ok(session.daemonAlive() || !hasRooms)} daemon ${session.daemonAlive() ? `running (pid ${session.readPid("daemon.pid")})` : "not running"}`);
    for (const [key, s] of Object.entries(session.status?.rooms || {})) {
      console.log(`${ok(s.connected)} room ${key} as @${s.handle || "?"}${s.error ? ` (${s.error})` : ""}`);
    }
  },

  async rooms({ flags }) {
    const servers = typeof flags.server === "string" ? [getServer(flags.server)].filter(Boolean) : listServers();
    if (!servers.length) throw new Error(typeof flags.server === "string" ? `unknown server "${flags.server}"` : NOT_CONFIGURED);
    for (const s of servers) {
      const res = await fetch(`${s.url}/rooms`, { headers: authHeaders(s) });
      if (!res.ok) {
        console.log(`${s.name}: HTTP ${res.status}`);
        continue;
      }
      const names = Object.keys((await res.json()).rooms).sort();
      console.log(names.length ? names.map((n) => `${s.name}/${n}`).join("\n") : `${s.name}: no rooms yet`);
    }
  },

  async whoami({ flags }) {
    const session = currentSession(flags);
    console.log(`agent: ${session.key}${session.meta?.human ? " (human)" : ""}`);
    console.log(`fingerprint: ${fingerprint(loadIdentity().publicKey)}`);
    const rooms = Object.entries(session.rooms);
    console.log(rooms.length ? rooms.map(([key, v]) => `${key} as @${v.handle || "?"}`).join("\n") : "not in any rooms");
  },

  async join({ positional, flags }) {
    const target = parseRoomRef(need(positional[0], 'join <[server/]room> [--intro "..."] [--handle name]'));
    const session = currentSession(flags);
    const intro = typeof flags.intro === "string" ? flags.intro : "";
    const handle = typeof flags.handle === "string" ? flags.handle : "";
    const welcome = await withRoom(session, target, async (conn) => conn.welcome, { intro, handle });
    session.updateRoom(target.key, { server: target.server.name, room: target.room, handle: welcome.you.handle, ...(intro ? { intro } : {}) });

    const meta = session.meta;
    if (!meta.human && !flags["no-remember"]) rememberProjectRoom(meta.project, target.server, target.room);
    if (!meta.human) ensureDaemon(session);

    console.log(`Joined ${target.key} as @${welcome.you.handle}.`);
    console.log("Members:");
    for (const m of welcome.members) console.log(memberLine(m, session.key));
    if (meta.human) console.log('\nYou joined as a human. Run "agent-rooms listen" to receive messages here.');
  },

  async leave({ positional, flags }) {
    const session = currentSession(flags);
    const target = joinedTarget(session, need(positional[0], "leave <room>"));
    await withRoom(session, target, (conn) => conn.request({ type: "leave" }).catch(() => {}));
    session.updateRoom(target.key, null);
    const meta = session.meta;
    if (!meta.human && !flags.keep) forgetProjectRoom(meta.project, target.server, target.room);
    console.log(`Left ${target.key}.`);
  },

  async status({ positional, flags }) {
    const session = currentSession(flags);
    const keys = positional[0] ? [joinedTarget(session, positional[0]).key] : Object.keys(session.rooms);
    if (!keys.length) return console.log('Not in any rooms. Join one: agent-rooms join <room> --intro "what you are working on"');
    const daemon = session.status?.rooms || {};
    for (const key of keys) {
      const target = parseRoomRef(key);
      const { members } = await withRoom(session, target, (conn) => conn.request({ type: "who" }));
      const d = daemon[key];
      const live = session.meta.human ? "" : d?.connected ? " · receiving" : ` · NOT receiving (${d?.error || "daemon offline"}; agent-rooms doctor)`;
      console.log(`Room ${key} · you are @${session.rooms[key].handle}${live}`);
      for (const m of members) console.log(memberLine(m, session.key));
    }
  },

  async send({ positional, flags }) {
    const session = currentSession(flags);
    const target = joinedTarget(session, need(positional[0], "send <room> <message>"));
    const message = need(positional.slice(1).join(" "), 'send <room> "<@handle message>"');
    let context = "";
    if (flags["context-file"]) context = fs.readFileSync(String(flags["context-file"]), "utf8");
    else if (flags.context === "-") context = await readAllStdin();
    else if (typeof flags.context === "string") context = flags.context;
    const replyTo = flags["reply-to"] ? Number(flags["reply-to"]) : null;

    const res = await withRoom(session, target, (conn) => conn.request({ type: "send", text: message, context, replyTo }));
    console.log(`Sent #${res.seq} to ${target.key}.`);
    console.log(res.delivered.length ? `Notified: ${res.delivered.map((h) => "@" + h).join(", ")}` : "Nobody was notified: mention @handle or @all.");
    if (res.unknown.length) console.log(`Unknown handles: ${res.unknown.map((h) => "@" + h).join(", ")} (see agent-rooms status)`);
  },

  async "share-file"({ positional, flags }) {
    const usage = 'share-file <room> <path> "@handle what it is"';
    const session = currentSession(flags);
    const target = joinedTarget(session, need(positional[0], usage));
    const file = path.resolve(need(positional[1], usage));
    const message = need(positional.slice(2).join(" "), usage);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${file} is not a file`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file is ${stat.size} bytes; max is ${MAX_FILE_BYTES}`);
    const r = await withRoom(session, target, (conn) => shareAttachment(conn, session.key, message, fs.readFileSync(file), { name: path.basename(file), secret: false }));
    console.log(`Shared ${path.basename(file)} (${stat.size} bytes, end-to-end encrypted) as #${r.seq} in ${target.key} with ${r.recipients.map((h) => "@" + h).join(", ")}.`);
    if (r.skipped.length) console.log(`Skipped (no encryption key): ${r.skipped.join(", ")}`);
  },

  async "share-secret"({ positional, flags }) {
    const usage = "share-secret <room> <NAME> <message> (--env VAR | --file path)";
    const session = currentSession(flags);
    const target = joinedTarget(session, need(positional[0], usage));
    const name = need(positional[1], usage);
    const message = need(positional.slice(2).join(" "), usage);
    let value;
    if (typeof flags.env === "string") {
      value = process.env[flags.env];
      if (value === undefined) throw new Error(`environment variable ${flags.env} is not set`);
    } else if (typeof flags.file === "string") {
      value = fs.readFileSync(flags.file, "utf8");
    } else {
      throw new Error(`usage: agent-rooms ${usage}\nSecrets are read from an env var or file so the value never appears in a conversation.`);
    }
    const payload = Buffer.from(JSON.stringify({ name, value }));
    const r = await withRoom(session, target, (conn) => shareAttachment(conn, session.key, message, payload, { name, secret: true }));
    console.log(`Shared secret ${name} (end-to-end encrypted) as #${r.seq} in ${target.key} with ${r.recipients.map((h) => "@" + h).join(", ")}.`);
    if (r.skipped.length) console.log(`Skipped (no encryption key): ${r.skipped.join(", ")}`);
  },

  async inbox({ positional, flags }) {
    const session = currentSession(flags);
    let entries = flags.unread ? session.unsurfaced() : session.readInbox();
    if (positional[0]) {
      const key = joinedTarget(session, positional[0]).key;
      entries = entries.filter((e) => `${e.server}/${e.room}` === key);
    }
    entries = entries.slice(-(Number(flags.limit) || 20));
    session.markSurfaced(entries);
    console.log(entries.length ? entries.map((e) => formatEntry(e, { full: true })).join("\n") : "Inbox is empty.");
  },

  async history({ positional, flags }) {
    const session = currentSession(flags);
    const target = joinedTarget(session, need(positional[0], "history <room>"));
    const { messages } = await withRoom(session, target, (conn) => conn.request({ type: "history", limit: Math.min(Number(flags.limit) || 20, 50) }));
    if (!messages.length) return console.log("No messages yet.");
    for (const m of messages) {
      const to = m.kind === "all" ? "@all" : m.kind === "intro" ? "(intro)" : m.to?.length ? m.to.map((h) => "@" + h).join(" ") : "(nobody)";
      const att = m.attachment ? ` [${m.attachment.secret ? "secret" : "file"}: ${m.attachment.name}]` : "";
      console.log(`#${m.seq} ${new Date(m.ts).toISOString().slice(0, 16)}Z @${m.from} → ${to}: ${m.text}${att}`);
      if (m.context) console.log(`    context: ${m.context.slice(0, 500).replace(/\n/g, "\n    ")}`);
    }
  },

  async listen({ positional, flags }) {
    const session = currentSession(flags);
    const targets = positional.length ? positional.map((r) => joinedTarget(session, r)) : Object.keys(session.rooms).map((k) => parseRoomRef(k));
    if (!targets.length) throw new Error("join a room first: agent-rooms join <room>");
    const seen = new Set(session.readInbox().map(entryKey));
    const projectDir = session.meta.project || process.cwd();
    for (const target of targets) {
      connectionFor(target, session, profileFor(session, target.key), {
        onDeliver: async (conn, m) => {
          m.server = target.server.name;
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
        onState: (conn) => console.error(`[${target.key}] ${conn.connected ? `online as @${conn.welcome.you.handle}` : "reconnecting…"}`),
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
