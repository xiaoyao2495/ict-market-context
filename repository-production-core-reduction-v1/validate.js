'use strict';
// Definitive safety validation before deletion.
const fs = require('fs'); const path = require('path');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');
const EXCLUDE = new Set(['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1']);

// inventory
const files = [];
function walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (EXCLUDE.has(e.name)) continue;
    const abs2 = path.join(abs, e.name); const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) { files.push({ rel: rel2, abs: abs2, isDir: true }); walk(abs2, rel2); }
    else files.push({ rel: rel2, abs: abs2, isDir: false, ext: path.extname(e.name).toLowerCase() });
  }
}
walk(ROOT, '');
const moduleMap = {}; for (const f of files) if (!f.isDir && (f.ext === '.js' || f.ext === '.json')) moduleMap[f.rel] = f;

const plan = JSON.parse(fs.readFileSync(path.join(REPORT, 'cleanup-delete-plan.json'), 'utf8'));

// deletable set: dir entries + their recursive contents; file entries
const deletable = new Set();
for (const e of plan) {
  if (e.type === 'dir') {
    deletable.add(e.path);
    for (const f of files) if (!f.isDir && (f.rel === e.path || f.rel.startsWith(e.path + '/'))) deletable.add(f.rel);
  } else deletable.add(e.path);
}

function resolveSpec(baseRel, spec) {
  if (!spec.startsWith('.')) return null;
  let target = path.normalize(path.join(path.dirname(baseRel), spec));
  const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js'), path.join(target, 'index.json')];
  for (const c of cands) if (moduleMap[c]) return c;
  return null;
}
function fsLiterals(abs, baseRel) {
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const out = [];
  const re = /path\.join\s*\(\s*(?:__dirname|[^,]+)\s*,\s*(['"])([^'"]+)\1/g; let m;
  while ((m = re.exec(src))) out.push(m[2]);
  const re2 = /(?:readFileSync|readdirSync|existsSync|createReadStream|readFile|writeFileSync|statSync|readdir)\s*\(\s*(?:path\.join\s*\([^)]*\)|(['"])([^'"]+)\1)/g;
  while ((m = re2.exec(src))) { if (m[2]) out.push(m[2]); }
  return out.map(s => { try { return path.normalize(path.join(path.dirname(baseRel), s)); } catch (e) { return s; } });
}

const violations = [];
for (const f of files) {
  if (f.isDir || f.ext !== '.js') continue;
  if (deletable.has(f.rel)) continue; // only surviving files
  if (f.rel.startsWith('repository-production-core-reduction-v1/')) continue;
  let src; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
  // requires
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g; let m;
  while ((m = re.exec(src))) {
    const r = resolveSpec(f.rel, m[2]);
    if (r && deletable.has(r)) violations.push({ file: f.rel, kind: 'require', target: r });
  }
  const reqResolve = /\brequire\.resolve\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = reqResolve.exec(src))) { const r = resolveSpec(f.rel, m[2]); if (r && deletable.has(r)) violations.push({ file: f.rel, kind: 'require.resolve', target: r }); }
  // fs
  for (const lit of fsLiterals(f.abs, f.rel)) {
    if (deletable.has(lit) || [...deletable].some(d => lit === d || lit.startsWith(d + '/') || d.startsWith(lit + '/'))) {
      violations.push({ file: f.rel, kind: 'fs', target: lit });
    }
  }
}
fs.writeFileSync(path.join(REPORT, 'validation-report.json'), JSON.stringify({ deletableCount: deletable.size, violations }, null, 2));
console.log('DELETABLE paths (incl recursive): ' + deletable.size);
console.log('VIOLATIONS (surviving file depends on deletable): ' + violations.length);
if (violations.length) console.log(JSON.stringify(violations.slice(0, 50), null, 2));
else console.log('SAFE: no surviving production/test/tool file requires or fs-reads any deletable path.');
