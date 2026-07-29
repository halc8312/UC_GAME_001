import { DEFAULT_SETTINGS, saveSettings } from '../core/storage.js';
import { MISSION_OBJECTIVES } from '../game/mission/objectives.js';

const $ = (id) => document.getElementById(id);

export const SCREEN = {
  NONE: 'none',
  LOADING: 'loading',
  MENU: 'menu',
  BRIEFING: 'briefing',
  PAUSE: 'pause',
  SETTINGS: 'settings',
  CONTROLS: 'controls',
  DEATH: 'death',
  RESULTS: 'results',
  FOCUS: 'focus',
};

const SETTINGS_SCHEMA = [
  { key: 'sensitivity', label: 'Mouse Sensitivity', type: 'range', min: 0.0004, max: 0.006, step: 0.0001, format: (v) => (v * 1000).toFixed(1) },
  { key: 'invertY', label: 'Invert Vertical', type: 'toggle' },
  { key: 'fov', label: 'Field of View', type: 'range', min: 65, max: 105, step: 1, format: (v) => `${v}°` },
  { key: 'masterVolume', label: 'Master Volume', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'sfxVolume', label: 'Effects Volume', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'musicVolume', label: 'Ambience Volume', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'headBob', label: 'Head Bob', type: 'toggle' },
  { key: 'screenEffects', label: 'Screen Effects', type: 'toggle' },
  { key: 'reducedFlash', label: 'Reduced Flashing', type: 'toggle' },
  { key: 'colorblindCrosshair', label: 'High-Contrast Crosshair', type: 'toggle' },
  { key: 'showFps', label: 'Performance Overlay', type: 'toggle' },
];

const CONTROLS = [
  ['W A S D', 'Move'],
  ['Mouse', 'Look'],
  ['Shift', 'Sprint'],
  ['Ctrl / C', 'Crouch'],
  ['Space', 'Jump'],
  ['Left Mouse', 'Fire'],
  ['Right Mouse', 'Aim down sights'],
  ['R', 'Reload'],
  ['1 / 2 / Wheel', 'Switch weapon'],
  ['E', 'Interact (hold where shown)'],
  ['Esc', 'Pause'],
  ['F3', 'Performance overlay'],
];

/**
 * Screen stack and menu wiring. Owns nothing about gameplay: it emits intents on
 * the bus and the app decides what they mean.
 */
export class Screens {
  constructor(bus, settings) {
    this.bus = bus;
    this.settings = settings;
    this.current = SCREEN.LOADING;
    this.previous = SCREEN.NONE;
    this.els = {};
    for (const name of Object.values(SCREEN)) {
      if (name === SCREEN.NONE) continue;
      this.els[name] = $(`screen-${name}`);
    }
    this._buildSettings();
    this._buildControls();
    this._buildBriefing();
    this._wire();
  }

  _wire() {
    const on = (id, fn) => {
      const el = $(id);
      if (el) {
        el.addEventListener('click', () => {
          this.bus.emit('ui:click', {});
          fn();
        });
        el.addEventListener('mouseenter', () => this.bus.emit('ui:hover', {}));
      }
    };

    on('btn-start', () => this.show(SCREEN.BRIEFING));
    on('btn-settings', () => this.show(SCREEN.SETTINGS));
    on('btn-controls', () => this.show(SCREEN.CONTROLS));
    on('btn-brief-back', () => this.show(SCREEN.MENU));
    on('btn-deploy', () => this.bus.emit('ui:deploy', {}));
    on('btn-resume', () => this.bus.emit('ui:resume', {}));
    on('btn-pause-settings', () => this.show(SCREEN.SETTINGS));
    on('btn-restart', () => this.bus.emit('ui:restart', {}));
    on('btn-abort', () => this.bus.emit('ui:abort', {}));
    on('btn-settings-back', () => this.back());
    on('btn-settings-reset', () => this.resetSettings());
    on('btn-controls-back', () => this.back());
    on('btn-retry', () => this.bus.emit('ui:retry', {}));
    on('btn-death-menu', () => this.bus.emit('ui:abort', {}));
    on('btn-results-menu', () => this.bus.emit('ui:abort', {}));
    on('btn-replay', () => this.bus.emit('ui:replay', {}));

    this.els[SCREEN.FOCUS]?.addEventListener('click', () => this.bus.emit('ui:refocus', {}));
  }

