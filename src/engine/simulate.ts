/**
 * Walk a scenario's events and produce a snapshot after each one.
 * Pure: same scenario in, same snapshots out.
 */

import { solveRound, commonShares, fullyDiluted } from './solver';
import type {
  CapRow,
  CapState,
  PreferredPosition,
  Scenario,
  ScenarioEvent,
  SimResult,
  Snapshot,
} from './types';

function emptyState(): CapState {
  return {
    founders: [],
    optionsAllocated: 0,
    poolUnallocated: 0,
    preferred: [],
    openSafes: [],
    investedByHolder: {},
  };
}

function cloneState(s: CapState): CapState {
  return {
    founders: s.founders.map((f) => ({ ...f })),
    optionsAllocated: s.optionsAllocated,
    poolUnallocated: s.poolUnallocated,
    preferred: s.preferred.map((p) => ({ ...p })),
    openSafes: s.openSafes.map((x) => ({ ...x })),
    investedByHolder: { ...s.investedByHolder },
  };
}

export function capRows(state: CapState): { rows: CapRow[]; total: number } {
  const total = fullyDiluted(state);
  const rows: CapRow[] = [];
  for (const f of state.founders) {
    rows.push({
      id: f.id,
      name: f.name,
      group: 'Founders',
      shares: f.shares,
      pct: total ? f.shares / total : 0,
      invested: 0,
      security: 'Common',
    });
  }
  if (state.optionsAllocated > 0) {
    rows.push({
      id: 'employees',
      name: 'Employees (granted options)',
      group: 'Employees',
      shares: state.optionsAllocated,
      pct: total ? state.optionsAllocated / total : 0,
      invested: 0,
      security: 'Options — granted',
    });
  }
  if (state.poolUnallocated > 0) {
    rows.push({
      id: 'pool',
      name: 'Option pool (unallocated)',
      group: 'Option pool',
      shares: state.poolUnallocated,
      pct: total ? state.poolUnallocated / total : 0,
      invested: 0,
      security: 'Options — reserved',
    });
  }
  for (const p of state.preferred) {
    rows.push({
      id: p.id,
      name: p.name,
      group: p.fromSafe ? 'SAFE investors' : 'Investors',
      shares: p.shares,
      pct: total ? p.shares / total : 0,
      invested: p.invested,
      security: `${p.series} preferred — ${p.multiple}x ${p.participating ? 'participating' : 'non-participating'}`,
    });
  }
  return { rows, total };
}

