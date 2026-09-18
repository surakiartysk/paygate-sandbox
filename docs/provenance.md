# Provenance

Where this repository came from, what did and did not travel, and how AI was
used. Written plainly because the alternative — depth with no explanation —
invites the wrong question.

## The short version

**This one is not a stand-in.**

The other repositories in this portfolio replace a private subject with an
invented one, because the original is not mine to publish. This sandbox does
not need that: it emulates **2C2P** and **Omise**, two real payment gateways
whose request and response shapes are published, and it follows that public
documentation. There is nothing here to disguise, which is why provider names
appear in this repository and nowhere else in the portfolio.

The providers are representative rather than special. They are the two I know
well enough to emulate faithfully, and the problems the sandbox exists to solve
are not specific to either — any gateway integration meets the same ones.

**What travelled is the judgement about which problems those are. No employer's
code, endpoints, field names or business rules did.**

## What travelled

**The knowledge of which paths actually matter**, which is the whole premise.
The README puts it plainly: "Integrating a payment gateway is mostly about the
unhappy paths. A card that works is the easy part."

Everything this sandbox makes reachable on demand is a case that is hard to
produce against a provider's own sandbox, and therefore gets tested by hand
once and never again:

- a decline carrying a specific issuer code
- an inquiry that hangs rather than answering
- the same webhook delivered twice, out of order
- a callback that arrives before the caller's own database commit

Choosing those four, and building the tool so each is a single API call, is a
judgement that comes from having been on the wrong side of them in production.
It is not something a provider's documentation tells you.

**The shape that follows from it.** An admin API that drives the outcome
separately from the transaction API — because the system under test must not
know it is being steered — plus a provider adapter layer and a built-in
inspector for integrations with no webhook endpoint yet. See
[architecture.md](architecture.md).

## What did not travel

- **No employer, product, or repository names**, here or in the commit history.
  Enforced mechanically rather than by good intentions: `scripts/check-leak.mjs`
  runs as the first half of `npm test`, which is what CI runs, so a build fails
  on the source project's vocabulary. Its word list lives outside the
  repository, because a denylist published in a public repo names the very
  things it exists to suppress.
- **No business rules.** The sandbox models what a gateway does, not what any
  particular merchant did with one. Amounts, currencies and issuer codes are
  the providers' own published values.
- **No real credentials, and no real money.** The sandbox holds neither, and
  must never be pointed at a production system — stated in the README as a
  condition of use rather than a footnote.
- **No payload encryption.** 2C2P's production API wraps requests and responses
  in JWT/JWE with a merchant key pair; this speaks plain JSON. A deliberate
  limit, and the README states its consequence against its own interest: an
  integration's signing step is not exercised here, so that layer still needs
  one test against the provider's real sandbox.

## The subject

2C2P and Omise, used on their own published merits. Unofficial, and not
affiliated with either.

Emulating a public API is not the same act as republishing private work, and
the distinction is worth stating because the rest of this portfolio is built on
the opposite premise. A reader who arrives here from the dashboard or the test
suites should know that this repository's subject required no substitution.

## How AI was used

As a drafting tool, under review. The architecture, the decisions and the
trade-offs are mine; the typing largely was not.

The discipline that makes that division honest here: **the sandbox is driven
over HTTP by its own tests, not asserted against its internals.** The suite
boots a real server against a throwaway data directory and exercises both
providers' flows, the callback inspector, the admin API and the SSRF guard — so
what is claimed in the README is what a caller can actually get, rather than
what the code appears to do when read.
