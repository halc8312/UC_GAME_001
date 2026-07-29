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

/**
 * Walk to a world position the way a player would: point at it, hold forward, fight
 * what gets in the way. No teleporting and no debug kills — if this cannot reach the
 * helipad, the mission is not actually playable.
 *
 * The whole leg runs inside one `page.evaluate` per *segment*, not per step. Driving
 * it a step at a time cost three browser round-trips per 350 ms of simulated time,
 * and against a software rasteriser that turned a 145-second withdrawal into
 * eighteen minutes of wall clock — the test was measuring Playwright's IPC, not the
 * game. It returns to Node only to handle a death, which needs the real death screen
 * and the real Retry button.
 *
 * Returns the number of times the operator died and retried on the way.
 */
async function walkTo(page, tx, tz, { budgetMs = 30_000, tolerance = 3.5, fire = true } = {}) {
  let deaths = 0;
  let remaining = budgetMs;
  while (remaining > 0) {
    const r = await page.evaluate(([tx, tz, budgetMs, tolerance, fire]) => {
      const g = window.__UC;
      const stepMs = 350;
      let elapsed = 0;
      let stuck = 0;
      let lastPos = null;
      while (elapsed < budgetMs) {
        const s = g.state();
        if (s.player.dead) return { died: true, used: elapsed };
        if (Math.hypot(s.player.x - tx, s.player.z - tz) <= tolerance) {
          return { reached: true, used: elapsed };
        }
        // Break off the fight every third step, and whenever the last few steps
        // gained no ground: fighting whatever is visible forever stalls the
        // withdrawal, because the operator keeps turning to shoot and so keeps
        // walking away from the objective.
        const push = Math.round(elapsed / stepMs) % 3 === 2 || stuck > 3;
        const threat = fire && !push
          ? s.enemies.states
            .filter((e) => !e.dead && e.visible &&
              Math.hypot(e.x - s.player.x, e.z - s.player.z) < 20)
            .sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) -
                            Math.hypot(b.x - s.player.x, b.z - s.player.z))[0]
          : null;
        if (threat) {
          const dist = Math.hypot(threat.x - s.player.x, threat.z - s.player.z);
          g.look(
            Math.atan2(-(threat.x - s.player.x), -(threat.z - s.player.z)),
            Math.atan2((threat.y + 1.2) - (s.player.y + 1.62), Math.max(1, dist)),
          );
          // Advance while firing, from the hip. Planting and aiming loses: the
          // reload is 2.5 s of standing in the open, nothing gets picked up and no
          // ground is gained. Strafing is not an option either — the catwalks are
          // two metres wide with a 9 m drop on both sides.
          g.input({ fire: true, moveZ: 1 });
        } else {
          // yaw 0 faces -Z, so heading toward (tx,tz) is atan2(-(dx), -(dz)).
          // The nudge when stuck matters: the catwalk cover is a square face, and
          // a head-on collision gives collide-and-slide no lateral component to
          // work with, so the operator otherwise pushes into a crate forever.
          g.look(Math.atan2(-(tx - s.player.x), -(tz - s.player.z))
            + (stuck > 3 ? (Math.floor(stuck / 4) % 2 ? -1 : 1) * 1.0 : 0), -0.02);
          g.input({ moveZ: 1, sprint: true });
        }
        if (lastPos && Math.hypot(s.player.x - lastPos[0], s.player.z - lastPos[1]) < 0.4) stuck++;
        else stuck = 0;
        lastPos = [s.player.x, s.player.z];
        g.step(stepMs);
        elapsed += stepMs;
      }
      return { used: elapsed };
    }, [tx, tz, remaining, tolerance, fire]);

    remaining -= Math.max(r.used, 350);
    if (r.reached) return deaths;
    if (r.died) {
      deaths++;
      await page.waitForFunction(() => window.__UC.state().screen === 'death', { timeout: 15_000 });
      await page.click('#btn-retry');
      await drive(page, {}, 600);
      remaining -= 1500;
      continue;
    }
    break;
  }
  return deaths;
}

/**
 * Hold the helipad: strafe, fight, go and get a medkit when hurt, retry on death.
 *
 * Same one-evaluate-per-segment shape as `walkTo`, and for the same reason. A death
 * *finishes* the mission — as failed — so only a successful finish ends the hold; a
 * failed one is a death, and a death means retry the beat and hold again.
 */
