import { describe, expect, it } from 'vitest';
import {
  ARMOR_ABSORB, HITBOX, addArmor, applyDamage, damageDirection, fallDamage, heal,
  hitboxesFor, rayHitboxes,
} from '../../src/game/combat/damage.js';
import { AI_STATE, AI_STATE_ORDER, StateMachine } from '../../src/game/ai/fsm.js';
import {
  PERCEPTION, canSee, coverQuality, enemyAimCone, hears, inViewCone, updateAwareness,
} from '../../src/game/ai/perception.js';
import { CollisionWorld, box } from '../../src/game/level/collision.js';
import { MOVE, PlayerController, accelerate, applyFriction, JUMP_VELOCITY } from '../../src/game/player/controller.js';
import { makeCommand } from '../../src/core/input.js';

const flatWorld = (...extra) =>
  new CollisionWorld(8)
    .add(box([-60, -1, -60], [60, 0, 60]))
    && null;

function world(...extra) {
  const w = new CollisionWorld(8);
  w.add(box([-60, -1, -60], [60, 0, 60]));
  for (const e of extra) w.add(e);
  return w.build();
}

describe('hitboxes', () => {
  it('produces head, torso and limb boxes stacked to 1.79 m', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 0 }, []);
    const kinds = boxes.map((b) => b.kind);
    expect(kinds).toContain(HITBOX.HEAD);
    expect(kinds).toContain(HITBOX.TORSO);
    expect(kinds).toContain(HITBOX.LIMB);
    expect(Math.max(...boxes.map((b) => b.maxY))).toBeCloseTo(1.79, 3);
  });

  it('crouching squashes the stack', () => {
    const stand = hitboxesFor({ x: 0, y: 0, z: 0 }, [], 0);
    const crouch = hitboxesFor({ x: 0, y: 0, z: 0 }, [], 1);
    expect(Math.max(...crouch.map((b) => b.maxY)))
      .toBeLessThan(Math.max(...stand.map((b) => b.maxY)));
  });

  it('reuses the output array', () => {
    const out = [];
    hitboxesFor({ x: 0, y: 0, z: 0 }, out);
    const n = out.length;
    hitboxesFor({ x: 5, y: 0, z: 5 }, out);
    expect(out.length).toBe(n);
    expect(out[0].minX).toBeCloseTo(5 - 0.14, 5);
  });

  it('a head-height ray registers a head hit', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 10 }, []);
    const r = rayHitboxes(0, 1.66, 0, 0, 0, 1, 50, boxes);
    expect(r.hit).toBe(true);
    expect(r.kind).toBe(HITBOX.HEAD);
    expect(r.dist).toBeCloseTo(10 - 0.14, 2);
  });

  it('a chest-height ray registers a torso hit', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 10 }, []);
    expect(rayHitboxes(0, 1.2, 0, 0, 0, 1, 50, boxes).kind).toBe(HITBOX.TORSO);
  });

  it('a knee-height ray registers a limb hit', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 10 }, []);
    expect(rayHitboxes(0, 0.4, 0, 0, 0, 1, 50, boxes).kind).toBe(HITBOX.LIMB);
  });

  it('a ray over the head misses', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 10 }, []);
    expect(rayHitboxes(0, 2.4, 0, 0, 0, 1, 50, boxes).hit).toBe(false);
  });

  it('respects maxDist', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 40 }, []);
    expect(rayHitboxes(0, 1.2, 0, 0, 0, 1, 20, boxes).hit).toBe(false);
  });

  it('returns the nearest hitbox when several overlap the ray', () => {
    const boxes = hitboxesFor({ x: 0, y: 0, z: 6 }, []);
    const r = rayHitboxes(0, 1.2, 0, 0, 0, 1, 50, boxes);
    expect(r.dist).toBeLessThan(6);
  });
});

