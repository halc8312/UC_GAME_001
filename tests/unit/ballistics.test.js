import { describe, expect, it } from 'vitest';
import { HITBOX, WEAPONS, WEAPON_ORDER, validateWeaponDef } from '../../src/game/weapons/weapondefs.js';
import {
  applySpreadToDirection, currentSpread, damageAtRange, damageForHit, decaySpread,
  effectiveRangeFor, hitboxMultiplier, makeBallisticState, pelletDirections,
  recoilForShot, recoilPatternValue, registerShot, resetBallisticState, rpmToInterval,
  timeToKill, updateRecoil,
} from '../../src/game/weapons/ballistics.js';
import { Rng } from '../../src/core/rng.js';
import { DEG } from '../../src/core/mathx.js';

const rifle = WEAPONS.rifle;
const shotgun = WEAPONS.shotgun;

const basis = () => ({
  forward: { x: 0, y: 0, z: -1 },
  right: { x: 1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
});

const angleFrom = (dir, forward) =>
  Math.acos(Math.min(1, Math.max(-1, dir.x * forward.x + dir.y * forward.y + dir.z * forward.z)));

describe('weapon definitions', () => {
  it('both shipped weapons validate', () => {
    for (const id of WEAPON_ORDER) {
      const r = validateWeaponDef(WEAPONS[id]);
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('rejects a malformed definition', () => {
    const r = validateWeaponDef({ id: '', rpm: -5 });
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  // Table-driven so an accidental tuning edit fails loudly against GAME_SPEC §4.2.
  const SPEC = [
    ['rifle', 'fireMode', 'auto'],
    ['rifle', 'rpm', 620],
    ['rifle', 'bodyDamage', 22],
    ['rifle', 'headDamage', 55],
    ['rifle', 'falloffStartMeters', 30],
    ['rifle', 'damageFloorFraction', 0.6],
    ['rifle', 'magazineSize', 30],
    ['rifle', 'reserveAmmo', 180],
    ['rifle', 'reloadTime', 2.1],
    ['rifle', 'reloadTacticalTime', 1.6],
    ['rifle', 'baseSpreadHip', 0.35],
    ['rifle', 'baseSpreadAds', 0.06],
    ['rifle', 'recoilPerShot', 0.55],
    ['rifle', 'recoilRecovery', 8],
    ['rifle', 'adsTime', 0.22],
    ['rifle', 'fovHip', 78],
    ['rifle', 'fovAds', 55],
    ['rifle', 'pellets', 1],
    ['shotgun', 'fireMode', 'pump'],
    ['shotgun', 'rpm', 70],
    ['shotgun', 'pellets', 9],
    ['shotgun', 'bodyDamage', 12],
    ['shotgun', 'falloffStartMeters', 14],
    ['shotgun', 'damageFloorFraction', 0.3],
    ['shotgun', 'magazineSize', 6],
    ['shotgun', 'reserveAmmo', 36],
    ['shotgun', 'shellReloadTime', 0.55],
    ['shotgun', 'reloadInterruptible', true],
    ['shotgun', 'baseSpreadHip', 3.6],
    ['shotgun', 'recoilPerShot', 3.2],
    ['shotgun', 'adsTime', 0.18],
    ['shotgun', 'fovAds', 68],
  ];
  it.each(SPEC)('%s.%s matches the spec (%s)', (id, key, value) => {
    expect(WEAPONS[id][key]).toBe(value);
  });

  it('the hitbox table is the spec table', () => {
    expect(HITBOX.head).toBe(2.5);
    expect(HITBOX.torso).toBe(1);
    expect(HITBOX.limb).toBe(0.75);
  });
});

describe('rate of fire', () => {
  it('converts RPM to a shot interval', () => {
    expect(rpmToInterval(620)).toBeCloseTo(0.0968, 4);
    expect(rpmToInterval(70)).toBeCloseTo(0.8571, 4);
    expect(rpmToInterval(0)).toBe(Infinity);
  });

  it('the shotgun pump fits inside its shot interval', () => {
    expect(shotgun.pumpTime).toBeLessThan(rpmToInterval(shotgun.rpm));
  });
});

describe('damage falloff', () => {
  it('is flat at full damage up to the falloff start', () => {
    expect(damageAtRange(rifle, 0)).toBe(22);
    expect(damageAtRange(rifle, 15)).toBe(22);
    expect(damageAtRange(rifle, 30)).toBe(22);
  });

  it('ramps down between start and end', () => {
    const mid = damageAtRange(rifle, 45);
    expect(mid).toBeLessThan(22);
    expect(mid).toBeGreaterThan(22 * 0.6);
    expect(mid).toBeCloseTo(22 * 0.8, 5);
  });

  it('is flat at the floor beyond the falloff end', () => {
    expect(damageAtRange(rifle, 60)).toBeCloseTo(22 * 0.6, 6);
    expect(damageAtRange(rifle, 500)).toBeCloseTo(22 * 0.6, 6);
  });

  it('decreases monotonically', () => {
    let prev = Infinity;
    for (let d = 0; d <= 80; d += 2) {
      const v = damageAtRange(rifle, d);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('applies the shotgun curve per pellet', () => {
    expect(damageAtRange(shotgun, 5)).toBe(12);
    expect(damageAtRange(shotgun, 40)).toBeCloseTo(12 * 0.3, 6);
  });

  it('effectiveRangeFor inverts the curve', () => {
    expect(effectiveRangeFor(rifle, 1)).toBe(30);
    expect(effectiveRangeFor(rifle, 0.6)).toBe(60);
    expect(damageAtRange(rifle, effectiveRangeFor(rifle, 0.8))).toBeCloseTo(22 * 0.8, 5);
  });
});

describe('hitbox multipliers', () => {
  it('applies head, torso and limb factors', () => {
    expect(damageForHit(rifle, 0, 'head')).toBeCloseTo(55);
    expect(damageForHit(rifle, 0, 'torso')).toBeCloseTo(22);
    expect(damageForHit(rifle, 0, 'limb')).toBeCloseTo(16.5);
  });

  it('applies them after falloff too', () => {
    expect(damageForHit(rifle, 60, 'head')).toBeCloseTo(22 * 0.6 * 2.5, 5);
  });

  it('falls back to torso for an unknown hitbox', () => {
    expect(hitboxMultiplier('elbow')).toBe(1);
  });
});

describe('spread', () => {
  it('starts at the weapon base spread', () => {
    const s = makeBallisticState();
    expect(currentSpread(s, rifle, 0, false, false, false)).toBeCloseTo(0.35, 6);
  });

  it('is near zero when fully aimed', () => {
    const s = makeBallisticState();
    expect(currentSpread(s, rifle, 1, false, false, false)).toBeCloseTo(0.06, 6);
  });

  it('grows over a burst and is capped', () => {
    const s = makeBallisticState();
    const before = currentSpread(s, rifle, 0, false, false, false);
    for (let i = 0; i < 10; i++) registerShot(s, rifle);
    const after = currentSpread(s, rifle, 0, false, false, false);
    expect(after).toBeGreaterThan(before);
    for (let i = 0; i < 200; i++) registerShot(s, rifle);
    expect(s.spread).toBeLessThanOrEqual(rifle.maxSpread + 1e-9);
  });

  it('decays back to base after the recovery window', () => {
    const s = makeBallisticState();
    for (let i = 0; i < 10; i++) registerShot(s, rifle);
    for (let i = 0; i < 240; i++) decaySpread(s, rifle, 1 / 60);
    expect(s.spread).toBeCloseTo(0, 5);
  });

  it('does not decay during the recovery delay', () => {
    const s = makeBallisticState();
    registerShot(s, rifle);
    const before = s.spread;
    decaySpread(s, rifle, rifle.spreadRecoveryDelay * 0.5);
    expect(s.spread).toBe(before);
  });

  it('orders stances: crouched < standing < moving < airborne', () => {
    const s = makeBallisticState();
    const crouch = currentSpread(s, rifle, 0, false, true, false);
    const stand = currentSpread(s, rifle, 0, false, false, false);
    const moving = currentSpread(s, rifle, 0, true, false, false);
    const air = currentSpread(s, rifle, 0, true, false, true);
    expect(crouch).toBeLessThan(stand);
    expect(stand).toBeLessThan(moving);
    expect(moving).toBeLessThan(air);
  });

  it('resetBallisticState clears accumulated state', () => {
    const s = makeBallisticState();
    for (let i = 0; i < 5; i++) registerShot(s, rifle);
    s.recoilPitch = 1;
    resetBallisticState(s);
    expect(s.spread).toBe(0);
    expect(s.recoilPitch).toBe(0);
    expect(s.shotIndex).toBe(0);
  });
});

describe('cone sampling', () => {
  it('keeps every hip-fire sample inside the cone and returns unit vectors', () => {
    const rng = new Rng(4242);
    const { forward, right, up } = basis();
    const out = { x: 0, y: 0, z: 0 };
    const cone = 3.0;
    let maxAngle = 0;
    let sumAngle = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      applySpreadToDirection(out, forward, right, up, cone, rng);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
      const a = angleFrom(out, forward);
      maxAngle = Math.max(maxAngle, a);
      sumAngle += a;
    }
    expect(maxAngle).toBeLessThanOrEqual(cone * DEG + 1e-6);
    const meanFraction = (sumAngle / N) / (cone * DEG);
    expect(meanFraction).toBeGreaterThan(0.4);
    expect(meanFraction).toBeLessThan(0.85);
  });

  it('an ADS cone is far tighter than a hip cone', () => {
    const rng = new Rng(11);
    const { forward, right, up } = basis();
    const out = { x: 0, y: 0, z: 0 };
    let hip = 0;
    let ads = 0;
    for (let i = 0; i < 500; i++) {
      applySpreadToDirection(out, forward, right, up, 0.35, rng);
      hip += angleFrom(out, forward);
      applySpreadToDirection(out, forward, right, up, 0.06, rng);
      ads += angleFrom(out, forward);
    }
    expect(ads).toBeLessThan(hip * 0.35);
  });

  it('a zero cone returns the forward direction exactly', () => {
    const rng = new Rng(1);
    const { forward, right, up } = basis();
    const out = { x: 0, y: 0, z: 0 };
    applySpreadToDirection(out, forward, right, up, 0, rng);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('is reproducible for a fixed seed', () => {
    const { forward, right, up } = basis();
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    applySpreadToDirection(a, forward, right, up, 2, new Rng(9));
    applySpreadToDirection(b, forward, right, up, 2, new Rng(9));
    expect(a).toEqual(b);
  });
});

describe('shotgun pellets', () => {
  it('produces exactly `pellets` unit directions inside the cone', () => {
    const rng = new Rng(77);
    const { forward, right, up } = basis();
    const out = [];
    pelletDirections(out, forward, right, up, shotgun, rng);
    expect(out.length).toBe(9);
    for (const d of out) {
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
      expect(angleFrom(d, forward)).toBeLessThanOrEqual(shotgun.baseSpreadHip * DEG + 1e-6);
    }
  });

  it('the pellets are distinct', () => {
    const rng = new Rng(5);
    const { forward, right, up } = basis();
    const out = [];
    pelletDirections(out, forward, right, up, shotgun, rng);
    const keys = new Set(out.map((d) => `${d.x.toFixed(6)},${d.y.toFixed(6)}`));
    expect(keys.size).toBe(9);
  });

  it('reuses the output array without growing it', () => {
    const rng = new Rng(6);
    const { forward, right, up } = basis();
    const out = [];
    pelletDirections(out, forward, right, up, shotgun, rng);
    const first = out[0];
    pelletDirections(out, forward, right, up, shotgun, rng);
    expect(out.length).toBe(9);
    expect(out[0]).toBe(first);
  });

  it('honours an explicit choked cone', () => {
    const rng = new Rng(8);
    const { forward, right, up } = basis();
    const out = [];
    pelletDirections(out, forward, right, up, shotgun, rng, 1.0);
    for (const d of out) expect(angleFrom(d, forward)).toBeLessThanOrEqual(1.0 * DEG + 1e-6);
  });
});

describe('recoil', () => {
  it('is reproducible for a fixed seed', () => {
    const a = [];
    const b = [];
    const r1 = new Rng(31);
    const r2 = new Rng(31);
    for (let i = 0; i < 10; i++) {
      const k = recoilForShot(rifle, i, r1);
      a.push([k.pitch, k.yaw]);
      const k2 = recoilForShot(rifle, i, r2);
      b.push([k2.pitch, k2.yaw]);
    }
    expect(a).toEqual(b);
  });

  it('climbs across a burst then plateaus', () => {
    const rng = new Rng(3);
    const first = recoilForShot(rifle, 0, rng).pitch;
    const eighth = recoilForShot(rifle, 8, rng).pitch;
    const ninth = recoilForShot(rifle, 9, rng).pitch;
    const twentieth = recoilForShot(rifle, 20, rng).pitch;
    expect(eighth).toBeGreaterThan(first);
    expect(ninth).toBeGreaterThan(eighth);
    // The climb saturates at shot 9; everything after is the same kick.
    expect(twentieth).toBeCloseTo(ninth, 6);
  });

  it('accumulates over a burst', () => {
    const s = makeBallisticState();
    const rng = new Rng(12);
    for (let i = 0; i < 8; i++) {
      registerShot(s, rifle);
      const k = recoilForShot(rifle, s.shotIndex, rng);
      s.recoilPitch += k.pitch;
    }
    expect(s.recoilPitch).toBeGreaterThan(0.04);
  });

  it('recovers to under 1% of peak within two seconds', () => {
    const s = makeBallisticState();
    s.recoilPitch = 0.2;
    s.recoilYaw = 0.05;
    const peak = s.recoilPitch;
    for (let i = 0; i < 120; i++) {
      decaySpread(s, rifle, 1 / 60);
      updateRecoil(s, rifle, 1 / 60);
    }
    expect(Math.abs(s.recoilPitch)).toBeLessThan(peak * 0.01);
    expect(Math.abs(s.recoilYaw)).toBeLessThan(0.001);
  });

  it('the shotgun kicks harder than the rifle', () => {
    const rng = new Rng(2);
    expect(recoilForShot(shotgun, 0, rng).pitch)
      .toBeGreaterThan(recoilForShot(rifle, 0, rng).pitch * 3);
  });

  it('the pattern is deterministic per weapon seed and shot index', () => {
    expect(recoilPatternValue(rifle.recoilPatternSeed, 3))
      .toBe(recoilPatternValue(rifle.recoilPatternSeed, 3));
    expect(recoilPatternValue(rifle.recoilPatternSeed, 3))
      .not.toBe(recoilPatternValue(shotgun.recoilPatternSeed, 3));
    for (let i = 0; i < 50; i++) {
      const v = recoilPatternValue(rifle.recoilPatternSeed, i);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('the burst index expires after the reset window', () => {
    const s = makeBallisticState();
    registerShot(s, rifle);
    expect(s.shotIndex).toBe(1);
    s.timeSinceShot = rifle.burstResetTime + 0.1;
    updateRecoil(s, rifle, 1 / 60);
    expect(s.shotIndex).toBe(0);
  });
});

describe('time to kill', () => {
  it('rifle body TTK at 10 m against 100 HP is between 0.25 s and 0.55 s', () => {
    const ttk = timeToKill(rifle, 10, 'torso', 100);
    expect(ttk).toBeGreaterThan(0.25);
    expect(ttk).toBeLessThan(0.55);
  });

  it('rifle headshots kill faster than body shots', () => {
    expect(timeToKill(rifle, 10, 'head', 100)).toBeLessThan(timeToKill(rifle, 10, 'torso', 100));
  });

  it('the shotgun one-shots at point-blank range', () => {
    // 9 pellets x 12 = 108 > 100 HP. At 9 x 11 = 99 it left contractors alive on
    // 1 HP, which is why the per-pellet damage is 12 and not the original 11.
    expect(damageAtRange(shotgun, 2) * shotgun.pellets).toBeGreaterThan(100);
    expect(timeToKill(shotgun, 2, 'torso', 100)).toBe(0);
  });

  it('the shotgun cannot one-shot beyond its falloff', () => {
    expect(timeToKill(shotgun, 40, 'torso', 100)).toBeGreaterThan(0);
  });
});

describe('numeric robustness', () => {
  it('never produces NaN across a fuzz sweep', () => {
    const rng = new Rng(1234);
    const { forward, right, up } = basis();
    const dir = { x: 0, y: 0, z: 0 };
    const pellets = [];
    for (let i = 0; i < 500; i++) {
      const def = i % 2 ? rifle : shotgun;
      const s = makeBallisticState();
      const dist = rng.range(0, 200);
      const ads = rng.next();
      expect(Number.isFinite(damageAtRange(def, dist))).toBe(true);
      expect(Number.isFinite(damageForHit(def, dist, rng.pick(['head', 'torso', 'limb'])))).toBe(true);
      expect(Number.isFinite(
        currentSpread(s, def, ads, rng.chance(0.5), rng.chance(0.5), rng.chance(0.5)),
      )).toBe(true);
      registerShot(s, def);
      decaySpread(s, def, rng.range(0, 0.5));
      updateRecoil(s, def, rng.range(0, 0.5));
      expect(Number.isFinite(s.spread)).toBe(true);
      expect(Number.isFinite(s.recoilPitch)).toBe(true);
      const k = recoilForShot(def, rng.int(0, 40), rng);
      expect(Number.isFinite(k.pitch) && Number.isFinite(k.yaw)).toBe(true);
      applySpreadToDirection(dir, forward, right, up, rng.range(0, 20), rng);
      expect(Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z)).toBe(true);
      pelletDirections(pellets, forward, right, up, def, rng);
      for (const p of pellets) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      }
      expect(Number.isFinite(effectiveRangeFor(def, rng.next()))).toBe(true);
    }
  });

  it('handles negative and zero distances', () => {
    expect(damageAtRange(rifle, -10)).toBe(22);
    expect(damageAtRange(rifle, 0)).toBe(22);
  });
});
