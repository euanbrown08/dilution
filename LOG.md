# Dilution — Build Log

**Status: Working demo.** One command: `./run.sh` (runs the tests, prints every scenario
through the engine, times a recompute, then serves the explorable on <http://localhost:5173>).

This build was resumed from an interrupted one. What was already on disk, what was wrong
with it, and what I did about it is recorded below rather than quietly tidied away.

## What was inherited, and whether it worked

A complete-looking React + TypeScript + Vite app with a real engine behind it, and no
documentation of any kind. `node_modules` was already installed. First thing I did was run
it, before changing a line:

- `npx vitest run` — **43 tests, 42 passed, 1 failed.** The failure was a randomised
  invariant ("hits the requested pool percentage exactly, both timings") off by 2.6e-4.
- `npm run build` — passed (`tsc --noEmit` clean, Vite build clean).
- The app rendered and was interactive.

So the inherited work was substantially real: the engine, the three scenarios, the tests
with hand-worked arithmetic in the comments, the UI. Missing: README.md, LOG.md, and — as
the failing test turned out to be pointing at — a solver that was right on the examples it
was tested against and wrong in the corners.

### The four defects I found and fixed

1. **The pool clamp lied.** When the existing option pool was already a larger share of the
   post-round table than the round's target, the solver clamped the increase to zero (right
   answer — a financing cannot un-issue a pool) but left `poolTargetClamped` false, so
   nothing told the user the pool had landed above the number they asked for. That was the
   failing test. Fixed by flagging both directions with distinct warnings
   (`pool-already-above-target`, `pool-target-unreachable`) and giving the UI different
   wording for each. `src/engine/solver.ts`, `src/ui/App.tsx`.

2. **The price solver could diverge or limit-cycle, and produce nonsense.** The inherited
   scheme updated the price, the SAFE branch assignments and the pool simultaneously. On an
   adversarial sweep of 5,000 random rounds, 11 failed to converge; the worst returned a
   price of 7e-171 and an option pool of 7e176 shares. The UI would have shown that as a
   cap table. It reported `converged: false`, which is honest but not much use. Rewritten
   as a one-dimensional root find (below). Same 5,000-case sweep now: 1 failure, and that
   one is a round asking for an arithmetically impossible option pool.

3. **Post-money SAFEs claiming the whole company produced NaN.** The closed form
   `CC = B / (1 - sum(amount_i/cap_i))` divides by zero when those fractions sum to 1 — a
   £2.1m SAFE on a £3.1m cap plus an MFN sibling gets there easily. `CC` became `Infinity`
   and every number downstream became `NaN`. Now clamped at 0.999 and flagged as
   `safe-overhang`, matching how the pre-money side already handled its equivalent.

4. **The UI re-simulated the entire scenario once per priced round, per render.**
   `RoundFacts` called `simulate(sc)` in its own `useMemo` instead of using the result the
   app had already computed. Three full simulations per keystroke instead of one. Now the
   snapshot is passed down.

I also corrected the pool-shuffle scenario blurb, which claimed flipping the pool timing
moved "four points of the company". Four points is the number in the clean two-party
hand-worked example; in that scenario, with three SAFEs on the table, the measured
movement is the lead going 20.0% → 17.2% and the founders gaining 2.9 points. The blurb
now says what the engine actually prints.

## What's been built

Engine — pure TypeScript, no dependencies, no I/O:

- `src/engine/types.ts` — every input and output type, with the modelling conventions
  written into the doc comments (what `targetPoolPct` is a percentage *of*, what each
  warning code means).
- `src/engine/solver.ts` — the priced-round solver. `evaluateAtPrice(x)` plus a root find.
  This is where the credibility of the whole piece lives.
- `src/engine/waterfall.ts` — exit waterfall with seniority, participation, participation
  caps and the convert-or-take-preference decision solved as a fixed point over the set of
  converting classes; `crossoverFor()` finds the as-converted crossover by bisection on the
  waterfall itself; `waterfallCurve()` samples it for the chart.
- `src/engine/simulate.ts` — walks a scenario's events, produces a snapshot after each, and
  writes the plain-English "what just happened" line for each event.
