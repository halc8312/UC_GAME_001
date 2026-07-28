import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/audio.js';
import {
  AMBIENT_LAYERS, LIMITER_THRESHOLD, SOUNDS, attenuationAt, describe as describeSound,
  describeAll, estimatePeak, limiterGainFor, makeImpulseResponse, makeNoiseBuffer,
  validateDescriptor,
} from '../../src/audio/synth.js';
import { Rng } from '../../src/core/rng.js';

/** Every sound the game actually asks for at runtime. */
const REQUIRED = [
  'rifle_fire', 'shotgun_fire', 'rifle_reload_start', 'rifle_reload_end', 'shotgun_shell',
  'shotgun_pump', 'dry_fire', 'weapon_switch', 'impact_concrete', 'impact_metal',
  'impact_grate', 'impact_glass', 'impact_flesh', 'impact_water', 'footstep_concrete',
  'footstep_metal', 'footstep_grate', 'footstep_water', 'jump', 'land', 'player_hurt',
  'player_death', 'enemy_alert', 'enemy_fire', 'enemy_hurt', 'enemy_death',
  'hitmarker', 'hitmarker_crit', 'objective_complete', 'checkpoint', 'alarm_siren',
  'ui_click', 'ui_hover', 'interact_start', 'interact_complete', 'breaker_pull',
  'powerdown', 'mission_success', 'mission_fail',
];

