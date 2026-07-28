import { clamp, clamp01, planarDist } from '../../core/mathx.js';
import {
  CHECKPOINTS, ENEMY_SPAWNS, INTERACTABLES, PICKUPS, PLAYER_SPAWN, WORLD_BOUNDS, zoneAt,
} from '../level/leveldata.js';
import { MISSION_OBJECTIVES, ObjectiveList } from './objectives.js';

export const PHASE = {
  MENU: 'menu',
  APPROACH: 'approach',
  PUMP_HALL: 'pump_hall',
  SERVER_ROOM: 'server_room',
  ALARM: 'alarm',
  WITHDRAWAL: 'withdrawal',
  EXTRACTION: 'extraction',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

/** Phases that follow directly from completing an objective. */
const PHASE_AFTER_OBJECTIVE = {
  obj_approach: PHASE.PUMP_HALL,
  obj_power: PHASE.SERVER_ROOM,
  obj_core: PHASE.ALARM,
  obj_exfil: PHASE.EXTRACTION,
};

/**
 * The mission director: owns phase progression, enemy activation, the alarm state,
 * checkpoints, the out-of-bounds safety net, and the results tally.
 *
 * Every gameplay-visible transition emits an event so the HUD, audio and renderer
 * react without the director knowing they exist.
 */
export class MissionDirector {
  constructor(ctx) {
    this.ctx = ctx; // {bus, player, enemies, weapons, world, rng, audio}
    this.bus = ctx.bus;
    this.objectives = new ObjectiveList(MISSION_OBJECTIVES, ctx.bus);
    this.phase = PHASE.MENU;
    this.phaseTime = 0;
    this.missionTime = 0;
    this.alarm = false;
    this.alarmT = 0;
    this.powerCut = false;
    this.checkpointIndex = 0;
    this.spawnedBeats = new Set();
    this.extractionWave = 0;
    this.extractionWaveTimer = 0;
    this.outOfBoundsT = 0;
    this.finished = false;
    this.result = null;
    this.callouts = [];

    this.interactables = INTERACTABLES.map((i) => ({ ...i, disabled: false, used: false }));
    this.pickups = PICKUPS.map((p) => ({ ...p, taken: false }));

    this._wire();
  }

  _wire() {
    this._offs = [
      this.bus.on('interact:complete', (e) => this._onInteract(e)),
      this.bus.on('player:died', () => this._onPlayerDied()),
      this.bus.on('objective:completed', (e) => this._onObjectiveComplete(e)),
    ];
  }

  // -------------------------------------------------------------------------

  start(fromCheckpoint = 0) {
    this.checkpointIndex = clamp(fromCheckpoint, 0, CHECKPOINTS.length - 1);
    const cp = CHECKPOINTS[this.checkpointIndex];

    this.ctx.rng.seed(0x5eed1234 + this.checkpointIndex);
    this.ctx.player.reset(cp);
    this.ctx.enemies.clear();
    this.ctx.weapons.reset();
    this.ctx.impacts?.clear();
    this.missionTime = 0;
    this.phaseTime = 0;
    this.finished = false;
    this.result = null;
    this.extractionWave = 0;
    this.extractionWaveTimer = 0;
    this.outOfBoundsT = 0;
    this.spawnedBeats.clear();

    // Restore mission progress up to this checkpoint.
    //
    // Completing the earlier objectives fires the same events a live playthrough
    // would, including phase advances — so beat activation has to be suppressed for
    // the duration, or restarting at the helipad also spawns the dock and pump-hall
    // patrols behind you.
    this._restoring = true;
    this.objectives.reset();
    const restoreUpTo = ['', 'obj_approach', 'obj_power', 'obj_core', 'obj_exfil'];
    for (let i = 1; i <= this.checkpointIndex; i++) {
      const id = restoreUpTo[i];
      if (!id) continue;
      const o = this.objectives.get(id);
      if (o) {
        o.progress = o.count;
        this.objectives.complete(id);
      }
    }
    this._restoring = false;
    // Every skipped beat counts as already spawned so it never fires later.
    const beatOrder = [
      PHASE.APPROACH, PHASE.PUMP_HALL, PHASE.SERVER_ROOM, PHASE.ALARM, PHASE.WITHDRAWAL,
    ];
    for (let i = 0; i < beatOrder.length; i++) {
      const reachedAt = [0, 1, 2, 3, 3][i];
      if (reachedAt < this.checkpointIndex) this.spawnedBeats.add(beatOrder[i]);
    }

    for (const it of this.interactables) {
      it.used = false;
      it.disabled = false;
    }
    for (const p of this.pickups) p.taken = false;

    // Checkpoints past the server room imply the alarm and the shotgun.
    if (this.checkpointIndex >= 2) {
      this.ctx.weapons.grant('shotgun');
      const sg = this.interactables.find((i) => i.id === 'shotgun_pickup');
      if (sg) { sg.used = true; sg.disabled = true; }
    }
    this.powerCut = this.checkpointIndex >= 2;
    this.setAlarm(this.checkpointIndex >= 3);

    this.setPhase(cp.phase, true);
    this.bus.emit('mission:started', { checkpoint: cp.id, index: this.checkpointIndex });
    return this;
  }

  setPhase(phase, silent = false) {
    if (this.phase === phase) return;
    const from = this.phase;
    this.phase = phase;
    this.phaseTime = 0;
    this._activateBeat(phase);
    if (!silent) this.bus.emit('mission:phase', { from, to: phase });
  }

  _activateBeat(phase) {
    if (this._restoring || this.spawnedBeats.has(phase)) return;
    const defs = ENEMY_SPAWNS.filter((s) => s.beat === phase && s.wave === undefined);
    if (defs.length) {
      this.ctx.enemies.queue(defs);
      this.spawnedBeats.add(phase);
    } else if (phase === PHASE.EXTRACTION) {
      this.spawnedBeats.add(phase);
    }
  }

  // -------------------------------------------------------------------------

  _onInteract(e) {
    const target = this.interactables.find((i) => i.id === e.id);
    if (!target || target.used) return;

    if (target.grants) {
      this.ctx.weapons.grant(target.grants);
      target.used = true;
      target.disabled = true;
      this.bus.emit('pickup:weapon', { id: target.grants });
      this.callout(`Breacher-12 acquired. Switch with <b>2</b>.`);
      return;
    }

    if (target.objective === 'obj_power') {
      target.used = true;
      target.disabled = true;
      this.bus.emit('breaker:pulled', { id: target.id });
      const remaining = this.interactables.filter(
        (i) => i.objective === 'obj_power' && !i.used,
      ).length;
      this.objectives.advance('obj_power', 1);
      if (remaining > 0) {
        this.callout(`Breaker down. <b>${remaining}</b> remaining.`);
      } else {
        this.powerCut = true;
        this.bus.emit('power:cut', {});
      }
      return;
    }

    if (target.objective === 'obj_core') {
      target.used = true;
      target.disabled = true;
      this.objectives.complete('obj_core');
      return;
    }
  }

  _onObjectiveComplete(e) {
    const next = PHASE_AFTER_OBJECTIVE[e.id];
    if (e.id === 'obj_core') {
      // Pulling the core is what trips the alarm — the mission's turning point.
      this.setAlarm(true);
      this.callout('Core secured. <b>Alarm tripped</b> — get to the helipad.');
      this.setPhase(PHASE.ALARM);
      this._saveCheckpoint(3);
      return;
    }
    if (e.id === 'obj_hold') {
      this._finish(true);
      return;
    }
    if (next) this.setPhase(next);
    if (e.id === 'obj_approach') this._saveCheckpoint(1);
    if (e.id === 'obj_power') this._saveCheckpoint(2);
    if (e.id === 'obj_exfil') this._saveCheckpoint(4);
  }

  _saveCheckpoint(index) {
    if (index <= this.checkpointIndex) return;
    this.checkpointIndex = index;
    this.bus.emit('mission:checkpoint', { index, id: CHECKPOINTS[index]?.id });
  }

  _onPlayerDied() {
    if (this.finished) return;
    this.finished = true;
    this.phase = PHASE.FAILED;
    this.result = this._tally(false);
    this.bus.emit('mission:failed', this.result);
  }

  _finish(success) {
    if (this.finished) return;
    this.finished = true;
    this.phase = PHASE.COMPLETE;
    this.ctx.player.controller.frozen = true;
    this.result = this._tally(success);
    this.bus.emit('mission:complete', this.result);
  }

  _tally(success) {
    const w = this.ctx.weapons.stats;
    const p = this.ctx.player.stats;
    const accuracy = w.shotsFired ? w.shotsHit / w.shotsFired : 0;
    const objectivesDone = this.objectives.doneCount;
    // Grade rewards speed, accuracy and not getting shot, in that priority order.
    let score = 0;
    score += clamp01(1 - this.missionTime / 420) * 40;
    score += accuracy * 30;
    score += clamp01(1 - p.damageTaken / 260) * 20;
    score += (objectivesDone / this.objectives.items.length) * 10;
    const grade = score >= 82 ? 'S' : score >= 70 ? 'A' : score >= 56 ? 'B' : score >= 40 ? 'C' : 'D';
    return {
      success,
      timeSeconds: +this.missionTime.toFixed(1),
      shotsFired: w.shotsFired,
      shotsHit: w.shotsHit,
      accuracy: +(accuracy * 100).toFixed(1),
      kills: w.kills,
      headshots: w.headshots,
      damageTaken: Math.round(p.damageTaken),
      deaths: p.deaths,
      objectivesCompleted: objectivesDone,
      objectivesTotal: this.objectives.items.length,
      score: +score.toFixed(1),
      grade,
    };
  }

  setAlarm(on) {
    if (this.alarm === on) return;
    this.alarm = on;
    this.bus.emit('mission:alarm', { on });
  }

  callout(html, seconds = 4.5) {
    this.callouts.push({ html, life: seconds });
    this.bus.emit('mission:callout', { html, seconds });
  }

  // -------------------------------------------------------------------------

  update(dt) {
    if (this.phase === PHASE.MENU) return;
    this.missionTime += dt;
    this.phaseTime += dt;
    this.alarmT += dt;

    const player = this.ctx.player;

    if (!this.finished) {
      this.objectives.update({
        playerPos: player.pos,
        dt,
        aliveEnemies: this.ctx.enemies.aliveCount,
      });
    }

    // The alarm beat is a short scripted breather before the running battle.
    if (this.phase === PHASE.ALARM && this.phaseTime > 1.6) {
      this.setPhase(PHASE.WITHDRAWAL);
    }

    // Extraction waves.
    if (this.phase === PHASE.EXTRACTION && !this.finished) {
      this.extractionWaveTimer -= dt;
      const waveDefs = ENEMY_SPAWNS.filter(
        (s) => s.beat === 'extraction' && s.wave === this.extractionWave,
      );
      if (this.extractionWaveTimer <= 0 && waveDefs.length) {
        this.ctx.enemies.queue(waveDefs);
        this.bus.emit('mission:wave', { wave: this.extractionWave + 1, count: waveDefs.length });
        this.extractionWave++;
        this.extractionWaveTimer = 13;
      }
    }

    this._updatePickups();
    this._safetyNet(dt);

    for (let i = this.callouts.length - 1; i >= 0; i--) {
      this.callouts[i].life -= dt;
      if (this.callouts[i].life <= 0) this.callouts.splice(i, 1);
    }
  }

  _updatePickups() {
    const p = this.ctx.player;
    for (const item of this.pickups) {
      if (item.taken) continue;
      if (planarDist(p.pos, item) > 1.5) continue;
      if (Math.abs(p.pos.y - item.y) > 2.2) continue;
      let took = false;
      if (item.kind === 'ammo') took = this.ctx.weapons.addAmmo(item.amount) > 0;
      else if (item.kind === 'health') took = p.addHealth(item.amount) > 0;
      else if (item.kind === 'armor') took = p.addArmor(item.amount) > 0;
      if (took) {
        item.taken = true;
        this.bus.emit('pickup:taken', { id: item.id, kind: item.kind, amount: item.amount });
      }
    }
  }

  /**
   * Out-of-bounds guard. Railings should make falling impossible, but a physics
   * escape must never be able to soft-lock a mission, so anything below the world
   * floor or outside the bounds is returned to the last checkpoint with a penalty.
   */
  _safetyNet(dt) {
    const p = this.ctx.player;
    if (p.dead || this.finished) return;
    const b = WORLD_BOUNDS;
    const outside =
      p.pos.y < b.min.y || p.pos.y > b.max.y ||
      p.pos.x < b.min.x || p.pos.x > b.max.x ||
      p.pos.z < b.min.z || p.pos.z > b.max.z;
    const drowning = p.pos.y < -1.2 && zoneAt(p.pos.x, p.pos.y, p.pos.z) === null;

    if (outside || drowning) {
      this.outOfBoundsT += dt;
      if (this.outOfBoundsT > 0.6) {
        this.outOfBoundsT = 0;
        const cp = CHECKPOINTS[this.checkpointIndex];
        p.controller.setPosition(cp.x, cp.y, cp.z);
        p.controller.yaw = cp.yaw ?? 0;
        p.takeDamage(15, { source: 'drowning' });
        this.bus.emit('mission:recovered', { checkpoint: cp.id });
        this.callout('Recovered to last checkpoint.');
      }
    } else {
      this.outOfBoundsT = 0;
    }
  }

  /** Interactables the player can currently use (feeds the prompt). */
  activeInteractables() {
    return this.interactables.filter((i) => !i.disabled);
  }

  get holdObjective() {
    const o = this.objectives.get('obj_hold');
    return o && o.active ? o : null;
  }

  snapshot() {
    return {
      phase: this.phase,
      missionTime: +this.missionTime.toFixed(2),
      alarm: this.alarm,
      powerCut: this.powerCut,
      checkpoint: this.checkpointIndex,
      objectives: this.objectives.snapshot(),
      finished: this.finished,
      result: this.result,
      enemiesAlive: this.ctx.enemies.aliveCount,
      enemiesPending: this.ctx.enemies.pendingCount,
      totalSpawned: this.ctx.enemies.totalSpawned,
      totalKilled: this.ctx.enemies.totalKilled,
    };
  }

  dispose() {
    for (const off of this._offs || []) off();
  }
}
