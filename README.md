# Paygate Sandbox

[![Tests](https://github.com/surakiartysk/paygate-sandbox/actions/workflows/test.yml/badge.svg)](https://github.com/surakiartysk/paygate-sandbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted sandbox that emulates the **2C2P** and **Omise** payment APIs, so you can test an
integration against every response a gateway can return — including the ones you cannot trigger on
demand in a real staging environment.

Point your backend at it instead of the provider, then drive the transaction: settle it, decline it
with a specific issuer code, make an inquiry time out, or deliver the same webhook twice out of
order. A built-in callback inspector captures what your webhook would have received, so the whole
request → callback loop stays in one place.

> **Unofficial, and not affiliated with 2C2P or Omise.** Request and response shapes follow each
> provider's public API documentation. This is a testing tool: it processes no real money, holds no
> real credentials, and must never be pointed at a production system.

## Why

Integrating a payment gateway is mostly about the unhappy paths. A card that works is the easy part.
The rest is what happens when the issuer declines, when the callback arrives before your database
commit, when the same webhook is delivered twice, or when an inquiry hangs for thirty seconds.

Those cases are hard to produce against a provider's own sandbox: you cannot ask it to decline with
code 4010 on demand, replay a webhook, or introduce latency. So they get tested by hand once and
then never again. This sandbox makes each of them a single API call, which means they can live in an
automated test suite.

## Quick start

```bash
npm install
npm run dev
```

The landing page is at `http://localhost:3000`, the dashboard at `/dashboard` (default password
`mockpay`). No build step and no database — storage falls back to JSON files under `data/` when no
KV store is configured.

Create a payment the way your backend would, and watch the callback arrive:

```bash
# Get a session on the built-in callback inspector
SESSION=$(curl -s -X POST http://localhost:3000/api/inspect | sed 's/.*"sessionId":"\([^"]*\)".*/\1/')

# 1. Request a payment token
curl -X POST http://localhost:3000/api/2c2p/token \
  -H 'Content-Type: application/json' \
  -d "{
    \"invoiceNo\": \"INV-0001\",
    \"amount\": 1500,
    \"currencyCode\": \"THB\",
    \"backendReturnUrl\": \"http://localhost:3000/api/inspect/${SESSION}\"
  }"

# 2. Settle it and fire the callback
curl -X POST http://localhost:3000/api/admin/payments/INV-0001/callback \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Password: mockpay' \
  -d '{"sequence":[{"status":"success","respCode":"0000","delayAfter":0}]}'

# 3. Read back what your webhook would have received
curl http://localhost:3000/api/inspect/${SESSION}
```

The same flow runs from the landing page with one click, if you would rather watch it than type it.

## What it does

**Speaks the real API shapes.** Token requests, inquiries, charges and webhooks follow the
providers' published schemas down to the response codes, so your integration needs no
sandbox-specific branches.

**Drives the failure cases.** Decline with a specific issuer code, make an inquiry time out or
return an error, add latency globally or per payment, or fail a configurable percentage of requests.

**Callback sequences.** Deliver an ordered series of callbacks with delays between them — pending,
then success, then a duplicate — which is how you prove a webhook handler is actually idempotent.

**Built-in callback inspector.** A callback endpoint inside the sandbox captures what was delivered,
headers included. No external request-bin, no tunnel to your laptop.

**Custom callback fields.** Merchant integrations usually carry extra correlation data through a
transaction. Attach arbitrary key/value pairs to a callback and save the combinations you use often
as presets.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/api.md](docs/api.md) | Every endpoint, with request and response examples |
| [docs/scenarios.md](docs/scenarios.md) | Recipes for the cases worth testing, as runnable curl |
| [docs/architecture.md](docs/architecture.md) | How it is put together, and why |
| [docs/deployment.md](docs/deployment.md) | Deploying to Vercel, and hardening a public instance |
| [openapi.yaml](openapi.yaml) | Machine-readable spec — import straight into Postman or Insomnia |

## Configuration

Everything is optional; the defaults give a working local instance.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `mockpay` | Guards the dashboard and `/api/admin/*` |
| `MOCK_SERVER_URL` | inferred | Public origin, used to build redirect and inspector URLs |
| `DEFAULT_CALLBACK_URL` | — | Fallback callback target when a request omits one |
| `URL_REWRITE_RULES` | — | Rewrite callback hosts, e.g. `api.example.com=>staging-api.example.com` |
| `ALLOW_PRIVATE_CALLBACKS` | `true` | Set `false` on a public deployment to refuse private/loopback targets |
| `RATE_LIMIT_MAX` | `60` | Requests per IP per minute; `0` disables |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Use Vercel KV instead of local JSON files |

See [.env.example](.env.example) for the annotated version.

## Tests

```bash
npm test
```

Node's built-in test runner — no test framework dependency. The suite boots a real server against a
throwaway data directory and drives it over HTTP, covering both providers' flows, the callback
inspector, the admin API, and the SSRF guard.

## Project layout

```
api/            Serverless handlers (Vercel file-based routing)
  2c2p/         2C2P provider API
  omise/        Omise provider API
  admin/        Dashboard API — payments, config, logs
  inspect/      Built-in callback receiver
  demo/         Seed data and the guided scenario
lib/            Domain logic shared by the handlers
public/         Landing page, dashboard and inspector (vanilla JS, no build step)
test/           Smoke tests
```

## License

MIT — see [LICENSE](LICENSE).
