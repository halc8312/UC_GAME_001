import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/mathx.js';
import { OBJECTIVE_STATE } from '../game/mission/objectives.js';

const $ = (id) => document.getElementById(id);
const CARDINALS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];

const _v = new THREE.Vector3();

/**
 * DOM-based HUD.
 *
 * DOM rather than canvas because the text stays crisp at any DPI with no font
 * atlas and no extra draw calls. The cost is layout thrash if you write to it
 * carelessly, so every field is diffed against its last value and only touched
 * when it actually changes.
 */
export class Hud {
  constructor(settings) {
    this.settings = settings;
    this.root = $('hud');
    this.el = {
      vignette: $('vignette'),
      hurtFlash: $('hurt-flash'),
      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      damageRing: $('damage-ring'),
      compassStrip: $('compass-strip'),
      objList: $('obj-list'),
      timerValue: $('timer-value'),
      holdTimer: $('hold-timer'),
      holdValue: $('hold-value'),
      holdBarFill: $('hold-bar-fill'),
      healthFill: $('health-fill'),
      healthNum: $('health-num'),
      healthBar: document.querySelector('.bar-health'),
      armorFill: $('armor-fill'),
      armorNum: $('armor-num'),
      ammoMag: $('ammo-mag'),
      ammoReserve: $('ammo-reserve'),
      weaponName: $('weapon-name'),
      weaponList: $('weapon-list'),
      reloadBar: $('reload-bar'),
      reloadFill: $('reload-fill'),
      prompt: $('interact-prompt'),
      promptText: $('prompt-text'),
      promptBar: $('prompt-bar'),
      promptFill: $('prompt-fill'),
      toasts: $('toasts'),
      subtitle: $('subtitle'),
      markerLayer: $('marker-layer'),
      perf: $('perf-overlay'),
    };

    this._last = {};
    this._arrows = [];
    this._markers = new Map();
    this._toasts = [];
    this._subtitleT = 0;
    this._hurtT = 0;
    this._compassCache = '';
    this._buildCompass();
    this._buildObjectiveRows(5);
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  _set(key, value, apply) {
    if (this._last[key] === value) return;
    this._last[key] = value;
    apply(value);
  }

  _buildCompass() {
    // Three repeats of the 360° strip so scrolling never runs off the end.
    const parts = [];
    for (let rep = -1; rep <= 1; rep++) {
      for (let deg = 0; deg < 360; deg += 45) {
        const label = CARDINALS.find((c) => c[0] === deg)?.[1] ?? '';
        parts.push(`<span class="${label.length === 1 ? 'card' : ''}">${label}</span>`);
      }
    }
    this.el.compassStrip.innerHTML = parts.join('');
    this._compassWidth = 60 * 8; // 8 ticks per revolution, 60px each
  }

  _buildObjectiveRows(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push('<li><span class="tick">□</span><span class="txt"></span><span class="obj-dist"></span></li>');
    }
    this.el.objList.innerHTML = rows.join('');
    this._objRows = [...this.el.objList.children].map((li) => ({
      li,
      tick: li.querySelector('.tick'),
      txt: li.querySelector('.txt'),
      dist: li.querySelector('.obj-dist'),
    }));
  }

  // -------------------------------------------------------------------------

  updateVitals(hp, armor, maxHp = 100, maxArmor = 100) {
    const hpPct = clamp01(hp / maxHp) * 100;
    this._set('hpPct', Math.round(hpPct), (v) => {
      this.el.healthFill.style.width = `${v}%`;
    });
    this._set('hpNum', Math.max(0, Math.ceil(hp)), (v) => {
      this.el.healthNum.textContent = String(v);
    });
    this._set('hpLow', hp <= 35, (v) => {
      this.el.healthBar.classList.toggle('low', v);
    });
    this._set('arPct', Math.round(clamp01(armor / maxArmor) * 100), (v) => {
      this.el.armorFill.style.width = `${v}%`;
    });
    this._set('arNum', Math.max(0, Math.round(armor)), (v) => {
      this.el.armorNum.textContent = String(v);
    });

    // Low-health vignette is the primary "you are about to die" signal.
    this._set('hurtVig', hp <= 35, (v) => {
      this.el.vignette.classList.toggle('hurt', v);
    });
  }

  updateWeapon(weapons) {
    const slot = weapons.slot;
    this._set('mag', slot.mag, (v) => {
      this.el.ammoMag.textContent = String(v);
    });
    this._set('magLow', slot.mag <= Math.ceil(slot.def.magazineSize * 0.25), (v) => {
      this.el.ammoMag.classList.toggle('low', v);
    });
    this._set('reserve', slot.reserve, (v) => {
      this.el.ammoReserve.textContent = String(v);
    });
    this._set('wname', slot.def.displayName, (v) => {
      this.el.weaponName.textContent = v.toUpperCase();
    });
    this._set('wlist', weapons.slots.map((s) => s.id).join(',') + '|' + weapons.index, () => {
      this.el.weaponList.innerHTML = weapons.slots
        .map((s, i) =>
          `<li class="${i === weapons.index ? 'active' : ''}"><span class="slot">${i + 1}</span>${s.def.displayName.toUpperCase()}</li>`)
        .join('');
    });

    const busy = weapons.busy && weapons.state !== 'switching';
    this._set('reloading', busy, (v) => {
      this.el.reloadBar.classList.toggle('hidden', !v);
    });
    if (busy) {
      this.el.reloadFill.style.width = `${(weapons.actionProgress * 100).toFixed(0)}%`;
    }
  }

