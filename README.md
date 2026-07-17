# Portal 🌀

A WebRTC video portal — a live video window between everyone who opens the page. Running at [us.keanan.fun](https://us.keanan.fun).

## How it works

- **Cloudflare Worker** serves the static frontend and routes `/ws?room=<name>` to a Durable Object.
- **`PortalRoom` Durable Object** (one per room, WebSocket Hibernation API) relays WebRTC signaling — offers, answers, and ICE candidates — between the peers in a room and broadcasts join/leave events.
- **The browsers** connect directly to each other in a full WebRTC mesh: the newest arrival initiates an offer to each peer already present, so there is never offer glare. Media never touches the server.

Rooms are capped at 8 peers (`MAX_PEERS` in `src/room.ts`) since mesh upload cost grows with each participant. Any `?room=name` gets its own isolated portal; the bare URL is the `main` room.

## Development

```sh
npm install
npm run dev        # local dev server on :8787
npm run typecheck
```

## Deploy

```sh
npm run deploy
```

The custom domain is configured in `wrangler.jsonc` (`routes`) and requires the zone to exist on the Cloudflare account you deploy from. The `workers.dev` URL works regardless.

## Known limitations

- STUN-only ICE (Google public STUN). Peers where both sides are behind strict/symmetric NAT need a TURN relay to connect — Cloudflare Calls TURN is the planned fix.
- Only the connection initiator can renegotiate; full perfect negotiation (and with it robust ICE restarts) is on the roadmap.
