import * as THREE from 'three';
import { clamp, damp, lerp } from '../../core/mathx.js';
import { WEAPON_STATE } from '../weapons/weapons.js';

const _worldPos = new THREE.Vector3();
const _worldDir = new THREE.Vector3();

/**
 * Viewmodel scale, and the distances the weapon is held at.
 *
 * These are not free parameters. The view camera has a 58° FOV and a 1 cm near
 * plane, so anything within ~15 cm of the origin covers most of the screen. The
 * first cut held the weapon at z = -0.36 with the model's origin at the
 * receiver, which put the rear of the stock 9 cm from the camera at the hip and
 * *behind* it while aiming — the stock ballooned into an unlit slab across the
 * lower half of the frame, and the rest of the gun hung off the bottom-right
 * corner. Holding it further out and scaling it down puts the whole weapon in
 * frame at a believable size, with the nearest geometry ~29 cm away.
 */
const VM_SCALE = 0.78;
// Recoil is a spring, and springs driven at 11 shots/second integrate without
// bound unless something stops them. These are the stops.
const MAX_KICK_VEL = 2.4;
const MAX_KICK_BACK = 0.115;   // metres toward the eye; ~1/4 of the hold distance
const MAX_KICK_UP = 0.075;
const HOLD_Z = -0.50;   // hip: distance from the eye to the receiver
const ADS_Z = -0.58;    // aiming: sights on the optical axis, body kept small

/**
 * First-person weapon viewmodel, built from boxes at runtime.
 *
 * The viewmodel carries most of the game's tactile feel: sway lags the camera,
 * bob follows the stride, recoil kicks and springs back, and ADS pulls the sight
 * to screen centre. It renders on a separate camera layer with a narrow FOV so it
 * never clips into walls — the standard trick, and the reason there is a second
 * render pass.
 */
export class ViewModel {
  constructor(scene, materials) {
    this.materials = materials;
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    scene.add(this.root);

    this.rifle = this._buildRifle(materials);
    this.shotgun = this._buildShotgun(materials);
    this.root.add(this.rifle.group, this.shotgun.group);
    this.shotgun.group.visible = false;
    this.current = this.rifle;

    // Animation state
    this.swayX = 0;
    this.swayY = 0;
    this.swayVelX = 0;
    this.swayVelY = 0;
    this.bobPhase = 0;
    this.kick = 0;
    this.kickVel = 0;
    this.kickUp = 0;
    this.kickUpVel = 0;
    this.adsBlend = 0;
    this.lowerBlend = 0;
    this.reloadT = 0;
    this.time = 0;

    // Kept for callers that want the neutral pose; the live values are per-weapon
    // because the two guns have different sight heights.
    this.basePos = this.rifle.basePos;
    this.adsPos = this.rifle.adsPos;
  }

  _mat(name) {
    return this.materials.get(name);
  }

