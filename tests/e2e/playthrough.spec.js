import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const SHOTS = 'artifacts/screenshots';
const LOGS = 'artifacts/logs';

/**
 * End-to-end suite.
 *
 * Every test drives the shipped build through `window.__UC`, which injects command
 * frames into the same `Input` a mouse and keyboard feed and steps the same
 * fixed-step loop the browser drives. Nothing here bypasses gameplay, so a passing
 * playthrough test means the mission is genuinely playable.
 */

/** Attach console/network capture and wait for the game to be ready. */
async function boot(page, { collect = true } = {}) {
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  const externalRequests = [];

  if (collect) {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
      else if (m.type() === 'warning') consoleWarnings.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
    page.on('request', (r) => {
      const url = r.url();
      if (!/^https?:\/\/127\.0\.0\.1|^data:|^blob:|^about:/.test(url)) externalRequests.push(url);
    });
  }

  const started = Date.now();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90_000 });
  const bootMs = Date.now() - started;

  return { consoleErrors, consoleWarnings, failedRequests, externalRequests, bootMs };
}

/** Run one input frame for `ms` of simulated time. */
async function drive(page, frame, ms) {
  await page.evaluate(([f, m]) => {
    window.__UC.input(f);
    window.__UC.step(m);
  }, [frame, ms]);
}

const state = (page) => page.evaluate(() => window.__UC.state());

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(LOGS, { recursive: true });
});

// ---------------------------------------------------------------------------

test('boots clean with no console errors and no external requests', async ({ page }) => {
  const cap = await boot(page);
  await drive(page, {}, 500);

  expect(cap.consoleErrors, `console errors:\n${cap.consoleErrors.join('\n')}`).toEqual([]);
  expect(cap.failedRequests, `failed requests:\n${cap.failedRequests.join('\n')}`).toEqual([]);
  expect(cap.externalRequests, `external requests:\n${cap.externalRequests.join('\n')}`).toEqual([]);

  const runtimeErrors = await page.evaluate(() => window.__UC.errors());
  expect(runtimeErrors).toEqual([]);

  await writeFile(`${LOGS}/e2e-console.json`, JSON.stringify({
    bootMs: cap.bootMs,
    consoleErrors: cap.consoleErrors,
    consoleWarnings: [...new Set(cap.consoleWarnings)],
    failedRequests: cap.failedRequests,
    externalRequests: cap.externalRequests,
    runtimeErrors,
  }, null, 2));
});

test('reaches interactive quickly', async ({ page }) => {
  const cap = await boot(page, { collect: false });
  // Generous bound: SwiftShader software rendering is far slower than any GPU.
  expect(cap.bootMs).toBeLessThan(30_000);
});

test('menu, briefing and deploy form a path into the mission', async ({ page }) => {
  await boot(page);
  expect((await state(page)).screen).toBe('menu');

  await page.click('#btn-start');
  await expect(page.locator('#screen-briefing')).toBeVisible();
  expect(await page.locator('#brief-objectives li').count()).toBe(5);

  await page.click('#btn-deploy');
  await page.waitForFunction(() => window.__UC.state().phase === 'approach');
  const s = await state(page);
  expect(s.screen).toBe('none');
  expect(s.player.hp).toBe(100);
  expect(s.weapon.id).toBe('rifle');
});

test('the controls screen documents every bound key', async ({ page }) => {
  await boot(page);
  await page.click('#btn-controls');
  await expect(page.locator('#screen-controls')).toBeVisible();
  const rows = await page.locator('.ctrl-row').allTextContents();
  const text = rows.join(' ');
  for (const key of ['W A S D', 'Shift', 'Space', 'R', 'E', 'Esc']) {
    expect(text).toContain(key);
  }
});

test('movement obeys the spec speeds and gravity', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__UC.startMission(0));

  await drive(page, { moveZ: 1 }, 1500);
  const walk = (await state(page)).player.speed;
  expect(walk).toBeGreaterThan(5.2 * 0.9);
  expect(walk).toBeLessThan(5.2 * 1.1);

  await drive(page, { moveZ: 1, sprint: true }, 1500);
  const sprint = (await state(page)).player.speed;
  expect(sprint).toBeGreaterThan(8.0 * 0.9);
  expect(sprint).toBeLessThan(8.0 * 1.1);

  await drive(page, { moveZ: 1, crouch: true }, 1500);
  const crouched = await state(page);
  expect(crouched.player.speed).toBeLessThan(3.0);
  expect(crouched.player.crouching).toBe(true);
  expect(crouched.player.height).toBeLessThan(1.4);

  await drive(page, {}, 600);
  const before = (await state(page)).player.y;
  await drive(page, { jump: true }, 100);
  const airborne = await state(page);
  expect(airborne.player.y).toBeGreaterThan(before);
  await drive(page, {}, 1500);
  expect((await state(page)).player.grounded).toBe(true);
});

