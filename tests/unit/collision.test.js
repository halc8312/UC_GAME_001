import { describe, expect, it } from 'vitest';
import {
  CollisionWorld, MOVE_DEFAULTS, RAMP, SOLID, SURFACE, box, moveAndSlide, ramp, rampHeightAt,
} from '../../src/game/level/collision.js';

/** A flat floor plus optional extras, with the grid already built. */
function worldWith(...extra) {
  const w = new CollisionWorld(8);
  w.add(box([-50, -1, -50], [50, 0, 50], SURFACE.CONCRETE, { tag: 'floor' }));
  for (const e of extra) w.add(e);
  return w.build();
}

const actor = (x, y, z) => ({
  pos: { x, y, z },
  vel: { x: 0, y: 0, z: 0 },
  height: 1.8,
  grounded: false,
});

/** Run n fixed steps of movement, returning the final state. */
function simulate(world, state, steps, cfg = MOVE_DEFAULTS, perStep) {
  let last = null;
  for (let i = 0; i < steps; i++) {
    if (perStep) perStep(state, i);
    last = moveAndSlide(world, state, 1 / 60, cfg);
  }
  return last;
}

describe('collider construction', () => {
  it('box stores min/max and a surface', () => {
    const b = box([0, 0, 0], [1, 2, 3], SURFACE.METAL, { tag: 't' });
    expect(b.kind).toBe(SOLID);
    expect(b.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(b.max).toEqual({ x: 1, y: 2, z: 3 });
    expect(b.surface).toBe(SURFACE.METAL);
    expect(b.tag).toBe('t');
  });

  it('every collider gets a unique id', () => {
    const ids = new Set();
    for (let i = 0; i < 40; i++) ids.add(box([0, 0, 0], [1, 1, 1]).id);
    expect(ids.size).toBe(40);
  });

  it('ramp records its axis, direction and slope angle', () => {
    const r = ramp([0, 0, 0], [4, 4, 4], 'z', 1);
    expect(r.kind).toBe(RAMP);
    expect(r.axis).toBe('z');
    expect(r.slopeDeg).toBeCloseTo(45, 4);
  });

  it('rampHeightAt interpolates along the slope axis and clamps outside', () => {
    const r = ramp([0, 0, 0], [10, 5, 4], 'x', 1);
    expect(rampHeightAt(r, 0, 2)).toBeCloseTo(0);
    expect(rampHeightAt(r, 5, 2)).toBeCloseTo(2.5);
    expect(rampHeightAt(r, 10, 2)).toBeCloseTo(5);
    expect(rampHeightAt(r, -50, 2)).toBeCloseTo(0);
    expect(rampHeightAt(r, 999, 2)).toBeCloseTo(5);
  });

  it('a reversed ramp rises the other way', () => {
    const r = ramp([0, 0, 0], [10, 5, 4], 'x', -1);
    expect(rampHeightAt(r, 0, 2)).toBeCloseTo(5);
    expect(rampHeightAt(r, 10, 2)).toBeCloseTo(0);
  });
});

describe('CollisionWorld queries', () => {
  it('finds overlapping colliders and ignores distant ones', () => {
    const w = worldWith(box([10, 0, 10], [12, 3, 12]));
    expect(w.query(10.5, 0.5, 10.5, 11.5, 1.5, 11.5).length).toBeGreaterThan(0);
    expect(w.query(30, 5, 30, 31, 6, 31).length).toBe(0);
  });

  it('spans multiple broadphase cells correctly', () => {
    // A 40 m wall crosses several 8 m grid cells; it must be found at both ends.
    const w = worldWith(box([-20, 0, 0], [20, 4, 1]));
    expect(w.query(-19, 1, 0.2, -18, 2, 0.8).length).toBe(1);
    expect(w.query(18, 1, 0.2, 19, 2, 0.8).length).toBe(1);
  });

  it('overlapsSolid ignores ramps', () => {
    const w = worldWith(ramp([0, 0, 0], [4, 4, 4], 'x', 1));
    expect(w.overlapsSolid(1, 0.1, 1, 2, 1, 2)).toBe(false);
  });

  it('groundAt returns the highest surface at or below the probe', () => {
    const w = worldWith(box([0, 0, 0], [4, 2, 4]));
    expect(w.groundAt(2, 2, 3).y).toBe(2);
    expect(w.groundAt(20, 20, 3).y).toBe(0);
  });

  it('groundAt follows a ramp surface', () => {
    const w = worldWith(ramp([0, 0, 0], [10, 5, 4], 'x', 1));
    expect(w.groundAt(5, 2, 6).y).toBeCloseTo(2.5, 3);
  });

  it('groundAt returns null below the whole world', () => {
    const w = worldWith();
    expect(w.groundAt(0, 0, -50)).toBeNull();
  });
});

describe('raycast', () => {
  it('hits a box in front and reports the distance and normal', () => {
    const w = worldWith(box([4, 0, -1], [6, 4, 1]));
    const r = w.raycast(0, 1, 0, 1, 0, 0, 20);
    expect(r.hit).toBe(true);
    expect(r.dist).toBeCloseTo(4, 2);
    expect(r.normal.x).toBe(-1);
  });

  it('misses when nothing is in the way', () => {
    const w = worldWith();
    expect(w.raycast(0, 5, 0, 1, 0, 0, 20).hit).toBe(false);
  });

  it('returns the nearest of several hits', () => {
    const w = worldWith(box([10, 0, -1], [11, 4, 1]), box([4, 0, -1], [5, 4, 1]));
    expect(w.raycast(0, 1, 0, 1, 0, 0, 30).dist).toBeCloseTo(4, 2);
  });

  it('respects maxDist', () => {
    const w = worldWith(box([40, 0, -1], [41, 4, 1]));
    expect(w.raycast(0, 1, 0, 1, 0, 0, 10).hit).toBe(false);
    expect(w.raycast(0, 1, 0, 1, 0, 0, 60).hit).toBe(true);
  });

  it('traces long rays across many grid cells', () => {
    const w = worldWith(box([80, 0, -1], [81, 4, 1]));
    const r = w.raycast(0, 1, 0, 1, 0, 0, 200);
    expect(r.hit).toBe(true);
    expect(r.dist).toBeCloseTo(80, 1);
  });

  it('reports the hit point on the surface', () => {
    const w = worldWith(box([4, 0, -1], [6, 4, 1]));
    const r = w.raycast(0, 1.5, 0, 1, 0, 0, 20);
    expect(r.point.x).toBeCloseTo(4, 2);
    expect(r.point.y).toBeCloseTo(1.5, 2);
  });

  it('lineOfSight is blocked by a wall and clear without one', () => {
    const w = worldWith(box([4, 0, -3], [5, 5, 3]));
    expect(w.lineOfSight(0, 1.6, 0, 10, 1.6, 0)).toBe(false);
    expect(w.lineOfSight(0, 1.6, 0, 3, 1.6, 0)).toBe(true);
  });

  it('lineOfSight ignores colliders flagged as non-occluding', () => {
    const w = worldWith(box([4, 0, -3], [5, 5, 3], SURFACE.METAL, { blocksSight: false }));
    expect(w.lineOfSight(0, 1.6, 0, 10, 1.6, 0)).toBe(true);
  });

  it('lineOfSight to a coincident point is trivially true', () => {
    const w = worldWith();
    expect(w.lineOfSight(1, 1, 1, 1, 1, 1)).toBe(true);
  });
});

describe('moveAndSlide', () => {
  it('lands on the floor and reports grounded', () => {
    const w = worldWith();
    const a = actor(0, 3, 0);
    a.vel.y = -5;
    simulate(w, a, 60);
    expect(a.pos.y).toBeCloseTo(0, 4);
    expect(a.grounded).toBe(true);
  });

  it('does not fall through the floor at high speed', () => {
    const w = worldWith();
    const a = actor(0, 40, 0);
    a.vel.y = -180;
    simulate(w, a, 120);
    expect(a.pos.y).toBeGreaterThanOrEqual(-0.01);
  });

  it('stops against a wall instead of passing through it', () => {
    const w = worldWith(box([5, 0, -5], [6, 4, 5]));
    const a = actor(0, 0, 0);
    a.grounded = true;
    simulate(w, a, 200, MOVE_DEFAULTS, (s) => { s.vel.x = 8; s.vel.y = -1; });
    expect(a.pos.x).toBeLessThan(5);
    expect(a.pos.x).toBeGreaterThan(4.5);
  });

  it('slides along a wall rather than sticking to it', () => {
    const w = worldWith(box([5, 0, -50], [6, 4, 50]));
    const a = actor(0, 0, 0);
    a.grounded = true;
    simulate(w, a, 120, MOVE_DEFAULTS, (s) => { s.vel.x = 6; s.vel.z = 6; s.vel.y = -1; });
    // Blocked on X, but Z motion is preserved — that is the "slide".
    expect(a.pos.x).toBeLessThan(5);
    expect(a.pos.z).toBeGreaterThan(5);
  });

  it('steps up a 0.45 m ledge without losing horizontal speed', () => {
    const w = worldWith(box([3, 0, -5], [9, 0.4, 5]));
    const a = actor(0, 0, 0);
    a.grounded = true;
    let stepped = 0;
    for (let i = 0; i < 90; i++) {
      a.vel.x = 5.2;
      a.vel.y = -1;
      const r = moveAndSlide(w, a, 1 / 60);
      if (r.steppedUp > 0) stepped = r.steppedUp;
    }
    expect(a.pos.x).toBeGreaterThan(5);
    expect(a.pos.y).toBeCloseTo(0.4, 2);
    expect(stepped).toBeGreaterThan(0);
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(5.2, 2);
  });

  it('refuses to step up a ledge taller than stepHeight', () => {
    const w = worldWith(box([3, 0, -5], [9, 1.2, 5]));
    const a = actor(0, 0, 0);
    a.grounded = true;
    simulate(w, a, 120, MOVE_DEFAULTS, (s) => { s.vel.x = 5.2; s.vel.y = -1; });
    expect(a.pos.y).toBeLessThan(0.1);
    expect(a.pos.x).toBeLessThan(3);
  });

  it('walks up a shallow ramp', () => {
    const w = worldWith(ramp([2, 0, -3], [10, 3, 3], 'x', 1));
    const a = actor(0, 0, 0);
    a.grounded = true;
    simulate(w, a, 200, MOVE_DEFAULTS, (s) => { s.vel.x = 4; s.vel.y = -1; });
    expect(a.pos.x).toBeGreaterThan(8);
    expect(a.pos.y).toBeGreaterThan(2);
  });

  it('will not stand on a ramp steeper than the slope limit', () => {
    // 20 m of rise over 2 m of run — about 84 degrees.
    const w = worldWith(ramp([2, 0, -3], [4, 20, 3], 'x', 1));
    const a = actor(3, 22, 0);
    let grounded = false;
    for (let i = 0; i < 60; i++) {
      a.vel.y -= 22 / 60;
      const r = moveAndSlide(w, a, 1 / 60);
      grounded = grounded || r.grounded;
    }
    expect(grounded).toBe(false);
  });

  it('reports a ceiling hit and cancels upward velocity', () => {
    const w = worldWith(box([-5, 2.4, -5], [5, 3.4, 5]));
    const a = actor(0, 0, 0);
    a.vel.y = 8;
    const r = moveAndSlide(w, a, 1 / 60);
    for (let i = 0; i < 20 && !r.hitCeiling; i++) {
      a.vel.y = 8;
      Object.assign(r, moveAndSlide(w, a, 1 / 60));
    }
    expect(a.pos.y).toBeLessThan(0.7);
  });

  it('reports the ground surface tag it landed on', () => {
    const w = worldWith(box([-2, 0, -2], [2, 1, 2], SURFACE.GRATE));
    const a = actor(0, 2, 0);
    a.vel.y = -4;
    let surface = '';
    for (let i = 0; i < 40; i++) surface = moveAndSlide(w, a, 1 / 60).groundSurface;
    expect(surface).toBe(SURFACE.GRATE);
  });

  it('never leaves the actor embedded inside geometry', () => {
    const w = worldWith(box([0, 0, 0], [4, 4, 4]));
    const a = actor(2, 0.2, 2); // spawned inside the block
    simulate(w, a, 30, MOVE_DEFAULTS, (s) => { s.vel.y = -2; });
    const inside =
      a.pos.x > 0 && a.pos.x < 4 && a.pos.z > 0 && a.pos.z < 4 && a.pos.y < 3.9;
    expect(inside).toBe(false);
  });

  it('is corner-safe: cannot squeeze through the seam between two boxes', () => {
    const w = worldWith(
      box([2, 0, -6], [3, 4, -0.001]),
      box([2, 0, 0.001], [3, 4, 6]),
    );
    const a = actor(0, 0, 0);
    a.grounded = true;
    simulate(w, a, 240, MOVE_DEFAULTS, (s) => { s.vel.x = 8; s.vel.y = -1; });
    expect(a.pos.x).toBeLessThan(2);
  });

  it('reports landing speed on impact', () => {
    const w = worldWith();
    const a = actor(0, 6, 0);
    let landSpeed = 0;
    for (let i = 0; i < 120; i++) {
      a.vel.y -= 22 / 60;
      const r = moveAndSlide(w, a, 1 / 60);
      if (r.landedSpeed > 0) landSpeed = r.landedSpeed;
    }
    expect(landSpeed).toBeGreaterThan(8);
  });
});
