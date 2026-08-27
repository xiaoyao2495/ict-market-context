'use strict';
// Repository Production-Core Reduction V1 — analysis pass.
// Builds require-graph, BFS from prod/test/tool roots, classifies every path.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1']);

// ---------- 1. inventory ----------
const files = []; // {rel, abs, ext, size, isDir}
function walk(abs, rel) {
  let ents;
  try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const abs2 = path.join(abs, e.name);
    const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      files.push({ rel: rel2, abs: abs2, ext: '', size: 0, isDir: true });
      walk(abs2, rel2);
    } else {
      let size = 0; try { size = fs.statSync(abs2).size; } catch (e2) {}
      files.push({ rel: rel2, abs: abs2, ext: path.extname(e.name).toLowerCase(), size, isDir: false });
    }
  }
}
walk(ROOT, '');

// tracked set
let tracked = new Set();
try {
  const out = execSync('git ls-files', { cwd: ROOT }).toString().split('\n').filter(Boolean);
  tracked = new Set(out);
} catch (e) { /* ignore */ }
const isTracked = (rel) => tracked.has(rel);

// module map (js/json)
const moduleMap = {};
for (const f of files) {
  if (f.isDir) continue;
  if (f.ext === '.js' || f.ext === '.json') moduleMap[f.rel] = f;
}

// ---------- 2. require graph ----------
function extractRequires(abs) {
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const specs = [];
  const re = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[2]);
  const re2 = /\brequire\.resolve\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = re2.exec(src))) specs.push(m[2]);
  return specs;
}
function resolveSpec(baseRel, spec) {
  if (!spec.startsWith('.')) return null; // external
  let target = path.normalize(path.join(path.dirname(baseRel), spec));
  const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js'), path.join(target, 'index.json')];
  for (const c of cands) if (moduleMap[c]) return c;
  return null;
}
const adj = {}; // rel -> [deps]
for (const f of files) {
  if (f.isDir || f.ext !== '.js') continue;
  const deps = [];
  for (const spec of extractRequires(f.abs)) {
    const r = resolveSpec(f.rel, spec);
    if (r) deps.push(r);
  }
  adj[f.rel] = deps;
}
function bfs(roots) {
  const seen = new Set(); const q = [];
  for (const r of roots) if (moduleMap[r]) { seen.add(r); q.push(r); }
  while (q.length) {
    const cur = q.shift();
    for (const d of (adj[cur] || [])) if (!seen.has(d)) { seen.add(d); q.push(d); }
  }
  return seen;
}

// ---------- 3. roots ----------
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const PROD_ROOTS = ['scripts/live.js'];
if (pkg.main && moduleMap[pkg.main]) PROD_ROOTS.push(pkg.main);
// entry dir files as possible prod roots if they exist
for (const e of ['entry/entryGate.js', 'entry/entryExplanation.js', 'entry/entryInvalidation.js']) {
  if (moduleMap[e]) PROD_ROOTS.push(e);
}

const TEST_ROOTS = [];
for (const f of files) {
  if (!f.isDir && f.rel.startsWith('test/') && f.ext === '.js') TEST_ROOTS.push(f.rel);
}

// tool roots: package.json scripts + known dev tools
const TOOL_SCRIPT_TARGETS = [];
if (pkg.scripts) {
  for (const k of Object.keys(pkg.scripts)) {
    const v = pkg.scripts[k];
    const m = v.match(/(?:node\s+)?([^\s]+\.js)/);
    if (m && moduleMap[m[1]]) TOOL_SCRIPT_TARGETS.push(m[1]);
  }
}
const KNOWN_TOOLS = ['scripts/testDingTalk.js', 'scripts/inspectLiquidity.js'];
const TOOL_ROOTS = TOOL_SCRIPT_TARGETS.slice();
for (const t of KNOWN_TOOLS) if (moduleMap[t]) TOOL_ROOTS.push(t);

const prodReach = bfs(PROD_ROOTS);
const testReach = bfs(TEST_ROOTS);
const toolReach = bfs(TOOL_ROOTS.filter(r => !prodReach.has(r) && !testReach.has(r)));

// A tool-reachable file is "kept" only if it's not a research-pattern script.
const RESEARCH_FILE = /(Audit|Shadow|Diagnosis|Design|Comparison|Evaluation|Acceptance|Replay|Population|Research|Probe|Investigation|Experiment)/i;
function isResearchPattern(rel) { return RESEARCH_FILE.test(rel); }

