// Conference control surface for an SWML join_conference conference (test harness).
// - Serves SWML from /swml/conference to a SWML Webhook resource, so every inbound leg (PSTN, SIP, browser)
//   joins the room through join_conference, and records each leg's from/to/type from the webhook payload
// - Dials Calling API legs (banker, monitor, coach) straight into the room with inline SWML
// - Controls participants with Compatibility API participant REST (mute, hold, coach, remove), which is the
//   cross-surface behavior under test, and moves legs with Calling API update (park, return, transfer)
// - Builds participant state from join_conference status callbacks and shows the Compatibility API's own
//   List Participants view next to it, so discrepancies are visible
// - Pushes one snapshot to every open page over SSE

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  SW_SPACE,
  SW_PROJECT_ID,
  SW_API_TOKEN,
  PUBLIC_URL,
  CONFERENCE_NAME = "support-bridge-4",
  TRANSFER_CONFERENCE_NAME = "support-bridge-4-transfer",
  DIAL_FROM,
  STATUS_EVENT_TYPE = "relay",
  HOLD_MUSIC_URL = "https://cdn.signalwire.com/default-music/welcome.mp3",
  COMPAT_HOLD_URL,
  SUBSCRIBER_REFERENCE,
  SAT_TTL_SECONDS = "3600",
  SAT_CLIENT_BOUND = "false",
  PORT = 3000,
} = process.env;

const SAT_TTL = Number(SAT_TTL_SECONDS);
if (!Number.isFinite(SAT_TTL) || SAT_TTL < 120) {
  console.error("SAT_TTL_SECONDS must be a number of seconds, 120 or more.");
  process.exit(1);
}
// Report expiry this much early, so the SDK's refresh (scheduled 5 s before expiry_at) has slack
const SAT_EXPIRY_MARGIN_S = 60;

