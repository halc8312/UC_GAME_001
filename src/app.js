import * as THREE from 'three';
import { EventBus } from './core/events.js';
import { Input } from './core/input.js';
import { Loop } from './core/loop.js';
import { Metrics } from './core/metrics.js';
import { clamp01, damp, planarDist } from './core/mathx.js';
import { Rng, rng } from './core/rng.js';
import { loadSettings, saveSettings } from './core/storage.js';

import { RenderStack } from './engine/renderer.js';
import { MaterialLibrary } from './engine/materials.js';
import { TextureLibrary } from './engine/textures.js';

import { CollisionWorld } from './game/level/collision.js';
import { buildColliders, NAV_EDGES, NAV_NODES, PLAYER_SPAWN } from './game/level/leveldata.js';
import { LevelBuilder } from './game/level/levelbuild.js';
import { NavGraph } from './game/ai/navgraph.js';
import { EnemyManager } from './game/ai/enemies.js';

import { Player } from './game/player/player.js';
import { ViewModel } from './game/player/viewmodel.js';
import { WeaponSystem } from './game/weapons/weapons.js';
import { ImpactSystem } from './game/weapons/impacts.js';
import { MissionDirector, PHASE } from './game/mission/director.js';

import { AudioEngine } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { SCREEN, Screens } from './ui/screens.js';

const BUILD = 'UC_GAME_001 · vertical slice';

/**
 * The game. Owns every system, the frame loop, and the screen state machine.
 *
 * Simulation runs at a fixed 60 Hz inside `_fixed`; everything visual happens in
 * `_render`, which interpolates and is free to run at any rate. The only bridge
 * between them is plain state — no gameplay decision is ever made in a render
 * callback, which is what makes the headless playthrough deterministic.
 */