describe('damage model', () => {
  it('reduces hp and reports the amount dealt', () => {
    const t = { hp: 100, armor: 0, dead: false };
    const r = applyDamage(t, 30);
    expect(t.hp).toBe(70);
    expect(r.dealt).toBe(30);
    expect(r.killed).toBe(false);
  });

  it('kills at zero and never goes negative', () => {
    const t = { hp: 20, armor: 0, dead: false };
    const r = applyDamage(t, 50);
    expect(t.hp).toBe(0);
    expect(t.dead).toBe(true);
    expect(r.killed).toBe(true);
  });

  it('armour absorbs a fraction and is consumed', () => {
    const t = { hp: 100, armor: 100, dead: false };
    applyDamage(t, 40);
    expect(t.armor).toBeCloseTo(100 - 40 * ARMOR_ABSORB, 5);
    expect(t.hp).toBeCloseTo(100 - 40 * (1 - ARMOR_ABSORB), 5);
  });

  it('armour never makes the target immortal', () => {
    const t = { hp: 100, armor: 100, dead: false };
    for (let i = 0; i < 40; i++) applyDamage(t, 20);
    expect(t.dead).toBe(true);
  });

  it('ignoreArmor bypasses the plate', () => {
    const t = { hp: 100, armor: 100, dead: false };
    applyDamage(t, 30, { ignoreArmor: true });
    expect(t.armor).toBe(100);
    expect(t.hp).toBe(70);
  });

  it('does nothing to an already-dead target', () => {
    const t = { hp: 0, armor: 0, dead: true };
    expect(applyDamage(t, 50).dealt).toBe(0);
  });

  it('ignores non-positive damage', () => {
    const t = { hp: 100, armor: 0, dead: false };
    expect(applyDamage(t, 0).dealt).toBe(0);
    expect(applyDamage(t, -5).dealt).toBe(0);
  });

  it('heal and addArmor clamp to their maxima', () => {
    const t = { hp: 80, armor: 90, dead: false };
    expect(heal(t, 50, 100)).toBe(20);
    expect(t.hp).toBe(100);
    expect(addArmor(t, 50, 100)).toBe(10);
    expect(t.armor).toBe(100);
  });
});

