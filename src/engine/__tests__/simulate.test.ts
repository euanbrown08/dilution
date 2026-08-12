import { describe, it, expect } from 'vitest';
import { simulate } from '../simulate';
import { waterfall } from '../waterfall';
import { scenarios, goodRound, poolShuffle } from '../../scenarios';
import type { Scenario } from '../types';

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('18. scenario walk-through', () => {
  it('every snapshot has percentages summing to 100 %', () => {
    for (const sc of scenarios) {
      for (const snap of simulate(sc).snapshots) {
        const sum = snap.rows.reduce((a, r) => a + r.pct, 0);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
        expect(snap.rows.every((r) => r.shares >= 0)).toBe(true);
      }
    }
  });

  it('founder ownership only ever goes down', () => {
    for (const sc of scenarios) {
      const snaps = simulate(sc).snapshots;
      for (let i = 1; i < snaps.length; i++) {
        expect(snaps[i].founderPct).toBeLessThan(snaps[i - 1].founderPct + 1e-12);
      }
    }
  });

  it('granting options does not move anyone s fully diluted percentage', () => {
    // A grant moves shares from the reserved pool to employees. Total FD is
    // unchanged, so founders and investors are unaffected. This is the single
    // most common misreading of a cap table.
    const snaps = simulate(goodRound).snapshots;
    const before = snaps.find((s) => s.eventId === 'seed')!;
    const after = snaps.find((s) => s.eventId === 'grants1')!;
    near(before.founderPct, after.founderPct, 1e-12);
    near(before.totalShares, after.totalShares, 1e-9);
  });

  it('a SAFE issues no shares until the priced round', () => {
    const snaps = simulate(goodRound).snapshots;
    near(snaps[0].totalShares, snaps[1].totalShares, 1e-9);
    expect(snaps[1].rows.some((r) => r.group === 'SAFE investors')).toBe(false);
    const a = snaps.find((s) => s.eventId === 'seriesA')!;
    expect(a.rows.some((r) => r.group === 'SAFE investors')).toBe(true);
  });

  it('the money in equals the sum of what everyone paid', () => {
    for (const sc of scenarios) {
      const final = simulate(sc).final;
      const raised = sc.events.reduce((a, e) => {
        if (e.kind === 'priced') return a + e.investment;
        if (e.kind === 'safe') return a + e.safes.reduce((x, s) => x + s.amount, 0);
        return a;
      }, 0);
      const onTable = final.rows.reduce((a, r) => a + r.invested, 0);
      near(onTable, raised, 1e-6);
    }
  });
});

describe('19. the pool shuffle, end to end', () => {
  it('flipping Series A pool timing hands the founders several points back', () => {
    const flip = (sc: Scenario, timing: 'pre-money' | 'post-money'): Scenario => ({
      ...sc,
      events: sc.events.map((e) => (e.kind === 'priced' && e.id === 'seriesA' ? { ...e, poolTiming: timing } : e)),
    });
    const preM = simulate(flip(poolShuffle, 'pre-money'));
    const postM = simulate(flip(poolShuffle, 'post-money'));
    const a = (r: typeof preM) => r.snapshots.find((s) => s.eventId === 'seriesA')!;
    expect(a(postM).founderPct).toBeGreaterThan(a(preM).founderPct);
    // and the Series A investor is correspondingly smaller
    const inv = (r: typeof preM) =>
      a(r).rows.find((x) => x.id === 'seriesA-lead')!.pct;
    expect(inv(postM)).toBeLessThan(inv(preM));
    // pre-money pool always gives the lead exactly investment / post-money
    near(inv(preM), 4_000_000 / 20_000_000, 1e-9);
  });
});

describe('20. exit waterfall on a real scenario', () => {
  it('conserves money and gives the founders less than their percentage', () => {
    const final = simulate(scenarios[2]).final; // the down round
    const w = waterfall(final.state, scenarios[2].exitValue);
    const total = w.lines.reduce((a, l) => a + l.proceeds, 0);
    near(total, scenarios[2].exitValue, 1e-3);
    const founderOwned = w.lines.filter((l) => l.group === 'Founders').reduce((a, l) => a + l.pctOwned, 0);
    const founderPaid = w.lines.filter((l) => l.group === 'Founders').reduce((a, l) => a + l.pctProceeds, 0);
    expect(founderPaid).toBeLessThan(founderOwned);
  });

  it('at a large enough exit everyone converges on their ownership share', () => {
    const final = simulate(goodRound).final;
    const w = waterfall(final.state, 5_000_000_000);
    for (const l of w.lines) {
      if (l.id === 'pool') continue;
      // pool is cancelled, so shares are scaled by 1/(1 - poolPct)
      const poolPct = w.lines.find((x) => x.id === 'pool')?.pctOwned ?? 0;
      expect(Math.abs(l.pctProceeds - l.pctOwned / (1 - poolPct))).toBeLessThan(1e-6);
    }
  });
});
