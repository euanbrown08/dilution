/**
 * Exit waterfall.
 *
 * At an exit value E, who actually gets what?
 *
 * 1. Preferred stock is paid its liquidation preference first, most senior
 *    series first, until the money runs out.
 * 2. Non-participating preferred may instead CONVERT to common and take its
 *    as-converted share of everything. A rational holder picks whichever is
 *    larger — so the choice of one class changes the residual for the others,
 *    which changes their choice. We solve that by fixed point over the set of
 *    converting classes.
 * 3. Participating preferred takes its preference AND its as-converted share of
 *    the residual, optionally capped at a multiple of money invested. A holder
 *    at its cap will convert instead once as-converted beats the cap.
 *
 * Simplifications, stated plainly:
 * - The UNALLOCATED option pool is cancelled at exit and does not receive
 *   proceeds. This is the normal outcome and it is a teaching point.
 * - GRANTED options are treated as fully vested and exercised at a zero strike
 *   price. Real strikes reduce option-holder proceeds slightly and add exercise
 *   cash to the pot. Not modelled — see LOG.md.
 * - No transaction costs, escrow, management carve-out, or debt.
 */

import type { CapState } from './types';

export interface WaterfallLine {
  id: string;
  name: string;
  group: string;
  /** Cash out at this exit value. */
  proceeds: number;
  /** Fully diluted ownership, for the "your % is not your payout" contrast. */
  pctOwned: number;
  pctProceeds: number;
  invested: number;
  /** 'preference' | 'converted' | 'common' | 'participating' */
  treatment: string;
}

export interface WaterfallResult {
  exitValue: number;
  lines: WaterfallLine[];
  convertedSeries: string[];
  /** Total paid out as liquidation preference before any residual sharing. */
  preferenceTotal: number;
  residual: number;
}

interface Klass {
  id: string;
  name: string;
  shares: number;
  invested: number;
  multiple: number;
  participating: boolean;
  cap?: number;
  seniority: number;
}

