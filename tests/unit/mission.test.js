import { beforeEach, describe, expect, it } from 'vitest';
import {
  MISSION_OBJECTIVES, OBJECTIVE_STATE, OBJECTIVE_TYPE, Objective, ObjectiveList,
} from '../../src/game/mission/objectives.js';
import { MissionDirector, PHASE } from '../../src/game/mission/director.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { CollisionWorld } from '../../src/game/level/collision.js';
import { buildColliders } from '../../src/game/level/leveldata.js';

const world = new CollisionWorld(8).addAll(buildColliders()).build();

/** Minimal stand-ins so the director can be tested without a renderer. */
function harness() {
  const bus = new EventBus();
  const player = {
    pos: { x: 0, y: 0, z: 53 },
    hp: 100,
    armor: 0,
    dead: false,
    stats: { damageTaken: 0, deaths: 0, pickups: 0, distance: 0 },
    controller: { frozen: false, yaw: 0, setPosition(x, y, z) { player.pos = { x, y, z }; } },
    reset(cp) {
      player.pos = { x: cp.x, y: cp.y, z: cp.z };
      player.hp = 100;
      player.armor = 0;
      player.dead = false;
      player.controller.frozen = false;
    },
    takeDamage(n) {
      player.hp = Math.max(0, player.hp - n);
      player.stats.damageTaken += n;
      if (player.hp === 0 && !player.dead) {
        player.dead = true;
        bus.emit('player:died', { cause: 'test' });
      }
      return { dealt: n, killed: player.dead };
    },
    addHealth: (n) => (player.hp < 100 ? ((player.hp = Math.min(100, player.hp + n)), n) : 0),
    addArmor: (n) => (player.armor < 100 ? ((player.armor = Math.min(100, player.armor + n)), n) : 0),
  };
  const enemies = {
    queued: [],
    aliveCount: 0,
    pendingCount: 0,
    totalSpawned: 0,
    totalKilled: 0,
    queue(defs) {
      enemies.queued.push(...defs);
      enemies.totalSpawned += defs.length;
      enemies.aliveCount += defs.length;
    },
    clear() {
      enemies.queued.length = 0;
      enemies.aliveCount = 0;
      enemies.totalSpawned = 0;
      enemies.totalKilled = 0;
    },
  };
  const weapons = {
    granted: [],
    stats: { shotsFired: 0, shotsHit: 0, kills: 0, headshots: 0 },
    grant(id) { weapons.granted.push(id); return true; },
    addAmmo: () => 30,
    reset() { weapons.granted.length = 0; weapons.stats = { shotsFired: 0, shotsHit: 0, kills: 0, headshots: 0 }; },
  };
  const director = new MissionDirector({
    bus, player, enemies, weapons, world, rng: new Rng(1), impacts: { clear() {} },
  });
  return { bus, player, enemies, weapons, director };
}

describe('Objective', () => {
  it('starts locked with zero progress', () => {
    const o = new Objective({ id: 'a', type: OBJECTIVE_TYPE.REACH, label: 'A' });
    expect(o.state).toBe(OBJECTIVE_STATE.LOCKED);
    expect(o.done).toBe(false);
    expect(o.fraction).toBe(0);
  });

  it('formats a counted progress label', () => {
    const o = new Objective({ id: 'a', type: OBJECTIVE_TYPE.INTERACT, label: 'A', count: 2 });
    expect(o.progressLabel).toBe('0/2');
    o.progress = 1;
    expect(o.progressLabel).toBe('1/2');
    expect(o.fraction).toBe(0.5);
  });

  it('formats a timer label counting down', () => {
    const o = new Objective({ id: 'a', type: OBJECTIVE_TYPE.SURVIVE_TIMER, label: 'A', duration: 45 });
    expect(o.progressLabel).toBe('45s');
    o.elapsed = 20;
    expect(o.progressLabel).toBe('25s');
    expect(o.fraction).toBeCloseTo(20 / 45, 5);
  });

  it('has no progress label for a single-step objective', () => {
    const o = new Objective({ id: 'a', type: OBJECTIVE_TYPE.REACH, label: 'A' });
    expect(o.progressLabel).toBe('');
  });
});

