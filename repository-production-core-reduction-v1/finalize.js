'use strict';
// Finalize: authoritative delete-plan with keeper-dependency re-validation.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1']);
const KEEP_ROOT_FILES = new Set(['package.json', 'package-lock.json', 'README.live.md', 'PROJECT_MEMORY.md', '.gitignore', '.DS_Store']);

// inventory
const files = [];
function walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const abs2 = path.join(abs, e.name); const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) { files.push({ rel: rel2, abs: abs2, ext: '', size: 0, isDir: true }); walk(abs2, rel2); }
    else { let s = 0; try { s = fs.statSync(abs2).size; } catch (e2) {} files.push({ rel: rel2, abs: abs2, ext: path.extname(e.name).toLowerCase(), size: s, isDir: false }); }
  }
}
walk(ROOT, '');
let tracked = new Set(); try { tracked = new Set(execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean)); } catch (e) {}
const isTracked = (rel) => tracked.has(rel);

const moduleMap = {};
for (const f of files) if (!f.isDir && (f.ext === '.js' || f.ext === '.json')) moduleMap[f.rel] = f;

function extractRequires(abs) {
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const specs = []; const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g; let m;
  while ((m = re.exec(src))) specs.push(m[2]);
  const re2 = /\brequire\.resolve\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = re2.exec(src))) specs.push(m[2]);
  return specs;
}
function resolveSpec(baseRel, spec) {
  if (!spec.startsWith('.')) return null;
  let target = path.normalize(path.join(path.dirname(baseRel), spec));
  const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js'), path.join(target, 'index.json')];
  for (const c of cands) if (moduleMap[c]) return c;
  return null;
}
const adj = {};
for (const f of files) { if (f.isDir || f.ext !== '.js') continue; const deps = []; for (const s of extractRequires(f.abs)) { const r = resolveSpec(f.rel, s); if (r) deps.push(r); } adj[f.rel] = deps; }
function bfs(roots) { const seen = new Set(); const q = []; for (const r of roots) if (moduleMap[r]) { seen.add(r); q.push(r); } while (q.length) { const c = q.shift(); for (const d of (adj[c] || [])) if (!seen.has(d)) { seen.add(d); q.push(d); } } return seen; }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PROD_ROOTS = ['scripts/live.js']; if (pkg.main && moduleMap[pkg.main]) PROD_ROOTS.push(pkg.main);
for (const e of ['entry/entryGate.js', 'entry/entryExplanation.js', 'entry/entryInvalidation.js']) if (moduleMap[e]) PROD_ROOTS.push(e);
const TEST_ROOTS = files.filter(f => !f.isDir && f.rel.startsWith('test/') && f.ext === '.js').map(f => f.rel);
const TOOL_TARGETS = [];
if (pkg.scripts) for (const k of Object.keys(pkg.scripts)) { const m = pkg.scripts[k].match(/(?:node\s+)?([^\s]+\.js)/); if (m && moduleMap[m[1]]) TOOL_TARGETS.push(m[1]); }
for (const t of ['scripts/testDingTalk.js', 'scripts/inspectLiquidity.js']) if (moduleMap[t]) TOOL_TARGETS.push(t);
const TOOL_ROOTS = TOOL_TARGETS.slice();

const prodReach = bfs(PROD_ROOTS);
const testReach = bfs(TEST_ROOTS);
const toolReach = bfs(TOOL_ROOTS.filter(r => !prodReach.has(r) && !testReach.has(r)));
const RESEARCH_FILE = /(Audit|Shadow|Diagnosis|Design|Comparison|Evaluation|Acceptance|Replay|Population|Research|Probe|Investigation|Experiment)/i;
const toolKeep = new Set([...toolReach].filter(r => !RESEARCH_FILE.test(r)));
const protectedReach = new Set([...prodReach, ...testReach, ...toolKeep]);

// UNKNOWN-keep: non-reachable source .js not matching research pattern -> keep (safety)
const unknownKeep = new Set();
for (const f of files) {
  if (f.isDir || f.ext !== '.js') continue;
  if (protectedReach.has(f.rel)) continue;
  if (RESEARCH_FILE.test(f.rel)) continue;
  const top = f.rel.split('/')[0];
  if (['ai', 'draw', 'archive', 'data-cache', 'outputs', 'audit'].includes(top)) continue; // these handled by dir/pattern rules
  unknownKeep.add(f.rel);
}

