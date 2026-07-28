import { describe, expect, it } from 'vitest';
import { CollisionWorld, RAMP, SOLID, moveAndSlide } from '../../src/game/level/collision.js';
import {
  CATWALK_Y, CHECKPOINTS, ENEMY_SPAWNS, INTERACTABLES, NAV_EDGES, NAV_NODES, PICKUPS,
  PLAYER_SPAWN, WORLD_BOUNDS, ZONES, buildColliders, zoneAt,
} from '../../src/game/level/leveldata.js';
import { NavGraph } from '../../src/game/ai/navgraph.js';
import { MISSION_OBJECTIVES } from '../../src/game/mission/objectives.js';

const colliders = buildColliders();
const world = new CollisionWorld(8).addAll(colliders).build();

const navGraph = (() => {
  const g = new NavGraph();
  for (const n of NAV_NODES) g.addNode(n.id, n.x, n.y, n.z, { zone: n.zone, cover: !!n.cover });
  for (const [a, b] of NAV_EDGES) g.connect(a, b);
  return g.build();
})();

/** Drop an actor at (x,z) from `fromY` and report where it comes to rest. */
function settle(x, y, z, steps = 240) {
  const state = { pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, height: 1.8, grounded: false };
  for (let i = 0; i < steps; i++) {
    state.vel.y -= 22 / 60;
    moveAndSlide(world, state, 1 / 60);
  }
  return state;
}

describe('level geometry', () => {
  it('builds a non-trivial collider set', () => {
    expect(colliders.length).toBeGreaterThan(80);
    for (const c of colliders) {
      expect(c.max.x).toBeGreaterThan(c.min.x);
      expect(c.max.y).toBeGreaterThan(c.min.y);
      expect(c.max.z).toBeGreaterThan(c.min.z);
    }
  });

  it('gives every collider a finite AABB', () => {
    for (const c of colliders) {
      for (const k of ['x', 'y', 'z']) {
        expect(Number.isFinite(c.min[k])).toBe(true);
        expect(Number.isFinite(c.max[k])).toBe(true);
      }
    }
  });

  it('has both solid boxes and ramps', () => {
    expect(colliders.some((c) => c.kind === SOLID)).toBe(true);
    expect(colliders.some((c) => c.kind === RAMP)).toBe(true);
  });

  it('keeps every ramp inside the 50 degree slope limit', () => {
    for (const c of colliders) {
      if (c.kind !== RAMP) continue;
      expect(c.slopeDeg).toBeLessThanOrEqual(50);
    }
  });

  it('fits inside the declared world bounds', () => {
    for (const c of colliders) {
      expect(c.min.x).toBeGreaterThanOrEqual(WORLD_BOUNDS.min.x);
      expect(c.max.x).toBeLessThanOrEqual(WORLD_BOUNDS.max.x);
      expect(c.min.z).toBeGreaterThanOrEqual(WORLD_BOUNDS.min.z);
      expect(c.max.z).toBeLessThanOrEqual(WORLD_BOUNDS.max.z);
    }
  });
});

describe('placements stand on solid ground', () => {
  const groundUnder = (p) => world.groundAt(p.x, p.z, (p.y ?? 0) + 1.0, 0.05);

  it('the player spawn is supported', () => {
    const g = groundUnder(PLAYER_SPAWN);
    expect(g).not.toBeNull();
    expect(Math.abs(g.y - PLAYER_SPAWN.y)).toBeLessThan(0.3);
  });

  it.each(CHECKPOINTS.map((c) => [c.id, c]))('checkpoint %s is supported', (_id, cp) => {
    const g = groundUnder(cp);
    expect(g).not.toBeNull();
    expect(Math.abs(g.y - cp.y)).toBeLessThan(0.35);
  });

  it.each(CHECKPOINTS.map((c) => [c.id, c]))('checkpoint %s has standing headroom', (_id, cp) => {
    expect(world.overlapsSolid(
      cp.x - 0.34, cp.y + 0.08, cp.z - 0.34,
      cp.x + 0.34, cp.y + 1.78, cp.z + 0.34,
    )).toBe(false);
  });

  it.each(ENEMY_SPAWNS.map((s) => [s.id, s]))('enemy spawn %s is supported and clear', (_id, sp) => {
    const g = world.groundAt(sp.x, sp.z, sp.y + 1.0, 0.05);
    expect(g).not.toBeNull();
    expect(Math.abs(g.y - sp.y)).toBeLessThan(0.4);
    expect(world.overlapsSolid(
      sp.x - 0.33, sp.y + 0.1, sp.z - 0.33,
      sp.x + 0.33, sp.y + 1.75, sp.z + 0.33,
    )).toBe(false);
  });

  it.each(NAV_NODES.map((n) => [n.id, n]))('nav node %s is supported', (_id, n) => {
    const g = world.groundAt(n.x, n.z, n.y + 1.0, 0.05);
    expect(g).not.toBeNull();
    expect(Math.abs(g.y - n.y)).toBeLessThan(0.45);
  });

  it.each(NAV_NODES.map((n) => [n.id, n]))('nav node %s is not inside geometry', (_id, n) => {
    expect(world.overlapsSolid(
      n.x - 0.3, n.y + 0.12, n.z - 0.3,
      n.x + 0.3, n.y + 1.7, n.z + 0.3,
    )).toBe(false);
  });

  it.each(PICKUPS.map((p) => [p.id, p]))('pickup %s is reachable from the floor', (_id, p) => {
    const g = world.groundAt(p.x, p.z, p.y + 1.4, 0.05);
    expect(g).not.toBeNull();
    expect(p.y - g.y).toBeLessThan(1.2);
  });

  it.each(INTERACTABLES.map((i) => [i.id, i]))('interactable %s has floor in front of it', (_id, it) => {
    const g = world.groundAt(it.x, it.z, it.y + 3, 0.6);
    expect(g).not.toBeNull();
  });
});

