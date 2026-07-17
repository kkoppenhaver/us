import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const MAX_PEERS = 8;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Attachment {
  id: string;
  name: string;
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
}

type ClientMessage =
  | { type: "signal"; to: string; data: unknown }
  | { type: "state"; muted?: boolean; cameraOff?: boolean; sharing?: boolean };

/**
 * One PortalRoom per room name. Relays WebRTC signaling messages
 * (offers/answers/ICE candidates) between the peers connected to it.
 * Uses the WebSocket Hibernation API so idle rooms cost nothing.
 *
 * Clients supply a stable peer id (?peer=<uuid>) so a reconnect replaces
 * the previous socket instead of appearing as a new participant — peers
 * keep their media flowing through brief signaling outages.
 */
export class PortalRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive handled without waking the DO from hibernation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const requested = url.searchParams.get("peer") ?? "";
    const id = UUID_PATTERN.test(requested) ? requested : crypto.randomUUID();
    const name =
      (url.searchParams.get("name") ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 32) || "Guest";
    const muted = url.searchParams.get("muted") === "1";
    const cameraOff = url.searchParams.get("camoff") === "1";
    const sharing = url.searchParams.get("sharing") === "1";

    const sockets = this.ctx.getWebSockets();
    const replaced = sockets.filter((ws) => this.peerId(ws) === id);
    const others = sockets.filter((ws) => {
      const peer = this.peerId(ws);
      return peer !== null && peer !== id;
    });
    if (others.length >= MAX_PEERS) {
      return new Response("Room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name, muted, cameraOff, sharing } satisfies Attachment);

    // Close a reconnecting client's previous socket only after the new one
    // is registered, so announceDeparture sees the replacement and stays quiet.
    for (const ws of replaced) {
      try {
        ws.close(1000, "replaced");
      } catch {}
    }

    server.send(
      JSON.stringify({
        type: "welcome",
        id,
        peers: others.map((ws) => this.peerInfo(ws)),
      })
    );
    const joined = JSON.stringify({ type: "peer-joined", id, name, muted, cameraOff, sharing });
    for (const ws of others) {
      try {
        ws.send(joined);
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "state") {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) return;
      attachment.muted = !!msg.muted;
      attachment.cameraOff = !!msg.cameraOff;
      attachment.sharing = !!msg.sharing;
      ws.serializeAttachment(attachment);
      this.broadcast({ type: "peer-state", ...this.peerInfo(ws) }, ws);
      return;
    }

    if (msg.type !== "signal" || typeof msg.to !== "string") return;

    const from = this.peerId(ws);
    if (!from) return;

    const target = this.ctx
      .getWebSockets()
      .find((peer) => peer !== ws && this.peerId(peer) === msg.to);
    target?.send(JSON.stringify({ type: "signal", from, data: msg.data }));
  }

  async webSocketClose(ws: WebSocket) {
    this.announceDeparture(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.announceDeparture(ws);
  }

  private announceDeparture(ws: WebSocket) {
    const id = this.peerId(ws);
    if (!id) return;
    // A newer socket with the same id means this was a reconnect, not a departure.
    const replacedByReconnect = this.ctx
      .getWebSockets()
      .some((peer) => peer !== ws && this.peerId(peer) === id);
    if (!replacedByReconnect) {
      this.broadcast({ type: "peer-left", id }, ws);
    }
  }

  private broadcast(payload: unknown, exclude?: WebSocket) {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(message);
      } catch {
        // Socket already gone; its close handler will announce it.
      }
    }
  }

  private peerId(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    return attachment?.id ?? null;
  }

  private peerInfo(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    return {
      id: attachment?.id ?? null,
      name: attachment?.name ?? "Guest",
      muted: attachment?.muted ?? false,
      cameraOff: attachment?.cameraOff ?? false,
      sharing: attachment?.sharing ?? false,
    };
  }
}