export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.settings = loadSettings();
    this.metrics = new Metrics();
    this.rng = rng;
    // Presentation-only randomness (screen shake, muzzle flash jitter) lives on
    // its own stream. Sampling the simulation RNG from the render callback makes
    // the gameplay stream depend on the frame rate, so a seeded run stops
    // reproducing the moment the machine renders at a different speed.
    this.fxRng = new Rng(0xf00dbeef);
    this.time = 0;
    this.booted = false;
    this.paused = false;
    this.disposed = false;
    this.lookDelta = { x: 0, y: 0 };
    this._markerEntries = [];
    this._muzzlePos = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3();
    this._camOffset = { x: 0, y: 0, z: 0 };
    this._listenerFwd = { x: 0, y: 0, z: -1 };
    this._firedThisStep = false;
    this._shakeT = 0;
    this._shakeAmp = 0;
    this.consoleErrors = [];
  }

  // =========================================================================
  // Boot

  async boot(onProgress = () => {}) {
    const step = async (fraction, label, fn) => {
      onProgress(fraction, label);
      // Yield so the loading screen can actually paint between steps.
      await new Promise((r) => setTimeout(r, 0));
      return fn();
    };

    await step(0.05, 'Starting renderer…', () => {
      this.render3d = new RenderStack(this.canvas, { maxPixelRatio: 1.5 });
      this.scene = this.render3d.scene;
      this.camera = this.render3d.camera;
      this.camera.fov = this.settings.fov;
      this.camera.updateProjectionMatrix();
    });

    await step(0.14, 'Generating surfaces…', () => {
      this.textures = new TextureLibrary(THREE, { size: 256, anisotropy: 4 });
      this.materials = new MaterialLibrary(this.textures);
    });

    await step(0.40, 'Building Undercurrent Station…', () => {
      this.colliders = buildColliders();
      this.world = new CollisionWorld(8).addAll(this.colliders).build();
      this.level = new LevelBuilder(this.scene, this.materials, this.colliders).build();
    });

    await step(0.58, 'Wiring navigation…', () => {
      this.nav = new NavGraph();
      for (const n of NAV_NODES) {
        this.nav.addNode(n.id, n.x, n.y, n.z, { zone: n.zone, cover: !!n.cover });
      }
      for (const [a, b] of NAV_EDGES) this.nav.connect(a, b);
      this.nav.build();
    });

    await step(0.70, 'Arming systems…', () => {
      this.player = new Player({ world: this.world, bus: this.bus, rng: this.rng });
      this.weapons = new WeaponSystem({
        world: this.world,
        rng: this.rng,
        bus: this.bus,
        targets: () => this.enemies.live,
      });
      this.impacts = new ImpactSystem(this.scene, this.materials);
      this._buildViewLayer();
    });

    await step(0.84, 'Deploying contractors…', () => {
      this.enemies = new EnemyManager({
        world: this.world,
        nav: this.nav,
        rng: this.rng,
        bus: this.bus,
        scene: this.scene,
        materials: this.materials,
        player: this.player,
        resolveEnemyShot: (ox, oy, oz, dx, dy, dz, maxDist, shooter) =>
          this._resolveEnemyShot(ox, oy, oz, dx, dy, dz, maxDist, shooter),
      }, 8);

      this.director = new MissionDirector({
        bus: this.bus,
        player: this.player,
        enemies: this.enemies,
        weapons: this.weapons,
        impacts: this.impacts,
        world: this.world,
        rng: this.rng,
      });
    });

    await step(0.93, 'Preparing interface…', () => {
      this.hud = new Hud(this.settings);
      this.screens = new Screens(this.bus, this.settings);
      this.screens.setBuildLine(`${BUILD} · three r${THREE.REVISION}`);
      this.audio = new AudioEngine(this.settings);
      this.input = new Input(this.canvas, this.settings);
      this._wireInput();
      this._wireBus();
    });

    await step(1.0, 'Ready', () => {
      this.loop = new Loop(
        (dt, tick) => this._fixed(dt, tick),
        (alpha, frameDt) => this._render(alpha, frameDt),
      );
      this._installResize();
      this.player.reset(PLAYER_SPAWN);
      this.booted = true;
    });

    // Menu backdrop: park the camera looking down the dock at the facility.
    this._menuCameraSetup();
    this.screens.show(SCREEN.MENU);
    this.loop.start();
    this.bus.emit('game:booted', {});
    return this;
  }

  /**
   * The viewmodel renders in its own scene with a narrower FOV and a near plane of
   * 1 cm. That is what stops the weapon clipping through walls when the player
   * backs into geometry, and it is why there are two render passes per frame.
   */
  _buildViewLayer() {
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(58, 16 / 9, 0.01, 6);
    this.vmRig = new THREE.Group();
    this.viewScene.add(this.vmRig);

    // The viewmodel is lit independently of the world so it stays readable in a
    // pitch-black corridor and does not blow out under a sodium lamp.
    const key = new THREE.DirectionalLight(0xd6e2f0, 3.0);
    key.position.set(-0.6, 1.0, 0.4);
    const fill = new THREE.DirectionalLight(0xffb15e, 1.4);
    fill.position.set(0.8, -0.3, 0.6);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.6);
    rim.position.set(0.2, 0.4, -1);
    this.viewScene.add(key, fill, rim, new THREE.AmbientLight(0x7d8fa5, 1.2));

    this.viewmodel = new ViewModel(this.viewScene, this.materials);
    this.vmRig.add(this.viewmodel.root);
  }

  _menuCameraSetup() {
    this.camera.position.set(3.4, 2.2, 48);
    this.camera.rotation.set(-0.06, Math.PI + 0.28, 0, 'YXZ');
    this._menuMode = true;
  }

  _installResize() {
    this._onResize = () => {
      const { w, h } = this.render3d.resize();
      this.viewCamera.aspect = w / Math.max(1, h);
      this.viewCamera.updateProjectionMatrix();
      this.viewportW = w;
      this.viewportH = h;
    };
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  // =========================================================================
  // Wiring

  _wireInput() {
    this.input.onPauseRequested = () => {
      if (!this.inMission) return;
      if (this.screens.current === SCREEN.SETTINGS || this.screens.current === SCREEN.CONTROLS) {
        this.screens.back();
        return;
      }
      if (this.paused) this.resume();
      else this.pause();
    };
    this.input.onDebugToggle = () => {
      this.settings.showFps = !this.settings.showFps;
      saveSettings(this.settings);
      this.screens.syncSettings();
    };
    this.input.onLockChange = (locked) => {
      this.canvas.classList.toggle('unlocked', !locked);
      if (!locked && this.inMission && !this.paused && !this.director.finished) {
        this.screens.show(SCREEN.FOCUS);
      } else if (locked && this.screens.current === SCREEN.FOCUS) {
        this.screens.hideAll();
      }
    };
    this.canvas.addEventListener('click', () => {
      if (this.inMission && !this.paused && !this.input.locked) {
        this.audio.resume();
        this.input.requestLock();
      }
    });
  }

  _wireBus() {
    const b = this.bus;
    const play = (name, opts) => this.audio.play(name, opts);

    // ---- UI intents ----
    b.on('ui:deploy', () => this.startMission(0));
    b.on('ui:replay', () => this.startMission(0));
    b.on('ui:resume', () => this.resume());
    b.on('ui:restart', () => this.startMission(this.director.checkpointIndex));
    b.on('ui:retry', () => this.startMission(this.director.checkpointIndex));
    b.on('ui:abort', () => this.abortToMenu());
    b.on('ui:refocus', () => {
      this.audio.resume();
      this.screens.hideAll();
      this.input.requestLock();
    });
    b.on('ui:click', () => play('ui_click'));
    b.on('ui:hover', () => play('ui_hover'));
    b.on('settings:changed', () => {
      this.audio.setSettings(this.settings);
      this.camera.fov = this.settings.fov;
      this.camera.updateProjectionMatrix();
    });

    // ---- weapons ----
    b.on('weapon:fire', (e) => {
      this._firedThisStep = true;
      play(e.sound, { position: null, volume: 0.9 });
      this.player.controller.addViewPunch(e.punchPitch * 26, e.punchYaw * 22);
      this.viewmodel.punch(1);
      this._shake(0.06, e.id === 'shotgun' ? 0.5 : 0.22);
    });
    b.on('weapon:dry', () => play('dry_fire'));
    b.on('weapon:switch', () => play('weapon_switch'));
    b.on('weapon:reload', (e) => {
      if (e.stage === 'start') play('rifle_reload_start');
      else if (e.stage === 'end') play(e.id === 'shotgun' ? 'shotgun_pump' : 'rifle_reload_end');
      else if (e.stage === 'shell') play('shotgun_shell');
    });
    b.on('weapon:impact', (e) => {
      this.impacts.spawnImpact(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.surface, this.rng, e.crit);
      play(`impact_${e.surface === 'flesh' ? 'flesh' : this._impactSound(e.surface)}`, {
        position: { x: e.x, y: e.y, z: e.z }, volume: 0.6,
      });
    });
    b.on('weapon:tracer', (e) => this.impacts.spawnTracer(e.x0, e.y0, e.z0, e.x1, e.y1, e.z1));
    b.on('weapon:hit', (e) => {
      this.hud.hitmarker(e.crit);
      play(e.crit ? 'hitmarker_crit' : 'hitmarker');
    });

    // ---- enemies ----
    b.on('enemy:fire', (e) => {
      play('enemy_fire', { position: { x: e.x, y: e.y, z: e.z }, volume: 0.85 });
      this.impacts.spawnMuzzleFlash(e.x, e.y, e.z, e.dx, e.dy, e.dz, 0.7, this.rng);
    });
    b.on('enemy:alert', (e) => play('enemy_alert', { position: e.pos, volume: 0.9 }));
    b.on('enemy:hurt', (e) => play('enemy_hurt', { position: e.pos, volume: 0.8 }));
    b.on('enemy:killed', (e) => {
      play('enemy_death', { position: e.pos, volume: 0.9 });
      this.hud.toast(e.kind === 'head' ? 'HEADSHOT' : 'CONTRACTOR DOWN', e.kind === 'head' ? 'warn' : '');
    });

    // ---- player ----
    b.on('player:footstep', (e) => {
      play(`footstep_${this._footstepSound(e.surface)}`, { volume: e.loud ? 0.55 : 0.35 });
    });
    b.on('player:jump', () => play('jump', { volume: 0.4 }));
    b.on('player:land', (e) => play('land', { volume: e.hard ? 0.8 : 0.4 }));
    b.on('player:damaged', (e) => {
      play('player_hurt', { volume: 0.85 });
      this.hud.hurt(clamp01(e.amount / 30));
      this._shake(0.18, clamp01(e.amount / 26) * 0.9);
    });
    b.on('player:died', (e) => {
      play('player_death');
      this.input.releaseLock();
      setTimeout(() => {
        if (!this.disposed) this.screens.showDeath(e.cause);
      }, 1400);
    });

    // ---- mission ----
    b.on('objective:completed', (e) => {
      play('objective_complete');
      this.hud.toast(`OBJECTIVE COMPLETE — ${e.label.toUpperCase()}`, 'objective');
    });
    b.on('objective:activated', (e) => {
      if (e.id !== 'obj_approach') this.hud.toast(`NEW OBJECTIVE — ${e.label.toUpperCase()}`, '');
    });
    b.on('mission:checkpoint', () => {
      play('checkpoint');
      this.hud.toast('CHECKPOINT', '');
    });
    b.on('mission:callout', (e) => this.hud.subtitle(e.html, e.seconds));
    b.on('mission:alarm', (e) => {
      this.audio.setAlarm(e.on);
      this.audio.setAmbientState(e.on ? 'alert' : 'calm');
      if (e.on) this.hud.toast('ALARM — FACILITY ALERTED', 'bad');
    });
    b.on('mission:wave', (e) => this.hud.toast(`HOSTILE WAVE ${e.wave}`, 'bad'));
    b.on('mission:complete', (r) => {
      play('mission_success');
      this.audio.setAlarm(false);
      this.input.releaseLock();
      setTimeout(() => {
        if (!this.disposed) this.screens.showResults(r);
      }, 1800);
    });
    b.on('mission:failed', () => play('mission_fail'));
    b.on('power:cut', () => {
      play('powerdown');
      this.hud.subtitle('Security grid <b>offline</b>. Move to the server room.', 5);
    });
    b.on('breaker:pulled', () => play('breaker_pull'));
    b.on('interact:start', () => play('interact_start'));
    b.on('interact:complete', (e) => {
      const t = e.target;
      if (t && t.sound) play(t.sound);
      // The lever swings and its status light dies, so a pulled breaker is
      // distinguishable from an unpulled one at a glance across the hall.
      if (t && t.kind === 'lever') this.level.setBreakerPulled(t.id);
    });
    b.on('pickup:taken', (e) => {
      play('checkpoint', { volume: 0.5 });
      const label = e.kind === 'ammo' ? 'AMMUNITION' : e.kind === 'armor' ? 'ARMOUR PLATE' : 'MEDKIT';
      this.hud.toast(`+ ${label}`, '');
    });
    b.on('pickup:weapon', () => play('weapon_switch'));
  }

  _impactSound(surface) {
    if (surface === 'metal' || surface === 'panel') return 'metal';
    if (surface === 'grate') return 'grate';
    if (surface === 'glass') return 'glass';
    if (surface === 'water') return 'water';
    return 'concrete';
  }

  _footstepSound(surface) {
    if (surface === 'grate') return 'grate';
    if (surface === 'metal' || surface === 'wood' || surface === 'panel') return 'metal';
    if (surface === 'water') return 'water';
    return 'concrete';
  }

  // =========================================================================
  // Mission control

  get inMission() {
    return this.director && this.director.phase !== PHASE.MENU;
  }

  startMission(checkpoint = 0) {
    this._menuMode = false;
    this.screens.hideAll();
    this.hud.show();
    this.hud.reset();
    this.impacts.clear();
    this.director.start(checkpoint);
    this.paused = false;
    this.loop.setPaused(false);
    this.metrics.reset();
    this.metrics.mark('mission_start', { checkpoint });
    this.audio.resume().then(() => {
      this.audio.setAmbientState(this.director.alarm ? 'alert' : 'calm');
      this.audio.setAlarm(this.director.alarm);
    });
    this.input.requestLock();
    this.bus.emit('game:mission_started', { checkpoint });
  }

  pause() {
    if (this.paused || !this.inMission) return;
    this.paused = true;
    this.loop.setPaused(true);
    this.input.releaseLock();
    this.screens.show(SCREEN.PAUSE);
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.loop.setPaused(false);
    this.screens.hideAll();
    this.audio.resume();
    this.input.requestLock();
  }

  abortToMenu() {
    this.paused = false;
    this.loop.setPaused(false);
    this.director.phase = PHASE.MENU;
    this.director.finished = true;
    this.enemies.clear();
    this.impacts.clear();
    this.hud.hide();
    this.audio.setAlarm(false);
    this.audio.setAmbientState('calm');
    this.render3d.setAlarmLighting(0);
    this.input.releaseLock();
    this._menuCameraSetup();
    this.screens.show(SCREEN.MENU);
  }

  // =========================================================================
  // Fixed-step simulation

  _fixed(dt, tick) {
    this.metrics.beginSim();
    this.time += dt;
    this._firedThisStep = false;

    if (!this.inMission || this.director.finished && this.director.phase === PHASE.MENU) {
      this.metrics.endSim();
      return;
    }

    const cmd = this.input.buildCommand();
    // Screens that block gameplay swallow input rather than pausing the world,
    // so the death and results screens keep rendering a live scene behind them.
    const blocked = this.screens.isBlocking;
    if (blocked) {
      cmd.moveX = cmd.moveZ = 0;
      cmd.lookX = cmd.lookY = 0;
      cmd.fire = cmd.firePressed = cmd.aim = false;
      cmd.jump = cmd.reload = cmd.interact = false;
      cmd.interactHeld = false;
      cmd.slot = -1;
      cmd.nextWeapon = 0;
    }

    this.lookDelta.x = cmd.lookX;
    this.lookDelta.y = cmd.lookY;

    const pc = this.player.controller;
    const forward = pc.forward();

    // Player movement, interaction, vitals.
    this.player.update(cmd, dt, {
      aiming: this.weapons.aiming,
      speedScale: this.weapons.adsFactor > 0.5 ? 0.62 : 1,
      interactables: this.director.activeInteractables(),
      firedThisStep: this._firedThisStep,
    });

    // Weapons (may emit fire events consumed above).
    this.weapons.update(cmd, dt, {
      eye: this.player.eye,
      forward,
      speed: pc.speed,
      crouched: pc.crouching,
      grounded: pc.grounded,
    });

    this.enemies.update(dt);
    this.director.update(dt);

    // Recoil is applied to the camera as an additive offset that recovers, rather
    // than being baked into yaw/pitch — so the player keeps their aim point.
    this.metrics.endSim();
  }

  /**
   * Resolve one enemy bullet against the player.
   * @returns {boolean} true when the player was hit
   */
  _resolveEnemyShot(ox, oy, oz, dx, dy, dz, maxDist, shooter) {
    const hit = this.player.testShot(ox, oy, oz, dx, dy, dz, maxDist);
    if (!hit) return false;
    const dmg = hit.kind === 'head' ? 14 : hit.kind === 'limb' ? 4.5 : 6.5;
    this.player.takeDamage(dmg, {
      fromX: ox, fromY: oy, fromZ: oz, source: 'gunfire', shooter: shooter.id,
    });
    this.bus.emit('weapon:impact', {
      x: hit.x, y: hit.y, z: hit.z, nx: -dx, ny: -dy, nz: -dz,
      surface: 'flesh', crit: false,
    });
    return true;
  }

  _shake(duration, amplitude) {
    if (!this.settings.screenEffects) return;
    this._shakeT = Math.max(this._shakeT, duration);
    this._shakeAmp = Math.max(this._shakeAmp, amplitude);
  }

  // =========================================================================
  // Render

  _render(alpha, frameDt) {
    if (this.disposed) return;
    this.metrics.beginRender();

    const t = this.time;
    this.materials.tick(frameDt);

    // Age the transient effects *before* this frame's update spawns new ones.
    //
    // With this after `_updateCamera`, a muzzle flash was spawned with 55 ms of
    // life and then immediately charged the whole frame's delta — so at any frame
    // rate below ~18 fps the flash was dead before it was ever drawn, and firing
    // produced no visible flash at all. Ageing first means anything spawned this
    // frame is guaranteed to render at least once.
    this.impacts.update(frameDt, this.camera);

    if (this._menuMode) {
      // Slow orbital drift keeps the menu backdrop alive without a whole camera rig.
      const k = performance.now() * 0.00006;
      this.camera.position.set(3.4 + Math.sin(k) * 1.6, 2.3 + Math.sin(k * 1.7) * 0.18, 48);
      this.camera.rotation.set(-0.05, Math.PI + 0.28 + Math.sin(k * 0.8) * 0.05, 0, 'YXZ');
      this.level.updateAlarm(t, false, this.settings.reducedFlash);
    } else if (this.inMission) {
      this._updateCamera(frameDt);
      this._updateHud(frameDt);
      this.level.updateAlarm(t, this.director.alarm, this.settings.reducedFlash);
      this._alarmBlend = damp(this._alarmBlend ?? 0, this.director.alarm ? 1 : 0, 1.6, frameDt);
      this.render3d.setAlarmLighting(this._alarmBlend);
      this.hud.setAlarm(
        this.director.alarm && this.settings.screenEffects !== false,
        this.settings.reducedFlash,
      );
    }

    this.audio.update(frameDt);
    this.hud.tick(frameDt);

    // ---- draw ----
    const r = this.render3d.renderer;
    r.info.reset();
    r.render(this.scene, this.camera);
    if (!this._menuMode && this.inMission) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.viewScene, this.viewCamera);
      r.autoClear = true;
    }

    this.metrics.endRender();
    this.metrics.sampleRenderer(r);
    // Raw, not the simulation's clamped delta — see Loop.frameDtRaw. Manual
    // stepping has no wall-clock frame at all, so fall back to what was passed.
    this.metrics.push((this.loop.frameDtRaw || frameDt) * 1000);
  }

  _updateCamera(dt) {
    const pc = this.player.controller;
    const eye = pc.eyePosition;
    const recoil = this.weapons.recoilOffset();

    pc.cameraOffset(this._camOffset, this.settings.headBob, this.weapons.adsFactor);

    // Screen shake decays fast so it punctuates rather than nauseates.
    let shakeX = 0, shakeY = 0;
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      const k = clamp01(this._shakeT / 0.2) * this._shakeAmp;
      shakeX = (this.fxRng.next() - 0.5) * 0.035 * k;
      shakeY = (this.fxRng.next() - 0.5) * 0.035 * k;
      if (this._shakeT <= 0) this._shakeAmp = 0;
    }

    this.camera.position.set(
      eye.x + this._camOffset.x,
      eye.y + this._camOffset.y,
      eye.z + this._camOffset.z,
    );
    this.camera.rotation.set(
      pc.pitch + recoil.pitch + pc.viewPunch.x + shakeY,
      pc.yaw + recoil.yaw + pc.viewPunch.y + shakeX,
      0,
      'YXZ',
    );

    // FOV: ADS zoom plus a subtle sprint widening.
    const def = this.weapons.def;
    const sprintBoost = pc.sprinting ? 3.5 : 0;
    const targetFov =
      (this.settings.fov / 78) *
      (def.fovHip + (def.fovAds - def.fovHip) * this.weapons.adsFactor) + sprintBoost;
    this._fov = damp(this._fov ?? targetFov, targetFov, 12, dt);
    this.render3d.setFov(this._fov);

    // Viewmodel rig follows the camera exactly, so its local space is camera space.
    this.vmRig.position.copy(this.camera.position);
    this.vmRig.quaternion.copy(this.camera.quaternion);
    this.viewCamera.position.copy(this.camera.position);
    this.viewCamera.quaternion.copy(this.camera.quaternion);

    this.viewmodel.setWeapon(this.weapons.def.id);
    this.viewmodel.update({
      lookDX: this.lookDelta.x,
      lookDY: this.lookDelta.y,
      speed: pc.speed,
      grounded: pc.grounded,
      adsFactor: this.weapons.adsFactor,
      weaponState: this.weapons.state,
      actionProgress: this.weapons.actionProgress,
      bobPhase: pc.bobPhase,
      bobAmount: pc.bobAmount,
      headBob: this.settings.headBob,
    }, dt);

    // Muzzle flash rides the actual muzzle of the viewmodel.
    if (this._firedThisStep || this._flashPending) {
      this._flashPending = false;
      this.viewmodel.muzzleWorld(this._muzzlePos, this._muzzleDir);
      this.impacts.spawnMuzzleFlash(
        this._muzzlePos.x, this._muzzlePos.y, this._muzzlePos.z,
        this._muzzleDir.x, this._muzzleDir.y, this._muzzleDir.z,
        this.weapons.def.id === 'shotgun' ? 1.5 : 1.0,
        this.fxRng,
      );
    }

    // Audio listener.
    this._listenerFwd.x = -Math.sin(pc.yaw);
    this._listenerFwd.y = 0;
    this._listenerFwd.z = -Math.cos(pc.yaw);
    this.audio.setListener(eye, this._listenerFwd, { x: 0, y: 1, z: 0 });
  }

  _updateHud(dt) {
    const p = this.player;
    const d = this.director;
    const w = this.weapons;

    this.hud.updateVitals(p.hp, p.armor);
    this.hud.updateWeapon(w);
    this.hud.updateCrosshair(
      w.slot.ballistics.spread + w.def.baseSpreadHip,
      w.adsFactor,
      this._fov ?? this.settings.fov,
      this.viewportH || window.innerHeight,
    );
    this.hud.updateObjectives(d.objectives.snapshot(), p.pos);
    this.hud.updateCompass(p.controller.yaw);
    this.hud.updateTimer(d.missionTime);
    this.hud.updateHold(d.holdObjective);
    this.hud.updateDamageIndicators(p.damageIndicators);
    this.hud.updatePrompt(p.interactTarget, p.interactProgress);

    // World markers: the active objective plus any pickup within 24 m.
    this._markerEntries.length = 0;
    const active = d.objectives.active;
    if (active && active.marker) {
      this._markerEntries.push({
        id: 'objective',
        x: active.marker.x, y: active.marker.y + 1.4, z: active.marker.z,
        label: active.label.toUpperCase(),
        distance: planarDist(p.pos, active.marker),
        kind: '',
      });
    }
    for (const item of d.pickups) {
      if (item.taken) continue;
      const dist = planarDist(p.pos, item);
      if (dist > 24) continue;
      // Drawing pickup labels through walls makes them read as threats and clutters
      // the centre of the screen; occluded ones are dimmed rather than removed so
      // the player still knows roughly where supplies are.
      const eye = p.eye;
      const occluded = !this.world.lineOfSight(
        eye.x, eye.y, eye.z, item.x, item.y + 0.7, item.z,
      );
      this._markerEntries.push({
        id: item.id,
        x: item.x, y: item.y + 0.7, z: item.z,
        label: item.kind.toUpperCase(),
        distance: dist,
        kind: 'pickup',
        occluded,
      });
    }
    this.hud.updateMarkers(
      this._markerEntries, this.camera,
      this.viewportW || window.innerWidth,
      this.viewportH || window.innerHeight,
    );

    if (this.settings.showFps) {
      const s = this.metrics;
      this.hud.updatePerf(
        `fps ${(1000 / Math.max(0.001, s.lastFrame)).toFixed(0)}\n` +
        `sim ${s.lastSim.toFixed(2)}ms\n` +
        `gpu ${s.lastRender.toFixed(2)}ms\n` +
        `draws ${s.drawCalls}\n` +
        `tris ${(s.triangles / 1000).toFixed(0)}k\n` +
        `ai ${this.enemies.aliveCount}`,
        true,
      );
    } else {
      this.hud.updatePerf('', false);
    }
  }

  // =========================================================================

  dispose() {
    this.disposed = true;
    this.loop?.stop();
    window.removeEventListener('resize', this._onResize);
    this.input?.dispose();
    this.enemies?.dispose();
    this.director?.dispose();
    this.impacts?.dispose();
    this.viewmodel?.dispose();
    this.level?.dispose();
    this.materials?.dispose();
    this.audio?.dispose();
    this.render3d?.dispose();
    this.bus.clear();
  }
}
