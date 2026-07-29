/** Ad-hoc probe. Not part of the verification suite; overwritten freely. */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4177;
const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
await sleep(2200);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90000 });

// Play with the real mouse: no synthetic frames anywhere in this probe.
await page.click('#btn-start');
await page.click('#btn-deploy');
await page.waitForFunction(() => window.__UC.state().phase === 'approach');

// Deploying already took the pointer lock (the deploy click is the user gesture).
await sleep(500);
const locked = await page.evaluate(() => ({
  pointerLockElement: document.pointerLockElement?.tagName ?? null,
  inputLocked: window.__UC_APP.input.locked,
}));
console.log('after canvas click:', JSON.stringify(locked));

const before = await page.evaluate(() => window.__UC.state().weapon);
console.log('mag before:', before.mag, 'state:', before.state);

// Hold the left button down for half a second of real frames.
await page.mouse.down({ button: 'left' });
await sleep(700);
await page.mouse.up({ button: 'left' });
await sleep(200);
const afterFire = await page.evaluate(() => window.__UC.state().weapon);
console.log('mag after left-mouse held 700ms:', afterFire.mag);

// Right button should pull the camera FOV in.
const fovHip = await page.evaluate(() => window.__UC_APP.camera.fov);
await page.mouse.down({ button: 'right' });
await sleep(600);
const fovAds = await page.evaluate(() => window.__UC_APP.camera.fov);
await page.mouse.up({ button: 'right' });
await sleep(500);
const fovBack = await page.evaluate(() => window.__UC_APP.camera.fov);
console.log('fov hip -> ads -> released:', fovHip.toFixed(1), fovAds.toFixed(1), fovBack.toFixed(1));

// And the GPU the browser actually picked.
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('webgl renderer:', gpu);

await browser.close();
process.exit(0);
