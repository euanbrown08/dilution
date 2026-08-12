import type { Scenario } from './engine/types';

/**
 * Three stories on the same company. Share counts and cheque sizes are made up
 * but sized to be recognisable for a UK/EU seed-to-Series-B path.
 */

const founders = [
  { id: 'ada', name: 'Ada (CEO)', shares: 4_500_000 },
  { id: 'ben', name: 'Ben (CTO)', shares: 3_500_000 },
];

export const goodRound: Scenario = {
  id: 'good',
  title: 'The good round',
  blurb:
    'A clean path. One post-money SAFE, a sensible pool, priced rounds at rising valuations and a 1x non-participating preference. This is roughly what founders imagine happens.',
  currency: '£',
  exitValue: 200_000_000,
  events: [
    { kind: 'founding', id: 'inc', label: 'Incorporation', founders, poolShares: 1_000_000 },
    {
      kind: 'safe',
      id: 'seed',
      label: 'Pre-seed SAFE',
      safes: [{ id: 'angels', name: 'Angel syndicate (SAFE)', amount: 750_000, cap: 8_000_000, type: 'post-money' }],
    },
    { kind: 'grant', id: 'grants1', label: 'First hires', shares: 400_000 },
    {
      kind: 'priced',
      id: 'seriesA',
      label: 'Series A',
      series: 'Series A',
      preMoney: 16_000_000,
      investment: 4_000_000,
      targetPoolPct: 0.12,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: false,
    },
    { kind: 'grant', id: 'grants2', label: 'Scaling the team', shares: 900_000 },
    {
      kind: 'priced',
      id: 'seriesB',
      label: 'Series B',
      series: 'Series B',
      preMoney: 56_000_000,
      investment: 14_000_000,
      targetPoolPct: 0.12,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: false,
      proRataHolderIds: ['seriesA-lead'],
    },
  ],
};

export const poolShuffle: Scenario = {
  id: 'shuffle',
  title: 'The pool-shuffle trap',
  blurb:
    'Same company, same headline valuations. The Series A lead asks for a 20% option pool "out of the pre-money". Flip the pool timing switch on Series A: the lead goes from 20.0% to 17.2% and the founders gain 2.9 points, on identical headline terms. The headline pre-money is not the pre-money.',
  currency: '£',
  exitValue: 200_000_000,
  events: [
    { kind: 'founding', id: 'inc', label: 'Incorporation', founders, poolShares: 1_000_000 },
    {
      kind: 'safe',
      id: 'seed',
      label: 'Pre-seed SAFEs',
      safes: [
        { id: 'angels', name: 'Angel syndicate (SAFE)', amount: 750_000, cap: 8_000_000, type: 'post-money' },
        { id: 'microvc', name: 'Micro-VC (SAFE)', amount: 1_000_000, cap: 12_000_000, discount: 0.2, type: 'post-money' },
        { id: 'mfn', name: 'Friend with MFN (SAFE)', amount: 250_000, type: 'post-money', mfn: true },
      ],
    },
    { kind: 'grant', id: 'grants1', label: 'First hires', shares: 400_000 },
    {
      kind: 'priced',
      id: 'seriesA',
      label: 'Series A',
      series: 'Series A',
      preMoney: 16_000_000,
      investment: 4_000_000,
      targetPoolPct: 0.2,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: false,
    },
    { kind: 'grant', id: 'grants2', label: 'Scaling the team', shares: 900_000 },
    {
      kind: 'priced',
      id: 'seriesB',
      label: 'Series B',
      series: 'Series B',
      preMoney: 56_000_000,
      investment: 14_000_000,
      targetPoolPct: 0.15,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: false,
    },
  ],
};

export const downRound: Scenario = {
  id: 'down',
  title: 'The down round',
  blurb:
    'Series B comes in below the Series A post-money, with 1x participating preference and broad-based weighted-average anti-dilution for the earlier round. Then look at the exit chart: at £60m the founders own a third of the company and receive far less than a third of the money.',
  currency: '£',
  exitValue: 60_000_000,
  events: [
    { kind: 'founding', id: 'inc', label: 'Incorporation', founders, poolShares: 1_000_000 },
    {
      kind: 'safe',
      id: 'seed',
      label: 'Pre-seed SAFE',
      safes: [{ id: 'angels', name: 'Angel syndicate (SAFE)', amount: 750_000, cap: 8_000_000, type: 'post-money' }],
    },
    { kind: 'grant', id: 'grants1', label: 'First hires', shares: 400_000 },
    {
      kind: 'priced',
      id: 'seriesA',
      label: 'Series A',
      series: 'Series A',
      preMoney: 24_000_000,
      investment: 6_000_000,
      targetPoolPct: 0.12,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: false,
    },
    { kind: 'grant', id: 'grants2', label: 'Scaling the team', shares: 900_000 },
    {
      kind: 'priced',
      id: 'seriesB',
      label: 'Series B (down)',
      series: 'Series B',
      preMoney: 18_000_000,
      investment: 12_000_000,
      targetPoolPct: 0.15,
      poolTiming: 'pre-money',
      prefMultiple: 1,
      participating: true,
      participationCap: 3,
      antiDilution: 'broad-based',
    },
  ],
};

export const scenarios: Scenario[] = [goodRound, poolShuffle, downRound];
