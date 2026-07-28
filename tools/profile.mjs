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
    `${name}: fps ${m.fps.mean} | frame p95 ${m.frameMs.p95}ms | sim mean ${m.simMs.mean}ms ` +
    `p95 ${m.simMs.p95}ms | draws ${m.drawCalls} | tris ${m.triangles} | enemies ${s.enemies.alive}`,
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
// Soak: continuous combat, sampling the heap.
// ---------------------------------------------------------------------------

console.log(`\nsoak: ${SOAK_SECONDS}s of continuous combat…`);
await page.evaluate(() => {
  window.__UC.startMission(4);
  window.__UC.seed(9001);
  window.__UC.teleport(37, 6.5, 1, -Math.PI / 2);
  window.__UC.input({ fire: true, moveX: 1 });
  window.__UC.resetMetrics();
});

const samples = [];
const sampleEvery = 5;
for (let t = 0; t < SOAK_SECONDS; t += sampleEvery) {
  await sleep(sampleEvery * 1000);
  const sample = await page.evaluate(() => {
    const g = window.__UC;
    // Keep the fight alive for the whole soak rather than running out of targets.
    const st = g.state();
    if (st.enemies.alive === 0) g.setPhase('extraction');
    if (st.player.hp < 40) g.startMission(4);
    // Strafe direction flips so the player keeps moving and the AI keeps repathing.
    g.input({ fire: true, moveX: Math.sin(Date.now() / 3000) > 0 ? 1 : -1 });
    const m = g.metrics();
    return {
      atSeconds: +st.missionTime.toFixed(1),
      heapMB: m.heapMB,
      drawCalls: m.drawCalls,
      triangles: m.triangles,
      geometries: m.geometries,
      textures: m.textures,
      programs: m.programs,
      simMean: m.simMs.mean,
      fps: m.fps.mean,
      enemiesAlive: st.enemies.alive,
      pools: m.pools,
      audioVoices: m.audio.activeVoices,
    };
  });
  samples.push(sample);
  process.stdout.write(
    `  t+${t + sampleEvery}s heap ${sample.heapMB ?? 'n/a'}MB draws ${sample.drawCalls} ` +
    `tris ${sample.triangles} geo ${sample.geometries} tex ${sample.textures}\n`,
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
  heaviestScene: heaviest.name,
  soak: {
    seconds: SOAK_SECONDS,
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
    poolStarvation: samples[samples.length - 1]?.pools?.starved ?? null,
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
