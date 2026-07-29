/**
 * Screenshot capture for every mission beat.
 *
 * Boots the production build in headless Chromium, drives the real game through
 * `window.__UC`, and writes PNGs into artifacts/screenshots/. Every shot is taken
 * after stepping the real simulation, so what is captured is what plays.
 *
 * Each beat re-enters from a checkpoint before posing the camera, so state never
 * leaks between shots (an earlier version let a death in one beat poison the next
 * six captures).
 *
 * Usage: node tools/capture.mjs [--prefix m1] [--width 1280] [--height 720]
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const PREFIX = opt('prefix', 'beat');
const WIDTH = Number(opt('width', 1280));
const HEIGHT = Number(opt('height', 720));
const OUT = opt('out', 'artifacts/screenshots');
const PORT = Number(opt('port', 4173));
const URL = `http://127.0.0.1:${PORT}/`;

await mkdir(OUT, { recursive: true });
await mkdir('artifacts/logs', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});
const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', cleanup);
await sleep(1500);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

const consoleLog = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleLog.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => consoleLog.push(`[requestfailed] ${r.url()}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90000 });

const captured = [];

/**
 * Settle two rendered frames, then grab the canvas.
 *
 * The default 30 s screenshot timeout is not enough here: on the open exterior
 * beats SwiftShader can take several seconds per frame, and `page.screenshot()`
 * has to wait for a composited one behind whatever the rAF loop is already
 * rasterising. `beat-13-helipad-hold` — eight contractors, alarm strobes and the
 * sky dome — blew through it and killed the whole run at beat 13 of 25. The
 * timeout is raised and a single retry added rather than lowering the visual
 * fidelity of the capture.
 */
const shot = async (name) => {
  const file = `${OUT}/${PREFIX}-${name}.png`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: file, timeout: 180_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.log(`  retrying ${name} after: ${err.message.split('\n')[0]}`);
      await sleep(2000);
    }
  }
  captured.push(file);
  console.log('captured', file);
  return file;
};

/**
 * Enter a beat from a checkpoint, pose the camera, then run a script of
 * (inputFrame, milliseconds) pairs through the real simulation.
 *
 * `hold` keeps an input frame installed through the screenshot. Without it the
 * harness clears input before shooting, and any state driven by a held key —
 * ADS above all — decays during the two settle frames, so the capture shows a
 * hipfire pose while claiming to document aiming.
 */
const beat = async ({ checkpoint = 0, at, look, script = [], seed = 1337, hold = null }) => {
  await page.evaluate(([cp, at, look, script, seed, hold]) => {
    const g = window.__UC;
    g.startMission(cp);
    g.seed(seed);
    g.step(250);
    if (at) g.teleport(at[0], at[1], at[2], look ? look[0] : undefined);
    if (look) g.look(look[0], look[1]);
    g.input({});
    g.step(120);
    for (const [frame, ms] of script) {
      g.input(frame);
      g.step(ms);
    }
    g.input(hold || {});
    g.step(60);
  }, [checkpoint, at, look, script, seed, hold]);
};

/**
 * Close with the nearest live contractor, aim at it and fire.
 *
 * Screenshots of a "firefight" with no enemy in frame prove nothing about combat
 * readability, so the combat beats hunt for a target before shooting instead of
 * spraying at a fixed heading.
 */
const engage = async ({ approachMs = 4000, fireMs = 700 } = {}) => {
  let elapsed = 0;
  while (elapsed < approachMs) {
    const st = await page.evaluate(() => window.__UC.state());
    const live = st.enemies.states.filter((e) => !e.dead);
    if (!live.length) break;
    live.sort((a, b) =>
      Math.hypot(a.x - st.player.x, a.z - st.player.z) - Math.hypot(b.x - st.player.x, b.z - st.player.z));
    const t = live[0];
    const dist = Math.hypot(t.x - st.player.x, t.z - st.player.z);
    const yaw = Math.atan2(-(t.x - st.player.x), -(t.z - st.player.z));
    const pitch = Math.atan2((t.y + 1.2) - (st.player.y + 1.62), Math.max(1, dist));
    await page.evaluate(([y, p]) => window.__UC.look(y, p), [yaw, pitch]);
    if (t.visible && dist < 22) {
      // Fire, then advance only a couple of frames before returning, so the
      // muzzle flash, tracer and impact are still alive when the screenshot is
      // taken. Burning the whole burst first produced "firefight" captures with
      // no combat feedback anywhere in frame.
      await page.evaluate((ms) => {
        window.__UC.input({ fire: true, aim: true });
        window.__UC.step(ms);
        window.__UC.step(24);
      }, fireMs);
      return true;
    }
    await page.evaluate(() => {
      window.__UC.input({ moveZ: 1 });
      window.__UC.step(300);
    });
    elapsed += 300;
  }
  // Nothing reachable: still fire so the muzzle flash and tracer are captured.
  await page.evaluate((ms) => {
    window.__UC.input({ fire: true });
    window.__UC.step(ms);
    window.__UC.step(24);
  }, fireMs);
  return false;
};

