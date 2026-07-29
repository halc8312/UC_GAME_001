import { describe, expect, it } from 'vitest';
import {
  angleDelta, clamp, clamp01, damp, invLerp, lerp, mean, moveTowards, percentile,
  planarDist, remap, smoothstep, v3, v3add, v3cross, v3dist, v3dot, v3len,
  v3normalize, v3scale, v3sub, wrapAngle,
} from '../../src/core/mathx.js';
import { Rng, rng } from '../../src/core/rng.js';
import { Pool } from '../../src/core/pool.js';
import { EventBus } from '../../src/core/events.js';
import { FIXED_DT, Loop } from '../../src/core/loop.js';
import { DEFAULT_SETTINGS, sanitize } from '../../src/core/storage.js';
import { lookDelta, makeCommand } from '../../src/core/input.js';
import { Metrics } from '../../src/core/metrics.js';

describe('mathx', () => {
  it('clamps to bounds', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(1.5, 0, 3)).toBe(1.5);
    expect(clamp01(2)).toBe(1);
  });

  it('lerp and invLerp are inverses', () => {
    for (const t of [0, 0.25, 0.5, 1]) {
      const v = lerp(10, 30, t);
      expect(invLerp(10, 30, v)).toBeCloseTo(t, 10);
    }
  });

  it('invLerp on a degenerate range returns 0 rather than NaN', () => {
    expect(invLerp(4, 4, 4)).toBe(0);
  });

  it('remap maps between ranges and clamps outside', () => {
    expect(remap(5, 0, 10, 0, 100)).toBeCloseTo(50);
    expect(remap(-5, 0, 10, 0, 100)).toBe(0);
    expect(remap(50, 0, 10, 0, 100)).toBe(100);
  });

  it('smoothstep is monotonic with zero-slope endpoints', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const v = smoothstep(0, 1, x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('damp is frame-rate independent to within a small tolerance', () => {
    const oneBigStep = damp(0, 10, 5, 0.5);
    let many = 0;
    for (let i = 0; i < 50; i++) many = damp(many, 10, 5, 0.01);
    expect(many).toBeCloseTo(oneBigStep, 6);
  });

  it('moveTowards never overshoots', () => {
    expect(moveTowards(0, 1, 10)).toBe(1);
    expect(moveTowards(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(moveTowards(1, 0, 0.25)).toBeCloseTo(0.75);
  });

  it('wrapAngle maps into [-PI, PI)', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    // 3*PI is exactly on the boundary; this implementation resolves it to -PI.
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(Math.PI * 2 + 0.3)).toBeCloseTo(0.3, 6);
    expect(wrapAngle(-Math.PI * 2 - 0.3)).toBeCloseTo(-0.3, 6);
    for (let a = -20; a < 20; a += 0.37) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(w).toBeLessThan(Math.PI + 1e-9);
    }
  });

  it('angleDelta takes the short way round', () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 6);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2, 6);
  });

  it('vec3 helpers compute the expected values', () => {
    const a = v3(1, 2, 3);
    const b = v3(4, 5, 6);
    expect(v3dot(a, b)).toBe(32);
    expect(v3len(v3(3, 4, 0))).toBe(5);
    expect(v3dist(v3(0, 0, 0), v3(0, 3, 4))).toBe(5);
    const out = v3();
    v3add(out, a, b);
    expect([out.x, out.y, out.z]).toEqual([5, 7, 9]);
    v3sub(out, b, a);
    expect([out.x, out.y, out.z]).toEqual([3, 3, 3]);
    v3scale(out, a, 2);
    expect([out.x, out.y, out.z]).toEqual([2, 4, 6]);
    v3cross(out, v3(1, 0, 0), v3(0, 1, 0));
    expect([out.x, out.y, out.z]).toEqual([0, 0, 1]);
  });

  it('v3normalize produces a unit vector and survives a zero vector', () => {
    const out = v3();
    v3normalize(out, v3(0, 5, 0));
    expect(v3len(out)).toBeCloseTo(1);
    v3normalize(out, v3(0, 0, 0));
    expect(v3len(out)).toBe(0);
  });

  it('planarDist ignores height', () => {
    expect(planarDist({ x: 0, y: 100, z: 0 }, { x: 3, y: -50, z: 4 })).toBeCloseTo(5);
  });

  it('percentile and mean match hand-computed values', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(mean(data)).toBe(5.5);
    expect(percentile(data, 50)).toBe(5);
    expect(percentile(data, 100)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it('percentile does not mutate its input', () => {
    const data = [5, 1, 3];
    percentile(data, 50);
    expect(data).toEqual([5, 1, 3]);
  });
});

