# Decisions

Why this sandbox is shaped the way it is. Read this first if something looks strange — the
reasoning is here rather than scattered through the code.

Every entry carries a **trade-off**. A decision with no stated cost is usually a decision nobody
has examined, and it is the section to press on hardest.

Most of what follows was not designed up front. It was learned from a bug, and the bug is named
where that is true — a decision that cost something to arrive at is worth more to a reader than
one that was obvious.

**Contents**

1. [A sandbox earns its keep only when failure is reachable on demand](#1-a-sandbox-earns-its-keep-only-when-failure-is-reachable-on-demand)
2. [Two providers, one engine, and no encryption](#2-two-providers-one-engine-and-no-encryption)
3. [Every input is attacker-controlled, and the password is published](#3-every-input-is-attacker-controlled-and-the-password-is-published)
4. [A choke point that can be walked around is not one](#4-a-choke-point-that-can-be-walked-around-is-not-one)
5. [An address is matched structurally; a spelling is not an address](#5-an-address-is-matched-structurally-a-spelling-is-not-an-address)
6. [The rate limit keys on the socket, and trusts a header only when told to](#6-the-rate-limit-keys-on-the-socket-and-trusts-a-header-only-when-told-to)
7. [A requirement in a table is not a requirement](#7-a-requirement-in-a-table-is-not-a-requirement)
8. [Redaction matches the shape of a name, not a list of names](#8-redaction-matches-the-shape-of-a-name-not-a-list-of-names)
9. [Simulation lives in headers, and a caller-chosen number gets a ceiling](#9-simulation-lives-in-headers-and-a-caller-chosen-number-gets-a-ceiling)
10. [Two storage backends, and the places they were allowed to disagree](#10-two-storage-backends-and-the-places-they-were-allowed-to-disagree)
11. [A callback delivered and not recorded is this tool failing](#11-a-callback-delivered-and-not-recorded-is-this-tool-failing)
12. [Caps count what fills the disk, and one cap is deliberately absent](#12-caps-count-what-fills-the-disk-and-one-cap-is-deliberately-absent)
13. [Nine writers were right and one was wrong, so the one moved](#13-nine-writers-were-right-and-one-was-wrong-so-the-one-moved)
14. [Constant time, and what it does not buy](#14-constant-time-and-what-it-does-not-buy)
15. [What is stated outranks what is inferred](#15-what-is-stated-outranks-what-is-inferred)
16. [The pattern all of this keeps producing](#16-the-pattern-all-of-this-keeps-producing)
17. [A demo password that can be published, because of what it opens](#17-a-demo-password-that-can-be-published-because-of-what-it-opens)
18. [The browser holds a session, not the password](#18-the-browser-holds-a-session-not-the-password)

---

## 1. A sandbox earns its keep only when failure is reachable on demand

**Context.** A provider's own sandbox will take a payment and approve it. What it will not
reliably do is decline with a specific issuer code, hang an inquiry, deliver the same webhook
twice out of order, or answer a callback after the caller has already committed its own
transaction. Those are the cases an integration gets wrong, and they are the cases nobody can
reproduce on demand.

**Decision.** Build the failures first and treat the happy path as the easy half. Every scenario
this sandbox exists for is selectable per request — a forced error code, a delay, a duplicate
callback, a sequence delivered out of order — so a test can ask for the bad case instead of
waiting to be unlucky.

**Trade-off.** Emulating a provider means the emulation can be wrong, and a test that passes here
is not evidence the real gateway agrees. The shapes come from the providers' public documentation,
which is a snapshot rather than a subscription: when a provider changes a field, this finds out
when someone notices. That limit is stated in the README alongside the one thing this
cannot exercise at all — payload encryption and signing, which still needs a test against the
provider's own sandbox.

---

## 2. Two providers, one engine, and no encryption

**Context.** 2C2P and Omise differ in more than field names. Amounts are major units in one and
subunits in the other; identity is merchant-supplied in one and gateway-generated in the other;
an outcome is a response code string in one and a status plus boolean flags in the other.

**Decision.** One storage model and one callback pipeline underneath, with a thin adaptation layer
per provider. The differences are data, not code paths — which is why `checkForceError` takes a
provider and why the dashboard can list both kinds of payment in one table.

**Trade-off.** A shared engine means a bug in it is a bug in both providers, and a provider-shaped
quirk has nowhere natural to live. It also means the provider is sometimes inferred rather than
known, which is how the 2C2P error dropdown came to do nothing, unnoticed — see
[decision 15](#15-what-is-stated-outranks-what-is-inferred).

---

## 3. Every input is attacker-controlled, and the password is published

**Context.** This is deployed publicly and its default admin password is in the repository. The
data is invented, so the instinct is that nothing here is worth attacking.

**Decision.** Treat the data as worthless and the *instance* as valuable, because it is: an
outbound callback is a request from this server to an address of the caller's choosing, the admin
dashboard renders caller-supplied strings into an authenticated page, and a request handler will
sleep for a number a caller sends. None of those care that the payments are fake.

That framing is why the security work in this repo is about reachability rather than
confidentiality. The questions are *what can a stranger make this server do* and *what can a
stranger put on the admin's screen*, and both have had real answers — decisions 4, 5 and 6, and
the stored cross-site scripting that reached the admin page through an invoice number.

**Trade-off.** It makes the code more defensive than a sandbox looks like it should be, and a
reader who assumes "it is fake data" will find the guards disproportionate. The alternative is a
public instance that is a usable proxy into someone's private network, which is the failure mode
that does not stay a sandbox problem.

---

## 4. A choke point that can be walked around is not one

**Context.** `executeCallback` validates the callback URL before sending, and the comment above
that call described it as the single choke point for every outbound callback. It was not one. The
`fetch` underneath defaults to following redirects, so the guard saw the first URL and the runtime
followed whatever came back without asking again.

A caller supplies a genuinely public callback URL — it passes, correctly — and their server
answers `302` toward a private range or a cloud metadata address. Verified rather than reasoned
about: a local server answering a redirect toward the metadata address produced a result with
nothing marked blocked, and a second local server used as the target received the POST.

**Decision.** Redirects are not followed. The `3xx` is reported as the result, which an
integration can see and act on.

**Trade-off.** An integration whose real endpoint sits behind a redirect has to point the sandbox
at the final URL itself. Following safely would mean re-validating every hop and capping the
chain — more code and more places to be wrong, for a convenience nobody has asked for.

Two tests hold it, and the second matters more than it looks: one that a redirect toward a
*refused* address is not followed, and one that a redirect toward an *allowed* address is not
followed either. The second fails if someone later decides to follow redirects "just to the safe
ones", which is the change that would quietly restore the hole.

---

## 5. An address is matched structurally; a spelling is not an address

**Context.** The always-blocked list was documented as hostnames that can never be reached
regardless of mode, and a test asserted exactly that for the cloud metadata address. Both were
true. Neither was the whole truth: it was a set of strings, so the guarantee held for the
spellings somebody had thought to list, and an IP address has several. The IPv6-mapped form
reached the identical service and was allowed.

**Decision.** The address is matched structurally, through the same IPv4-mapped decoding the
private-range check already did. The string set keeps the metadata *names*, where a string match
is the right tool.

**Trade-off.** Structural matching is more code than a set literal and harder to read at a glance.
It is also the only version that is true — and the decimal, hex, octal and short-form spellings
that look like the next omission are not: the URL parser normalises them to dotted quads before
this code runs. That is recorded in a comment rather than left for the next reader to re-derive,
because an absent check that is actually someone else's job looks identical to a missing one.

---

## 6. The rate limit keys on the socket, and trusts a header only when told to

**Context.** The limiter read the forwarded-for header first and fell back to the socket address.
That header is sent by the client, so the bucket was keyed on a value the caller chooses. Verified
against a running server: five plain requests then a refusal, as intended — and eight requests
carrying eight different forwarded-for values, never refused once.

Both the module header and the deployment guide scoped out a "distributed attacker" while claiming
the limit still stops the runaway script it exists for. A runaway script setting one header is
neither distributed nor stopped, and nothing said so.

**Decision.** The socket address is the key. The header is trusted only when `TRUST_PROXY=true`.

The asymmetry is the point: trusting the header where nothing overwrites it removes the limit
entirely, while refusing to trust it merely groups everyone behind a shared proxy into one
bucket — too strict rather than absent.

**Trade-off.** Behind a proxy, and without the opt-in, every client shares one allowance. That is
a real cost paid by the correct deployment to protect the careless one. Whether a given platform
lets a client prepend to the header it sets is that platform's business and not something this
code can check, so opting in is a statement that the operator knows — and the comment says that is
the limit of what was verified, rather than implying it away.

---

## 7. A requirement in a table is not a requirement

**Context.** The deployment guide marked `ADMIN_PASSWORD` as "something long and random — the
default is public knowledge" and `ALLOW_PRIVATE_CALLBACKS=false` as required for a public
instance. Nothing enforced either. A deployment that forgot them served its dashboard, its logs
and its config API to anyone who had read the README, with the callback guard in its permissive
mode — and looked like it was working, which is the whole problem with a requirement that lives
in a table.

**Decision.** Enforce at the two chokepoints every affected path already passes through, and
change no handler: authentication refuses every password, the default included, when deployed
without one set; the URL guard treats an unset private-callback flag as `false` once deployed.

The companion dashboard solved the same problem with middleware that refuses every request with a
`503` naming the fault. That shape needs a single entry point and this has none — each file under
`api/` is its own function. Copying it would have meant an import-time throw, turning a
configuration mistake into an opaque `500`, or a check in every handler, which is a wide diff and
one more thing to forget.

**Trade-off.** Refusing the default password locks the owner out of their own deployment until
they set one. That is recoverable in a single redeploy; an admin surface open to everyone is not.
Neither rule applies locally, because the quick start depends on the default working and on
loopback callbacks being allowed, and a check that breaks the quick start is a check people
disable. `VERCEL=1` is the signal, and it covers preview deployments deliberately: a preview URL
is as reachable as a production one.

---

## 8. Redaction matches the shape of a name, not a list of names

**Context.** Header sanitisation existed to keep credentials out of the request log, and it
worked — for the four header names somebody thought of in advance. The name of *this
application's own password* was not among them. Measured against a running sandbox, a request
carrying both stored one as redacted and the other in plaintext, in a log that is readable through
the dashboard and sits on disk for a week.

The redaction was not broken. It had never been told about the secret this sandbox uses.

**Decision.** The explicit list keeps its entries, and anything whose name contains password,
secret, token, api-key, auth, credential or signature is redacted whether or not it was listed. A
four-name denylist was wrong the moment a fifth header existed, and the next one would be wrong
the same way.

**Trade-off.** The pattern over-matches, deliberately. A header genuinely called `x-token-count`
is redacted and someone loses a number from a log; the other error publishes a secret into a store
that renders in a browser. Those are not comparable, so it leans to the harmless side.

---

## 9. Simulation lives in headers, and a caller-chosen number gets a ceiling

**Context.** Per-request simulation belongs in headers rather than the body, because it must work
against every route without changing the provider payloads those routes exist to emulate. The
delay header took a number from whoever sent the request and slept for it, with nothing checking
the value. Measured: a large enough number was still sleeping when the client gave up — roughly
27 hours. Serverless, that burns the function's whole budget; self-hosted, nothing stops it.

It is the same shape as the rate limit in [decision 6](#6-the-rate-limit-keys-on-the-socket-and-trusts-a-header-only-when-told-to):
a value the caller chooses, trusted because it arrived in a header.

**Decision.** Clamp to 30 seconds — the timeout on this sandbox's own outbound callbacks, and so
the longest wait anything here is designed to survive. Clamped rather than refused: the header is
a testing affordance, and answering `400` to a number that used to work breaks callers to make a
point, where a shorter delay does not.

**Trade-off.** A genuinely slower gateway can no longer be simulated through the header. The admin
config's global delay is deliberately left unbounded for that, because it is behind the admin
password and whoever holds it already has more destructive options than sleeping.

Both headers were undocumented before this; they are in `docs/api.md` now, with the ceiling and
its reason. Two things about the tests came from getting them wrong first. The ceiling is
configurable so the test can lower it to a second, instead of making the suite sleep for thirty
to prove something a lower bound shows just as well. And the long-delay test carries an explicit
timeout: without one, removing the clamp does not fail the test, it *hangs* it for the 27 hours
the header asked for. A suite that hangs in CI is worse than one that goes red, because nobody
gets a failure to read.

---

## 10. Two storage backends, and the places they were allowed to disagree

**Context.** Storage is Vercel KV when deployed and JSON files locally. That split is what lets
the repository be cloned and run with no account anywhere, and it is the reason two bugs lived as
long as they did: a test run never takes the deployed branch, so a divergence is invisible to the
suite by construction.

The inspector's session TTL was the clearest case. The save function said it refreshed the TTL,
and on KV it did — every write set a fresh 24-hour expiry. The local store expires from creation
and does not. So a session receiving one callback a day lived indefinitely on the deployed
backend and expired in development, while the module's own documentation promised a shared demo
never accumulates. Three claims, two implementations, no agreement.

**Decision.** Where the backends can differ, the documented intent wins and both are made to match
it. The TTL is absolute on both; what KV is handed is what remains of the original window rather
than a new one, and a session already past its window is not rewritten — which an unconditional
expiry would have resurrected for another day.

**Trade-off.** A debugging session running longer than a day loses its captures mid-flight with no
warning. For a sandbox whose sessions are minted freely, that is the cheaper side.

The testing consequence is the durable part: the expiry tests call the remaining-TTL helper
directly, because the divergence lives in a branch a test run never takes. Anything that behaves
differently per backend needs a test at the level where both halves are reachable, or only the
half that was already right gets tested.

---

## 11. A callback delivered and not recorded is this tool failing

**Context.** `sendCallback` read the payment, sent the callback over the network, then appended
the history entry to that snapshot. The read and the write were separated by a full outbound HTTP
round trip, so two concurrent callbacks on one invoice each overwrote the other's entry — while
the API answered success to both.

Measured against a running sandbox, with the built-in inspector as an independent witness rather
than trusting the record to describe itself:

```
6 concurrent callbacks, one invoice
  delivered (the receiver saw)   6
  recorded in history            3
```

This sandbox exists to show an integrator which callbacks went out. A callback that arrives and is
not written down is that job failing in the quietest possible way: the caller is told it worked,
the receiver has it, and the dashboard does not.

**Decision.** The append lives in one function in storage, and both callback paths use it. Forty
lines further down the same file, the sequence sender already re-read the payment immediately
before appending — which is why sequences were correct under identical load and single callbacks
were not. Same file, same problem, solved in one place and not the other.

**Trade-off, stated in the code rather than implied away.** On the local store the append is
genuinely atomic: the read and write are synchronous, so with no await between them an interleave
has nowhere to happen. On KV it is not and cannot be here — there is no compare-and-set, and two
serverless instances share nothing but the store. The window becomes two adjacent calls instead of
a network round trip. That is the whole of the improvement, and the comment says so.

The test that earns this is not the one that asserts the fix. It is the mutation that inserts a
single yield between the read and the write: one is enough to lose six of thirty, which is what
tests the atomicity claim instead of restating it.

---

## 12. Caps count what fills the disk, and one cap is deliberately absent

**Context.** The per-session capture cap was a count of captures, with a comment saying one noisy
client could not exhaust storage. Measured: a single request carrying a 5 MB body was stored
whole. The cap never looked at size.

**Decision.** Bodies are bounded once serialised — three orders of magnitude above a payment
callback — and an oversized one is truncated to a readable excerpt rather than refused. A `413`
would tell a gateway its delivery failed and leave nothing to inspect, which is the opposite of
what this endpoint is for.

**And one cap that is deliberately missing.** Nothing limits the *number* of sessions: 300
distinct ones created in under a second, in one file. That is not fixed, because a cap means
refusing new callers once a shared demo fills up, or evicting someone mid-debug — and ids are
chosen by the caller, so there is no fair eviction order. What actually bounds it is the rate
limit on the endpoint and the TTL that reclaims.

**Trade-off.** The honest version of this decision is that the second half is unresolved, and the
comment above the constant now says what bounds session count instead of claiming a protection the
constant does not provide. A reader deciding what to point at a shared instance needs that, and a
comment that quietly overstates it is worse than silence.

---

## 13. Nine writers were right and one was wrong, so the one moved

**Context.** Status history is written in ten places. Nine of them write the shape the dashboard's
timeline reads. The seeded demo data wrote a different one — its own key names, its own prose
field. For a seeded payment the sort comparator compared two undefined dates and returned `NaN`,
the time column rendered `Invalid Date`, the author fell through to "unknown", and the one piece
of prose those entries carried was the only thing the renderer had no field for.

That is on the seeded data, which exists so a visitor to a shared deployment sees something real
instead of an empty table — the worst possible place for a timeline that reads `Invalid Date`.

**Decision.** The one moved. When a shape is written in ten places and read in one, the reader
defines the contract and a majority of writers is evidence, not proof — but nine against one is
not a close call.

**Trade-off.** Nothing enforces the shape; it is a convention held by a test that asserts on what
was stored. That test exists because the realistic mistake is not writing the wrong shape, it is
writing the *new* keys while leaving the old ones behind — which passes a naive check and leaves
two shapes in one array. The mutation that proves it is exactly that one.

---

## 14. Constant time, and what it does not buy

**Context.** Comparing the admin password with `===` returns as soon as two bytes differ, so how
long a rejection takes correlates with how much of the prefix was right. It is the textbook shape
of a timing oracle, and the authentication module is the first file a reader checks for one.

**Decision.** Compare in constant time. Not because the attack is realistic here — nobody is
extracting this password by timing a public sandbox that holds invented payments and sits behind a
rate limit, where network jitter dwarfs the signal — but because the alternative is a comment
explaining why the obvious thing was skipped, and that costs a reader more than the five lines it
replaces.

**Trade-off.** It buys one channel and no more, and pretending otherwise would be the real cost.
The password is still a single shared secret, compared in full on every request, with no hashing,
no rotation and no lockout.

Two guards around it carry more practical weight than the timing does: without the length check,
any wrong-length password is a `500` instead of a `401`; without the type guard, so is a non-string
from a JSON body. Both are mutation-tested. Reverting to `===` fails none of the tests — stated
plainly, because it is the limit of what they protect. They pin behaviour; timing is not assertable
without a flaky test, so the constant-time property itself rests on review.

---

## 15. What is stated outranks what is inferred

**Context.** Provider detection guessed 2C2P from a path prefix this repository does not serve.
Every 2C2P endpoint lives under a different prefix, so the guess returned nothing for all of them
and the dashboard's 2C2P error dropdown could never apply. The dashboard offered it, saved the
value, read it back, and nothing happened. The Omise half matched its prefix and worked throughout,
which is why this went unnoticed: anyone exercising the feature at all was likely to exercise the
half that was fine.

**Decision.** The path matches reality, and — the durable half — the force-error check takes the
provider from its caller when the caller knows it. The Omise route was already passing its provider
as a second argument the function ignored, which reads as the intent this restores. Inference from
paths is the weaker signal, and it has now broken silently once.

**Trade-off.** Two sources of truth for the same fact, with the explicit one winning. That is one
more thing to keep straight than a single inference, and it needs a test at the level where the
stated provider and the path can actually disagree — because correcting the path alone makes every
route-level test green, which would leave the argument as redundancy with nothing pinning it. That
is the shape that rots: nothing tells you when it stops working.

Each provider test has a partner asserting the *other* provider is untouched. Without that pair,
forcing an error for everything would pass.

---

## 16. The pattern all of this keeps producing

Eight bugs here have had the same shape: **a defence that is present, correct and documented,
sitting beside a path that goes around it.**

| The defence | The path around it |
| --- | --- |
| A guard on the callback URL | `fetch` followed redirects past it |
| An always-blocked metadata address | One spelling of it was not in the list |
| A rate limit | Keyed on a header the caller sends |
| A per-session capture cap | Counted rows while one row held 5 MB |
| A TTL that stops a demo accumulating | Slid forward on the backend that is deployed |
| Header redaction | Never told the name of this application's own password |
| A callback history | Appended to a snapshot taken before the network call |
| A force-error setting | Detected a provider by a path this repo does not serve |

Most were found not by reading but by a probe against a running server, asking whether
the thing the comment claimed was actually true — which is why `CLAUDE.md` says to go and check a
claimed protection rather than believe it, and why the numbers in this repository's commit
messages are measurements rather than estimates.

**Trade-off.** Probing costs more than reading and does not scale: it finds what you thought to
ask about, and the audit is only as good as the questions. Three of the eight were found while
looking for something else.

---

## 17. A demo password that can be published, because of what it opens

**Context.** The landing page offered "Open the dashboard", and on a public deployment that led to a
login nobody but the owner could pass: [decision 7](#7-a-requirement-in-a-table-is-not-a-requirement)
made the admin password mandatory, correctly, because it opens everything — the shared config,
every caller's request log, deleting every payment, and callbacks to any address. A visitor could
use the provider APIs with `curl`, but never see the part that shows what a sandbox is for.

The companion dashboard solved the same problem with a role whose password is printed on the
sign-in screen, and which can never dispatch a real run. The lesson carried over: publishing a
password is safe exactly when what it grants is narrow enough to hand to anyone.

**Decision.** `demo` signs in a *visitor*, not an admin. Each sign-in mints a random token of its
own, ten sample payments owned by it, and an inspector session for their callbacks, all expiring
after a day. The token, never the shared password, is the credential after that.

- **Refused unless allowed.** `isAuthenticated` still means the admin and nothing else, so every
  admin route that has not been written with visitors in mind turns them away. The ones that
  have opted in: the payment list, one payment's routes (status, callback, inquiry config,
  delete) and reading the config. Clearing all payments, writing the config and reading the
  request log answer `403`.
- **Ownership is checked where the payment is read.** Each payment route reads through one
  `loadPayment`, which answers "not found" for a payment that is not the visitor's, so the routes
  cannot be used to learn which invoice numbers exist.
- **Nothing a visitor sends decides where a request goes.** Their callbacks go to the inspector
  session fixed at sign-in; naming another address is refused. A visitor's payment also gets the
  30-second ceiling [decision 9](#9-simulation-lives-in-headers-and-a-caller-chosen-number-gets-a-ceiling)
  gave the delay header, on its inquiry delay and its simulated timeout, because it is exactly the
  stranger that decision was written for.
- **Each side sees only its own.** The admin's list leaves visitors' payments out: strings a
  stranger chose do not belong on the admin's screen, and two hundred copies of the same ten
  samples are no use there.
- **Bounded.** Sign-in has its own rate-limit bucket of ten a minute, a visitor on the admin
  routes is held to the provider APIs' limit, and the instance refuses new visitors past 2,000
  live visitor payments. Each seeded payment measured 0.83–1.06 KB serialised, about 9.2 KB a
  visitor, so the ceiling is about 1.8 MB before any callback history. Expired visitors' payments
  are swept on the next demo sign-in, the one event that adds more.
- **The admin password can never be `demo`.** Refused everywhere, not only when deployed: nothing
  depends on it locally, and the failure it prevents is the published password opening the admin
  surface.

Building it found a bug that had nothing to do with visitors: the inquiry `timeout` simulation
answered `200 {"_timeout":true}` in 8ms and only then hung, so the client timeout it exists to
exercise never fired. It now sends nothing.

**Trade-off.** The admin surface now has two principals, and every new admin route has to decide
which it serves. Refusing by default makes forgetting safe, not free: a route that opts in has to
check ownership itself, and that rule lives in three handlers rather than one place.

The ceiling on visitor payments refuses rather than evicts, so someone signing in from many
addresses can fill the demo for a day and turn everyone else away. Evicting the oldest instead
would let them delete other visitors' sandboxes, which is worse. On KV the count and the seeding
are not atomic, so simultaneous sign-ins can overshoot the ceiling by a few visitors.

Visitors share the admin's global config — a global delay or a forced error the owner sets
applies to their payments too, and they can see it but not change it. The ten-a-minute sign-in
limit covers admin attempts as well, so an owner who mistypes ten times waits a minute. And the
admin can no longer see what visitors did, except by opening a visitor invoice number directly.

---

## 18. The browser holds a session, not the password

**Context.** Signing in on the dashboard stored the admin password in `localStorage`, and in a
cookie readable by script for thirty days, and sent it on every request. The dashboard renders
strings chosen by anyone who can call the provider APIs — invoice numbers, descriptions, request
headers — so every one of its sixty `innerHTML` writes was one missed `escapeHtml` away from
handing the password to whoever planted the string. A probe putting markup in every
caller-controlled field of `POST /api/2c2p/token` found the escaping holds today. The design still
made a single future slip cost the password itself, which does not expire and opens everything
[decision 17](#17-a-demo-password-that-can-be-published-because-of-what-it-opens) lists.

**Decision.** A browser signs in once and receives an `HttpOnly; SameSite=Strict` session cookie,
`Secure` behind HTTPS. The page keeps a marker that it is signed in and nothing secret.

- **Signed, not stored.** The cookie holds an expiry, a nonce and an HMAC keyed by a hash of
  `ADMIN_PASSWORD`. Nothing is written server-side, so `isAuthenticated` stays synchronous for
  every route that calls it, and changing the password ends every session.
- **Twelve hours**, down from the thirty days the password cookie lasted.
- **The password cookie is refused**, not merely no longer set, so a browser still carrying one
  from before signs in again rather than riding it. Its `localStorage` copy is deleted the next
  time any page loads the sign-in or dashboard scripts.
- **Scripts keep the header.** `X-Admin-Password` is unchanged: a script holds the password
  anyway, and has no page to steal it from.
- **Signing in as demo ends an admin session** in the same browser. The admin wins when a request
  carries both, and only the server can clear an `HttpOnly` cookie.

**Trade-off.** Signing out clears the cookie in that browser, but a copy taken before then stays
valid until it expires; the only early revocation is rotating the password, which signs out every
browser at once. A stored session could be revoked one at a time, at the price of a storage read
on every admin request and an `async` `isAuthenticated` threaded through every route.

`HttpOnly` does not make a script on the page harmless: while the page is open, injected script
can still call the admin API as the admin. What it removes is carrying the credential away, and
what the lifetime bounds is how long a stolen one is worth.

A cookie is sent on requests the page did not make, the reason
[decision 17](#17-a-demo-password-that-can-be-published-because-of-what-it-opens) keeps demo
tokens in a header. `SameSite=Strict` is what answers that here: probed in Chromium from another
site, a credentialed `POST` to the clear route arrived without the cookie and every payment
survived. That protection is only as good as the browser's — an old one that ignores `SameSite`
sends the cookie, where a header would never have been sent. The usual cost of `Strict`, a link
from another site landing signed out, does not apply: the dashboard's HTML is public and its data
comes from its own same-site requests, which carry the cookie — also probed.

---

## How to add a decision

Write it while the reasoning is still fresh, and include the cost. If the trade-off section reads
as "no real downside", the decision has not been examined hard enough — go back and find who it
makes life worse for.

Add it to the Contents at the top. `test/decisions-doc.test.js` checks that the list and the
headings agree, so a decision that never reaches the index fails the suite rather than quietly
becoming unfindable.
