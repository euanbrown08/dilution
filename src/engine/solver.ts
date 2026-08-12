/**
 * The priced-round solver.
 *
 * A priced round is genuinely circular. The price per share depends on the
 * fully diluted pre-money share count; that count depends on the new option
 * pool; the pool is sized as a percentage of the POST-money count, which
 * depends on how many shares the new money buys, which depends on the price.
 * SAFEs make it worse: their conversion price depends on the round price
 * (discount branch) or on the pool (cap branch), and their shares sit inside
 * the pre-money count.
 *
 * Naive fixed-point iteration on the price DIVERGES whenever the SAFEs bind on
 * their discount: shares = amount / (pps * (1 - d)), so a lower guessed price
 * creates more shares, which lowers the price again. The trick that kills the
 * runaway is to notice that a discount-bound SAFE contributes a fixed amount of
 * VALUE at the round price rather than a fixed number of shares:
 *
 *     pps * shares_j  =  amount_j / (1 - d_j)   ... independent of pps
 *
 * so, writing Vdisc for the sum of those amounts and G for every other share in
 * the pre-money count,
 *
 *     preMoney = pps * (G + P) + Vdisc     =>     pps = (preMoney - Vdisc)/(G + P)
 *
 * and the option pool has a closed form too (derived inline below). What is
 * left to iterate is only which branch each SAFE binds on, the cap-bound share
 * counts, and the anti-dilution shares — a well-conditioned little problem that
 * settles in a handful of passes. We report the residual rather than assume it.
 */

import type {
  CapState,
  PreferredPosition,
  PricedRoundEvent,
  RoundSolution,
  SafeConversion,
  SafeTerms,
} from './types';

const MAX_ITERS = 200;
/** Passes of the inner (pool / SAFE shares / anti-dilution) loop at a fixed price. */
const MAX_INNER = 100;
/**
 * Stopping tolerance for that inner loop, relative to the share count. Tighter
 * than this and the last few ulps of floating point noise in a nine-figure
 * share count stop it from ever declaring itself finished.
 */
const INNER_TOL = 1e-12;
/** Looser bar for calling the inner loop good enough to trust. */
const SETTLED_TOL = 1e-9;
const TOL = 1e-14;
/**
 * The largest fraction of the post-round table we will let an option pool take
 * before we clamp and flag. Purely a numerical guard: the pre-money pool
 * formula has a pole at p = pMax, and asking for anything near it produces a
 * pool of essentially infinite shares at essentially zero price. No real
 * financing creates a pool worth 90 % of the company.
 */
const POOL_CEILING = 0.9;
/**
 * Absolute ceiling on the option pool increase, as a multiple of the pre-round
 * share block (common + prior preferred + existing pool). Twenty times that
 * block is far beyond any real financing; it exists only to break the runaway
 * described at the clamp site below.
 */
const POOL_MAX_MULTIPLE = 20;

export function commonShares(state: CapState): number {
  return state.founders.reduce((a, f) => a + f.shares, 0);
}

/** Fully diluted share count of the current state, ignoring open SAFEs. */
export function fullyDiluted(state: CapState): number {
  return (
    commonShares(state) +
    state.optionsAllocated +
    state.poolUnallocated +
    state.preferred.reduce((a, p) => a + p.shares, 0)
  );
}

/** Apply MFN: a SAFE marked mfn adopts the best cap and best discount in the stack. */
export function applyMfn(safes: SafeTerms[]): SafeTerms[] {
  const caps = safes.map((s) => s.cap).filter((c): c is number => typeof c === 'number');
  const discs = safes.map((s) => s.discount).filter((d): d is number => typeof d === 'number');
  const bestCap = caps.length ? Math.min(...caps) : undefined;
  const bestDisc = discs.length ? Math.max(...discs) : undefined;
  return safes.map((s) => {
    if (!s.mfn) return s;
    const cap = bestCap === undefined ? s.cap : s.cap === undefined ? bestCap : Math.min(s.cap, bestCap);
    const discount =
      bestDisc === undefined ? s.discount : s.discount === undefined ? bestDisc : Math.max(s.discount, bestDisc);
    return { ...s, cap, discount };
  });
}

/** Everything a candidate round price implies. See evaluateAtPrice below. */
interface Evaluation {
  /** The price the resulting cap table implies. A solution has implied === x. */
  implied: number;
  pool: number;
  work: SafeWork[];
  ad: Record<string, number>;
  clampHigh: boolean;
  clampLow: boolean;
  overhang: boolean;
  /** The inner (pool / SAFE / anti-dilution) fixed point actually settled. */
  settled: boolean;
}