describe('traversability', () => {
  it('the player does not fall out of the world at any checkpoint', () => {
    for (const cp of CHECKPOINTS) {
      const s = settle(cp.x, cp.y + 0.5, cp.z);
      expect(s.pos.y).toBeGreaterThan(WORLD_BOUNDS.min.y);
      expect(s.grounded).toBe(true);
    }
  });

  it('an actor dropped onto every nav node comes to rest on solid ground', () => {
    for (const n of NAV_NODES) {
      const s = settle(n.x, n.y + 1.2, n.z, 180);
      expect(s.pos.y).toBeGreaterThan(WORLD_BOUNDS.min.y);
      expect(s.grounded).toBe(true);
    }
  });

  it('a sweep across the whole playable footprint never drops below the world floor', () => {
    // Coarse grid over the level: any hole in the floor shows up as a fall-out.
    let holes = 0;
    for (let x = -22; x <= 44; x += 2) {
      for (let z = -36; z <= 56; z += 2) {
        const g = world.groundAt(x, z, 30, 0.05);
        if (!g) continue;             // outside the built area — expected
        const s = settle(x, g.y + 0.6, z, 120);
        if (s.pos.y < WORLD_BOUNDS.min.y) holes++;
      }
    }
    expect(holes).toBe(0);
  });

  it('zoneAt classifies each checkpoint into a zone', () => {
    for (const cp of CHECKPOINTS) {
      expect(zoneAt(cp.x, cp.y + 0.5, cp.z)).not.toBeNull();
    }
  });

  it('zoneAt returns null well outside the facility', () => {
    expect(zoneAt(200, 0, 200)).toBeNull();
  });

  it('every zone constant is reachable by some nav node', () => {
    const zones = new Set(NAV_NODES.map((n) => n.zone));
    for (const z of Object.values(ZONES)) expect(zones.has(z)).toBe(true);
  });
});

describe('railings', () => {
  const railings = colliders.filter((c) => c.tag === 'railing');

  it('exist on every elevated walkway', () => {
    expect(railings.length).toBeGreaterThan(10);
  });

  it('are at least waist height so they cannot be walked over', () => {
    // Most are 1.1 m rails; the mezzanine stair is flanked by full-height cages.
    for (const r of railings) {
      expect(r.max.y - r.min.y).toBeGreaterThanOrEqual(1.05);
    }
  });

  // Railings are drawn as open posts and rails. They must stop the player from
  // falling but must not eat bullets or block the AI's line of sight, or shots
  // that visibly pass between the posts would hit nothing.
  it('do not block sight or gunfire', () => {
    for (const r of railings) expect(r.blocksSight).toBe(false);
  });

  it('let a shot cross the catwalk railing but stop the player', () => {
    // Across the catwalk's east railing at x = 30.
    expect(world.lineOfSight(28, 7.0, -12, 34, 7.0, -12)).toBe(true);
    const state = {
      pos: { x: 29.5, y: 6.4, z: -12 },
      vel: { x: 6, y: -1, z: 0 },
      height: 1.8,
      grounded: true,
    };
    for (let i = 0; i < 90; i++) {
      state.vel.x = 6;
      state.vel.y = -1;
      moveAndSlide(world, state, 1 / 60);
    }
    expect(state.pos.x).toBeLessThan(30);
  });

  it('keep the player on the helipad', () => {
    const state = {
      pos: { x: 41, y: 6.4, z: 1 },
      vel: { x: 0, y: 0, z: 0 },
      height: 1.8,
      grounded: true,
    };
    for (let i = 0; i < 180; i++) {
      state.vel.x = 8;
      state.vel.y = -1;
      moveAndSlide(world, state, 1 / 60);
    }
    expect(state.pos.x).toBeLessThan(44);
    expect(state.pos.y).toBeGreaterThan(6);
  });
});

