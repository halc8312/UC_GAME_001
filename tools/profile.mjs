/**
 * Performance and memory profiling.
 *
 * Runs the shipped build under real requestAnimationFrame pacing (not manual
 * stepping) so frame timings are genuine, then does a 3-minute combat soak while
 * sampling the JS heap.
 *
 * IMPORTANT: the CI browser renders through SwiftShader, a software rasteriser.
 * GPU-side numbers here are a pessimistic lower bound and are labelled as such.
 * CPU simulation time, draw calls, triangle counts and heap behaviour are
 * hardware-independent and are the binding budgets from GAME_SPEC §2.
 *
 * Usage: node tools/profile.mjs [--soak 180] [--scene-seconds 20]
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};

const SOAK_SECONDS = opt('soak', 180);
const SCENE_SECONDS = opt('scene-seconds', 20);
const PORT = opt('port', 4173);

await mkdir('artifacts/perf', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', cleanup);
await sleep(1500);

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--js-flags=--expose-gc',
    // Without this, performance.memory.usedJSHeapSize is bucketed and cached for
    // ~20 minutes as an anti-fingerprinting measure, so a three-minute soak
    // reports the same value at every sample and a leak is undetectable. The
    // first run of this profiler printed 24.8 MB thirty-six times in a row.
    '--enable-precise-memory-info',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90000 });

const env = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    heapLimitMB: performance.memory ? +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) : null,
  };
});
console.log('renderer:', env.renderer);

/**
 * Let the page run under real rAF for `seconds` with a given input frame, then
 * return the metrics summary.
 */
async function measure(name, { checkpoint, at, look, frame = {}, seconds }) {
  await page.evaluate(([cp, at, look, f]) => {
    window.__UC.startMission(cp);
    window.__UC.seed(31337);
    if (at) window.__UC.teleport(at[0], at[1], at[2], look ? look[0] : undefined);
    if (look) window.__UC.look(look[0], look[1]);
    window.__UC.input(f);
    window.__UC.resetMetrics();
  }, [checkpoint, at, look, frame]);

  await sleep(1200);               // let the scene settle and shaders compile
  await page.evaluate(() => window.__UC.resetMetrics());
  await sleep(seconds * 1000);

  const m = await page.evaluate(() => window.__UC.metrics());
  const s = await page.evaluate(() => window.__UC.state());
  console.log(
    `${name}: fps ${m.fps.mean} | frame p95 ${m.frameMs.p95}ms | step ${m.simMs.mean}ms ` +
    `p95 ${m.simMs.p95}ms | sim/frame ${m.simFrameMs.mean}ms (${m.stepsPerFrame.mean} steps) | ` +
    `draws ${m.drawCalls} | tris ${m.triangles} | enemies ${s.enemies.alive}`,
  );
  return { name, metrics: m, enemiesAlive: s.enemies.alive, phase: s.phase };
}

const scenes = [];

scenes.push(await measure('dock_approach', {
  checkpoint: 0, look: [0, -0.03], frame: { moveZ: 1 }, seconds: SCENE_SECONDS,
}));

scenes.push(await measure('pump_hall_firefight', {
  checkpoint: 1, at: [-1, 0.1, 18], look: [0.05, -0.02],
  frame: { moveZ: 1, fire: true }, seconds: SCENE_SECONDS,
}));

scenes.push(await measure('server_room', {
  checkpoint: 2, at: [-8, 0.1, -26], look: [Math.PI / 2, -0.02],
  frame: { fire: true }, seconds: SCENE_SECONDS,
}));

// The heaviest view in the game: eight contractors, alarm strobes, open exterior.
scenes.push(await measure('extraction_hold_heaviest', {
  checkpoint: 4, at: [37, 6.5, 1], look: [-2.4, -0.05],
  frame: { fire: true }, seconds: SCENE_SECONDS + 10,
}));

// ---------------------------------------------------------------------------
// Frame-time distribution.
//
// The per-scene windows above run 20-30 s each, which at ~3 s a frame under
// SwiftShader is five to eleven samples — enough for a mean, nowhere near enough
// to quote a p99 from. This window sits on the heaviest scene and does nothing
// but let real frames accumulate until there are enough of them to describe a
// distribution. It is slow on purpose; the sample count is reported alongside
// the percentiles so the number can be judged rather than trusted.
// ---------------------------------------------------------------------------