const protectedReach = new Set();
for (const r of prodReach) protectedReach.add(r);
for (const r of testReach) protectedReach.add(r);
// tool roots that are NOT research pattern -> keep (active tool)
const toolKeep = new Set();
for (const r of toolReach) if (!isResearchPattern(r)) toolKeep.add(r);

// reverse adjacency for consumers
const consumersOf = {};
for (const f of Object.keys(adj)) {
  for (const d of adj[f]) {
    if (!consumersOf[d]) consumersOf[d] = [];
    consumersOf[d].push(f);
  }
}

// ---------- 4. helper: dir full deletability ----------
// returns true if dir and all descendants are NOT in protectedReach and NOT a protected dir
function dirFullyDeletable(dirRel) {
  if (EXCLUDE_DIRS.has(dirRel) || dirRel === '') return false;
  // check any protected file inside
  for (const f of files) {
    if (f.isDir) continue;
    if (f.rel === dirRel) continue;
    if (f.rel.startsWith(dirRel + '/')) {
      if (protectedReach.has(f.rel)) return false;
    }
  }
  // also any dir inside that is itself protected? none.
  return true;
}

// ---------- 5. classify ----------
function classifyNonReachable(rel, ext) {
  // directory-based
  const segs = rel.split('/');
  const top = segs[0];
  const base = path.basename(rel);
  // root-level artifact dirs
  if (top.startsWith('.audit')) return 'AUDIT_ONLY';
  if (/(audit|design|shadow|diagnosis|diagnos|comparison|evaluation|integration|finalization|semantics|registry|architecture|policy|trace|frontier|funnel|gate|refactor|replacement|extension|consumption|eligible|evidence|population|quality|coverage|availability|hierarchy|projection|stall|replay|fix|minimal|live-multi|sndkusdt|mtf|multi-timeframe|swing-context|structural-role|watch-|narrative-|liquidity-|displacement-)/i.test(top) && top !== 'live' && top !== 'liquidity' /* careful */) {
    // distinguish source dirs (liquidity, live) from artifact dirs: source dirs contain reachable files normally.
    // We'll only mark as artifact if it ALSO has no reachable file — but this is a name hint.
    // To avoid over-deleting source dirs, only treat as artifact if name contains a clear artifact token:
  }
  const ARTIFACT_TOKEN = /(audit|design|shadow|diagnosis|comparison|evaluation|integration|finalization|semantics|registry|architecture|policy|trace|frontier|funnel|gate|refactor|replacement|extension|consumption|eligible|evidence|population|quality|coverage|availability|hierarchy|projection|stall|replay|fix|minimal|bootstrap|sndkusdt|mtf|multi-timeframe|swing-context|structural-role|watch-|narrative-|liquidity-|displacement-)/i;
  if (ARTIFACT_TOKEN.test(top) && top !== 'liquidity' && top !== 'live') return 'GENERATED_ARTIFACT';
  if (top === 'archive') return 'ARCHIVED';
  if (top === 'data-cache') return 'CACHE';
  if (top === 'outputs') return 'OLD_OUTPUT';
  if (top === 'audit') return 'AUDIT_ONLY';
  if (top === 'ai' || top === 'draw') return 'RESEARCH_ONLY';
  if (isResearchPattern(rel)) return 'RESEARCH_ONLY';
  // default unknown -> keep
  return 'UNKNOWN';
}

const deletePlan = [];
const unknownList = [];
const keepList = []; // production core snapshot

function addDeleteEntry(rel, type, classification, reason, safe) {
  deletePlan.push({
    path: rel,
    type,
    classification,
    sizeBytes: 0,
    productionReachable: protectedReach.has(rel) && false,
    testReachable: false,
    activeToolReachable: false,
    consumers: consumersOf[rel] || [],
    reason,
    safeToDelete: safe
  });
}

// Process top-level dirs for whole-dir deletion first
const topDirs = [];
for (const f of files) {
  if (f.isDir && !f.rel.includes('/')) topDirs.push(f.rel);
}
// also root-level .audit-* and *-v1 dirs are top-level dirs already captured.

