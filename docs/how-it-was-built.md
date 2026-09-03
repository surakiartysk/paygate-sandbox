# How it was built

The subject being emulated, and how AI was used.

## The subject

2C2P and Omise, emulated from their public documentation. Unofficial, and not
affiliated with either.

Why these two: they are among the most common card gateways for a merchant in
Thailand, and they disagree on nearly everything a sandbox has to get right.
2C2P hands out a payment token and reports every outcome as a response code in
the body; Omise creates a charge object and reports through its status and
failure code. A sandbox that serves both cannot quietly assume one provider's
habits.

The history starts at the first push, on 3 September; the work before it was
done locally.

## How AI was used

As a drafting tool, under review. The architecture, the decisions and the
trade-offs are mine; the typing largely was not.

The discipline that makes that division honest here: **the sandbox is driven
over HTTP by its own tests, not asserted against its internals.** The suite
boots a real server against a throwaway data directory and exercises both
providers' flows, the callback inspector, the admin API and the SSRF guard — so
what is claimed in the README is what a caller can actually get, rather than
what the code appears to do when read.
