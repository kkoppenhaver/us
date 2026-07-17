// Portal — WebRTC mesh client.
// Signaling: WebSocket to the PortalRoom Durable Object.
// Topology: full mesh; the newest peer to arrive initiates the offer
// to each peer already in the room, so a pair never has offer glare.

const ROOM = (new URLSearchParams(location.search).get("room") || "main")
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "")
  .slice(0, 64) || "main";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const KEEPALIVE_MS = 20_000;
const RECONNECT_MS = 2_500;

const el = (id) => document.getElementById(id);
const grid = el("video-grid");

let localStream = null;
let ws = null;
let myId = null;
let keepaliveTimer = null;
let reconnectTimer = null;
let leaving = false;

/** @type {Map<string, {pc: RTCPeerConnection, tile: HTMLElement}>} */
const peers = new Map();

// ---------- UI ----------

el("room-label").textContent = ROOM === "main" ? "" : `/ ${ROOM}`;

el("btn-join").addEventListener("click", async () => {
  el("gate-error").hidden = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    const msg = el("gate-error");
    msg.textContent =
      "Couldn't access your camera or microphone. Check browser permissions and try again.";
    msg.hidden = false;
    return;
  }
  el("local-video").srcObject = localStream;
  el("gate").hidden = true;
  connect();
});

el("btn-mic").addEventListener("click", () => toggleTrack("audio", el("btn-mic")));
el("btn-cam").addEventListener("click", () => toggleTrack("video", el("btn-cam")));

el("btn-leave").addEventListener("click", () => {
  leaving = true;
  ws?.close();
  for (const id of [...peers.keys()]) removePeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  el("local-video").srcObject = null;
  setStatus("offline", "left the portal — reload to rejoin");
});

function toggleTrack(kind, button) {
  if (!localStream) return;
  const tracks =
    kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks();
  const enabled = !(tracks[0]?.enabled ?? true);
  tracks.forEach((t) => (t.enabled = enabled));
  button.classList.toggle("off", !enabled);
}

function setStatus(state, text) {
  const dot = el("status-dot");
  dot.classList.toggle("online", state === "online");
  dot.classList.toggle("offline", state === "offline");
  el("peer-count").textContent = text;
}

function updateCount() {
  const n = peers.size;
  setStatus("online", n === 0 ? "just you" : `${n + 1} in the portal`);
  el("empty-hint").hidden = n > 0;
}

// ---------- Signaling ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${ROOM}`);

  ws.addEventListener("open", () => {
    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, KEEPALIVE_MS);
  });

  ws.addEventListener("message", async (event) => {
    if (event.data === "pong") return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome":
        myId = msg.id;
        updateCount();
        // We initiate toward everyone already here.
        for (const peerId of msg.peers) getPeer(peerId, true);
        break;
      case "peer-joined":
        // They will initiate toward us; just show the count.
        updateCount();
        break;
      case "peer-left":
        removePeer(msg.id);
        break;
      case "signal":
        await handleSignal(msg.from, msg.data);
        break;
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(keepaliveTimer);
    if (leaving) return;
    setStatus("offline", "reconnecting…");
    for (const id of [...peers.keys()]) removePeer(id);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}

function sendSignal(to, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "signal", to, data }));
  }
}

// ---------- WebRTC ----------

function getPeer(id, initiator) {
  const existing = peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const tile = createTile(id);
  const peer = { pc, tile };
  peers.set(id, peer);
  updateCount();

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) sendSignal(id, { candidate });
  });

  pc.addEventListener("track", ({ streams }) => {
    const video = tile.querySelector("video");
    if (video.srcObject !== streams[0]) video.srcObject = streams[0];
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") pc.restartIce();
    tile.classList.toggle("connected", pc.connectionState === "connected");
  });

  if (initiator) {
    pc.addEventListener("negotiationneeded", async () => {
      try {
        await pc.setLocalDescription();
        sendSignal(id, { description: pc.localDescription });
      } catch (err) {
        console.error("negotiation failed", err);
      }
    });
  }

  return peer;
}

async function handleSignal(from, data) {
  const { pc } = getPeer(from, false);
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.error("signal handling failed", err);
  }
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.tile.remove();
  peers.delete(id);
  updateCount();
}

function createTile(id) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.peer = id;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = `Visitor ${id.slice(0, 4)}`;

  tile.append(video, name);
  grid.append(tile);
  return tile;
}