  _buildSettings() {
    const grid = $('settings-grid');
    grid.innerHTML = SETTINGS_SCHEMA.map((s) => {
      if (s.type === 'toggle') {
        return `<div class="setting" data-key="${s.key}">
          <label for="set-${s.key}">${s.label}</label>
          <input class="toggle" type="checkbox" id="set-${s.key}" />
          <span class="value"></span>
        </div>`;
      }
      return `<div class="setting" data-key="${s.key}">
        <label for="set-${s.key}">${s.label}</label>
        <input type="range" id="set-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
        <span class="value"></span>
      </div>`;
    }).join('');

    for (const s of SETTINGS_SCHEMA) {
      const input = $(`set-${s.key}`);
      const value = input.parentElement.querySelector('.value');
      const sync = () => {
        if (s.type === 'toggle') {
          input.checked = !!this.settings[s.key];
          value.textContent = input.checked ? 'ON' : 'OFF';
        } else {
          input.value = String(this.settings[s.key]);
          value.textContent = s.format ? s.format(this.settings[s.key]) : String(this.settings[s.key]);
        }
      };
      input.addEventListener('input', () => {
        this.settings[s.key] = s.type === 'toggle' ? input.checked : Number(input.value);
        sync();
        saveSettings(this.settings);
        this.bus.emit('settings:changed', { key: s.key, value: this.settings[s.key] });
      });
      s._sync = sync;
    }
    this.syncSettings();
  }

  syncSettings() {
    for (const s of SETTINGS_SCHEMA) s._sync?.();
  }

  resetSettings() {
    Object.assign(this.settings, DEFAULT_SETTINGS);
    saveSettings(this.settings);
    this.syncSettings();
    this.bus.emit('settings:changed', { key: '*', value: null });
  }

  _buildControls() {
    $('controls-grid').innerHTML = CONTROLS
      .map(([k, a]) => `<div class="ctrl-row"><span class="act">${a}</span><span class="keys">${k}</span></div>`)
      .join('');
  }

  _buildBriefing() {
    $('brief-objectives').innerHTML = MISSION_OBJECTIVES
      .map((o) => `<li>${o.label}<span>${o.hint}</span></li>`)
      .join('');
  }

  // -------------------------------------------------------------------------

  show(name) {
    if (name === this.current) return;
    if (name !== SCREEN.SETTINGS && name !== SCREEN.CONTROLS) this.previous = this.current;
    for (const [key, el] of Object.entries(this.els)) {
      if (!el) continue;
      el.classList.toggle('hidden', key !== name);
    }
    this.current = name;
    this.bus.emit('screen:changed', { screen: name });
  }

  hideAll() {
    for (const el of Object.values(this.els)) el?.classList.add('hidden');
    this.current = SCREEN.NONE;
    this.bus.emit('screen:changed', { screen: SCREEN.NONE });
  }

  back() {
    this.show(this.previous === SCREEN.NONE ? SCREEN.MENU : this.previous);
  }

  setLoading(fraction, text) {
    const fill = $('loading-fill');
    if (fill) fill.style.width = `${Math.round(fraction * 100)}%`;
    if (text) $('loading-text').textContent = text;
  }

  setBuildLine(text) {
    const el = $('build-line');
    if (el) el.textContent = text;
  }

  showResults(result) {
    $('results-grade').textContent = result.grade;
    const mm = Math.floor(result.timeSeconds / 60);
    const ss = Math.floor(result.timeSeconds % 60);
    const rows = [
      ['TIME', `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`],
      ['ACCURACY', `${result.accuracy}%`],
      ['KILLS', String(result.kills)],
      ['HEADSHOTS', String(result.headshots)],
      ['SHOTS FIRED', String(result.shotsFired)],
      ['DAMAGE TAKEN', String(result.damageTaken)],
      ['OBJECTIVES', `${result.objectivesCompleted}/${result.objectivesTotal}`],
      ['DEATHS', String(result.deaths)],
      ['SCORE', String(result.score)],
    ];
    $('results-grid').innerHTML = rows
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');
    this.show(SCREEN.RESULTS);
  }

  showDeath(cause) {
    const map = {
      gunfire: 'Contractors confirmed the kill at Undercurrent Station.',
      fall: 'Fell from the structure. Signal lost.',
      drowning: 'Went into the water. Signal lost.',
    };
    $('death-sub').textContent = map[cause] || map.gunfire;
    this.show(SCREEN.DEATH);
  }

  get isBlocking() {
    return this.current !== SCREEN.NONE && this.current !== SCREEN.FOCUS;
  }

  get isAnyVisible() {
    return this.current !== SCREEN.NONE;
  }
}
