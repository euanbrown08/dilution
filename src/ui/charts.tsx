import { useMemo, useState } from 'react';
import type { CapRow, CapState } from '../engine/types';
import { waterfall, waterfallCurve, crossoverFor } from '../engine/waterfall';
import { colourFor, GROUP_ORDER, money, pct, shares as fmtShares } from './format';

/* ------------------------------------------------------------------ */
/* Sunburst                                                            */
/* ------------------------------------------------------------------ */

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const span = Math.min(a1 - a0, Math.PI * 2 - 1e-6);
  const end = a0 + span;
  const P = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  const large = span > Math.PI ? 1 : 0;
  return `M${P(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${P(r1, end)} L${P(r0, end)} A${r0} ${r0} 0 ${large} 0 ${P(r0, a0)} Z`;
}

export function Sunburst({
  rows,
  size = 300,
  onHover,
}: {
  rows: CapRow[];
  size?: number;
  onHover?: (id: string | null) => void;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const total = rows.reduce((a, r) => a + r.shares, 0) || 1;

  const groups = GROUP_ORDER.map((g) => ({
    name: g,
    rows: rows.filter((r) => r.group === g),
  })).filter((g) => g.rows.length > 0);

  let angle = -Math.PI / 2;
  const inner: { path: string; fill: string; name: string; pct: number }[] = [];
  const outer: { path: string; fill: string; row: CapRow }[] = [];

  for (const g of groups) {
    const gShares = g.rows.reduce((a, r) => a + r.shares, 0);
    const gSpan = (gShares / total) * Math.PI * 2;
    inner.push({
      path: arcPath(cx, cy, size * 0.2, size * 0.29, angle, angle + gSpan),
      fill: colourFor(g.name, 0),
      name: g.name,
      pct: gShares / total,
    });
    let a = angle;
    g.rows.forEach((r, i) => {
      const span = (r.shares / total) * Math.PI * 2;
      outer.push({
        path: arcPath(cx, cy, size * 0.305, size * 0.46, a, a + span),
        fill: colourFor(g.name, i),
        row: r,
      });
      a += span;
    });
    angle += gSpan;
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="sunburst" role="img" aria-label="Ownership sunburst">
      {inner.map((s, i) => (
        <path key={`i${i}`} d={s.path} fill={s.fill} opacity={0.55} />
      ))}
      {outer.map((s, i) => (
        <path
          key={`o${i}`}
          d={s.path}
          fill={s.fill}
          onMouseEnter={() => onHover?.(s.row.id)}
          onMouseLeave={() => onHover?.(null)}
        >
          <title>{`${s.row.name} — ${pct(s.row.pct)} (${fmtShares(s.row.shares)} shares)`}</title>
        </path>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Founder ownership sparkline                                         */
/* ------------------------------------------------------------------ */

export function Sparkline({
  values,
  labels,
  current,
  onPick,
}: {
  values: number[];
  labels: string[];
  current: number;
  onPick?: (i: number) => void;
}) {
  const w = 300;
  const h = 56;
  const pad = 6;
  const max = Math.max(...values, 0.001);
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(values.length - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" role="img" aria-label="Founder ownership over time">
      <path d={area} fill="#f0a640" opacity={0.12} />
      <path d={d} fill="none" stroke="#f0a640" strokeWidth={1.6} />
      {values.map((v, i) => (
        <g key={i} onClick={() => onPick?.(i)} className="spark-pt">
          <circle cx={x(i)} cy={y(v)} r={i === current ? 4 : 2.4} fill={i === current ? '#f0a640' : '#8a6b3a'} />
          <rect x={x(i) - 12} y={0} width={24} height={h} fill="transparent" />
          <title>{`${labels[i]} — founders ${pct(v)}`}</title>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Exit waterfall chart                                                */
/* ------------------------------------------------------------------ */

export function ExitChart({
  state,
  maxExit,
  exitValue,
  currency,
  onExitChange,
}: {
  state: CapState;
  maxExit: number;
  exitValue: number;
  currency: string;
  onExitChange: (v: number) => void;
}) {
  const w = 640;
  const h = 260;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const [hover, setHover] = useState<number | null>(null);

  const { curve, order, meta, crossovers } = useMemo(() => {
    // start just above zero: at an exit of exactly nothing every band is zero
    // and the stack collapses into a meaningless spike.
    const curve = waterfallCurve(state, maxExit, 145, maxExit / 400);
    const at = waterfall(state, maxExit);
    // stack founders/employees at the bottom, investors on top
    const rank = (g: string) => GROUP_ORDER.indexOf(g);
    const lines = [...at.lines].sort((a, b) => rank(a.group) - rank(b.group));
    const order = lines.filter((l) => l.id !== 'pool').map((l) => l.id);
    const meta: Record<string, { name: string; group: string; index: number }> = {};
    const seen: Record<string, number> = {};
    for (const l of lines) {
      const i = (seen[l.group] = (seen[l.group] ?? -1) + 1);
      meta[l.id] = { name: l.name, group: l.group, index: i };
    }
    const crossovers = state.preferred
      .map((p) => ({ id: p.id, name: p.name, at: crossoverFor(state, p.id, maxExit * 4) }))
      .filter((c) => c.at !== null && c.at! <= maxExit) as { id: string; name: string; at: number }[];
    return { curve, order, meta, crossovers };
  }, [state, maxExit]);

  const X = (e: number) => padL + (e / maxExit) * (w - padL - padR);
  const Y = (frac: number) => padT + (1 - frac) * (h - padT - padB);

  // stacked areas of proceeds share
  const bands = order.map((id, idx) => {
    const upper: string[] = [];
    const lower: string[] = [];
    curve.forEach((pt, i) => {
      const tot = Object.values(pt.byId).reduce((a, b) => a + b, 0) || 1;
      let below = 0;
      for (let k = 0; k < idx; k++) below += pt.byId[order[k]] ?? 0;
      const mine = pt.byId[id] ?? 0;
      upper.push(`${i === 0 ? 'M' : 'L'}${X(pt.exit).toFixed(2)} ${Y((below + mine) / tot).toFixed(2)}`);
      lower.push(`L${X(pt.exit).toFixed(2)} ${Y(below / tot).toFixed(2)}`);
    });
    return {
      id,
      d: `${upper.join(' ')} ${lower.reverse().join(' ')} Z`,
      fill: colourFor(meta[id].group, meta[id].index),
    };
  });

  const here = waterfall(state, hover ?? exitValue);
  const hereTotal = here.lines.reduce((a, l) => a + l.proceeds, 0) || 1;

  return (
    <div className="exitchart">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * w;
          setHover(Math.max(0, Math.min(maxExit, ((px - padL) / (w - padL - padR)) * maxExit)));
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => hover !== null && onExitChange(hover)}
        role="img"
        aria-label="Share of exit proceeds by exit value"
      >
        {bands.map((b) => (
          <path key={b.id} d={b.d} fill={b.fill} opacity={0.9} />
        ))}
        {crossovers.map((c) => (
          <g key={c.id}>
            <line x1={X(c.at)} x2={X(c.at)} y1={padT} y2={h - padB} stroke="#fff" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
            <text x={X(c.at) + 4} y={padT + 11} className="crosslabel">
              {c.name} converts
            </text>
          </g>
        ))}
        <line x1={X(exitValue)} x2={X(exitValue)} y1={padT} y2={h - padB} stroke="#fff" strokeWidth={1.5} />
        {hover !== null && (
          <line x1={X(hover)} x2={X(hover)} y1={padT} y2={h - padB} stroke="#fff" strokeWidth={1} opacity={0.4} />
        )}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={X(maxExit * f)} y={h - 8} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="axis">
            {money(maxExit * f, currency)}
          </text>
        ))}
      </svg>
      <table className="waterfall-table">
        <thead>
          <tr>
            <th>At an exit of {money(hover ?? exitValue, currency)}</th>
            <th>Owns</th>
            <th>Receives</th>
            <th>Share of proceeds</th>
            <th>Treatment</th>
          </tr>
        </thead>
        <tbody>
          {here.lines.map((l) => (
            <tr key={l.id} className={l.group === 'Founders' ? 'founder-row' : ''}>
              <td>
                <span className="swatch" style={{ background: colourFor(l.group, meta[l.id]?.index ?? 0) }} />
                {l.name}
              </td>
              <td className="num">{pct(l.pctOwned)}</td>
              <td className="num">{money(l.proceeds, currency)}</td>
              <td className="num">{pct(l.proceeds / hereTotal)}</td>
              <td className="treatment">{l.treatment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