export function waterfall(state: CapState, exitValue: number): WaterfallResult {
  const classes: Klass[] = state.preferred.map((p) => ({
    id: p.id,
    name: p.name,
    shares: p.shares,
    invested: p.invested,
    multiple: p.multiple,
    participating: p.participating,
    cap: p.participationCap,
    seniority: p.seniority,
  }));

  const commonHolders = [
    ...state.founders.map((f) => ({ id: f.id, name: f.name, shares: f.shares, group: 'Founders' })),
    ...(state.optionsAllocated > 0
      ? [{ id: 'employees', name: 'Employees (granted options)', shares: state.optionsAllocated, group: 'Employees' }]
      : []),
  ];
  const commonShares = commonHolders.reduce((a, h) => a + h.shares, 0);

  const evaluate = (converted: Set<string>) => {
    // 1. preferences, senior first
    const ordered = [...classes].sort((a, b) => b.seniority - a.seniority);
    let remaining = exitValue;
    const pref: Record<string, number> = {};
    for (const c of ordered) {
      if (converted.has(c.id)) {
        pref[c.id] = 0;
        continue;
      }
      const want = c.multiple * c.invested;
      const pay = Math.min(remaining, want);
      pref[c.id] = pay;
      remaining -= pay;
    }
    const preferenceTotal = exitValue - remaining;

    // 2. residual, shared by common + converted preferred + participating preferred
    const participation: Record<string, number> = {};
    const cappedOut = new Set<string>();
    let residual = remaining;
    let base =
      commonShares +
      classes
        .filter((c) => converted.has(c.id) || (c.participating && !converted.has(c.id)))
        .reduce((a, c) => a + c.shares, 0);

    for (let i = 0; i < classes.length + 1; i++) {
      const rps = base > 0 ? residual / base : 0;
      let changed = false;
      for (const c of classes) {
        if (converted.has(c.id) || !c.participating || cappedOut.has(c.id) || c.cap === undefined) continue;
        const total = pref[c.id] + c.shares * rps;
        if (total > c.cap * c.invested + 1e-9) {
          const allowed = Math.max(0, c.cap * c.invested - pref[c.id]);
          participation[c.id] = allowed;
          cappedOut.add(c.id);
          residual -= allowed;
          base -= c.shares;
          changed = true;
        }
      }
      if (!changed) break;
    }

    const rps = base > 0 ? residual / base : 0;
    const proceeds: Record<string, number> = {};
    for (const h of commonHolders) proceeds[h.id] = h.shares * rps;
    for (const c of classes) {
      if (converted.has(c.id)) proceeds[c.id] = c.shares * rps;
      else if (c.participating) proceeds[c.id] = pref[c.id] + (cappedOut.has(c.id) ? participation[c.id] : c.shares * rps);
      else proceeds[c.id] = pref[c.id];
    }
    return { proceeds, pref, rps, preferenceTotal, residual: remaining };
  };

  // fixed point over the converting set
  let converted = new Set<string>();
  let result = evaluate(converted);
  for (let iter = 0; iter < classes.length + 3; iter++) {
    const next = new Set<string>();
    for (const c of classes) {
      // what would this class get if it converted, holding everyone else fixed?
      const trial = new Set(converted);
      trial.add(c.id);
      const withConv = evaluate(trial);
      const without = new Set(converted);
      without.delete(c.id);
      const withoutConv = evaluate(without);
      if (withConv.proceeds[c.id] > withoutConv.proceeds[c.id] + 1e-9) next.add(c.id);
    }
    const same = next.size === converted.size && [...next].every((x) => converted.has(x));
    converted = next;
    result = evaluate(converted);
    if (same) break;
  }

  const totalFD =
    commonShares + state.poolUnallocated + classes.reduce((a, c) => a + c.shares, 0);

  const lines: WaterfallLine[] = [];
  for (const h of commonHolders) {
    lines.push({
      id: h.id,
      name: h.name,
      group: h.group,
      proceeds: result.proceeds[h.id] ?? 0,
      pctOwned: totalFD ? h.shares / totalFD : 0,
      pctProceeds: exitValue ? (result.proceeds[h.id] ?? 0) / exitValue : 0,
      invested: 0,
      treatment: 'common',
    });
  }
  if (state.poolUnallocated > 0) {
    lines.push({
      id: 'pool',
      name: 'Option pool (unallocated)',
      group: 'Option pool',
      proceeds: 0,
      pctOwned: totalFD ? state.poolUnallocated / totalFD : 0,
      pctProceeds: 0,
      invested: 0,
      treatment: 'cancelled at exit',
    });
  }
  for (const c of classes) {
    const src = state.preferred.find((p) => p.id === c.id)!;
    lines.push({
      id: c.id,
      name: c.name,
      group: src.fromSafe ? 'SAFE investors' : 'Investors',
      proceeds: result.proceeds[c.id] ?? 0,
      pctOwned: totalFD ? c.shares / totalFD : 0,
      pctProceeds: exitValue ? (result.proceeds[c.id] ?? 0) / exitValue : 0,
      invested: c.invested,
      treatment: converted.has(c.id) ? 'converted to common' : c.participating ? 'preference + participation' : 'took preference',
    });
  }

  return {
    exitValue,
    lines,
    convertedSeries: [...converted],
    preferenceTotal: result.preferenceTotal,
    residual: result.residual,
  };
}

/**
 * The crossover: the smallest exit value at which a given preferred class does
 * better converting to common than taking its liquidation preference. Below it,
 * the investor takes the money and the founders' percentage is worth much less
 * than they think. Found by bisection on the waterfall itself, so it respects
 * seniority, participation and caps rather than assuming a tidy formula.
 */
export function crossoverFor(state: CapState, classId: string, maxExit = 1e12): number | null {
  const converts = (E: number) => waterfall(state, E).convertedSeries.includes(classId);
  if (!converts(maxExit)) return null;
  let lo = 0;
  let hi = maxExit;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (converts(mid)) hi = mid;
    else lo = mid;
    if (hi - lo < Math.max(1, hi * 1e-12)) break;
  }
  return hi;
}

/** Sample the waterfall across a range of exit values, for the area chart. */
export function waterfallCurve(
  state: CapState,
  maxExit: number,
  samples = 121,
  minExit = 0,
): { exit: number; byId: Record<string, number> }[] {
  const out: { exit: number; byId: Record<string, number> }[] = [];
  for (let i = 0; i < samples; i++) {
    const E = minExit + ((maxExit - minExit) * i) / (samples - 1);
    const w = waterfall(state, E);
    const byId: Record<string, number> = {};
    for (const l of w.lines) byId[l.id] = l.proceeds;
    out.push({ exit: E, byId });
  }
  return out;
}