const wholeDirDeleted = new Set();
for (const d of topDirs) {
  if (EXCLUDE_DIRS.has(d)) continue;
  if (dirFullyDeletable(d)) {
    wholeDirDeleted.add(d);
    const cat = classifyNonReachable(d, '');
    let size = 0;
    for (const f of files) if (!f.isDir && f.rel.startsWith(d + '/')) size += f.size;
    deletePlan.push({
      path: d, type: 'dir', classification: cat, sizeBytes: size,
      productionReachable: false, testReachable: false, activeToolReachable: false,
      consumers: [], reason: 'WHOLE_DIR_DELETABLE: no prod/test/tool-reachable file inside', safeToDelete: true
    });
  }
}

// Now classify individual files not inside a whole-deleted dir
for (const f of files) {
  if (f.isDir) continue;
  const rel = f.rel;
  // skip if inside a whole-deleted dir
  let inWhole = false;
  for (const d of wholeDirDeleted) if (rel === d || rel.startsWith(d + '/')) { inWhole = true; break; }
  if (inWhole) continue;

  if (protectedReach.has(rel)) {
    let cls = prodReach.has(rel) ? 'PRODUCTION_REQUIRED' : testReach.has(rel) ? 'ACTIVE_TEST_REQUIRED' : 'ACTIVE_TOOL_REQUIRED';
    keepList.push({ rel, cls, size: f.size, tracked: isTracked(rel) });
    continue;
  }
  // not reachable
  // test file obsolete detection
  if (rel.startsWith('test/') && rel.endsWith('.js')) {
    // compute required project modules
    const seen = new Set(); const q = [rel];
    while (q.length) { const c = q.shift(); for (const d of (adj[c] || [])) if (!seen.has(d)) { seen.add(d); q.push(d); } }
    const projReqs = [...seen].filter(r => !r.startsWith('node_modules') && r !== rel);
    const touchesProd = projReqs.some(r => prodReach.has(r));
    if (!touchesProd && projReqs.length > 0) {
      deletePlan.push({ path: rel, type: 'file', classification: 'OBSOLETE_TEST', sizeBytes: f.size, productionReachable: false, testReachable: true, activeToolReachable: false, consumers: consumersOf[rel] || [], reason: 'TEST_ONLY_COVERS_DELETABLE_SUBSYSTEM', safeToDelete: true });
      continue;
    }
    // test file that may be useful: keep as UNKNOWN if it doesn't touch prod? Actually keep it.
    unknownList.push({ path: rel, reasonUnknown: 'test file not requiring production module directly; kept for safety', possibleConsumer: 'test/run.js' });
    keepList.push({ rel, cls: 'UNKNOWN_KEEP', size: f.size, tracked: isTracked(rel) });
    continue;
  }
  const cat = classifyNonReachable(rel, f.ext);
  if (cat === 'UNKNOWN') {
    unknownList.push({ path: rel, reasonUnknown: 'non-reachable source file, no research/artifact pattern; kept (UNKNOWN safety)', possibleConsumer: 'none detected' });
    keepList.push({ rel, cls: 'UNKNOWN_KEEP', size: f.size, tracked: isTracked(rel) });
  } else {
    deletePlan.push({ path: rel, type: 'file', classification: cat, sizeBytes: f.size, productionReachable: false, testReachable: false, activeToolReachable: false, consumers: consumersOf[rel] || [], reason: 'NOT_REACHABLE_FROM_PROD_TEST_TOOL', safeToDelete: true });
  }
}

// fill sizeBytes for deletePlan entries
for (const e of deletePlan) {
  if (e.type === 'file') { const mf = moduleMap[e.path] || files.find(f => f.rel === e.path); e.sizeBytes = mf ? mf.size : 0; }
}

// ---------- 6. safety grep: artifact dirs referenced by source? ----------
function grepSource(substr) {
  const hits = [];
  for (const f of files) {
    if (f.isDir || f.ext !== '.js') continue;
    if (protectedReach.has(f.rel)) {
      let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) {}
      if (src.includes(substr)) hits.push(f.rel);
    }
  }
  return hits;
}
const safety = {};
for (const s of ['data-cache', 'outputs', 'archive', '.audit', 'audit/']) safety[s] = grepSource(s);

