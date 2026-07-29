import './ui/styles.css';
import { Game } from './app.js';
import { FIXED_DT } from './core/loop.js';
import { SCREEN } from './ui/screens.js';
import { PHASE } from './game/mission/director.js';
import { AI_STATE_ORDER } from './game/ai/fsm.js';
import { saveSettings } from './core/storage.js';

const canvas = document.getElementById('view');
const game = new Game(canvas);

// Error capture must be installed before boot so a failure during boot is still
// visible to the e2e console-cleanliness assertion.
const errors = [];
window.addEventListener('error', (e) => {
  errors.push({ type: 'error', message: e.message, source: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  errors.push({ type: 'unhandledrejection', message: String(e.reason) });
});

const loadingText = document.getElementById('loading-text');

game
  .boot((fraction, label) => {
    game.screens?.setLoading?.(fraction, label);
    const fill = document.getElementById('loading-fill');
    if (fill) fill.style.width = `${Math.round(fraction * 100)}%`;
    if (loadingText && label) loadingText.textContent = label;
  })
  .then(() => {
    installTestHooks(game, errors);
    window.__UC_READY = true;
  })
  .catch((err) => {
    errors.push({ type: 'boot', message: String(err && err.stack ? err.stack : err) });
    if (loadingText) loadingText.textContent = `Failed to start: ${err.message}`;
    window.__UC_READY = false;
    window.__UC_BOOT_ERROR = String(err && err.stack ? err.stack : err);
    throw err;
  });

/**
 * `window.__UC` — the headless play API from GAME_SPEC §6.
 *
 * The e2e suite drives the real game through these: it injects command frames into
 * the same `Input` the mouse and keyboard feed, and steps the same fixed-step loop
 * the browser drives. Nothing here is a gameplay shortcut, so an automated
 * playthrough is a genuine playthrough.
 */
function installTestHooks(g, errorList) {
  const api = {
    version: 1,
    fixedDt: FIXED_DT,

    ready: () => !!g.booted,

    /** Full simulation snapshot. */
    state() {
      const p = g.player;
      const pc = p.controller;
      return {
        phase: g.director.phase,
        screen: g.screens.current,
        paused: g.paused,
        missionTime: +g.director.missionTime.toFixed(2),
        alarm: g.director.alarm,
        player: {
          x: +pc.pos.x.toFixed(3), y: +pc.pos.y.toFixed(3), z: +pc.pos.z.toFixed(3),
          yaw: +pc.yaw.toFixed(4), pitch: +pc.pitch.toFixed(4),
          hp: +p.hp.toFixed(1), armor: +p.armor.toFixed(1),
          dead: p.dead, grounded: pc.grounded, speed: +pc.speed.toFixed(3),
          crouching: pc.crouching, sprinting: pc.sprinting,
          height: +pc.height.toFixed(3),
        },
        weapon: {
          id: g.weapons.def.id,
          state: g.weapons.state,
          mag: g.weapons.slot.mag,
          reserve: g.weapons.slot.reserve,
          ads: +g.weapons.adsFactor.toFixed(3),
          spread: +g.weapons.slot.ballistics.spread.toFixed(4),
          owned: [...g.weapons.owned],
        },
        stats: { ...g.weapons.stats, damageTaken: Math.round(p.stats.damageTaken) },
        objectives: g.director.objectives.snapshot(),
        enemies: {
          alive: g.enemies.aliveCount,
          spawned: g.enemies.totalSpawned,
          killed: g.enemies.totalKilled,
          pending: g.enemies.pendingCount,
          states: g.enemies.live.map((e) => ({
            id: e.id, state: e.fsm.current, hp: +e.hp.toFixed(1),
            x: +e.pos.x.toFixed(2), y: +e.pos.y.toFixed(2), z: +e.pos.z.toFixed(2),
            visible: e.visible, dead: e.dead,
          })),
          visitedStates: g.enemies.visitedStates(),
          allStates: AI_STATE_ORDER,
        },
        interactTarget: p.interactTarget ? p.interactTarget.id : null,
        interactProgress: +p.interactProgress.toFixed(3),
        result: g.director.result,
        finished: g.director.finished,
      };
    },

    /** Inject a synthetic command frame; persists until changed. */
    input(frame) {
      g.input.setSynthetic(frame);
      return true;
    },

    clearInput() {
      g.input.setSynthetic(null);
      g.input.setSynthetic({});
      g.input.synthetic = null;
      return true;
    },

    /** Advance the simulation by `ms` of fixed steps without waiting on rAF. */
    step(ms = FIXED_DT * 1000) {
      const steps = Math.max(1, Math.round(ms / (FIXED_DT * 1000)));
      g.loop.stepManual(steps, false);
      return steps;
    },

    seed(n) {
      g.rng.seed(n >>> 0);
      return true;
    },

    /**
     * Suspend the loop's wall-clock advance, leaving `step()` as the only source
     * of simulated time.
     *
     * Without this, real rAF frames tick the simulation between two `evaluate`
     * calls, with whatever input frame happened to be installed — so a
     * determinism test measures the browser's frame pacing as much as the game.
     * Rendering continues, so screenshots still work while frozen.
     */
    freeze(v = true) {
      g.loop.setPaused(!!v);
      return !!v;
    },

    teleport(x, y, z, yaw) {
      g.player.controller.setPosition(x, y, z);
      if (yaw !== undefined) g.player.controller.yaw = yaw;
      return true;
    },

    look(yaw, pitch) {
      g.player.controller.yaw = yaw;
      if (pitch !== undefined) g.player.controller.pitch = pitch;
      return true;
    },

    setPhase(name) {
      if (!Object.values(PHASE).includes(name)) return false;
      g.director.setPhase(name);
      return true;
    },

    startMission(checkpoint = 0) {
      g.startMission(checkpoint);
      return true;
    },

    showScreen(name) {
      if (name === 'none') g.screens.hideAll();
      else g.screens.show(name);
      return true;
    },

    pause() { g.pause(); return true; },
    resume() { g.resume(); return true; },
    abort() { g.abortToMenu(); return true; },

    hurt(amount) {
      g.player.takeDamage(amount, { fromX: g.player.pos.x, fromZ: g.player.pos.z + 4, source: 'gunfire' });
      return g.player.hp;
    },

    giveWeapon(id) {
      return g.weapons.grant(id);
    },

    killAllEnemies() {
      for (const e of g.enemies.live) {
        if (!e.dead) e.takeDamage(999, { kind: 'torso', weapon: 'debug' });
      }
      return true;
    },

    /** Scene-graph dump: name, world bounds and visibility of every mesh. */
    debugScene() {
      const out = [];
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox?.();
        const b = o.geometry.boundingBox;
        out.push({
          name: o.name || o.type,
          material: o.material?.name || o.material?.type,
          visible: o.visible,
          inFrustum: !o.frustumCulled,
          tris: o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3,
          bounds: b ? [
            [+b.min.x.toFixed(1), +b.min.y.toFixed(1), +b.min.z.toFixed(1)],
            [+b.max.x.toFixed(1), +b.max.y.toFixed(1), +b.max.z.toFixed(1)],
          ] : null,
          pos: [+o.position.x.toFixed(1), +o.position.y.toFixed(1), +o.position.z.toFixed(1)],
        });
      });
      return out;
    },

    metrics() {
      const s = g.metrics.summary();
      s.pools = g.impacts.stats;
      s.audio = { ...g.audio.stats, ready: g.audio.ready, events: g.audio.getEventLog().length };
      s.level = g.level.stats;
      return s;
    },

    resetMetrics() {
      g.metrics.reset();
      return true;
    },

    audioLog() {
      return g.audio.getEventLog();
    },

    aiTraces() {
      return g.enemies.traces();
    },

    /** Live pickups, so a headless run can go and get one when it is hurt. */
    pickups() {
      return g.director.pickups
        .filter((p) => !p.taken)
        .map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, amount: p.amount }));
    },

    errors() {
      return errorList;
    },

    settings(patch) {
      if (patch) {
        Object.assign(g.settings, patch);
        // Persist, exactly as the settings UI does. Without this the hook was an
        // unfaithful stand-in for a user changing a setting, and the e2e
        // "settings survive a reload" assertion was testing a path the game
        // never takes.
        saveSettings(g.settings);
        g.bus.emit('settings:changed', { key: '*', value: null });
        g.screens.syncSettings();
      }
      return { ...g.settings };
    },

    screens: SCREEN,
    phases: PHASE,
  };

  window.__UC = api;
  // Raw app handle for ad-hoc probes (tools/_probe.mjs). The curated `__UC`
  // surface above is what tests use; this is the escape hatch for the times a
  // rendering question can only be answered by reaching into the scene graph.
  window.__UC_APP = g;
  return api;
}

export { game };
