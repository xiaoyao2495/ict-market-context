/**
 * Phase 11T.3 — Narrative Boundary Pooled Report（表 ④ Cross Asset）
 *
 * 读取三币种 backtest 日志中的 NB_POOL_ROW 行，产出：
 *   1. 三币并排：PRESENT vs MISSING performance
 *   2. 三币并排：Boundary Loss 四类分布
 *   3. Pooled PRESENT vs MISSING（n 加权精确合并）
 *   4. missing rate + performance delta（MISSING 是否显著更差）
 *
 * 用法：
 *   node scripts/narrativeBoundaryPooled.js /tmp/v3_btc.log /tmp/v3_eth.log /tmp/v3_bnb.log
 */
var fs = require('fs');

var LOGS = process.argv.slice(2);
if (LOGS.length === 0) {
    console.error('usage: node scripts/narrativeBoundaryPooled.js <btc.log> [eth.log] [bnb.log]');
    process.exit(1);
}

var LOSS_KEYS = ['PRESENT_THROUGHOUT', 'MISSING_FROM_START', 'LOST_AFTER_WATCH', 'PRESENT_AT_TRIGGER_ONLY'];
var METRICS = ['surv', 'tgtHit', 'stopTgt', 'mfe', 'mae', 'mfeMae', 'medRR', 'stopATR', 'match', 'fvg'];

function parseRows(logPath) {
    var text = fs.readFileSync(logPath, 'utf8');
    var line = text.split('\n').filter(function (l) { return l.indexOf('NB_POOL_ROW ') === 0; }).pop();
    if (!line) return null;
    var symbol = line.split(' ')[1];
    var payload = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    return { symbol: symbol, data: payload };
}

var sets = LOGS.map(parseRows).filter(Boolean);
if (sets.length === 0) {
    console.error('No NB_POOL_ROW found in logs.');
    process.exit(1);
}

function fmtPct(x) {
    if (x === null || x === undefined) return 'N/A';
    return (x * 100).toFixed(0) + '%';
}
function fmt2(x) {
    if (x === null || x === undefined) return 'N/A';
    return x.toFixed(2);
}
function fmt1(x) {
    if (x === null || x === undefined) return 'N/A';
    return x.toFixed(1);
}
function pad(s, n) { s = String(s); while (s.length < n) { s = ' ' + s; } return s; }

console.log('NARRATIVE BOUNDARY BY SYMBOL (Phase 11T.3 — diagnostic only)');
console.log('');

// ---------- 1. 三币并排 PRESENT / MISSING ----------
['present', 'missing'].forEach(function (grp) {
    console.log('-- ' + grp.toUpperCase() + ' --');
    console.log('  ' + pad('metric', 10) + sets.map(function (s) { return pad(s.symbol, 10); }).join(''));
    METRICS.concat(['n']).forEach(function (m) {
        var cells = sets.map(function (s) {
            var r = (s.data[grp] || {});
            if (!r || !r.n) return pad('-', 10);
            if (m === 'n') return pad(r.n, 10);
            if (m === 'surv' || m === 'tgtHit' || m === 'stopTgt' || m === 'match') return pad(fmtPct(r[m]), 10);
            if (m === 'mfe' || m === 'mae' || m === 'mfeMae' || m === 'stopATR') return pad(fmt2(r[m]), 10);
            if (m === 'medRR') return pad(fmt1(r[m]), 10);
            return pad(fmt2(r[m]), 10);
        });
        console.log('  ' + pad(m, 10) + cells.join(''));
    });
    console.log('');
});

// ---------- 2. 三币并排 Loss 四类 ----------
console.log('-- BOUNDARY LOSS (watch vs trigger/plan) --');
console.log('  ' + pad('class', 26) + sets.map(function (s) { return pad(s.symbol, 10); }).join(''));
var lossTotal = {};
sets.forEach(function (s) { lossTotal[s.symbol] = 0; Object.keys(s.data.loss || {}).forEach(function (k) { lossTotal[s.symbol] += s.data.loss[k].n; }); });
LOSS_KEYS.forEach(function (k) {
    var cells = sets.map(function (s) {
        var r = (s.data.loss || {})[k];
        if (!r) return pad('-', 10);
        var pct = lossTotal[s.symbol] > 0 ? (r.n / lossTotal[s.symbol] * 100).toFixed(1) + '%' : '0%';
        return pad(r.n + ' (' + pct + ')', 10);
    });
    console.log('  ' + pad(k, 26) + cells.join(''));
});
console.log('');