// ---------- 7. package script audit ----------
const pkgAudit = [];
if (pkg.scripts) {
  for (const k of Object.keys(pkg.scripts)) {
    const v = pkg.scripts[k];
    const m = v.match(/(?:node\s+)?([^\s]+\.js|\S+)/);
    const target = m ? m[1] : v;
    const exists = !!moduleMap[target] || fs.existsSync(path.join(ROOT, target));
    let cls = 'UNKNOWN';
    if (moduleMap[target]) {
      if (protectedReach.has(target)) cls = prodReach.has(target) ? 'PRODUCTION' : testReach.has(target) ? 'ACTIVE_TEST' : 'ACTIVE_TOOL';
      else if (isResearchPattern(target)) cls = 'RESEARCH_ONLY';
      else cls = 'OTHER';
    }
    pkgAudit.push({ script: k, command: v, target, targetExists: exists, classification: cls, pointsToDeletable: cls === 'RESEARCH_ONLY' });
  }
}

// ---------- 8. metrics ----------
function dirSize(rel) { let s = 0; for (const f of files) if (!f.isDir && (f.rel === rel || f.rel.startsWith(rel + '/'))) s += f.size; return s; }
function countIn(rel) { let c = 0, j = 0; for (const f of files) { if (f.isDir) continue; if (f.rel === rel || f.rel.startsWith(rel + '/')) { c++; if (f.ext === '.js') j++; } } return { c, j }; }

const before = {
  totalFiles: files.filter(f => !f.isDir).length,
  jsFiles: files.filter(f => !f.isDir && f.ext === '.js').length,
  trackedFiles: files.filter(f => !f.isDir && isTracked(f.rel)).length,
  untrackedFiles: files.filter(f => !f.isDir && !isTracked(f.rel)).length,
  projectSizeBytes: files.filter(f => !f.isDir).reduce((a, f) => a + f.size, 0),
  nodeModulesSizeBytes: dirSize('node_modules'),
  perDir: {},
  top50: []
};
// per-dir (top-level)
for (const d of topDirs) {
  const { c, j } = countIn(d);
  before.perDir[d] = { fileCount: c, jsFileCount: j, sizeBytes: dirSize(d) };
}
// top 50 by size
const allFiles = files.filter(f => !f.isDir).slice().sort((a, b) => b.size - a.size);
before.top50 = allFiles.slice(0, 50).map(f => ({ path: f.rel, sizeBytes: f.size, ext: f.ext }));

// ---------- write outputs ----------
function w(name, obj) { fs.writeFileSync(path.join(REPORT, name), JSON.stringify(obj, null, 2)); }
w('before-metrics.json', before);
w('production-dependency-graph.json', { roots: PROD_ROOTS, nodes: [...prodReach], adjacency: pickAdj(prodReach) });
w('test-dependency-graph.json', { roots: TEST_ROOTS, nodes: [...testReach], adjacency: pickAdj(testReach) });
w('cleanup-delete-plan.json', deletePlan);
w('cleanup-unknown.json', unknownList);
w('package-script-audit.json', pkgAudit);
w('safety-grep.json', safety);
function pickAdj(set) { const o = {}; for (const n of set) o[n] = adj[n] || []; return o; }

// summary text
let s = '';
s += 'PROD reachable: ' + prodReach.size + '\n';
s += 'TEST reachable: ' + testReach.size + '\n';
s += 'TOOL reachable (kept): ' + toolKeep.size + '\n';
s += 'DELETE entries: ' + deletePlan.length + ' (dirs: ' + deletePlan.filter(e => e.type === 'dir').length + ', files: ' + deletePlan.filter(e => e.type === 'file').length + ')\n';
const byCat = {};
for (const e of deletePlan) byCat[e.classification] = (byCat[e.classification] || 0) + 1;
s += 'BY CATEGORY: ' + JSON.stringify(byCat) + '\n';
s += 'UNKNOWN kept: ' + unknownList.length + '\n';
s += 'KEEP (prod/test/tool): ' + keepList.length + '\n';
s += 'SAFETY GREP (artifact dirs referenced by PROD/TEST code): ' + JSON.stringify(safety) + '\n';
s += 'PKG AUDIT: ' + JSON.stringify(pkgAudit.map(p => ({ s: p.script, t: p.target, cls: p.classification, exists: p.targetExists }))) + '\n';
s += 'WHOLE DIRS DELETED: ' + JSON.stringify([...wholeDirDeleted]) + '\n';
fs.writeFileSync(path.join(REPORT, 'analysis-summary.txt'), s);
console.log(s);
