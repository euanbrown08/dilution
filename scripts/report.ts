/**
 * Prints every bundled scenario through the engine, so the maths can be
 * inspected without opening a browser. Deterministic; no network.
 *   npm run report
 */
import { simulate } from '../src/engine/simulate';
import { waterfall, crossoverFor } from '../src/engine/waterfall';
import { scenarios } from '../src/scenarios';

const nf = new Intl.NumberFormat('en-GB');
const sh = (n: number) => nf.format(Math.round(n)).padStart(12);
const pc = (n: number) => `${(n * 100).toFixed(2)}%`.padStart(8);

function money(n: number, cur: string) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${cur}${(n / 1e9).toFixed(2)}bn`;
  if (a >= 1e6) return `${cur}${(n / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${cur}${(n / 1e3).toFixed(0)}k`;
  return `${cur}${n.toFixed(0)}`;
}

function rule(ch = '-') {
  console.log(ch.repeat(78));
}

for (const sc of scenarios) {
  rule('=');
  console.log(`SCENARIO: ${sc.title}`);
  rule('=');
  const sim = simulate(sc);
  for (const snap of sim.snapshots) {
    console.log(`\n[${snap.label}]  total shares ${sh(snap.totalShares).trim()}`);
    if (snap.solution) {
      const s = snap.solution;
      console.log(
        `  price ${sc.currency}${s.pps.toFixed(4)}/share · post-money ${money(snap.postMoney!, sc.currency)}` +
          ` · pool added ${nf.format(Math.round(s.poolIncrease))}` +
          ` · solver ${s.iterations} passes, residual ${s.residual.toExponential(1)}` +
          (s.converged ? '' : '  *** DID NOT CONVERGE ***'),
      );
      if (s.warnings.length) console.log(`    warnings: ${s.warnings.join(', ')}`);
      for (const c of s.safeConversions) {
        console.log(
          `    SAFE ${c.name}: ${nf.format(Math.round(c.shares))} shares @ ${sc.currency}${c.pricePerShare.toFixed(4)}` +
            ` (${c.type}, bound by ${c.mechanism})`,
        );
      }
    }
    for (const r of snap.rows) {
      console.log(`   ${r.name.padEnd(34).slice(0, 34)} ${pc(r.pct)} ${sh(r.shares)}`);
    }
    console.log(`   ${'-> founders, fully diluted'.padEnd(34)} ${pc(snap.founderPct)}`);
  }

  rule();
  console.log(`EXIT WATERFALL at ${money(sc.exitValue, sc.currency)}`);
  const w = waterfall(sim.final.state, sc.exitValue);
  console.log(`   ${'holder'.padEnd(34)} ${'owns'.padStart(8)} ${'receives'.padStart(14)} ${'% of exit'.padStart(9)}   treatment`);
  for (const l of w.lines) {
    console.log(
      `   ${l.name.padEnd(34).slice(0, 34)} ${pc(l.pctOwned)} ${money(l.proceeds, sc.currency).padStart(14)} ${pc(l.pctProceeds)}   ${l.treatment}`,
    );
  }
  const paidOut = w.lines.reduce((a, l) => a + l.proceeds, 0);
  console.log(`   check: paid out ${money(paidOut, sc.currency)} of ${money(sc.exitValue, sc.currency)}`);
  for (const p of sim.final.state.preferred) {
    const x = crossoverFor(sim.final.state, p.id, sc.exitValue * 20);
    console.log(
      `   crossover for ${p.name}: ${x === null ? 'never converts (participating, uncapped)' : money(x, sc.currency)}`,
    );
  }
  console.log('');
}
