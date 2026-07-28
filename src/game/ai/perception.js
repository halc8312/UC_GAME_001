import { clamp, clamp01, DEG } from '../../core/mathx.js';

/** Perception tuning from GAME_SPEC §4.3. */
export const PERCEPTION = {
  fovDeg: 100,
  rangeMeters: 32,
  closeRangeMeters: 4.5,   // sensed regardless of facing
  buildTime: 0.45,         // seconds of continuous sight to reach full awareness
  buildTimeAlerted: 0.15,  // when the target is firing or sprinting
  decayTime: 3.0,
  suspicionThreshold: 0.35,
  combatThreshold: 1.0,
  hearingRadius: 25,       // gunshot stimulus radius
  eyeHeight: 1.62,
};

/** Is `target` inside the observer's view cone and range? Geometry only, no LOS. */
export function inViewCone(obsX, obsZ, obsYaw, tgtX, tgtZ, fovDeg = PERCEPTION.fovDeg, range = PERCEPTION.rangeMeters) {
  const dx = tgtX - obsX;
  const dz = tgtZ - obsZ;
  const dist = Math.hypot(dx, dz);
  if (dist > range) return false;
  if (dist < 0.001) return true;
  // yaw 0 faces -Z
  const fx = -Math.sin(obsYaw);
  const fz = -Math.cos(obsYaw);
  const cosA = (dx / dist) * fx + (dz / dist) * fz;
  return cosA >= Math.cos((fovDeg * 0.5) * DEG);
}

/**
 * Full visibility test: cone + range + an unobstructed line to the torso or head.
 * Two rays rather than one so an enemy behind a waist-high crate can still see a
 * standing player's head — the single-ray version makes AI feel blind.
 */
export function canSee(observer, target, world, cfg = PERCEPTION) {
  const ox = observer.pos.x, oz = observer.pos.z;
  const oy = observer.pos.y + cfg.eyeHeight;
  const dist = Math.hypot(target.pos.x - ox, target.pos.z - oz);
  if (dist > cfg.rangeMeters) return false;

  const near = dist <= cfg.closeRangeMeters;
  if (!near && !inViewCone(ox, oz, observer.yaw, target.pos.x, target.pos.z, cfg.fovDeg, cfg.rangeMeters)) {
    return false;
  }
  const th = target.height ?? 1.8;
  if (world.lineOfSight(ox, oy, oz, target.pos.x, target.pos.y + th * 0.6, target.pos.z)) return true;
  if (world.lineOfSight(ox, oy, oz, target.pos.x, target.pos.y + th * 0.92, target.pos.z)) return true;
  return false;
}

/**
 * Advance an awareness value in [0, combatThreshold].
 * @param {number} awareness current value
 * @param {boolean} visible
 * @param {number} dt
 * @param {object} opts {conspicuous:boolean, distance:number}
 */
export function updateAwareness(awareness, visible, dt, opts = {}, cfg = PERCEPTION) {
  if (visible) {
    const base = opts.conspicuous ? cfg.buildTimeAlerted : cfg.buildTime;
    // Distant targets resolve more slowly; the near end is unchanged.
    const distScale = 1 + clamp01(((opts.distance ?? 0) - 12) / 24) * 1.6;
    return clamp(awareness + dt / (base * distScale), 0, cfg.combatThreshold);
  }
  return clamp(awareness - dt / cfg.decayTime, 0, cfg.combatThreshold);
}

/** Loudness-scaled hearing check for gunshots and impacts. */
export function hears(observer, sourceX, sourceZ, loudness = 1, cfg = PERCEPTION) {
  const d = Math.hypot(sourceX - observer.pos.x, sourceZ - observer.pos.z);
  return d <= cfg.hearingRadius * loudness;
}

/**
 * Accuracy model: enemies are deliberately worse against a moving, distant, or
 * recently-engaged target. Returns the cone half-angle in degrees to fire within.
 */
export function enemyAimCone(distance, targetSpeed, alertness, baseDeg = 1.6) {
  const distTerm = clamp(distance / 30, 0, 1) * 3.2;
  const moveTerm = clamp(targetSpeed / 8, 0, 1) * 2.4;
  const settle = 1 - 0.45 * clamp01(alertness);
  return (baseDeg + distTerm + moveTerm) * settle;
}

/**
 * How good a cover node is against a threat: 1 when the node fully blocks line of
 * sight to a standing target, 0 when fully exposed.
 */
export function coverQuality(nodePos, threatPos, world, standHeight = 1.6) {
  const blockedTorso = !world.lineOfSight(
    threatPos.x, threatPos.y + 1.6, threatPos.z,
    nodePos.x, nodePos.y + standHeight * 0.55, nodePos.z,
  );
  const blockedHead = !world.lineOfSight(
    threatPos.x, threatPos.y + 1.6, threatPos.z,
    nodePos.x, nodePos.y + standHeight, nodePos.z,
  );
  if (blockedTorso && blockedHead) return 1;
  if (blockedTorso) return 0.65;
  return 0;
}
