// Portal — WebRTC mesh client.
// Signaling: WebSocket to the PortalRoom Durable Object.
// Topology: full mesh. The newcomer's connections send the first offer
// (existing peers create theirs lazily on receipt), and every pair runs
// the "perfect negotiation" pattern so either side can renegotiate later
// (ICE restarts, device changes); simultaneous offers resolve by role —
// the peer with the lower id politely rolls back.
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

const FALLBACK_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Replaced with Cloudflare TURN servers (STUN included) when /turn responds;
// TURN relays media for peers whose networks block direct connections.
let iceServers = FALLBACK_ICE_SERVERS;

async function loadIceServers() {
  try {
    const res = await fetch("/turn");
    if (!res.ok) return;
    const data = await res.json();
    const servers = Array.isArray(data.iceServers)
      ? data.iceServers
      : [data.iceServers];
    if (servers.length && servers[0]?.urls) {
      iceServers = [...servers, ...FALLBACK_ICE_SERVERS];
    }
  } catch {
    // STUN-only fallback stands.
  }
}

const KEEPALIVE_MS = 20_000;
// No pong (or any traffic) for this long = the socket is silently dead.
const LIVENESS_TIMEOUT_MS = 50_000;
const MAX_BACKOFF_MS = 30_000;
// How long to keep a peer's tile and connection after "peer-left" —
// if they rejoin within this window (signaling blip), nothing is torn down.
const PEER_LEFT_GRACE_MS = 8_000;
// Cap per-peer video upload so mesh streams don't fight for bandwidth.
// Screen shares get more headroom and hold resolution (text legibility);
// cameras hold framerate.
const CAMERA_PROFILE = { maxBitrate: 1_000_000, degradation: "maintain-framerate" };
const SCREEN_PROFILE = { maxBitrate: 2_500_000, degradation: "maintain-resolution" };

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  // Non-standard but harmless where unsupported; enables OS-level
  // voice isolation on platforms that offer it (e.g. recent macOS).
  voiceIsolation: true,
};
const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

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

  // Prefer the devices used last time; "ideal" quietly falls back if
  // they're unplugged.
  const savedMic = localStorage.getItem("portal-mic");
  const savedCam = localStorage.getItem("portal-cam");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { ...VIDEO_CONSTRAINTS, ...(savedCam && { deviceId: { ideal: savedCam } }) },
      audio: { ...AUDIO_CONSTRAINTS, ...(savedMic && { deviceId: { ideal: savedMic } }) },
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
  refreshDevices();
  // TURN credentials must be in hand before the first peer connection.
  await loadIceServers();
  connect();

  // Restore enhancement toggles from last time. Called inside the click
  // handler so the audio/video pipelines start within a user gesture.
  if (localStorage.getItem("portal-ns") === "1") {
    setNoiseSuppression(true);
  }
  if (localStorage.getItem("portal-blur") === "1") {
    setBackgroundBlur(true);
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
  screenTrack?.stop();
  stopBlurPipeline();
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
    sharing: !!screenTrack,
  };
}

// ---------- Device picker ----------

const settingsPanel = el("settings-panel");

el("btn-settings").addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) refreshDevices();
});

async function refreshDevices() {
  if (!localStream) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillDeviceSelect(el("sel-mic"), devices, "audioinput",
    localStream.getAudioTracks()[0]?.getSettings().deviceId);
  fillDeviceSelect(el("sel-cam"), devices, "videoinput",
    localStream.getVideoTracks()[0]?.getSettings().deviceId);
}

function fillDeviceSelect(select, devices, kind, currentId) {
  select.replaceChildren(
    ...devices
      .filter((d) => d.kind === kind && d.deviceId)
      .map((d, i) => {
        const option = document.createElement("option");
        option.value = d.deviceId;
        option.textContent = d.label || `${kind === "audioinput" ? "Microphone" : "Camera"} ${i + 1}`;
        option.selected = d.deviceId === currentId;
        return option;
      })
  );
}

navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);

el("sel-mic").addEventListener("change", (e) => switchDevice("audio", e.target.value));
el("sel-cam").addEventListener("change", (e) => switchDevice("video", e.target.value));