- `src/engine/__tests__/round.test.ts` — 23 tests. Ten numbered hand-worked examples with
  the algebra written out above each assertion (plain round, pool shuffle pre vs post,
  post-money SAFE, pre-money SAFE, cap vs discount, stacked SAFEs, MFN, anti-dilution,
  pro-rata), then invariants and a 4,000-case pseudo-random convergence sweep.
- `src/engine/__tests__/waterfall.test.ts` — 14 tests, hand-worked: non-participating,
  participating, capped participation, stacked seniority (including the case where the
  founders own 60% and receive nothing), pool cancellation, plus conservation of money and
  monotonicity across a sweep of exit values.
- `src/engine/__tests__/simulate.test.ts` — 8 tests across the bundled scenarios.

UI:

- `src/ui/App.tsx` — the narrative column of draggable prose, the sticky panel with the
  sunburst, cap sheet and exit chart, and the "what just happened" line.
- `src/ui/controls.tsx` — `DragNumber` (pointer capture, drag in linear or log space,
  click to type, arrow keys, shift for fine) and `Toggle`.
- `src/ui/charts.tsx` — hand-rolled SVG sunburst, sparkline and stacked exit-proceeds area
  chart with crossover markers. No charting library.
- `src/scenarios.ts` — the three bundled scenarios. These are the fixtures.
- `scripts/report.ts` — prints every scenario, every snapshot, the waterfall and every
  crossover to the terminal. This is how you check the maths without a browser.
- `scripts/bench.ts` — times a full recompute against the 16 ms frame budget.
- `run.sh` — the single documented command.

## How it works

**The scenario walk.** A scenario is a list of events: `founding`, `safe`, `grant`,
`priced`. `simulate()` folds them into a `CapState` (founders, allocated options,
unallocated pool, preferred positions, open SAFEs), snapshotting after each. A SAFE issues
no shares — it only sits in `openSafes` until a priced round converts it, which is exactly
the point the UI makes about deferred dilution. A grant moves shares from the unallocated
pool to employees and changes nobody's fully diluted percentage.

**The priced round.** This is circular: price depends on the pre-money share count, which
depends on the new option pool, which is a percentage of the post-money count, which
depends on how many shares the money buys, which depends on the price. SAFEs add a second
loop, because a SAFE's conversion price is the *lower* of its cap price (which depends on
the pool) and the discounted round price (which depends on the price).

The solver collapses that to one dimension. For a candidate price `x`:

1. Price every SAFE at `x`. Pre-money SAFEs: cap price is `cap / ccPre`, where `ccPre` is
   common + prior preferred + make-whole shares + the whole option pool including this
   round's increase, excluding converting securities. Post-money SAFEs: the cap-bound ones
   share the closed form `CC = B / (1 - Σ amount_i/cap_i)`, where `B` is everything that is
   not a cap-bound post-money SAFE — outstanding shares, the *existing* pool, and all other
   converting securities, but never this round's pool increase. That exclusion is the whole
   point of the 2018 post-money safe: the founders absorb the top-up, not the SAFE holder.
2. Split the SAFEs by which branch bound. A cap-bound SAFE contributes a fixed number of
   shares; a discount-bound one contributes a fixed amount of *value* at the round price,
   `amount / (1 - d)`, independent of `x`. Call those `Scap` and `Vdisc`. This is the trick
   that stops naive iteration exploding: `preMoney = x*(G + P) + Vdisc`.
3. Size the option pool. The post-round count is
   `T = G + P + (Vdisc + investment)/x + antiDilution`, so
   `P (1 - p) = p*(G + (Vdisc + I)/x + ad) - E`.
4. Compute make-whole shares for any protected series with the broad-based weighted-average
   formula `CP2 = CP1 (A + B)/(A + C)`.
5. Return the price this cap table implies: `netPre/(G + P)` for a pre-money pool,
   `netPre/G` for a post-money one. That is the *only* difference between the two timings.