async function holdAndFight(page, { budgetMs = 90_000 } = {}) {
  let deaths = 0;
  let remaining = budgetMs;
  while (remaining > 0) {
    const r = await page.evaluate(([budgetMs]) => {
      const g = window.__UC;
      const stepMs = 600;
      let elapsed = 0;
      while (elapsed < budgetMs) {
        const s = g.state();
        if (s.finished && s.result && s.result.success) return { won: true, used: elapsed };
        if (s.finished || s.player.dead) return { died: true, used: elapsed };
        // Hurt? Go and get something. The hold is 45 unbroken seconds against three
        // waves and a death restarts the whole beat, so trading fire at 16 HP loses
        // it every time — there is armour and a medkit on the pad for exactly this.
        if (s.player.hp < 60) {
          const kit = g.pickups()
            .filter((p) => p.kind !== 'ammo' &&
              Math.hypot(p.x - s.player.x, p.z - s.player.z) < 22)
            .sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) -
                            Math.hypot(b.x - s.player.x, b.z - s.player.z))[0];
          if (kit) {
            g.look(Math.atan2(-(kit.x - s.player.x), -(kit.z - s.player.z)), -0.02);
            g.input({ moveZ: 1, sprint: true });
            g.step(stepMs);
            elapsed += stepMs;
            continue;
          }
        }
        const threat = s.enemies.states.filter((e) => !e.dead)
          .sort((a, b) => Math.hypot(a.x - s.player.x, a.z - s.player.z) -
                          Math.hypot(b.x - s.player.x, b.z - s.player.z))[0];
        if (threat) {
          const dist = Math.hypot(threat.x - s.player.x, threat.z - s.player.z);
          g.look(
            Math.atan2(-(threat.x - s.player.x), -(threat.z - s.player.z)),
            Math.atan2((threat.y + 1.2) - (s.player.y + 1.62), Math.max(1, dist)),
          );
        }
        g.input({
          moveX: Math.sin(elapsed / 2200) > 0 ? 1 : -1,
          fire: !!threat, aim: !!threat,
        });
        g.step(stepMs);
        elapsed += stepMs;
      }
      return { used: elapsed };
    }, [remaining]);

    remaining -= Math.max(r.used, 600);
    if (r.won) return deaths;
    if (r.died) {
      deaths++;
      await page.waitForFunction(() => window.__UC.state().screen === 'death', { timeout: 15_000 });
      await page.click('#btn-retry');
      await drive(page, {}, 600);
      remaining -= 1500;
      continue;
    }
    break;
  }
  return deaths;
}

/**
 * Hold an interact prompt to completion the way a player has to.
 *
 * Holding the button through one long step is not how this beat plays: the data
 * core takes four seconds, contractors are shooting throughout, and taking a hit
 * swings the view far enough to drop the prompt and reset the timer — or kills
 * the operator outright. The player's answer is to re-acquire and hold again.
 */
async function holdInteract(page, id, objectiveIndex, place, { budgetMs = 60_000 } = {}) {
  let deaths = 0;
  let remaining = budgetMs;
  const reposition = async () => {
    await page.evaluate(([p]) => {
      window.__UC.teleport(p[0], p[1], p[2], p[3]);
      window.__UC.look(p[3], p[4]);
    }, [place]);
    await drive(page, {}, 300);
  };
  while (remaining > 0) {
    const r = await page.evaluate(([id, objectiveIndex, place, budgetMs]) => {
      const g = window.__UC;
      const stepMs = 400;
      let elapsed = 0;
      while (elapsed < budgetMs) {
        const s = g.state();
        if (s.objectives[objectiveIndex].state === 'done') return { done: true, used: elapsed };
        if (s.player.dead || s.finished) return { died: true, used: elapsed };
        if (s.interactTarget !== id) {
          g.teleport(place[0], place[1], place[2], place[3]);
          g.look(place[3], place[4]);
          g.input({});
          g.step(300);
          elapsed += 300;
          continue;
        }
        g.input({ interactHeld: true });
        g.step(stepMs);
        elapsed += stepMs;
      }
      return { used: elapsed };
    }, [id, objectiveIndex, place, remaining]);

    remaining -= Math.max(r.used, 400);
    if (r.done) return deaths;
    if (r.died) {
      deaths++;
      await page.waitForFunction(() => window.__UC.state().screen === 'death', { timeout: 15_000 });
      await page.click('#btn-retry');
      await drive(page, {}, 600);
      await reposition();
      remaining -= 1500;
      continue;
    }
    break;
  }
  return deaths;
}

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
  // Five checkpoints x four directions x 2.5 s, and every checkpoint now actually
  // spawns its squad, so the simulation has real work to do on each step. Measured
  // at 3.1 minutes against a 3-minute default.
  test.slow();
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
    // This test is about the weapon state machine, not about surviving a
    // firefight. Checkpoint 1 populates the pump hall, and standing still for
    // twelve seconds of simulated time to run a magazine dry gets the operator
    // killed — which freezes the controller and makes every later assertion a
    // test of the death screen. The AI is covered by its own test.
    window.__UC.killAllEnemies();
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
  // Clear the room: this measures the ADS speed penalty, and taking fire adds a
  // view punch and a death that have nothing to do with the thing under test.
  await page.evaluate(() => {
    window.__UC.startMission(1);
    window.__UC.killAllEnemies();
  });
  await drive(page, { moveZ: 1 }, 1200);
  const hipSpeed = (await state(page)).player.speed;
  await drive(page, { moveZ: 1, aim: true }, 1200);
  const adsState = await state(page);
  expect(adsState.weapon.ads).toBeGreaterThan(0.9);
  expect(adsState.player.speed).toBeLessThan(hipSpeed);
});