interface SafeWork {
  terms: SafeTerms;
  shares: number;
  price: number;
  /** 'cap' = bound by the valuation cap; otherwise bound by the round price. */
  capBound: boolean;
  mechanism: 'cap' | 'discount' | 'round-price';
}

/**
 * Solve one priced round.
 *
 * Conventions, stated explicitly because every cap table tool picks one and
 * most never tell you which:
 *
 * - `targetPoolPct` is the TOTAL pool (granted options + unallocated reserve)
 *   as a fraction of the post-round fully diluted count.
 * - Pre-money SAFE "Company Capitalization" = common + prior preferred +
 *   anti-dilution shares + the whole option pool INCLUDING the increase agreed
 *   in this round, and EXCLUDING all converting securities.
 * - Post-money SAFE "Company Capitalization" follows the 2018 YC definition: it
 *   includes issued and outstanding shares, ALL converting securities (so other
 *   SAFEs and notes), issued and promised options, and the EXISTING unissued
 *   option pool — but EXCLUDES the pool increase made in connection with this
 *   financing. That exclusion is the point of the post-money safe: the holder's
 *   percentage cannot be eroded by other SAFEs or by the pool top-up. The
 *   founders absorb both.
 * - Anti-dilution is broad-based weighted average, applied to prior series that
 *   opted in, and only when the new price is below their conversion price. The
 *   round price is struck on the pre-money capitalisation using the OLD
 *   conversion ratios and the adjustment applied afterwards, so the make-whole
 *   shares dilute the incoming investor too. Some term sheets instead put the
 *   adjustment inside the pre-money so founders alone pay for it.
 */
