'use strict';
// Execute deletions from cleanup-delete-plan.json. Records deleted-paths.json.
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');
const EXCLUDE = new Set(['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1']);

// inventory for sizes
const allFiles = [];
function walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (EXCLUDE.has(e.name)) continue;
    const abs2 = path.join(abs, e.name); const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) walk(abs2, rel2);
    else { let s = 0; try { s = fs.statSync(abs2).size; } catch (e2) {} allFiles.push({ rel: rel2, size: s }); }
  }
}
walk(ROOT, '');

const plan = JSON.parse(fs.readFileSync(path.join(REPORT, 'cleanup-delete-plan.json'), 'utf8'));
const deleted = [];
function tracked(rel) { try { execSync('git ls-files --error-unmatch -- ' + JSON.stringify(rel), { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch (e) { return false; } }

for (const e of plan) {
  const p = path.join(ROOT, e.path);
  let size = e.sizeBytes || 0;
  if (e.type === 'dir' && (!size || size === 0)) {
    size = allFiles.filter(f => f.rel === e.path || f.rel.startsWith(e.path + '/')).reduce((a, f) => a + f.size, 0);
  }
  try {
    if (e.type === 'dir') {
      if (fs.existsSync(p)) execSync('rm -rf ' + JSON.stringify(p));
      try { execSync('git rm -r --cached --ignore-unmatch -- ' + JSON.stringify(e.path), { cwd: ROOT, stdio: 'ignore' }); } catch (e2) {}
    } else {
      if (tracked(e.path)) { try { execSync('git rm --cached --ignore-unmatch -- ' + JSON.stringify(e.path), { cwd: ROOT, stdio: 'ignore' }); } catch (e2) {} }
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (err) {
    console.error('FAILED ' + e.path + ': ' + err.message);
    continue;
  }
  deleted.push({ path: e.path, type: e.type, classification: e.classification, sizeBytes: size });
}
fs.writeFileSync(path.join(REPORT, 'deleted-paths.json'), JSON.stringify(deleted, null, 2));

const byCat = {}; for (const d of deleted) byCat[d.classification] = (byCat[d.classification] || 0) + 1;
const totalSize = deleted.reduce((a, d) => a + d.sizeBytes, 0);
console.log('DELETED entries: ' + deleted.length);
console.log('BY CATEGORY: ' + JSON.stringify(byCat));
console.log('TOTAL DELETED BYTES: ' + totalSize + ' (' + (totalSize / 1024 / 1024).toFixed(2) + ' MB)');