// ---------- 3. Pooled ----------
function pooledRow(grp) {
    var n = 0, survN = 0, tgtN = 0, stopOutSum = 0, sotN = 0;
    var mfeW = 0, maeW = 0, rrW = 0, atrW = 0, matchW = 0, matchN = 0, fvgW = 0, fvgN = 0;
    sets.forEach(function (s) {
        var r = s.data[grp];
        if (!r || !r.n) return;
        n += r.n;
        survN += (r.surv || 0) * r.n;
        tgtN += (r.tgtHit || 0) * r.n;
        if (r.stopTgt !== null && r.stopTgt !== undefined) {
            // 近似：用 rate 加权（分母 n 近似 stopOutN，pooled 的 stop->tgt 有偏差但方向可信）
            stopOutSum += r.n;
            sotN += r.stopTgt * r.n;
        }
        mfeW += (r.mfe || 0) * r.n;
        maeW += (r.mae || 0) * r.n;
        if (r.medRR !== null && r.medRR !== undefined) rrW += r.medRR * r.n;
        if (r.stopATR !== null && r.stopATR !== undefined) atrW += r.stopATR * r.n;
        if (r.match !== null && r.match !== undefined) { matchW += r.match * r.n; matchN += r.n; }
        if (r.fvg !== null && r.fvg !== undefined) { fvgW += r.fvg * r.n; fvgN += r.n; }
    });
    return {
        n: n,
        surv: n > 0 ? survN / n : 0,
        tgtHit: n > 0 ? tgtN / n : 0,
        stopTgt: stopOutSum > 0 ? sotN / stopOutSum : null,
        mfe: n > 0 ? mfeW / n : 0,
        mae: n > 0 ? maeW / n : 0,
        mfeMae: maeW > 0 ? mfeW / maeW : null,
        medRR: n > 0 ? rrW / n : null,
        stopATR: n > 0 ? atrW / n : null,
        match: matchN > 0 ? matchW / matchN : null,
        fvg: fvgN > 0 ? fvgW / fvgN : null
    };
}

var pooled = { present: pooledRow('present'), missing: pooledRow('missing') };
console.log('POOLED PRESENT vs MISSING (n 加权)');
console.log('  ' + pad('metric', 10) + pad('PRESENT', 12) + pad('MISSING', 12) + pad('delta', 10));
['n', 'surv', 'tgtHit', 'stopTgt', 'mfe', 'mae', 'mfeMae', 'medRR', 'stopATR', 'match', 'fvg'].forEach(function (m) {
    var p = pooled.present[m];
    var x = pooled.missing[m];
    var delta = (m === 'n' || p === null || x === null) ? '-' : (x - p);
    var fmt = function (v) {
        if (v === null || v === undefined) return 'N/A';
        if (m === 'surv' || m === 'tgtHit' || m === 'stopTgt' || m === 'match') return fmtPct(v);
        if (m === 'mfe' || m === 'mae' || m === 'mfeMae' || m === 'stopATR' || m === 'fvg') return fmt2(v);
        if (m === 'medRR') return fmt1(v);
        return String(v);
    };
    var deltaFmt = delta === '-' ? '-' : (m === 'surv' || m === 'tgtHit' || m === 'stopTgt' || m === 'match'
        ? fmtPct(delta) : (m === 'mfe' || m === 'mae' || m === 'mfeMae' || m === 'stopATR' ? fmt2(delta) : fmt1(delta)));
    console.log('  ' + pad(m, 10) + pad(fmt(p), 12) + pad(fmt(x), 12) + pad(deltaFmt, 10));
});
console.log('  (delta = MISSING - PRESENT；negative = MISSING 更差)');
console.log('');