// initial deletable per file: not in protectedReach, not unknownKeep, not keep-root-files
function fileDeletableInit(rel) {
  if (protectedReach.has(rel)) return false;
  if (unknownKeep.has(rel)) return false;
  if (KEEP_ROOT_FILES.has(rel)) return false;
  if (rel.startsWith('docs/')) return false;
  return true;
}

// keeper .js set (for fs-dependency re-validation): protectedReach .js + unknownKeep .js
const keeperJs = new Set([...protectedReach].filter(r => r.endsWith('.js') || r.endsWith('.json')).concat([...unknownKeep]));
// Also any root file in keeperJs? fine.

// Extract fs-read literal paths from a keeper .js
function fsLiterals(abs, baseRel) {
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const out = [];
  const re = /(?:fs|fspath)?\.(?:readFileSync|readdirSync|existsSync|createReadStream|readFile|writeFileSync|statSync|readdir|readFileSync)\s*\(\s*(?:path\.join\s*\(\s*(?:__dirname|[^,]+)\s*,\s*)?(['"])([^'"]+)\1/g;
  let m; while ((m = re.exec(src))) out.push(m[2]);
  // also path.join(__dirname, 'x')
  const re2 = /path\.join\s*\(\s*(?:__dirname|[^,]+)\s*,\s*(['"])([^'"]+)\1/g;
  while ((m = re2.exec(src))) out.push(m[2]);
  return out.map(s => { try { return path.normalize(path.join(path.dirname(baseRel), s)); } catch (e) { return s; } });
}

// Build set of keeper-referenced paths (resolved)
const keeperReferenced = new Set();
for (const k of keeperJs) {
  if (!moduleMap[k]) continue;
  for (const lit of fsLiterals(moduleMap[k].abs, k)) {
    keeperReferenced.add(lit);
    keeperReferenced.add(lit + '.js'); keeperReferenced.add(lit + '.json');
    keeperReferenced.add(path.join(lit, 'index.js'));
  }
}

// Re-validation: a candidate file is KEPT if any keeper references its path (fs) or requires it.
// (require closure already covered by protectedReach; fs is the gap.)
const deletable = new Set();
for (const f of files) {
  if (f.isDir) continue;
  if (!fileDeletableInit(f.rel)) continue;
  // fs re-validation
  if (keeperReferenced.has(f.rel)) { unknownKeep.add(f.rel); continue; }
  // also keep if inside a dir that a keeper fs-references
  let kept = false;
  for (const kr of keeperReferenced) { if (f.rel === kr || f.rel.startsWith(kr.replace(/\/$/, '') + '/')) { unknownKeep.add(f.rel); kept = true; break; } }
  if (kept) continue;
  deletable.add(f.rel);
}

// Now classify deletable files & build dir-level plan
function classify(rel) {
  const top = rel.split('/')[0];
  if (top.startsWith('.audit')) return 'AUDIT_ONLY';
  const ART = /(audit|design|shadow|diagnosis|comparison|evaluation|integration|finalization|semantics|registry|architecture|policy|trace|frontier|funnel|gate|refactor|replacement|extension|consumption|eligible|evidence|population|quality|coverage|availability|hierarchy|projection|stall|replay|fix|minimal|bootstrap|sndkusdt|mtf|multi-timeframe|swing-context|structural-role|watch-|narrative-|liquidity-|displacement-)/i;
  if (ART.test(top) && top !== 'liquidity' && top !== 'live') return 'GENERATED_ARTIFACT';
  if (top === 'archive') return 'ARCHIVED';
  if (top === 'data-cache') return 'CACHE';
  if (top === 'outputs') return 'OLD_OUTPUT';
  if (top === 'audit') return 'AUDIT_ONLY';
  if (top === 'ai' || top === 'draw') return 'RESEARCH_ONLY';
  if (RESEARCH_FILE.test(rel)) return 'RESEARCH_ONLY';
  return 'RESEARCH_ONLY';
}

// Build per-file deletable list with classification + dir grouping
const deletePlan = [];
const unknownList = [...unknownKeep].map(r => ({ path: r, reasonUnknown: 'non-reachable source/test/tool file kept by UNKNOWN safety or keeper fs-reference', possibleConsumer: 'none detected' }));

// Group deletable files by top-level dir; if ALL files in a top-level dir are deletable -> dir entry
const topDirs = []; for (const f of files) if (f.isDir && !f.rel.includes('/')) topDirs.push(f.rel);
for (const d of topDirs) {
  if (EXCLUDE_DIRS.has(d)) continue;
  if (KEEP_ROOT_FILES.has(d)) continue;
  const inside = files.filter(f => !f.isDir && (f.rel === d || f.rel.startsWith(d + '/')));
  if (inside.length === 0) continue; // empty dir -> leave
  const allDel = inside.every(f => deletable.has(f.rel));
  if (allDel) {
    let size = 0; for (const f of inside) size += f.size;
    deletePlan.push({ path: d, type: 'dir', classification: classify(d) || 'GENERATED_ARTIFACT', sizeBytes: size, productionReachable: false, testReachable: false, activeToolReachable: false, consumers: [], reason: 'WHOLE_DIR_DELETABLE: every file inside is deletable', safeToDelete: true });
  } else {
    for (const f of inside) if (deletable.has(f.rel)) {
      deletePlan.push({ path: f.rel, type: 'file', classification: classify(f.rel), sizeBytes: f.size, productionReachable: false, testReachable: false, activeToolReachable: false, consumers: (adj[f.rel] ? [] : []), reason: 'NOT_REACHABLE_FROM_PROD_TEST_TOOL_KEEPER', safeToDelete: true });
    }
  }
}

// OBSOLETE_TEST detection: test files that are not in protectedReach? Actually test files are in testReach (protected). But a test whose required project modules are all deletable => orphan -> delete.
for (const f of files) {
  if (f.isDir || !f.rel.startsWith('test/') || f.ext !== '.js') continue;
  if (deletable.has(f.rel)) continue; // already
  if (protectedReach.has(f.rel)) {
    // check if all required project modules are deletable
    const seen = new Set(); const q = [f.rel]; while (q.length) { const c = q.shift(); for (const d of (adj[c] || [])) if (!seen.has(d)) { seen.add(d); q.push(d); } }
    const proj = [...seen].filter(r => !r.startsWith('node_modules') && r !== f.rel);
    const allDel = proj.every(r => deletable.has(r) || !protectedReach.has(r) && !unknownKeep.has(r));
    // more precisely: keep if any required module is a keeper (protected or unknownKeep)
    const touchesKeeper = proj.some(r => protectedReach.has(r) || unknownKeep.has(r));
    if (!touchesKeeper && proj.length > 0) {
      // also ensure not a dir-level kept test (it's a file). Add as obsolete test delete.
      if (!deletePlan.find(e => e.path === f.rel)) {
        deletePlan.push({ path: f.rel, type: 'file', classification: 'OBSOLETE_TEST', sizeBytes: f.size, productionReachable: false, testReachable: true, activeToolReachable: false, consumers: [], reason: 'TEST_ONLY_COVERS_DELETABLE_SUBSYSTEM', safeToDelete: true });
      }
    }
  }
}

// Remove any deletePlan entry that collides with a kept file (safety)
const finalPlan = deletePlan.filter(e => {
  if (unknownKeep.has(e.path)) return false;
  if (protectedReach.has(e.path)) return false;
  if (KEEP_ROOT_FILES.has(e.path)) return false;
  return true;
});

// Summary
const byCat = {}; for (const e of finalPlan) byCat[e.classification] = (byCat[e.classification] || 0) + 1;
let s = '';
s += 'PROD reachable: ' + prodReach.size + '\n';
s += 'TEST reachable: ' + testReach.size + '\n';
s += 'TOOL kept: ' + toolKeep.size + '\n';
s += 'UNKNOWN kept: ' + unknownKeep.size + '\n';
s += 'DELETABLE files: ' + deletable.size + '\n';
s += 'DELETE PLAN entries: ' + finalPlan.length + ' (dirs: ' + finalPlan.filter(e => e.type === 'dir').length + ', files: ' + finalPlan.filter(e => e.type === 'file').length + ')\n';
s += 'BY CATEGORY: ' + JSON.stringify(byCat) + '\n';
s += 'DIRS: ' + JSON.stringify(finalPlan.filter(e => e.type === 'dir').map(e => e.path)) + '\n';
fs.writeFileSync(path.join(REPORT, 'analysis-summary2.txt'), s);
fs.writeFileSync(path.join(REPORT, 'cleanup-delete-plan.json'), JSON.stringify(finalPlan, null, 2));
fs.writeFileSync(path.join(REPORT, 'cleanup-unknown.json'), JSON.stringify(unknownList, null, 2));
console.log(s);