if (!SW_SPACE || !SW_PROJECT_ID || !SW_API_TOKEN || !PUBLIC_URL) {
  console.error("Missing SW_SPACE, SW_PROJECT_ID, SW_API_TOKEN or PUBLIC_URL. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (CONFERENCE_NAME === TRANSFER_CONFERENCE_NAME) {
  console.error("CONFERENCE_NAME and TRANSFER_CONFERENCE_NAME must differ.");
  process.exit(1);
}

const ROOMS = [CONFERENCE_NAME, TRANSFER_CONFERENCE_NAME];
const AUTH = "Basic " + Buffer.from(`${SW_PROJECT_ID}:${SW_API_TOKEN}`).toString("base64");
const COMPAT = `https://${SW_SPACE}/api/laml/2010-04-01/Accounts/${SW_PROJECT_ID}`;
const CALLING = `https://${SW_SPACE}/api/calling/calls`;
const SAT_TOKENS = `https://${SW_SPACE}/api/fabric/subscribers/tokens`;
const POLL_MS = 5000;

// ---------- REST helpers ----------

async function request(method, url, { form, json } = {}) {
  const headers = { Authorization: AUTH, Accept: "application/json" };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form);
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${url.replace(`https://${SW_SPACE}`, "")} → ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const compat = (method, apiPath, form) => request(method, COMPAT + apiPath, { form });
// dial and update carry the call inside params; every other command takes a top-level id
const calling = (command, params, id) => request("POST", CALLING, { json: { command, ...(id && { id }), params } });

// ---------- Subscriber Access Tokens ----------

// Mints a SAT for SUBSCRIBER_REFERENCE (the subscriber is created if it doesn't exist yet).
// With a DPoP fingerprint from the SDK and SAT_CLIENT_BOUND=true, it asks for sat:refresh scope so the SDK
// can refresh on its own; if the Space rejects that, it falls back to a plain SAT and the SDK calls
// refresh(), which comes back here.
async function mintSat({ fingerprint, reason }) {
  const expireAt = Math.floor(Date.now() / 1000) + SAT_TTL;
  const base = { reference: SUBSCRIBER_REFERENCE, expire_at: expireAt };
  const bound = SAT_CLIENT_BOUND === "true" && fingerprint;
  let res;
  let clientBound = false;
  if (bound) {
    try {
      res = await request("POST", SAT_TOKENS, { json: { ...base, fingerprint, scope: ["sat:refresh"] } });
      clientBound = true;
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      console.warn(`client-bound SAT rejected, minting a plain one: ${err.message}`);
    }
  }
  res ??= await request("POST", SAT_TOKENS, { json: base });
  if (!res?.token) throw new Error("Token endpoint returned no token");

  const sat = { token: res.token, expiry_at: (expireAt - SAT_EXPIRY_MARGIN_S) * 1000 };
  console.log(`SAT minted (${reason}${clientBound ? ", client-bound" : ""}) subscriber=${res.subscriber_id} expires=${new Date(expireAt * 1000).toISOString()}`);
  logEvent({ format: "sat", event: `sat-${reason}`, subscriberId: res.subscriber_id, expiresAt: new Date(expireAt * 1000).toISOString(), clientBound });
  return { ...sat, subscriberId: res.subscriber_id, reference: SUBSCRIBER_REFERENCE, clientBound };
}

// ---------- SWML documents ----------

function joinConference(room, { muted = false, coach } = {}) {
  const q = new URLSearchParams({ room, src: "harness" }); // the src key checks query-string preservation
  return {
    join_conference: {
      name: room,
      beep: "onEnter",
      start_on_enter: true,
      end_on_exit: false,
      record: "record-from-start",
      muted,
      ...(coach && { coach }),
      status_callback: `${PUBLIC_URL}/conference-events?${q}`,
      status_callback_event: "start end join leave mute hold modify",
      status_callback_event_type: STATUS_EVENT_TYPE,
      recording_status_callback: `${PUBLIC_URL}/recording-events?${q}`,
      recording_status_callback_event: "in-progress completed absent",
      recording_status_callback_event_type: "relay",
    },
  };
}

// After join_conference finishes (the leg left or was removed), SWML runs the next step.
// The announcement makes that visible when testing Delete a Participant.
const afterConference = [{ play: { url: "say:You have left the conference." } }, { hangup: {} }];

const swml = (main) => ({ version: "1.0.0", sections: { main } });
const conferenceDoc = (room, opts, { answer = false } = {}) =>
  swml([...(answer ? [{ answer: {} }] : []), joinConference(room, opts), ...afterConference]);

// Park: loop music outside any conference (goto allows at most 100 jumps), then rejoin the main room
// so a forgotten caller isn't stranded.
const holdingDoc = () =>
  swml([
    { label: "music" },
    { play: { url: HOLD_MUSIC_URL } },
    { goto: { label: "music", max: 100 } },
    joinConference(CONFERENCE_NAME),
    ...afterConference,
  ]);

// ---------- State ----------

// Every leg we know about, from the inbound webhook or from our own dial: callId → { from, to, type, origin }
const calls = new Map();
// Callback-derived room state: room name → { id, participants: Map(callId → state) }
// lastTs: newest event timestamp applied per call, kept after a leave so late-arriving older events are ignored.
const rooms = new Map(ROOMS.map((r) => [r, { id: null, participants: new Map(), lastTs: new Map() }]));
// Parked legs (outside any conference): callId → { parkedAt }
const parked = new Map();
// Recent normalized callback events, newest first
const eventLog = [];

function logEvent(entry) {
  eventLog.unshift({ at: new Date().toISOString(), ...entry });
  eventLog.length = Math.min(eventLog.length, 50);
}

function typeFromAddress(to = "") {
  if (to.startsWith("/")) return "webrtc";
  if (to.startsWith("sip:")) return "sip";
  return "phone";
}

const roomOf = (callId) => [...rooms].find(([, r]) => r.participants.has(callId))?.[0] ?? null;

async function roomIdOrThrow(name) {
  const room = rooms.get(name);
  if (room?.id) return room.id;
  const err = new Error(`No conference ID for "${name}" yet. It arrives with the first status callback.`);
  err.status = 409;
  throw err;
}

// Compatibility API's own view of a room: lookup by FriendlyName, then List Participants by ID.
// Shown beside the callback view to expose namespace and stale-list discrepancies.
async function compatView(name) {
  const view = { foundByName: null, participants: null, error: null };
  try {
    const q = new URLSearchParams({ FriendlyName: name, Status: "in-progress" });
    const { conferences = [] } = await compat("GET", `/Conferences.json?${q}`);
    view.foundByName = conferences[0]?.sid ?? null;
    const id = rooms.get(name).id ?? view.foundByName;
    if (id) {
      const { participants = [] } = await compat("GET", `/Conferences/${id}/Participants.json`);
      view.participants = participants.map((p) => ({ callSid: p.call_sid, muted: p.muted, hold: p.hold, coaching: p.coaching }));
    }
  } catch (err) {
    view.error = err.message;
  }
  return view;
}

async function snapshot() {
  const views = await Promise.all(ROOMS.map(compatView));
  return {
    statusEventType: STATUS_EVENT_TYPE,
    rooms: ROOMS.map((name, i) => {
      const room = rooms.get(name);
      return {
        name,
        id: room.id,
        participants: [...room.participants].map(([callId, s]) => ({ callId, ...(calls.get(callId) ?? {}), ...s })),
        compat: views[i],
      };
    }),
    parked: [...parked].map(([callId, p]) => ({ callId, ...(calls.get(callId) ?? {}), ...p })),
    events: eventLog,
  };
}

// ---------- Callback normalization ----------

const bool = (v) => (v === undefined || v === "" ? undefined : v === true || v === "true");

// relay: JSON { event_type: "calling.conference", params: {...} }; cxml: form-encoded Compatibility shape
function normalize(req) {
  if (req.is("application/json")) {
    const p = req.body?.params ?? {};
    return {
      format: "relay",
      ts: typeof req.body?.timestamp === "number" ? req.body.timestamp : undefined,
      event: p.status,
      callId: p.call_id,
      conferenceId: p.conference_id,
      name: p.name,
      muted: bool(p.muted),
      hold: bool(p.hold),
      coaching: bool(p.coaching),
      coachTarget: p.call_id_to_coach || null,
    };
  }
  const b = req.body ?? {};
  return {
    format: "cxml",
    ts: b.Timestamp ? Date.parse(b.Timestamp) / 1000 || undefined : undefined, // one-second resolution
    event: b.StatusCallbackEvent,
    callId: b.CallSid || undefined,
    conferenceId: b.ConferenceSid,
    name: b.FriendlyName,
    muted: bool(b.Muted),
    hold: bool(b.Hold),
    coaching: bool(b.Coaching),
    coachTarget: b.CallSidToCoach || null,
  };
}

// Callbacks can arrive out of order (a re-seat's leave has been seen after its join), so each call's
// events are applied by their own timestamp, not by arrival. Returns false when an event is stale.
function applyEvent(e, roomName) {
  const room = rooms.get(roomName);
  if (!room) return true;
  if (e.conferenceId) room.id = e.conferenceId;

  if (e.event === "conference-end") {
    room.participants.clear();
    room.lastTs.clear();
    room.id = null;
    return true;
  }
  if (!e.callId || !e.event?.startsWith("participant-")) return true;

  const last = room.lastTs.get(e.callId);
  if (e.ts !== undefined && last !== undefined && e.ts < last) return false;
  if (e.ts !== undefined) room.lastTs.set(e.callId, e.ts);

  if (e.event === "participant-leave") {
    room.participants.delete(e.callId);
    return true;
  }

  const current = room.participants.get(e.callId) ?? { joinedAt: new Date().toISOString() };
  const next = { ...current };
  for (const k of ["muted", "hold", "coaching"]) if (e[k] !== undefined) next[k] = e[k];
  if ("coachTarget" in e) next.coachTarget = e.coachTarget;
  room.participants.set(e.callId, next);
  parked.delete(e.callId); // a parked leg that rejoins is no longer parked
  return true;
}

// ---------- Live updates (SSE) ----------

const clients = new Set();
let lastPayload = "";

async function broadcast(force = false) {
  if (!clients.size) return;
  try {
    const payload = JSON.stringify(await snapshot());
    if (!force && payload === lastPayload) return;
    lastPayload = payload;
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  } catch (err) {
    console.error("broadcast failed:", err.message);
  }
}
setInterval(broadcast, POLL_MS);

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public")));

const route = (fn) => (req, res, next) => fn(req, res).catch(next);
const done = (res, body) => {
  broadcast(true);
  return body === undefined ? res.status(204).end() : res.json(body);
};

// SWML Webhook resource → External URL. Every inbound leg (PSTN, SIP domain, browser dialing the
// resource address) gets the same document, so all of them join through join_conference.
app.post("/swml/conference", (req, res) => {
  const c = req.body?.call ?? {};
  if (c.call_id) {
    calls.set(c.call_id, {
      from: c.from ?? "",
      to: c.to ?? "",
      type: c.type ?? "unknown",
      origin: "inbound",
      subscriber: c.subscriber_name ?? null,
    });
  }
  console.log(`inbound webhook: ${c.call_id} ${c.type} from=${c.from} to=${c.to}`);
  res.json(conferenceDoc(CONFERENCE_NAME, {}, { answer: true }));
});

// join_conference status_callback target (relay JSON or cxml form, per STATUS_EVENT_TYPE)
app.post("/conference-events", (req, res) => {
  const e = normalize(req);
  const roomName = req.query.room ?? e.name;
  console.log(`conference event (${e.format}) ${e.event} room=${roomName} call=${e.callId ?? "-"} query=${JSON.stringify(req.query)}`);
  console.log(JSON.stringify(req.body, null, 2));
  const applied = applyEvent(e, roomName);
  if (!applied) console.log(`  ↳ stale: older than the last event applied for ${e.callId}, ignored`);
  logEvent({ ...e, room: roomName, query: req.query, ...(!applied && { stale: true }) });
  broadcast(true);
  res.status(204).end();
});

// join_conference recording_status_callback target (relay JSON or cxml form). Logged only; recording
// events never touch participant state, so applyEvent() isn't called.
app.post("/recording-events", (req, res) => {
  const json = req.is("application/json");
  const p = json ? req.body?.params ?? {} : req.body ?? {};
  const r = json
    ? { format: "relay", status: p.status, conferenceId: p.conference_id, recordingUrl: p.recording_url, size: p.recording_file_size, duration: p.recording_duration }
    : { format: "cxml", status: p.RecordingStatus, conferenceId: p.ConferenceSid, recordingUrl: p.RecordingUrl, size: p.RecordingFileSize, duration: p.RecordingDuration };
  console.log(`recording event (${r.format}) ${r.status} room=${req.query.room} conf=${r.conferenceId} size=${r.size} duration=${r.duration} query=${JSON.stringify(req.query)}`);
  console.log(JSON.stringify(req.body, null, 2));
  logEvent({ format: "recording", event: r.status, conferenceId: r.conferenceId, recordingUrl: r.recordingUrl, size: r.size, duration: r.duration, query: req.query });
  broadcast(true);
  res.status(204).end();
});

// Calling API dial status_url target
app.post("/dial-events", (req, res) => {
  const p = req.body?.params ?? {};
  console.log(`dial event: ${p.call_state} call=${p.call_id} end_reason=${p.end_reason ?? "-"}`);
  console.log(JSON.stringify(req.body, null, 2));
  logEvent({ format: "dial", event: `call-${p.call_state}`, callId: p.call_id, endReason: p.end_reason ?? null });
  if (p.call_state === "ended") parked.delete(p.call_id);
  broadcast(true);
  res.status(204).end();
});

app.get("/api/events", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  clients.add(res);
  req.on("close", () => clients.delete(res));
  try {
    res.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
  } catch (err) {
    console.error("initial snapshot failed:", err.message);
  }
});