const DIST_SECONDS = opt('dist-seconds', 200);
console.log(`\nframe-time distribution: ${DIST_SECONDS}s on the heaviest scene…`);
await page.evaluate(() => {
  window.__UC.startMission(0);
  window.__UC.seed(4242);
  window.__UC.look(0, -0.03);
  window.__UC.input({ moveZ: 1 });
});
await sleep(3000);
await page.evaluate(() => window.__UC.resetMetrics());
await sleep(DIST_SECONDS * 1000);
const distribution = await page.evaluate(() => {
  const m = window.__UC.metrics();
  return { samples: m.samples, frameMs: m.frameMs, fps: m.fps, renderMs: m.renderMs };
});
console.log(
  `  ${distribution.samples} frames | p50 ${distribution.frameMs.p50}ms ` +
  `p95 ${distribution.frameMs.p95}ms p99 ${distribution.frameMs.p99}ms ` +
  `max ${distribution.frameMs.max}ms | fps ${distribution.fps.mean}`,
);

// ---------------------------------------------------------------------------
// Soak: continuous combat, sampling the heap.
// ---------------------------------------------------------------------------

/*
 * The soak has to be three minutes of *gameplay*, not three minutes of wall
 * clock.
 *
 * Left to run on rAF alone under SwiftShader, a frame takes ~2.7 s and the loop
 * caps catch-up at 5 fixed steps, so 180 s of waiting advanced the mission by
 * 0.8 seconds — it soaked the rasteriser and proved nothing about the
 * simulation, which is where the leaks would actually be (effect pools, enemy
 * spawns, audio voices, event logs). So each sample window sleeps to let real
 * frames render *and* drives the simulation forward explicitly, giving a full
 * SOAK_SECONDS of mission time with rendering happening throughout.
 */
console.log(`\nsoak: ${SOAK_SECONDS}s of continuous combat (simulated time, rendered throughout)…`);
await page.evaluate(() => {
  window.__UC.startMission(4);
  window.__UC.seed(9001);
  window.__UC.teleport(37, 6.5, 1, -Math.PI / 2);
  window.__UC.input({ fire: true, moveX: 1 });
  window.__UC.resetMetrics();
});

const samples = [];
const sampleEvery = 5;
let simulatedSeconds = 0;
for (let t = 0; t < SOAK_SECONDS; t += sampleEvery) {
  await sleep(2000); // real frames, so the render path is exercised too
  const sample = await page.evaluate((stepSeconds) => {
    const g = window.__UC;
    // Keep the fight alive for the whole soak rather than running out of targets.
    const st = g.state();
    if (st.enemies.alive === 0) g.setPhase('extraction');
    if (st.player.hp < 40) g.startMission(4);

    // Advance in one-second slices, re-aiming at the nearest live contractor
    // each time. Firing on a fixed heading is not a combat soak: it produced
    // 180 seconds and zero kills, so nothing ever died, respawned, or churned
    // the effect pools — exactly the paths a leak would hide in.
    for (let i = 0; i < stepSeconds; i++) {
      const s = g.state();
      const live = s.enemies.states.filter((e) => !e.dead);
      if (live.length) {
        live.sort((a, b) =>
          Math.hypot(a.x - s.player.x, a.z - s.player.z) -
          Math.hypot(b.x - s.player.x, b.z - s.player.z));
        const tgt = live[0];
        const d = Math.hypot(tgt.x - s.player.x, tgt.z - s.player.z);
        g.look(
          Math.atan2(-(tgt.x - s.player.x), -(tgt.z - s.player.z)),
          Math.atan2((tgt.y + 1.2) - (s.player.y + 1.62), Math.max(1, d)),
        );
      }
      // Strafe direction flips so the player keeps moving and the AI keeps repathing.
      g.input({ fire: true, moveX: i % 2 === 0 ? 1 : -1 });
      g.step(1000);
    }
    const after = g.state();
    const m = g.metrics();
    return {
      atSeconds: +after.missionTime.toFixed(1),
      heapMB: m.heapMB,
      drawCalls: m.drawCalls,
      triangles: m.triangles,
      geometries: m.geometries,
      textures: m.textures,
      programs: m.programs,
      simMean: m.simMs.mean,
      fps: m.fps.mean,
      enemiesAlive: after.enemies.alive,
      enemiesKilled: after.enemies.killed,
      pools: m.pools,
      // Voices are reaped against the real AudioContext clock, but step() runs
      // simulated seconds in milliseconds of wall clock, so the 24-voice pool
      // saturates and drops under manual stepping. That is an artefact of
      // stepping, not a leak, and it cannot happen in play where simulated and
      // wall time advance together. Recorded rather than hidden.
      audioVoices: m.audio.activeVoices,
      audioDropped: m.audio.dropped,
      audioEvents: m.audio.events,
    };
  }, sampleEvery);
  simulatedSeconds += sampleEvery;
  samples.push(sample);
  process.stdout.write(
    `  sim t+${simulatedSeconds}s heap ${sample.heapMB ?? 'n/a'}MB draws ${sample.drawCalls} ` +
    `tris ${sample.triangles} geo ${sample.geometries} tex ${sample.textures} ` +
    `kills ${sample.enemiesKilled} voices ${sample.audioVoices}\n`,
  );
}