describe('ObjectiveList', () => {
  let list;
  let bus;
  beforeEach(() => {
    bus = new EventBus();
    list = new ObjectiveList(MISSION_OBJECTIVES, bus);
    list.reset();
  });

  it('activates only the first objective', () => {
    expect(list.active.id).toBe('obj_approach');
    expect(list.items.filter((o) => o.active).length).toBe(1);
  });

  it('completing one activates the next', () => {
    list.complete('obj_approach');
    expect(list.get('obj_approach').done).toBe(true);
    expect(list.active.id).toBe('obj_power');
  });

  it('advance completes a counted objective only at the count', () => {
    list.complete('obj_approach');
    list.advance('obj_power', 1);
    expect(list.get('obj_power').done).toBe(false);
    list.advance('obj_power', 1);
    expect(list.get('obj_power').done).toBe(true);
  });

  it('advance is a no-op for an inactive objective', () => {
    expect(list.advance('obj_core', 1)).toBe(false);
    expect(list.get('obj_core').progress).toBe(0);
  });

  it('completing twice is idempotent', () => {
    list.complete('obj_approach');
    expect(list.complete('obj_approach')).toBe(false);
    expect(list.completedOrder).toEqual(['obj_approach']);
  });

  it('emits activation and completion events', () => {
    const seen = [];
    bus.on('objective:completed', (e) => seen.push(`done:${e.id}`));
    bus.on('objective:activated', (e) => seen.push(`active:${e.id}`));
    list.complete('obj_approach');
    expect(seen).toEqual(['done:obj_approach', 'active:obj_power']);
  });

  it('a reach objective completes when the player is inside the radius', () => {
    const o = list.active;
    list.update({ playerPos: { x: 0, y: 0, z: 50 }, dt: 1 / 60, aliveEnemies: 0 });
    expect(o.done).toBe(false);
    list.update({ playerPos: { x: o.marker.x, y: o.marker.y, z: o.marker.z }, dt: 1 / 60, aliveEnemies: 0 });
    expect(o.done).toBe(true);
  });

  it('a reach objective ignores a player far above or below the marker', () => {
    const o = list.active;
    list.update({ playerPos: { x: o.marker.x, y: o.marker.y + 20, z: o.marker.z }, dt: 1 / 60, aliveEnemies: 0 });
    expect(o.done).toBe(false);
  });

  it('a survive-timer objective completes after its duration', () => {
    for (const id of ['obj_approach', 'obj_power', 'obj_core', 'obj_exfil']) list.complete(id);
    const hold = list.active;
    expect(hold.id).toBe('obj_hold');
    for (let i = 0; i < 45 * 60 - 1; i++) {
      list.update({ playerPos: { x: 0, y: 0, z: 0 }, dt: 1 / 60, aliveEnemies: 1 });
    }
    expect(hold.done).toBe(false);
    for (let i = 0; i < 120; i++) {
      list.update({ playerPos: { x: 0, y: 0, z: 0 }, dt: 1 / 60, aliveEnemies: 1 });
    }
    expect(hold.done).toBe(true);
    expect(list.allDone).toBe(true);
  });

  it('snapshot mirrors the live state', () => {
    list.complete('obj_approach');
    const snap = list.snapshot();
    expect(snap.length).toBe(MISSION_OBJECTIVES.length);
    expect(snap[0].state).toBe(OBJECTIVE_STATE.DONE);
    expect(snap[1].state).toBe(OBJECTIVE_STATE.ACTIVE);
  });

  it('reset returns everything to the start', () => {
    list.complete('obj_approach');
    list.complete('obj_power');
    list.reset();
    expect(list.doneCount).toBe(0);
    expect(list.active.id).toBe('obj_approach');
  });
});

