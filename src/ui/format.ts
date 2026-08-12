const nf = new Intl.NumberFormat('en-GB');

export function shares(n: number): string {
  return nf.format(Math.round(n));
}

export function pct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function money(n: number, cur = '£'): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${cur}${(n / 1e9).toFixed(2)}bn`;
  if (a >= 1e6) return `${cur}${trim(n / 1e6)}m`;
  if (a >= 1e3) return `${cur}${trim(n / 1e3)}k`;
  return `${cur}${Math.round(n)}`;
}

function trim(x: number): string {
  const s = x.toFixed(2);
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function price(n: number, cur = '£'): string {
  if (!Number.isFinite(n)) return '—';
  return `${cur}${n < 0.01 ? n.toPrecision(3) : n.toFixed(4)}`;
}

/** Stable colour per cap-table row. */
export function colourFor(group: string, index: number): string {
  const ramps: Record<string, string[]> = {
    Founders: ['#f0a640', '#e08a2e', '#c9721f', '#b35f18'],
    Employees: ['#3fb8a5'],
    'Option pool': ['#5a6470'],
    'SAFE investors': ['#9d7ce0', '#8a66d4', '#7a55c4', '#6b46b4'],
    Investors: ['#4a9de8', '#3a86d6', '#2f6fb8', '#265a99', '#1e4a80'],
  };
  const ramp = ramps[group] ?? ['#888'];
  return ramp[index % ramp.length];
}

export const GROUP_ORDER = ['Founders', 'Employees', 'Option pool', 'SAFE investors', 'Investors'];
