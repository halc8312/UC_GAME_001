/**
 * Weapon definitions — the data contract for GAME_SPEC §4.2.
 *
 * Pure data + validation. No Three.js, no DOM, no `Math.random()`. The runtime
 * weapon system reads these; `ballistics.js` consumes them for the maths.
 *
 * Units used throughout:
 *   - distances / ranges: metres
 *   - times: seconds
 *   - angles stored in defs: DEGREES (ballistics converts to radians at the edge)
 *   - damage: hit points, PER PELLET (shotgun damage is 11 per pellet, ×9 pellets)
 *
 * Interpretations of the spec table are marked `SPEC-GAP:` — the spec fixes the
 * headline numbers but not every supporting constant, so those are tuned here and
 * called out in the summary rather than invented silently.
 */

/**
 * Damage multipliers by hitbox. GAME_SPEC §4.3 ("headshot ×2.5, limb ×0.75").
 * Note 22 × 2.5 = 55, which is exactly the rifle's spec'd head damage, so the
 * shared table and the weapon table agree without a special case.
 */
export const HITBOX = Object.freeze({
  head: 2.5,
  torso: 1.0,
  limb: 0.75,
});

/** Canonical sound-event names owned by the weapons (resolved by the audio graph). */
export const WEAPON_SOUNDS = Object.freeze({
  rifleFire: 'rifle_fire',
  shotgunFire: 'shotgun_fire',
  rifleReloadStart: 'rifle_reload_start',
  rifleReloadEnd: 'rifle_reload_end',
  shotgunShell: 'shotgun_shell',
  shotgunPump: 'shotgun_pump',
  dryFire: 'dry_fire',
});

/**
 * MX-4 Carbine — the starting weapon.
 * Spec row: full-auto / 620 RPM / 22 body, 55 head, falloff to 60% past 30 m /
 * mag 30 / reserve 180 / reload 2.1 s (1.6 tactical) / spread 0.35 hip, 0.06 ADS /
 * recoil 0.55 vertical + horizontal jitter, 8 /s recovery / ADS 0.22 s, FOV 78 → 55.
 */
const RIFLE = {
  id: 'rifle',
  displayName: 'MX-4 Carbine',
  fireMode: 'auto',

  // --- rate of fire -------------------------------------------------------
  rpm: 620,
  pellets: 1,

  // --- damage -------------------------------------------------------------
  bodyDamage: 22,
  headDamage: 55, // == bodyDamage * HITBOX.head
  headMultiplier: HITBOX.head,
  limbMultiplier: HITBOX.limb,
  /** Full damage at/below this range. */
  falloffStartMeters: 30,
  /** SPEC-GAP: spec fixes the start (30 m) and the floor (60%), not the ramp end.
   *  Ramp ends at 2× the start, which keeps the curve readable at gameplay ranges. */
  falloffEndMeters: 60,
  damageFloorFraction: 0.6,
  /** Longest hitscan trace; beyond this the shot simply does not register. */
  maxRangeMeters: 120,

  // --- ammunition & reload ------------------------------------------------
  magazineSize: 30,
  reserveAmmo: 180,
  reloadType: 'magazine',
  reloadTime: 2.1,
  /** Chamber still loaded → shorter animation. */
  reloadTacticalTime: 1.6,
  shellReloadTime: 0,
  reloadInterruptible: false,

  // --- spread (degrees, cone HALF-angle) ----------------------------------
  baseSpreadHip: 0.35,
  baseSpreadAds: 0.06,
  /** SPEC-GAP: how much accumulated bloom survives at full ADS. */
  adsSpreadScale: 0.2,
  spreadGrowthPerShot: 0.09,
  spreadDecayPerSecond: 2.2,
  /** SPEC-GAP: bloom holds this long after the last shot before it starts decaying,
   *  otherwise sustained auto fire would decay faster than it grows. */
  spreadRecoveryDelay: 0.12,
  /** Hard cap on standing hip-fire spread (base + bloom). */
  maxSpread: 2.6,
  /** SPEC-GAP: stance/motion modifiers — spec only says spread grows and decays. */
  moveSpreadAdd: 0.9,
  crouchSpreadMultiplier: 0.7,
  airSpreadMultiplier: 5.0,

  // --- recoil (degrees) ---------------------------------------------------
  recoilPerShot: 0.55,
  /** Horizontal jitter half-range per shot ("with horizontal jitter"). */
  recoilHorizontal: 0.22,
  recoilRecovery: 8,
  /** Fixed per-weapon offset so the deterministic climb pattern differs per gun. */
  recoilPatternSeed: 0x4d5834,
  /** Burst index resets this long after the last shot. */
  burstResetTime: 0.35,

  // --- aiming -------------------------------------------------------------
  adsTime: 0.22,
  fovHip: 78,
  fovAds: 55,

  // --- handling -----------------------------------------------------------
  pumpTime: 0,
  switchTime: 0.35,
  tracerEveryNShots: 3,

  sounds: Object.freeze({
    fire: WEAPON_SOUNDS.rifleFire,
    reloadStart: WEAPON_SOUNDS.rifleReloadStart,
    reloadEnd: WEAPON_SOUNDS.rifleReloadEnd,
    dry: WEAPON_SOUNDS.dryFire,
  }),

  /** Viewmodel tuning (metres of travel / relative sway gain). */
  viewmodel: Object.freeze({
    kickBack: 0.045,
    kickUp: 0.02,
    swayScale: 1.0,
  }),
};

