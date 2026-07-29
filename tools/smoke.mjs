/**
 * Fast boot smoke test: launches the built game in headless Chromium, waits for
 * `__UC_READY`, and prints every console message, page error and failed request.
 * Used during development; the real gate is `npm run test:e2e`.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT || 4173;
const URL = `http://127.0.0.1:${PORT}/`;

const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
  detached: false,
});

const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

await sleep(1500);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

let ready = false;
try {
  await page.waitForFunction(() => window.__UC_READY === true || window.__UC_BOOT_ERROR, { timeout: 60000 });
  ready = await page.evaluate(() => window.__UC_READY === true);
} catch (e) {
  logs.push(`[timeout] ${e.message}`);
}

const bootError = await page.evaluate(() => window.__UC_BOOT_ERROR || null);
console.log('READY:', ready);
if (bootError) console.log('BOOT ERROR:\n', bootError);

if (ready) {
  const info = await page.evaluate(() => {
    window.__UC.startMission(0);
    window.__UC.input({ moveZ: 1 });
    window.__UC.step(1000);
    return { state: window.__UC.state(), metrics: window.__UC.metrics(), errors: window.__UC.errors() };
  });
  console.log('STATE:', JSON.stringify(info.state, null, 1).slice(0, 2600));
  console.log('DRAWS:', info.metrics.drawCalls, 'TRIS:', info.metrics.triangles, 'LEVEL:', JSON.stringify(info.metrics.level));
  console.log('RUNTIME ERRORS:', JSON.stringify(info.errors, null, 1).slice(0, 2000));
  await page.screenshot({ path: 'artifacts/screenshots/_smoke.png' });
}

console.log('--- CONSOLE ---');
console.log(logs.slice(0, 60).join('\n') || '(clean)');

await browser.close();
cleanup();
process.exit(ready ? 0 : 1);
