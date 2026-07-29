import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENEMY, EnemyManager } from '../../src/game/ai/enemies.js';
import { AI_STATE, AI_STATE_ORDER } from '../../src/game/ai/fsm.js';
import { NavGraph } from '../../src/game/ai/navgraph.js';
import { CollisionWorld } from '../../src/game/level/collision.js';
import { ENEMY_SPAWNS, NAV_EDGES, NAV_NODES, buildColliders } from '../../src/game/level/leveldata.js';
import { MaterialLibrary } from '../../src/engine/materials.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { planarDist } from '../../src/core/mathx.js';

/**
 * Enemies run headlessly in Node: geometry and materials construct fine without a
 * WebGL context, so the whole AI stack can be exercised against the real level and
 * the real navigation graph without a browser.
 *
 * This is the layer where the AI meets the nav library, and it is where the
 * count-returning API of `neighbours()` / `coverNodesNear()` silently broke cover
 * selection and search wandering — both invisible to a pure-unit test of either
 * side, and slow to spot by eye in a browser.
 */
const world = new CollisionWorld(8).addAll(buildColliders()).build();

function makeNav() {
  const g = new NavGraph();
  for (const n of NAV_NODES) g.addNode(n.id, n.x, n.y, n.z, { zone: n.zone, cover: !!n.cover });
  for (const [a, b] of NAV_EDGES) g.connect(a, b);
  return g.build();
}

function harness(playerPos = { x: 0, y: 0, z: 20 }) {
  const bus = new EventBus();
  const rng = new Rng(1234);
  const scene = new THREE.Scene();
  const materials = new MaterialLibrary(null, { size: 16 });
  const shots = [];
  const player = {
    pos: { ...playerPos },
    height: 1.8,
    speed: 0,
    dead: false,
    firingRecently: false,
  };
  const manager = new EnemyManager({
    world,
    nav: makeNav(),
    rng,
    bus,
    scene,
    materials,
    player,
    resolveEnemyShot: (ox, oy, oz, dx, dy, dz) => {
      shots.push({ ox, oy, oz, dx, dy, dz });
      return false;
    },
  }, 8);
  return { bus, rng, manager, player, shots, materials, scene };
}

const step = (manager, seconds, perStep) => {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    if (perStep) perStep(i);
    manager.update(1 / 60);
  }
};

describe('EnemyManager', () => {
  let h;
  beforeEach(() => {
    h = harness();
  });

  it('spawns queued enemies up to the live cap', () => {
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    expect(h.manager.live.length).toBe(3);
    expect(h.manager.aliveCount).toBe(3);
  });

  it('never exceeds the simultaneous cap and queues the overflow', () => {
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.wave === undefined));
    expect(h.manager.live.length).toBeLessThanOrEqual(8);
    expect(h.manager.pendingCount).toBeGreaterThan(0);
  });

  it('drains the queue as enemies die', () => {
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.wave === undefined));
    const pendingBefore = h.manager.pendingCount;
    for (const e of h.manager.live.slice(0, 3)) e.takeDamage(999, { kind: 'torso' });
    step(h.manager, ENEMY.corpseFade + 1);
    expect(h.manager.pendingCount).toBeLessThan(pendingBefore);
  });

  it('emits spawn and kill events', () => {
    const events = [];
    h.bus.on('enemy:spawned', () => events.push('spawn'));
    h.bus.on('enemy:killed', () => events.push('kill'));
    h.manager.queue([ENEMY_SPAWNS[1]]);
    h.manager.live[0].takeDamage(999, { kind: 'torso' });
    expect(events).toEqual(['spawn', 'kill']);
    expect(h.manager.totalKilled).toBe(1);
  });

  it('clear() removes everything', () => {
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    h.manager.clear();
    expect(h.manager.live.length).toBe(0);
    expect(h.manager.aliveCount).toBe(0);
  });
});