app.get("/api/state", route(async (_req, res) => res.json(await snapshot())));

// Browser client: get a fresh SAT. Called by the page's credential provider on authenticate() and on every
// refresh(). Body: { reason: "authenticate" | "refresh", fingerprint? }
app.post("/api/sat", route(async (req, res) => {
  if (!SUBSCRIBER_REFERENCE) {
    return res.status(501).json({ error: "SAT minting isn't configured. Set SUBSCRIBER_REFERENCE in .env." });
  }
  const { reason = "authenticate", fingerprint } = req.body ?? {};
  res.set("Cache-Control", "no-store");
  done(res, await mintSat({ reason: reason === "refresh" ? "refresh" : "authenticate", fingerprint }));
}));

// Operator: dial a new Calling API leg into a room.
// Body: { to, room?, role: "participant" | "monitor" | "coach", coachTarget? }
app.post("/api/dial", route(async (req, res) => {
  const { to, room = CONFERENCE_NAME, role = "participant", coachTarget } = req.body ?? {};
  if (!to) return res.status(400).json({ error: "Send to (a number, SIP URI, or subscriber address like /private/name)" });
  if (!DIAL_FROM) return res.status(501).json({ error: "Dialing isn't configured. Set DIAL_FROM in .env." });
  if (role === "coach" && !coachTarget) return res.status(400).json({ error: "Coach needs coachTarget (a call ID in the room)" });

  const call = await calling("dial", {
    from: DIAL_FROM,
    to,
    swml: conferenceDoc(room, { muted: role === "monitor", coach: role === "coach" ? coachTarget : undefined }),
    status_url: `${PUBLIC_URL}/dial-events`,
    status_events: ["created", "ringing", "answered", "ended"],
  });
  calls.set(call.id, { from: DIAL_FROM, to, type: typeFromAddress(to), origin: `dial:${role}` });
  logEvent({ format: "dial", event: "dial-requested", callId: call.id, to, role });
  done(res, { callId: call.id, status: call.status });
}));