const S = Math.PI;      // south (+Z)
const N = 0;            // north (-Z)
const E = -Math.PI / 2; // east (+X)
const W = Math.PI / 2;  // west (-X)

// --- 01 main menu -----------------------------------------------------------
await page.evaluate(() => window.__UC.showScreen('menu'));
await sleep(400);
await shot('01-main-menu');

// --- 02 briefing ------------------------------------------------------------
await page.evaluate(() => window.__UC.showScreen('briefing'));
await sleep(250);
await shot('02-briefing');

// --- 03 dock approach -------------------------------------------------------
await beat({ checkpoint: 0, look: [N, -0.03] });
await shot('03-dock-approach');

// --- 04 dock advance --------------------------------------------------------
await beat({ checkpoint: 0, look: [N, -0.02], script: [[{ moveZ: 1 }, 2400]] });
await shot('04-dock-advance');

// --- 05 apron, first contact ------------------------------------------------
await beat({ checkpoint: 0, at: [1.5, 0.1, 36], look: [-0.35, -0.02] });
await engage({ approachMs: 6000, fireMs: 500 });
await shot('05-apron-contact');

// --- 06 pump hall -----------------------------------------------------------
await beat({ checkpoint: 1, at: [1, 0.1, 25], look: [0.12, -0.05], script: [[{ moveZ: 1 }, 900]] });
await shot('06-pump-hall');

// --- 07 pump hall firefight -------------------------------------------------
await beat({ checkpoint: 1, at: [-1, 0.1, 22], look: [0.05, -0.02], script: [[{}, 1200]] });
await engage({ approachMs: 9000, fireMs: 800 });
await shot('07-pump-hall-firefight');

// --- 08 breaker interaction -------------------------------------------------
// Backed off from 1.2 m to 2.2 m: pressed against the wall, a single sodium lamp
// blew the concrete out to a flat tan field that filled the frame.
await beat({ checkpoint: 1, at: [-17.2, 0.1, 12.9], look: [W - 0.34, -0.05] });
await shot('08-breaker-prompt');

// --- 09 server room ---------------------------------------------------------
await beat({ checkpoint: 2, at: [-1, 0.1, -19], look: [0.5, -0.04], script: [[{}, 900]] });
await engage({ approachMs: 9000, fireMs: 700 });
await shot('09-server-room');

// --- 10 data core -----------------------------------------------------------
await beat({
  checkpoint: 2, at: [-10, 0.1, -28.2], look: [N, -0.14],
  script: [[{ interactHeld: true }, 1500]],
});
await shot('10-data-core-hold');

// --- 11 alarm, catwalk ------------------------------------------------------
await beat({ checkpoint: 3, at: [21.8, 6.5, -23], look: [E, -0.05], script: [[{}, 700]] });
await shot('11-alarm-catwalk');

// --- 12 catwalk battle ------------------------------------------------------
await beat({ checkpoint: 3, at: [28, 6.5, -20], look: [S, -0.03], script: [[{}, 600]] });
await engage({ approachMs: 9000, fireMs: 800 });
await shot('12-catwalk-battle');

// --- 13 helipad extraction --------------------------------------------------
await beat({ checkpoint: 4, at: [37, 6.5, 2], look: [-2.35, -0.06], script: [[{}, 1200]] });
await engage({ approachMs: 9000, fireMs: 900 });
await shot('13-helipad-hold');