describe('enemy behaviour', () => {
  it('patrols: a patrolling enemy actually moves along its route', () => {
    const h = harness({ x: 0, y: 0, z: 200 });      // player far away, unseen
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    const e = h.manager.live[0];
    const start = { ...e.pos };
    step(h.manager, 6);
    expect(e.fsm.current).toBe(AI_STATE.PATROL);
    expect(planarDist(e.pos, start)).toBeGreaterThan(1.5);
  });

  it('acquires the player and enters combat', () => {
    const h = harness({ x: -12, y: 0, z: 12 });     // right in front of e_hall_1
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    step(h.manager, 4);
    const e = h.manager.live[0];
    expect(e.awareness).toBeGreaterThan(0);
    expect([AI_STATE.SUSPICIOUS, AI_STATE.COMBAT]).toContain(e.fsm.current);
  });

  it('fires at the player once in combat', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    step(h.manager, 8);
    expect(h.shots.length).toBeGreaterThan(0);
    for (const s of h.shots) {
      expect(Number.isFinite(s.dx) && Number.isFinite(s.dy) && Number.isFinite(s.dz)).toBe(true);
      expect(Math.hypot(s.dx, s.dy, s.dz)).toBeCloseTo(1, 4);
    }
  });

  // Guards the nav-API mismatch: `coverNodesNear` returns a count and fills an
  // array of ids, so treating it as an array of nodes left `currentCover` null
  // forever and enemies simply stood in the open.
  it('selects a cover node during a firefight', () => {
    const h = harness({ x: 0, y: 0, z: 20 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    step(h.manager, 14);
    const withCover = h.manager.live.filter((e) => e.currentCover);
    expect(withCover.length, 'no enemy ever chose cover').toBeGreaterThan(0);
    for (const e of withCover) {
      expect(h.manager.ctx.nav.node(e.currentCover), `unknown cover id ${e.currentCover}`).toBeTruthy();
    }
  });

  it('closes the distance to the player rather than stalling at its spawn', () => {
    const h = harness({ x: 0, y: 0, z: 20 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    const before = h.manager.live.map((e) => planarDist(e.pos, h.player.pos));
    step(h.manager, 16);
    const after = h.manager.live.map((e) => planarDist(e.pos, h.player.pos));
    expect(Math.min(...after)).toBeLessThan(Math.min(...before));
  });

  it('paths out of the server room to a player on the catwalk', () => {
    const h = harness({ x: 28, y: 6.4, z: -18 });
    h.manager.queue([{
      id: 'probe', beat: 'test', x: -10, y: 0, z: -30, yaw: 0, alert: true,
      patrol: ['srv_core', 'srv_aisle_2'],
    }]);
    const e = h.manager.live[0];
    const start = planarDist(e.pos, h.player.pos);
    step(h.manager, 40);
    expect(planarDist(e.pos, h.player.pos)).toBeLessThan(start - 8);
    expect(e.pos.y).toBeGreaterThan(2);   // it climbed the stair tower
  });

  it('loses the player and drops to SEARCH, then gives up', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    step(h.manager, 4);
    const e = h.manager.live[0];
    expect(e.fsm.current).toBe(AI_STATE.COMBAT);
    // Teleport the player out of the level entirely.
    h.player.pos.x = 300;
    h.player.pos.z = 300;
    step(h.manager, 5);
    expect(e.fsm.current).toBe(AI_STATE.SEARCH);
    step(h.manager, ENEMY.searchDuration + 2);
    expect([AI_STATE.PATROL, AI_STATE.IDLE]).toContain(e.fsm.current);
  });

  it('the search wander picks a real neighbouring node', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    step(h.manager, 3);
    const e = h.manager.live[0];
    h.player.pos.x = 300;
    h.player.pos.z = 300;
    step(h.manager, ENEMY.loseSightTime + 1.5);
    expect(e.fsm.current).toBe(AI_STATE.SEARCH);
    const before = { ...e.pos };
    step(h.manager, 8);
    expect(planarDist(e.pos, before)).toBeGreaterThan(0.5);
  });

  it('being shot puts an unaware enemy straight into combat', () => {
    const h = harness({ x: 0, y: 0, z: 200 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    const e = h.manager.live[0];
    step(h.manager, 1);
    e.takeDamage(20, { kind: 'torso', fromX: 0, fromY: 1.6, fromZ: 20 });
    expect(e.fsm.current).toBe(AI_STATE.COMBAT);
    expect(e.hp).toBe(80);
  });

  it('a gunshot nearby raises suspicion', () => {
    const h = harness({ x: 0, y: 0, z: 200 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    const e = h.manager.live[0];
    step(h.manager, 2);
    h.manager.broadcastNoise(e.pos.x + 4, e.pos.y, e.pos.z, 1);
    expect([AI_STATE.SUSPICIOUS, AI_STATE.COMBAT]).toContain(e.fsm.current);
  });

  it('a distant gunshot does not', () => {
    const h = harness({ x: 0, y: 0, z: 200 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    const e = h.manager.live[0];
    step(h.manager, 2);
    const before = e.fsm.current;
    h.manager.broadcastNoise(e.pos.x + 200, e.pos.y, e.pos.z, 1);
    expect(e.fsm.current).toBe(before);
  });

  it('one enemy seeing the player alerts the squad', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    step(h.manager, 6);
    const alerted = h.manager.live.filter(
      (e) => e.fsm.current === AI_STATE.COMBAT || e.fsm.current === AI_STATE.SUSPICIOUS,
    );
    expect(alerted.length).toBeGreaterThan(1);
  });

  it('takes damage with correct multipliers and dies', () => {
    const h = harness();
    h.manager.queue([ENEMY_SPAWNS[1]]);
    const e = h.manager.live[0];
    e.takeDamage(55, { kind: 'head' });
    expect(e.hp).toBe(45);
    expect(e.dead).toBe(false);
    e.takeDamage(45, { kind: 'torso' });
    expect(e.dead).toBe(true);
    expect(e.fsm.current).toBe(AI_STATE.DEAD);
  });

  it('corpses fade out and free their slot', () => {
    const h = harness();
    h.manager.queue([ENEMY_SPAWNS[1]]);
    const e = h.manager.live[0];
    e.takeDamage(999, { kind: 'torso' });
    step(h.manager, ENEMY.corpseFade - 2);
    expect(e.active).toBe(true);
    step(h.manager, 4);
    expect(e.active).toBe(false);
    expect(h.manager.live.length).toBe(0);
  });

  it('a dead enemy stops shooting', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue([ENEMY_SPAWNS.find((s) => s.id === 'e_hall_1')]);
    step(h.manager, 6);
    expect(h.shots.length).toBeGreaterThan(0);
    h.manager.live[0].takeDamage(999, { kind: 'torso' });
    const after = h.shots.length;
    step(h.manager, 5);
    expect(h.shots.length).toBe(after);
  });

  it('enemies never bunch tighter than the separation distance for long', () => {
    const h = harness({ x: 0, y: 0, z: 20 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    let violations = 0;
    step(h.manager, 20, () => {
      const live = h.manager.live.filter((e) => !e.dead);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          if (planarDist(live[i].pos, live[j].pos) < ENEMY.separationDistance * 0.55) violations++;
        }
      }
    });
    expect(violations).toBeLessThan(60);
  });

  it('enemies stay inside the world and on the ground', () => {
    const h = harness({ x: 0, y: 0, z: 20 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.wave === undefined));
    step(h.manager, 25, () => {
      for (const e of h.manager.live) {
        expect(e.pos.y).toBeGreaterThan(-6);
        expect(Number.isFinite(e.pos.x)).toBe(true);
      }
    });
  });

  it('produces no NaN in any enemy state over a long run', () => {
    const h = harness({ x: 0, y: 0, z: 20 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.wave === undefined));
    step(h.manager, 30, (i) => {
      // Move the player around so the AI keeps repathing.
      h.player.pos.x = Math.sin(i / 90) * 8;
      h.player.pos.z = 18 + Math.cos(i / 70) * 6;
      h.player.speed = 4;
    });
    for (const e of h.manager.live) {
      for (const k of ['x', 'y', 'z']) {
        expect(Number.isFinite(e.pos[k]), `pos.${k} is NaN`).toBe(true);
        expect(Number.isFinite(e.vel[k]), `vel.${k} is NaN`).toBe(true);
      }
      expect(Number.isFinite(e.yaw)).toBe(true);
      expect(Number.isFinite(e.awareness)).toBe(true);
    }
  });

  it('traverses every FSM state across a full encounter', () => {
    const h = harness({ x: -12, y: 0, z: 12 });
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    step(h.manager, 3);                       // idle -> patrol -> suspicious/combat
    h.player.pos.x = 300;
    h.player.pos.z = 300;
    step(h.manager, 6);                       // combat -> search
    h.player.pos.x = -12;
    h.player.pos.z = 12;
    step(h.manager, 6);                       // search -> combat
    for (const e of h.manager.live) e.takeDamage(999, { kind: 'torso' });
    step(h.manager, 1);                       // -> dead

    const visited = h.manager.visitedStates();
    for (const s of AI_STATE_ORDER) {
      expect(visited, `never entered ${s}`).toContain(s);
    }
    expect(h.manager.traces().length).toBeGreaterThan(0);
  });

  it('is deterministic for a fixed seed', () => {
    const run = () => {
      const h = harness({ x: 0, y: 0, z: 20 });
      h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
      step(h.manager, 10);
      return h.manager.live.map((e) => `${e.pos.x.toFixed(4)},${e.pos.z.toFixed(4)}`).join('|');
    };
    expect(run()).toBe(run());
  });

  it('disposes cleanly', () => {
    const h = harness();
    h.manager.queue(ENEMY_SPAWNS.filter((s) => s.beat === 'pump_hall'));
    expect(() => {
      h.manager.dispose();
      h.materials.dispose();
    }).not.toThrow();
  });
});