describe('sound bank', () => {
  it('exposes a non-trivial set of sounds', () => {
    expect(SOUNDS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(REQUIRED)('%s is defined', (name) => {
    expect(SOUNDS).toContain(name);
    expect(describeSound(name)).toBeTruthy();
  });

  it('returns null for an unknown sound', () => {
    expect(describeSound('not_a_real_sound')).toBeNull();
  });

  it.each(SOUNDS)('%s has a well-formed descriptor', (name) => {
    const d = describeSound(name);
    // validateDescriptor reports an array of problems; empty means valid.
    const v = validateDescriptor(d);
    const problems = Array.isArray(v) ? v : (v.problems ?? []);
    expect(problems, `${name}: ${JSON.stringify(problems)}`).toEqual([]);
    expect(d.duration).toBeGreaterThan(0);
    expect(d.layers.length).toBeGreaterThan(0);
    expect(d.gain).toBeGreaterThan(0);
    expect(d.gain).toBeLessThanOrEqual(2);
  });

  it.each(SOUNDS)('%s has envelope times that fit inside each layer', (name) => {
    for (const layer of describeSound(name).layers) {
      expect(layer.duration).toBeGreaterThan(0);
      expect(layer.attack).toBeGreaterThanOrEqual(0);
      expect(layer.attack + (layer.hold || 0)).toBeLessThanOrEqual(layer.duration + 1e-6);
      expect(layer.gain).toBeGreaterThan(0);
    }
  });

  it('describeAll covers every sound plus the ambient layers', () => {
    const all = describeAll();
    for (const name of SOUNDS) expect(all[name], `${name} missing`).toBeTruthy();
    for (const name of AMBIENT_LAYERS) expect(all[name], `${name} missing`).toBeTruthy();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(SOUNDS.length);
  });

  it('weapon fire is louder and higher priority than a footstep', () => {
    const fire = describeSound('rifle_fire');
    const step = describeSound('footstep_concrete');
    expect(fire.priority).toBeGreaterThan(step.priority);
    expect(fire.gain).toBeGreaterThan(step.gain);
  });

  it('the alarm siren loops and the weapons do not', () => {
    expect(describeSound('alarm_siren').loop).toBe(true);
    expect(describeSound('rifle_fire').loop).toBe(false);
  });

  it('defines ambient layers for the calm/alert bed', () => {
    expect(AMBIENT_LAYERS.length).toBeGreaterThanOrEqual(2);
    for (const name of AMBIENT_LAYERS) expect(describeSound(name)).toBeTruthy();
  });
});

describe('noise generation', () => {
  it('produces the requested length', () => {
    const buf = makeNoiseBuffer(48000, 0.5, new Rng(1), 'white');
    expect(buf.length).toBe(24000);
  });

  it('is deterministic for a fixed seed', () => {
    const a = makeNoiseBuffer(8000, 0.1, new Rng(9), 'white');
    const b = makeNoiseBuffer(8000, 0.1, new Rng(9), 'white');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('stays bounded in [-1, 1]', () => {
    for (const colour of ['white', 'pink', 'brown']) {
      const buf = makeNoiseBuffer(8000, 0.2, new Rng(3), colour);
      for (let i = 0; i < buf.length; i++) {
        expect(buf[i]).toBeGreaterThanOrEqual(-1.0001);
        expect(buf[i]).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('different colours produce different spectra', () => {
    const white = makeNoiseBuffer(8000, 0.2, new Rng(4), 'white');
    const brown = makeNoiseBuffer(8000, 0.2, new Rng(4), 'brown');
    // Brown noise has far less sample-to-sample variation than white.
    const diff = (b) => {
      let s = 0;
      for (let i = 1; i < b.length; i++) s += Math.abs(b[i] - b[i - 1]);
      return s / b.length;
    };
    expect(diff(brown)).toBeLessThan(diff(white));
  });

  // The engine feeds this into a stereo ConvolverNode; the shape matters as much
  // as the contents, because getting it wrong silently disables all reverb.
  it('impulse responses are stereo Float32Array pairs of the right length', () => {
    const ir = makeImpulseResponse(8000, 0.4, 3, new Rng(2));
    expect(ir.left).toBeInstanceOf(Float32Array);
    expect(ir.right).toBeInstanceOf(Float32Array);
    expect(ir.length).toBe(3200);
    expect(ir.left.length).toBe(ir.length);
    expect(ir.right.length).toBe(ir.length);
  });

  it('impulse responses decay toward silence', () => {
    const ir = makeImpulseResponse(8000, 0.4, 3, new Rng(2));
    const energy = (buf, from, to) => {
      let s = 0;
      for (let i = from; i < to; i++) s += buf[i] * buf[i];
      return s / (to - from);
    };
    expect(energy(ir.left, 0, 400)).toBeGreaterThan(energy(ir.left, ir.length - 400, ir.length));
    expect(energy(ir.right, 0, 400)).toBeGreaterThan(energy(ir.right, ir.length - 400, ir.length));
  });

  it('impulse response samples are finite', () => {
    const ir = makeImpulseResponse(8000, 0.3, 3, new Rng(5));
    for (let i = 0; i < ir.length; i += 17) {
      expect(Number.isFinite(ir.left[i])).toBe(true);
      expect(Number.isFinite(ir.right[i])).toBe(true);
    }
  });
});

describe('distance attenuation (rubric E2)', () => {
  it('is 1 at the reference distance', () => {
    expect(attenuationAt(1, 1, 10000, 1)).toBeCloseTo(1, 6);
    expect(attenuationAt(4, 4, 10000, 1)).toBeCloseTo(1, 6);
  });

  it('decreases monotonically with distance', () => {
    let prev = Infinity;
    for (let d = 1; d < 200; d += 1) {
      const v = attenuationAt(d, 1, 10000, 1);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('never goes negative and never exceeds 1', () => {
    for (let d = 0; d < 500; d += 0.5) {
      const v = attenuationAt(d, 3, 90, 1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });

  it('a higher rolloff attenuates faster', () => {
    expect(attenuationAt(20, 1, 10000, 2)).toBeLessThan(attenuationAt(20, 1, 10000, 1));
  });

  it('is finite at zero distance', () => {
    expect(Number.isFinite(attenuationAt(0, 1, 10000, 1))).toBe(true);
  });
});

describe('limiter (rubric E3)', () => {
  it('leaves quiet material untouched', () => {
    expect(limiterGainFor(LIMITER_THRESHOLD * 0.5)).toBeCloseTo(1, 6);
  });

  it('holds the summed peak at or below the threshold', () => {
    for (const peak of [0.5, 1, 2, 5, 12, 40]) {
      const g = limiterGainFor(peak);
      expect(peak * g).toBeLessThanOrEqual(LIMITER_THRESHOLD + 1e-6);
    }
  });

  it('applies more reduction as more voices stack', () => {
    expect(limiterGainFor(20)).toBeLessThan(limiterGainFor(4));
  });

  it('never returns a negative or non-finite gain', () => {
    for (const peak of [0, 0.001, 1, 1e6]) {
      const g = limiterGainFor(peak);
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeGreaterThanOrEqual(0);
    }
  });

  it('estimatePeak reports a positive peak for every sound', () => {
    for (const name of SOUNDS) {
      const p = estimatePeak(describeSound(name));
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe('AudioEngine without an AudioContext', () => {
  it('constructs without throwing in Node', () => {
    expect(() => new AudioEngine({ masterVolume: 1, sfxVolume: 1, musicVolume: 1 })).not.toThrow();
  });

  it('reports itself as unavailable', () => {
    const a = new AudioEngine({});
    expect(a.ready).toBe(false);
    expect(a.init()).toBe(false);
  });

  it('play() returns null but still records the event', () => {
    const a = new AudioEngine({});
    expect(a.play('rifle_fire')).toBeNull();
    const log = a.getEventLog();
    expect(log.length).toBe(1);
    expect(log[0].name).toBe('rifle_fire');
  });

  it('records positions in the event log', () => {
    const a = new AudioEngine({});
    a.play('impact_metal', { position: { x: 1.234, y: 2, z: -3 } });
    expect(a.getEventLog()[0].position).toEqual({ x: 1.23, y: 2, z: -3 });
  });

  it('the event log is bounded', () => {
    const a = new AudioEngine({});
    for (let i = 0; i < 5000; i++) a.play('ui_click');
    expect(a.getEventLog().length).toBeLessThanOrEqual(2000);
  });

  it('clearEventLog empties it', () => {
    const a = new AudioEngine({});
    a.play('ui_click');
    a.clearEventLog();
    expect(a.getEventLog().length).toBe(0);
  });

  it('every other method is a safe no-op', () => {
    const a = new AudioEngine({});
    expect(() => {
      a.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
      a.setSettings({ masterVolume: 0.5 });
      a.setAmbientState('alert');
      a.setAlarm(true);
      a.setAlarm(false);
      a.update(1 / 60);
      a.stopAll();
      a.stop(null);
      a.dispose();
    }).not.toThrow();
  });

  it('resume() resolves false rather than rejecting', async () => {
    const a = new AudioEngine({});
    await expect(a.resume()).resolves.toBe(false);
  });

  it('records the alarm state change even with no context', () => {
    const a = new AudioEngine({});
    a.setAlarm(true);
    expect(a.getEventLog().some((e) => e.name === 'alarm_siren')).toBe(true);
  });

  it('exposes the sound list statically', () => {
    expect(AudioEngine.sounds).toBe(SOUNDS);
  });
});