// --- 14 shotgun -------------------------------------------------------------
await beat({ checkpoint: 2, at: [-6, 0.1, -24], look: [W, -0.03], script: [[{ slot: 1 }, 900]] });
await engage({ approachMs: 7000, fireMs: 240 });
await shot('14-shotgun');

// --- 14b muzzle flash, tracer and impact, caught mid-burst -------------------
await beat({ checkpoint: 1, at: [-1, 0.1, 20], look: [0.05, -0.02], script: [[{}, 900]] });
await engage({ approachMs: 9000, fireMs: 120 });
await shot('14b-muzzle-flash');

// --- 15 aim down sights -----------------------------------------------------
await beat({
  checkpoint: 1, at: [0, 0.1, 22], look: [0.05, -0.02],
  script: [[{ aim: true }, 600]], hold: { aim: true },
});
await shot('15-ads');

// --- 16 damaged / low health ------------------------------------------------
await beat({ checkpoint: 1, at: [-2, 0.1, 18], look: [0.1, -0.03] });
await page.evaluate(() => {
  window.__UC.hurt(74);
  window.__UC.step(180);
});
await sleep(700); // let the desaturation transition settle before the shot
await shot('16-low-health');

// --- 17 pause ---------------------------------------------------------------
await beat({ checkpoint: 1, at: [0, 0.1, 20], look: [0.05, -0.03] });
await page.evaluate(() => window.__UC.pause());
await sleep(250);
await shot('17-pause');

// --- 18 settings ------------------------------------------------------------
await page.evaluate(() => window.__UC.showScreen('settings'));
await sleep(250);
await shot('18-settings');

// --- 19 controls ------------------------------------------------------------
await page.evaluate(() => window.__UC.showScreen('controls'));
await sleep(250);
await shot('19-controls');

// --- 20 death ---------------------------------------------------------------
await page.evaluate(() => window.__UC.resume());
await beat({ checkpoint: 1, at: [-1, 0.1, 16], look: [0.06, -0.03] });
await page.evaluate(() => {
  window.__UC.hurt(500);
  window.__UC.step(600);
  window.__UC.showScreen('death');
});
await sleep(350);
await shot('20-death');

// --- 21 results (a real extraction hold, not a forced screen) ---------------
const finished = await page.evaluate(async () => {
  const g = window.__UC;
  g.startMission(4);
  g.step(300);
  g.teleport(37, 6.5, 1, -Math.PI / 2);
  // Survive the hold: clear each wave as it arrives.
  for (let i = 0; i < 60; i++) {
    g.killAllEnemies();
    g.input({});
    g.step(1000);
    if (g.state().finished) break;
  }
  return g.state();
});
await sleep(500);
await shot('21-results');
console.log('mission completed by surviving the hold:', finished.finished, '| result:', JSON.stringify(finished.result));

// --- 22 reduced-flash accessibility comparison ------------------------------
await beat({ checkpoint: 3, at: [28, 6.5, -14], look: [S, -0.04], script: [[{}, 600]] });
await shot('22-alarm-normal');
// Reduced flash on its own: strobes and the edge vignette hold steady instead of
// pulsing. Screen effects stay on so the pair differs only in motion.
await page.evaluate(() => window.__UC.settings({ reducedFlash: true }));
await page.evaluate(() => window.__UC.step(300));
await sleep(250);
await shot('22-alarm-reduced-flash');
await page.evaluate(() => window.__UC.settings({ reducedFlash: true, screenEffects: false }));
await page.evaluate(() => window.__UC.step(300));
await sleep(250);
await shot('22-alarm-no-screen-effects');
await page.evaluate(() => window.__UC.settings({ reducedFlash: false, screenEffects: true }));

const report = {
  capturedAt: new Date().toISOString(),
  viewport: { width: WIDTH, height: HEIGHT },
  files: captured,
  console: consoleLog,
  missionCompleted: finished.finished,
  result: finished.result,
  metrics: await page.evaluate(() => window.__UC.metrics()),
  errors: await page.evaluate(() => window.__UC.errors()),
};
await writeFile(`artifacts/logs/capture-${PREFIX}.json`, JSON.stringify(report, null, 2));

console.log('\nconsole output during capture:');
console.log(consoleLog.length ? [...new Set(consoleLog)].slice(0, 30).join('\n') : '(clean)');
console.log('runtime errors:', JSON.stringify(report.errors));

await browser.close();
cleanup();
process.exit(0);
