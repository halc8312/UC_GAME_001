/** Ad-hoc probe. Not part of the verification suite; overwritten freely. */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4177;
const server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
await sleep(1800);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90000 });

// One life on the catwalk, half-second by half-second: where is the damage coming
// from, and is the player actually killing anything back?
const trace = await page.evaluate(() => {
  const g = window.__UC;
  g.freeze(true);
  g.startMission(3);
  g.step(300);
  g.input({});
  g.step(600);

  const rows = [];
  const target = { x: 28, z: -2 };
  for (let i = 0; i < 40; i++) {
    const s = g.state();
    if (s.player.dead) {
      rows.push({ t: (i * 0.5).toFixed(1), note: 'DEAD' });
      break;
    }
    const live = s.enemies.states.filter((e) => !e.dead && e.visible)
      .sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) -
                      Math.hypot(b.x - s.player.x, b.z - s.player.z));
    const t = live[0];
    if (t) {
      const d = Math.hypot(t.x - s.player.x, t.z - s.player.z);
      g.look(Math.atan2(-(t.x - s.player.x), -(t.z - s.player.z)),
             Math.atan2((t.y + 1.2) - (s.player.y + 1.62), Math.max(1, d)));
      g.input({ fire: true, moveZ: 1 });
    } else {
      g.look(Math.atan2(-(target.x - s.player.x), -(target.z - s.player.z)), -0.02);
      g.input({ moveZ: 1, sprint: true });
    }
    rows.push({
      t: (i * 0.5).toFixed(1),
      hp: Math.round(s.player.hp), ar: Math.round(s.player.armor),
      pos: `${s.player.x.toFixed(0)},${s.player.z.toFixed(0)}`,
      mag: s.weapon.mag, st: s.weapon.state,
      vis: live.length, alive: s.enemies.alive, killed: s.enemies.killed,
      tgt: t ? `${Math.hypot(t.x - s.player.x, t.z - s.player.z).toFixed(0)}m` : '-',
    });
    g.step(500);
  }
  const s = g.state();
  return { rows, final: { hp: Math.round(s.player.hp), killed: s.enemies.killed, alive: s.enemies.alive } };
});
for (const r of trace.rows) console.log(JSON.stringify(r));
console.log('final:', JSON.stringify(trace.final));

await browser.close();
process.exit(0);
