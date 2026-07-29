/**
 * Ballistics maths — pure, allocation-free, deterministic.
 *
 * Every stochastic function takes an `Rng` so a seeded run reproduces exactly.
 * Angles in weapon definitions are degrees; everything returned to the camera is
 * radians. Cone angles are HALF-angles throughout.
 */
import { clamp, clamp01, DEG, lerp } from '../../core/mathx.js';
import { HITBOX } from './weapondefs.js';

export function rpmToInterval(rpm) {
  return rpm > 0 ? 60 / rpm : Infinity;
}

/** Fresh per-weapon ballistic state. */
export function makeBallisticState() {
  return {
    spread: 0,          // accumulated bloom, degrees
    shotIndex: 0,       // index within the current burst, drives the recoil pattern
    totalShots: 0,
    timeSinceShot: 999,
    recoilPitch: 0,     // radians, applied to the camera and recovered
    recoilYaw: 0,
  };
}

export function resetBallisticState(state) {
  state.spread = 0;
  state.shotIndex = 0;
  state.timeSinceShot = 999;
  state.recoilPitch = 0;
  state.recoilYaw = 0;
  return state;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

/** Per-projectile damage after range falloff (full → linear ramp → flat floor). */
export function damageAtRange(def, distance) {
  const d = Math.max(0, distance);
  const floor = def.bodyDamage * def.damageFloorFraction;
  if (d <= def.falloffStartMeters) return def.bodyDamage;
  if (d >= def.falloffEndMeters) return floor;
  const t = (d - def.falloffStartMeters) / (def.falloffEndMeters - def.falloffStartMeters);
  return lerp(def.bodyDamage, floor, t);
}

export function hitboxMultiplier(kind) {
  const m = HITBOX[kind];
  return typeof m === 'number' ? m : HITBOX.torso;
}

export function damageForHit(def, distance, hitboxKind) {
  return damageAtRange(def, distance) * hitboxMultiplier(hitboxKind);
}

/** Distance at which damage first reaches `fraction` of the base value. */
export function effectiveRangeFor(def, fraction) {
  const f = clamp(fraction, def.damageFloorFraction, 1);
  if (f >= 1) return def.falloffStartMeters;
  if (f <= def.damageFloorFraction) return def.falloffEndMeters;
  const t = (1 - f) / (1 - def.damageFloorFraction);
  return lerp(def.falloffStartMeters, def.falloffEndMeters, t);
}

/** Seconds to kill `targetHp` at a range, ignoring reloads. */
export function timeToKill(def, distance, hitboxKind, targetHp = 100) {
  const per = damageForHit(def, distance, hitboxKind) * def.pellets;
  if (per <= 0) return Infinity;
  const shots = Math.ceil(targetHp / per);
  const cycle = rpmToInterval(def.rpm);
  return (shots - 1) * cycle;
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

/**
 * Cone half-angle in degrees for the next shot.
 *
 * Base spread interpolates hip→ADS, accumulated bloom is scaled down (not removed)
 * by aiming, movement adds, and stance multiplies. Ordering guaranteed by the
 * model: crouched < standing < moving < airborne.
 */
export function currentSpread(state, def, adsFactor = 0, moving = false, crouched = false, airborne = false) {
  const a = clamp01(adsFactor);
  const base = lerp(def.baseSpreadHip, def.baseSpreadAds, a);
  const bloom = state.spread * lerp(1, def.adsSpreadScale, a);
  let total = base + bloom;
  if (moving) total += def.moveSpreadAdd * lerp(1, 0.6, a);
  if (crouched) total *= def.crouchSpreadMultiplier;
  if (airborne) total *= def.airSpreadMultiplier;
  const cap = def.maxSpread * (airborne ? def.airSpreadMultiplier : 1);
  return clamp(total, 0, cap);
}

export function registerShot(state, def) {
  state.spread = Math.min(state.spread + def.spreadGrowthPerShot, def.maxSpread);
  state.shotIndex++;
  state.totalShots++;
  state.timeSinceShot = 0;
  return state;
}

export function decaySpread(state, def, dt) {
  state.timeSinceShot += dt;
  if (state.timeSinceShot < def.spreadRecoveryDelay) return state;
  state.spread = Math.max(0, state.spread - def.spreadDecayPerSecond * dt);
  return state;
}

/**
 * Sample a direction inside the cone and write it to `out`.
 * Uniform over the disc at unit distance, which is the standard shooter feel:
 * denser toward the centre than a uniform-solid-angle sample.
 */
export function applySpreadToDirection(out, forward, right, up, spreadDeg, rng) {
  const half = Math.max(0, spreadDeg) * DEG;
  if (half <= 1e-7) {
    out.x = forward.x; out.y = forward.y; out.z = forward.z;
    return out;
  }
  const t = Math.tan(half);
  const angle = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * t;
  const dx = Math.cos(angle) * r;
  const dy = Math.sin(angle) * r;
  let x = forward.x + right.x * dx + up.x * dy;
  let y = forward.y + right.y * dx + up.y * dy;
  let z = forward.z + right.z * dx + up.z * dy;
  const len = Math.hypot(x, y, z) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  return out;
}

/**
 * Fill `out` with `def.pellets` unit directions. Pellets are distributed on
 * jittered rings rather than purely at random so a shotgun blast covers its cone
 * evenly instead of clumping — clumped pellets read as "the gun missed".
 */
export function pelletDirections(out, forward, right, up, def, rng, spreadDeg) {
  const n = def.pellets;
  const half = Math.max(0, spreadDeg === undefined ? def.baseSpreadHip : spreadDeg) * DEG;
  const t = Math.tan(half);
  while (out.length < n) out.push({ x: 0, y: 0, z: 0 });
  out.length = n;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const phase = rng.next() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    // Sunflower distribution + jitter: even coverage, still random per shot.
    const rr = Math.sqrt((i + 0.5 + rng.range(-0.35, 0.35)) / n) * t;
    const ang = phase + i * golden + rng.range(-0.25, 0.25);
    const dx = Math.cos(ang) * rr;
    const dy = Math.sin(ang) * rr;
    const o = out[i];
    let x = forward.x + right.x * dx + up.x * dy;
    let y = forward.y + right.y * dx + up.y * dy;
    let z = forward.z + right.z * dx + up.z * dy;
    const len = Math.hypot(x, y, z) || 1;
    o.x = x / len;
    o.y = y / len;
    o.z = z / len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recoil
// ---------------------------------------------------------------------------

/** Deterministic pseudo-pattern in [-1,1] from the weapon seed and shot index. */
export function recoilPatternValue(seed, shotIndex) {
  let h = (seed ^ (shotIndex * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967296) * 2 - 1;
}

const _kick = { pitch: 0, yaw: 0 };

/**
 * Vertical kick plus horizontal jitter for one shot, in radians.
 * The vertical component climbs across a burst and plateaus, so the first rounds
 * stay controllable and sustained fire is not.
 */
export function recoilForShot(def, shotIndex, rng) {
  const climb = 0.72 + 0.5 * clamp01(shotIndex / 9);
  _kick.pitch = def.recoilPerShot * DEG * climb;
  const pattern = recoilPatternValue(def.recoilPatternSeed, shotIndex);
  const jitter = rng ? rng.range(-0.45, 0.45) : 0;
  _kick.yaw = def.recoilHorizontal * DEG * (pattern * 0.75 + jitter);
  return _kick;
}

/** Exponential recovery toward zero; also expires the burst index. */
export function updateRecoil(state, def, dt) {
  const k = Math.exp(-def.recoilRecovery * dt);
  state.recoilPitch *= k;
  state.recoilYaw *= k;
  if (Math.abs(state.recoilPitch) < 1e-6) state.recoilPitch = 0;
  if (Math.abs(state.recoilYaw) < 1e-6) state.recoilYaw = 0;
  if (state.timeSinceShot > def.burstResetTime) state.shotIndex = 0;
  return state;
}
