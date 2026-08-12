/**
 * Dilution engine — types.
 *
 * Everything here is plain data. The engine is a pure function of a Scenario.
 * Share counts are held as floating point on purpose: rounding to whole shares
 * at every step introduces drift that makes hand-checking impossible. We round
 * only for display. See LOG.md ("Thinking & key decisions").
 */

export type PoolTiming = 'pre-money' | 'post-money';
export type SafeType = 'post-money' | 'pre-money';
export type AntiDilution = 'none' | 'broad-based';

/** A SAFE or convertible note sitting outside the cap table until a priced round. */
export interface SafeTerms {
  id: string;
  name: string;
  /** Money in. */
  amount: number;
  /** Valuation cap. Undefined = uncapped (discount-only, or MFN-only). */
  cap?: number;
  /** 0.2 = a 20 % discount to the round price. Undefined = no discount. */
  discount?: number;
  type: SafeType;
  /** Most-favoured-nation: adopt the best cap and best discount of any other SAFE in the stack. */
  mfn?: boolean;
}

export interface FoundingEvent {
  kind: 'founding';
  id: string;
  label: string;
  founders: { id: string; name: string; shares: number }[];
  /** Unallocated option pool created at founding. */
  poolShares: number;
}

export interface SafeEvent {
  kind: 'safe';
  id: string;
  label: string;
  safes: SafeTerms[];
}

/** Grant options to employees: moves shares from unallocated pool to allocated. */
export interface GrantEvent {
  kind: 'grant';
  id: string;
  label: string;
  shares: number;
}

export interface PricedRoundEvent {
  kind: 'priced';
  id: string;
  label: string;
  /** Series name, e.g. "Series A". */
  series: string;
  preMoney: number;
  investment: number;
  /**
   * Target TOTAL option pool (allocated + unallocated) as a fraction of the
   * post-round fully diluted share count. 0.12 = 12 %.
   */
  targetPoolPct: number;
  /**
   * 'pre-money'  — the pool increase sits in the pre-money share count, so only
   *                existing holders pay for it (the "pool shuffle").
   * 'post-money' — the pool increase is issued after the round price is struck,
   *                so the new investor is diluted by it too.
   */
  poolTiming: PoolTiming;
  prefMultiple: number;
  participating: boolean;
  /** Participation cap as a multiple of money invested, e.g. 3 = 3x cap. */
  participationCap?: number;
  /** Ids of existing preferred positions whose holders take their pro-rata. */
  proRataHolderIds?: string[];
  /** Anti-dilution protection carried by PRIOR series, triggered on a down round. */
  antiDilution?: AntiDilution;
}

export type ScenarioEvent = FoundingEvent | SafeEvent | GrantEvent | PricedRoundEvent;

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  currency: string;
  events: ScenarioEvent[];
  exitValue: number;
}

/* ------------------------------------------------------------------ */
/* Cap table state                                                     */
/* ------------------------------------------------------------------ */

export interface PreferredPosition {
  id: string;
  name: string;
  series: string;
  shares: number;
  invested: number;
  multiple: number;
  participating: boolean;
  participationCap?: number;
  /** Higher number = more senior = paid first. */
  seniority: number;
  /** Price paid per share; used by weighted-average anti-dilution. */
  conversionPrice: number;
  antiDilutionProtected: boolean;
  /** True when this position was created by a SAFE converting. */
  fromSafe: boolean;
}

export interface FounderPosition {
  id: string;
  name: string;
  shares: number;
}

export interface CapState {
  founders: FounderPosition[];
  /** Options granted to employees (allocated). Counted as common, fully diluted. */
  optionsAllocated: number;
  /** Reserved but ungranted option pool. */
  poolUnallocated: number;
  preferred: PreferredPosition[];
  /** SAFEs still outstanding (not yet converted). */
  openSafes: SafeTerms[];
  /** Money in so far, by holder id — used for pro-rata display and MOIC. */
  investedByHolder: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* Solver output                                                       */
/* ------------------------------------------------------------------ */

export interface SafeConversion {
  safeId: string;
  name: string;
  amount: number;
  shares: number;
  pricePerShare: number;
  /** Which branch of the SAFE actually bound. */
  mechanism: 'cap' | 'discount' | 'round-price';
  type: SafeType;
  /** Effective pre-money valuation the SAFE holder bought at. */
  effectiveValuation: number;
}

export interface RoundSolution {
  pps: number;
  /** Total new shares issued for the round's money (lead + pro-rata takers). */
  newMoneyShares: number;
  poolIncrease: number;
  safeConversions: SafeConversion[];
  /** Extra common issuable to prior series under weighted-average anti-dilution. */
  antiDilutionShares: Record<string, number>;
  preMoneyFD: number;
  postFD: number;
  iterations: number;
  /** |pps_n - pps_{n-1}| / pps at the point we stopped. */
  residual: number;
  converged: boolean;
  /**
   * True when the requested option pool percentage could not be hit, in either
   * direction. Two distinct cases, told apart by `warnings`:
   *   'pool-target-unreachable'    — too high. Under pre-money timing the pool
   *      can never exceed preMoney/(preMoney+investment) of the post-round
   *      table, because the new investor's slice is fixed.
   *   'pool-already-above-target'  — too low. The existing pool is already a
   *      larger share of the post-round table than requested, and a financing
   *      cannot un-issue a pool, so the increase is zero and the result lands
   *      above the request.
   */
  poolTargetClamped: boolean;
  /** Machine-readable notes, e.g. 'safe-overhang' when the SAFEs claim the whole pre-money. */
  warnings: string[];
  /** How the round money split between the new lead and pro-rata takers. */
  allocations: { holderId: string; name: string; amount: number; shares: number; isNew: boolean }[];
}

/* ------------------------------------------------------------------ */
/* Simulation output                                                   */
/* ------------------------------------------------------------------ */

export interface CapRow {
  id: string;
  name: string;
  group: 'Founders' | 'Employees' | 'Option pool' | 'SAFE investors' | 'Investors';
  shares: number;
  pct: number;
  invested: number;
  security: string;
}

export interface Snapshot {
  eventId: string;
  label: string;
  rows: CapRow[];
  totalShares: number;
  founderPct: number;
  postMoney: number | null;
  pps: number | null;
  solution: RoundSolution | null;
  /** One-line, plain-English account of what this event did. */
  explanation: string;
  state: CapState;
}

export interface SimResult {
  snapshots: Snapshot[];
  final: Snapshot;
}
