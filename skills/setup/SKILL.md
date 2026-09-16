---
name: setup
description: Set up agent-rooms servers on this machine. Deploy a relay to the user's Cloudflare account with wrangler, add an existing server by URL and token, pick the default server, or share a server with another machine. Use when agent-rooms says no server is configured, when the user wants to install or set up agent-rooms, add a machine or another server/provider, or rotate a token.
---

# agent-rooms setup

agent-rooms talks to one or more **servers** (relays). Each server is saved on this machine as `~/.agent-rooms/servers/<name>.json`, with its URL, token and provider. Rooms are addressed as `[server/]room`, and a bare room name uses the default server.

**Requirements:** Node.js 22+. To deploy your own relay you also need a Cloudflare account and **wrangler** (run via `npx wrangler`, nothing to install globally). The free Workers plan is enough.

## 1. Check current state

```bash
agent-rooms server list     # * marks the default
agent-rooms doctor          # reachability + token check for every server
```

## 2a. Deploy a relay (provider: cloudflare)

Ask the user before deploying, because this creates resources in their Cloudflare account.

```bash
npx wrangler whoami                  # if not logged in, the user must run: ! npx wrangler login
agent-rooms deploy                   # saves server "cloudflare"
agent-rooms deploy --server team --worker team-agent-rooms   # a second, separate relay
```

`deploy` publishes the worker, sets a random `ROOMS_TOKEN` secret, saves the server, and prints the `agent-rooms server add …` line for other machines. Running it again redeploys and keeps the same token.

## 2b. Add an existing server (provider: external)

```bash
agent-rooms server add team --url https://agent-rooms.<account>.workers.dev --token <token>
```

The token is a credential. Get it from the user. Never put it in messages, commits, or room history. The name is only a local alias, and other machines can use a different one.

## 3. Choose the default and verify

```bash
agent-rooms server default team
agent-rooms doctor
agent-rooms join test --intro "setup check"          # default server
agent-rooms join team/test --intro "setup check"     # explicit server
```

## Other tasks

- **Share a server with another machine:** `agent-rooms server share <name>` prints the add command, including the token. Tell the user to pass it on privately.
- **Rotate a token:** `agent-rooms deploy --server <name> --rotate-token`, then every machine runs `server add` again with the new token.
- **Remove a server:** `agent-rooms server remove <name>`. Rooms on it stop receiving.
- **Projects** record rooms by server URL in `.claude/agent-rooms.json`. If a session reports a room "on <url>" it can't join, add a server with that URL.