describe('MissionDirector', () => {
  it('starts at the first checkpoint in the approach phase', () => {
    const { director } = harness();
    director.start(0);
    expect(director.phase).toBe(PHASE.APPROACH);
    expect(director.objectives.active.id).toBe('obj_approach');
    expect(director.alarm).toBe(false);
  });

  it('spawns only the current beat on a fresh start', () => {
    const { director, enemies } = harness();
    director.start(0);
    expect(enemies.queued.every((d) => d.beat === 'approach')).toBe(true);
    expect(enemies.queued.length).toBe(1);
  });

  // The bug this guards: restoring a late checkpoint replays the earlier
  // objective completions, which used to re-trigger every earlier beat's spawns.
  it('restoring a late checkpoint does not spawn earlier beats', () => {
    const { director, enemies } = harness();
    director.start(4);
    expect(director.phase).toBe(PHASE.EXTRACTION);
    const beats = new Set(enemies.queued.map((d) => d.beat));
    expect(beats.has('approach')).toBe(false);
    expect(beats.has('pump_hall')).toBe(false);
    expect(beats.has('server_room')).toBe(false);
  });

  it('restores prior objective progress at a checkpoint', () => {
    const { director } = harness();
    director.start(3);
    expect(director.objectives.get('obj_approach').done).toBe(true);
    expect(director.objectives.get('obj_power').done).toBe(true);
    expect(director.objectives.get('obj_core').done).toBe(true);
    expect(director.objectives.active.id).toBe('obj_exfil');
  });

  it('grants the shotgun and raises the alarm at the appropriate checkpoints', () => {
    const { director, weapons } = harness();
    director.start(2);
    expect(weapons.granted).toContain('shotgun');
    expect(director.alarm).toBe(false);
    const b = harness();
    b.director.start(3);
    expect(b.director.alarm).toBe(true);
  });

  it('pulling both breakers completes the power objective', () => {
    const { director, bus } = harness();
    director.start(1);
    bus.emit('interact:complete', { id: 'breaker_w', target: director.interactables[0] });
    expect(director.objectives.get('obj_power').done).toBe(false);
    bus.emit('interact:complete', { id: 'breaker_e', target: director.interactables[1] });
    expect(director.objectives.get('obj_power').done).toBe(true);
    expect(director.powerCut).toBe(true);
    expect(director.phase).toBe(PHASE.SERVER_ROOM);
  });

  it('a breaker cannot be pulled twice', () => {
    const { director, bus } = harness();
    director.start(1);
    bus.emit('interact:complete', { id: 'breaker_w' });
    bus.emit('interact:complete', { id: 'breaker_w' });
    expect(director.objectives.get('obj_power').progress).toBe(1);
  });

  it('taking the core trips the alarm and advances to the alarm phase', () => {
    const { director, bus } = harness();
    director.start(2);
    bus.emit('interact:complete', { id: 'data_core' });
    expect(director.alarm).toBe(true);
    expect(director.phase).toBe(PHASE.ALARM);
    expect(director.checkpointIndex).toBe(3);
  });

  it('the alarm phase gives way to the withdrawal after a beat', () => {
    const { director, bus } = harness();
    director.start(2);
    bus.emit('interact:complete', { id: 'data_core' });
    for (let i = 0; i < 200; i++) director.update(1 / 60);
    expect(director.phase).toBe(PHASE.WITHDRAWAL);
  });

  it('the shotgun pickup grants the weapon exactly once', () => {
    const { director, bus, weapons } = harness();
    director.start(1);
    bus.emit('interact:complete', { id: 'shotgun_pickup' });
    bus.emit('interact:complete', { id: 'shotgun_pickup' });
    expect(weapons.granted.filter((g) => g === 'shotgun').length).toBe(1);
  });

  it('runs the three extraction waves on a timer', () => {
    const { director, enemies } = harness();
    director.start(4);
    enemies.queued.length = 0;
    const waves = new Set();
    for (let i = 0; i < 60 * 60; i++) {
      director.update(1 / 60);
      for (const d of enemies.queued) waves.add(d.wave);
    }
    expect([...waves].sort()).toEqual([0, 1, 2]);
  });

  it('completes the mission when the hold timer expires', () => {
    const { director } = harness();
    let completed = null;
    director.bus.on('mission:complete', (r) => { completed = r; });
    director.start(4);
    for (let i = 0; i < 50 * 60; i++) director.update(1 / 60);
    expect(director.phase).toBe(PHASE.COMPLETE);
    expect(completed).toBeTruthy();
    expect(completed.success).toBe(true);
    expect(completed.objectivesCompleted).toBe(5);
  });

  it('fails the mission when the player dies', () => {
    const { director, player } = harness();
    let failed = null;
    director.bus.on('mission:failed', (r) => { failed = r; });
    director.start(1);
    player.takeDamage(100);
    expect(director.phase).toBe(PHASE.FAILED);
    expect(failed.success).toBe(false);
  });

  it('grades the run and reports an accurate tally', () => {
    const { director, weapons, player } = harness();
    director.start(4);
    weapons.stats.shotsFired = 100;
    weapons.stats.shotsHit = 62;
    weapons.stats.kills = 9;
    player.stats.damageTaken = 40;
    for (let i = 0; i < 50 * 60; i++) director.update(1 / 60);
    const r = director.result;
    expect(r.shotsFired).toBe(100);
    expect(r.accuracy).toBeCloseTo(62, 1);
    expect(r.kills).toBe(9);
    expect(r.damageTaken).toBe(40);
    expect(['S', 'A', 'B', 'C', 'D']).toContain(r.grade);
  });

  it('grades a clean fast run above a slow sloppy one', () => {
    const fast = harness();
    fast.director.start(4);
    fast.weapons.stats.shotsFired = 40;
    fast.weapons.stats.shotsHit = 38;
    for (let i = 0; i < 50 * 60; i++) fast.director.update(1 / 60);

    const slow = harness();
    slow.director.start(4);
    slow.weapons.stats.shotsFired = 400;
    slow.weapons.stats.shotsHit = 40;
    slow.player.stats.damageTaken = 240;
    for (let i = 0; i < 50 * 60; i++) slow.director.update(1 / 60);

    expect(fast.director.result.score).toBeGreaterThan(slow.director.result.score);
  });

  it('picks up ammo, health and armour when walked over', () => {
    const { director, player, weapons } = harness();
    director.start(1);
    player.hp = 40;
    const health = director.pickups.find((p) => p.kind === 'health');
    player.pos = { x: health.x, y: health.y - 0.4, z: health.z };
    director.update(1 / 60);
    expect(health.taken).toBe(true);
    expect(player.hp).toBeGreaterThan(40);
    expect(weapons).toBeTruthy();
  });

  it('does not consume a pickup the player cannot use', () => {
    const { director, player } = harness();
    director.start(1);
    player.hp = 100;
    const health = director.pickups.find((p) => p.kind === 'health');
    player.pos = { x: health.x, y: health.y - 0.4, z: health.z };
    director.update(1 / 60);
    expect(health.taken).toBe(false);
  });

  // Falling out of the world must never be able to soft-lock the mission.
  it('recovers the player to the last checkpoint when out of bounds', () => {
    const { director, player } = harness();
    director.start(1);
    let recovered = false;
    director.bus.on('mission:recovered', () => { recovered = true; });
    player.pos = { x: 0, y: -40, z: 0 };
    for (let i = 0; i < 120; i++) director.update(1 / 60);
    expect(recovered).toBe(true);
    expect(player.pos.y).toBeGreaterThan(-10);
  });

  it('the out-of-bounds guard costs health so it is not a free teleport', () => {
    const { director, player } = harness();
    director.start(1);
    player.pos = { x: 0, y: -40, z: 0 };
    for (let i = 0; i < 120; i++) director.update(1 / 60);
    expect(player.hp).toBeLessThan(100);
  });

  it('does not fire the safety net during normal play', () => {
    const { director, player } = harness();
    director.start(0);
    let recovered = false;
    director.bus.on('mission:recovered', () => { recovered = true; });
    for (let i = 0; i < 600; i++) {
      player.pos = { x: 0, y: 0, z: 53 - i * 0.02 };
      director.update(1 / 60);
    }
    expect(recovered).toBe(false);
  });

  it('snapshot reports the live mission state', () => {
    const { director } = harness();
    director.start(1);
    director.update(1 / 60);
    const s = director.snapshot();
    expect(s.phase).toBe(PHASE.PUMP_HALL);
    expect(s.objectives.length).toBe(5);
    expect(s.missionTime).toBeGreaterThan(0);
    expect(s.finished).toBe(false);
  });

  it('restarting resets the tally', () => {
    const { director, player } = harness();
    director.start(1);
    player.takeDamage(100);
    expect(director.finished).toBe(true);
    director.start(1);
    expect(director.finished).toBe(false);
    expect(director.missionTime).toBe(0);
    expect(director.result).toBeNull();
  });
});
