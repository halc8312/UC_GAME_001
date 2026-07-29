import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src', import.meta.url).pathname;
const ROOT = new URL('../..', import.meta.url).pathname;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(SRC).map((f) => ({
  path: f,
  rel: relative(ROOT, f),
  text: readFileSync(f, 'utf8'),
}));

/** Strip comments so a rule about code is not tripped by prose describing it. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('source hygiene', () => {
  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  // GAME_SPEC §6: all gameplay randomness routes through the seeded PRNG, or a
  // seeded replay does not reproduce.
  it('never calls Math.random() in simulation code', () => {
    const offenders = files
      .filter((f) => /src\/(core|game)\//.test(f.rel))
      .filter((f) => /Math\s*\.\s*random\s*\(/.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('never calls Math.random() anywhere under src/', () => {
    const offenders = files
      .filter((f) => /Math\s*\.\s*random\s*\(/.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('makes no runtime network requests', () => {
    const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(/;
    const offenders = files
      .filter((f) => banned.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('loads no external asset URLs', () => {
    const banned = /(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]{2,}/i;
    const offenders = files
      .filter((f) => {
        const code = stripComments(f.text);
        return banned.test(code) && !/@license|three\/examples/.test(code);
      })
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('has no TextureLoader / AudioLoader / GLTFLoader usage', () => {
    const banned = /(TextureLoader|AudioLoader|GLTFLoader|FileLoader|ImageBitmapLoader)/;
    const offenders = files
      .filter((f) => banned.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('leaves no debugger statements or bare console.log in shipped code', () => {
    const offenders = files
      .filter((f) => /\bdebugger\b|console\s*\.\s*log\s*\(/.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('leaves no TODO or FIXME markers', () => {
    const offenders = files
      .filter((f) => /\b(TODO|FIXME|XXX|HACK)\b/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  // Rubric A9: anything that allocates a GPU resource must be able to free it.
  it('every class that creates GPU resources exposes dispose()', () => {
    const creators = files.filter((f) =>
      /new THREE\.(Mesh|BoxGeometry|PlaneGeometry|CylinderGeometry|SphereGeometry|InstancedMesh|CanvasTexture|WebGLRenderer|ShaderMaterial|MeshStandardMaterial|MeshBasicMaterial)/
        .test(f.text));
    const missing = creators
      .filter((f) => !/\bdispose\s*\(/.test(f.text))
      .map((f) => f.rel);
    expect(missing).toEqual([]);
  });

  it('every system module that owns state exposes dispose() or reset()', () => {
    const systems = [
      'src/game/ai/enemies.js',
      'src/game/weapons/impacts.js',
      'src/game/weapons/weapons.js',
      'src/game/level/levelbuild.js',
      'src/game/mission/director.js',
      'src/engine/renderer.js',
      'src/engine/materials.js',
      'src/engine/textures.js',
      'src/audio/audio.js',
      'src/core/input.js',
      'src/app.js',
    ];
    for (const rel of systems) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} not found`).toBeTruthy();
      expect(/\b(dispose|reset|clear)\s*\(/.test(f.text), `${rel} has no teardown`).toBe(true);
    }
  });

  it('disposes every geometry the level builder creates', () => {
    const f = files.find((x) => x.rel === 'src/game/level/levelbuild.js');
    expect(f.text).toMatch(/for \(const g of this\._geometries\) g\.dispose/);
  });

  it('keeps the fixed timestep as the single source of simulation dt', () => {
    const loop = files.find((x) => x.rel === 'src/core/loop.js');
    expect(loop.text).toMatch(/export const FIXED_DT = 1 \/ 60/);
    // Gameplay modules must not invent their own timestep.
    const offenders = files
      .filter((f) => /src\/game\//.test(f.rel))
      .filter((f) => /\b1\s*\/\s*60\b/.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('routes gameplay randomness through an Rng instance', () => {
    const gameplay = files.filter((f) => /src\/game\/(ai|weapons)\//.test(f.rel));
    const usesRandomness = gameplay.filter((f) => /\brng\b/.test(f.text));
    expect(usesRandomness.length).toBeGreaterThan(2);
  });
});

describe('project files', () => {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  it('ships the three governing documents', () => {
    for (const doc of ['GAME_SPEC.md', 'AGENTS.md', 'QUALITY_RUBRIC.md']) {
      expect(read(doc).length).toBeGreaterThan(1500);
    }
  });

  it('declares no runtime dependency other than three', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys(pkg.dependencies)).toEqual(['three']);
  });

  it('exposes the commands the documentation promises', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const script of ['dev', 'build', 'preview', 'test', 'test:e2e', 'capture', 'profile', 'verify']) {
      expect(pkg.scripts[script], `missing script ${script}`).toBeTruthy();
    }
  });

  it('has no image or audio assets checked in', () => {
    const assetExt = /\.(png|jpe?g|gif|webp|mp3|ogg|wav|glb|gltf|fbx)$/i;
    const assets = [];
    const scan = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'artifacts' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) scan(full);
        else if (assetExt.test(entry)) assets.push(relative(ROOT, full));
      }
    };
    scan(ROOT);
    expect(assets).toEqual([]);
  });
});
