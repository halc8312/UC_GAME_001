import * as THREE from 'three';
import { clamp01, damp, lerp } from '../../core/mathx.js';

/**
 * Procedural contractor model: six meshes, no skeleton, no imported assets.
 *
 * Six parts is the sweet spot — enough for a readable walk cycle, aim pose and
 * death fall, few enough that eight simultaneous enemies cost under 50 draw calls.
 * The visor is emissive so an enemy is identifiable as a threat in a dim room at
 * range, which is the single most important readability property of the character.
 */
export class EnemyModel {
  constructor(materials) {
    this.group = new THREE.Group();
    this.group.visible = false;

    // Materials are cloned per enemy: corpse fade and hit-flash tinting are
    // per-instance, and sharing them would fade or flash every contractor at once.
    this._ownMaterials = [];
    const own = (name, tweak) => {
      const m = materials.get(name).clone();
      m.transparent = true;
      m.opacity = 1;
      if (tweak) tweak(m);
      this._ownMaterials.push(m);
      return m;
    };
    const body = own('enemy_body');
    const dark = own('weapon_dark');
    const visorMat = own('enemy_visor');
    const gunMat = own('weapon_body');
    const accentMat = own('enemy_accent');
    this._bodyMat = body;
    this._baseEmissive = body.emissive ? body.emissive.clone() : null;
    this._accentMat = accentMat;

    // Shared geometry across all instances of the model would be ideal, but each
    // enemy needs its own transforms; geometry is shared via the static cache below.
    const g = EnemyModel._geometry(materials);

    this.torso = new THREE.Mesh(g.torso, body);
    this.torso.position.y = 1.24;
    this.torso.castShadow = true;

    this.head = new THREE.Mesh(g.head, dark);
    this.head.position.y = 1.66;
    this.head.castShadow = true;

    this.visor = new THREE.Mesh(g.visor, visorMat);
    this.visor.position.set(0, 1.665, -0.135);

    this.legL = new THREE.Mesh(g.leg, dark);
    this.legL.position.set(-0.12, 0.46, 0);
    this.legL.castShadow = true;

    this.legR = new THREE.Mesh(g.leg, dark);
    this.legR.position.set(0.12, 0.46, 0);
    this.legR.castShadow = true;

    this.arms = new THREE.Mesh(g.arms, gunMat);
    this.arms.position.set(0.02, 1.3, -0.3);
    this.arms.castShadow = true;

    // Chest and shoulder markings in a hue used nowhere else in the palette.
    // Body value alone is not enough: a dark contractor against a dark catwalk is
    // invisible, and against a lamp-lit beige wall the silhouette washes out. A
    // narrow emissive band reads at range in both cases.
    this.chestBand = new THREE.Mesh(g.band, accentMat);
    this.chestBand.position.set(0, 1.36, -0.153);
    this.shoulderL = new THREE.Mesh(g.pip, accentMat);
    this.shoulderL.position.set(-0.21, 1.5, 0);
    this.shoulderR = new THREE.Mesh(g.pip, accentMat);
    this.shoulderR.position.set(0.21, 1.5, 0);

    this.group.add(
      this.torso, this.head, this.visor, this.legL, this.legR, this.arms,
      this.chestBand, this.shoulderL, this.shoulderR,
    );

    this.walkPhase = 0;
    this.aimBlend = 0;
    this.deathT = 0;
    this.flinch = 0;
    this._flinchAxis = 1;
  }

