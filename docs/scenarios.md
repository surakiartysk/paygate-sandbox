# Testing scenarios

Recipes for the cases that are awkward to reproduce against a real gateway. Every snippet is
runnable as-is against a local instance.

These assume:

```bash
BASE=http://localhost:3000
ADMIN='X-Admin-Password: mockpay'
JSON='Content-Type: application/json'
```

Most start by pointing callbacks at the [built-in inspector](api.md#callback-inspector), so you can
read back exactly what was delivered:

```bash
SESSION=$(curl -s -X POST $BASE/api/inspect | sed 's/.*"sessionId":"\([^"]*\)".*/\1/')
HOOK="$BASE/api/inspect/$SESSION"
```

Swap `$HOOK` for your own endpoint once you are testing your real handler.

---

## The happy path

```bash
curl -X POST $BASE/api/2c2p/token -H "$JSON" \
  -d "{\"invoiceNo\":\"T-100\",\"amount\":1500,\"backendReturnUrl\":\"$HOOK\"}"

curl -X POST $BASE/api/admin/payments/T-100/callback -H "$JSON" -H "$ADMIN" \
  -d '{"sequence":[{"status":"success","respCode":"0000","delayAfter":0}]}'

curl -s $BASE/api/inspect/$SESSION
```

**What to assert:** your handler marks the order paid, and the callback carries an `approvalCode`.

---

## A declined card

The issuer decline code matters — "insufficient funds" and "stolen card" usually mean different
things to your support team.

```bash
curl -X POST $BASE/api/2c2p/token -H "$JSON" \
  -d "{\"invoiceNo\":\"T-101\",\"amount\":990,\"backendReturnUrl\":\"$HOOK\"}"

curl -X POST $BASE/api/admin/payments/T-101/callback -H "$JSON" -H "$ADMIN" \
  -d '{"sequence":[{"status":"failed","respCode":"4010","delayAfter":0}]}'
```

Swap `4010` for `4011` (invalid card), `4051` (expired), `4057` (stolen), or `4033` (limit
exceeded).

**What to assert:** the order is not fulfilled, and the decline reason is recorded rather than
flattened to "payment failed".

---

## A duplicate webhook

Networks retry. A gateway that delivers the same callback twice is normal, and your handler must
treat the second one as a no-op.

```bash
curl -X POST $BASE/api/2c2p/token -H "$JSON" \
  -d "{\"invoiceNo\":\"T-102\",\"amount\":2500,\"backendReturnUrl\":\"$HOOK\"}"

curl -X POST $BASE/api/admin/payments/T-102/callback -H "$JSON" -H "$ADMIN" \
  -d '{"sequence":[
        {"status":"success","respCode":"0000","delayAfter":500},
        {"status":"success","respCode":"0000","delayAfter":0}
      ]}'
```

**What to assert:** the customer is charged once in your ledger, one confirmation email is sent, and
no unique-constraint error is thrown.

You can also switch duplication on globally, so *every* callback is doubled for the rest of the
test run:

```bash
curl -X POST $BASE/api/admin/config -H "$JSON" -H "$ADMIN" \
  -d '{"duplicateCallback": true}'
```

---

## Callbacks that arrive out of order

A `pending` callback landing *after* the `success` one is the classic race that corrupts order
state.

```bash
curl -X POST $BASE/api/2c2p/token -H "$JSON" \
  -d "{\"invoiceNo\":\"T-103\",\"amount\":300,\"backendReturnUrl\":\"$HOOK\"}"

curl -X POST $BASE/api/admin/payments/T-103/callback -H "$JSON" -H "$ADMIN" \
  -d '{"sequence":[
        {"status":"success","respCode":"0000","delayAfter":1000},
        {"status":"pending","respCode":"2001","delayAfter":0}
      ]}'
```

**What to assert:** a paid order is never dragged back to pending by a late callback.

---

## A slow gateway

```bash
# Every provider response waits 5 seconds
curl -X POST $BASE/api/admin/config -H "$JSON" -H "$ADMIN" \
  -d '{"globalDelay": 5000}'

time curl -s -X POST $BASE/api/2c2p/inquiry -H "$JSON" -d '{"invoiceNo":"T-100"}'

# Put it back
curl -X POST $BASE/api/admin/config -H "$JSON" -H "$ADMIN" -d '{"globalDelay": 0}'
```

**What to assert:** your HTTP client's timeout fires as configured, and a timeout does not leave the
order stuck in an intermediate state.

---

## An inquiry that fails or hangs

Per-payment, so one slow transaction does not affect the rest of your suite.

```bash
# Hang
curl -X POST $BASE/api/admin/payments/T-100/inquiry-config -H "$JSON" -H "$ADMIN" \
  -d '{"behavior": "timeout"}'

# Or answer with an error code
curl -X POST $BASE/api/admin/payments/T-100/inquiry-config -H "$JSON" -H "$ADMIN" \
  -d '{"behavior": "error", "errorCode": "0999"}'

# Or answer slowly
curl -X POST $BASE/api/admin/payments/T-100/inquiry-config -H "$JSON" -H "$ADMIN" \
  -d '{"behavior": "delay", "delay": 8000}'

# Back to normal
curl -X POST $BASE/api/admin/payments/T-100/inquiry-config -H "$JSON" -H "$ADMIN" \
  -d '{"behavior": "normal"}'
```

**What to assert:** a reconciliation job that polls inquiries survives one transaction misbehaving.

---

## A callback your endpoint never receives

Move the payment on without delivering anything:

```bash
curl -X POST $BASE/api/admin/payments/T-100/status -H "$JSON" -H "$ADMIN" \
  -d '{"status": "success", "respCode": "0000"}'
```

The gateway now considers it paid; your system has heard nothing.

**What to assert:** your reconciliation catches the discrepancy — this is what inquiry polling is
*for*, and it is rarely tested.

---

## Intermittent failures

```bash
curl -X POST $BASE/api/admin/config -H "$JSON" -H "$ADMIN" \
  -d '{"failureRate": 30}'
```

Roughly 30% of provider requests now fail. Useful for exercising retry and backoff logic.

Reset with `{"failureRate": 0}`.

---

## Extra fields in the payload

When your integration carries its own correlation data through the transaction:

```bash
curl -X POST $BASE/api/admin/payments/T-100/callback -H "$JSON" -H "$ADMIN" \
  -d '{
    "sequence": [{"status":"success","respCode":"0000","delayAfter":0}],
    "customFields": { "orderRef": "ORD-42", "tenant": "acme" }
  }'
```

For 2C2P these are merged alongside the provider's own fields; for Omise they land in
`data.metadata`. Combinations you use often can be saved as presets in the dashboard.

Fields that identify the transaction or state its outcome (`invoiceNo`, `respCode`, `amount`, …)
are not overridable this way — see [the API reference](api.md#post-apiadminpaymentsinvoicenocallback).
Use `customPayload` when you need to control the payload completely.

---

## An exact payload

When you have a real payload captured from production and want to replay it verbatim:

```bash
curl -X POST $BASE/api/admin/payments/T-100/callback -H "$JSON" -H "$ADMIN" \
  -d '{
    "customPayload": {
      "invoiceNo": "T-100",
      "amount": "1500.00",
      "respCode": "0000",
      "respDesc": "Success",
      "tranRef": "TXN123456789"
    }
  }'
```

The fields are sent exactly as given — nothing is generated, defaulted or normalised. The provider
envelope still applies, so a 2C2P callback arrives as `{ "payload": { … } }` with your object
inside it.

---

## Omise

Same ideas, different shapes. Amounts are in subunits:

```bash
CHARGE=$(curl -s -X POST $BASE/api/omise/charges -H "$JSON" \
  -d "{\"amount\":150000,\"currency\":\"thb\",\"return_uri\":\"$HOOK\"}" \
  | sed 's/.*"id":"\([^"]*\)".*/\1/')

curl -s $BASE/api/omise/charges/$CHARGE
```

Webhooks use Omise's event envelope, so assert against `data.status` rather than `respCode`.

---

## In an automated suite

Nothing here needs the UI. A typical setup:

1. Start the sandbox as a fixture (`npm run dev`, or point at a deployed instance).
2. Mint an inspector session per test so runs cannot see each other's callbacks.
3. Drive the payment through the admin API.
4. Poll `GET /api/inspect/:sessionId` until the expected number of callbacks arrives.
5. Assert on the captured payload.

The sandbox's own test suite does exactly this — see [`test/`](../test) for a working example, and
[`test/helpers.js`](../test/helpers.js) in particular.
