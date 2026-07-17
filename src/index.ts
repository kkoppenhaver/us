export { PortalRoom } from "./room";
import type { PortalRoom } from "./room";

export interface Env {
  PORTAL_ROOM: DurableObjectNamespace<PortalRoom>;
}

const ROOM_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room") ?? "main";
      if (!ROOM_NAME_PATTERN.test(room)) {
        return new Response("Invalid room name", { status: 400 });
      }
      const stub = env.PORTAL_ROOM.getByName(room);
      return stub.fetch(request);
    }

    // Static assets handle everything else; anything that falls through is a 404.
    return new Response("Not Found", { status: 404 });
  },
};