  /** Geometry is created once and shared by every enemy instance. */
  static _geometry() {
    if (EnemyModel._geoCache) return EnemyModel._geoCache;
    const torso = new THREE.BoxGeometry(0.52, 0.66, 0.3);
    // Chamfer the shoulders slightly so the silhouette is not a plain slab.
    const p = torso.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0.2) p.setX(i, p.getX(i) * 0.86);
    }
    p.needsUpdate = true;
    torso.computeVertexNormals();

    const cache = {
      torso,
      head: new THREE.BoxGeometry(0.25, 0.28, 0.26),
      visor: new THREE.BoxGeometry(0.19, 0.075, 0.02),
      leg: new THREE.BoxGeometry(0.17, 0.92, 0.19),
      arms: new THREE.BoxGeometry(0.42, 0.16, 0.62),
      band: new THREE.BoxGeometry(0.30, 0.055, 0.02),
      pip: new THREE.BoxGeometry(0.075, 0.05, 0.16),
    };
    EnemyModel._geoCache = cache;
    return cache;
  }

  static disposeShared() {
    if (!EnemyModel._geoCache) return;
    for (const g of Object.values(EnemyModel._geoCache)) g.dispose();
    EnemyModel._geoCache = null;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  /**
   * @param {object} s {x,y,z,yaw,speed,aiming,dead,deathT,flinch,crouch,firing}
   */
  update(s, dt) {
    const grp = this.group;
    grp.position.set(s.x, s.y, s.z);

    if (s.dead) {
      // Ragdoll-lite: fall onto the face or back depending on the death impulse,
      // settle, then let the manager fade the whole group out.
      this.deathT = Math.min(1, this.deathT + dt * 2.6);
      const t = this.deathT;
      const ease = 1 - (1 - t) * (1 - t);
      grp.rotation.y = s.yaw;
      grp.rotation.x = ease * (s.deathDir >= 0 ? 1.42 : -1.42);
      grp.position.y = s.y + Math.sin(t * Math.PI) * 0.1;
      const sag = 1 - 0.12 * ease;
      this.torso.position.y = 1.24 * sag;
      this.head.position.y = 1.66 * sag;
      this.visor.position.y = 1.665 * sag;
      this.chestBand.position.y = 1.36 * sag;
      this.shoulderL.position.y = 1.5 * sag;
      this.shoulderR.position.y = 1.5 * sag;
      // Markings go dark on death so a corpse stops reading as a live threat.
      this._accentMat.emissiveIntensity = 0.25;
      this.legL.rotation.x = -0.35 * ease;
      this.legR.rotation.x = -0.2 * ease;
      this.arms.rotation.x = 0.9 * ease;
      return;
    }

    grp.rotation.set(0, s.yaw, 0);

    // Walk cycle driven by distance travelled, not by time, so it never skates.
    const speed = s.speed || 0;
    this.walkPhase += speed * dt * 3.1;
    const stride = clamp01(speed / 3.6);
    const swing = Math.sin(this.walkPhase) * 0.52 * stride;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    const bounce = Math.abs(Math.cos(this.walkPhase)) * 0.035 * stride;

    const crouch = s.crouch || 0;
    const squash = 1 - 0.3 * crouch;
    this.torso.position.y = 1.24 * squash + bounce;
    this.head.position.y = 1.66 * squash + bounce;
    this.visor.position.y = 1.665 * squash + bounce;
    this.chestBand.position.y = 1.36 * squash + bounce;
    this.shoulderL.position.y = 1.5 * squash + bounce;
    this.shoulderR.position.y = 1.5 * squash + bounce;
    this.legL.position.y = 0.46 * squash;
    this.legR.position.y = 0.46 * squash;

    // Aim pose: arms come up and the torso squares to the target.
    this.aimBlend = damp(this.aimBlend, s.aiming ? 1 : 0, 9, dt);
    this.arms.position.set(
      lerp(0.16, 0.05, this.aimBlend),
      (lerp(1.18, 1.42, this.aimBlend)) * squash + bounce,
      lerp(-0.18, -0.42, this.aimBlend),
    );
    this.arms.rotation.x = lerp(0.35, s.pitch ?? 0, this.aimBlend);
    this.torso.rotation.x = lerp(0.06, -0.05, this.aimBlend) + swing * 0.05;

    // Hit flinch: a quick shove that decays.
    if (s.flinch > 0.001) {
      this.torso.rotation.z = s.flinch * 0.35 * this._flinchAxis;
      this.head.rotation.z = s.flinch * 0.5 * this._flinchAxis;
    } else {
      this.torso.rotation.z = 0;
      this.head.rotation.z = 0;
    }

    // Muzzle flash pose kick.
    if (s.firing > 0) {
      this.arms.position.z -= s.firing * 0.06;
    }
  }

  reset() {
    this._accentMat.emissiveIntensity = 2.8;
    this.deathT = 0;
    this.aimBlend = 0;
    this.walkPhase = 0;
    this.group.rotation.set(0, 0, 0);
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.arms.rotation.set(0, 0, 0);
    this.legL.rotation.set(0, 0, 0);
    this.legR.rotation.set(0, 0, 0);
    this._flinchAxis = 1;
  }

  setOpacity(o) {
    for (const m of this._ownMaterials) m.opacity = o;
    this.group.visible = o > 0.02;
  }

  /** White flash on the body for one hit, so damage registers even at range. */
  setHitFlash(k) {
    if (!this._bodyMat.emissive) return;
    if (k <= 0.001) {
      if (this._baseEmissive) this._bodyMat.emissive.copy(this._baseEmissive);
      this._bodyMat.emissiveIntensity = this._baseEmissiveIntensity ?? 1;
      return;
    }
    if (this._baseEmissiveIntensity === undefined) {
      this._baseEmissiveIntensity = this._bodyMat.emissiveIntensity;
    }
    this._bodyMat.emissive.setRGB(k, k * 0.55, k * 0.45);
    this._bodyMat.emissiveIntensity = 1;
  }

  dispose() {
    for (const m of this._ownMaterials) m.dispose();
    this._ownMaterials.length = 0;
  }
}
