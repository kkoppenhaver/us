// Portal — WebRTC mesh client.
// Signaling: WebSocket to the PortalRoom Durable Object.
// Topology: full mesh; the newest peer to arrive initiates the offer
// to each peer already in the room, so a pair never has offer glare.
//
// Identity is stable for the life of the page (CLIENT_ID), so a signaling
// reconnect replaces our old socket server-side instead of making us look
// like a new participant — established media keeps flowing through brief
// signaling outages on both ends.

const ROOM = (new URLSearchParams(location.search).get("room") || "main")
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "")
  .slice(0, 64) || "main";

const CLIENT_ID = crypto.randomUUID();

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const KEEPALIVE_MS = 20_000;
// No pong (or any traffic) for this long = the socket is silently dead.
const LIVENESS_TIMEOUT_MS = 50_000;
const MAX_BACKOFF_MS = 30_000;
// How long to keep a peer's tile and connection after "peer-left" —
// if they rejoin within this window (signaling blip), nothing is torn down.
const PEER_LEFT_GRACE_MS = 8_000;
// Cap per-peer video upload so mesh streams don't fight for bandwidth.
const MAX_VIDEO_BITRATE = 1_000_000;

const MIC_OFF_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="3" y1="3" x2="21" y2="21"/>
  </svg>`;

const el = (id) => document.getElementById(id);
const grid = el("video-grid");
const stage = el("stage");

let localStream = null;
let ws = null;
let myId = null;
let displayName = "";
let keepaliveTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastSeen = 0;
let leaving = false;

/** @type {Map<string, {pc: RTCPeerConnection, tile: HTMLElement, videoSenders: RTCRtpSender[]}>} */
const peers = new Map();
/** @type {Map<string, number>} peer id -> removal timeout */
const pendingRemovals = new Map();
/** @type {Map<string, string>} peer id -> display name */
const names = new Map();
/** @type {Map<string, {muted: boolean, cameraOff: boolean}>} */
const states = new Map();

// ---------- UI ----------

el("room-label").textContent = ROOM === "main" ? "" : `/ ${ROOM}`;

const nameInput = el("name-input");
const joinBtn = el("btn-join");
nameInput.value = localStorage.getItem("portal-name") ?? "";
const syncJoinButton = () => {
  joinBtn.disabled = nameInput.value.trim().length === 0;
};
nameInput.addEventListener("input", syncJoinButton);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !joinBtn.disabled) joinBtn.click();
});
syncJoinButton();

joinBtn.addEventListener("click", async () => {
  el("gate-error").hidden = true;
  displayName = nameInput.value.trim().slice(0, 32);
  if (!displayName) return;
  localStorage.setItem("portal-name", displayName);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Non-standard but harmless where unsupported; enables OS-level
        // voice isolation on platforms that offer it (e.g. recent macOS).
        voiceIsolation: true,
      },
    });
  } catch (err) {
    const msg = el("gate-error");
    msg.textContent =
      "Couldn't access your camera or microphone. Check browser permissions and try again.";
    msg.hidden = false;
    return;
  }
  el("local-video").srcObject = localStream;
  el("local-avatar").textContent = displayName[0].toUpperCase();
  el("local-tile").querySelector(".tile-name").textContent = displayName;
  el("gate").hidden = true;
  connect();

  // Restore ML noise suppression if it was on last time. Called inside the
  // click handler so the AudioContext starts within a user gesture.
  if (localStorage.getItem("portal-ns") === "1") {
    setNoiseSuppression(true);
  }
});

el("btn-mic").addEventListener("click", () => toggleTrack("audio", el("btn-mic")));
el("btn-cam").addEventListener("click", () => toggleTrack("video", el("btn-cam")));
el("btn-ns").addEventListener("click", () => setNoiseSuppression(!nsEnabled));

el("btn-leave").addEventListener("click", () => {
  leaving = true;
  clearTimeout(reconnectTimer);
  ws?.close();
  for (const id of [...peers.keys()]) removePeer(id);
  localStream?.getTracks().forEach((t) => t.stop());
  processedTrack?.stop();
  audioCtx?.close();
  el("local-video").srcObject = null;
  setStatus("offline", "left the portal — reload to rejoin");
});

// ---------- Noise suppression (RNNoise WASM worklet) ----------
// Mic → AudioWorklet(RNNoise) → MediaStreamDestination; the processed
// track is hot-swapped into every peer connection via replaceTrack(),
// so toggling never renegotiates. Layered on top of the browser's own
// noiseSuppression constraint.

let nsEnabled = false;
let audioCtx = null;
let sourceNode = null;
let rnnoiseNode = null;
let processedTrack = null;

function activeAudioTrack() {
  const raw = localStream?.getAudioTracks()[0] ?? null;
  return nsEnabled && processedTrack ? processedTrack : raw;
}

async function setNoiseSuppression(on) {
  const button = el("btn-ns");
  const micTrack = localStream?.getAudioTracks()[0];
  if (!micTrack) return;

  try {
    if (on && !processedTrack) {
      button.disabled = true;
      // RNNoise operates on 48 kHz frames.
      audioCtx = new AudioContext({ sampleRate: 48000 });
      const { loadRnnoise, RnnoiseWorkletNode } = await import("/vendor/noise/index.js");
      const wasmBinary = await loadRnnoise({
        url: "/vendor/noise/rnnoise.wasm",
        simdUrl: "/vendor/noise/rnnoise_simd.wasm",
      });
      await audioCtx.audioWorklet.addModule("/vendor/noise/rnnoise-worklet.js");

      sourceNode = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
      rnnoiseNode = new RnnoiseWorkletNode(audioCtx, { wasmBinary, maxChannels: 1 });
      const destination = audioCtx.createMediaStreamDestination();
      sourceNode.connect(rnnoiseNode);
      rnnoiseNode.connect(destination);
      processedTrack = destination.stream.getAudioTracks()[0];
    }

    // Suspend the graph when off so the worklet costs no CPU.
    if (audioCtx) await (on ? audioCtx.resume() : audioCtx.suspend());

    nsEnabled = on;
    const track = activeAudioTrack();
    await Promise.all(
      [...peers.values()].map(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        return sender ? sender.replaceTrack(track) : Promise.resolve();
      })
    );

    button.classList.toggle("active", on);
    localStorage.setItem("portal-ns", on ? "1" : "0");
  } catch (err) {
    console.error("noise suppression unavailable", err);
    nsEnabled = false;
    button.classList.remove("active");
    localStorage.setItem("portal-ns", "0");
  } finally {
    button.disabled = false;
  }
}

window.addEventListener("online", () => {
  if (leaving || !localStream) return;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    clearTimeout(reconnectTimer);
    connect();
  }
});

function toggleTrack(kind, button) {
  if (!localStream) return;
  const tracks =
    kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks();
  const enabled = !(tracks[0]?.enabled ?? true);
  tracks.forEach((t) => (t.enabled = enabled));
  button.classList.toggle("off", !enabled);

  const { muted, cameraOff } = currentState();
  const localTile = el("local-tile");
  localTile.classList.toggle("muted", muted);
  localTile.classList.toggle("cam-off", cameraOff);
  sendState();
}

function currentState() {
  return {
    muted: !(localStream?.getAudioTracks()[0]?.enabled ?? true),
    cameraOff: !(localStream?.getVideoTracks()[0]?.enabled ?? true),
  };
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
  // With company, your own view shrinks to a picture-in-picture overlay.
  stage.classList.toggle("has-peers", n > 0);
}

// ---------- Signaling ----------

function connect() {
  const { muted, cameraOff } = currentState();
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
      `/ws?room=${ROOM}&peer=${CLIENT_ID}` +
      `&name=${encodeURIComponent(displayName)}` +
      `&muted=${muted ? 1 : 0}&camoff=${cameraOff ? 1 : 0}`
  );

  ws.addEventListener("open", () => {
    lastSeen = Date.now();
    keepaliveTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastSeen > LIVENESS_TIMEOUT_MS) {
        // Silently dead socket — force the close path so we reconnect.
        ws.close();
        return;
      }
      ws.send("ping");
    }, KEEPALIVE_MS);
  });

  ws.addEventListener("message", async (event) => {
    lastSeen = Date.now();
    if (event.data === "pong") return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome": {
        myId = msg.id;
        reconnectAttempts = 0;
        // Anyone we still hold that isn't in the room anymore left while
        // we were disconnected.
        const present = new Set(msg.peers.map((p) => p.id));
        for (const id of [...peers.keys()]) {
          if (!present.has(id)) removePeer(id);
        }
        for (const peer of msg.peers) {
          cancelRemoval(peer.id);
          names.set(peer.id, peer.name);
          // We initiate toward peers we don't already have a connection to.
          getPeer(peer.id, true);
          applyPeerState(peer.id, peer);
        }
        updateCount();
        break;
      }
      case "peer-joined":
        // A rejoin within the grace window keeps the existing connection.
        cancelRemoval(msg.id);
        names.set(msg.id, msg.name);
        applyPeerState(msg.id, msg);
        peers.get(msg.id)?.tile.querySelector(".tile-name")
          .replaceChildren(document.createTextNode(msg.name));
        updateCount();
        break;
      case "peer-left":
        scheduleRemoval(msg.id);
        break;
      case "peer-state":
        applyPeerState(msg.id, msg);
        break;
      case "signal":
        await handleSignal(msg.from, msg.data);
        break;
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(keepaliveTimer);
    if (leaving) return;
    // Keep peer connections — media is P2P and usually survives a
    // signaling blip. Peers get pruned via welcome/peer-left on reconnect.
    setStatus("offline", "signal lost — reconnecting…");
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const delay =
    Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** reconnectAttempts) +
    Math.random() * 1_000;
  reconnectAttempts++;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

function sendSignal(to, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "signal", to, data }));
  }
}

function sendState() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "state", ...currentState() }));
  }
}

// ---------- WebRTC ----------

function getPeer(id, initiator) {
  const existing = peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const tile = createTile(id);
  const videoSenders = [];
  const peer = { pc, tile, videoSenders };
  peers.set(id, peer);
  updateCount();

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    const sender = pc.addTrack(videoTrack, localStream);
    videoSenders.push(sender);
    capVideoSender(sender);
  }
  const audioTrack = activeAudioTrack();
  if (audioTrack) pc.addTrack(audioTrack, localStream);

  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) sendSignal(id, { candidate });
  });

  pc.addEventListener("track", ({ streams }) => {
    const video = tile.querySelector("video");
    if (video.srcObject !== streams[0]) video.srcObject = streams[0];
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") pc.restartIce();
    if (pc.connectionState === "connected") {
      // Encodings only exist after negotiation; re-apply the cap now.
      videoSenders.forEach(capVideoSender);
    }
    tile.classList.toggle("connected", pc.connectionState === "connected");
    updateConnChip(tile, pc.connectionState);
  });
  updateConnChip(tile, "connecting");

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

async function capVideoSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    for (const encoding of params.encodings) {
      encoding.maxBitrate = MAX_VIDEO_BITRATE;
    }
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params);
  } catch {
    // Not negotiated yet — retried on the "connected" state change.
  }
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

const CONN_LABELS = {
  new: "connecting…",
  connecting: "connecting…",
  disconnected: "unstable…",
  failed: "reconnecting…",
};

function updateConnChip(tile, state) {
  const chip = tile.querySelector(".tile-conn");
  if (!chip) return;
  const label = CONN_LABELS[state];
  chip.hidden = !label;
  if (label) chip.textContent = label;
  chip.classList.toggle("bad", state === "failed");
}

// ---------- Connection stats (hover a tile to see them) ----------

/** @type {Map<string, {bytes: number, lost: number, received: number, ts: number}>} */
const prevStats = new Map();

setInterval(async () => {
  for (const [id, peer] of peers) {
    if (peer.pc.connectionState !== "connected") continue;
    try {
      const report = await peer.pc.getStats();
      let bytes = 0;
      let lost = 0;
      let received = 0;
      let rtt = null;
      report.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          bytes += r.bytesReceived ?? 0;
          lost += r.packetsLost ?? 0;
          received += r.packetsReceived ?? 0;
        }
        if (
          r.type === "candidate-pair" &&
          r.nominated &&
          r.state === "succeeded" &&
          r.currentRoundTripTime !== undefined
        ) {
          rtt = r.currentRoundTripTime;
        }
      });

      const now = performance.now();
      const prev = prevStats.get(id);
      prevStats.set(id, { bytes, lost, received, ts: now });
      if (!prev) continue;

      const kbps = Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.ts)));
      const dLost = lost - prev.lost;
      const dReceived = received - prev.received;
      const lossPct = dLost + dReceived > 0 ? (dLost / (dLost + dReceived)) * 100 : 0;

      const parts = [`↓ ${kbps} kbps`];
      if (rtt !== null) parts.push(`${Math.round(rtt * 1000)} ms`);
      parts.push(`${lossPct.toFixed(1)}% loss`);
      peer.tile.querySelector(".tile-stats").textContent = parts.join(" · ");
    } catch {
      // Peer torn down mid-poll; next tick skips it.
    }
  }
}, 2_000);

function applyPeerState(id, { muted, cameraOff }) {
  states.set(id, { muted: !!muted, cameraOff: !!cameraOff });
  const tile = peers.get(id)?.tile;
  if (tile) {
    tile.classList.toggle("muted", !!muted);
    tile.classList.toggle("cam-off", !!cameraOff);
  }
}

function scheduleRemoval(id) {
  const peer = peers.get(id);
  if (!peer || pendingRemovals.has(id)) return;
  peer.tile.classList.add("stale");
  pendingRemovals.set(
    id,
    setTimeout(() => {
      pendingRemovals.delete(id);
      removePeer(id);
    }, PEER_LEFT_GRACE_MS)
  );
}

function cancelRemoval(id) {
  const timer = pendingRemovals.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingRemovals.delete(id);
  }
  peers.get(id)?.tile.classList.remove("stale");
}

function removePeer(id) {
  cancelRemoval(id);
  const peer = peers.get(id);
  names.delete(id);
  states.delete(id);
  prevStats.delete(id);
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

  const name = names.get(id) ?? `Visitor ${id.slice(0, 4)}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;

  const overlay = document.createElement("div");
  overlay.className = "cam-overlay";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = name[0].toUpperCase();
  overlay.append(avatar);

  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = name;

  const badge = document.createElement("span");
  badge.className = "tile-badge";
  badge.innerHTML = MIC_OFF_SVG;

  const conn = document.createElement("span");
  conn.className = "tile-conn";
  conn.hidden = true;

  const stats = document.createElement("span");
  stats.className = "tile-stats";

  tile.append(video, overlay, label, badge, conn, stats);
  grid.append(tile);

  const state = states.get(id);
  if (state) applyPeerState(id, state);
  return tile;
}