const soakMetrics = await page.evaluate(() => window.__UC.metrics());
const finalState = await page.evaluate(() => window.__UC.state());
const runtimeErrors = await page.evaluate(() => window.__UC.errors());

/** Least-squares slope of heap over time, in MB/minute. */
function heapTrend(list) {
  const pts = list.filter((s) => typeof s.heapMB === 'number');
  if (pts.length < 3) return null;
  const n = pts.length;
  const xs = pts.map((_, i) => i * sampleEvery);
  const ys = pts.map((s) => s.heapMB);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : +((num / den) * 60).toFixed(3);
}

const heaps = samples.map((s) => s.heapMB).filter((v) => typeof v === 'number');
const heaviest = scenes.reduce((a, b) =>
  (b.metrics.drawCalls > a.metrics.drawCalls ? b : a), scenes[0]);

const budgets = {
  drawCalls: { budget: 260, measured: Math.max(...scenes.map((s) => s.metrics.drawCalls)) },
  triangles: { budget: 400_000, measured: Math.max(...scenes.map((s) => s.metrics.triangles)) },
  // GAME_SPEC's 4 ms budget is the cost of one 60 Hz simulation step, which is
  // what a frame contains at the target frame rate. simFrameMs is reported for
  // context but deliberately not gated: under SwiftShader the loop runs five
  // catch-up steps per rendered frame, so gating on it would score the
  // rasteriser rather than the simulation.
  simMsMean: { budget: 4.0, measured: Math.max(...scenes.map((s) => s.metrics.simMs.mean)) },
  heapMB: { budget: 220, measured: heaps.length ? Math.max(...heaps) : null },
};
for (const [k, v] of Object.entries(budgets)) {
  v.pass = v.measured === null ? null : v.measured <= v.budget;
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: env,
  caveat:
    'Rendered through SwiftShader (software WebGL). renderMs and fps are a pessimistic ' +
    'lower bound and must not be read as GPU performance. simMs, drawCalls, triangles ' +
    'and heapMB are hardware-independent.',
  scenes,
  frameTimeDistribution: distribution,
  heaviestScene: heaviest.name,
  soak: {
    seconds: SOAK_SECONDS,
    simulatedSeconds,
    combatKills: samples[samples.length - 1]?.enemiesKilled ?? null,
    audioEvents: samples[samples.length - 1]?.audioEvents ?? null,
    sampleEverySeconds: sampleEvery,
    samples,
    frameMs: soakMetrics.frameMs,
    simMs: soakMetrics.simMs,
    renderMs: soakMetrics.renderMs,
    fps: soakMetrics.fps,
    heapStartMB: heaps[0] ?? null,
    heapEndMB: heaps[heaps.length - 1] ?? null,
    heapPeakMB: heaps.length ? Math.max(...heaps) : null,
    heapTrendMBPerMinute: heapTrend(samples),
    geometriesStart: samples[0]?.geometries ?? null,
    geometriesEnd: samples[samples.length - 1]?.geometries ?? null,
    texturesStart: samples[0]?.textures ?? null,
    texturesEnd: samples[samples.length - 1]?.textures ?? null,
    // Non-zero here and zero in every real-time scene window, for the same
    // reason the audio pool drops: transient effects are aged on the render
    // path, and manual stepping spawns a simulated second's worth of decals,
    // sparks and tracers between two rendered frames. In play, where renders
    // and steps advance together, the pools never starve — the scene windows
    // above are the evidence for that.
    poolStarvation: samples[samples.length - 1]?.pools?.starved ?? null,
    poolStarvationInRealtimeScenes: scenes.map((s) => s.metrics.pools?.starved ?? 0),
    finalPhase: finalState.phase,
  },
  budgets,
  problems,
  runtimeErrors,
};

await writeFile('artifacts/perf/performance.json', JSON.stringify(report, null, 2));

console.log('\n--- budgets ---');
for (const [k, v] of Object.entries(budgets)) {
  console.log(`${k}: ${v.measured} / ${v.budget} -> ${v.pass === null ? 'n/a' : v.pass ? 'PASS' : 'FAIL'}`);
}
console.log('heap start/end/peak MB:', report.soak.heapStartMB, report.soak.heapEndMB, report.soak.heapPeakMB);
console.log('heap trend MB/min:', report.soak.heapTrendMBPerMinute);
console.log('geometries start/end:', report.soak.geometriesStart, report.soak.geometriesEnd);
console.log('problems:', problems.length ? problems.slice(0, 10) : '(none)');

await browser.close();
cleanup();
process.exit(0);
