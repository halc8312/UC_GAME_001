import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../../core/mathx.js';
import { WEAPON_STATE } from '../weapons/weapons.js';

const _worldPos = new THREE.Vector3();
const _worldDir = new THREE.Vector3();

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

    this.basePos = new THREE.Vector3(0.19, -0.19, -0.36);
    this.adsPos = new THREE.Vector3(0, -0.098, -0.26);
  }

  _mat(name) {
    return this.materials.get(name);
  }

  _buildRifle(materials) {
    const g = new THREE.Group();
    const body = materials.get('weapon_body');
    const dark = materials.get('weapon_dark');
    const parts = [];

    const add = (geo, mat, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      m.castShadow = false;
      m.receiveShadow = false;
      g.add(m);
      parts.push(geo);
      return m;
    };

    add(new THREE.BoxGeometry(0.062, 0.075, 0.30), body, 0, 0, -0.02);          // receiver
    add(new THREE.BoxGeometry(0.036, 0.038, 0.30), dark, 0, 0.004, -0.30);      // handguard
    add(new THREE.CylinderGeometry(0.0105, 0.0105, 0.20, 8), dark, 0, 0.006, -0.50, Math.PI / 2); // barrel
    const mag = add(new THREE.BoxGeometry(0.040, 0.135, 0.072), dark, 0, -0.098, -0.04);
    add(new THREE.BoxGeometry(0.038, 0.10, 0.062), dark, 0, -0.075, 0.075, -0.32);  // grip
    add(new THREE.BoxGeometry(0.045, 0.072, 0.155), body, 0, 0.004, 0.19);      // stock
    add(new THREE.BoxGeometry(0.018, 0.030, 0.020), dark, 0, 0.055, -0.13);     // rear sight
    add(new THREE.BoxGeometry(0.012, 0.032, 0.014), dark, 0, 0.056, -0.44);     // front post
    add(new THREE.BoxGeometry(0.052, 0.012, 0.10), dark, 0, 0.046, -0.06);      // rail

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.006, -0.60);
    g.add(muzzle);

    g.position.set(0.19, -0.19, -0.36);
    return { group: g, muzzle, mag, geometries: parts, kickBack: 0.045, kickUp: 0.02 };
  }

  _buildShotgun(materials) {
    const g = new THREE.Group();
    const body = materials.get('weapon_body');
    const dark = materials.get('weapon_dark');
    const parts = [];
    const add = (geo, mat, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      g.add(m);
      parts.push(geo);
      return m;
    };

    add(new THREE.BoxGeometry(0.070, 0.085, 0.26), body, 0, 0, 0.0);
    add(new THREE.CylinderGeometry(0.017, 0.017, 0.46, 10), dark, 0, 0.018, -0.36, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.40, 8), dark, 0, -0.020, -0.33, Math.PI / 2);
    const pump = add(new THREE.BoxGeometry(0.052, 0.052, 0.11), body, 0, -0.020, -0.30);
    add(new THREE.BoxGeometry(0.042, 0.105, 0.065), dark, 0, -0.078, 0.085, -0.30);
    add(new THREE.BoxGeometry(0.050, 0.080, 0.175), body, 0, -0.006, 0.20);
    add(new THREE.BoxGeometry(0.012, 0.026, 0.014), dark, 0, 0.052, -0.52);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.018, -0.60);
    g.add(muzzle);

    g.position.set(0.19, -0.19, -0.36);
    return { group: g, muzzle, pump, geometries: parts, kickBack: 0.11, kickUp: 0.055 };
  }

  setWeapon(id) {
    const next = id === 'shotgun' ? this.shotgun : this.rifle;
    if (next === this.current) return;
    this.rifle.group.visible = next === this.rifle;
    this.shotgun.group.visible = next === this.shotgun;
    this.current = next;
  }

  /** Apply a recoil impulse (called on every shot). */
  punch(scale = 1) {
    this.kickVel -= this.current.kickBack * 34 * scale;
    this.kickUpVel += this.current.kickUp * 34 * scale;
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
    this.kick += this.kickVel * dt;
    this.kickUpVel += (-this.kickUp * rk - this.kickUpVel * rd) * dt;
    this.kickUp += this.kickUpVel * dt;

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
    const px = lerp(this.basePos.x, this.adsPos.x, a) + this.swayX + bobX;
    const py = lerp(this.basePos.y, this.adsPos.y, a) + this.swayY + bobY + breathe
      - this.lowerBlend * 0.22 + this.kickUp * 0.35;
    const pz = lerp(this.basePos.z, this.adsPos.z, a) - this.kick;

    cur.group.position.set(px, py, pz);
    cur.group.rotation.set(
      this.kickUp * 1.4 - this.lowerBlend * 0.55 + this.swayY * 1.2,
      -this.swayX * 2.2 * (1 - a),
      this.swayX * 3.4 * (1 - a) - this.lowerBlend * 0.25,
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
        cur.pump.position.z = -0.30 + Math.sin(p * Math.PI * 2) * 0.05;
      }
      cur.group.rotation.x += Math.sin(p * Math.PI) * 0.28;
    } else if (cur === this.rifle && cur.mag) {
      cur.mag.position.y = -0.098;
      cur.mag.rotation.z = 0;
    }

    if (s.weaponState === WEAPON_STATE.PUMPING && cur === this.shotgun && cur.pump) {
      const p = s.actionProgress;
      cur.pump.position.z = -0.30 + Math.sin(p * Math.PI) * 0.085;
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