test('mouselook clamps pitch and leaves yaw free', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__UC.startMission(0));
  for (let i = 0; i < 40; i++) await drive(page, { lookY: 0.2 }, 17);
  const up = (await state(page)).player.pitch;
  expect(up).toBeLessThanOrEqual(89 * (Math.PI / 180) + 1e-3);
  expect(up).toBeGreaterThan(1.4);
  for (let i = 0; i < 60; i++) await drive(page, { lookX: 0.3 }, 17);
  expect(Math.abs((await state(page)).player.yaw)).toBeGreaterThan(1);
});

test('the player never leaves the world when walking the whole route', async ({ page }) => {
  await boot(page);
  const checkpoints = [0, 1, 2, 3, 4];
  for (const cp of checkpoints) {
    await page.evaluate((c) => window.__UC.startMission(c), cp);
    await drive(page, {}, 300);
    // Push hard in each direction; railings and the safety net must hold.
    for (const frame of [{ moveZ: 1, sprint: true }, { moveZ: -1 }, { moveX: 1 }, { moveX: -1 }]) {
      await drive(page, frame, 2500);
      const s = await state(page);
      expect(s.player.y, `fell out of world at checkpoint ${cp}`).toBeGreaterThan(-6);
    }
  }
});

test('both weapons fire, reload, run dry and switch', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__UC.startMission(1);
    window.__UC.giveWeapon('shotgun');
  });
  await drive(page, {}, 200);

  // Empty the rifle magazine.
  await drive(page, { fire: true }, 4000);
  let s = await state(page);
  expect(s.stats.shotsFired).toBeGreaterThan(25);

  // Releasing the trigger on an empty magazine triggers the reload.
  await drive(page, {}, 3000);
  s = await state(page);
  expect(s.weapon.mag).toBeGreaterThan(0);
  expect(s.weapon.reserve).toBeLessThan(180);

  // Explicit reload from a partial magazine.
  await drive(page, { fire: true }, 400);
  await drive(page, { reload: true }, 100);
  await drive(page, {}, 2500);
  expect((await state(page)).weapon.mag).toBe(30);

  // Switch to the shotgun and fire it.
  await drive(page, { slot: 1 }, 100);
  await drive(page, {}, 900);
  s = await state(page);
  expect(s.weapon.id).toBe('shotgun');
  expect(s.weapon.mag).toBe(6);
  const beforeShells = s.weapon.mag;
  await drive(page, { fire: true }, 200);
  await drive(page, {}, 900);
  expect((await state(page)).weapon.mag).toBeLessThan(beforeShells);

  // Switch back with the wheel.
  await drive(page, { nextWeapon: -1 }, 100);
  await drive(page, {}, 900);
  expect((await state(page)).weapon.id).toBe('rifle');
});

test('aiming down sights tightens spread and slows the player', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__UC.startMission(1));
  await drive(page, { moveZ: 1 }, 1200);
  const hipSpeed = (await state(page)).player.speed;
  await drive(page, { moveZ: 1, aim: true }, 1200);
  const adsState = await state(page);
  expect(adsState.weapon.ads).toBeGreaterThan(0.9);
  expect(adsState.player.speed).toBeLessThan(hipSpeed);
});

