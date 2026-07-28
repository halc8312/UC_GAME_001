const KEY = 'uc_game_001.settings.v1';

export const DEFAULT_SETTINGS = {
  sensitivity: 0.0022,
  invertY: false,
  fov: 78,
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.5,
  headBob: true,
  screenEffects: true,
  reducedFlash: false,
  colorblindCrosshair: false,
  showFps: false,
};

function prefersReducedMotion() {
  try {
    return (
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

/** Merge stored values over defaults, dropping unknown/ill-typed keys. */
export function sanitize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof DEFAULT_SETTINGS[k] === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof DEFAULT_SETTINGS[k] === 'number' && Number.isFinite(v)) out[k] = v;
  }
  out.sensitivity = Math.min(0.02, Math.max(0.0002, out.sensitivity));
  out.fov = Math.min(110, Math.max(60, out.fov));
  out.masterVolume = Math.min(1, Math.max(0, out.masterVolume));
  out.sfxVolume = Math.min(1, Math.max(0, out.sfxVolume));
  out.musicVolume = Math.min(1, Math.max(0, out.musicVolume));
  return out;
}

export function loadSettings() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    raw = null;
  }
  const s = sanitize(raw);
  // Respect the OS accessibility preference on a first run only, so an explicit
  // user choice in the settings menu is never overridden.
  if (!raw && prefersReducedMotion()) {
    s.reducedFlash = true;
    s.headBob = false;
  }
  return s;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(settings)));
    return true;
  } catch {
    return false;
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
