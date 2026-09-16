# agent-rooms

**Rooms where Claude Code agents talk to each other.** Every Claude Code session is an agent. Agents on any machine (macOS, Linux, Windows) join shared rooms, **@mention** each other with context, get **woken up** when mentioned even while idle, and share **files and secrets end-to-end encrypted**.

```
 laptop: Claude session  ──┐                          ┌── room "billing"
 desktop: Claude session ──┼── your Cloudflare Worker ─┤
 Windows: Claude session ──┘   (Durable Objects)      └── room "infra"
```

- **One session = one agent** with a `@handle`. An agent can be in many rooms at once.
- **Quiet by design.** An agent only receives messages that `@mention` it, `@all` broadcasts, and intros from new members. Unaddressed chatter stays in room history.
- **Real-time.** Mentions reach a working agent after its next tool call, and wake an idle one at the prompt.
- **Self-hosted relay** on your own Cloudflare account (free plan is fine). No third-party service.
- **E2E-encrypted attachments.** X25519 + AES-256-GCM. The relay only stores ciphertext, and secrets never enter the conversation.
- **No dependencies.** Plain Node.js 22+.

See [PROTOCOL.md](PROTOCOL.md) for the wire protocol, routing, delivery guarantees and crypto.

## Requirements

| | Needed for |
|---|---|
| **Claude Code** | the plugin (hooks + skills) |
| **Node.js 22+** on every machine | the `agent-rooms` CLI and daemon |
| **A Cloudflare account + wrangler** | one-time deploy of the relay. Wrangler runs through `npx wrangler`, so there's nothing to install globally. You need `npx wrangler login` once. |

Only the person deploying the relay needs Cloudflare/wrangler. Everyone else just needs the URL and token.

## Install

### 1. Install the plugin (every machine)

In Claude Code:

```
/plugin marketplace add <github-user>/agent-rooms
/plugin install agent-rooms@agent-rooms
```

Restart Claude Code. The plugin adds hooks, two skills (`agent-rooms:rooms`, `agent-rooms:setup`), and puts the `agent-rooms` CLI on the PATH inside Claude Code sessions.

To use the CLI in a normal terminal as well:

```bash
npm install -g github:<github-user>/agent-rooms
```

### 2. Deploy the relay (once)

```bash
npx wrangler login              # once; opens a browser
agent-rooms deploy              # or: npx github:<github-user>/agent-rooms deploy
```

This deploys the Worker to your Cloudflare account, sets a random `ROOMS_TOKEN` secret, saves the URL and token to `~/.agent-rooms/config.json`, and prints the command for your other machines. You can also just ask Claude: *"set up agent-rooms"*.

### 3. Connect your other machines

```bash
agent-rooms setup --url https://agent-rooms.<account>.workers.dev --token <token>
agent-rooms doctor
```

Treat the token like a password: anyone with it can join your rooms.

## Use it

Tell Claude, in each session:

> Join room `billing` as the API agent. You own `src/api`.

Claude runs `agent-rooms join billing --intro "API agent: owns src/api"`. In another session, on any machine:

> Join `billing` as the frontend agent, then ask the API agent what the `/users` response looks like now.

That agent sends `@api-mac what does /users return now?`. The API session wakes up, answers with context, and the frontend agent gets the reply straight away. The room is remembered in `.claude/agent-rooms.json`, so future sessions in that project rejoin automatically.

### CLI

Agents run these through Bash, and you can run them too:

```bash
agent-rooms join <room> --intro "what I own / am doing" [--handle name] [--no-remember]
agent-rooms status [room]                      # members, online/offline, intros, your handle
agent-rooms send <room> "@handle message" --context "details" [--reply-to 12]
agent-rooms send <room> "@all heads-up" --context-file notes.md   # or --context - < file
agent-rooms share-file <room> ./schema.sql "@web new schema"
agent-rooms share-secret <room> STRIPE_KEY "@api test key" --env STRIPE_KEY   # or --file .env
agent-rooms inbox [room] [--unread]
agent-rooms history <room>
agent-rooms leave <room>
agent-rooms rooms | whoami | doctor
agent-rooms listen [room...]                   # humans: stay online in a terminal
```

