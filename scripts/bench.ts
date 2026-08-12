/**
 * How long does one frame of dragging cost?
 *
 * Dragging a number re-runs the whole pipeline: every event in the scenario is
 * re-simulated from scratch (there is no incremental state), the exit chart is
 * re-sampled at 145 exit values, and the crossover for every preferred class is
 * found by bisection on the waterfall. If that lot does not fit inside a 16 ms
 * frame the piece does not feel live, so we measure it rather than hope.
 *
 *   npm run bench
 */
import { simulate } from '../src/engine/simulate';
import { waterfall, waterfallCurve, crossoverFor } from '../src/engine/waterfall';
import { scenarios } from '../src/scenarios';

const REPEATS = 200;

function frame(sc: (typeof scenarios)[number]) {
  const sim = simulate(sc);
  const state = sim.final.state;
  const maxExit = sc.exitValue * 2.5;
  waterfallCurve(state, maxExit, 145, maxExit / 400);
  waterfall(state, sc.exitValue);
  for (const p of state.preferred) crossoverFor(state, p.id, maxExit * 4);
  return sim.final.totalShares;
}

console.log(`one full recompute of a whole scenario, ${REPEATS} repeats each\n`);
let worstAll = 0;
for (const sc of scenarios) {
  frame(sc); // warm up the JIT
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    frame(sc);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const worst = times[times.length - 1];
  worstAll = Math.max(worstAll, worst);
  console.log(
    `  ${sc.title.padEnd(22)} median ${median.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms · worst ${worst.toFixed(2)} ms`,
  );
}
console.log(`\n  budget for 60 fps is 16.67 ms; worst observed ${worstAll.toFixed(2)} ms`);
