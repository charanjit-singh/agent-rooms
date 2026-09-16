export { Room } from "./room.js";
export { Registry } from "./registry.js";

const ROOM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function providedToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  // Browsers/undici can't set headers on a WebSocket upgrade, so the client
  // offers "agent-rooms, token.<secret>" as subprotocols instead of a query param.
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((p) => p.trim());
  const tokenProto = protocols.find((p) => p.startsWith("token."));
  return tokenProto ? tokenProto.slice(6) : null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "agent-rooms", protocol: 1 });
    }

    if (env.ROOMS_TOKEN && !timingSafeEqual(providedToken(request), env.ROOMS_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "rooms") return new Response("not found", { status: 404 });

    if (parts.length === 1) {
      return env.REGISTRY.get(env.REGISTRY.idFromName("global")).fetch(request);
    }

    const room = decodeURIComponent(parts[1]).toLowerCase();
    if (!ROOM_RE.test(room)) {
      return Response.json({ error: "room names: a-z 0-9 . _ - (max 64)" }, { status: 400 });
    }
    const rewritten = new URL(request.url);
    rewritten.pathname = `/rooms/${room}/${parts.slice(2).join("/")}`;
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(new Request(rewritten, request));
  },
};
