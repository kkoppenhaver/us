import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const MAX_PEERS = 8;

interface Attachment {
  id: string;
}

interface ClientMessage {
  type: "signal";
  to: string;
  data: unknown;
}

/**
 * One PortalRoom per room name. Relays WebRTC signaling messages
 * (offers/answers/ICE candidates) between the peers connected to it.
 * Uses the WebSocket Hibernation API so idle rooms cost nothing.
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

    const existing = this.ctx.getWebSockets();
    if (existing.length >= MAX_PEERS) {
      return new Response("Room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id } satisfies Attachment);

    const peers = existing.map((ws) => this.peerId(ws)).filter(Boolean);
    server.send(JSON.stringify({ type: "welcome", id, peers }));
    this.broadcast({ type: "peer-joined", id }, server);

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
    if (msg.type !== "signal" || typeof msg.to !== "string") return;

    const from = this.peerId(ws);
    if (!from) return;

    const target = this.ctx
      .getWebSockets()
      .find((peer) => this.peerId(peer) === msg.to);
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
    if (id) this.broadcast({ type: "peer-left", id }, ws);
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
}
