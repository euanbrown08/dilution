/**
 * Hand-worked exit waterfalls. Arithmetic written out above each assertion.
 */
import { describe, it, expect } from 'vitest';
import { waterfall, crossoverFor } from '../waterfall';
import type { CapState, PreferredPosition } from '../types';

const pref = (over: Partial<PreferredPosition>): PreferredPosition => ({
  id: 'A',
  name: 'Series A',
  series: 'Series A',
  shares: 2_000_000,
  invested: 2_000_000,
  multiple: 1,
  participating: false,
  seniority: 1,
  conversionPrice: 1,
  antiDilutionProtected: true,
  fromSafe: false,
  ...over,
});

const base = (preferred: PreferredPosition[], over: Partial<CapState> = {}): CapState => ({
  founders: [{ id: 'f1', name: 'Founders', shares: 8_000_000 }],
  optionsAllocated: 0,
  poolUnallocated: 0,
  preferred,
  openSafes: [],
  investedByHolder: {},
  ...over,
});

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);
const get = (w: ReturnType<typeof waterfall>, id: string) => w.lines.find((l) => l.id === id)!;

describe('12. 1x non-participating preferred', () => {
  const s = base([pref({})]); // founders 8m, Series A 2m shares (20 %), £2m in

  it('takes the preference below the crossover — 20 % owner gets 40 % of the money', () => {
    // Exit £5m. Preference £2m vs as-converted 20 % x £5m = £1m. Takes £2m.
    // Founders: residual £3m across 8,000,000 common shares = £3m.
    const w = waterfall(s, 5_000_000);
    near(get(w, 'A').proceeds, 2_000_000);
    near(get(w, 'f1').proceeds, 3_000_000);
    near(get(w, 'A').pctOwned, 0.2, 1e-12);
    near(get(w, 'A').pctProceeds, 0.4, 1e-12);
    // founders own 80 % but receive 60 %
    near(get(w, 'f1').pctProceeds, 0.6, 1e-12);
  });

  it('is wiped out below the preference', () => {
    // Exit £1.5m: Series A takes all of it, founders get nothing.
    const w = waterfall(s, 1_500_000);
    near(get(w, 'A').proceeds, 1_500_000);
    near(get(w, 'f1').proceeds, 0);
  });

  it('converts above the crossover', () => {
    // Crossover: 0.2 E = £2m => E = £10m.
    near(crossoverFor(s, 'A')!, 10_000_000, 1);
    // Exit £20m: converts, takes 20 % = £4m, founders £16m.
    const w = waterfall(s, 20_000_000);
    expect(w.convertedSeries).toContain('A');
    near(get(w, 'A').proceeds, 4_000_000, 1e-3);
    near(get(w, 'f1').proceeds, 16_000_000, 1e-3);
  });
});

describe('13. 1x participating preferred (a "double dip")', () => {
  const s = base([pref({ participating: true })]);

  it('takes the preference AND its share of the rest', () => {
    // Exit £10m: £2m preference, then 20 % of the remaining £8m = £1.6m.
    // Total £3.6m = 36 % of the exit on a 20 % stake.
    const w = waterfall(s, 10_000_000);
    near(get(w, 'A').proceeds, 3_600_000);
    near(get(w, 'f1').proceeds, 6_400_000);
    near(get(w, 'A').pctProceeds, 0.36, 1e-12);
  });

  it('never converts when uncapped', () => {
    expect(crossoverFor(s, 'A')).toBe(null);
  });
});

describe('14. participating with a 3x cap', () => {
  const s = base([pref({ participating: true, participationCap: 3 })]);

  it('participates freely below the cap', () => {
    // Exit £10m: £2m + 20 % of £8m = £3.6m, below the £6m cap.
    near(get(waterfall(s, 10_000_000), 'A').proceeds, 3_600_000);
  });

  it('stops at the cap', () => {
    // Cap binds where 2m + 0.2(E - 2m) = 6m  =>  E = £22m.
    // Exit £25m: capped at £6m; as-converted would be 20 % x £25m = £5m, worse.
    // Founders take the remaining £19m.
    const w = waterfall(s, 25_000_000);
    near(get(w, 'A').proceeds, 6_000_000, 1e-3);
    near(get(w, 'f1').proceeds, 19_000_000, 1e-3);
  });

  it('converts once as-converted beats the cap', () => {
    // 0.2 E = £6m  =>  E = £30m.
    near(crossoverFor(s, 'A')!, 30_000_000, 10);
    // Exit £35m: converts, 20 % = £7m.
    const w = waterfall(s, 35_000_000);
    expect(w.convertedSeries).toContain('A');
    near(get(w, 'A').proceeds, 7_000_000, 1e-3);
  });
});