export function solveRound(state: CapState, ev: PricedRoundEvent): RoundSolution {
  const common = commonShares(state);
  const priorPrefShares = state.preferred.reduce((a, p) => a + p.shares, 0);
  const poolExisting = state.optionsAllocated + state.poolUnallocated;
  const fixedBase = common + priorPrefShares + poolExisting;
  const p = ev.targetPoolPct;
  const warnings: string[] = [];

  const protectedSeries: PreferredPosition[] =
    ev.antiDilution === 'broad-based' ? state.preferred.filter((s) => s.antiDilutionProtected) : [];

  const terms = applyMfn(state.openSafes);

  // Reachability of the option pool target.
  //
  // As the candidate price x falls, the pool needed to hit a fixed percentage
  // of the post-round table grows like 1/x, and the price that cap table
  // implies falls with it. At a vanishing price every SAFE is bound by its
  // discount, so the small-x behaviour is governed by constants, and the two
  // curves only meet near zero if
  //     pEff  <  netPre0 / (netPre0 + Vdisc0 + investment)  =  1 / mLimit.
  // Above that there may still be a solution further up the price range, so we
  // do NOT clamp on the strength of this alone: we try the requested pool
  // first, and only fall back to pMax when the search shows there is no
  // solution to be had. Clamping eagerly would silently answer a different
  // question from the one the user asked.
  const allDiscountValue = terms.reduce((a, t) => a + t.amount / (1 - (t.discount ?? 0)), 0);
  const netPreFloor = Math.max(ev.preMoney * 0.001, ev.preMoney - allDiscountValue);
  const mLimit = (ev.preMoney + ev.investment) / netPreFloor;
  const pMax = ev.poolTiming === 'pre-money' ? Math.min(POOL_CEILING, POOL_CEILING / mLimit) : POOL_CEILING;
  /** The pool fraction actually used; lowered to pMax only as a last resort. */
  let pEff = p;
  let poolUnreachable = false;

  const priceCeiling = Math.max(1e-12, ev.preMoney) / Math.max(1, fixedBase);

  /**
   * Everything downstream of a candidate round price x: what each SAFE converts
   * into, how big the option pool has to be, how many make-whole shares the
   * protected series get — and, from all of that, the price the resulting cap
   * table actually implies.
   *
   * Holding x fixed removes the circularity in the price itself and leaves a
   * small, well-behaved fixed point in (pool, SAFE shares, anti-dilution
   * shares). Solving the round is then a one-dimensional root find on
   * implied(x) - x, which is what the caller below does.
   */
  function evaluateAtPrice(x: number): Evaluation {
    const work: SafeWork[] = terms.map((t) => ({
      terms: t,
      shares: 0,
      price: 0,
      capBound: false,
      mechanism: 'round-price',
    }));
    const ad: Record<string, number> = {};
    for (const s of protectedSeries) ad[s.id] = 0;

    let pool = 0;
    let clampHigh = false;
    let clampLow = false;
    let overhang = false;
    let settled = false;
    let G = fixedBase;
    let netPre = ev.preMoney;

    for (let k = 0; k < MAX_INNER; k++) {
      const adTotal = Object.values(ad).reduce((a, b) => a + b, 0);
      const prevSafeShares = work.map((w) => w.shares);

      // --- 1. price every SAFE at x ------------------------------------
      // Pre-money safe Company Capitalization: whole option pool including the
      // increase agreed in this round, converting securities excluded.
      const ccPre = common + priorPrefShares + adTotal + poolExisting + pool;
      let preMoneySafeShares = 0;
      for (const w of work) {
        if (w.terms.type !== 'pre-money') continue;
        const capPrice = w.terms.cap !== undefined ? w.terms.cap / ccPre : Infinity;
        const pricePrice = x * (1 - (w.terms.discount ?? 0));
        const price = Math.min(capPrice, pricePrice);
        w.shares = w.terms.amount / price;
        w.price = price;
        w.capBound = capPrice < pricePrice;
        w.mechanism = w.capBound ? 'cap' : w.terms.discount ? 'discount' : 'round-price';
        preMoneySafeShares += w.shares;
      }

      // Post-money safes. Those binding on their cap share a closed form:
      //   CC = B / (1 - sum(amount_i / cap_i))
      // where B is everything that is NOT a cap-bound post-money SAFE, i.e.
      // outstanding shares + existing pool (not the increase) + all other
      // converting securities.
      const postSafes = work.filter((w) => w.terms.type === 'post-money');
      for (let inner = 0; inner < 12; inner++) {
        const priceBoundShares = postSafes
          .filter((w) => !w.capBound)
          .reduce((a, w) => a + w.terms.amount / (x * (1 - (w.terms.discount ?? 0))), 0);
        const B = common + priorPrefShares + adTotal + poolExisting + preMoneySafeShares + priceBoundShares;
        let fSum = postSafes
          .filter((w) => w.capBound)
          .reduce((a, w) => a + (w.terms.cap !== undefined ? w.terms.amount / w.terms.cap : 0), 0);
        // Post-money safes claim amount/cap of the company each. If those add up
        // to 100 % or more there is nothing left for anybody and CC is infinite,
        // which poisons every number downstream with NaN. Clamp and flag.
        if (fSum >= 0.999) {
          fSum = 0.999;
          overhang = true;
        }
        const CC = B / (1 - fSum);
        let changed = false;
        for (const w of postSafes) {
          const capShares = w.terms.cap !== undefined ? (w.terms.amount / w.terms.cap) * CC : -Infinity;
          const priceShares = w.terms.amount / (x * (1 - (w.terms.discount ?? 0)));
          const nowCap = capShares > priceShares;
          if (nowCap !== w.capBound) changed = true;
          w.capBound = nowCap;
          w.shares = nowCap ? capShares : priceShares;
          w.price = w.terms.amount / w.shares;
          w.mechanism = nowCap ? 'cap' : w.terms.discount ? 'discount' : 'round-price';
        }
        if (!changed) break;
      }

      // --- 2. split the SAFEs by the branch they bound on ---------------
      let Vdisc = 0; // money claimed by price-bound SAFEs, at the round price
      let Scap = 0; // shares held by cap-bound SAFEs
      for (const w of work) {
        if (w.capBound) Scap += w.shares;
        else Vdisc += w.terms.amount / (1 - (w.terms.discount ?? 0));
      }
      if (Vdisc >= ev.preMoney * 0.999) {
        // The discounted SAFEs alone claim the whole pre-money. Degenerate; the
        // round cannot really be priced. Clamp so the UI stays usable, and say so.
        Vdisc = ev.preMoney * 0.999;
        overhang = true;
      }
      G = fixedBase + Scap;
      netPre = ev.preMoney - Vdisc;

      // --- 3. option pool, in closed form -------------------------------
      // The post-round fully diluted count, written so that it does not care
      // how a SAFE was classified:
      //
      //   T = G + P + (Vdisc + investment)/x + ad
      //
      // because a price-bound SAFE holds exactly Vdisc/x shares. The target is
      //   P = pEff*T - E
      // so
      //   P (1 - pEff) = pEff*(G + (Vdisc + I)/x + ad) - E.
      //
      // Writing it this way matters. G jumps when a SAFE crosses from its
      // discount to its cap, and Vdisc/x jumps by exactly the same amount the
      // other way, so the bracket — and therefore the pool — is CONTINUOUS
      // across that boundary. The older form, P = (p m G + p ad - E)/(1 - p m),
      // is not: it amplified the jump in G and could open a gap that straddled
      // the solution, leaving the round with no self-consistent price at all.
      // At a solution the two forms are identical.
      //
      // Under pre-money timing the pool sits inside the pre-money share count
      // and so drags the price down; under post-money timing it does not touch
      // the price at all. That is the only difference between the two timings.
      clampHigh = poolUnreachable;
      let rawPool =
        (pEff * (G + (Vdisc + ev.investment) / x + adTotal) - poolExisting) / (1 - pEff);
      // Hard ceiling on the pool, in shares, measured against a block that does
      // NOT move inside this loop. Without it a cap-bound PRE-money SAFE and a
      // clamped pre-money pool feed each other without limit: a bigger pool
      // raises the SAFE's Company Capitalization, which issues it more shares,
      // which enlarges the pre-money block, which enlarges the pool. That system
      // has no positive fixed point, and unclamped it runs off to 1e176 shares.
      const poolCeiling = POOL_MAX_MULTIPLE * fixedBase;
      if (rawPool > poolCeiling) {
        rawPool = poolCeiling;
        clampHigh = true;
      }
      // A negative "increase" would mean cancelling shares out of an existing
      // pool. That is not a thing a financing does, so we hold the pool where
      // it is, land ABOVE the requested percentage, and say so.
      clampLow = rawPool < 0;
      const nextPool = Math.max(0, rawPool);

      // --- 4. broad-based weighted average anti-dilution -----------------
      // CP2 = CP1 * (A + B) / (A + C)
      //   A = fully diluted immediately before the new issue, old ratios
      //   B = new money / CP1  (shares the money would have bought at CP1)
      //   C = shares actually issued for the new money
      const denomForPrice = ev.poolTiming === 'pre-money' ? G + nextPool : G;
      const newShares = ev.investment / x;
      let adMove = 0;
      for (const s of protectedSeries) {
        let next = 0;
        if (x < s.conversionPrice) {
          const cp2 =
            s.conversionPrice *
            ((denomForPrice + ev.investment / s.conversionPrice) / (denomForPrice + newShares));
          next = s.shares * (s.conversionPrice / cp2 - 1);
        }
        adMove = Math.max(adMove, Math.abs(next - (ad[s.id] ?? 0)));
        ad[s.id] = next;
      }

      const poolMove = Math.abs(nextPool - pool);
      pool = nextPool;
      // Stability is measured on the numbers, not on the labels. A SAFE sitting
      // exactly on the boundary between its cap and its discount can keep
      // swapping which branch it is nominally on while its share count does not
      // move at all; that is settled, and treating it as unsettled would report
      // a perfectly good answer as unreliable.
      let safeMove = 0;
      work.forEach((w, i) => {
        safeMove = Math.max(safeMove, Math.abs(w.shares - prevSafeShares[i]));
      });
      const scale = Math.max(1, denomForPrice);
      const move = Math.max(poolMove, adMove, safeMove) / scale;
      // Two thresholds on purpose: stop early once the state is genuinely still,
      // but still call it settled if it merely got small — the outer residual on
      // the price is the real measure of the answer's quality.
      settled = k > 0 && move < SETTLED_TOL;
      if (k > 0 && move < INNER_TOL) break;
    }

    const implied = ev.poolTiming === 'pre-money' ? netPre / (G + pool) : netPre / G;
    return { implied, pool, work, ad, clampHigh, clampLow, overhang, settled };
  }

  // --- solve for the price ----------------------------------------------
  // A solution is a price x with implied(x) = x. Two ways of finding one:
  //
  //  1. Fast path — iterate x <- implied(x). For anything resembling a real
  //     financing this lands in a handful of passes.
  //  2. Bisection — the fast path can settle into a two-cycle when a SAFE sits
  //     near the boundary between its cap and its discount: each branch implies
  //     the price that makes the other branch look right. Bisection does not
  //     care. implied(x) - x is positive at a vanishing price (there every SAFE
  //     claims a fixed amount of MONEY rather than a fixed number of shares, so
  //     the implied price is bounded away from zero) and is <= 0 at the ceiling
  //     preMoney/fixedBase, which is the price with no SAFEs and no new pool.
  //     Given that bracket, a root exists and bisection finds it.
  let iters = 0;
  let pps = priceCeiling;
  let e = evaluateAtPrice(pps);
  let residual = Infinity;

  const solveOnce = (): void => {
    pps = priceCeiling;
    e = evaluateAtPrice(pps);
    iters++;
    residual = Math.abs(e.implied - pps) / Math.max(1e-300, pps);
    let n = 0;
    while (n < MAX_ITERS && residual > TOL && Number.isFinite(e.implied) && e.implied > 0) {
      pps = e.implied;
      e = evaluateAtPrice(pps);
      residual = Math.abs(e.implied - pps) / Math.max(1e-300, pps);
      iters++;
      n++;
    }
    if (residual < 1e-11 && pps > 0 && Number.isFinite(pps)) return;

    let lo = priceCeiling * 1e-14;
    let hi = priceCeiling;
    for (let i = 0; i < 200 && hi - lo > hi * 1e-15; i++) {
      const mid = 0.5 * (lo + hi);
      const em = evaluateAtPrice(mid);
      iters++;
      if (em.implied > mid) lo = mid;
      else hi = mid;
    }
    pps = 0.5 * (lo + hi);
    e = evaluateAtPrice(pps);
    residual = Math.abs(e.implied - pps) / Math.max(1e-300, pps);
  };

  solveOnce();

  if (!(residual < 1e-11 && pps > 0 && Number.isFinite(pps)) && p > 0) {
    // No consistent price at the requested pool. Check the bracket: if the
    // implied price is already below the candidate at a vanishing price, the
    // pool percentage cannot be reached at any price, so fall back to the
    // largest pool that can be — and say so, loudly, in `warnings`.
    const probe = priceCeiling * 1e-14;
    if (evaluateAtPrice(probe).implied <= probe && p > pMax) {
      pEff = pMax;
      poolUnreachable = true;
      solveOnce();
    }
  }

  const work = e.work;
  const adShares = e.ad;
  const poolIncrease = e.pool;
  // Convergence is judged on the price and the price alone: implied(pps) = pps
  // means the cap table this price produces is the cap table that produces this
  // price. The inner loop occasionally keeps twitching at the ninth significant
  // figure while the price is exact to machine precision — worth noting, not
  // worth calling the answer unreliable.
  const converged = residual < 1e-11 && Number.isFinite(pps) && pps > 0;
  if (!e.settled) warnings.push('inner-loop-unsettled');
  if (e.overhang) warnings.push('safe-overhang');
  if (e.clampHigh) warnings.push('pool-target-unreachable');
  if (e.clampLow) warnings.push('pool-already-above-target');

  const adTotal = Object.values(adShares).reduce((a, b) => a + b, 0);
  const safeTotal = work.reduce((a, w) => a + w.shares, 0);
  const baseNoPool = fixedBase + safeTotal;
  const preMoneyFD = ev.poolTiming === 'pre-money' ? baseNoPool + poolIncrease : baseNoPool;
  const newMoneyShares = ev.investment / pps;
  const postFD = baseNoPool + poolIncrease + newMoneyShares + adTotal;

  // --- pro-rata allocation of the round --------------------------------
  // The price is identical for everyone, so pro-rata does not change the
  // dilution maths at all: it only decides WHO buys the new shares. Existing
  // holders who exercise take a slice sized by their pre-round fully diluted
  // ownership; the new lead takes the rest.
  const allocations: RoundSolution['allocations'] = [];
  let claimed = 0;
  for (const id of ev.proRataHolderIds ?? []) {
    const pos = state.preferred.find((x) => x.id === id);
    if (!pos) continue;
    const ownership = (pos.shares + (adShares[id] ?? 0)) / preMoneyFD;
    const amount = Math.min(ev.investment - claimed, ownership * ev.investment);
    if (amount <= 0) continue;
    claimed += amount;
    allocations.push({ holderId: id, name: pos.name, amount, shares: amount / pps, isNew: false });
  }
  const leadAmount = Math.max(0, ev.investment - claimed);
  allocations.unshift({
    holderId: `${ev.id}-lead`,
    name: `${ev.series} lead`,
    amount: leadAmount,
    shares: leadAmount / pps,
    isNew: true,
  });

  const safeConversions: SafeConversion[] = work.map((w) => ({
    safeId: w.terms.id,
    name: w.terms.name,
    amount: w.terms.amount,
    shares: w.shares,
    pricePerShare: w.price,
    mechanism: w.mechanism,
    type: w.terms.type,
    effectiveValuation: w.price * preMoneyFD,
  }));

  return {
    pps,
    newMoneyShares,
    poolIncrease,
    safeConversions,
    antiDilutionShares: adShares,
    preMoneyFD,
    postFD,
    iterations: iters,
    residual,
    converged,
    poolTargetClamped: e.clampHigh || e.clampLow,
    warnings,
    allocations,
  };
}