async function switchDevice(kind, deviceId) {
  if (!localStream) return;
  let newTrack;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === "audio"
        ? { audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } } }
        : { video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } } }
    );
    newTrack = stream.getTracks()[0];
  } catch (err) {
    console.error("device switch failed", err);
    refreshDevices();
    return;
  }

  const oldTrack =
    kind === "audio" ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
  newTrack.enabled = oldTrack?.enabled ?? true; // carry mute state over
  if (oldTrack) {
    localStream.removeTrack(oldTrack);
    oldTrack.stop();
  }
  localStream.addTrack(newTrack);
  localStorage.setItem(kind === "audio" ? "portal-mic" : "portal-cam", deviceId);

  if (kind === "audio") {
    if (sourceNode) {
      // Re-point the noise-suppression graph at the new mic.
      sourceNode.disconnect();
      sourceNode = audioCtx.createMediaStreamSource(new MediaStream([newTrack]));
      sourceNode.connect(rnnoiseNode);
    }
    // Peers receive the processed track while NS is on; nothing to swap then.
    if (!nsEnabled) await replaceOutgoing("audio", newTrack);
  } else if (blurEnabled && blurSourceVideo) {
    // Peers receive the blur canvas track; just re-point its camera feed.
    blurSourceVideo.srcObject = new MediaStream([newTrack]);
    await blurSourceVideo.play().catch(() => {});
  } else if (!screenTrack) {
    // While screen sharing, the camera swap shows up when sharing ends.
    await replaceOutgoing("video", newTrack);
  }
}

async function replaceOutgoing(kind, track) {
  await Promise.all(
    [...peers.values()].map(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      return sender ? sender.replaceTrack(track) : Promise.resolve();
    })
  );
}

// ---------- Screen sharing ----------

let screenTrack = null;

el("btn-share").addEventListener("click", async () => {
  if (!localStream) return;
  if (screenTrack) {
    stopScreenShare();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch {
    return; // picker dismissed
  }
  screenTrack = stream.getVideoTracks()[0];
  // Browser-chrome "Stop sharing" button ends the track out from under us.
  screenTrack.addEventListener("ended", stopScreenShare);

  await replaceOutgoing("video", screenTrack);
  recapVideoSenders();
  el("local-video").srcObject = new MediaStream([screenTrack]);
  el("local-tile").classList.add("sharing");
  el("btn-share").classList.add("active");
  sendState();
});

function stopScreenShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  const track = activeVideoTrack(); // blurred camera if blur is on
  if (track) replaceOutgoing("video", track);
  recapVideoSenders();
  el("local-video").srcObject =
    blurEnabled && blurTrack ? new MediaStream([blurTrack]) : localStream;
  el("local-tile").classList.remove("sharing");
  el("btn-share").classList.remove("active");
  sendState();
}

function recapVideoSenders() {
  for (const peer of peers.values()) {
    peer.videoSenders.forEach(capVideoSender);
  }
}

// ---------- Background blur (MediaPipe selfie segmentation) ----------
// Camera → hidden <video> → segmenter (person confidence mask) → canvas
// composite (blurred frame under sharp masked person) → captureStream
// track, swapped into peers via replaceTrack. Precedence for the outgoing
// video track: screen share > blurred camera > raw camera.

let blurEnabled = false;
let blurTrack = null;
let segmenter = null;
let blurSourceVideo = null;
let blurStopped = null;
let blurCanvas, blurCtx, personCanvas, personCtx, maskCanvas, maskCtx, maskImageData;

function activeVideoTrack() {
  if (screenTrack) return screenTrack;
  if (blurEnabled && blurTrack) return blurTrack;
  return localStream?.getVideoTracks()[0] ?? null;
}

el("btn-blur").addEventListener("click", () => setBackgroundBlur(!blurEnabled));

async function setBackgroundBlur(on) {
  if (!localStream || on === blurEnabled) return;
  const button = el("btn-blur");
  button.disabled = true;
  try {
    if (on) {
      await startBlurPipeline();
      blurEnabled = true;
    } else {
      blurEnabled = false;
      stopBlurPipeline();
    }
    if (!screenTrack) {
      await replaceOutgoing("video", activeVideoTrack());
      el("local-video").srcObject =
        blurEnabled && blurTrack ? new MediaStream([blurTrack]) : localStream;
    }
    button.classList.toggle("active", blurEnabled);
    localStorage.setItem("portal-blur", blurEnabled ? "1" : "0");
  } catch (err) {
    console.error("background blur unavailable", err);
    blurEnabled = false;
    stopBlurPipeline();
    button.classList.remove("active");
    localStorage.setItem("portal-blur", "0");
  } finally {
    button.disabled = false;
  }
}

