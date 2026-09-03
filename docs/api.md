# API reference

Three groups of endpoints:

- **Provider APIs** (`/api/2c2p/*`, `/api/omise/*`) — what your integration calls. Unauthenticated,
  because that is what makes the sandbox a drop-in replacement for the real gateway.
- **Admin API** (`/api/admin/*`) — drives the sandbox itself. Requires the admin password.
- **Sandbox APIs** (`/api/inspect/*`, `/api/demo/*`) — the callback receiver and the guided demo.

All requests and responses are JSON. Provider and sandbox APIs are rate limited per client IP
(`RATE_LIMIT_MAX`, 60/minute by default) and answer `429` with a `Retry-After` header when exceeded.

---

## Authentication

Admin endpoints accept the password as a header or a cookie:

```bash
curl http://localhost:3000/api/admin/payments \
  -H 'X-Admin-Password: mockpay'
```

Anything else returns `401`.

---

## 2C2P

> **Plain JSON, not JWT.** 2C2P's production API wraps request and response payloads in
> JWT/JWE signed with a merchant key pair. This sandbox accepts and returns unwrapped JSON.
> Point an integration at it with encryption disabled in test configuration, or let your
> signing code wrap a payload the sandbox ignores. The signing step itself is not exercised
> here and needs its own test against the provider's real sandbox.

### `POST /api/2c2p/token`

Creates a payment and returns a token plus the URL a customer would be redirected to.

| Field | Type | Notes |
| --- | --- | --- |
| `invoiceNo` | string | **Required.** Your reference; must be unique |
| `amount` | number | **Required.** Major units, e.g. `1500` for ฿1,500.00 |
| `currencyCode` | string | Defaults to `THB` |
| `description` | string | Free text |
| `backendReturnUrl` | string | Where the callback is POSTed |
| `frontendReturnUrl` | string | Where the customer returns after paying |
| `paymentChannel` | string[] | e.g. `["CC"]`, `["QR"]`. Defaults to `["CC"]` |
| `paymentExpiry` | string | `YYYY-MM-DD HH:mm:ss` or ISO 8601 |
| `merchantID` | string | Defaults to `MOCK_MERCHANT` |
| `locale` | string | Defaults to `en` |

```bash
curl -X POST http://localhost:3000/api/2c2p/token \
  -H 'Content-Type: application/json' \
  -d '{
    "invoiceNo": "INV-0001",
    "amount": 1500,
    "currencyCode": "THB",
    "paymentChannel": ["CC"],
    "backendReturnUrl": "https://your-app.example.com/payment/callback"
  }'
```

```json
{
  "paymentToken": "mock_token_V86pR9Xh0sSqrER9PIAT",
  "webPaymentUrl": "http://localhost:3000/mock-pay/mock_token_V86pR9Xh0sSqrER9PIAT",
  "respCode": "0000",
  "respDesc": "Success"
}
```

Payment channels: `CC` (card), `3DS` (3-D Secure), `QR` (PromptPay), `DPAY` (wallet),
`PC` (pay at counter), `SSM` (self-service machine), `IB` (internet banking).

### `POST /api/2c2p/inquiry`

Returns the current state of a payment.

```bash
curl -X POST http://localhost:3000/api/2c2p/inquiry \
  -H 'Content-Type: application/json' \
  -d '{"invoiceNo": "INV-0001"}'
```

```json
{
  "merchantID": "MOCK_MERCHANT",
  "invoiceNo": "INV-0001",
  "amount": "1500.00",
  "currencyCode": "THB",
  "tranRef": "TXN890564821043",
  "referenceNo": "REF5595365",
  "approvalCode": "540203",
  "transactionDateTime": "20260901143022",
  "channelCode": "CC",
  "cardType": "CREDIT",
  "respCode": "0000",
  "respDesc": "Success"
}
```

A payment that does not exist returns `respCode` `2002` with HTTP 200 — the provider's own
behaviour, not an HTTP error.

### Other 2C2P routes

| Route | Purpose |
| --- | --- |
| `POST /api/2c2p/payment` | QR payment request |
| `GET /api/2c2p/qr/:invoiceNo` | QR image for a payment |
| `POST /api/2c2p/optionDetails` | Available payment options |
| `GET /api/2c2p/info` | Merchant info |

---

## Omise

### `POST /api/omise/charges`

```bash
curl -X POST http://localhost:3000/api/omise/charges \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": 150000,
    "currency": "thb",
    "description": "Order #1234",
    "return_uri": "https://your-app.example.com/payment/return"
  }'
```

Amounts are in **subunits** (satang), matching Omise. The response is the standard charge object,
wrapped in `data`:

```json
{
  "data": {
    "object": "charge",
    "id": "chrg_test_ahfdyq5lbjporso",
    "amount": 150000,
    "currency": "thb",
    "status": "pending",
    "paid": false,
    "authorize_uri": "http://localhost:3000/mock-pay/...",
    "created_at": "2026-09-01T14:30:22.000Z"
  }
}
```

| Route | Purpose |
| --- | --- |
| `GET /api/omise/charges/:id` | Retrieve a charge |
| `POST /api/omise/tokens` | Create a card token |
| `POST /api/omise/sources` | Create a source (PromptPay, internet banking, …) |

Omise webhooks are delivered in the provider's event format, with the charge under `data`. Custom
fields are merged into `data.metadata`.

---

## Admin API

### `GET /api/admin/payments`

Lists payments, newest first.

| Query | Default | Notes |
| --- | --- | --- |
| `page` | `1` | |
| `limit` | `20` | |
| `provider` | all | `2c2p` or `omise` |
| `status` | all | `pending`, `success`, `failed`, `cancelled`, `expired` |
| `method` | all | Channel code |
| `search` | — | Matches invoice number |

