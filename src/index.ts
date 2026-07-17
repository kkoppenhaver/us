export { PortalRoom } from "./room";
import type { PortalRoom } from "./room";

export interface Env {
  PORTAL_ROOM: DurableObjectNamespace<PortalRoom>;
  // Cloudflare Calls TURN credentials (wrangler secrets); absent = STUN-only.
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}

const ROOM_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
// Long enough for a long call; short enough that leaked credentials expire.
const TURN_TTL_SECONDS = 4 * 60 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/turn") {
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
        return Response.json({ iceServers: [] });
      }
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.TURN_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        }
      );
      if (!res.ok) {
        console.error("TURN credential fetch failed", res.status, await res.text());
        return Response.json({ iceServers: [] }, { status: 502 });
      }
      return Response.json(await res.json(), {
        headers: { "Cache-Control": "no-store" },
      });
    }

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