describe('Rng', () => {
  it('is deterministic for a fixed seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 200; i++) expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(3);
  });

  it('stays in [0,1) across many samples', () => {
    const r = new Rng(7);
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const r = new Rng(99);
    const buckets = new Array(10).fill(0);
    const n = 40000;
    for (let i = 0; i < n; i++) buckets[Math.floor(r.next() * 10)]++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 10 * 0.85);
      expect(b).toBeLessThan(n / 10 * 1.15);
    }
  });

  it('range and int respect their bounds', () => {
    const r = new Rng(3);
    for (let i = 0; i < 2000; i++) {
      const v = r.range(-3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
      const n = r.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('pick always returns an element', () => {
    const r = new Rng(11);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 500; i++) expect(arr).toContain(r.pick(arr));
  });

  it('disc samples land inside the unit circle', () => {
    const r = new Rng(21);
    const out = { x: 0, y: 0 };
    for (let i = 0; i < 5000; i++) {
      r.disc(out);
      expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1.0000001);
    }
  });

  it('save/restore reproduces the stream', () => {
    const r = new Rng(555);
    for (let i = 0; i < 10; i++) r.next();
    const snap = r.save();
    const a = [r.next(), r.next(), r.next()];
    r.restore(snap);
    const b = [r.next(), r.next(), r.next()];
    expect(a).toEqual(b);
  });

  it('reseeding restarts the stream', () => {
    const first = rng.seed(42).next();
    expect(rng.seed(42).next()).toBe(first);
  });
});

describe('Pool', () => {
  it('preallocates and hands out distinct objects', () => {
    const p = new Pool(3, (i) => ({ i }));
    const a = p.acquire();
    const b = p.acquire();
    expect(a).not.toBe(b);
    expect(p.active.length).toBe(2);
    expect(p.freeCount).toBe(1);
  });

  it('returns null and counts starvation when exhausted', () => {
    const p = new Pool(2, () => ({}));
    p.acquire();
    p.acquire();
    expect(p.acquire()).toBeNull();
    expect(p.starved).toBe(1);
  });

  it('release makes an object reusable and runs the reset hook', () => {
    let resets = 0;
    const p = new Pool(1, () => ({ v: 0 }), (o) => { o.v = 0; resets++; });
    const a = p.acquire();
    a.v = 9;
    expect(p.release(a)).toBe(true);
    expect(resets).toBe(1);
    expect(p.acquire().v).toBe(0);
  });

  it('releaseAt is safe inside a reverse loop', () => {
    const p = new Pool(5, (i) => ({ i }));
    for (let i = 0; i < 5; i++) p.acquire();
    for (let i = p.active.length - 1; i >= 0; i--) p.releaseAt(i);
    expect(p.active.length).toBe(0);
    expect(p.freeCount).toBe(5);
  });

  it('tracks peak usage', () => {
    const p = new Pool(4, () => ({}));
    const objs = [p.acquire(), p.acquire(), p.acquire()];
    for (const o of objs) p.release(o);
    expect(p.peak).toBe(3);
  });

  it('releasing an unowned object is a no-op', () => {
    const p = new Pool(2, () => ({}));
    expect(p.release({ not: 'mine' })).toBe(false);
  });
});