### `GET /api/admin/payments/:invoiceNo`

Full record, including `statusHistory` and `callbackHistory`.
Add `?preview=callback` to see the payload that *would* be sent without sending it.

### `POST /api/admin/payments/:invoiceNo/status`

```bash
curl -X POST http://localhost:3000/api/admin/payments/INV-0001/status \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Password: mockpay' \
  -d '{"status": "failed", "respCode": "4010"}'
```

`respCode` is optional; a sensible default is chosen per status. Moving a payment to `success`
generates an approval code and reference number if it does not already have them.

### `POST /api/admin/payments/:invoiceNo/callback`

Delivers one or more callbacks.

| Field | Type | Notes |
| --- | --- | --- |
| `sequence` | array | Ordered callbacks: `{ status, respCode, delayAfter }` |
| `customFields` | object | Extra key/value pairs merged into the payload |
| `callbackUrl` | string | Overrides the payment's `backendReturnUrl` |
| `customPayload` | object | Send these exact fields instead of a generated payload (single callback only) |

`delayAfter` is milliseconds to wait *after* that callback before sending the next; the delay on
the final entry is never applied.

Limits, because a sequence is delivered synchronously and must finish inside the platform's
function timeout: at most **10 callbacks**, at most **8000ms** per delay, and at most **8000ms**
total across the sequence. Anything larger is rejected with `400` rather than silently truncated
by a timeout.

`customFields` cannot overwrite the fields that identify the transaction or state its outcome —
`invoiceNo`, `amount`, `currencyCode`, `merchantID`, `respCode`, `respDesc`, `tranRef`,
`referenceNo` and `approvalCode`. Reserved keys are ignored with a warning; use `customPayload`
when you need to send something arbitrary.

```bash
curl -X POST http://localhost:3000/api/admin/payments/INV-0001/callback \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Password: mockpay' \
  -d '{
    "sequence": [
      { "status": "pending", "respCode": "2001", "delayAfter": 2000 },
      { "status": "success", "respCode": "0000", "delayAfter": 0 }
    ],
    "customFields": { "orderRef": "ORD-42" }
  }'
```

2C2P callbacks arrive wrapped as `{ "payload": { … } }`. Omise webhooks use the provider's own
event envelope. `customPayload` replaces the payload's contents, not the envelope.

### `POST /api/admin/payments/:invoiceNo/inquiry-config`

Makes inquiries on one payment misbehave.

| Field | Values | Notes |
| --- | --- | --- |
| `behavior` | `normal`, `delay`, `error`, `timeout` | |
| `delay` | milliseconds | Used when `behavior` is `delay` |
| `errorCode` | response code | Used when `behavior` is `error` |

### `GET` / `POST /api/admin/config`

Global simulation settings.

| Key | Type | Effect |
| --- | --- | --- |
| `globalDelay` | number | Milliseconds added to every provider response |
| `failureRate` | number | Percentage of requests that fail randomly (0–100) |
| `duplicateCallback` | boolean | Send every callback twice |
| `forceError2c2p` | string | Force this response code on 2C2P |
| `forceErrorOmise` | string | Force this error on Omise |
| `logTTLDays` | number | How long request logs are kept |
| `customFieldPresets` | array | `[{ name, fields }]` saved presets |

### Other admin routes

| Route | Purpose |
| --- | --- |
| `DELETE /api/admin/payments/:invoiceNo` | Delete one payment |
| `POST /api/admin/payments/clear` | Delete all payments |
| `GET /api/admin/logs` | Request log |
| `GET /api/admin/response-codes` | Every supported code, by provider |
| `POST /api/admin/login` | Verify a password |

---

## Callback inspector

A callback endpoint built into the sandbox. Sessions expire after 24 hours and keep the 50 most
recent callbacks.

| Route | Purpose |
| --- | --- |
| `POST /api/inspect` | Mint a session; returns `sessionId` and `callbackUrl` |
| `POST /api/inspect/:sessionId` | Receive a callback (this is the URL you point at) |
| `GET /api/inspect/:sessionId` | Read back what arrived |
| `DELETE /api/inspect/:sessionId` | Discard a session |

```bash
curl -s -X POST http://localhost:3000/api/inspect
# {"success":true,"sessionId":"s_mth…","callbackUrl":"http://localhost:3000/api/inspect/s_mth…"}

curl http://localhost:3000/api/inspect/s_mth…
```

```json
{
  "success": true,
  "sessionId": "s_mth…",
  "captures": [
    {
      "receivedAt": "2026-09-01T14:31:02.145Z",
      "method": "POST",
      "headers": { "content-type": "application/json", "user-agent": "Mock-2C2P-Gateway/1.0" },
      "body": { "payload": { "invoiceNo": "INV-0001", "respCode": "0000" } }
    }
  ]
}
```

The UI for this is at `/inspector`.

---

## Demo

| Route | Purpose |
| --- | --- |
| `POST /api/demo/scenario` | Run one payment end to end and return the narrated steps |
| `POST /api/demo/seed` | Populate an empty instance with sample payments |

Seeding refuses to run when payments already exist, so it never overwrites your data.

---

## Response codes

`GET /api/admin/response-codes` returns the full set. The ones you will reach for most:

| Code | Meaning |
| --- | --- |
| `0000` | Success |
| `2001` | Transaction in progress |
| `0003` | Cancelled |
| `2002` | Transaction not found |
| `4010` | Insufficient funds |
| `4011` | Invalid card number |
| `4051` | Expired card |
| `5002` | Timeout |
| `5009` | Payment expired |
| `0999` | System error |

References: [2C2P response codes](https://developer.2c2p.com/docs/response-code-payment) ·
[Omise errors](https://docs.omise.co/api/errors)