function founderPct(state: CapState): number {
  const total = fullyDiluted(state);
  return total ? commonShares(state) / total : 0;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function money(n: number, cur: string): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${cur}${(n / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `${cur}${(n / 1e6).toFixed(2)}m`;
  if (abs >= 1e3) return `${cur}${(n / 1e3).toFixed(0)}k`;
  return `${cur}${n.toFixed(0)}`;
}

function applyEvent(
  prev: CapState,
  ev: ScenarioEvent,
  currency: string,
): { state: CapState; snapshot: Omit<Snapshot, 'rows' | 'totalShares' | 'founderPct' | 'state'> } {
  const state = cloneState(prev);

  if (ev.kind === 'founding') {
    state.founders = ev.founders.map((f) => ({ ...f }));
    state.poolUnallocated = ev.poolShares;
    const total = fullyDiluted(state);
    return {
      state,
      snapshot: {
        eventId: ev.id,
        label: ev.label,
        postMoney: null,
        pps: null,
        solution: null,
        explanation:
          ev.poolShares > 0
            ? `Company formed with ${ev.founders.length} founders and a ${pct(ev.poolShares / total)} unallocated option pool. Nothing has diluted yet — the pool is already carved out of the founders' 100%.`
            : `Company formed. Founders hold 100% of a ${total.toLocaleString('en-GB')} share company.`,
      },
    };
  }

  if (ev.kind === 'grant') {
    const granted = Math.min(ev.shares, state.poolUnallocated);
    state.poolUnallocated -= granted;
    state.optionsAllocated += granted;
    return {
      state,
      snapshot: {
        eventId: ev.id,
        label: ev.label,
        postMoney: null,
        pps: null,
        solution: null,
        explanation: `${granted.toLocaleString('en-GB')} options granted to employees. This moves shares from the reserved pool to real people — it does NOT change anyone's fully diluted percentage, because the pool was already counted.`,
      },
    };
  }

  if (ev.kind === 'safe') {
    state.openSafes = [...state.openSafes, ...ev.safes.map((s) => ({ ...s }))];
    const total = ev.safes.reduce((a, s) => a + s.amount, 0);
    const post = ev.safes.filter((s) => s.type === 'post-money');
    const impliedNow = post.reduce((a, s) => a + (s.cap ? s.amount / s.cap : 0), 0);
    return {
      state,
      snapshot: {
        eventId: ev.id,
        label: ev.label,
        postMoney: null,
        pps: null,
        solution: null,
        explanation:
          `${money(total, currency)} raised on ${ev.safes.length} SAFE${ev.safes.length > 1 ? 's' : ''}. No shares issue yet, so the cap table above is unchanged — ` +
          (impliedNow > 0
            ? `but the post-money SAFEs have already locked in ${pct(impliedNow)} of the company. That dilution is real; it is just deferred to the priced round.`
            : `the dilution lands at the priced round.`),
      },
    };
  }

  // --- priced round ---------------------------------------------------
  const sol = solveRound(state, ev);
  const prevFounder = founderPct(prev);

  // anti-dilution: extra common to protected prior series
  for (const p of state.preferred) {
    const extra = sol.antiDilutionShares[p.id] ?? 0;
    if (extra > 0) p.shares += extra;
  }

  // SAFEs convert into their own shadow series with 1x non-participating on
  // the money actually paid (this is what the YC safe says happens).
  const seniorityBase = state.preferred.reduce((a, p) => Math.max(a, p.seniority), 0);
  for (const c of sol.safeConversions) {
    state.preferred.push({
      id: `${c.safeId}-conv`,
      name: c.name,
      series: `${ev.series} (SAFE)`,
      shares: c.shares,
      invested: c.amount,
      multiple: 1,
      participating: false,
      seniority: seniorityBase + 1,
      conversionPrice: c.pricePerShare,
      antiDilutionProtected: false,
      fromSafe: true,
    });
    state.investedByHolder[c.safeId] = (state.investedByHolder[c.safeId] ?? 0) + c.amount;
  }
  state.openSafes = [];

  // pool top-up
  state.poolUnallocated += sol.poolIncrease;

  // new money
  for (const a of sol.allocations) {
    if (a.amount <= 0) continue;
    if (a.isNew) {
      const pos: PreferredPosition = {
        id: a.holderId,
        name: a.name,
        series: ev.series,
        shares: a.shares,
        invested: a.amount,
        multiple: ev.prefMultiple,
        participating: ev.participating,
        participationCap: ev.participationCap,
        seniority: seniorityBase + 2,
        conversionPrice: sol.pps,
        antiDilutionProtected: true,
        fromSafe: false,
      };
      state.preferred.push(pos);
    } else {
      // pro-rata: existing holder buys into the new series as a separate position
      const src = state.preferred.find((x) => x.id === a.holderId);
      state.preferred.push({
        id: `${a.holderId}-${ev.id}-pr`,
        name: `${src ? src.name : a.name} (pro-rata)`,
        series: ev.series,
        shares: a.shares,
        invested: a.amount,
        multiple: ev.prefMultiple,
        participating: ev.participating,
        participationCap: ev.participationCap,
        seniority: seniorityBase + 2,
        conversionPrice: sol.pps,
        antiDilutionProtected: true,
        fromSafe: false,
      });
    }
  }

  const newFounder = founderPct(state);
  const postMoney = ev.preMoney + ev.investment;
  const poolPctPost = (state.optionsAllocated + state.poolUnallocated) / fullyDiluted(state);

  const bits: string[] = [];
  bits.push(
    `${ev.series}: ${money(ev.investment, currency)} at a ${money(ev.preMoney, currency)} pre-money (${money(postMoney, currency)} post), ${currency}${sol.pps.toFixed(4)} per share.`,
  );
  if (sol.poolIncrease > 0) {
    bits.push(
      ev.poolTiming === 'pre-money'
        ? `The option pool was topped up to ${pct(poolPctPost)} out of the PRE-money — the pool shuffle. The new investor's percentage is untouched; existing holders paid for the whole top-up, and the effective pre-money is really ${money(sol.pps * (sol.preMoneyFD - sol.poolIncrease), currency)}.`
        : `The option pool was topped up to ${pct(poolPctPost)} out of the POST-money, so the new investor was diluted by it alongside everyone else.`,
    );
  }
  const converted = sol.safeConversions.filter((c) => c.shares > 0);
  if (converted.length) {
    const capBound = converted.filter((c) => c.mechanism === 'cap');
    bits.push(
      `${converted.length} SAFE${converted.length > 1 ? 's' : ''} converted into ${Math.round(converted.reduce((a, c) => a + c.shares, 0)).toLocaleString('en-GB')} shares` +
        (capBound.length
          ? `, ${capBound.length} of them on their valuation cap at ${currency}${capBound[0].pricePerShare.toFixed(4)}/share — a ${(sol.pps / capBound[0].pricePerShare).toFixed(2)}x better price than the round.`
          : `, priced off the round discount.`),
    );
  }
  const adTotal = Object.values(sol.antiDilutionShares).reduce((a, b) => a + b, 0);
  if (adTotal > 0.5) {
    bits.push(
      `Down round: broad-based weighted-average anti-dilution issued ${Math.round(adTotal).toLocaleString('en-GB')} extra shares to the earlier series. Founders pay for that too.`,
    );
  }
  bits.push(
    `Founders went ${pct(prevFounder)} → ${pct(newFounder)} (${((newFounder - prevFounder) * 100).toFixed(1)} points).`,
  );

  return {
    state,
    snapshot: {
      eventId: ev.id,
      label: ev.label,
      postMoney,
      pps: sol.pps,
      solution: sol,
      explanation: bits.join(' '),
    },
  };
}

export function simulate(scenario: Scenario): SimResult {
  let state = emptyState();
  const snapshots: Snapshot[] = [];
  for (const ev of scenario.events) {
    const out = applyEvent(state, ev, scenario.currency);
    state = out.state;
    const { rows, total } = capRows(state);
    snapshots.push({
      ...out.snapshot,
      rows,
      totalShares: total,
      founderPct: founderPct(state),
      state: cloneState(state),
    });
  }
  return { snapshots, final: snapshots[snapshots.length - 1] };
}