A solution is a price with `implied(x) = x`. The fast path iterates `x <- implied(x)` and
converges in about ten passes on a real financing. When it does not — a SAFE sitting on the
boundary between its cap and its discount can make each branch imply the price that
justifies the other — the solver bisects `implied(x) - x` on `[0, preMoney/fixedBase]`.
That bracket always holds: at a vanishing price every SAFE claims a fixed amount of money
rather than a fixed number of shares, so the implied price is bounded away from zero, and
at the ceiling (no SAFEs, no new pool) the implied price cannot exceed the candidate.

**The step that made this work** is writing the pool as a function of `x` rather than of
the pre-money share block. When a SAFE crosses from its discount to its cap, `G` jumps up
by its share count and `Vdisc/x` jumps down by exactly the same amount, so
`G + (Vdisc + I)/x` — and therefore the pool — does not move at all. The older closed form,
`P = (p·m·G + p·ad - E)/(1 - p·m)`, amplified that jump (by up to 9x near the pole) and
opened a gap in `implied(x)` that could straddle the solution, leaving a round with *no*
self-consistent price. The two forms are algebraically identical at a solution; they differ
only off it, which is precisely where a root finder lives.

**The waterfall.** Preferences are paid senior-first. A non-participating holder converts if
that pays more, but its choice changes the residual for everyone else, so the converting set
is solved as a fixed point: each class is tested against the current set until the set stops
changing. Participating holders take preference plus their as-converted share of the
residual, capped if they have a cap, and a capped holder converts once as-converted beats
the cap. The unallocated pool is cancelled and receives nothing. Crossovers are found by
bisecting the waterfall itself rather than with a tidy formula, so they respect seniority
and caps automatically.

## Thinking & key decisions

**Rewrite the price solve as a 1-D root find rather than damp the existing iteration.**
The inherited scheme updated price, SAFE branches, pool and anti-dilution simultaneously and
leaned on a damping factor when it misbehaved. Damping cannot fix a *discrete* oscillation:
`Vdisc` jumps by a finite amount when a SAFE changes branch, whatever the damping is on the
continuous variables. I first tried halving the relaxation (no effect on the two-cycles),
then a hard ceiling on the pool (fixed the 1e176 runaway, not the cycling), before
restructuring. The rejected alternative was enumerating all 2^n branch assignments and
solving each exactly: correct, but exponential in the number of SAFEs and a much bigger
rewrite. The evaluator + root find is ~40 lines of control flow and reuses every formula
that was already there and already tested. Decisive evidence that the rewrite is faithful:
all 44 pre-existing assertions, including the ones with hand-computed constants to 1e-12,
passed unchanged.

**Judge convergence on the price alone.** `implied(pps) = pps` means the cap table this
price produces is the cap table that produces this price — that is the whole of what
"solved" means here. The inner (pool / SAFE / anti-dilution) loop occasionally twitches at
the ninth significant figure while the price is exact to machine precision. Requiring both
flagged 6 perfectly good answers (residual ~1e-16) as unreliable in a 50,000-case sweep, so
the inner state is now reported as a `inner-loop-unsettled` warning instead of a verdict.

**Clamp the option pool target only when there is provably no answer.** Under a pre-money
pool the achievable pool percentage is bounded — the new investor's slice is fixed, so the
pool cannot exceed what is left. I first computed that bound up front and clamped eagerly;
that silently answered a different question from the one asked, and on a realistic sweep it
mis-clamped about 1% of rounds. Now the solver tries the requested pool, and only if the
search shows no root exists does it fall back to the bound and add
`pool-target-unreachable` to the warnings, which the UI renders in plain English.

**Floating-point share counts, rounded only for display.** Rounding to whole shares at every
step introduces drift that makes hand-checking impossible, and hand-checking is the only
reason to trust any of this. A registrar issues whole shares; this is a teaching model, and
it says so. The alternative — integer shares with a documented rounding rule — is the right
call for a cap table of record and the wrong one for an explorable.

**One pure engine, a thin UI.** Everything the piece claims is computed in
`src/engine/`, which imports nothing and touches no browser API. That is what makes the
terminal report, the benchmark and the tests possible, and it is why the maths can be
audited without reading a line of React.