describe('15. stacked seniority — a good company, a bad outcome', () => {
  // Founders 6m common. Series A 2m shares / £2m in (junior).
  // Series B 2m shares / £10m in (senior). Fully diluted 10m shares.
  const s = base(
    [
      pref({ id: 'A', name: 'Series A', shares: 2_000_000, invested: 2_000_000, seniority: 1 }),
      pref({ id: 'B', name: 'Series B', series: 'Series B', shares: 2_000_000, invested: 10_000_000, seniority: 2 }),
    ],
    { founders: [{ id: 'f1', name: 'Founders', shares: 6_000_000 }] },
  );

  it('pays the senior series first and leaves nothing', () => {
    // Exit £8m: Series B takes min(8, 10) = £8m. Series A £0. Founders £0.
    const w = waterfall(s, 8_000_000);
    near(get(w, 'B').proceeds, 8_000_000);
    near(get(w, 'A').proceeds, 0);
    near(get(w, 'f1').proceeds, 0);
  });

  it('a £12m exit still leaves the founders with nothing', () => {
    // B £10m, A £2m, residual £0. Founders own 60 % and get £0.
    const w = waterfall(s, 12_000_000);
    near(get(w, 'B').proceeds, 10_000_000);
    near(get(w, 'A').proceeds, 2_000_000);
    near(get(w, 'f1').proceeds, 0);
    near(get(w, 'f1').pctOwned, 0.6, 1e-12);
  });

  it('resolves the interdependent convert/preference choice', () => {
    // Exit £20m.
    //  - B as-converted = 20 % x 20m = £4m < £10m preference, so B holds.
    //  - If A holds: A gets £2m, residual = 20 - 10 - 2 = £8m over 6m common
    //    shares, founders £8m.
    //  - If A converts: residual = 20 - 10 = £10m over 6m + 2m = 8m shares,
    //    A gets 2/8 x 10m = £2.5m > £2m. So A converts.
    //  => B £10m, A £2.5m, founders 6/8 x 10m = £7.5m. Sums to £20m.
    const w = waterfall(s, 20_000_000);
    expect(w.convertedSeries).toEqual(['A']);
    near(get(w, 'B').proceeds, 10_000_000, 1e-3);
    near(get(w, 'A').proceeds, 2_500_000, 1e-3);
    near(get(w, 'f1').proceeds, 7_500_000, 1e-3);
  });
});

describe('16. option pool at exit', () => {
  it('cancels the unallocated pool and pays granted options', () => {
    // Founders 8m, granted options 1m, unallocated pool 1m, Series A 2m shares
    // / £2m in. FD = 12m. Exit £60m — everyone converts.
    // Residual is shared over 8m + 1m + 2m = 11m shares (the unallocated 1m is
    // cancelled), so founders get 8/11 x 60m = £43.636m, not 8/12 x 60m.
    const s = base([pref({})], { optionsAllocated: 1_000_000, poolUnallocated: 1_000_000 });
    const w = waterfall(s, 60_000_000);
    near(get(w, 'pool').proceeds, 0);
    near(get(w, 'f1').proceeds, (8 / 11) * 60_000_000, 1);
    near(get(w, 'employees').proceeds, (1 / 11) * 60_000_000, 1);
    near(get(w, 'A').proceeds, (2 / 11) * 60_000_000, 1);
    // owning 66.7 % of the fully diluted table, founders receive 72.7 %
    near(get(w, 'f1').pctOwned, 8 / 12, 1e-12);
    near(get(w, 'f1').pctProceeds, 8 / 11, 1e-9);
  });
});

describe('17. conservation of money', () => {
  it('pays out exactly the exit value at every exit value, every structure', () => {
    const structures: CapState[] = [
      base([pref({})]),
      base([pref({ participating: true })]),
      base([pref({ participating: true, participationCap: 2 })]),
      base(
        [
          pref({ id: 'A', shares: 2_000_000, invested: 2_000_000, seniority: 1 }),
          pref({ id: 'B', name: 'Series B', shares: 3_000_000, invested: 12_000_000, seniority: 2, participating: true, participationCap: 3 }),
        ],
        { optionsAllocated: 800_000, poolUnallocated: 700_000 },
      ),
    ];
    for (const s of structures) {
      for (let e = 0; e <= 120_000_000; e += 1_000_000) {
        const w = waterfall(s, e);
        const total = w.lines.reduce((a, l) => a + l.proceeds, 0);
        expect(Math.abs(total - e)).toBeLessThan(1e-6);
        expect(w.lines.every((l) => l.proceeds >= -1e-9)).toBe(true);
      }
    }
  });

  it('is monotone: nobody is made worse off by a larger exit', () => {
    const s = base(
      [
        pref({ id: 'A', shares: 2_000_000, invested: 2_000_000, seniority: 1 }),
        pref({ id: 'B', name: 'Series B', shares: 3_000_000, invested: 9_000_000, seniority: 2, participating: true, participationCap: 2 }),
      ],
      { optionsAllocated: 500_000, poolUnallocated: 500_000 },
    );
    let prev: Record<string, number> | null = null;
    for (let e = 0; e <= 150_000_000; e += 250_000) {
      const w = waterfall(s, e);
      const now: Record<string, number> = {};
      for (const l of w.lines) now[l.id] = l.proceeds;
      if (prev) for (const k of Object.keys(now)) expect(now[k]).toBeGreaterThan(prev[k] - 1e-3);
      prev = now;
    }
  });
});