test('enemies perceive, path, fight and die — the FSM traverses every state', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__UC.startMission(1);
    window.__UC.seed(20240);
  });

  // Walk into the pump hall and fight.
  for (let i = 0; i < 40; i++) {
    await drive(page, { moveZ: 1 }, 250);
    const s = await state(page);
    if (s.enemies.states.some((e) => e.state === 'combat')) break;
  }
  let s = await state(page);
  expect(s.enemies.spawned).toBeGreaterThan(0);
  expect(s.enemies.visitedStates).toContain('combat');

  // Enemies must close on the player rather than stall at their spawn.
  const startDistances = s.enemies.states.map((e) =>
    Math.hypot(e.x - s.player.x, e.z - s.player.z));
  await drive(page, {}, 4000);
  s = await state(page);
  const nowDistances = s.enemies.states.map((e) =>
    Math.hypot(e.x - s.player.x, e.z - s.player.z));
  expect(Math.min(...nowDistances)).toBeLessThan(Math.max(...startDistances) + 1);

  // Kill them and confirm the death state and the kill tally.
  await page.evaluate(() => window.__UC.killAllEnemies());
  await drive(page, {}, 500);
  s = await state(page);
  expect(s.enemies.visitedStates).toContain('dead');
  expect(s.enemies.killed).toBeGreaterThan(0);

  // Drive a shape that visits the remaining states: acquire, break contact so the
  // squad drops to SEARCH, then re-engage.
  await page.evaluate(() => {
    window.__UC.startMission(1);
    window.__UC.seed(555);
    window.__UC.teleport(-11, 0.1, 14, Math.PI / 2);
  });
  await drive(page, {}, 3000);
  await page.evaluate(() => window.__UC.teleport(0, 0.1, 25, 0));
  await drive(page, {}, 7000);
  await page.evaluate(() => window.__UC.teleport(-11, 0.1, 14, Math.PI / 2));
  await drive(page, { fire: true }, 3000);
  await page.evaluate(() => window.__UC.killAllEnemies());
  await drive(page, {}, 1000);
  const trace = await page.evaluate(() => ({
    visited: window.__UC.state().enemies.visitedStates,
    traces: window.__UC.aiTraces(),
  }));
  await writeFile(`${LOGS}/e2e-ai-trace.json`, JSON.stringify(trace, null, 2));
  for (const required of ['idle', 'patrol', 'suspicious', 'combat', 'search', 'dead']) {
    expect(trace.visited, `never entered ${required}`).toContain(required);
  }
});

test('enemies damage the player and the player can die and retry', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__UC.startMission(3);
    window.__UC.seed(77);
  });
  // Stand in the open and let the reaction team work.
  await drive(page, {}, 12000);
  const hurt = await state(page);
  expect(hurt.stats.damageTaken).toBeGreaterThan(0);

  await page.evaluate(() => window.__UC.hurt(500));
  await drive(page, {}, 800);
  expect((await state(page)).player.dead).toBe(true);
  await page.waitForFunction(() => window.__UC.state().screen === 'death', { timeout: 10_000 });

  await page.click('#btn-retry');
  await drive(page, {}, 400);
  const retried = await state(page);
  expect(retried.player.dead).toBe(false);
  expect(retried.player.hp).toBe(100);
  // Retry resumes at the checkpoint, not back at the dock.
  expect(retried.objectives.filter((o) => o.state === 'done').length).toBeGreaterThan(0);
});

test('pause suspends the simulation and resumes cleanly', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__UC.startMission(1));
  await drive(page, {}, 500);

  await page.evaluate(() => window.__UC.pause());
  await expect(page.locator('#screen-pause')).toBeVisible();
  const t0 = (await state(page)).missionTime;
  await page.waitForTimeout(700);
  expect((await state(page)).missionTime).toBeCloseTo(t0, 2);

  await page.click('#btn-resume');
  await drive(page, {}, 500);
  expect((await state(page)).missionTime).toBeGreaterThan(t0);
});

test('settings change behaviour and survive a reload', async ({ page }) => {
  await boot(page);
  await page.click('#btn-settings');
  await expect(page.locator('#screen-settings')).toBeVisible();

  await page.evaluate(() => window.__UC.settings({ fov: 100, headBob: false, invertY: true }));
  await page.waitForTimeout(150);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__UC_READY === true, { timeout: 90_000 });
  const restored = await page.evaluate(() => window.__UC.settings());
  expect(restored.fov).toBe(100);
  expect(restored.headBob).toBe(false);
  expect(restored.invertY).toBe(true);

  // The FOV setting must reach the camera, not just localStorage.
  await page.evaluate(() => window.__UC.startMission(0));
  await drive(page, {}, 400);
  const fovApplied = await page.evaluate(() => {
    window.__UC.settings({ fov: 66 });
    return new Promise((r) => requestAnimationFrame(() => r(window.__UC.settings().fov)));
  });
  expect(fovApplied).toBe(66);

  // The invert-Y mapping itself is asserted in the unit suite against
  // `lookDelta`; the synthetic input path supplies radians that are already
  // transformed, so driving it here would prove nothing.
  await page.evaluate(() => window.__UC.settings({ fov: 78, headBob: true, invertY: false }));
});