**Anti-dilution make-whole shares are issued after the price is struck**, so the incoming
investor is diluted by them alongside the founders. Some term sheets instead fold the
adjustment into the pre-money capitalisation, so the founders alone pay. Both are real; the
engine picks one, says so in the code, and does not expose the choice. Exposing it is a
to-do, not a defect.

**The unallocated pool is cancelled at exit.** This is the normal outcome and it is a
teaching point: it is why founders receive a larger share of the proceeds than their fully
diluted percentage suggests, which the waterfall table shows side by side.

**Bundled scenarios, no network at all.** There is no dataset worth fetching here — the
piece computes everything from first principles. Three hand-written scenarios are the
fixtures, so the demo is deterministic and works offline by construction rather than by a
fallback path that might rot.

## Considered and rejected

- **Exhaustive 2^n SAFE branch enumeration** in the solver. Exact, but exponential and a
  much larger rewrite; the continuous pool reformulation removed the need.
- **Whole-share rounding.** See above. Would have cost the ability to hand-check.
- **Full ratchet anti-dilution, pay-to-play, narrow-based weighted average.** Each is
  another term to model and another switch in an interface that already has plenty. The
  broad-based weighted average is the one that is actually in most term sheets.
- **Convertible notes with interest and maturity.** Accrued interest changes the converting
  amount; the mechanism is otherwise the SAFE mechanism. Cut as duplicated teaching value.
- **Founder vesting and leaver provisions.** Enormously important in practice, invisible on
  a fully diluted cap table until someone leaves. Out of scope.
- **URL state / shareable permalinks.** The single most valuable missing feature for a
  signal piece, and the first thing on the to-do list. Cut only because correctness came
  first and the time went on the solver.
- **Animated transitions between snapshots.** Would look better in a screenshot. Would also
  have delayed the numbers being right.
- **Incremental / memoised simulation.** A full recompute of a whole scenario measures
  1.7–4.4 ms median, so there is no problem to solve yet.
- **A charting library.** Three bespoke SVG charts, none of which a general library draws
  well, against ~50 KB of dependency. Hand-rolled.

## Known limitations & honest gaps

Measured, not guessed:

- **Convergence.** On a pseudo-random sweep of 50,000 rounds within realistic ranges
  (pre-money £3m–£150m, cheque between a tenth and the whole of the pre-money, three SAFEs
  including an uncapped MFN, a prior series with anti-dilution, pool targets to 25%),
  **1 round failed to converge**. On a deliberately extreme sweep (pre-money from £2m,
  cheques to £40m, pool targets to 40%, SAFE stacks that can exceed the pre-money),
  **134 of 50,000 failed, 132 of them flagged `pool-target-unreachable`** — i.e. the input
  asked for something arithmetically impossible. Non-convergence is always reported: the
  round's panel says so and gives the residual.
- **Interaction latency.** Engine only: median 1.7–4.4 ms per full recompute, worst
  observed 7.0 ms (`npm run bench`). End-to-end in the production build, measured in the
  browser from keydown to the panel's DOM updating: option pool median 3.9 ms / worst
  4.6 ms; exit value median 4.8 ms / worst 9.3 ms; pre-money valuation median 7.9 ms but
  **p95 27.7 ms**, over the 16 ms budget. That was measured in a background tab, so some of
  it is likely scheduling and GC rather than compute, but I have not proven that and it is
  the one number here that does not meet its target.

Things I did **not** test or verify:

- No tests of any kind on the React layer. The UI is verified by having driven it: the page
  renders, the numbers match the engine report, and toggling the Series A pool timing
  produces "pool timing — the pool shuffle — founders 46.6% → 46.9% (+0.36 points)", which
  names the right mechanic. That is a walkthrough, not a test suite.
- Tested only on macOS, Node 24, Chrome, at 1440x900 and 800x748. Not Safari, not Firefox,
  not Windows, not a touch screen. `DragNumber` uses pointer events, so touch *should* work;
  I have not confirmed it.
