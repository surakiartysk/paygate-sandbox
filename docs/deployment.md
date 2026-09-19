# Deployment

## Local

```bash
npm install
npm run dev
```

Landing page at `http://localhost:3000`, dashboard at `/dashboard` (password `mockpay`). Data goes
to JSON files under `data/`, which is gitignored. Nothing else to configure.

To change the password locally, copy `.env.example` to `.env` and set `ADMIN_PASSWORD`.

## Vercel

The repository is already shaped for it — `vercel.json` declares the routing, and each file under
`api/` becomes a function.

```bash
npm i -g vercel
vercel
```

### Storage

The JSON-file fallback does **not** work on Vercel: serverless filesystems are ephemeral and not
shared between instances, so payments would vanish unpredictably. Create a KV store and attach it:

```bash
vercel kv create paygate-sandbox-kv
```

Attaching it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically, and `lib/storage.js`
switches to KV as soon as both are present.

### Environment variables

Set these in the Vercel dashboard, or with `vercel env add`:

| Variable | Value | Why |
| --- | --- | --- |
| `ADMIN_PASSWORD` | something long and random | The default is public knowledge — **enforced**: admin routes are refused without it |
| `MOCK_SERVER_URL` | `https://your-app.vercel.app` | Builds correct redirect and inspector URLs |
| `ALLOW_PRIVATE_CALLBACKS` | `false` | **Required for a public instance** — **enforced**: unset behaves as `false` once deployed |
| `RATE_LIMIT_MAX` | `60` | Or lower, if the instance is widely shared |
| `TRUST_PROXY` | `true` | Required behind a proxy, or every client shares one bucket |

Redeploy after changing them; existing warm instances keep the values they started with.

### The first two are enforced, not advised

They used to be advice, and advice in a table is a thing people skip. A
deployment that forgot `ADMIN_PASSWORD` served its dashboard, logs and config
API to anyone who had read this repository's README; one that forgot
`ALLOW_PRIVATE_CALLBACKS` ran the SSRF guard in its permissive mode. Both
looked like they were working.

So when the platform reports a deployment — `VERCEL=1`, production or preview,
since a preview URL is as reachable as a production one — those two fail
closed:

- Without `ADMIN_PASSWORD`, every password is refused, including the default.
  That locks you out of your own dashboard until you set it, which is
  recoverable in one redeploy. An admin surface open to everyone is not.
- Without `ALLOW_PRIVATE_CALLBACKS`, private and loopback targets are refused
  as though it were `false`. Setting it to `"true"` still works — a deployment
  that wants private targets says so, rather than getting them by omission.

Neither applies locally, where the defaults are the point: the quick start
depends on `mockpay` working and on loopback callbacks being allowed, and a
check that broke those is a check people disable.

The reason is logged once per instance, so a password that suddenly stops
working has an explanation in the logs rather than a mystery.

Most of these are read per request, so a new instance picks them up immediately. `ADMIN_PASSWORD`
is the exception — it is captured once when `lib/auth.js` loads, so a rotated password does not
take effect until every warm instance has cycled. Rotate it expecting a window where both the old
and new value are live somewhere, rather than a clean cutover.

## Hardening a public instance

An instance anyone can reach is an instance anyone can use to make HTTP requests from your
infrastructure. Three things matter.

### 1. Refuse private callback targets

```
ALLOW_PRIVATE_CALLBACKS=false
```

Without this, someone can point `backendReturnUrl` at an internal address and have your deployment
fetch it for them. With it, only publicly routable HTTP(S) endpoints are accepted; visitors who want
to see a callback land use the built-in inspector instead.

Cloud metadata endpoints are blocked regardless of this setting.

### 2. Keep the rate limit on

`RATE_LIMIT_MAX` defaults to 60 requests per IP per minute. Setting it to `0` disables limiting
entirely — reasonable locally, not on a public URL.

Note the limit is per warm instance, not global (see
[architecture](architecture.md#rate-limiting)). It stops runaway scripts, not a distributed
attacker. If you need real protection, put Vercel's WAF or Cloudflare in front.

**Behind a proxy, set `TRUST_PROXY=true`.** The limit counts per client, and by default that
means the socket address, because `X-Forwarded-For` is a header the caller sends — keying on it
let one client hand itself a fresh allowance every request by changing one string, which is the
runaway script the limit exists to stop rather than the distributed attacker it does not.

Leaving it unset behind a proxy is safe but blunt: every client arrives from the proxy's address,
so they share one bucket and the cap becomes per-instance rather than per-client. Setting it is a
statement that you know what sits in front and that it controls the header.

### 3. Use a real admin password

`/api/admin/*` can delete every payment in the instance. The default password is in this repository.

## Data lifetime

Inspector sessions expire 24 hours after they are created — absolutely, not sliding, so an active
session expires on schedule too. Each holds at most fifty captures of at most 64 KB. Request logs expire after `logTTLDays`
(7 by default). Payments persist until deleted — through the dashboard, `DELETE
/api/admin/payments/:invoiceNo`, or `POST /api/admin/payments/clear`.

For a public demo, clearing payments periodically keeps the dashboard readable. An empty instance
re-seeds itself with sample data on the next `POST /api/demo/seed`.

## Pointing your system at it

Change one base URL in your configuration:

```diff
- PAYMENT_GATEWAY_URL=https://sandbox-pgw.2c2p.com
+ PAYMENT_GATEWAY_URL=https://your-sandbox.vercel.app/api/2c2p
```

Nothing else changes — the request and response shapes are the provider's own.

Two things worth doing on your side:

- **Never let the sandbox base URL reach a production build.** Gate it behind the same environment
  switch as your other test doubles.
- **Set `URL_REWRITE_RULES`** if you replay payloads captured from production, so a stray
  `backendReturnUrl` is redirected at staging rather than firing at your live system:

  ```
  URL_REWRITE_RULES=api.example.com=>staging-api.example.com
  ```

## Other platforms

The handlers use the `(request, response)` signature and Vercel's file-based routing. Anything that
supports that convention will run them as-is. Elsewhere you would need a router in front — the
handlers themselves are plain functions with no Vercel-specific imports, and `dev-server.js` is a
working example of wiring them up by hand.