test('enemies perceive, path, fight and die — the FSM traverses every state', async ({ page }) => {
  // Every loop iteration is a browser round-trip, and under SwiftShader this
  // scenario runs ~3 minutes. It is slow, not broken.
  test.slow();
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
  // Seven seconds, not three: a checkpoint restart now grants 2.5 s of respawn
  // grace, during which the squad is deliberately unaware. Three seconds left
  // them half a second to acquire, so they never reached COMBAT and therefore
  // never dropped to SEARCH.
  await drive(page, {}, 7000);
  // Break contact for real. Standing at the south end of the pump hall is still
  // in plain view of the squad, so `timeSinceSeen` never passes `loseSightTime`
  // and nobody ever drops to SEARCH. Leave the room entirely, out onto the dock.
  await page.evaluate(() => window.__UC.teleport(0, 0.1, 44, 0));
  await drive(page, {}, 9000);
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
  await page.evaluate(() => {
    window.__UC.startMission(1);
    window.__UC.killAllEnemies();
  });
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
  // Not slow-because-broken: this walks, shoots, dies and retries through the
  // whole mission, and every loop iteration is a browser round-trip against a
  // software rasteriser. The 45-second extraction hold has to be survived in one
  // life, so it takes as many attempts as it takes.
  test.setTimeout(1_800_000);
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

  const CORE_STAND = [-10, 0.1, -28.2, 0, -0.14];
  await page.evaluate(([p]) => {
    window.__UC.teleport(p[0], p[1], p[2], p[3]);
    window.__UC.look(p[3], p[4]);
  }, [CORE_STAND]);
  await drive(page, {}, 300);
  expect((await state(page)).interactTarget).toBe('data_core');
  await holdInteract(page, 'data_core', 2, CORE_STAND, { budgetMs: 60_000 });
  s = await state(page);
  expect(s.objectives[2].state, 'objective 3 (data core) did not complete').toBe('done');
  expect(s.alarm, 'taking the core did not trip the alarm').toBe(true);
  timeline.push({ at: s.missionTime, event: 'objective_3_done_alarm', phase: s.phase });
  await page.screenshot({ path: `${SHOTS}/run-03-core-alarm.png` });

  // Beat 4: fight out to the helipad, walking and shooting for real.
  await drive(page, {}, 2000);
  await page.evaluate(() => window.__UC.teleport(21.8, 6.5, -22, -Math.PI / 2));
  let deaths = 0;
  deaths += await walkTo(page, 28, -22, { budgetMs: 45_000 });
  deaths += await walkTo(page, 28, -2, { budgetMs: 40_000 });
  deaths += await walkTo(page, 35, 1, { budgetMs: 60_000 });
  s = await state(page);
  expect(s.objectives[3].state, 'objective 4 (reach helipad) did not complete').toBe('done');
  timeline.push({ at: s.missionTime, event: 'objective_4_done', phase: s.phase, deaths });
  await page.screenshot({ path: `${SHOTS}/run-04-helipad.png` });

  // Beat 5: hold for extraction, fighting the three waves.
  deaths += await holdAndFight(page, { budgetMs: 300_000 });
  s = await state(page);
  expect(s.objectives[4].state, 'objective 5 (hold) did not complete').toBe('done');
  expect(s.finished).toBe(true);
  expect(s.result.success).toBe(true);
  timeline.push({ at: s.missionTime, event: 'mission_complete', result: s.result, deaths });

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
    deathsDuringRun: deaths,
    playedWithoutDebugKills: true,
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
      // Freeze the wall-clock advance first: otherwise real rAF frames tick the
      // simulation between these `evaluate` calls, carrying whatever input frame
      // the previous run left installed, and the second run starts from a
      // different world than the first.
      window.__UC.freeze(true);
      // Seed before starting. `startMission` draws from the stream (patrol
      // phases, spawn jitter), so seeding afterwards leaves the mission set up
      // from wherever the previous run left the generator.
      window.__UC.seed(4242);
      window.__UC.startMission(1);
      window.__UC.seed(4242);
      window.__UC.input({});
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
  await page.evaluate(() => window.__UC.freeze(false));
  expect(b).toEqual(a);
});

