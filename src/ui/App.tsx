import { useCallback, useMemo, useRef, useState } from 'react';
import { simulate } from '../engine/simulate';
import type { PricedRoundEvent, SafeEvent, Scenario, ScenarioEvent, Snapshot } from '../engine/types';
import { scenarios } from '../scenarios';
import { ExitChart, Sparkline, Sunburst } from './charts';
import { DragNumber, Toggle } from './controls';
import { colourFor, money, pct, price, shares as fmtShares } from './format';

const clone = (s: Scenario): Scenario => JSON.parse(JSON.stringify(s));

export default function App() {
  const [scenarioId, setScenarioId] = useState(scenarios[0].id);
  const [sc, setSc] = useState<Scenario>(() => clone(scenarios[0]));
  const [step, setStep] = useState<number>(scenarios[0].events.length - 1);
  const [chartMax, setChartMax] = useState(scenarios[0].exitValue * 2.5);
  const [note, setNote] = useState<{ mechanic: string; before: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const lastFounder = useRef<number>(1);

  const sim = useMemo(() => simulate(sc), [sc]);
  const idx = Math.min(step, sim.snapshots.length - 1);
  const snap = sim.snapshots[idx];
  const finalSnap = sim.final;

  const loadScenario = (id: string) => {
    const found = scenarios.find((s) => s.id === id)!;
    setScenarioId(id);
    setSc(clone(found));
    setStep(found.events.length - 1);
    setChartMax(found.exitValue * 2.5);
    setNote(null);
  };

  /** Wrap every edit so the "what just happened" line can name the mechanic. */
  const edit = useCallback(
    (mechanic: string, fn: (draft: Scenario) => void) => {
      setNote({ mechanic, before: lastFounder.current });
      setSc((prev) => {
        const draft = clone(prev);
        fn(draft);
        return draft;
      });
    },
    [],
  );

  const patch = (id: string, mechanic: string, p: Partial<PricedRoundEvent>) =>
    edit(mechanic, (d) => {
      const e = d.events.find((x) => x.id === id) as PricedRoundEvent | undefined;
      if (e) Object.assign(e, p);
    });

  lastFounder.current = finalSnap.founderPct;

  const totalRaised = sc.events.reduce((a, e) => {
    if (e.kind === 'priced') return a + e.investment;
    if (e.kind === 'safe') return a + e.safes.reduce((x, s) => x + s.amount, 0);
    return a;
  }, 0);

  const delta = note ? finalSnap.founderPct - note.before : 0;

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Dilution</h1>
          <p className="sub">
            An explorable equity simulator. Drag any number. The cap table, the ownership sunburst and the exit
            waterfall all recompute as you go.
          </p>
        </div>
        <div className="scenario-picker">
          {scenarios.map((s) => (
            <button key={s.id} className={s.id === scenarioId ? 'on' : ''} onClick={() => loadScenario(s.id)}>
              {s.title}
            </button>
          ))}
          <button className="reset" onClick={() => loadScenario(scenarioId)} title="Reset this scenario">
            Reset
          </button>
        </div>
      </header>

      <p className="blurb">{scenarios.find((s) => s.id === scenarioId)?.blurb}</p>

      <div className="layout">
        {/* ---------------- narrative column ---------------- */}
        <main className="steps">
          {sc.events.map((ev, i) => (
            <section
              key={ev.id}
              className={`step${i === idx ? ' active' : ''}`}
              onClick={() => setStep(i)}
              onFocus={() => setStep(i)}
            >
              <div className="step-head">
                <span className="step-n">{i + 1}</span>
                <h2>{ev.label}</h2>
                <span className="step-own">
                  founders {pct(sim.snapshots[i].founderPct)}
                </span>
              </div>
              <StepBody ev={ev} sc={sc} snap={sim.snapshots[i]} edit={edit} patch={patch} />
              <p className="what">{sim.snapshots[i].explanation}</p>
              {sim.snapshots[i].solution && !sim.snapshots[i].solution!.converged && (
                <p className="warn">
                  The solver did not converge for these inputs (residual{' '}
                  {sim.snapshots[i].solution!.residual.toExponential(2)}). Treat the numbers above as unreliable.
                </p>
              )}
              {sim.snapshots[i].solution?.poolTargetClamped && (
                <p className="warn">
                  {sim.snapshots[i].solution!.warnings.includes('pool-already-above-target')
                    ? 'The existing option pool is already a bigger share of the post-round table than that target, and a financing cannot un-issue a pool. No shares were added, so the pool lands above the number you asked for.'
                    : "That option pool percentage is unreachable with a pre-money pool: the new investor's slice is fixed, so the pool cannot exceed pre-money / (pre-money + investment) of the post-round table. Clamped."}
                </p>
              )}
            </section>
          ))}

          <section className="step exit-step">
            <div className="step-head">
              <span className="step-n">↘</span>
              <h2>The exit</h2>
            </div>
            <p className="field">
              The company sells for{' '}
              <DragNumber
                value={sc.exitValue}
                min={100_000}
                max={chartMax}
                step={1}
                log
                label="Exit value"
                format={(v) => money(v, sc.currency)}
                onChange={(v) => edit('exit value', (d) => { d.exitValue = v; })}
              />{' '}
              (chart range{' '}
              <DragNumber
                value={chartMax}
                min={Math.max(1_000_000, sc.exitValue)}
                max={5_000_000_000}
                step={1}
                log
                label="Chart range"
                format={(v) => money(v, sc.currency)}
                onChange={setChartMax}
              />
              ). Total raised: {money(totalRaised, sc.currency)}.
            </p>
            <p className="what">
              Percentage is not payout. Preferred shares are paid their liquidation preference before the common stock
              sees anything, and the unallocated option pool is cancelled. The dashed lines mark the crossover: the exit
              value above which an investor does better converting to common than taking the preference.
            </p>
          </section>

          <section className="notes">
            <h3>What this model does and does not do</h3>
            <ul>
              <li>Not investment, financial, tax or legal advice. It is a teaching model, not a cap table of record.</li>
              <li>
                Share counts are floating point, so a table may show 1,285,714 shares where a registrar would round.
              </li>
              <li>
                Founder vesting, share classes with different votes, debt, escrow, transaction costs, management
                carve-outs and option strike prices are all out of scope.
              </li>
              <li>
                Granted options are treated as fully vested and exercised at a zero strike; the unallocated pool is
                cancelled at exit.
              </li>
            </ul>
          </section>
        </main>

        {/* ---------------- sticky visual column ---------------- */}
        <aside className="panel">
          <div className="ownership">
            <div className="big">
              <span className="bignum">{pct(finalSnap.founderPct)}</span>
              <span className="biglabel">founders, fully diluted, after {sc.events[sc.events.length - 1].label}</span>
            </div>
            <Sparkline
              values={sim.snapshots.map((s) => s.founderPct)}
              labels={sim.snapshots.map((s) => s.label)}
              current={idx}
              onPick={setStep}
            />
          </div>

          {note && (
            <p className="justhappened">
              <strong>{note.mechanic}</strong> — founders {pct(note.before)} → {pct(finalSnap.founderPct)}
              {Math.abs(delta) > 1e-9 && (
                <span className={delta < 0 ? 'down' : 'up'}>
                  {' '}
                  ({delta > 0 ? '+' : ''}
                  {(delta * 100).toFixed(2)} points)
                </span>
              )}
            </p>
          )}

          <div className="viz">
            <Sunburst rows={snap.rows} size={280} onHover={setHovered} />
            <div className="capsheet">
              <div className="capsheet-head">
                <span>{snap.label}</span>
                <span>{fmtShares(snap.totalShares)} shares</span>
              </div>
              <table className="captable">
                <tbody>
                  {snap.rows.map((r) => {
                    const sameGroup = snap.rows.filter((x) => x.group === r.group);
                    const gi = sameGroup.indexOf(r);
                    return (
                      <tr key={r.id} className={hovered === r.id ? 'hi' : ''}>
                        <td>
                          <span className="swatch" style={{ background: colourFor(r.group, gi) }} />
                          {r.name}
                        </td>
                        <td className="num strong">{pct(r.pct)}</td>
                        <td className="num dim">{fmtShares(r.shares)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {snap.pps !== null && (
                <div className="capsheet-foot">
                  {price(snap.pps, sc.currency)}/share · post-money {money(snap.postMoney ?? 0, sc.currency)}
                </div>
              )}
            </div>
          </div>

          <div className="exitwrap">
            <h3>Who gets what at exit</h3>
            <ExitChart
              state={finalSnap.state}
              maxExit={chartMax}
              exitValue={Math.min(sc.exitValue, chartMax)}
              currency={sc.currency}
              onExitChange={(v) => edit('exit value', (d) => { d.exitValue = v; })}
            />
          </div>
        </aside>
      </div>

      <footer>
        <p>
          Not investment, financial, tax or legal advice. A simplified model for teaching, not a substitute for your
          own counsel or a real cap table. Verify anything that matters against the actual documents.
        </p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StepBody({
  ev,
  sc,
  snap,
  edit,
  patch,
}: {
  ev: ScenarioEvent;
  sc: Scenario;
  snap: Snapshot;
  edit: (m: string, fn: (d: Scenario) => void) => void;
  patch: (id: string, m: string, p: Partial<PricedRoundEvent>) => void;
}) {
  const cur = sc.currency;

  if (ev.kind === 'founding') {
    return (
      <p className="field">
        {ev.founders.map((f, i) => (
          <span key={f.id}>
            {i > 0 && ' and '}
            {f.name} takes{' '}
            <DragNumber
              value={f.shares}
              min={100_000}
              max={20_000_000}
              step={5_000}
              label={`${f.name} shares`}
              format={(v) => fmtShares(v)}
              onChange={(v) =>
                edit('founder share split', (d) => {
                  const e = d.events.find((x) => x.id === ev.id) as typeof ev;
                  e.founders[i].shares = v;
                })
              }
            />{' '}
            shares
          </span>
        ))}
        , and{' '}
        <DragNumber
          value={ev.poolShares}
          min={0}
          max={5_000_000}
          step={2_000}
          label="Founding option pool"
          format={(v) => fmtShares(v)}
          onChange={(v) =>
            edit('founding option pool', (d) => {
              const e = d.events.find((x) => x.id === ev.id) as typeof ev;
              e.poolShares = v;
            })
          }
        />{' '}
        shares go into an option pool.
      </p>
    );
  }

  if (ev.kind === 'grant') {
    return (
      <p className="field">
        Grant{' '}
        <DragNumber
          value={ev.shares}
          min={0}
          max={3_000_000}
          step={2_000}
          label="Options granted"
          format={(v) => fmtShares(v)}
          onChange={(v) =>
            edit('employee option grant', (d) => {
              const e = d.events.find((x) => x.id === ev.id) as typeof ev;
              e.shares = v;
            })
          }
        />{' '}
        options from the pool to the team.
      </p>
    );
  }

  if (ev.kind === 'safe') {
    const e = ev as SafeEvent;
    return (
      <div className="safes">
        {e.safes.map((s, i) => (
          <p className="field" key={s.id}>
            <span className="who">{s.name}</span> puts in{' '}
            <DragNumber
              value={s.amount}
              min={10_000}
              max={20_000_000}
              step={1}
              log
              label={`${s.name} amount`}
              format={(v) => money(v, cur)}
              onChange={(v) =>
                edit('SAFE cheque size', (d) => {
                  const t = d.events.find((x) => x.id === ev.id) as SafeEvent;
                  t.safes[i].amount = v;
                })
              }
            />{' '}
            on a{' '}
            <Toggle
              value={s.type}
              options={[
                { value: 'post-money', label: 'post-money', title: 'YC 2018 safe: a fixed % of the company, protected from later SAFEs and from the pool top-up' },
                { value: 'pre-money', label: 'pre-money', title: 'YC 2013 safe: the cap is a pre-money number, and other converting SAFEs dilute this one' },
              ]}
              onChange={(v) =>
                edit('SAFE type (pre-money vs post-money)', (d) => {
                  const t = d.events.find((x) => x.id === ev.id) as SafeEvent;
                  t.safes[i].type = v;
                })
              }
            />{' '}
            SAFE
            {s.cap !== undefined ? (
              <>
                {' '}
                capped at{' '}
                <DragNumber
                  value={s.cap}
                  min={500_000}
                  max={500_000_000}
                  step={1}
                  log
                  label={`${s.name} cap`}
                  format={(v) => money(v, cur)}
                  onChange={(v) =>
                    edit('SAFE valuation cap', (d) => {
                      const t = d.events.find((x) => x.id === ev.id) as SafeEvent;
                      t.safes[i].cap = v;
                    })
                  }
                />
              </>
            ) : (
              <> with no cap</>
            )}
            {s.discount !== undefined && (
              <>
                {' '}
                and a{' '}
                <DragNumber
                  value={s.discount}
                  min={0}
                  max={0.5}
                  step={0.001}
                  label={`${s.name} discount`}
                  format={(v) => pct(v, 0)}
                  onChange={(v) =>
                    edit('SAFE discount', (d) => {
                      const t = d.events.find((x) => x.id === ev.id) as SafeEvent;
                      t.safes[i].discount = v;
                    })
                  }
                />{' '}
                discount
              </>
            )}
            {s.mfn && <span className="tag" title="Most-favoured nation: takes the best cap and discount in the stack">MFN</span>}
          </p>
        ))}
      </div>
    );
  }

  // priced round
  const r = ev as PricedRoundEvent;
  return (
    <div>
      <p className="field">
        Raise{' '}
        <DragNumber
          value={r.investment}
          min={100_000}
          max={300_000_000}
          step={1}
          log
          label="Investment"
          format={(v) => money(v, cur)}
          onChange={(v) => patch(r.id, 'round size', { investment: v })}
        />{' '}
        at a{' '}
        <DragNumber
          value={r.preMoney}
          min={500_000}
          max={2_000_000_000}
          step={1}
          log
          label="Pre-money valuation"
          format={(v) => money(v, cur)}
          onChange={(v) => patch(r.id, 'pre-money valuation', { preMoney: v })}
        />{' '}
        pre-money.
      </p>
      <p className="field">
        Option pool topped up to{' '}
        <DragNumber
          value={r.targetPoolPct}
          min={0}
          max={0.4}
          step={0.0006}
          label="Target option pool"
          format={(v) => pct(v, 1)}
          onChange={(v) => patch(r.id, 'option pool size', { targetPoolPct: v })}
        />{' '}
        of the post-round table, taken out of the{' '}
        <Toggle
          value={r.poolTiming}
          options={[
            { value: 'pre-money', label: 'pre-money', title: 'The pool shuffle: only existing holders pay for the new pool' },
            { value: 'post-money', label: 'post-money', title: 'The new investor is diluted by the pool alongside everyone else' },
          ]}
          onChange={(v) => patch(r.id, 'pool timing — the pool shuffle', { poolTiming: v })}
        />
        .
      </p>
      <p className="field">
        Preference:{' '}
        <DragNumber
          value={r.prefMultiple}
          min={0}
          max={4}
          step={0.005}
          label="Liquidation preference multiple"
          format={(v) => `${v.toFixed(2)}x`}
          onChange={(v) => patch(r.id, 'liquidation preference multiple', { prefMultiple: v })}
        />{' '}
        <Toggle
          value={r.participating ? 'yes' : 'no'}
          options={[
            { value: 'no', label: 'non-participating', title: 'Take the preference OR convert to common, whichever is worth more' },
            { value: 'yes', label: 'participating', title: 'Take the preference AND share the rest — the double dip' },
          ]}
          onChange={(v) => patch(r.id, 'participating vs non-participating preference', { participating: v === 'yes' })}
        />
        {r.participating && (
          <>
            {' '}
            capped at{' '}
            <DragNumber
              value={r.participationCap ?? 3}
              min={1}
              max={10}
              step={0.01}
              label="Participation cap"
              format={(v) => `${v.toFixed(1)}x`}
              onChange={(v) => patch(r.id, 'participation cap', { participationCap: v })}
            />
          </>
        )}
      </p>
      <p className="field">
        Earlier rounds carry{' '}
        <Toggle
          value={r.antiDilution ?? 'none'}
          options={[
            { value: 'none', label: 'no anti-dilution' },
            { value: 'broad-based', label: 'broad-based weighted average', title: 'On a down round, earlier preferred gets make-whole shares' },
          ]}
          onChange={(v) => patch(r.id, 'anti-dilution protection', { antiDilution: v })}
        />
        .
      </p>
      <RoundFacts r={r} sc={sc} snap={snap} />
    </div>
  );
}

function RoundFacts({ r, sc, snap }: { r: PricedRoundEvent; sc: Scenario; snap: Snapshot }) {
  // The solved round comes from the single simulate() the app already ran. It
  // used to re-run simulate() here, once per priced round, per render.
  const sol = snap.solution;
  if (!sol) return null;
  const effectivePre = sol.pps * (sol.preMoneyFD - (r.poolTiming === 'pre-money' ? sol.poolIncrease : 0));
  return (
    <dl className="facts">
      <div>
        <dt>Price per share</dt>
        <dd>{price(sol.pps, sc.currency)}</dd>
      </div>
      <div>
        <dt>Post-money</dt>
        <dd>{money(r.preMoney + r.investment, sc.currency)}</dd>
      </div>
      <div>
        <dt>Pool added</dt>
        <dd>{fmtShares(sol.poolIncrease)}</dd>
      </div>
      <div title="What the existing shareholders' stock was actually valued at, once the new pool is stripped out of the pre-money">
        <dt>Effective pre-money</dt>
        <dd className={effectivePre < r.preMoney * 0.999 ? 'bad' : ''}>{money(effectivePre, sc.currency)}</dd>
      </div>
      {sol.safeConversions.map((c) => (
        <div key={c.safeId} title={`Bound by its ${c.mechanism}`}>
          <dt>{c.name}</dt>
          <dd>
            {fmtShares(c.shares)} @ {price(c.pricePerShare, sc.currency)} <span className="dim">({c.mechanism})</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