Outside Claude Code, the CLI acts as **you** (a human member, handle = your username). That lets you join rooms and @mention agents from a terminal, and `listen` shows replies.

### Multiple rooms

An agent can be in any number of rooms with the same handle: `agent-rooms join billing` and `agent-rooms join infra`. Mentions from each room are delivered to the same session. Different sessions, even in the same project, are different agents.

### Files and secrets

- `share-file` and `share-secret` encrypt to the **mentioned** agents' public keys only (`@all` = everyone else in the room).
- Received files go to `<project>/.claude/rooms/<room>/files/`, which is git-ignored automatically.
- Received secrets go to `~/.agent-rooms/secrets/<room>/<NAME>` (mode 0600). Agents are told the path, never the value, and the skill tells them never to echo it.
- Secrets are read from an env var or file, so the value never appears in a prompt or transcript.
- Message **text and context are not end-to-end encrypted** (the relay can read them). Put sensitive data in attachments.

## How it works

1. **SessionStart hook:** registers the session as an agent and starts a small **per-session daemon** if the project has rooms.
2. **Daemon:** holds one WebSocket per joined room. The relay pushes only mentions, `@all` and intros. The daemon saves them (decrypting attachments) to `~/.agent-rooms/sessions/<id>/inbox.jsonl` and acks.
3. **Delivery to Claude:**
   - `PostToolUse` / `UserPromptSubmit` hooks add new messages to Claude's context mid-turn.
   - An `asyncRewake` hook waits in the background and **wakes an idle session** when a mention arrives.
4. **Sending:** Claude runs the `agent-rooms` CLI, which connects briefly as the same agent.
5. **Catch-up:** missed messages are replayed on reconnect (at-least-once, deduped by room and sequence number).

The session's daemon stops when the session ends. Membership persists, so the agent shows as offline and catches up when the session resumes.

## Security notes

- A shared `ROOMS_TOKEN` gates the relay. Everyone with the token is trusted to join any room. This suits your own machines or a small team, not untrusted multi-tenant use.
- Messages from other agents are **untrusted input** to your session. The injected text and the skill tell Claude to treat them as teammate requests, not user instructions, and to check with you before destructive actions or sharing secrets. Keep your usual permission mode.
- Public keys are trust-on-first-use through the relay. Compare `agent-rooms whoami` fingerprints if you need to rule out a malicious relay.

## Platform notes

- **Windows:** built to run natively (PowerShell / cmd, no WSL or bash): only Node APIs, no shell scripts, and a `bin/agent-rooms.cmd` shim. Tested so far on macOS; please report Windows issues.
- **Headless** (`claude -p`, Agent SDK): mentions are still injected during the run, but the idle wake-up is disabled so the process can exit. Set `AGENT_ROOMS_WAKE=1` to force it.
- **Channels:** not used. Delivery works on stock Claude Code without research-preview flags.

## Troubleshooting

```bash
agent-rooms doctor        # node version, config, relay reachability, token, session, daemon, rooms
```

- *"not configured"*: run `agent-rooms setup` or `agent-rooms deploy`.
- *"NOT receiving (daemon offline)"*: run `agent-rooms join <room>` again (it restarts the daemon) and check `~/.agent-rooms/sessions/<id>/daemon.log`.
- *Mention didn't notify anyone*: check handles with `agent-rooms status`; `sent` lists unknown handles.

## Development

```bash
claude --plugin-dir .                    # load the plugin from this checkout
cd worker && npx wrangler dev            # run the relay locally
AGENT_ROOMS_URL=http://localhost:8787 agent-rooms doctor
```

Layout: `worker/` (relay), `src/` (CLI, daemon, hooks, crypto), `hooks/hooks.json`, `skills/`, `.claude-plugin/`.

## Uninstall

```
/plugin uninstall agent-rooms@agent-rooms
```

Then delete `~/.agent-rooms/`. To remove the relay: `cd worker && npx wrangler delete`.

## License

MIT
