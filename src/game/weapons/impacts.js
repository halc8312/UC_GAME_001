import * as THREE from 'three';
import { clamp01 } from '../../core/mathx.js';
import { Pool } from '../../core/pool.js';

const SURFACE_COLOR = {
  concrete: 0xb9b2a6,
  panel: 0xa8b0b8,
  metal: 0xffd9a0,
  grate: 0xffcf90,
  glass: 0xcfe8ff,
  water: 0x9fc8e0,
  wood: 0xc09462,
  rubber: 0x707070,
  flesh: 0xd0261c,
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);
const _color = new THREE.Color();
const _pos = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * All bullet feedback in three instanced draw calls: decals, sparks, tracers.
 *
 * Everything is pooled and recycled — a 3-minute firefight allocates nothing after
 * construction, which is what keeps the heap flat in the soak test.
 */
export class ImpactSystem {
  constructor(scene, materials, opts = {}) {
    this.scene = scene;
    this.materials = materials;
    this.time = 0;

    const decalCap = opts.decals ?? 110;
    const sparkCap = opts.sparks ?? 320;
    const tracerCap = opts.tracers ?? 28;

    // ---- decals ----
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    this.decalMesh = new THREE.InstancedMesh(decalGeo, materials.get('decal_bullet'), decalCap);
    this.decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decalMesh.frustumCulled = false;
    this.decalMesh.renderOrder = 5;
    this.decalMesh.count = decalCap;
    for (let i = 0; i < decalCap; i++) this.decalMesh.setMatrixAt(i, HIDDEN);
    scene.add(this.decalMesh);

    this.decals = new Pool(decalCap, (i) => ({
      i, life: 0, maxLife: 22, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, size: 0.14, rot: 0,
    }));

    // ---- sparks ----
    const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.sparkMesh = new THREE.InstancedMesh(sparkGeo, this.sparkMat, sparkCap);
    this.sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(sparkCap * 3), 3,
    );
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 6;
    for (let i = 0; i < sparkCap; i++) this.sparkMesh.setMatrixAt(i, HIDDEN);
    scene.add(this.sparkMesh);

    this.sparks = new Pool(sparkCap, (i) => ({
      i, life: 0, maxLife: 0.5, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      size: 0.03, r: 1, g: 1, b: 1, gravity: 14,
    }));

    // ---- tracers ----
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c0,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(tracerGeo, this.tracerMat, tracerCap);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = 6;
    for (let i = 0; i < tracerCap; i++) this.tracerMesh.setMatrixAt(i, HIDDEN);
    scene.add(this.tracerMesh);

    this.tracers = new Pool(tracerCap, (i) => ({
      i, life: 0, maxLife: 0.085,
      x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, width: 0.028,
    }));

    // ---- muzzle flash ----
    const flashGeo = new THREE.PlaneGeometry(0.5, 0.5);
    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.flash = new THREE.Mesh(flashGeo, this.flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 8;
    scene.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 9, 2.0);
    this.flashLight.visible = false;
    scene.add(this.flashLight);
    this.flashTime = 0;