async function startBlurPipeline() {
  if (!segmenter) {
    const vision = await import("/vendor/segment/vision_bundle.mjs");
    const fileset = await vision.FilesetResolver.forVisionTasks("/vendor/segment/wasm");
    segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "/vendor/segment/selfie_segmenter.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  }

  blurSourceVideo = document.createElement("video");
  blurSourceVideo.muted = true;
  blurSourceVideo.playsInline = true;
  blurSourceVideo.srcObject = new MediaStream([localStream.getVideoTracks()[0]]);
  await blurSourceVideo.play();

  const w = blurSourceVideo.videoWidth || 1280;
  const h = blurSourceVideo.videoHeight || 720;
  blurCanvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  blurCtx = blurCanvas.getContext("2d");
  personCanvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  personCtx = personCanvas.getContext("2d");
  maskCanvas = document.createElement("canvas");
  maskCtx = maskCanvas.getContext("2d");
  maskImageData = null;

  let running = true;
  blurStopped = () => {
    running = false;
  };
  const schedule = blurSourceVideo.requestVideoFrameCallback
    ? (cb) => blurSourceVideo.requestVideoFrameCallback(cb)
    : (cb) => setTimeout(cb, 33);
  const tick = () => {
    if (!running) return;
    if (blurSourceVideo.readyState >= 2) {
      try {
        segmenter.segmentForVideo(blurSourceVideo, performance.now(), renderBlurFrame);
      } catch (err) {
        console.error("segmentation frame failed", err);
      }
    }
    schedule(tick);
  };
  schedule(tick);

  blurTrack = blurCanvas.captureStream(30).getVideoTracks()[0];
}

function renderBlurFrame(result) {
  try {
    // Selfie segmenter: category 0 = background, 1 = person. With a
    // two-entry mask list the person confidence is last; a single-mask
    // model output is the person channel.
    const masks = result.confidenceMasks;
    const mask = masks?.[masks.length - 1];
    if (!mask || !blurCtx) return;

    const mw = mask.width;
    const mh = mask.height;
    if (!maskImageData || maskCanvas.width !== mw || maskCanvas.height !== mh) {
      maskCanvas.width = mw;
      maskCanvas.height = mh;
      maskImageData = maskCtx.createImageData(mw, mh);
    }
    const confidence = mask.getAsFloat32Array();
    const px = maskImageData.data;
    for (let i = 0; i < confidence.length; i++) {
      px[i * 4 + 3] = confidence[i] * 255; // person confidence → alpha
    }
    maskCtx.putImageData(maskImageData, 0, 0);

    const w = blurCanvas.width;
    const h = blurCanvas.height;
    personCtx.clearRect(0, 0, w, h);
    personCtx.drawImage(blurSourceVideo, 0, 0, w, h);
    personCtx.globalCompositeOperation = "destination-in";
    personCtx.drawImage(maskCanvas, 0, 0, w, h);
    personCtx.globalCompositeOperation = "source-over";

    blurCtx.filter = "blur(16px)";
    blurCtx.drawImage(blurSourceVideo, 0, 0, w, h);
    blurCtx.filter = "none";
    blurCtx.drawImage(personCanvas, 0, 0, w, h);
  } finally {
    result.close?.();
  }
}

function stopBlurPipeline() {
  blurStopped?.();
  blurStopped = null;
  blurTrack?.stop();
  blurTrack = null;
  if (blurSourceVideo) {
    blurSourceVideo.srcObject = null;
    blurSourceVideo = null;
  }
}

// ---------- Join/leave chimes ----------

let chimeCtx = null;

function chime(ascending) {
  try {
    chimeCtx = chimeCtx ?? new AudioContext();
    if (chimeCtx.state === "suspended") chimeCtx.resume();
    const notes = ascending ? [523.25, 783.99] : [783.99, 523.25]; // C5↔G5
    for (const [i, freq] of notes.entries()) {
      const osc = chimeCtx.createOscillator();
      const gain = chimeCtx.createGain();
      const t = chimeCtx.currentTime + i * 0.13;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(chimeCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  } catch {
    // No audio output available; chimes are decorative.
  }
}

// ---------- Active speaker highlight ----------

const SPEAKING_LEVEL = 0.02;
const SPEAKING_HOLD_MS = 700;
/** @type {Map<string, number>} peer id (or "self") -> last time above threshold */
const lastSpoke = new Map();

setInterval(async () => {
  if (document.hidden) return;
  const now = performance.now();

  await Promise.all(
    [...peers.entries()].map(async ([id, peer]) => {
      if (peer.pc.connectionState !== "connected") {
        peer.tile.classList.remove("speaking");
        return;
      }
      try {
        const stats = await peer.pc.getStats();
        let level = 0;
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && r.kind === "audio" && r.audioLevel !== undefined) {
            level = Math.max(level, r.audioLevel);
          }
        });
        if (level > SPEAKING_LEVEL) lastSpoke.set(id, now);
        peer.tile.classList.toggle(
          "speaking",
          now - (lastSpoke.get(id) ?? 0) < SPEAKING_HOLD_MS
        );
      } catch {}
    })
  );

  // Our own level comes from any connected pc's media-source stat.
  const anyPc = [...peers.values()].find((p) => p.pc.connectionState === "connected")?.pc;
  if (anyPc) {
    try {
      const stats = await anyPc.getStats();
      let level = 0;
      stats.forEach((r) => {
        if (r.type === "media-source" && r.kind === "audio" && r.audioLevel !== undefined) {
          level = r.audioLevel;
        }
      });
      if (level > SPEAKING_LEVEL) lastSpoke.set("self", now);
      el("local-tile").classList.toggle(
        "speaking",
        now - (lastSpoke.get("self") ?? 0) < SPEAKING_HOLD_MS
      );
    } catch {}
  } else {
    el("local-tile").classList.remove("speaking");
  }
}, 300);

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
  const { muted, cameraOff, sharing } = currentState();
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
      `/ws?room=${ROOM}&peer=${CLIENT_ID}` +
      `&name=${encodeURIComponent(displayName)}` +
      `&muted=${muted ? 1 : 0}&camoff=${cameraOff ? 1 : 0}&sharing=${sharing ? 1 : 0}`
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
        for (const info of msg.peers) {
          cancelRemoval(info.id);
          names.set(info.id, info.name);
          // As the newcomer we create the connection (its negotiationneeded
          // sends the first offer); existing peers create theirs on our offer.
          const peer = getPeer(info.id);
          // A connection that died while signaling was down gets restarted
          // now that we can renegotiate again.
          if (peer.pc.connectionState === "failed") peer.pc.restartIce();
          applyPeerState(info.id, info);
        }
        updateCount();
        break;
      }
      case "peer-joined":
        // Chime for genuine arrivals and grace-window returns (whose
        // departure already chimed), not for silent socket replacements.
        if (!peers.has(msg.id) || pendingRemovals.has(msg.id)) chime(true);
        // A rejoin within the grace window keeps the existing connection.
        cancelRemoval(msg.id);
        names.set(msg.id, msg.name);
        applyPeerState(msg.id, msg);
        peers.get(msg.id)?.tile.querySelector(".tile-name")
          .replaceChildren(document.createTextNode(msg.name));
        updateCount();
        break;
      case "peer-left":
        if (peers.has(msg.id) && !pendingRemovals.has(msg.id)) chime(false);
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

