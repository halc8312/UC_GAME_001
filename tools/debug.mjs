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


// Does the viewmodel render, and does ADS actually change the frame?
const cases = [
  ['vm-hip',  {}],
  ['vm-ads',  { aim: true }],
  ['vm-fire', { fire: true }],
];
for (const [name, frame] of cases) {
  await page.evaluate(([f]) => {
    const g = window.__UC;
    g.startMission(1);
    g.step(250);
    g.teleport(0, 0.1, 22, 0.05);
    g.look(0.05, -0.02);
    g.input(f);
    g.step(900);
  }, [frame]);
  // Leave the frame installed so the state under test survives the render.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const info = await page.evaluate(() => {
    const s = window.__UC.state();
    return { ads: s.weapon.ads, state: s.weapon.state, mag: s.weapon.mag };
  });
  await page.screenshot({ path: `artifacts/screenshots/_dbg-${name}.png` });
  console.log(name, JSON.stringify(info));
}
await browser.close();
process.exit(0);