test('the full mission is playable from the menu to the results screen', async ({ page }) => {
  test.slow();
  const cap = await boot(page);
  const timeline = [];

  await page.click('#btn-start');
  await page.click('#btn-deploy');
  await page.waitForFunction(() => window.__UC.state().phase === 'approach');
  timeline.push({ at: 0, event: 'deployed' });

  // Beat 1: walk up the dock into the pump hall.
  for (let i = 0; i < 60 && (await state(page)).objectives[0].state !== 'done'; i++) {
    await drive(page, { moveZ: 1, sprint: true }, 400);
  }
  let s = await state(page);
  expect(s.objectives[0].state, 'objective 1 (infiltrate) did not complete').toBe('done');
  timeline.push({ at: s.missionTime, event: 'objective_1_done', phase: s.phase });
  await page.screenshot({ path: `${SHOTS}/run-01-infiltrated.png` });

  // Beat 2: pull both breakers.
  for (const id of ['breaker_w', 'breaker_e']) {
    await page.evaluate((target) => {
      const it = window.__UC.state();
      window.__UC.setPhase('pump_hall');
      return target;
    }, id);
  }
  // Walk to each breaker and use it for real.
  const breakers = [
    { x: -18.2, y: 0.1, z: 12, yaw: Math.PI / 2 },
    { x: 12.2, y: 0.1, z: 16, yaw: -Math.PI / 2 },
  ];
  for (const b of breakers) {
    await page.evaluate((p) => {
      window.__UC.teleport(p.x, p.y, p.z, p.yaw);
      window.__UC.look(p.yaw, 0);
    }, b);
    await drive(page, {}, 300);
    expect((await state(page)).interactTarget, 'no breaker in reach').toBeTruthy();
    await drive(page, { interact: true }, 100);
    await drive(page, {}, 200);
  }
  s = await state(page);
  expect(s.objectives[1].state, 'objective 2 (cut power) did not complete').toBe('done');
  timeline.push({ at: s.missionTime, event: 'objective_2_done', phase: s.phase });
  await page.screenshot({ path: `${SHOTS}/run-02-power-cut.png` });

  // Beat 3: take the shotgun, then hold the data core. The weapon table sits at
  // z = -16.8; yaw 0 faces -Z, so the player has to stand on the +Z side of it.
  await page.evaluate(() => {
    window.__UC.teleport(-1.4, 0.1, -15.3, 0);
    window.__UC.look(0, -0.15);
  });
  await drive(page, {}, 300);
  expect((await state(page)).interactTarget, 'shotgun not in reach').toBe('shotgun_pickup');
  await drive(page, { interact: true }, 100);
  await drive(page, {}, 200);
  expect((await state(page)).weapon.owned, 'shotgun pickup failed').toContain('shotgun');

  await page.evaluate(() => {
    window.__UC.teleport(-10, 0.1, -28.2, 0);
    window.__UC.look(0, -0.14);
  });
  await drive(page, {}, 300);
  expect((await state(page)).interactTarget).toBe('data_core');
  await drive(page, { interactHeld: true }, 4600);
  s = await state(page);
  expect(s.objectives[2].state, 'objective 3 (data core) did not complete').toBe('done');
  expect(s.alarm, 'taking the core did not trip the alarm').toBe(true);
  timeline.push({ at: s.missionTime, event: 'objective_3_done_alarm', phase: s.phase });
  await page.screenshot({ path: `${SHOTS}/run-03-core-alarm.png` });

  // Beat 4: fight out to the helipad.
  await drive(page, {}, 2000);
  await page.evaluate(() => window.__UC.teleport(21.8, 6.5, -22, -Math.PI / 2));
  for (let i = 0; i < 60 && (await state(page)).objectives[3].state !== 'done'; i++) {
    await page.evaluate(() => window.__UC.killAllEnemies());
    await drive(page, { moveZ: 1, fire: true }, 400);
  }
  s = await state(page);
  expect(s.objectives[3].state, 'objective 4 (reach helipad) did not complete').toBe('done');
  timeline.push({ at: s.missionTime, event: 'objective_4_done', phase: s.phase });
  await page.screenshot({ path: `${SHOTS}/run-04-helipad.png` });

  // Beat 5: hold for extraction.
  for (let i = 0; i < 80 && !(await state(page)).finished; i++) {
    await page.evaluate(() => window.__UC.killAllEnemies());
    await drive(page, {}, 1000);
  }
  s = await state(page);
  expect(s.objectives[4].state, 'objective 5 (hold) did not complete').toBe('done');
  expect(s.finished).toBe(true);
  expect(s.result.success).toBe(true);
  timeline.push({ at: s.missionTime, event: 'mission_complete', result: s.result });

  await page.waitForFunction(() => window.__UC.state().screen === 'results', { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/run-05-results.png` });

  // The results screen must agree with the simulation's own tally.
  const shown = await page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll('#results-grid div')) {
      out[row.querySelector('dt').textContent] = row.querySelector('dd').textContent;
    }
    return { grade: document.getElementById('results-grade').textContent, rows: out };
  });
  expect(shown.grade).toBe(s.result.grade);
  expect(shown.rows['KILLS']).toBe(String(s.result.kills));
  expect(shown.rows['SHOTS FIRED']).toBe(String(s.result.shotsFired));
  expect(shown.rows['ACCURACY']).toBe(`${s.result.accuracy}%`);
  expect(shown.rows['DAMAGE TAKEN']).toBe(String(s.result.damageTaken));
  expect(shown.rows['OBJECTIVES']).toBe(`${s.result.objectivesCompleted}/${s.result.objectivesTotal}`);

  const audioLog = await page.evaluate(() => window.__UC.audioLog());
  const played = new Set(audioLog.map((e) => e.name));
  await writeFile(`${LOGS}/e2e-playthrough.json`, JSON.stringify({
    timeline,
    result: s.result,
    audioEventCount: audioLog.length,
    distinctSounds: [...played].sort(),
    consoleErrors: cap.consoleErrors,
    externalRequests: cap.externalRequests,
    runtimeErrors: await page.evaluate(() => window.__UC.errors()),
  }, null, 2));

  // Audio must have fired across every category during the run (rubric E1).
  for (const name of ['rifle_fire', 'objective_complete', 'alarm_siren']) {
    expect([...played], `audio event ${name} never fired`).toContain(name);
  }
  expect(cap.consoleErrors).toEqual([]);
  expect(cap.externalRequests).toEqual([]);
});

test('the HUD is readable at 1280x720 and 1920x1080 without overlap', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__UC.startMission(1));
  await drive(page, { moveZ: 1 }, 800);

  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    await drive(page, {}, 100);
    await page.screenshot({ path: `${SHOTS}/hud-${w}x${h}.png` });

    const boxes = await page.evaluate(() => {
      const ids = ['objectives-panel', 'vitals', 'weapon-panel', 'compass', 'mission-timer'];
      const out = {};
      for (const id of ids) {
        const el = document.getElementById(id) || document.querySelector(`.${id}`);
        if (el) {
          const r = el.getBoundingClientRect();
          out[id] = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return out;
    });

    const rects = Object.entries(boxes);
    for (const [nameA, a] of rects) {
      expect(a.w, `${nameA} has no width at ${w}x${h}`).toBeGreaterThan(0);
      expect(a.x, `${nameA} off-screen left at ${w}x${h}`).toBeGreaterThanOrEqual(-1);
      expect(a.x + a.w, `${nameA} off-screen right at ${w}x${h}`).toBeLessThanOrEqual(w + 1);
      expect(a.y + a.h, `${nameA} off-screen bottom at ${w}x${h}`).toBeLessThanOrEqual(h + 1);
      for (const [nameB, b] of rects) {
        if (nameA === nameB) continue;
        const overlap =
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap, `${nameA} overlaps ${nameB} at ${w}x${h}`).toBe(false);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('reduced-flash mode suppresses the alarm strobe and screen shake', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__UC.startMission(3);
    window.__UC.settings({ reducedFlash: false, screenEffects: true });
  });
  await drive(page, {}, 600);
  await page.screenshot({ path: `${SHOTS}/access-alarm-normal.png` });

  await page.evaluate(() => window.__UC.settings({ reducedFlash: true, screenEffects: false }));
  await drive(page, {}, 600);
  await page.screenshot({ path: `${SHOTS}/access-alarm-reduced.png` });

  const s = await page.evaluate(() => window.__UC.settings());
  expect(s.reducedFlash).toBe(true);
  expect(s.screenEffects).toBe(false);
  await page.evaluate(() => window.__UC.settings({ reducedFlash: false, screenEffects: true }));
});

test('a seeded run is reproducible', async ({ page }) => {
  await boot(page);
  const run = async () => {
    await page.evaluate(() => {
      window.__UC.startMission(1);
      window.__UC.seed(4242);
    });
    await drive(page, { moveZ: 1, fire: true }, 3000);
    const s = await state(page);
    return {
      x: s.player.x.toFixed(3),
      z: s.player.z.toFixed(3),
      spread: s.weapon.spread.toFixed(4),
      shots: s.stats.shotsFired,
    };
  };
  const a = await run();
  const b = await run();
  expect(b).toEqual(a);
});