    this._geometries = [decalGeo, sparkGeo, tracerGeo, flashGeo];
    this._dirty = { decals: true, sparks: true, tracers: true };
  }

  /** Bullet hit: a decal (hard surfaces only) plus a directional spark burst. */
  spawnImpact(x, y, z, nx, ny, nz, surface, rng, crit = false) {
    const colorHex = SURFACE_COLOR[surface] ?? SURFACE_COLOR.concrete;
    const isFlesh = surface === 'flesh';

    if (!isFlesh) {
      let d = this.decals.acquire();
      if (!d) {
        // Recycle the oldest rather than dropping feedback.
        this.decals.releaseAt(0);
        d = this.decals.acquire();
      }
      if (d) {
        d.life = 0;
        d.maxLife = 22;
        d.x = x + nx * 0.012;
        d.y = y + ny * 0.012;
        d.z = z + nz * 0.012;
        d.nx = nx; d.ny = ny; d.nz = nz;
        d.size = 0.1 + rng.next() * 0.07;
        d.rot = rng.next() * Math.PI * 2;
        this._dirty.decals = true;
      }
    }

    const count = isFlesh ? 7 : 9;
    _color.setHex(colorHex);
    for (let i = 0; i < count; i++) {
      const s = this.sparks.acquire();
      if (!s) break;
      const spreadV = isFlesh ? 2.2 : 3.4;
      s.life = 0;
      s.maxLife = isFlesh ? 0.3 + rng.next() * 0.2 : 0.28 + rng.next() * 0.42;
      s.x = x + nx * 0.03;
      s.y = y + ny * 0.03;
      s.z = z + nz * 0.03;
      s.vx = nx * (1.6 + rng.next() * 2.4) + rng.gauss(0, spreadV * 0.35);
      s.vy = ny * (1.6 + rng.next() * 2.4) + rng.gauss(0, spreadV * 0.35) + 0.9;
      s.vz = nz * (1.6 + rng.next() * 2.4) + rng.gauss(0, spreadV * 0.35);
      s.size = isFlesh ? 0.022 + rng.next() * 0.02 : 0.016 + rng.next() * 0.028;
      s.gravity = isFlesh ? 20 : 14;
      s.r = _color.r * (0.8 + rng.next() * 0.5);
      s.g = _color.g * (0.8 + rng.next() * 0.5);
      s.b = _color.b * (0.8 + rng.next() * 0.5);
    }
    if (crit) {
      for (let i = 0; i < 5; i++) {
        const s = this.sparks.acquire();
        if (!s) break;
        s.life = 0;
        s.maxLife = 0.42;
        s.x = x; s.y = y; s.z = z;
        s.vx = rng.gauss(0, 2.4);
        s.vy = 1.6 + rng.next() * 2.2;
        s.vz = rng.gauss(0, 2.4);
        s.size = 0.03;
        s.gravity = 16;
        s.r = 1.0; s.g = 0.28; s.b = 0.2;
      }
    }
    this._dirty.sparks = true;
  }

  spawnTracer(x0, y0, z0, x1, y1, z1) {
    let t = this.tracers.acquire();
    if (!t) {
      this.tracers.releaseAt(0);
      t = this.tracers.acquire();
    }
    if (!t) return;
    t.life = 0;
    t.x0 = x0; t.y0 = y0; t.z0 = z0;
    t.x1 = x1; t.y1 = y1; t.z1 = z1;
    this._dirty.tracers = true;
  }

  /** Muzzle flash at a world position, oriented along `dir`. */
  spawnMuzzleFlash(x, y, z, dirX, dirY, dirZ, scale = 1, rng) {
    this.flash.position.set(x + dirX * 0.14, y + dirY * 0.14, z + dirZ * 0.14);
    this.flash.scale.setScalar(scale * (0.85 + (rng ? rng.next() : 0.5) * 0.5));
    this.flash.rotation.z = (rng ? rng.next() : 0) * Math.PI * 2;
    this.flash.visible = true;
    this.flashMat.opacity = 1;
    this.flashLight.position.set(x + dirX * 0.4, y + dirY * 0.4, z + dirZ * 0.4);
    this.flashLight.intensity = 9 * scale;
    this.flashLight.visible = true;
    this.flashTime = 0.055;
  }

  update(dt, camera) {
    this.time += dt;

    // ---- muzzle flash decay ----
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const k = clamp01(this.flashTime / 0.055);
      this.flashMat.opacity = k;
      this.flashLight.intensity = 11 * k;
      if (camera) this.flash.quaternion.copy(camera.quaternion);
      if (this.flashTime <= 0) {
        this.flash.visible = false;
        this.flashLight.visible = false;
        this.flashLight.intensity = 0;
      }
    }

    // ---- decals ----
    const decals = this.decals.active;
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      d.life += dt;
      if (d.life >= d.maxLife) {
        this.decalMesh.setMatrixAt(d.i, HIDDEN);
        this.decals.releaseAt(i);
        this._dirty.decals = true;
        continue;
      }
      const fade = 1 - clamp01((d.life - (d.maxLife - 3)) / 3);
      const size = d.size * (0.35 + 0.65 * fade);
      _v.set(d.nx, d.ny, d.nz);
      _q.setFromUnitVectors(_fwd, _v.lengthSq() > 0 ? _v.normalize() : _up);
      _s.set(size, size, size);
      _pos.set(d.x, d.y, d.z);
      _m.compose(_pos, _q, _s);
      this.decalMesh.setMatrixAt(d.i, _m);
      this._dirty.decals = true;
    }

    // ---- sparks ----
    const sparks = this.sparks.active;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        this.sparkMesh.setMatrixAt(s.i, HIDDEN);
        this.sparks.releaseAt(i);
        continue;
      }
      s.vy -= s.gravity * dt;
      s.vx *= 1 - 2.4 * dt;
      s.vz *= 1 - 2.4 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const k = 1 - clamp01(s.life / s.maxLife);
      const size = s.size * (0.4 + 0.6 * k);
      _m.makeScale(size, size, size);
      _m.setPosition(s.x, s.y, s.z);
      this.sparkMesh.setMatrixAt(s.i, _m);
      this.sparkMesh.instanceColor.setXYZ(s.i, s.r * k, s.g * k, s.b * k);
    }
    this.sparkMesh.instanceColor.needsUpdate = true;
    this.sparkMesh.instanceMatrix.needsUpdate = true;

    // ---- tracers ----
    const tracers = this.tracers.active;
    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      t.life += dt;
      if (t.life >= t.maxLife) {
        this.tracerMesh.setMatrixAt(t.i, HIDDEN);
        this.tracers.releaseAt(i);
        continue;
      }
      const dx = t.x1 - t.x0, dy = t.y1 - t.y0, dz = t.z1 - t.z0;
      const len = Math.hypot(dx, dy, dz) || 0.001;
      _v.set(dx / len, dy / len, dz / len);
      _q.setFromUnitVectors(_fwd, _v);
      const k = 1 - clamp01(t.life / t.maxLife);
      _s.set(t.width, t.width, len);
      _pos.set((t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2, (t.z0 + t.z1) / 2);
      _m.compose(_pos, _q, _s);
      this.tracerMesh.setMatrixAt(t.i, _m);
      this.tracerMat.opacity = 0.28 + 0.55 * k;
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;

    if (this._dirty.decals) {
      this.decalMesh.instanceMatrix.needsUpdate = true;
      this._dirty.decals = false;
    }
  }

  clear() {
    for (const d of this.decals.active.slice()) {
      this.decalMesh.setMatrixAt(d.i, HIDDEN);
    }
    this.decals.releaseAll();
    for (const s of this.sparks.active.slice()) this.sparkMesh.setMatrixAt(s.i, HIDDEN);
    this.sparks.releaseAll();
    for (const t of this.tracers.active.slice()) this.tracerMesh.setMatrixAt(t.i, HIDDEN);
    this.tracers.releaseAll();
    this.decalMesh.instanceMatrix.needsUpdate = true;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    this.flash.visible = false;
    this.flashLight.visible = false;
  }

  get stats() {
    return {
      decals: this.decals.active.length,
      sparks: this.sparks.active.length,
      tracers: this.tracers.active.length,
      starved: this.decals.starved + this.sparks.starved + this.tracers.starved,
    };
  }

  dispose() {
    this.scene.remove(this.decalMesh, this.sparkMesh, this.tracerMesh, this.flash, this.flashLight);
    this.decalMesh.dispose();
    this.sparkMesh.dispose();
    this.tracerMesh.dispose();
    for (const g of this._geometries) g.dispose();
    this.sparkMat.dispose();
    this.tracerMat.dispose();
    this.flashMat.dispose();
  }
}