  /** Crosshair gap follows the live spread cone so accuracy is legible. */
  updateCrosshair(spreadDeg, adsFactor, fovDeg, viewportH) {
    // Convert the cone half-angle to pixels at the current FOV.
    const halfRad = spreadDeg * (Math.PI / 180);
    const focal = viewportH / (2 * Math.tan((fovDeg * Math.PI) / 360));
    const px = clamp(Math.tan(halfRad) * focal, 2, 90);
    const gap = Math.round(lerp(px + 3, 2, adsFactor));
    this._set('chGap', gap, (v) => {
      this.el.crosshair.style.setProperty('--gap', `${v}px`);
    });
    this._set('chAds', adsFactor > 0.85, (v) => {
      this.el.crosshair.classList.toggle('hidden-ch', v);
    });
    this._set('chColor', this.settings.colorblindCrosshair, (v) => {
      this.el.crosshair.style.setProperty('--col', v ? '#ffd400' : 'var(--mint)');
    });
  }

  hitmarker(crit) {
    const el = this.el.hitmarker;
    el.classList.remove('show');
    el.classList.toggle('crit', !!crit);
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void el.offsetWidth;
    el.classList.add('show');
  }

  hurt(intensity = 1) {
    if (!this.settings.screenEffects) return;
    this._hurtT = 0.32 * clamp01(intensity);
    this.el.hurtFlash.style.opacity = String(0.55 * clamp01(intensity));
  }

  updateObjectives(snapshot, playerPos) {
    for (let i = 0; i < this._objRows.length; i++) {
      const row = this._objRows[i];
      const o = snapshot[i];
      if (!o) {
        this._set(`obj${i}vis`, false, () => row.li.classList.add('hidden'));
        continue;
      }
      this._set(`obj${i}vis`, true, () => row.li.classList.remove('hidden'));
      const done = o.state === OBJECTIVE_STATE.DONE;
      const active = o.state === OBJECTIVE_STATE.ACTIVE;
      this._set(`obj${i}state`, o.state, () => {
        row.li.classList.toggle('done', done);
        row.li.classList.toggle('active', active);
        row.tick.textContent = done ? '■' : active ? '▸' : '□';
      });
      const text = o.label + (o.progressLabel ? ` (${o.progressLabel})` : '');
      this._set(`obj${i}txt`, text, (v) => {
        row.txt.textContent = v;
      });
      let dist = '';
      if (active && o.marker && playerPos) {
        const d = Math.hypot(o.marker.x - playerPos.x, o.marker.z - playerPos.z);
        dist = `${Math.round(d)}m`;
      }
      this._set(`obj${i}dist`, dist, (v) => {
        row.dist.textContent = v;
      });
    }
  }

  updateCompass(yaw, objectiveMarker, playerPos) {
    // yaw 0 faces -Z (north). Positive yaw turns left.
    let heading = (-yaw * 180) / Math.PI;
    heading = ((heading % 360) + 360) % 360;
    const offset = -(heading / 45) * 60 - this._compassWidth + 170;
    this.el.compassStrip.style.transform = `translateX(${offset.toFixed(1)}px)`;
  }

  updateTimer(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const text = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    this._set('timer', text, (v) => {
      this.el.timerValue.textContent = v;
    });
  }

  updateHold(objective) {
    const show = !!objective;
    this._set('holdShow', show, (v) => {
      this.el.holdTimer.classList.toggle('hidden', !v);
    });
    if (!show) return;
    const remaining = Math.max(0, Math.ceil(objective.duration - objective.elapsed));
    this._set('holdV', remaining, (v) => {
      this.el.holdValue.textContent = String(v);
    });
    this.el.holdBarFill.style.width = `${((1 - objective.fraction) * 100).toFixed(1)}%`;
  }

  updateDamageIndicators(indicators) {
    while (this._arrows.length < indicators.length) {
      const el = document.createElement('div');
      el.className = 'dmg-arrow';
      this.el.damageRing.appendChild(el);
      this._arrows.push(el);
    }
    for (let i = 0; i < this._arrows.length; i++) {
      const el = this._arrows[i];
      const ind = indicators[i];
      if (!ind) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.opacity = String(clamp01(ind.life / 1.2));
      el.style.transform = `rotate(${(ind.angle * 180) / Math.PI}deg)`;
    }
  }

