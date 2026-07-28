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
  ['cw-look-south', 28, 6.5, -20,  Math.PI,     -0.06, 3],
  ['cw-look-east',  22, 6.5, -22,  -Math.PI/2,  -0.05, 3],
  ['dock',          0,  0.1, 46,   0,           -0.03, 0],
  ['heli',          33, 6.5, 1,    -Math.PI/2,  -0.08, 4],
];
for (const [name, x, y, z, yaw, pitch, cp] of shots) {
  await page.evaluate(([x, y, z, yaw, pitch, cp]) => {
    const g = window.__UC;
    g.startMission(cp);
    g.step(250);
    g.teleport(x, y, z, yaw);
    g.look(yaw, pitch);
    g.input({});
    g.step(150);
  }, [x, y, z, yaw, pitch, cp]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `artifacts/screenshots/_dbg-${name}.png` });
  console.log('shot', name);
}
console.log('draws/tris:', JSON.stringify(await page.evaluate(() => {
  const m = window.__UC.metrics();
  return { draws: m.drawCalls, tris: m.triangles, level: m.level };
})));
await browser.close();
process.exit(0);