function getPeer(id) {
  const existing = peers.get(id);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers });
  const tile = createTile(id);
  const videoSenders = [];
  // Perfect negotiation (per pair): the peer with the lower id is "polite" —
  // on simultaneous offers it rolls back and accepts the other side's.
  const peer = {
    pc,
    tile,
    videoSenders,
    polite: CLIENT_ID < id,
    makingOffer: false,
    ignoreOffer: false,
    settingRemoteAnswer: false,
  };
  peers.set(id, peer);
  updateCount();

  const videoTrack = activeVideoTrack();
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
    if (pc.connectionState === "connected") {
      // Encodings only exist after negotiation; re-apply the cap now.
      videoSenders.forEach(capVideoSender);
    }
    tile.classList.toggle("connected", pc.connectionState === "connected");
    updateConnChip(tile, pc.connectionState);
  });
  updateConnChip(tile, "connecting");

  // With perfect negotiation either side can restart ICE; the resulting
  // offer glare (both sides restarting at once) resolves via politeness.
  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "failed") pc.restartIce();
  });

  pc.addEventListener("negotiationneeded", async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(id, { description: pc.localDescription });
    } catch (err) {
      console.error("negotiation failed", err);
    } finally {
      peer.makingOffer = false;
    }
  });

  return peer;
}

async function capVideoSender(sender) {
  const profile = screenTrack ? SCREEN_PROFILE : CAMERA_PROFILE;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    for (const encoding of params.encodings) {
      encoding.maxBitrate = profile.maxBitrate;
    }
    params.degradationPreference = profile.degradation;
    await sender.setParameters(params);
  } catch {
    // Not negotiated yet — retried on the "connected" state change.
  }
}

async function handleSignal(from, data) {
  const peer = getPeer(from);
  const { pc } = peer;
  try {
    if (data.description) {
      const { description } = data;
      // Perfect negotiation: an offer that arrives while we're mid-offer
      // (or otherwise not stable) is a collision. The impolite peer ignores
      // it and lets its own offer win; the polite peer's
      // setRemoteDescription implicitly rolls back its offer and answers.
      const readyForOffer =
        !peer.makingOffer &&
        (pc.signalingState === "stable" || peer.settingRemoteAnswer);
      const offerCollision = description.type === "offer" && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;

      peer.settingRemoteAnswer = description.type === "answer";
      await pc.setRemoteDescription(description);
      peer.settingRemoteAnswer = false;
      if (description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        // Candidates for an offer we deliberately ignored are expected noise.
        if (!peer.ignoreOffer) throw err;
      }
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

function applyPeerState(id, { muted, cameraOff, sharing }) {
  states.set(id, { muted: !!muted, cameraOff: !!cameraOff, sharing: !!sharing });
  const tile = peers.get(id)?.tile;
  if (tile) {
    tile.classList.toggle("muted", !!muted);
    tile.classList.toggle("cam-off", !!cameraOff);
    tile.classList.toggle("sharing", !!sharing);
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
  lastSpoke.delete(id);
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
