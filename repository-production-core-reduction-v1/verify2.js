'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');

// Load protected sets from before run: recompute minimal here by re-reading delete plan + metrics? Simpler: re-derive.
// We'll just scan and categorize references.
const tokens = ['.audit', 'audit/', 'outputs', 'data-cache', 'archive'];
const files = [];
function walk(abs, rel) {
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (['node_modules', '.git', '.workbuddy', 'repository-production-core-reduction-v1'].includes(e.name)) continue;
    const abs2 = path.join(abs, e.name); const rel2 = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) walk(abs2, rel2);
    else if (e.name.endsWith('.js')) files.push({ rel: rel2, abs: abs2 });
  }
}
walk(ROOT, '');

for (const tok of tokens) {
  console.log('\n===== TOKEN: ' + tok + ' =====');
  for (const f of files) {
    let src = ''; try { src = fs.readFileSync(f.abs, 'utf8'); } catch (e) { continue; }
    if (!src.includes(tok)) continue;
    // Determine if it's a require or fs call
    const lines = src.split('\n').map((l, i) => ({ i: i + 1, l })).filter(o => o.l.includes(tok));
    // classify: require(...) or readFileSync/readdirSync/fs with token
    const isDep = lines.some(o => /require\s*\(|readFileSync|readdirSync|readFile|writeFile|existsSync|createReadStream|glob|fs\./.test(o.l));
    if (isDep) {
      console.log('  [DEP] ' + f.rel);
      for (const o of lines) if (/require\s*\(|readFileSync|readdirSync|readFile|writeFile|existsSync|createReadStream|glob|fs\./.test(o.l)) console.log('      L' + o.i + ': ' + o.l.trim().slice(0, 160));
    }
  }
}
console.log('\nDone. Only [DEP] entries represent real require/fs dependencies on the token.');