  updatePrompt(target, progress) {
    const show = !!target;
    this._set('promptShow', show, (v) => {
      this.el.prompt.classList.toggle('hidden', !v);
    });
    if (!show) return;
    this._set('promptText', target.label, (v) => {
      this.el.promptText.textContent = v;
    });
    const holding = (target.holdTime || 0) > 0;
    this._set('promptBar', holding, (v) => {
      this.el.promptBar.classList.toggle('hidden', !v);
    });
    if (holding) this.el.promptFill.style.width = `${(progress * 100).toFixed(0)}%`;
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.el.toasts.appendChild(el);
    this._toasts.push({ el, life: 2.6 });
    while (this._toasts.length > 2) {
      const old = this._toasts.shift();
      old.el.remove();
    }
  }

  subtitle(html, seconds = 4.5) {
    this.el.subtitle.innerHTML = html;
    this.el.subtitle.classList.add('show');
    this._subtitleT = seconds;
  }

  /** Screen-space objective and pickup markers. */
  updateMarkers(entries, camera, width, height) {
    const seen = new Set();
    for (const entry of entries) {
      seen.add(entry.id);
      let el = this._markers.get(entry.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `world-marker ${entry.kind || ''}`;
        el.innerHTML = '<span class="diamond"></span><span class="label"></span><span class="dist"></span>';
        this.el.markerLayer.appendChild(el);
        this._markers.set(entry.id, el);
        el._label = el.querySelector('.label');
        el._dist = el.querySelector('.dist');
        el._lastLabel = '';
      }
      _v.set(entry.x, entry.y, entry.z).project(camera);
      const behind = _v.z > 1;
      const sx = (_v.x * 0.5 + 0.5) * width;
      const sy = (-_v.y * 0.5 + 0.5) * height;
      const dist = Math.round(entry.distance);

      let cx;
      let cy;
      let off = behind;
      if (behind || sx < 40 || sx > width - 40 || sy < 44 || sy > height - 120) {
        // Off-screen markers ride a ring around the centre at their true bearing.
        // Clamping them all to one screen edge (the obvious approach) piles every
        // marker on top of the others and makes the whole set unreadable.
        const dx = behind ? -(sx - width / 2) : sx - width / 2;
        const dy = behind ? height * 0.5 : sy - height / 2;
        const ang = Math.atan2(dy, dx);
        const radius = Math.min(width, height) * 0.36;
        cx = width / 2 + Math.cos(ang) * radius;
        cy = height / 2 + Math.sin(ang) * radius;
        off = true;
      } else {
        cx = sx;
        cy = sy;
      }
      cx = clamp(cx, 60, width - 60);
      cy = clamp(cy, 54, height - 118);

      // Marker priority. The objective diamond owns the player's attention budget;
      // ambient pickup chatter must never compete with it or with the crosshair.
      const fromCentre = Math.hypot(cx - width / 2, cy - height / 2);
      let alpha = 1;
      if (fromCentre < 90) alpha = 0.28;
      if (entry.kind === 'pickup') {
        alpha *= entry.distance > 14 ? 0.3 : entry.distance > 8 ? 0.55 : 0.85;
        if (entry.occluded) alpha *= 0.35;
      }
      el.style.opacity = alpha.toFixed(2);
      el.classList.toggle('far', entry.kind === 'pickup' && entry.distance > 12);

      el.classList.toggle('offscreen', off);
      el.style.transform = `translate(${cx.toFixed(0)}px, ${cy.toFixed(0)}px) translate(-50%, -50%)`;
      if (el._lastLabel !== entry.label) {
        el._label.textContent = entry.label;
        el._lastLabel = entry.label;
      }
      el._dist.textContent = `${dist}m`;
      el.style.display = '';
    }
    for (const [id, el] of this._markers) {
      if (!seen.has(id)) el.style.display = 'none';
    }
  }

  updatePerf(text, visible) {
    this._set('perfVis', visible, (v) => {
      this.el.perf.classList.toggle('hidden', !v);
    });
    if (visible) this.el.perf.textContent = text;
  }

  /** Per-frame decay of the transient effects. */
  tick(dt) {
    if (this._hurtT > 0) {
      this._hurtT -= dt;
      const k = clamp01(this._hurtT / 0.32);
      this.el.hurtFlash.style.opacity = String(0.55 * k * k);
      if (this._hurtT <= 0) this.el.hurtFlash.style.opacity = '0';
    }
    if (this._subtitleT > 0) {
      this._subtitleT -= dt;
      if (this._subtitleT <= 0) this.el.subtitle.classList.remove('show');
    }
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.life -= dt;
      if (t.life <= 0.42 && !t.fading) {
        t.fading = true;
        t.el.classList.add('fading');
      }
      if (t.life <= 0) {
        t.el.remove();
        this._toasts.splice(i, 1);
      }
    }
  }

  reset() {
    this._last = {};
    for (const t of this._toasts) t.el.remove();
    this._toasts.length = 0;
    this.el.subtitle.classList.remove('show');
    this.el.hurtFlash.style.opacity = '0';
    this.el.vignette.classList.remove('hurt');
    for (const el of this._markers.values()) el.style.display = 'none';
  }
}
