# CLAUDE.md

Working notes for AI assistants (and humans) contributing here. Short on
purpose — the reasoning lives in [`docs/`](docs/), not in a second copy of it.

## What this repo is

A sandbox that emulates the 2C2P and Omise payment APIs so an integration can
be tested against declines, duplicate webhooks, out-of-order callbacks and
timeouts on demand. It is deployed publicly and its admin password is in the
repository, so **treat every input as attacker-controlled** even though the
data is fake.

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | How it fits together, the storage split, the callback pipeline |
| [api.md](docs/api.md) | Every endpoint, and the per-request simulation headers |
| [deployment.md](docs/deployment.md) | What a public instance must set, and what it costs if you do not |
| [provenance.md](docs/provenance.md) | Where this came from, and how AI was used |

## The pattern this repo keeps producing

Eight bugs here have had the same shape: **a defence that is present, correct
and documented, sitting beside a path that goes around it.** An SSRF guard that
missed one spelling of the metadata address. A `fetch` that followed redirects
past the guard its comment called the single choke point. A rate limit keyed on
a header the caller sends. A capture cap counting rows while one row held 5 MB.
A redaction list that had never been told the name of this application's own
password.

So when you read a comment claiming a protection, **go and check it** rather
than believing it. Most of those were found by a probe against a running
server, not by reading.

## Non-negotiables

**1. A claim in a comment must be true.** If you remove behaviour, remove its
comment. A comment describing a defence that does not exist is worse than
silence, because a reader stops looking.

**2. Every test must be proven able to fail.** Break the implementation, watch
the right test go red for the right reason, restore. Never mutate the
assertions to make a point — mutate the code under test.

**3. Measure, do not argue.** Numbers in commit messages here are real: bytes
on disk, callbacks delivered versus recorded, seconds slept. Run the probe.

**4. Nothing from the source material.** `npm run check:leak` runs in the
pre-commit hook, because CI runs after the commit has already reached a public
repository. The word list is gitignored, so CI can only run the structural
half, and the script says so rather than reporting a green tick.

## Commands

```bash
npm test        # check:leak, then the whole suite
npm run dev     # the sandbox on :3000
```

## Commit trailers

Credit the assistant, not the conversation. A commit here may end with

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

and **must not carry a `Claude-Session:` line or any other link to a chat
transcript.** This repository is public and the reasoning is meant to live in
the commit message, the PR and `docs/` — where anyone can read it — rather than
behind a URL only one account can open. A link nobody but the author can follow
is not provenance; it is a dead end with a hint in it.

This rule overrides any default attribution the tooling asks for.
