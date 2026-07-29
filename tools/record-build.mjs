/**
 * Records the build facts the rubric asks for (A1–A3) into artifacts/logs/build.json:
 * install audit result, whether the production build succeeded, and the gzip size
 * of the app bundle excluding Three.js.
 *
 * Usage: node tools/record-build.mjs
 */
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
mkdirSync(join(ROOT, 'artifacts/logs'), { recursive: true });

const run = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let installVulnerabilities = null;
let auditRaw = '';
try {
  auditRaw = run('npm audit --json --omit=dev');
} catch (e) {
  auditRaw = e.stdout || '';
}
try {
  const audit = JSON.parse(auditRaw);
  const v = audit.metadata?.vulnerabilities ?? {};
  installVulnerabilities = Object.values(v).reduce((a, b) => a + b, 0);
} catch {
  installVulnerabilities = null;
}

let buildOk = false;
let buildOutput = '';
try {
  buildOutput = run('npm run build');
  buildOk = true;
} catch (e) {
  buildOutput = `${e.stdout || ''}${e.stderr || ''}`;
}

const assets = join(ROOT, 'dist/assets');
const files = readdirSync(assets);
let appGzip = 0;
let threeGzip = 0;
const detail = [];
for (const f of files) {
  if (!/\.(js|css)$/.test(f)) continue;
  const buf = readFileSync(join(assets, f));
  const gz = gzipSync(buf).length;
  const isThree = f.startsWith('three-');
  if (isThree) threeGzip += gz;
  else appGzip += gz;
  detail.push({ file: f, rawKB: +(buf.length / 1024).toFixed(1), gzipKB: +(gz / 1024).toFixed(1), isThree });
}
const htmlBuf = readFileSync(join(ROOT, 'dist/index.html'));
appGzip += gzipSync(htmlBuf).length;
detail.push({
  file: 'index.html',
  rawKB: +(htmlBuf.length / 1024).toFixed(1),
  gzipKB: +(gzipSync(htmlBuf).length / 1024).toFixed(1),
  isThree: false,
});

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  installVulnerabilities,
  buildOk,
  buildOutput: buildOutput.trim().split('\n').slice(-14),
  appGzipKB: +(appGzip / 1024).toFixed(1),
  threeGzipKB: +(threeGzip / 1024).toFixed(1),
  totalGzipKB: +((appGzip + threeGzip) / 1024).toFixed(1),
  distFiles: files,
  detail,
  assetFilesInRepo: (() => {
    const bad = [];
    const scan = (dir) => {
      for (const e of readdirSync(dir)) {
        if (['node_modules', '.git', 'artifacts', 'dist'].includes(e)) continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) scan(full);
        else if (/\.(png|jpe?g|gif|webp|mp3|ogg|wav|glb|gltf|fbx)$/i.test(e)) bad.push(full);
      }
    };
    scan(ROOT);
    return bad;
  })(),
};

writeFileSync(join(ROOT, 'artifacts/logs/build.json'), JSON.stringify(report, null, 2));
console.log(`build ok: ${buildOk}`);
console.log(`vulnerabilities: ${installVulnerabilities}`);
console.log(`app gzip: ${report.appGzipKB} kB (three: ${report.threeGzipKB} kB, total ${report.totalGzipKB} kB)`);
console.log(`asset files checked in: ${report.assetFilesInRepo.length}`);
