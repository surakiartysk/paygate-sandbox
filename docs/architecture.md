# Architecture

## Shape of the thing

Serverless functions plus static pages, with no build step:

```
Browser / your backend
        │
        ├── /                     Landing page          (public)
        ├── /dashboard            Payment dashboard     (password)
        ├── /inspector            Callback inspector    (public)
        │
        ├── /api/2c2p/*           Provider API          (public)
        ├── /api/omise/*          Provider API          (public)
        ├── /api/admin/*          Control API           (password)
        ├── /api/inspect/*        Callback receiver     (public)
        └── /api/demo/*           Seed + guided demo    (public)
                │
                ▼
            lib/ ── storage ── Vercel KV, or JSON files locally
```

Each file under `api/` is one serverless function, resolved by Vercel's file-based routing.
`dev-server.js` reimplements that routing over `node:http` so local development behaves the same
without the Vercel CLI.

## Why no framework

The whole thing is vanilla JavaScript with one runtime dependency (`@vercel/kv`).

That is a deliberate trade. A testing tool that is annoying to run does not get used, and a build
step is one more thing to break between you and a working sandbox. `git clone && npm install && npm
run dev` gets you a working instance, and the pages are debuggable in a browser with no source maps.
The dashboard is not complex enough to earn a framework's cost.

## Provider adaptation

The two providers differ in more than field names:

| | 2C2P | Omise |
| --- | --- | --- |
| Amounts | Major units (`1500.00`) | Subunits (`150000`) |
| Identity | `invoiceNo`, merchant-supplied | `chrg_…`, gateway-generated |
| Outcome | `respCode` string | `status` + boolean flags (`paid`, `authorized`, …) |
| Callback | Flat payload wrapped in `{ payload: … }` | Event envelope with the charge under `data` |
| Extra data | Fields merged into the payload | `metadata` object |

A payment record keeps a `provider` field, and the two places that care —
[`lib/callback.js`](../lib/callback.js) when building a payload, and the API handlers when shaping a
response — branch on it. Everything in between (storage, status transitions, simulation, logging) is
provider-agnostic.

Adding a third provider means: a directory under `api/`, a payload builder in `lib/callback.js`, and
its response codes in `api/admin/config.js`. No changes to storage or the dashboard.

## Storage

[`lib/storage.js`](../lib/storage.js) is the only module that touches persistence, and it picks a
backend at import time: Vercel KV when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are both set, JSON
files under `data/` otherwise.

The fallback is not a toy. It is what makes `npm install && npm run dev` sufficient, and it is what
the test suite runs against — each test process gets its own `DATA_DIR`, so runs are isolated and
nothing has to be cleaned up between them.

Inspector sessions use KV's native TTL (`{ ex: seconds }`) where available, and a timestamp sweep on
read locally. Both expire 24 hours after the session was created, so a shared deployment does not
accumulate.

The word doing the work there is *created*. Each KV write used to set a fresh 24-hour `ex`, which is
a sliding TTL — a session receiving one callback a day would have lived indefinitely on the deployed
path while expiring on the dev one, and the "does not accumulate" sentence would have been true only
of the backend nobody deploys. `inspectorTTLRemaining` now hands KV what is left of the original
window, and has its own tests, because a TTL that is wrong in this direction shows no symptom: a
session that outlives its window looks exactly like one that has not reached it yet.

A session holds at most fifty captures, each at most 64 KB once serialised. Both caps are needed —
counting alone bounds nothing, since one capture carries whatever body was posted. Oversized bodies
are truncated to a readable excerpt rather than refused, because this endpoint answers a gateway and
exists to show that a callback arrived. Nothing caps the *number* of sessions: the rate limit bounds
how fast they can be minted and the TTL reclaims them, which is the right size of limit for a
sandbox and would not be for anything holding something valuable.

## Outbound callbacks

Every callback the sandbox sends passes through `executeCallback` in
[`lib/callback.js`](../lib/callback.js). One choke point, in order:

1. **Rewrite** — apply `URL_REWRITE_RULES`, so a payload copied from production can be redirected at
   staging instead ([`lib/urlUtils.js`](../lib/urlUtils.js)).
2. **Guard** — reject anything that is not a safe public HTTP(S) target
   ([`lib/urlGuard.js`](../lib/urlGuard.js)).
3. **Send** — POST with a 30-second timeout, recording status, latency and any error.
4. **Log** — write to the request log and the payment's callback history.

### The guard, and why it exists

The sandbox POSTs to a URL supplied by whoever created the payment. On a public deployment that is a
textbook SSRF primitive: point `backendReturnUrl` at `169.254.169.254` and the sandbox fetches cloud
credentials on the attacker's behalf.

So the policy is deny-by-default on anything that is not publicly routable: cloud metadata endpoints
(blocked unconditionally), loopback, RFC 1918 ranges, link-local, carrier-grade NAT, and non-HTTP
schemes. IPv4-mapped IPv6 addresses are decoded and judged by the address they embed, because
`::ffff:7f00:1` is `127.0.0.1` wearing a hat.

Local development needs the opposite behaviour — posting to `http://localhost:3001` is the entire
point — so loopback and private ranges are permitted unless `ALLOW_PRIVATE_CALLBACKS=false`. Metadata
endpoints are blocked in both modes.

**Scope:** this validates the URL, not what DNS resolves it to. A hostname pointing at a private
address (DNS rebinding) would pass. Closing that requires resolving and pinning the address at
connect time, which is more machinery than a sandbox whose worst case is an unwanted POST justifies.

## Simulation

[`lib/simulation.js`](../lib/simulation.js) applies global settings — latency, forced error codes,
random failure rate, duplicate callbacks — read from config on each request rather than cached, so a
change takes effect immediately without a redeploy.

Per-payment inquiry behaviour (`normal`, `delay`, `error`, `timeout`) lives on the payment record
itself, so one misbehaving transaction does not disturb the others in a test run.

## Rate limiting

[`lib/rateLimit.js`](../lib/rateLimit.js) keeps counters in process memory. On serverless that means
the limit applies per warm instance, not globally.

That is the intended trade-off: it costs no storage round-trip on the hot path and still stops the
runaway script or crawler it is meant to stop. It is not a defence against a distributed attacker,
and the module says so rather than implying otherwise.

## Tests

Node's built-in runner, no framework. [`test/helpers.js`](../test/helpers.js) boots a real server as
a child process on a random port with a throwaway `DATA_DIR`, and starts a local HTTP receiver that
records what it is sent.

Tests drive the sandbox over HTTP exactly as a merchant backend would, then assert on delivered
callbacks. Nothing reaches into internals, so the tests keep passing across refactors and are
themselves a worked example of using the sandbox from a test suite.
