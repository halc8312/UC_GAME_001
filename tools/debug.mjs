/** Ad-hoc probe: boot, run a scenario, dump state. `node tools/debug.mjs` */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4176;
const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
await sleep(1500);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90000 });

const shots = [
  ['pad-eye',      33, 6.5, 1,    -Math.PI/2, -0.15, 0],
  ['pad-high',     26, 16,  1,    -Math.PI/2, -0.55, 0],
  ['pad-from-cw',  28, 6.5, -10,  -0.9,       -0.1,  0],
  ['pad-eye-alarm',33, 6.5, 1,    -Math.PI/2, -0.15, 1],
  ['hall-high',    -2, 8,   14,   0,          -0.5,  0],
];
for (const [name, x, y, z, yaw, pitch, alarm] of shots) {
  await page.evaluate(([x, y, z, yaw, pitch, alarm]) => {
    const g = window.__UC;
    g.startMission(alarm ? 4 : 1);
    g.step(200);
    g.teleport(x, y, z, yaw);
    g.look(yaw, pitch);
    g.input({});
    g.step(120);
  }, [x, y, z, yaw, pitch, alarm]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `artifacts/screenshots/_dbg-${name}.png` });
  console.log('shot', name);
}
await browser.close();
process.exit(0);