// Operator: mute/unmute and hold/unhold through Compat Update a Participant. Body: { muted?, hold? }
app.post("/api/participants/:callId", route(async (req, res) => {
  const form = {};
  if (typeof req.body.muted === "boolean") form.Muted = String(req.body.muted);
  if (typeof req.body.hold === "boolean") {
    form.Hold = String(req.body.hold);
    if (req.body.hold && COMPAT_HOLD_URL) Object.assign(form, { HoldUrl: COMPAT_HOLD_URL, HoldMethod: "GET" });
  }
  if (!Object.keys(form).length) return res.status(400).json({ error: "Send muted and/or hold as booleans" });

  const roomName = roomOf(req.params.callId) ?? CONFERENCE_NAME;
  const id = await roomIdOrThrow(roomName);
  const updated = await compat("POST", `/Conferences/${id}/Participants/${req.params.callId}.json`, form);
  logEvent({ format: "api", event: "update-participant", callId: req.params.callId, sent: form, returned: { muted: updated.muted, hold: updated.hold } });
  done(res, { callId: updated.call_sid, muted: updated.muted, hold: updated.hold });
}));

// Operator: start or stop coaching through Compat Update a Participant. Body: { target: callId | null }
app.post("/api/participants/:callId/coach", route(async (req, res) => {
  const { target } = req.body ?? {};
  const form = target ? { Coaching: "true", CallSidToCoach: target } : { Coaching: "false" };
  const roomName = roomOf(req.params.callId) ?? CONFERENCE_NAME;
  const id = await roomIdOrThrow(roomName);
  const updated = await compat("POST", `/Conferences/${id}/Participants/${req.params.callId}.json`, form);
  logEvent({ format: "api", event: "update-participant", callId: req.params.callId, sent: form, returned: { coaching: updated.coaching, call_sid_to_coach: updated.call_sid_to_coach } });
  done(res, { callId: updated.call_sid, coaching: updated.coaching, coachTarget: updated.call_sid_to_coach });
}));