- Accessibility: the drag controls carry `role="slider"` with `aria-valuenow`/`aria-valuetext`
  and respond to arrow keys, and the toggles are a `radiogroup`. Not tested with a screen
  reader. The colour palette has not been checked for contrast.
- The pre-money SAFE conversion convention (which securities count in Company
  Capitalization) is the one written in the solver's doc comment. It matches the 2013 YC
  safe as I read it; it has not been checked by a lawyer, and pre-money safes vary.
- MFN here means "adopt the best cap and the best discount anywhere in the stack",
  simultaneously. A real MFN clause lets the holder elect the terms of a specific later
  instrument, as a package. The simplification is favourable to the MFN holder.
- The engine has no protection against absurd inputs beyond the clamps described: negative
  valuations, zero founders and similar are not validated, they are simply not reachable
  from the UI.

## What's still to do

**(a) To demo it to a stranger**

1. Encode the scenario in the URL so a modified cap table can be sent to someone. Today a
   reload loses everything.
2. Narrow-viewport layout. It stacks to one column below ~900 px and I have only eyeballed
   it; the exit chart in particular wants a rethink at phone width.
3. A first-run cue that the numbers are draggable. The affordance is a dotted underline and
   a cursor change, which is discoverable if you already know the genre and invisible if you
   do not.
4. Chase the pre-money control's p95 latency: it is the one interaction that can miss a
   frame.

**(b) To make it real**

5. Export: the cap table and the waterfall as CSV, and the round as a one-page summary.
6. Whole-share rounding with a stated rule, behind a switch, so output can be compared with
   a real cap table tool.
7. Convertible notes: interest, maturity, and conversion at the note's own terms.
8. The other anti-dilution flavours (full ratchet, narrow-based) and pay-to-play.
9. The alternative anti-dilution timing (adjustment inside the pre-money) as a toggle, since
   the choice is worth real money and is exactly the sort of thing this piece exists to show.
10. Option strike prices, so exit proceeds to employees are net of exercise cost.
11. Tests on the UI layer, and a visual regression check on the three scenarios.

**(c) Blue sky**

12. Import a real cap table (Carta/Ledgy CSV) and run the same explanations over it.
13. Term-sheet diff mode: paste two sets of terms, see the difference in pounds at a range
    of exits rather than in adjectives.
14. A "what did that term cost" league table across a distribution of exit outcomes, so the
    argument becomes expected value rather than anecdote.

## Run log

Actual output of `./run.sh`, verbatim. The last step serves the app until interrupted; the
log below is everything up to and including the server starting.