/**
 * Real hardware input.
 *
 * Every other test in this file installs a synthetic command frame through
 * `__UC.input()`. That is the right tool for driving a mission headlessly, but
 * `Input.buildCommand()` returns on its first branch when a synthetic frame is
 * present, so the entire device path — the mousedown/mouseup/keydown listeners a
 * player's hardware actually reaches — had no end-to-end coverage at all. A
 * `mousedown` handler gated on a flag that was never assigned shipped behind that
 * gap: fire and aim did nothing on real hardware for the whole build, while all
 * seventeen tests passed.
 *
 * This test touches `__UC` only to read state. Everything it does to the game, it
 * does with `page.mouse` and `page.keyboard`.
 */
test('a real mouse and keyboard drive the game, not just the synthetic input path', async ({ page }) => {
  test.slow();
  const cap = await boot(page);

  await page.click('#btn-start');
  await page.click('#btn-deploy');
  await page.waitForFunction(() => window.__UC.state().phase === 'approach');

  // Deploying is a user gesture, so the browser grants the pointer lock. Without
  // it the mouse belongs to the UI and none of the rest of this test is valid.
  await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 10_000 });

  const weapon = () => page.evaluate(() => window.__UC.state().weapon);
  const fov = () => page.evaluate(() => window.__UC.state().camera.fov);

  // ---- left button fires -------------------------------------------------
  const magBefore = (await weapon()).mag;
  await page.mouse.down({ button: 'left' });
  await page.waitForFunction(
    (m) => window.__UC.state().weapon.mag < m,
    magBefore,
    { timeout: 20_000 },
  );
  await page.mouse.up({ button: 'left' });
  const magAfter = (await weapon()).mag;
  expect(magAfter, 'holding the left mouse button must fire the weapon').toBeLessThan(magBefore);

  // ---- releasing stops the weapon ---------------------------------------
  await page.waitForTimeout(600);
  const settled = (await weapon()).mag;
  await page.waitForTimeout(700);
  expect(
    (await weapon()).mag,
    'the weapon kept firing after the button came up',
  ).toBe(settled);

  // ---- right button aims -------------------------------------------------
  const hipFov = await fov();
  await page.mouse.down({ button: 'right' });
  await page.waitForFunction((f) => window.__UC.state().camera.fov < f - 5, hipFov, { timeout: 20_000 });
  const adsFov = await fov();
  expect(adsFov, 'the right mouse button must pull the camera into ADS').toBeLessThan(hipFov - 5);
  await page.mouse.up({ button: 'right' });
  await page.waitForFunction((f) => window.__UC.state().camera.fov > f + 5, adsFov, { timeout: 20_000 });

  // ---- keyboard moves and reloads ---------------------------------------
  const posBefore = await page.evaluate(() => {
    const p = window.__UC.state().player;
    return { x: p.x, z: p.z };
  });
  await page.keyboard.down('w');
  await page.waitForFunction(
    (p) => Math.hypot(window.__UC.state().player.x - p.x, window.__UC.state().player.z - p.z) > 1,
    posBefore,
    { timeout: 20_000 },
  );
  await page.keyboard.up('w');

  await page.keyboard.press('r');
  await page.waitForFunction(() => window.__UC.state().weapon.state === 'reloading', { timeout: 20_000 });

  // ---- Escape pauses -----------------------------------------------------
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__UC.state().paused === true, { timeout: 20_000 });

  expect(cap.consoleErrors, `console errors:\n${cap.consoleErrors.join('\n')}`).toEqual([]);
});

/**
 * The renderer the browser handed the game.
 *
 * CI runs on SwiftShader, so this cannot assert that hardware was picked. What it
 * can assert is that the game reports honestly which renderer it got, rather than
 * leaving a player to guess why the frame rate is poor.
 */
test('the build reports which WebGL renderer it is running on', async ({ page }) => {
  await boot(page);
  const gpu = await page.evaluate(() => window.__UC.gpu());

  expect(gpu.renderer, 'the renderer string must be read from the live context').toBeTruthy();
  expect(typeof gpu.software, 'software fallback must be classified, not guessed').toBe('boolean');
  expect(gpu.short.length).toBeGreaterThan(0);

  // Whatever it is, it must be on the menu where a player can see it.
  const buildLine = await page.textContent('#build-line');
  expect(buildLine).toContain(gpu.short);
  if (gpu.software) {
    expect(buildLine, 'a software fallback must be called out, not buried').toContain('software');
  }

  // Under SwiftShader this is the expected classification; on a GPU-backed run
  // the same assertion holds with the branch inverted.
  const isSwiftshader = /swiftshader/i.test(gpu.renderer);
  expect(gpu.software).toBe(isSwiftshader || /llvmpipe|software/i.test(gpu.renderer));

  await writeFile(`${LOGS}/e2e-gpu.json`, JSON.stringify(gpu, null, 2));
});