describe('EventBus', () => {
  it('delivers to all handlers in registration order', () => {
    const bus = new EventBus();
    const seen = [];
    bus.on('x', () => seen.push(1));
    bus.on('x', () => seen.push(2));
    bus.emit('x', {});
    expect(seen).toEqual([1, 2]);
  });

  it('off removes only the given handler', () => {
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    const fnA = () => a++;
    bus.on('x', fnA);
    bus.on('x', () => b++);
    bus.off('x', fnA);
    bus.emit('x');
    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it('the subscription returns an unsubscribe function', () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on('x', () => n++);
    bus.emit('x');
    off();
    bus.emit('x');
    expect(n).toBe(1);
  });

  it('once fires exactly once', () => {
    const bus = new EventBus();
    let n = 0;
    bus.once('x', () => n++);
    bus.emit('x');
    bus.emit('x');
    expect(n).toBe(1);
  });

  it('emitting an unknown type is safe', () => {
    const bus = new EventBus();
    expect(() => bus.emit('nobody-listening', 1)).not.toThrow();
  });

  it('the log records emissions up to its limit', () => {
    const bus = new EventBus();
    bus.startLog(3);
    for (let i = 0; i < 10; i++) bus.emit('x', i);
    expect(bus.getLog().length).toBe(3);
    bus.clearLog();
    expect(bus.getLog().length).toBe(0);
  });
});

describe('Loop', () => {
  it('runs whole fixed steps and carries the remainder', () => {
    let steps = 0;
    let renders = 0;
    const loop = new Loop(() => steps++, () => renders++);
    loop.advance(FIXED_DT * 2.5);
    expect(steps).toBe(2);
    expect(renders).toBe(1);
    loop.advance(FIXED_DT * 0.6);
    expect(steps).toBe(3);
  });

  it('always passes the same dt to the simulation', () => {
    const dts = new Set();
    const loop = new Loop((dt) => dts.add(dt), () => {});
    loop.advance(0.1);
    loop.advance(0.0031);
    loop.advance(0.05);
    expect([...dts]).toEqual([FIXED_DT]);
  });

  // The clamp must keep protecting the simulation, but it must not be the only
  // record of how long the frame took: clamped frame times make every
  // percentile in the perf report read as exactly the ceiling.
  it('clamps the simulation delta but keeps the raw one for instrumentation', () => {
    let steps = 0;
    const loop = new Loop(() => steps++, () => {});
    let t = 0;
    loop._now = () => t;
    globalThis.requestAnimationFrame = () => 0;
    loop.running = true;
    loop.lastTime = 0;
    t = 900;                       // a 900 ms frame, far past the 250 ms clamp
    loop._frame();
    expect(loop.frameDt).toBeCloseTo(0.25, 6);
    expect(loop.frameDtRaw).toBeCloseTo(0.9, 6);
    expect(steps).toBeLessThanOrEqual(5);
    loop.stop();
  });

  it('caps catch-up steps instead of spiralling', () => {
    let steps = 0;
    const loop = new Loop(() => steps++, () => {});
    loop.advance(10);
    expect(steps).toBeLessThanOrEqual(5);
    expect(loop.droppedSteps).toBeGreaterThan(0);
  });

  it('does not advance the simulation while paused', () => {
    let steps = 0;
    const loop = new Loop(() => steps++, () => {});
    loop.setPaused(true);
    loop.advance(1);
    expect(steps).toBe(0);
    loop.setPaused(false);
    loop.advance(FIXED_DT);
    expect(steps).toBe(1);
  });

  it('stepManual advances exactly n steps', () => {
    let steps = 0;
    const loop = new Loop(() => steps++, () => {});
    loop.stepManual(7);
    expect(steps).toBe(7);
    expect(loop.simTime).toBeCloseTo(FIXED_DT * 7, 10);
  });

  it('timeScale scales accumulated time', () => {
    let steps = 0;
    const loop = new Loop(() => steps++, () => {});
    loop.timeScale = 0.5;
    loop.advance(FIXED_DT * 2);
    expect(steps).toBe(1);
  });
});

describe('settings sanitisation', () => {
  it('falls back to defaults for junk input', () => {
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitize('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(sanitize({ sensitivity: 'fast' }).sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
  });

  it('clamps out-of-range values', () => {
    const s = sanitize({ fov: 900, masterVolume: 12, sensitivity: 99 });
    expect(s.fov).toBeLessThanOrEqual(110);
    expect(s.masterVolume).toBe(1);
    expect(s.sensitivity).toBeLessThanOrEqual(0.02);
  });

  it('keeps valid values and ignores unknown keys', () => {
    const s = sanitize({ fov: 90, headBob: false, bogus: 1 });
    expect(s.fov).toBe(90);
    expect(s.headBob).toBe(false);
    expect('bogus' in s).toBe(false);
  });

  it('rejects a boolean supplied for a numeric key', () => {
    expect(sanitize({ fov: true }).fov).toBe(DEFAULT_SETTINGS.fov);
  });
});

describe('look transform', () => {
  const base = { sensitivity: 0.002, invertY: false };

  it('scales raw pointer movement by sensitivity', () => {
    expect(lookDelta(100, 0, base).x).toBeCloseTo(-0.2, 9);
    expect(lookDelta(0, 100, base).y).toBeCloseTo(-0.2, 9);
  });

  it('inverts only the vertical axis when invertY is set', () => {
    const normal = lookDelta(100, 50, base);
    const inverted = lookDelta(100, 50, { ...base, invertY: true });
    expect(inverted.x).toBeCloseTo(normal.x, 9);
    expect(inverted.y).toBeCloseTo(-normal.y, 9);
  });

  it('doubling sensitivity doubles the delta', () => {
    const a = lookDelta(80, 40, base);
    const b = lookDelta(80, 40, { ...base, sensitivity: 0.004 });
    expect(b.x).toBeCloseTo(a.x * 2, 9);
    expect(b.y).toBeCloseTo(a.y * 2, 9);
  });

  it('is zero for no movement and writes into the out parameter', () => {
    const out = { x: 9, y: 9 };
    lookDelta(0, 0, base, out);
    expect(out).toEqual({ x: -0, y: -0 });
  });

  it('makeCommand starts fully neutral', () => {
    const c = makeCommand();
    expect(c.moveX).toBe(0);
    expect(c.fire).toBe(false);
    expect(c.slot).toBe(-1);
  });
});

describe('Metrics', () => {
  it('summarises frame samples with percentiles', () => {
    const m = new Metrics(100);
    let t = 0;
    m._now = () => t;
    for (let i = 0; i < 50; i++) {
      m.beginSim();
      t += 1;
      m.endSim();
      m.lastRender = 2;
      m.push(16 + (i % 5));
    }
    const s = m.summary();
    expect(s.samples).toBe(50);
    expect(s.frameMs.p50).toBeGreaterThan(15);
    expect(s.frameMs.p99).toBeGreaterThanOrEqual(s.frameMs.p50);
    expect(s.simMs.mean).toBeCloseTo(1, 3);
    expect(s.simFrameMs.mean).toBeCloseTo(1, 3);
    expect(s.stepsPerFrame.mean).toBeCloseTo(1, 3);
  });

  // The 4 ms budget in GAME_SPEC is the cost of one 60 Hz step. A frame that
  // catches up five steps pays five times that, and reporting either number as
  // the other is how a perf report ends up lying in one direction or the other.
  it('separates per-step cost from the frame total when the loop catches up', () => {
    const m = new Metrics(100);
    let t = 0;
    m._now = () => t;
    for (let frame = 0; frame < 20; frame++) {
      for (let step = 0; step < 5; step++) {
        m.beginSim();
        t += 2;
        m.endSim();
      }
      m.push(250);
    }
    const s = m.summary();
    expect(s.simMs.mean).toBeCloseTo(2, 3);
    expect(s.simFrameMs.mean).toBeCloseTo(10, 3);
    expect(s.stepsPerFrame.mean).toBeCloseTo(5, 3);
    expect(s.stepsPerFrame.max).toBe(5);
  });

  // A paused frame runs no steps at all; the per-step average must not inherit
  // the previous frame's cost, and must not divide by zero.
  it('records zero simulation cost for a frame that runs no steps', () => {
    const m = new Metrics(10);
    let t = 0;
    m._now = () => t;
    m.beginSim();
    t += 3;
    m.endSim();
    m.push(16);
    m.push(16);
    const s = m.summary();
    expect(s.simMs.mean).toBeCloseTo(1.5, 3);
    expect(s.simFrameMs.max).toBeCloseTo(3, 3);
    expect(s.stepsPerFrame.mean).toBeCloseTo(0.5, 3);
  });

  it('is a bounded ring buffer', () => {
    const m = new Metrics(10);
    for (let i = 0; i < 100; i++) m.push(i);
    expect(m.summary().samples).toBe(10);
  });

  it('records marks', () => {
    const m = new Metrics(4);
    m.mark('start', { beat: 'dock' });
    expect(m.summary().marks[0].name).toBe('start');
    expect(m.summary().marks[0].beat).toBe('dock');
  });

  it('reset clears counters', () => {
    const m = new Metrics(8);
    m.push(16);
    m.mark('x');
    m.reset();
    expect(m.summary().samples).toBe(0);
    expect(m.summary().marks.length).toBe(0);
  });
});
