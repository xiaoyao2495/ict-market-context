'use strict';
// After-deletion integrity check: broken requires + syntax errors in surviving JS.
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');
const EXCLUDE = new Set(['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1']);

const files = [];
function walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (EXCLUDE.has(e.name)) continue;
    const abs2 = path.join(abs, e.name); const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) walk(abs2, rel2);
    else files.push({ rel: rel2, abs: abs2, ext: path.extname(e.name).toLowerCase() });
  }
}
walk(ROOT, '');

const moduleSet = new Set(files.filter(f => f.ext === '.js' || f.ext === '.json').map(f => f.rel));
function resolveSpec(baseRel, spec) {
  if (!spec.startsWith('.')) return null;
  let target = path.normalize(path.join(path.dirname(baseRel), spec));
  const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js'), path.join(target, 'index.json')];
  for (const c of cands) if (moduleSet.has(c)) return c;
  return null;
}

let broken = 0; const brokenList = [];
let syntaxErrors = 0; const syntaxErrList = [];
const jsFiles = files.filter(f => f.ext === '.js');
for (const f of jsFiles) {
  // syntax
  try { execSync('node --check ' + JSON.stringify(f.abs), { stdio: 'ignore' }); }
  catch (e) { syntaxErrors++; syntaxErrList.push(f.rel); }
  // requires
  let src; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g; let m;
  while ((m = re.exec(src))) {
    const s = m[2];
    if (!s.startsWith('.')) continue; // external
    const r = resolveSpec(f.rel, s);
    if (!r) { broken++; brokenList.push({ file: f.rel, spec: s }); }
  }
}

const report = { BROKEN_PRODUCTION_REQUIRE_COUNT: broken, PRODUCTION_SYNTAX_ERRORS: syntaxErrors, brokenList, syntaxErrList, jsFileCount: jsFiles.length };
fs.writeFileSync(path.join(REPORT, 'after-integrity.json'), JSON.stringify(report, null, 2));
console.log('JS files checked: ' + jsFiles.length);
console.log('BROKEN_REQUIRE_COUNT: ' + broken);
console.log('SYNTAX_ERRORS: ' + syntaxErrors);
if (broken) console.log('BROKEN: ' + JSON.stringify(brokenList.slice(0, 30), null, 2));
if (syntaxErrors) console.log('SYNTAX ERRORS: ' + JSON.stringify(syntaxErrList.slice(0, 30), null, 2));
