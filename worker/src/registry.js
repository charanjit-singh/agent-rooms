export class Registry {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const rooms = (await this.state.storage.get("rooms")) || {};

    if (request.method === "GET") {
      return Response.json({ rooms });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.name) return Response.json({ error: "name required" }, { status: 400 });
      if (!rooms[body.name]) {
        rooms[body.name] = { createdAt: Date.now() };
        await this.state.storage.put("rooms", rooms);
      }
      return Response.json({ ok: true, room: rooms[body.name] });
    }

    if (request.method === "DELETE") {
      const name = url.searchParams.get("name");
      if (name && rooms[name]) {
        delete rooms[name];
        await this.state.storage.put("rooms", rooms);
      }
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}