  /**
   * Part builder shared by both weapons.
   *
   * `hipYaw` is not decoration. Held square to the camera, a box-built gun is
   * seen end-on and reads as a flat slab — the receiver hides the barrel, the
   * magazine and the hands, and there is no silhouette left to recognise. Yawing
   * it a few degrees at the hip and unwinding that to zero at ADS gives the
   * three-quarter view that makes the shape legible, then squares it up when the
   * sights have to line up with the crosshair.
   */
  _weaponRig(parts) {
    const g = new THREE.Group();
    return {
      g,
      add: (geo, mat, x, y, z, rx = 0, ry = 0) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        if (rx) m.rotation.x = rx;
        if (ry) m.rotation.y = ry;
        m.castShadow = false;
        m.receiveShadow = false;
        g.add(m);
        parts.push(geo);
        return m;
      },
    };
  }

  /**
   * Iron sights, built big enough to actually read at 720p.
   *
   * The first pass used an 18 mm rear block and a 12 mm front post, which at the
   * aiming distance projected to a handful of pixels of the same colour as the
   * receiver behind them — aiming down the sights showed no sights. The rear is
   * now an aperture ring the eye can centre on and the front post carries a mint
   * tip in the HUD's own accent colour, so the aiming reference is the brightest
   * thing on the weapon.
   */
  _addIronSights(add, materials, sightY, rearZ, frontZ) {
    const dark = materials.get('weapon_dark');
    const dot = materials.get('emissive_green');
    // Rear aperture: a ring on a short pillar.
    add(new THREE.TorusGeometry(0.027, 0.0060, 5, 16), dark, 0, sightY, rearZ);
    add(new THREE.BoxGeometry(0.014, 0.034, 0.016), dark, 0, sightY - 0.038, rearZ);
    // Front post: base, blade, then the tip the eye actually tracks.
    add(new THREE.BoxGeometry(0.030, 0.024, 0.024), dark, 0, sightY - 0.040, frontZ);
    add(new THREE.BoxGeometry(0.011, 0.038, 0.013), dark, 0, sightY - 0.018, frontZ);
    add(new THREE.BoxGeometry(0.015, 0.013, 0.015), dot, 0, sightY, frontZ);
  }

  /** Gloved hands and forearms, so the weapon is carried rather than floating. */
  _addHands(add, materials, { grip, support }) {
    const glove = materials.get('weapon_glove');
    const dark = materials.get('weapon_dark');
    // Trigger hand, wrapped around the grip.
    add(new THREE.BoxGeometry(0.074, 0.090, 0.105), glove, 0.004, grip[0], grip[1]);
    add(new THREE.BoxGeometry(0.080, 0.028, 0.088), dark, 0.004, grip[0] - 0.030, grip[1] - 0.004);
    add(new THREE.BoxGeometry(0.066, 0.066, 0.22), glove, 0.030, grip[0] - 0.026, grip[1] + 0.16);
    // Support hand on the handguard, with the forearm angled back to the shoulder.
    add(new THREE.BoxGeometry(0.078, 0.080, 0.115), glove, 0.004, support[0], support[1]);
    add(new THREE.BoxGeometry(0.084, 0.026, 0.098), dark, 0.004, support[0] - 0.028, support[1]);
    add(new THREE.BoxGeometry(0.062, 0.062, 0.20), glove, 0.038, support[0] - 0.048, support[1] + 0.14, 0, 0.34);
  }

  _buildRifle(materials) {
    const parts = [];
    const { g, add } = this._weaponRig(parts);
    const body = materials.get('weapon_body');
    const dark = materials.get('weapon_dark');
    const accent = materials.get('enemy_accent');

    add(new THREE.BoxGeometry(0.068, 0.082, 0.34), body, 0, 0, -0.03);          // receiver
    add(new THREE.BoxGeometry(0.056, 0.014, 0.26), dark, 0, 0.048, -0.10);      // top rail
    add(new THREE.BoxGeometry(0.050, 0.050, 0.28), dark, 0, -0.006, -0.33);     // handguard
    for (let i = 0; i < 3; i++) {                                               // heat vents
      add(new THREE.BoxGeometry(0.052, 0.006, 0.020), accent, 0, 0.010, -0.26 - i * 0.062);
    }
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.22, 8), dark, 0, 0.002, -0.55, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.020, 0.020, 0.062, 8), body, 0, 0.002, -0.645, Math.PI / 2);
    const mag = add(new THREE.BoxGeometry(0.046, 0.150, 0.080), dark, 0, -0.112, -0.06);
    add(new THREE.BoxGeometry(0.044, 0.112, 0.070), dark, 0, -0.086, 0.085, -0.30);  // grip
    add(new THREE.BoxGeometry(0.052, 0.074, 0.165), dark, 0, -0.008, 0.205);    // stock
    add(new THREE.BoxGeometry(0.056, 0.016, 0.130), dark, 0, 0.046, 0.195);     // cheek rest
    add(new THREE.BoxGeometry(0.020, 0.014, 0.052), body, 0.040, 0.026, 0.03);  // charging handle

    const SIGHT_Y = 0.076;
    this._addIronSights(add, materials, SIGHT_Y, -0.14, -0.47);
    this._addHands(add, materials, { grip: [-0.076, 0.075], support: [-0.048, -0.31] });

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.002, -0.69);
    g.add(muzzle);

    // ADS height is derived from the sight line, not eyeballed: the aperture and
    // the front tip have to sit on the optical axis or the weapon is visibly
    // aiming somewhere the bullets do not go.
    const basePos = new THREE.Vector3(0.205, -0.150, HOLD_Z);
    const adsPos = new THREE.Vector3(0, -SIGHT_Y * VM_SCALE, ADS_Z);
    g.scale.setScalar(VM_SCALE);
    g.position.copy(basePos);
    return {
      group: g, muzzle, mag, geometries: parts,
      kickBack: 0.045, kickUp: 0.02, basePos, adsPos, hipYaw: -0.20, hipRoll: 0.05,
    };
  }

  _buildShotgun(materials) {
    const parts = [];
    const { g, add } = this._weaponRig(parts);
    const body = materials.get('weapon_body');
    const dark = materials.get('weapon_dark');
    const accent = materials.get('enemy_accent');

    // A quarter shorter than the carbine, with a bore three times as wide and an
    // exposed shell tube. At the first attempt the two weapons shared a
    // silhouette and differed only in grey value, so the equipped weapon was
    // unreadable at a glance.
    add(new THREE.BoxGeometry(0.086, 0.100, 0.26), body, 0, 0, -0.01);          // receiver
    add(new THREE.CylinderGeometry(0.036, 0.036, 0.34, 12), dark, 0, 0.030, -0.30, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.044, 0.044, 0.046, 12), body, 0, 0.030, -0.46, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.026, 0.026, 0.32, 10), dark, 0, -0.026, -0.28, Math.PI / 2);
    add(new THREE.BoxGeometry(0.012, 0.038, 0.24), body, 0, 0.004, -0.30);      // barrel bridge
    const pump = add(new THREE.BoxGeometry(0.082, 0.078, 0.150), body, 0, -0.026, -0.26);
    for (let i = 0; i < 4; i++) {                                               // pump ribs
      add(new THREE.BoxGeometry(0.086, 0.008, 0.016), accent, 0, -0.062, -0.21 - i * 0.032);
    }
    add(new THREE.BoxGeometry(0.048, 0.118, 0.074), dark, 0, -0.090, 0.095, -0.28);  // grip
    add(new THREE.BoxGeometry(0.056, 0.080, 0.185), dark, 0, -0.014, 0.215);    // stock
    add(new THREE.BoxGeometry(0.060, 0.016, 0.140), dark, 0, 0.044, 0.205);     // comb
    add(new THREE.BoxGeometry(0.030, 0.030, 0.014), dark, 0.040, -0.030, 0.05); // shell port

    const SIGHT_Y = 0.076;
    this._addIronSights(add, materials, SIGHT_Y, -0.12, -0.40);
    this._addHands(add, materials, { grip: [-0.086, 0.085], support: [-0.070, -0.26] });

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.030, -0.50);
    g.add(muzzle);

    const basePos = new THREE.Vector3(0.205, -0.150, HOLD_Z);
    const adsPos = new THREE.Vector3(0, -SIGHT_Y * VM_SCALE, ADS_Z);
    g.scale.setScalar(VM_SCALE);
    g.position.copy(basePos);
    return {
      group: g, muzzle, pump, geometries: parts,
      kickBack: 0.11, kickUp: 0.055, basePos, adsPos, hipYaw: -0.20, hipRoll: 0.05,
    };
  }

  setWeapon(id) {
    const next = id === 'shotgun' ? this.shotgun : this.rifle;
    if (next === this.current) return;
    this.rifle.group.visible = next === this.rifle;
    this.shotgun.group.visible = next === this.shotgun;
    this.current = next;
  }

  /**
   * Apply a recoil impulse (called on every shot).
   *
   * The impulse is bounded. Unclamped, a held trigger stacks eleven impulses a
   * second onto an underdamped spring; the recoil offset ran away past the
   * camera origin and the weapon vanished from the frame for the whole burst —
   * the one moment the player most needs to see it.
   */
  punch(scale = 1) {
    this.kickVel = clamp(this.kickVel - this.current.kickBack * 34 * scale, -MAX_KICK_VEL, MAX_KICK_VEL);
    this.kickUpVel = clamp(this.kickUpVel + this.current.kickUp * 34 * scale, -MAX_KICK_VEL, MAX_KICK_VEL);
  }

  /**
   * @param {object} s {lookDX, lookDY, speed, grounded, adsFactor, weaponState,
   *                    actionProgress, bobPhase, bobAmount, headBob}
   */
  update(s, dt) {
    this.time += dt;
    const cur = this.current;

    // ---- sway: the weapon lags the camera, then springs back ----
    const swayTarget = clamp(-s.lookDX * 2.2, -0.055, 0.055);
    const swayTargetY = clamp(s.lookDY * 1.8, -0.045, 0.045);
    const k = 150, d = 17;
    this.swayVelX += (swayTarget - this.swayX) * k * dt - this.swayVelX * d * dt;
    this.swayVelY += (swayTargetY - this.swayY) * k * dt - this.swayVelY * d * dt;
    this.swayX += this.swayVelX * dt;
    this.swayY += this.swayVelY * dt;

    // ---- recoil spring ----
    const rk = 260, rd = 21;
    this.kickVel += (-this.kick * rk - this.kickVel * rd) * dt;
    this.kick = clamp(this.kick + this.kickVel * dt, -MAX_KICK_BACK, MAX_KICK_BACK * 0.3);
    this.kickUpVel += (-this.kickUp * rk - this.kickUpVel * rd) * dt;
    this.kickUp = clamp(this.kickUp + this.kickUpVel * dt, -MAX_KICK_UP * 0.3, MAX_KICK_UP);

    // ---- ads / lower ----
    this.adsBlend = s.adsFactor;
    const lowering =
      s.weaponState === WEAPON_STATE.SWITCHING ? 1 :
        s.weaponState === WEAPON_STATE.RELOADING ? 0.55 : 0;
    this.lowerBlend = damp(this.lowerBlend, lowering, 14, dt);

    // ---- bob ----
    const bobAmt = (s.headBob === false ? 0.35 : 1) * (s.bobAmount ?? 0) * (1 - 0.85 * this.adsBlend);
    this.bobPhase = s.bobPhase ?? this.bobPhase;
    const bobX = Math.sin(this.bobPhase) * 0.017 * bobAmt;
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * 0.014 * bobAmt;
    const breathe = Math.sin(this.time * 1.35) * 0.0022 * (1 - this.adsBlend);

    // ---- compose ----
    const a = this.adsBlend;
    // Sway and bob are damped hard while aiming: at ADS the sight is on the
    // optical axis, and letting it drift there makes the gun look broken.
    const steady = 1 - 0.82 * a;
    const px = lerp(cur.basePos.x, cur.adsPos.x, a) + (this.swayX + bobX) * steady;
    const py = lerp(cur.basePos.y, cur.adsPos.y, a) + (this.swayY + bobY) * steady + breathe
      - this.lowerBlend * 0.22 + this.kickUp * 0.35;
    const pz = lerp(cur.basePos.z, cur.adsPos.z, a) - this.kick;

    cur.group.position.set(px, py, pz);
    // The hip three-quarter angle unwinds to square as the sights come up.
    const hip = 1 - a;
    cur.group.rotation.set(
      this.kickUp * 1.4 - this.lowerBlend * 0.55 + this.swayY * 1.2 * steady,
      cur.hipYaw * hip - this.swayX * 2.2 * hip,
      cur.hipRoll * hip + this.swayX * 3.4 * hip - this.lowerBlend * 0.25,
    );

    // ---- reload flourish ----
    if (s.weaponState === WEAPON_STATE.RELOADING) {
      const p = s.actionProgress;
      if (cur === this.rifle && cur.mag) {
        // Magazine drops out, new one goes in.
        const drop = p < 0.4 ? p / 0.4 : p < 0.62 ? 1 : 1 - (p - 0.62) / 0.38;
        cur.mag.position.y = -0.098 - drop * 0.13;
        cur.mag.rotation.z = drop * 0.35;
      }
      if (cur === this.shotgun && cur.pump) {
        cur.pump.position.z = -0.26 + Math.sin(p * Math.PI * 2) * 0.055;
      }
      cur.group.rotation.x += Math.sin(p * Math.PI) * 0.28;
    } else if (cur === this.rifle && cur.mag) {
      cur.mag.position.y = -0.098;
      cur.mag.rotation.z = 0;
    }

    if (s.weaponState === WEAPON_STATE.PUMPING && cur === this.shotgun && cur.pump) {
      const p = s.actionProgress;
      cur.pump.position.z = -0.26 + Math.sin(p * Math.PI) * 0.09;
    }
  }

  /** World-space muzzle position and forward direction, for flashes and tracers. */
  muzzleWorld(outPos, outDir) {
    this.current.muzzle.getWorldPosition(_worldPos);
    this.current.muzzle.getWorldDirection(_worldDir);
    outPos.copy(_worldPos);
    outDir.copy(_worldDir).negate();
    return outPos;
  }

  dispose() {
    for (const w of [this.rifle, this.shotgun]) {
      for (const g of w.geometries) g.dispose();
    }
    this.root.removeFromParent();
  }
}
