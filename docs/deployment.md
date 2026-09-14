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
| `ADMIN_PASSWORD` | something long and random | The default is public knowledge |
| `MOCK_SERVER_URL` | `https://your-app.vercel.app` | Builds correct redirect and inspector URLs |
| `ALLOW_PRIVATE_CALLBACKS` | `false` | **Required for a public instance** — see below |
| `RATE_LIMIT_MAX` | `60` | Or lower, if the instance is widely shared |

Redeploy after changing them; existing warm instances keep the values they started with.

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

### 3. Use a real admin password

`/api/admin/*` can delete every payment in the instance. The default password is in this repository.

## Data lifetime

Inspector sessions expire after 24 hours via KV's TTL. Request logs expire after `logTTLDays`
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