// Operator: remove a participant through Compat Delete a Participant.
// The leg isn't hung up: join_conference returns and the SWML plays "You have left the conference."
app.delete("/api/participants/:callId", route(async (req, res) => {
  const roomName = roomOf(req.params.callId) ?? CONFERENCE_NAME;
  const id = await roomIdOrThrow(roomName);
  await compat("DELETE", `/Conferences/${id}/Participants/${req.params.callId}.json`);
  logEvent({ format: "api", event: "delete-participant", callId: req.params.callId });
  done(res);
}));

// Operator: park outside any conference with Calling API update (inline SWML holding loop)
app.post("/api/participants/:callId/park", route(async (req, res) => {
  await calling("update", { id: req.params.callId, swml: holdingDoc() });
  parked.set(req.params.callId, { parkedAt: new Date().toISOString() });
  logEvent({ format: "api", event: "calling-update:park", callId: req.params.callId });
  done(res, { callId: req.params.callId, parked: true });
}));

// Operator: move a leg to the other room with Calling API update (inline SWML join_conference)
app.post("/api/participants/:callId/transfer", route(async (req, res) => {
  const from = roomOf(req.params.callId);
  const to = from === TRANSFER_CONFERENCE_NAME ? CONFERENCE_NAME : TRANSFER_CONFERENCE_NAME;
  await calling("update", { id: req.params.callId, swml: conferenceDoc(to) });
  logEvent({ format: "api", event: `calling-update:transfer→${to}`, callId: req.params.callId });
  done(res, { callId: req.params.callId, room: to });
}));