/**
 * Breacher-12 — the server-room pickup.
 * Spec row: pump / 70 RPM / 12 × 9 pellets, falloff to 30% past 14 m / mag 6 /
 * reserve 36 / 0.55 s per shell, interruptible / 3.6° cone / 3.2° kick /
 * ADS 0.18 s, FOV 78 → 68.
 */
const SHOTGUN = {
  id: 'shotgun',
  displayName: 'Breacher-12',
  fireMode: 'pump',

  rpm: 70,
  pellets: 9,

  bodyDamage: 12,
  headDamage: 30, // == bodyDamage * HITBOX.head, per pellet
  headMultiplier: HITBOX.head,
  limbMultiplier: HITBOX.limb,
  falloffStartMeters: 14,
  /** SPEC-GAP: same 2× rule as the rifle. */
  falloffEndMeters: 28,
  damageFloorFraction: 0.3,
  maxRangeMeters: 45,

  magazineSize: 6,
  reserveAmmo: 36,
  reloadType: 'shell',
  /** Derived: a full reload from empty is magazineSize × shellReloadTime. */
  reloadTime: 3.3,
  reloadTacticalTime: 3.3,
  shellReloadTime: 0.55,
  reloadInterruptible: true,

  baseSpreadHip: 3.6,
  /** SPEC-GAP: spec gives one cone (3.6°); ADS chokes it, matching the mild 78→68 FOV. */
  baseSpreadAds: 2.4,
  adsSpreadScale: 0.65,
  spreadGrowthPerShot: 0.6,
  spreadDecayPerSecond: 1.2,
  spreadRecoveryDelay: 0.2,
  maxSpread: 6.0,
  moveSpreadAdd: 1.2,
  crouchSpreadMultiplier: 0.8,
  airSpreadMultiplier: 2.0,

  recoilPerShot: 3.2,
  recoilHorizontal: 0.9,
  recoilRecovery: 6,
  recoilPatternSeed: 0xb12c40,
  burstResetTime: 0.6,

  adsTime: 0.18,
  fovHip: 78,
  fovAds: 68,

  /** Cycle time; must fit inside the 60/70 s shot interval. */
  pumpTime: 0.42,
  switchTime: 0.45,
  tracerEveryNShots: 3,

  sounds: Object.freeze({
    fire: WEAPON_SOUNDS.shotgunFire,
    shell: WEAPON_SOUNDS.shotgunShell,
    pump: WEAPON_SOUNDS.shotgunPump,
    dry: WEAPON_SOUNDS.dryFire,
  }),

  viewmodel: Object.freeze({
    kickBack: 0.11,
    kickUp: 0.055,
    swayScale: 1.25,
  }),
};

/** The shipped loadout, keyed by id. */
export const WEAPONS = Object.freeze({
  rifle: Object.freeze(RIFLE),
  shotgun: Object.freeze(SHOTGUN),
});

/** Stable ordering for the `1` / `2` keys and the mouse wheel. */
export const WEAPON_ORDER = Object.freeze(['rifle', 'shotgun']);