describe('navigation graph', () => {
  it('registers every node and edge', () => {
    expect(navGraph.nodeCount).toBe(NAV_NODES.length);
    for (const [a, b] of NAV_EDGES) {
      expect(navGraph.node(a), `missing node ${a}`).toBeTruthy();
      expect(navGraph.node(b), `missing node ${b}`).toBeTruthy();
    }
  });

  it('links the whole level: every node can reach the helipad', () => {
    const out = [];
    const unreachable = [];
    for (const n of NAV_NODES) {
      if (navGraph.findPath(n.id, 'heli_c', out) === 0) unreachable.push(n.id);
    }
    expect(unreachable).toEqual([]);
  });

  it('links the whole level in reverse too', () => {
    const out = [];
    const unreachable = [];
    for (const n of NAV_NODES) {
      if (navGraph.findPath('heli_c', n.id, out) === 0) unreachable.push(n.id);
    }
    expect(unreachable).toEqual([]);
  });

  it('routes the full mission path from the dock to the helipad', () => {
    const out = [];
    const len = navGraph.findPath('dock_s', 'heli_e', out);
    expect(len).toBeGreaterThan(10);
    expect(out[0]).toBe('dock_s');
    expect(out[len - 1]).toBe('heli_e');
  });

  it('every declared patrol route resolves to real, connected nodes', () => {
    const out = [];
    for (const spawn of ENEMY_SPAWNS) {
      if (!spawn.patrol) continue;
      for (const id of spawn.patrol) {
        expect(navGraph.node(id), `${spawn.id} patrols unknown node ${id}`).toBeTruthy();
      }
      for (let i = 0; i < spawn.patrol.length - 1; i++) {
        const len = navGraph.findPath(spawn.patrol[i], spawn.patrol[i + 1], out);
        expect(len, `${spawn.id}: ${spawn.patrol[i]} -> ${spawn.patrol[i + 1]}`).toBeGreaterThan(0);
      }
    }
  });

  it('every enemy spawn can path to the player start of its beat', () => {
    const out = [];
    const beatTarget = {
      approach: 'dock_n',
      pump_hall: 'hall_s',
      server_room: 'srv_s',
      withdrawal: 'cw_a1',
      extraction: 'heli_c',
    };
    for (const spawn of ENEMY_SPAWNS) {
      const target = beatTarget[spawn.beat];
      const from = navGraph.nearestNode(spawn.x, spawn.y, spawn.z, { maxDist: 8 });
      expect(from, `no nav node near ${spawn.id}`).not.toBe(-1);
      const fromId = typeof from === 'string' ? from : navGraph.nodeAt(from)?.id;
      expect(navGraph.findPath(fromId, target, out), `${spawn.id} -> ${target}`).toBeGreaterThan(0);
    }
  });

  it('has cover nodes in every combat zone', () => {
    const combatZones = [ZONES.APRON, ZONES.PUMP_HALL, ZONES.SERVER_ROOM, ZONES.CATWALK, ZONES.HELIPAD];
    for (const z of combatZones) {
      expect(NAV_NODES.some((n) => n.zone === z && n.cover), `no cover in ${z}`).toBe(true);
    }
  });
});

describe('mission data integrity', () => {
  it('spawns the enemy count the spec promises', () => {
    expect(ENEMY_SPAWNS.length).toBe(18);
    const byBeat = {};
    for (const s of ENEMY_SPAWNS) byBeat[s.beat] = (byBeat[s.beat] || 0) + 1;
    expect(byBeat.approach).toBe(1);
    expect(byBeat.pump_hall).toBe(3);
    expect(byBeat.server_room).toBe(3);
    expect(byBeat.withdrawal).toBe(5);
    expect(byBeat.extraction).toBe(6);
  });

  it('gives every enemy and pickup a unique id', () => {
    const ids = ENEMY_SPAWNS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pids = PICKUPS.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    const nids = NAV_NODES.map((n) => n.id);
    expect(new Set(nids).size).toBe(nids.length);
  });

  it('places the extraction waves in ascending order', () => {
    const waves = ENEMY_SPAWNS.filter((s) => s.beat === 'extraction').map((s) => s.wave);
    expect(waves.every((w) => w !== undefined)).toBe(true);
    expect(Math.max(...waves)).toBe(2);
  });

  it('wires every objective marker to a real location in the level', () => {
    for (const o of MISSION_OBJECTIVES) {
      if (!o.marker) continue;
      const g = world.groundAt(o.marker.x, o.marker.z, o.marker.y + 1.6, 0.5);
      expect(g, `objective ${o.id} marker floats`).not.toBeNull();
    }
  });

  it('links each interactable to an objective or a grant', () => {
    for (const it of INTERACTABLES) {
      expect(Boolean(it.objective || it.grants), `${it.id} does nothing`).toBe(true);
    }
  });

  it('provides two breakers for the two-part power objective', () => {
    const breakers = INTERACTABLES.filter((i) => i.objective === 'obj_power');
    expect(breakers.length).toBe(2);
    expect(MISSION_OBJECTIVES.find((o) => o.id === 'obj_power').count).toBe(2);
  });

  it('puts the checkpoints in mission order along the route', () => {
    expect(CHECKPOINTS.map((c) => c.phase)).toEqual([
      'approach', 'pump_hall', 'server_room', 'withdrawal', 'extraction',
    ]);
    // The route runs from +Z to -Z and then up onto the catwalks.
    expect(CHECKPOINTS[0].z).toBeGreaterThan(CHECKPOINTS[2].z);
    expect(CHECKPOINTS[4].y).toBeCloseTo(CATWALK_Y + 0.05, 5);
  });
});