// Operator: re-seat a leg in its current room with Calling API update, as the workaround for participant
// controls the Calling API lacks. The leg leaves the room and rejoins with new join_conference settings.
// Body: { mode: "mute" | "unmute" | "coach", target? }  (target: call ID to coach, required for "coach")
app.post("/api/participants/:callId/reseat", route(async (req, res) => {
  const { mode, target } = req.body ?? {};
  if (!["mute", "unmute", "coach"].includes(mode)) return res.status(400).json({ error: 'Send mode as "mute", "unmute" or "coach"' });
  if (mode === "coach" && !target) return res.status(400).json({ error: "Coach needs target (a call ID in the room)" });

  const room = roomOf(req.params.callId);
  if (!room) return res.status(404).json({ error: "That call isn't in a room the console is tracking" });
  if (mode === "coach" && !rooms.get(room).participants.has(target)) {
    return res.status(409).json({ error: "The coaching target isn't in the same room" });
  }

  await calling("update", {
    id: req.params.callId,
    swml: conferenceDoc(room, { muted: mode === "mute", coach: mode === "coach" ? target : undefined }),
  });
  logEvent({ format: "api", event: `calling-update:reseat-${mode}`, callId: req.params.callId, room, ...(target && { target }) });
  done(res, { callId: req.params.callId, room, mode });
}));

// Operator: return a parked leg to the main room
app.post("/api/parked/:callId/return", route(async (req, res) => {
  if (!parked.has(req.params.callId)) return res.status(404).json({ error: "That call isn't parked" });
  await calling("update", { id: req.params.callId, swml: conferenceDoc(CONFERENCE_NAME) });
  parked.delete(req.params.callId);
  logEvent({ format: "api", event: "calling-update:return", callId: req.params.callId });
  done(res, { callId: req.params.callId, room: CONFERENCE_NAME });
}));

// Operator: hang up a leg with Calling API calling.end
app.post("/api/calls/:callId/end", route(async (req, res) => {
  await calling("calling.end", { reason: "hangup" }, req.params.callId);
  parked.delete(req.params.callId);
  logEvent({ format: "api", event: "calling.end", callId: req.params.callId });
  done(res);
}));

// Browser client: mute/unmute its own leg at the conference. Body: { muted, callId?, identity? }
// Matching order: the browser's Call.id, then IDENTITY against the leg's "from", then the only WebRTC leg.
app.post("/api/self/mute", route(async (req, res) => {
  const { muted, callId, identity } = req.body ?? {};
  if (typeof muted !== "boolean") return res.status(400).json({ error: "Send muted as a boolean" });

  const room = rooms.get(CONFERENCE_NAME);
  const legs = [...room.participants.keys()];
  const webrtc = legs.filter((id) => calls.get(id)?.type === "webrtc");
  const leg =
    (callId && legs.includes(callId) && callId) ||
    (identity && webrtc.find((id) => calls.get(id)?.from === identity)) ||
    (webrtc.length === 1 && webrtc[0]) ||
    null;
  if (!leg) {
    return res.status(409).json({
      error: callId
        ? `Call.id ${callId} isn't a participant, and no single WebRTC leg matched. Set IDENTITY in index.html.`
        : "Can't tell which WebRTC leg is yours. Set IDENTITY in index.html.",
    });
  }

  const id = await roomIdOrThrow(CONFERENCE_NAME);
  const updated = await compat("POST", `/Conferences/${id}/Participants/${leg}.json`, { Muted: String(muted) });
  logEvent({ format: "api", event: "self-mute", callId: leg, matchedBy: leg === callId ? "Call.id" : identity ? "identity" : "only-webrtc" });
  done(res, { callId: leg, muted: updated.muted, matchedByCallId: leg === callId });
}));

app.use((err, _req, res, _next) => {
  console.error(err.message);
  logEvent({ format: "error", event: "api-error", message: err.message });
  broadcast(true);
  res.status(err.status && err.status < 500 ? err.status : 502).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Browser client:   http://localhost:${PORT}/`);
  console.log(`Operator console: http://localhost:${PORT}/console.html`);
  console.log(`SWML webhook URL: ${PUBLIC_URL}/swml/conference`);
  console.log(
    SUBSCRIBER_REFERENCE
      ? `SATs:             minted for "${SUBSCRIBER_REFERENCE}", ${SAT_TTL}s lifetime${SAT_CLIENT_BOUND === "true" ? ", client-bound when the SDK sends a fingerprint" : ""}`
      : "SATs:             SUBSCRIBER_REFERENCE not set; the browser falls back to the SAT pasted in index.html",
  );
});