```text

==> running the engine test suite (hand-worked examples)

 RUN  v3.2.7 /Users/euan/Desktop/claudeprojects/dilution

 ✓ src/engine/__tests__/waterfall.test.ts (14 tests) 47ms
 ✓ src/engine/__tests__/simulate.test.ts (8 tests) 35ms
 ✓ src/engine/__tests__/round.test.ts (23 tests) 283ms

 Test Files  3 passed (3)
      Tests  45 passed (45)
   Start at  21:37:17
   Duration  598ms (transform 112ms, setup 0ms, collect 163ms, tests 365ms, environment 0ms, prepare 151ms)


==> engine report: every bundled scenario, offline and deterministic
==============================================================================
SCENARIO: The good round
==============================================================================

[Incorporation]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[Pre-seed SAFE]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[First hires]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Employees (granted options)           4.44%      400,000
   Option pool (unallocated)             6.67%      600,000
   -> founders, fully diluted           88.89%

[Series A]  total shares 13,133,874
  price £1.5228/share · post-money £20.00m · pool added 576,065 · solver 10 passes, residual 8.7e-15
    SAFE Angel syndicate (SAFE): 931,034 shares @ £0.8056 (post-money, bound by cap)
   Ada (CEO)                            34.26%    4,500,000
   Ben (CTO)                            26.65%    3,500,000
   Employees (granted options)           3.05%      400,000
   Option pool (unallocated)             8.95%    1,176,065
   Angel syndicate (SAFE)                7.09%      931,034
   Series A lead                        20.00%    2,626,775
   -> founders, fully diluted           60.91%

[Scaling the team]  total shares 13,133,874
   Ada (CEO)                            34.26%    4,500,000
   Ben (CTO)                            26.65%    3,500,000
   Employees (granted options)           9.90%    1,300,000
   Option pool (unallocated)             2.10%      276,065
   Angel syndicate (SAFE)                7.09%      931,034
   Series A lead                        20.00%    2,626,775
   -> founders, fully diluted           60.91%

[Series B]  total shares 16,996,778
  price £4.1184/share · post-money £70.00m · pool added 463,549 · solver 10 passes, residual 2.2e-15
   Ada (CEO)                            26.48%    4,500,000
   Ben (CTO)                            20.59%    3,500,000
   Employees (granted options)           7.65%    1,300,000
   Option pool (unallocated)             4.35%      739,613
   Angel syndicate (SAFE)                5.48%      931,034
   Series A lead                        15.45%    2,626,775
   Series B lead                        16.14%    2,742,662
   Series A lead (pro-rata)              3.86%      656,694
   -> founders, fully diluted           47.07%
------------------------------------------------------------------------------
EXIT WATERFALL at £200.00m
   holder                                 owns       receives % of exit   treatment
   Ada (CEO)                            26.48%        £55.36m   27.68%   common
   Ben (CTO)                            20.59%        £43.06m   21.53%   common
   Employees (granted options)           7.65%        £15.99m    8.00%   common
   Option pool (unallocated)             4.35%             £0    0.00%   cancelled at exit
   Angel syndicate (SAFE)                5.48%        £11.45m    5.73%   converted to common
   Series A lead                        15.45%        £32.32m   16.16%   converted to common
   Series B lead                        16.14%        £33.74m   16.87%   converted to common
   Series A lead (pro-rata)              3.86%         £8.08m    4.04%   converted to common
   check: paid out £200.00m of £200.00m
   crossover for Angel syndicate (SAFE): £26.24m
   crossover for Series A lead: £33.58m
   crossover for Series B lead: £66.95m
   crossover for Series A lead (pro-rata): £66.95m

==============================================================================
SCENARIO: The pool-shuffle trap
==============================================================================

[Incorporation]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[Pre-seed SAFEs]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[First hires]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Employees (granted options)           4.44%      400,000
   Option pool (unallocated)             6.67%      600,000
   -> founders, fully diluted           88.89%

[Series A]  total shares 17,567,568
  price £1.1385/share · post-money £20.00m · pool added 2,513,514 · solver 15 passes, residual 5.7e-15
    SAFE Angel syndicate (SAFE): 1,081,926 shares @ £0.6932 (post-money, bound by cap)
    SAFE Micro-VC (SAFE): 1,097,973 shares @ £0.9108 (post-money, bound by discount)
    SAFE Friend with MFN (SAFE): 360,642 shares @ £0.6932 (post-money, bound by cap)
   Ada (CEO)                            25.62%    4,500,000
   Ben (CTO)                            19.92%    3,500,000
   Employees (granted options)           2.28%      400,000
   Option pool (unallocated)            17.72%    3,113,514
   Angel syndicate (SAFE)                6.16%    1,081,926
   Micro-VC (SAFE)                       6.25%    1,097,973
   Friend with MFN (SAFE)                2.05%      360,642
   Series A lead                        20.00%    3,513,514
   -> founders, fully diluted           45.54%

[Scaling the team]  total shares 17,567,568
   Ada (CEO)                            25.62%    4,500,000
   Ben (CTO)                            19.92%    3,500,000
   Employees (granted options)           7.40%    1,300,000
   Option pool (unallocated)            12.60%    2,213,514
   Angel syndicate (SAFE)                6.16%    1,081,926
   Micro-VC (SAFE)                       6.25%    1,097,973
   Friend with MFN (SAFE)                2.05%      360,642
   Series A lead                        20.00%    3,513,514
   -> founders, fully diluted           45.54%

[Series B]  total shares 21,959,459
  price £3.1877/share · post-money £70.00m · pool added 0 · solver 1 passes, residual 0.0e+0
    warnings: pool-already-above-target
   Ada (CEO)                            20.49%    4,500,000
   Ben (CTO)                            15.94%    3,500,000
   Employees (granted options)           5.92%    1,300,000
   Option pool (unallocated)            10.08%    2,213,514
   Angel syndicate (SAFE)                4.93%    1,081,926
   Micro-VC (SAFE)                       5.00%    1,097,973
   Friend with MFN (SAFE)                1.64%      360,642
   Series A lead                        16.00%    3,513,514
   Series B lead                        20.00%    4,391,892
   -> founders, fully diluted           36.43%
------------------------------------------------------------------------------
EXIT WATERFALL at £200.00m
   holder                                 owns       receives % of exit   treatment
   Ada (CEO)                            20.49%        £45.58m   22.79%   common
   Ben (CTO)                            15.94%        £35.45m   17.73%   common
   Employees (granted options)           5.92%        £13.17m    6.58%   common
   Option pool (unallocated)            10.08%             £0    0.00%   cancelled at exit
   Angel syndicate (SAFE)                4.93%        £10.96m    5.48%   converted to common
   Micro-VC (SAFE)                       5.00%        £11.12m    5.56%   converted to common
   Friend with MFN (SAFE)                1.64%         £3.65m    1.83%   converted to common
   Series A lead                        16.00%        £35.59m   17.79%   converted to common
   Series B lead                        20.00%        £44.48m   22.24%   converted to common
   check: paid out £200.00m of £200.00m
   crossover for Angel syndicate (SAFE): £26.45m
   crossover for Micro-VC (SAFE): £28.78m
   crossover for Friend with MFN (SAFE): £26.45m
   crossover for Series A lead: £31.48m
   crossover for Series B lead: £62.94m

==============================================================================
SCENARIO: The down round
==============================================================================

[Incorporation]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[Pre-seed SAFE]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Option pool (unallocated)            11.11%    1,000,000
   -> founders, fully diluted           88.89%

[First hires]  total shares 9,000,000
   Ada (CEO)                            50.00%    4,500,000
   Ben (CTO)                            38.89%    3,500,000
   Employees (granted options)           4.44%      400,000
   Option pool (unallocated)             6.67%      600,000
   -> founders, fully diluted           88.89%

[Series A]  total shares 13,133,874
  price £2.2842/share · post-money £30.00m · pool added 576,065 · solver 10 passes, residual 8.7e-15
    SAFE Angel syndicate (SAFE): 931,034 shares @ £0.8056 (post-money, bound by cap)
   Ada (CEO)                            34.26%    4,500,000
   Ben (CTO)                            26.65%    3,500,000
   Employees (granted options)           3.05%      400,000
   Option pool (unallocated)             8.95%    1,176,065
   Angel syndicate (SAFE)                7.09%      931,034
   Series A lead                        20.00%    2,626,775
   -> founders, fully diluted           60.91%

[Scaling the team]  total shares 13,133,874
   Ada (CEO)                            34.26%    4,500,000
   Ben (CTO)                            26.65%    3,500,000
   Employees (granted options)           9.90%    1,300,000
   Option pool (unallocated)             2.10%      276,065
   Angel syndicate (SAFE)                7.09%      931,034
   Series A lead                        20.00%    2,626,775
   -> founders, fully diluted           60.91%

[Series B (down)]  total shares 26,544,086
  price £1.1583/share · post-money £30.00m · pool added 2,405,548 · solver 16 passes, residual 8.4e-15
   Ada (CEO)                            16.95%    4,500,000
   Ben (CTO)                            13.19%    3,500,000
   Employees (granted options)           4.90%    1,300,000
   Option pool (unallocated)            10.10%    2,681,613
   Angel syndicate (SAFE)                3.51%      931,034
   Series A lead                        12.33%    3,271,824
   Series B lead                        39.03%   10,359,615
   -> founders, fully diluted           30.14%
------------------------------------------------------------------------------
EXIT WATERFALL at £60.00m
   holder                                 owns       receives % of exit   treatment
   Ada (CEO)                            16.95%         £9.05m   15.09%   common
   Ben (CTO)                            13.19%         £7.04m   11.73%   common
   Employees (granted options)           4.90%         £2.61m    4.36%   common
   Option pool (unallocated)            10.10%             £0    0.00%   cancelled at exit
   Angel syndicate (SAFE)                3.51%         £1.87m    3.12%   converted to common
   Series A lead                        12.33%         £6.58m   10.97%   converted to common
   Series B lead                        39.03%        £32.84m   54.73%   preference + participation
   check: paid out £60.00m of £60.00m
   crossover for Angel syndicate (SAFE): £34.59m
   crossover for Series A lead: £55.76m
   crossover for Series B lead: £82.92m


==> timing one full recompute (the 16 ms frame budget)
one full recompute of a whole scenario, 200 repeats each

  The good round         median 2.89 ms · p95 3.64 ms · worst 5.14 ms
  The pool-shuffle trap  median 4.38 ms · p95 5.24 ms · worst 7.01 ms
  The down round         median 1.74 ms · p95 2.36 ms · worst 3.06 ms

  budget for 60 fps is 16.67 ms; worst observed 7.01 ms

==> starting the explorable on http://localhost:5173  (ctrl-c to stop)

  VITE v7.3.6  ready in 108 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

## Sources & references

- Y Combinator, the safe documents and the safe user guide — the post-money safe (2018) and
  the pre-money safe (2013), including the definitions of Company Capitalization that this
  engine implements: <https://www.ycombinator.com/documents>
- NVCA model legal documents, for the broad-based weighted-average anti-dilution language
  `CP2 = CP1 * (A + B) / (A + C)`: <https://nvca.org/model-legal-documents/>
- Venture Hacks, "The Option Pool Shuffle" — the canonical statement of why a pre-money pool
  is a reduction in the effective pre-money:
  <https://venturehacks.com/articles/option-pool-shuffle>
- Fred Wilson, MBA Mondays on employee equity and dilution, for the founder-facing framing
  of the same point: <https://avc.com/>
- Setosa, "Explorable Explanations" style — the form this piece is written in:
  <https://setosa.io/>
- sha256algorithm.com — the other reference point for step-by-step, drag-anything
  explanation: <https://sha256algorithm.com/>

Numbers stated in the README and in this log (2.9 points on the pool shuffle, the
convergence rates, the latency figures) come from `npm run report`, `npm run bench` and the
sweeps in `src/engine/__tests__/round.test.ts`, all of which are reproducible offline.

---

## Audit note — 2026-08-10 (independent auditor, not the builder)

**What I ran.** `./run.sh` from the folder, plus `npm test` and `npm run build`
separately, then drove the served app in a browser.

**Result: the documented command works and the Run log above is accurate.**
45 tests passed (14 waterfall + 8 simulate + 23 round), the engine report reproduces
the committed output line for line for all three scenarios, and the bench came in at
median 2.91 / 4.68 / 1.83 ms with worst 9.69 ms against the 16.67 ms budget. `npm run
build` type-checks and builds clean. Everything is offline; no network call, no key,
no hardcoded secret. The "not investment, financial, tax or legal advice" disclaimer
is in the README, in the in-app "what this model does and does not do" list, and in
the footer.

**The headline claim was verified interactively, and it holds.** Loading "The
pool-shuffle trap" and flipping the Series A pool-timing toggle from pre-money to
post-money moves the Series A lead from 20.0% to 17.2% and the founders from 45.5%
to 48.4% (+2.9 points), exactly as the README says. The app also names the mechanic
("pool timing — the pool shuffle").

**One overstatement in the README, worth tightening.** The down-round summary says
the founders "own a third of the company and receive much less than a third of the
money". The engine's own report gives founders 30.14% fully diluted and 26.82% of a
£60m exit (Ada 15.09% + Ben 11.73%). That is less, by 3.3 points, but "much less"
outruns the number. The mechanic being illustrated is real and the figures in the
report are right; only the prose around them is stronger than the arithmetic.

**Nothing changed in the project.** No code or README was modified.