export const FIRE_MODES = Object.freeze(['auto', 'pump']);
export const RELOAD_TYPES = Object.freeze(['magazine', 'shell']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isNonNeg = (v) => isNum(v) && v >= 0;
const isPosInt = (v) => isPos(v) && Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Structural + tuning sanity check on a weapon definition.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateWeaponDef(def) {
  const problems = [];
  const bad = (msg) => problems.push(msg);

  if (!def || typeof def !== 'object') {
    return { ok: false, problems: ['def is not an object'] };
  }

  // identity ---------------------------------------------------------------
  if (!isStr(def.id)) bad('id must be a non-empty string');
  if (!isStr(def.displayName)) bad('displayName must be a non-empty string');
  if (!FIRE_MODES.includes(def.fireMode)) {
    bad(`fireMode must be one of ${FIRE_MODES.join('|')}, got ${String(def.fireMode)}`);
  }

  // rate of fire -----------------------------------------------------------
  if (!isPos(def.rpm)) bad('rpm must be > 0');
  if (!isPosInt(def.pellets)) bad('pellets must be a positive integer');

  // damage -----------------------------------------------------------------
  if (!isPos(def.bodyDamage)) bad('bodyDamage must be > 0');
  if (!isPos(def.headMultiplier)) bad('headMultiplier must be > 0');
  if (!isPos(def.limbMultiplier)) bad('limbMultiplier must be > 0');
  if (def.headMultiplier !== HITBOX.head) {
    bad(`headMultiplier must match HITBOX.head (${HITBOX.head})`);
  }
  if (def.limbMultiplier !== HITBOX.limb) {
    bad(`limbMultiplier must match HITBOX.limb (${HITBOX.limb})`);
  }
  if (isNum(def.headDamage) && isNum(def.bodyDamage) && isNum(def.headMultiplier)) {
    const expected = def.bodyDamage * def.headMultiplier;
    if (Math.abs(def.headDamage - expected) > 1e-9) {
      bad(`headDamage ${def.headDamage} != bodyDamage * headMultiplier (${expected})`);
    }
  }
  if (!isPos(def.falloffStartMeters)) bad('falloffStartMeters must be > 0');
  if (!isPos(def.falloffEndMeters)) bad('falloffEndMeters must be > 0');
  if (isNum(def.falloffStartMeters) && isNum(def.falloffEndMeters) &&
      def.falloffEndMeters <= def.falloffStartMeters) {
    bad('falloffEndMeters must be > falloffStartMeters');
  }
  if (!(isNum(def.damageFloorFraction) && def.damageFloorFraction > 0 &&
        def.damageFloorFraction <= 1)) {
    bad('damageFloorFraction must be in (0, 1]');
  }
  if (!isPos(def.maxRangeMeters)) bad('maxRangeMeters must be > 0');
  else if (isNum(def.falloffEndMeters) && def.maxRangeMeters < def.falloffEndMeters) {
    bad('maxRangeMeters must be >= falloffEndMeters');
  }

  // ammunition -------------------------------------------------------------
  if (!isPosInt(def.magazineSize)) bad('magazineSize must be a positive integer');
  if (!(isNum(def.reserveAmmo) && Number.isInteger(def.reserveAmmo) && def.reserveAmmo >= 0)) {
    bad('reserveAmmo must be a non-negative integer');
  }
  if (!RELOAD_TYPES.includes(def.reloadType)) {
    bad(`reloadType must be one of ${RELOAD_TYPES.join('|')}`);
  }
  if (!isPos(def.reloadTime)) bad('reloadTime must be > 0');
  if (!isPos(def.reloadTacticalTime)) bad('reloadTacticalTime must be > 0');
  else if (isNum(def.reloadTime) && def.reloadTacticalTime > def.reloadTime) {
    bad('reloadTacticalTime must be <= reloadTime');
  }
  if (def.reloadType === 'shell') {
    if (!isPos(def.shellReloadTime)) bad('shell reloads need shellReloadTime > 0');
    if (def.reloadInterruptible !== true) bad('shell reloads must be interruptible');
    if (isPos(def.shellReloadTime) && isPosInt(def.magazineSize) && isNum(def.reloadTime)) {
      const full = def.shellReloadTime * def.magazineSize;
      if (Math.abs(def.reloadTime - full) > 1e-9) {
        bad(`reloadTime ${def.reloadTime} != magazineSize * shellReloadTime (${full})`);
      }
    }
  } else if (!isNonNeg(def.shellReloadTime)) {
    bad('shellReloadTime must be a number (0 for magazine reloads)');
  }

  // spread -----------------------------------------------------------------
  if (!isPos(def.baseSpreadHip)) bad('baseSpreadHip must be > 0');
  if (!isNonNeg(def.baseSpreadAds)) bad('baseSpreadAds must be >= 0');
  else if (isNum(def.baseSpreadHip) && def.baseSpreadAds > def.baseSpreadHip) {
    bad('baseSpreadAds must be <= baseSpreadHip');
  }
  if (!(isNum(def.adsSpreadScale) && def.adsSpreadScale >= 0 && def.adsSpreadScale <= 1)) {
    bad('adsSpreadScale must be in [0, 1]');
  }
  if (!isPos(def.spreadGrowthPerShot)) bad('spreadGrowthPerShot must be > 0');
  if (!isPos(def.spreadDecayPerSecond)) bad('spreadDecayPerSecond must be > 0');
  if (!isNonNeg(def.spreadRecoveryDelay)) bad('spreadRecoveryDelay must be >= 0');
  if (!isPos(def.maxSpread)) bad('maxSpread must be > 0');
  else if (isNum(def.baseSpreadHip) && def.maxSpread <= def.baseSpreadHip) {
    bad('maxSpread must be > baseSpreadHip (otherwise bloom is a no-op)');
  }
  if (!isNonNeg(def.moveSpreadAdd)) bad('moveSpreadAdd must be >= 0');
  if (!(isNum(def.crouchSpreadMultiplier) && def.crouchSpreadMultiplier > 0 &&
        def.crouchSpreadMultiplier < 1)) {
    bad('crouchSpreadMultiplier must be in (0, 1) so crouching helps');
  }
  if (!(isNum(def.airSpreadMultiplier) && def.airSpreadMultiplier > 1)) {
    bad('airSpreadMultiplier must be > 1 so airborne hurts');
  }
  // The ordering crouch < stand < moving < airborne must hold at both ends of
  // the bloom range, otherwise the handling curve reads wrong to the player.
  if (isNum(def.baseSpreadHip) && isNum(def.moveSpreadAdd) && isNum(def.airSpreadMultiplier)) {
    if (def.baseSpreadHip * def.airSpreadMultiplier <= def.baseSpreadHip + def.moveSpreadAdd) {
      bad('airborne spread must exceed moving spread at base bloom');
    }
    if (isNum(def.maxSpread) &&
        def.maxSpread * def.airSpreadMultiplier <= def.maxSpread + def.moveSpreadAdd) {
      bad('airborne spread must exceed moving spread at max bloom');
    }
  }

  // recoil -----------------------------------------------------------------
  if (!isPos(def.recoilPerShot)) bad('recoilPerShot must be > 0');
  if (!isNonNeg(def.recoilHorizontal)) bad('recoilHorizontal must be >= 0');
  if (!isPos(def.recoilRecovery)) bad('recoilRecovery must be > 0');
  if (!(isNum(def.recoilPatternSeed) && Number.isInteger(def.recoilPatternSeed))) {
    bad('recoilPatternSeed must be an integer');
  }
  if (!isPos(def.burstResetTime)) bad('burstResetTime must be > 0');

  // aiming -----------------------------------------------------------------
  if (!isPos(def.adsTime)) bad('adsTime must be > 0');
  if (!isPos(def.fovHip)) bad('fovHip must be > 0');
  if (!isPos(def.fovAds)) bad('fovAds must be > 0');
  else if (isNum(def.fovHip) && def.fovAds >= def.fovHip) {
    bad('fovAds must be < fovHip (ADS zooms in)');
  }

  // handling ---------------------------------------------------------------
  if (!isNonNeg(def.pumpTime)) bad('pumpTime must be >= 0');
  if (def.fireMode === 'pump') {
    if (!isPos(def.pumpTime)) bad('pump weapons need pumpTime > 0');
    else if (isPos(def.rpm) && def.pumpTime >= 60 / def.rpm) {
      bad('pumpTime must fit inside the shot interval (60 / rpm)');
    }
    if (def.pellets < 1) bad('pump weapons fire at least one pellet');
  }
  if (!isPos(def.switchTime)) bad('switchTime must be > 0');
  if (!isPosInt(def.tracerEveryNShots)) bad('tracerEveryNShots must be a positive integer');

  // sounds -----------------------------------------------------------------
  if (!def.sounds || typeof def.sounds !== 'object') bad('sounds must be an object');
  else {
    if (!isStr(def.sounds.fire)) bad('sounds.fire must be a non-empty string');
    if (!isStr(def.sounds.dry)) bad('sounds.dry must be a non-empty string');
    for (const [k, v] of Object.entries(def.sounds)) {
      if (!isStr(v)) bad(`sounds.${k} must be a non-empty string`);
    }
  }

  // viewmodel --------------------------------------------------------------
  if (!def.viewmodel || typeof def.viewmodel !== 'object') bad('viewmodel must be an object');
  else {
    if (!isPos(def.viewmodel.kickBack)) bad('viewmodel.kickBack must be > 0');
    if (!isPos(def.viewmodel.kickUp)) bad('viewmodel.kickUp must be > 0');
    if (!isPos(def.viewmodel.swayScale)) bad('viewmodel.swayScale must be > 0');
  }

  return { ok: problems.length === 0, problems };
}

/** Convenience: validate everything in `WEAPONS` at once. */
export function validateAllWeapons() {
  const problems = [];
  for (const key of Object.keys(WEAPONS)) {
    const def = WEAPONS[key];
    if (def.id !== key) problems.push(`WEAPONS.${key}.id is "${def.id}"`);
    for (const p of validateWeaponDef(def).problems) problems.push(`${key}: ${p}`);
  }
  return { ok: problems.length === 0, problems };
}
