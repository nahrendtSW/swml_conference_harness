# Setup Guide: SWML `join_conference` Conference, with Operator Console

> **Test harness, not production code.** This example tests how the Compatibility API and the Calling API interoperate when every leg joins a conference through SWML. The console has no login, `/api/sat` hands out tokens to anyone who can reach it, and the server doesn't validate webhook signatures, so run it only on a trusted machine or network.

## Overview

This is the SWML counterpart of a cXML `<Conference>` setup. Every leg joins the room `support-bridge-4` through SWML [`join_conference`](https://signalwire.com/docs/swml/reference/calling/join-conference), never through cXML `<Conference>`:

- **Inbound legs** (PSTN numbers, SIP, and browsers dialing the resource address) reach a SWML Webhook resource whose External URL is this server's `/swml/conference`. The server records each leg's `from`, `to` and `type` from the [SWML inbound call webhook](https://signalwire.com/docs/apis/rest/swml-webhook/webhooks/inbound-call-webhook) payload and returns the `join_conference` document.
- **Outbound legs** (a banker, monitor, or coach) are created by the console with the Calling API [`dial`](https://signalwire.com/docs/apis/rest/calls/call-commands) command, with inline SWML that runs `join_conference`. This is a common shape for agent and supervisor legs.

Control is deliberately split across both surfaces, because that split is what's under test:

| Action | Surface | Endpoint |
| --- | --- | --- |
| Mute, Hold, Coach | Compatibility API | [Update a Participant](https://signalwire.com/docs/compatibility-api/rest/conference-participants/update-participant) |
| Remove | Compatibility API | [Delete a Participant](https://signalwire.com/docs/compatibility-api/rest/conference-participants/delete-participant) |
| Rejoin muted / unmuted / as coach | Calling API | `update` with inline SWML that re-runs `join_conference` with `muted` or `coach` |
| Park, Return, Transfer | Calling API | `update` with inline SWML |
| Hang up | Calling API | `calling.end` |
| Dial a leg in | Calling API | `dial` with inline SWML |

In the console, each row's actions are grouped by surface: **Compat** (the participant endpoints) and **Calling API** (re-seats and moves). Early testing found that the Compat participant endpoints return 404 in an all-SWML room, so the Calling API group holds the workarounds.

Participant state comes from `join_conference` status callbacks, not from List Participants. Each room table also shows the Compatibility API's own participant list beside the callback view, and highlights any row where the two disagree.

**Files**

| File | What it does |
| --- | --- |
| `server.js` | Serves the SWML, receives status and dial callbacks, mints the browser's SATs, proxies every API call (the API token stays here), and pushes state over SSE |
| `public/index.html` | Browser SDK v4 client: gets its SAT from the server and refreshes it before expiry, joins by dialing the resource address, or registers and answers when the console dials it |
| `public/console.html` | Operator console: dial panel, both rooms with Compat comparison, parked legs, and an event log |
| `package.json`, `.env.example` | Dependencies and configuration |

There are no script files to paste. The server builds every SWML document, including the holding loop and the transfer room.

**Prerequisites**

- A SignalWire Space and a project with Calling API and Compatibility API access
- Node.js 20.6 or later
- A project API token with the **Voice** scope, plus whatever scope your Space requires to create subscriber tokens
- A public HTTPS URL that reaches the server (for example `ngrok http 3000`)
- A phone number in the project, used as `DIAL_FROM` and (optionally) for PSTN callers
- A subscriber reference (for example an email address) for the browser client. The server mints its SATs, and creates the subscriber on first use if it doesn't exist
- A browser with microphone access, with the page served over HTTPS or `localhost`

## 1. Start the server and tunnel

1. Copy `.env.example` to `.env` and fill in `SW_SPACE`, `SW_PROJECT_ID`, `SW_API_TOKEN`, `PUBLIC_URL` (the tunnel URL), `DIAL_FROM` and `SUBSCRIBER_REFERENCE`. Leave the room names as they are unless you need a fresh pair.
2. Start the tunnel (`ngrok http 3000`), put its URL in `PUBLIC_URL`, then install and start:

   ```bash
   npm install
   npm start
   ```

   The server prints the SWML webhook URL to use in step 2.

## 2. Create the SWML Webhook resource

1. In the Dashboard, open **Resources → Add New → Script → SWML Webhook** (the type whose handler is an External URL).
2. Set the External URL to `<PUBLIC_URL>/swml/conference`, method POST.
3. Name it and give it the address `/public/support-bridge-4`, or whatever you set as `CONFERENCE_ADDRESS` in `public/index.html`.
4. Optionally point a phone number in the same project at this resource, so PSTN callers join the room.

## 3. Set up the browser

1. Set `SUBSCRIBER_REFERENCE` in `.env`. There's no token to paste: on page load the browser asks `POST /api/sat` for a SAT, and the SDK asks again shortly before each one expires (see [SAT regeneration](#sat-regeneration)). Pin the SDK version in place of `@latest`.
2. Note the subscriber's address (`/private/<name>`). That's what the console dials to reach this browser.
3. Open `http://localhost:3000/` and the console at `http://localhost:3000/console.html`.

## 4. Test plan

Each test lists what to check.

**1. Join paths.** Join one leg each way: the browser with **Join conference**, a PSTN call to the number, and a console **Dial** to the subscriber address (answer it in the browser).
- All three appear in `support-bridge-4` with the right type.
- The console's note under the room heading says whether Compat finds the room by name, and under which ID.

**2. Mute.** Mute and unmute each leg type from the console.
- The far end stops hearing the muted leg.
- `participant-mute`/`participant-unmute` callbacks arrive.
- The Compat list agrees, with no highlighted row.

**3. Hold.** Hold and resume each leg type.
- Hold music plays, and the held leg can't hear or be heard.
- `participant-hold` fires.
- The API's `hold: true` matches reality.
- Repeat with `COMPAT_HOLD_URL` set.

**4. Coach.** Two ways:
- *Compat coaching:* pick a target in a leg's Coach list and click **Coach**. The coach should be heard only by the target. Then **Stop coaching**.
- *SWML coaching:* use **Dial** with "Joins as: Coach" and a target. This is the `join_conference` `coach` path for supervisor legs.

**5. Remove.** Click **Remove** on a Calling-API-dialed leg and on an inbound leg.
- The removed leg hears "You have left the conference" and then hangs up, which confirms SWML continued after `join_conference`.
- `participant-leave` fires, and the room keeps running.

**6. Park, Return, Transfer.** Park a leg, then return it. Transfer a leg to `support-bridge-4-transfer` and back.
- `participant-leave` arrives from the old room and `participant-join` from the new one.
- Watch for a leg that stays listed in the old room's Compat list.

**7. Callback format.** Restart with `STATUS_EVENT_TYPE=cxml` and repeat tests 1 to 3.
- Open log rows to compare the payload fields against the cXML Conference status callback, including `Coaching` and `CallSidToCoach`.
- In every callback row, check that `query` still carries `room` and `src=harness`.

**8. Dial outcomes.** Using **Dial** to the subscriber address, try each case:
- the browser closed (no live registration);
- let it ring out;
- **Decline** in the browser;
- dial an invalid destination;
- hang up the ringing leg from the console.

Record what the `/dial-events` rows show for `end_reason`, and whether the dial request itself errored.

**9. Correlation.** After the browser answers a console dial, its `Call.id` (shown on the page) should equal the console's call ID. Clicking the browser's **Mute** reports when the server had to fall back from `Call.id` matching.

**10. Re-seat workarounds.** With a PSTN caller and a dialed banker in the room, use the **Calling API** group on the banker's row:
- **Rejoin muted:** the far end stops hearing the banker. The log shows `participant-leave`, then `participant-join` with `muted` true. Note any beep, gap, or clipped audio during the re-seat.
- **Rejoin unmuted:** audio returns.
- **Rejoin as coach** (target: the caller's leg): only the caller hears the banker. Then check whether the callback reports `coaching` and the target.
- **Park** then **Return:** this is the hold workaround. The caller hears music outside the room, then rejoins.
- Repeat each on the PSTN leg, and confirm the call stays up and the leg keeps its call ID throughout.

**11. Recording.** After a session with all three leg types, fetch the conference recording and confirm every leg's audio is in it.

**12. SAT refresh.** Restart with `SAT_TTL_SECONDS=180`, register the browser, and join the room.
- About two minutes in, the page's token line shows "refreshed 1×" with a new expiry, and the event log shows `sat-refresh`.
- The call keeps its audio through the refresh, and a console **Dial** to the subscriber address still rings the browser afterward.

## SAT regeneration

The browser never holds a long-lived token. `index.html` passes the SDK a custom `CredentialProvider`:

- `authenticate(context)` runs at startup. It calls `POST /api/sat`, and the server mints a SAT for `SUBSCRIBER_REFERENCE` through `POST /api/fabric/subscribers/tokens` with `expire_at` set `SAT_TTL_SECONDS` ahead.
- The provider returns the token with `expiry_at`. The server reports it 60 seconds before the real expiry, so the refresh has slack.
- The SDK calls `refresh()` 5 seconds before `expiry_at`. `refresh()` calls `POST /api/sat` again, and the SDK swaps the new token into the live session. If a refresh fails, the SDK retries with backoff up to 5 times, then disconnects.
- With `SAT_CLIENT_BOUND=true`, the server forwards the SDK's DPoP `fingerprint` and asks for `scope: ["sat:refresh"]`. The SDK then refreshes the token itself and doesn't call `refresh()`. If the Space rejects that request, the server mints a plain SAT and the SDK falls back to `refresh()`.
- Each mint appears in the console's event log as `sat-authenticate` or `sat-refresh`.
- `FALLBACK_SAT` in `index.html` is used only when `SUBSCRIBER_REFERENCE` isn't set. It doesn't refresh.

`/api/sat` has no authentication, like the rest of this harness. Anyone who can reach the server can get a SAT for the test subscriber.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUBSCRIBER_REFERENCE` | none | Subscriber the browser signs in as. Required for minting |
| `SAT_TTL_SECONDS` | `3600` | Lifetime of each minted SAT, 120 or more. Set it low to test refresh |
| `SAT_CLIENT_BOUND` | `false` | `true` requests client-bound SATs (`sat:refresh` scope) when the SDK sends a fingerprint |

## How state stays in sync

- **Events are applied by timestamp, not arrival order.** Callbacks can arrive out of order; a re-seat's `participant-leave` has arrived after its `participant-join`. Each call's events are applied by their own `timestamp`, and an older one that arrives late is logged as "stale, ignored."
- **Primary state is callback-derived.** Conference status callbacks drive the room tables. They're best-effort, so the server re-broadcasts every 5 seconds and refreshes the Compat comparison each time.
- **Recording events are logged, not applied.** Recording status events (`in-progress`, `completed`, `absent`) arrive at `/recording-events`, are logged and shown in the event log, and don't affect participant state. Their reported size and duration can be compared with `conference-end`'s.
- **Compat List Participants is shown, not trusted.** Mismatches are highlighted rather than resolved, because the mismatch is one of the findings.
- **The conference ID comes from the first callback.** Until a room has sent one, Compat participant actions return "No conference ID yet."
- **Park is bounded.** The holding loop repeats the music up to 100 times, the `goto` maximum, and then rejoins the main room, so a forgotten leg isn't stranded.
- **Parked legs are tracked in memory.** A server restart forgets them; return them by sending a Calling API `update` with a `join_conference` document yourself.
- **The browser mutes at the conference, not the microphone.** For "nothing leaves my device," also call `client.disableAudioInput()`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Inbound callers hear an error or silence | The resource's External URL doesn't reach `/swml/conference` | Check the tunnel and the URL, then restart |
| Room never appears in the console | No status callback arrived | Make sure `PUBLIC_URL` is the current tunnel URL; the callback URL is built from it |
| "No conference ID yet" on actions | The room hasn't sent a callback | Wait for the first `participant-join`, or check the server log |
| Dial returns "Dialing isn't configured" | `DIAL_FROM` isn't set | Set it to a number in the project and restart |
| Subscriber dial fails or never rings | Browser isn't registered, or the address is wrong | Reload the browser page, and check `/private/<name>` |
| Compat actions return 404 | Compat doesn't see all-SWML rooms (observed in testing) | Use the Calling API group; record the conference and call IDs |
| Rejoin leaves the leg out of the room | The update reached a leg that wasn't answered, or the SWML failed | Check the log and server output for the `update` error; only answered legs can be redirected |
| Every row is highlighted | The Compat list is empty or stale for SWML rooms | A known gap for SWML-joined rooms; record which legs are missing |
| Browser shows "SAT minting isn't configured" | `SUBSCRIBER_REFERENCE` isn't set | Set it and restart, or paste a token into `FALLBACK_SAT` |
| Browser shows "Couldn't register" with a 401 or 403 | The API token can't create subscriber tokens | Add the needed scope to the API token, then restart |
| Browser drops after about `SAT_TTL_SECONDS` | Refresh failed | Check the server log for `/api/fabric/subscribers/tokens` errors and the browser console for `SDK warning` |
| Browser Mute says "Call.id didn't match" | The browser's `Call.id` differs from the participant ID | Record it; set `IDENTITY` to keep testing |

## References

- [SWML `join_conference`](https://signalwire.com/docs/swml/reference/calling/join-conference)
- [SWML inbound call webhook](https://signalwire.com/docs/apis/rest/swml-webhook/webhooks/inbound-call-webhook)
- [Calling API call commands](https://signalwire.com/docs/apis/rest/calls/call-commands)
- [Update a Participant](https://signalwire.com/docs/compatibility-api/rest/conference-participants/update-participant)
- [Delete a Participant](https://signalwire.com/docs/compatibility-api/rest/conference-participants/delete-participant)
- [List all Participants](https://signalwire.com/docs/compatibility-api/rest/conference-participants/list-all-participants)
- [Conference status callback](https://signalwire.com/docs/compatibility-api/rest/conferences/webhooks/conference-status-callback)
- [Subscriber tokens](https://signalwire.com/docs/apis/rest/subscribers/tokens/create-subscriber-token)
- [Browser SDK v4 inbound calls](https://signalwire.com/docs/browser-sdk/v4/guides/inbound-calls)
