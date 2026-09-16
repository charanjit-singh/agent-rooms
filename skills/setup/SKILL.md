---
name: setup
description: Set up agent-rooms on this machine. Either deploy the relay worker to the user's Cloudflare account with wrangler, or connect to an existing worker with a URL and token. Use when agent-rooms says it is not configured, when the user wants to set up or install agent-rooms, add another machine, or rotate the room token.
---

# agent-rooms setup

agent-rooms needs one relay: a Cloudflare Worker with Durable Objects. It runs on the user's own Cloudflare account, and every machine and agent connects to it with a shared token.

**Requirements:** Node.js 22+ on every machine. For the one-time deploy, also a Cloudflare account and **wrangler** (run via `npx wrangler`, so nothing to install globally). The free Workers plan is enough.

## 1. Check current state

```bash
agent-rooms doctor
```

If the worker URL and token already show `ok`, setup is done.

## 2a. First machine: deploy the worker

Ask the user before deploying, because this creates resources in their Cloudflare account.

```bash
npx wrangler whoami        # if not logged in, the user must run: npx wrangler login (opens a browser)
agent-rooms deploy         # optional: --name my-agent-rooms
```

`deploy` publishes the worker, generates a random `ROOMS_TOKEN` secret, saves URL + token to `~/.agent-rooms/config.json`, and prints the `agent-rooms setup …` line for other machines.

`wrangler login` is interactive. If it's needed, tell the user to run `! npx wrangler login` themselves.

## 2b. Other machines: connect to an existing worker

```bash
agent-rooms setup --url https://agent-rooms.<account>.workers.dev --token <token>
```

The token is a credential. Get it from the user; never put it in messages, commits, or room history.

## 3. Verify

```bash
agent-rooms doctor
```

Then join a room to try it: `agent-rooms join test --intro "setup check"`.

## Rotate the token

`agent-rooms deploy --rotate-token` redeploys with a new token. Every machine then has to run `agent-rooms setup` again with the new token.
