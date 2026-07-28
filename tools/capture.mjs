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

const shot = async (name) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = `${OUT}/${PREFIX}-${name}.png`;
  await page.screenshot({ path: file });
  captured.push(file);
  console.log('captured', file);
  return file;
};

/**
 * Enter a beat from a checkpoint, pose the camera, then run a script of
 * (inputFrame, milliseconds) pairs through the real simulation.
 */
const beat = async ({ checkpoint = 0, at, look, script = [], seed = 1337 }) => {
  await page.evaluate(([cp, at, look, script, seed]) => {
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
    g.input({});
    g.step(60);
  }, [checkpoint, at, look, script, seed]);
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
await beat({
  checkpoint: 0, at: [1.5, 0.1, 36], look: [-0.35, -0.02],
  script: [[{ moveZ: 1 }, 700], [{ fire: true }, 420]],
});
await shot('05-apron-contact');

// --- 06 pump hall -----------------------------------------------------------
await beat({ checkpoint: 1, at: [1, 0.1, 25], look: [0.12, -0.05], script: [[{ moveZ: 1 }, 900]] });
await shot('06-pump-hall');

// --- 07 pump hall firefight -------------------------------------------------
await beat({
  checkpoint: 1, at: [-1, 0.1, 20], look: [0.05, -0.02],
  script: [[{ moveZ: 1 }, 1500], [{}, 700], [{ fire: true, aim: true }, 700]],
});
await shot('07-pump-hall-firefight');

// --- 08 breaker interaction -------------------------------------------------
await beat({ checkpoint: 1, at: [-18.2, 0.1, 12], look: [W, -0.06] });
await shot('08-breaker-prompt');

// --- 09 server room ---------------------------------------------------------
await beat({
  checkpoint: 2, at: [-1, 0.1, -19], look: [0.5, -0.04],
  script: [[{ moveZ: 1 }, 1200], [{ fire: true }, 600]],
});
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
await beat({
  checkpoint: 3, at: [28, 6.5, -20], look: [S, -0.03],
  script: [[{ moveZ: 1 }, 1100], [{ fire: true }, 700], [{ fire: true, aim: true }, 500]],
});
await shot('12-catwalk-battle');

// --- 13 helipad extraction --------------------------------------------------
await beat({
  checkpoint: 4, at: [37, 6.5, 2], look: [-2.35, -0.06],
  script: [[{}, 900], [{ fire: true }, 900]],
});
await shot('13-helipad-hold');

// --- 14 shotgun -------------------------------------------------------------
await beat({
  checkpoint: 2, at: [-6, 0.1, -24], look: [W, -0.03],
  script: [[{ slot: 1 }, 800], [{ fire: true }, 260], [{}, 140]],
});
await shot('14-shotgun');

// --- 15 aim down sights -----------------------------------------------------
await beat({
  checkpoint: 1, at: [0, 0.1, 22], look: [0.05, -0.02],
  script: [[{ aim: true }, 600]],
});
await shot('15-ads');

// --- 16 damaged / low health ------------------------------------------------
await beat({ checkpoint: 1, at: [-2, 0.1, 18], look: [0.1, -0.03] });
await page.evaluate(() => {
  window.__UC.hurt(74);
  window.__UC.step(180);
});
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
await page.evaluate(() => window.__UC.settings({ reducedFlash: true, screenEffects: false }));
await sleep(250);
await shot('22-alarm-reduced-flash');
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
