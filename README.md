# Dilution — an explorable equity simulator

Drag a fake company from incorporation to Series B and watch the cap table dilute:
SAFEs, option pools, the pool shuffle, liquidation preferences and the exit waterfall.

## Run it

```bash
./run.sh
```

That one command installs dependencies if needed, runs the engine test suite, prints the
full cap table and exit waterfall for every bundled scenario, times a recompute against
the 16 ms frame budget, and then serves the explorable at <http://localhost:5173>.

Everything is bundled and offline. There is no API, no key, no network call at any point.

Individual pieces, if you want them: `npm test`, `npm run report`, `npm run bench`,
`npm run dev`, `npm run build`.

---

## What it is

An explorable explanation in the Setosa / sha256algorithm.com tradition. Every number in
the narrative is draggable — cheque sizes, valuations, SAFE caps and discounts, option
pool percentage and timing, preference multiple, participation, anti-dilution, exit value.
The cap table, the ownership sunburst and the exit waterfall recompute on every frame, and
a line at the top names the mechanic you just touched and the points of ownership it moved.

Three bundled scenarios, all on the same fictional company:

- **The good round** — one post-money SAFE, a sensible pool, rising valuations, 1x
  non-participating preference.
- **The pool-shuffle trap** — three SAFEs including an MFN one, and a 20% option pool taken
  out of the pre-money. Flip the pool timing switch on Series A: the lead goes from 20.0%
  to 17.2% and the founders gain 2.9 points, on identical headline terms.
- **The down round** — Series B below the Series A post-money, 1x participating preference
  capped at 3x, broad-based weighted-average anti-dilution. At a £60m exit the founders own
  a third of the company and receive much less than a third of the money.

## Who it is for

Founders about to sign a term sheet they have not modelled, operators who have been handed
a cap table and told it is fine, and investors who want to show a founder what a term
actually costs rather than assert it. It assumes you know what a share is and nothing else.

**Not investment, financial, tax or legal advice. Not a cap table of record.** It is a
teaching model. Verify anything that matters against the actual documents and your own
counsel.

## How it works

`src/engine/` is a pure, dependency-free TypeScript library; `src/ui/` is a thin React
layer over it. Given a scenario — a list of events (founding, SAFE, grant, priced round) —
`simulate()` walks the events and returns a snapshot of the cap table after each one.

The interesting part is `solveRound()`. A priced round is genuinely circular: the price per
share depends on the pre-money share count, which depends on the new option pool, which is
sized as a percentage of the post-money count, which depends on how many shares the money
buys, which depends on the price. SAFEs make it worse, because their conversion price
depends on the round price (discount branch) or on the option pool (cap branch).

The solver turns that into a one-dimensional root find. For a candidate price `x`,
`evaluateAtPrice(x)` computes what every SAFE converts into, how big the pool must be, and
how many make-whole shares any protected series receives — then reports the price that
resulting cap table implies. A solution is a price with `implied(x) = x`. The fast path
iterates `x <- implied(x)` and lands in a handful of passes; when a SAFE sits exactly on
the boundary between its cap and its discount, that iteration can two-cycle, and the solver
falls back to bisection on `implied(x) - x`, which cannot. Either way the residual is
reported, and the UI says so plainly when a round did not converge.

What the model covers, with the convention it picked stated explicitly in the code:

- pre-money vs post-money option pool (the pool shuffle), and the effective pre-money it implies
- post-money SAFEs on the 2018 YC definition of Company Capitalization, pre-money SAFEs on
  the 2013 one, valuation caps, discounts, MFN, and the circular pre-money conversion
- pool top-ups sized against the post-round table, and grants out of an existing pool
- pro-rata participation by existing holders
- broad-based weighted-average anti-dilution on a down round
- an exit waterfall with seniority, 1x/nx preferences, participating and capped-participating
  preferred, and the as-converted crossover found by bisection on the waterfall itself

## Data sources

None. There is no dataset and no live API — the "fixtures" are three hand-written scenarios
in `src/scenarios.ts` with made-up but plausible UK/EU seed-to-Series-B numbers. Every
result is computed from first principles by the engine, so the demo is deterministic and
runs with the network switched off.

The conventions the engine implements come from the standard documents and the usual
sources: the Y Combinator safe (2013 pre-money and 2018 post-money forms) and its user
guide, the NVCA model documents' weighted-average anti-dilution language, and the standard
treatment of the option pool shuffle. See LOG.md for the specific references.

## Honest limitations

- Share counts are floating point and rounded only for display. A registrar issues whole
  shares; this does not.
- Granted options are treated as fully vested and exercised at a zero strike price. The
  unallocated pool is cancelled at exit and receives nothing.
- No founder vesting, no debt, no convertible notes with interest or maturity, no escrow,
  no transaction costs, no management carve-out, no multiple share classes with different
  votes, no tax anywhere.
- Anti-dilution is broad-based weighted average only; no full ratchet, no narrow-based
  variant, no pay-to-play.
- Anti-dilution make-whole shares are issued after the price is struck, so the incoming
  investor is diluted by them. Some term sheets put the adjustment inside the pre-money
  instead, so the founders alone pay. That choice is not exposed in the UI.
- Roughly 1 round in 50,000 of a deliberately adversarial random sweep has no
  self-consistent price and is reported as non-converged rather than answered. Asking for
  an arithmetically impossible option pool is clamped and flagged rather than refused.
- Tested on macOS with Node 24 in Chrome. Not tested on Windows, on Safari, on Firefox, or
  on a touch screen.

## Licence

No licence granted; this is a portfolio piece, not a product.