describe('fall damage', () => {
  it('is free below the safe speed', () => {
    expect(fallDamage(5)).toBe(0);
    expect(fallDamage(9)).toBe(0);
  });

  it('scales up to lethal', () => {
    expect(fallDamage(14)).toBeGreaterThan(0);
    expect(fallDamage(26)).toBeGreaterThanOrEqual(100);
    expect(fallDamage(60)).toBeGreaterThanOrEqual(100);
  });

  it('increases monotonically', () => {
    let prev = -1;
    for (let s = 0; s < 40; s += 1) {
      const d = fallDamage(s);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('damage direction', () => {
  it('reports zero for a hit from straight ahead', () => {
    // yaw 0 faces -Z, so a source at -Z is dead ahead.
    expect(Math.abs(damageDirection(0, 0, 0, 0, -5))).toBeLessThan(1e-6);
  });

  it('reports a right-hand hit as a positive angle', () => {
    expect(damageDirection(0, 0, 0, 5, 0)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('reports a hit from behind as ±PI', () => {
    expect(Math.abs(damageDirection(0, 0, 0, 0, 5))).toBeCloseTo(Math.PI, 5);
  });

  it('always returns a wrapped angle', () => {
    for (let yaw = -10; yaw < 10; yaw += 0.31) {
      const a = damageDirection(yaw, 0, 0, 3, 4);
      expect(a).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(a).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('state machine', () => {
  const states = () => ({
    idle: { enter: (o) => o.log.push('enter:idle'), exit: (o) => o.log.push('exit:idle') },
    patrol: { enter: (o) => o.log.push('enter:patrol'), update: (o) => o.log.push('tick') },
    dead: {},
  });

  it('runs the initial enter handler', () => {
    const owner = { log: [] };
    new StateMachine(states(), 'idle', owner);
    expect(owner.log).toEqual(['enter:idle']);
  });

  it('transitions and fires exit then enter', () => {
    const owner = { log: [] };
    const fsm = new StateMachine(states(), 'idle', owner);
    owner.log.length = 0;
    expect(fsm.transition('patrol')).toBe(true);
    expect(owner.log).toEqual(['exit:idle', 'enter:patrol']);
    expect(fsm.previous).toBe('idle');
  });

  it('ignores a transition to the current or an unknown state', () => {
    const fsm = new StateMachine(states(), 'idle', { log: [] });
    expect(fsm.transition('idle')).toBe(false);
    expect(fsm.transition('nope')).toBe(false);
    expect(fsm.transitions).toBe(0);
  });

  it('accumulates time in state and resets it on transition', () => {
    const fsm = new StateMachine(states(), 'idle', { log: [] });
    fsm.update(0.5, {});
    fsm.update(0.5, {});
    expect(fsm.timeInState).toBeCloseTo(1);
    fsm.transition('patrol');
    expect(fsm.timeInState).toBe(0);
  });

  it('records a bounded transition trace and the visited set', () => {
    const fsm = new StateMachine(states(), 'idle', { log: [] });
    for (let i = 0; i < 200; i++) fsm.transition(i % 2 ? 'idle' : 'patrol', 'r');
    expect(fsm.trace.length).toBeLessThanOrEqual(fsm.traceLimit);
    expect(fsm.hasVisitedAll(['idle', 'patrol'])).toBe(true);
    expect(fsm.hasVisitedAll(['idle', 'patrol', 'dead'])).toBe(false);
  });

  it('exposes the six AI states in order', () => {
    expect(AI_STATE_ORDER).toEqual([
      AI_STATE.IDLE, AI_STATE.PATROL, AI_STATE.SUSPICIOUS,
      AI_STATE.COMBAT, AI_STATE.SEARCH, AI_STATE.DEAD,
    ]);
  });
});

describe('perception', () => {
  it('sees a target straight ahead within range', () => {
    expect(inViewCone(0, 0, 0, 0, -10)).toBe(true);
  });

  it('does not see a target behind', () => {
    expect(inViewCone(0, 0, 0, 0, 10)).toBe(false);
  });

  it('respects the cone half-angle', () => {
    // 100 degree FOV means +/-50 degrees. 40 degrees off-axis is in, 60 is out.
    const d = 10;
    const inAngle = 40 * (Math.PI / 180);
    const outAngle = 60 * (Math.PI / 180);
    expect(inViewCone(0, 0, 0, Math.sin(inAngle) * d, -Math.cos(inAngle) * d)).toBe(true);
    expect(inViewCone(0, 0, 0, Math.sin(outAngle) * d, -Math.cos(outAngle) * d)).toBe(false);
  });

  it('respects the range limit', () => {
    expect(inViewCone(0, 0, 0, 0, -PERCEPTION.rangeMeters - 1)).toBe(false);
  });

  it('canSee needs line of sight', () => {
    const w = world(box([-4, 0, -6], [4, 4, -5]));
    const observer = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
    const target = { pos: { x: 0, y: 0, z: -12 }, height: 1.8 };
    expect(canSee(observer, target, w)).toBe(false);
    const near = { pos: { x: 0, y: 0, z: -3 }, height: 1.8 };
    expect(canSee(observer, near, w)).toBe(true);
  });

  it('canSee ignores facing at very close range', () => {
    const w = world();
    const observer = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
    const behind = { pos: { x: 0, y: 0, z: 2 }, height: 1.8 };
    expect(canSee(observer, behind, w)).toBe(true);
  });

  it('canSee spots a target whose head clears low cover', () => {
    // Waist-high crate: the torso ray is blocked, the head ray is not.
    const w = world(box([-2, 0, -6], [2, 1.0, -5.5]));
    const observer = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
    const target = { pos: { x: 0, y: 0, z: -10 }, height: 1.8 };
    expect(canSee(observer, target, w)).toBe(true);
  });

  it('awareness builds while visible and decays when not', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = updateAwareness(a, true, 1 / 60, { distance: 5 });
    expect(a).toBeGreaterThan(PERCEPTION.suspicionThreshold);
    const peak = a;
    for (let i = 0; i < 60; i++) a = updateAwareness(a, false, 1 / 60, {});
    expect(a).toBeLessThan(peak);
  });

  it('awareness is clamped to the combat threshold', () => {
    let a = 0;
    for (let i = 0; i < 600; i++) a = updateAwareness(a, true, 1 / 60, { distance: 1 });
    expect(a).toBe(PERCEPTION.combatThreshold);
  });

  it('never goes below zero', () => {
    let a = 0;
    for (let i = 0; i < 600; i++) a = updateAwareness(a, false, 1 / 60, {});
    expect(a).toBe(0);
  });

  it('a conspicuous target is spotted faster', () => {
    let quiet = 0;
    let loud = 0;
    for (let i = 0; i < 12; i++) {
      quiet = updateAwareness(quiet, true, 1 / 60, { distance: 8 });
      loud = updateAwareness(loud, true, 1 / 60, { distance: 8, conspicuous: true });
    }
    expect(loud).toBeGreaterThan(quiet);
  });

  it('a distant target is spotted more slowly', () => {
    let near = 0;
    let far = 0;
    for (let i = 0; i < 12; i++) {
      near = updateAwareness(near, true, 1 / 60, { distance: 4 });
      far = updateAwareness(far, true, 1 / 60, { distance: 30 });
    }
    expect(near).toBeGreaterThan(far);
  });

  it('hears gunshots inside the stimulus radius only', () => {
    const observer = { pos: { x: 0, y: 0, z: 0 } };
    expect(hears(observer, 10, 0)).toBe(true);
    expect(hears(observer, 40, 0)).toBe(false);
  });

  it('the aim cone widens with range and target speed', () => {
    const still = enemyAimCone(5, 0, 1);
    const far = enemyAimCone(30, 0, 1);
    const running = enemyAimCone(5, 8, 1);
    expect(far).toBeGreaterThan(still);
    expect(running).toBeGreaterThan(still);
  });

  it('coverQuality rewards nodes that block line of sight', () => {
    const w = world(box([-1, 0, 4], [1, 2.4, 5]));
    const threat = { x: 0, y: 0, z: 0 };
    const behind = { x: 0, y: 0, z: 8 };
    const exposed = { x: 8, y: 0, z: 8 };
    expect(coverQuality(behind, threat, w)).toBeGreaterThan(coverQuality(exposed, threat, w));
  });
});

describe('player controller', () => {
  const make = () => {
    const w = world();
    const c = new PlayerController(w);
    c.setPosition(0, 0, 0);
    c.grounded = true;
    return c;
  };

  const cmd = (patch = {}) => ({ ...makeCommand(), ...patch });

  const run = (c, command, steps) => {
    for (let i = 0; i < steps; i++) c.update(command, 1 / 60);
    return c;
  };

  it('reaches walk speed within 5%', () => {
    const c = run(make(), cmd({ moveZ: 1 }), 120);
    expect(c.speed).toBeGreaterThan(MOVE.walkSpeed * 0.95);
    expect(c.speed).toBeLessThan(MOVE.walkSpeed * 1.05);
  });

  it('reaches sprint speed within 5%', () => {
    const c = run(make(), cmd({ moveZ: 1, sprint: true }), 180);
    expect(c.speed).toBeGreaterThan(MOVE.sprintSpeed * 0.95);
    expect(c.speed).toBeLessThan(MOVE.sprintSpeed * 1.05);
  });

  it('reaches crouch speed within 5%', () => {
    const c = run(make(), cmd({ moveZ: 1, crouch: true }), 180);
    expect(c.speed).toBeGreaterThan(MOVE.crouchSpeed * 0.95);
    expect(c.speed).toBeLessThan(MOVE.crouchSpeed * 1.05);
  });

  it('does not sprint backwards or while aiming', () => {
    const back = run(make(), cmd({ moveZ: -1, sprint: true }), 120);
    expect(back.sprinting).toBe(false);
    const c = make();
    for (let i = 0; i < 120; i++) c.update(cmd({ moveZ: 1, sprint: true }), 1 / 60, { aiming: true });
    expect(c.sprinting).toBe(false);
  });

  it('does not exceed walk speed moving diagonally', () => {
    const c = run(make(), cmd({ moveZ: 1, moveX: 1 }), 150);
    expect(c.speed).toBeLessThan(MOVE.walkSpeed * 1.05);
  });

  it('decelerates to rest with no input', () => {
    const c = run(make(), cmd({ moveZ: 1 }), 120);
    run(c, cmd(), 180);
    expect(c.speed).toBeLessThan(0.01);
  });

  it('jumps to roughly the spec apex', () => {
    const c = make();
    c.update(cmd({ jump: true }), 1 / 60);
    let apex = 0;
    for (let i = 0; i < 120; i++) {
      c.update(cmd(), 1 / 60);
      apex = Math.max(apex, c.pos.y);
    }
    expect(apex).toBeGreaterThan(MOVE.jumpHeight * 0.9);
    expect(apex).toBeLessThan(MOVE.jumpHeight * 1.15);
    expect(JUMP_VELOCITY).toBeCloseTo(Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight), 6);
  });

  it('lands back on the ground after a jump', () => {
    const c = make();
    c.update(cmd({ jump: true }), 1 / 60);
    for (let i = 0; i < 200; i++) c.update(cmd(), 1 / 60);
    expect(c.grounded).toBe(true);
    expect(c.pos.y).toBeCloseTo(0, 3);
  });

  it('coyote time allows a jump just after leaving a ledge', () => {
    const w = world(box([-2, 0, -2], [2, 1, 2]));
    const c = new PlayerController(w);
    c.setPosition(0, 1, 0);
    c.update(cmd(), 1 / 60);
    expect(c.grounded).toBe(true);
    // Walk off the edge, then jump within the coyote window.
    for (let i = 0; i < 4; i++) c.update(cmd({ moveX: 1 }), 1 / 60);
    const before = c.pos.y;
    c.update(cmd({ moveX: 1, jump: true }), 1 / 60);
    expect(c.vel.y).toBeGreaterThan(0);
    expect(before).toBeDefined();
  });

  it('cannot jump while crouched', () => {
    const c = make();
    c.update(cmd({ crouch: true, jump: true }), 1 / 60);
    expect(c.vel.y).toBeLessThanOrEqual(0);
  });

  it('crouching lowers the collision height and the eye height', () => {
    const c = make();
    run(c, cmd({ crouch: true }), 30);
    expect(c.height).toBeCloseTo(MOVE.crouchHeight, 2);
    expect(c.eyeHeight).toBeCloseTo(MOVE.crouchEye, 2);
  });

  it('cannot stand up under a low ceiling', () => {
    // Start in the open, crouch, then crawl under the overhang — spawning inside
    // the geometry would only be testing the depenetration path.
    const w = world(box([2, 1.2, -3], [9, 2.2, 3]));
    const c = new PlayerController(w);
    c.setPosition(0, 0, 0);
    run(c, cmd({ crouch: true }), 30);
    expect(c.crouching).toBe(true);
    run(c, cmd({ crouch: true, moveX: 1 }), 120);
    expect(c.pos.x).toBeGreaterThan(3);
    run(c, cmd({ moveX: 1 }), 60);
    expect(c.crouching).toBe(true);
    expect(c.height).toBeLessThan(MOVE.standHeight);
    // Back out into the open and standing becomes possible again.
    run(c, cmd({ moveX: -1 }), 180);
    run(c, cmd(), 40);
    expect(c.crouching).toBe(false);
  });

  it('clamps pitch to the spec limit', () => {
    const c = make();
    for (let i = 0; i < 100; i++) c.update(cmd({ lookY: 0.3 }), 1 / 60);
    expect(c.pitch).toBeCloseTo(MOVE.maxPitch, 5);
    for (let i = 0; i < 200; i++) c.update(cmd({ lookY: -0.3 }), 1 / 60);
    expect(c.pitch).toBeCloseTo(-MOVE.maxPitch, 5);
  });

  it('yaw is unlimited', () => {
    const c = make();
    for (let i = 0; i < 100; i++) c.update(cmd({ lookX: 0.5 }), 1 / 60);
    expect(Math.abs(c.yaw)).toBeGreaterThan(Math.PI * 2);
  });

  it('forward() is a unit vector matching yaw and pitch', () => {
    const c = make();
    c.yaw = 0;
    c.pitch = 0;
    const f = c.forward();
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.z).toBeCloseTo(-1, 6);
    c.yaw = Math.PI / 2;
    const f2 = c.forward();
    expect(f2.x).toBeCloseTo(-1, 6);
    expect(Math.hypot(f2.x, f2.y, f2.z)).toBeCloseTo(1, 6);
  });

  it('a frozen controller does not move', () => {
    const c = make();
    c.frozen = true;
    run(c, cmd({ moveZ: 1 }), 60);
    expect(c.pos.z).toBe(0);
  });

  it('accumulates footsteps by distance', () => {
    const c = make();
    run(c, cmd({ moveZ: 1 }), 120);
    let steps = 0;
    for (let i = 0; i < 240; i++) {
      c.update(cmd({ moveZ: 1 }), 1 / 60);
      if (c.takeFootstep(2.1)) steps++;
    }
    expect(steps).toBeGreaterThan(3);
  });

  it('accelerate never exceeds the wish speed', () => {
    const vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i++) accelerate(vel, 1, 0, 5.2, 60, 1 / 60);
    expect(Math.hypot(vel.x, vel.z)).toBeCloseTo(5.2, 6);
  });

  it('applyFriction brings a slow actor to a full stop', () => {
    const vel = { x: 0.0005, y: 0, z: 0 };
    applyFriction(vel, 10, 1 / 60);
    expect(vel.x).toBe(0);
  });
});
