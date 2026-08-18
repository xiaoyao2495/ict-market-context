/**
 * Phase 11T.2 — Stop V2 Pooled Report
 *
 * 读取三币种 backtest 日志中的 V2_POOL_ROW 行，产出：
 *   1. 三币并排矩阵（BTC / ETH / BNB）
 *   2. Pooled 矩阵（n 加权合并）
 *   3. Pooled Baseline vs V2 配对
 *
 * 用法：
 *   node scripts/stopV2Pooled.js /tmp/v2_btc.log /tmp/v2_eth.log /tmp/v2_bnb.log
 */
var fs = require('fs');

var LOGS = process.argv.slice(2);
if (LOGS.length === 0) {
    console.error('usage: node scripts/stopV2Pooled.js <btc.log> [eth.log] [bnb.log]');
    process.exit(1);
}

var KEYS = ['BASELINE', 'MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION',
    'MANIPULATION_INVALIDATION_NBUF', 'ACCUMULATION_INVALIDATION_NBUF'];
var PAIR_KEYS = ['MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION',
    'MANIPULATION_INVALIDATION_NBUF', 'ACCUMULATION_INVALIDATION_NBUF'];

function parseRows(logPath) {
    var text = fs.readFileSync(logPath, 'utf8');
    var line = text.split('\n').filter(function (l) { return l.indexOf('V2_POOL_ROW ') === 0; }).pop();
    if (!line) return null;
    var symbol = line.split(' ')[1];
    var payload = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    return { symbol: symbol, data: payload };
}

var sets = LOGS.map(parseRows).filter(Boolean);
if (sets.length === 0) {
    console.error('No V2_POOL_ROW found in logs.');
    process.exit(1);
}

function fmtPct(x) { return (x * 100).toFixed(0) + '%'; }
function fmtMed(x) { return x === null || x === undefined ? 'N/A' : x.toFixed(2); }
function fmtRR(x) { return x === null || x === undefined ? 'N/A' : x.toFixed(1); }
function pad(s, n) { s = String(s); while (s.length < n) { s = ' ' + s; } return s; }

// ---------- 1. 三币并排 ----------
console.log('STOP V2 MATRIX BY SYMBOL (Phase 11T.2 — shadow only, baseline frozen)');
console.log('  horizon 288 bars (24h @5m) | same target per plan | AMBIGUOUS counted as stop-out');
console.log('');
['surv', 'tgtHit', 'stopTgt', 'medATR', 'medRR', 'rrGe15'].forEach(function (metric) {
    console.log('-- ' + metric + ' --');
    console.log('  ' + pad('model', 34) + sets.map(function (s) { return pad(s.symbol, 10); }).join(''));
    KEYS.forEach(function (k) {
        var cells = sets.map(function (s) {
            var r = (s.data.matrix || {})[k];
            if (!r || !r.n) return pad('-', 10);
            if (metric === 'surv' || metric === 'tgtHit' || metric === 'rrGe15') return pad(fmtPct(r[metric]), 10);
            if (metric === 'stopTgt') return pad(r[metric] === null ? 'N/A' : fmtPct(r[metric]), 10);
            if (metric === 'medATR') return pad(fmtMed(r[metric]), 10);
            return pad(fmtRR(r[metric]), 10);
        });
        console.log('  ' + pad(k, 34) + cells.join(''));
    });
    console.log('');
});

// ---------- 2. Pooled ----------
function pooledMatrix() {
    var out = {};
    KEYS.forEach(function (k) {
        var n = 0, survN = 0, tgtN = 0, stopOutN = 0, sotN = 0, rrN = 0, rrGe15N = 0;
        var medATRw = 0, medRRw = 0;
        sets.forEach(function (s) {
            var r = (s.data.matrix || {})[k];
            if (!r || !r.n) return;
            n += r.n;
            survN += r.surv * r.n;
            tgtN += r.tgtHit * r.n;
            stopOutN += r.stopOutN || 0;
            sotN += (r.stopTgt !== null && r.stopTgt !== undefined ? r.stopTgt : 0) * (r.stopOutN || 0);
            rrN += r.rrN || 0;
            rrGe15N += r.rrGe15 * (r.rrN || r.n);
            if (r.medATR !== null && r.medATR !== undefined) medATRw += r.medATR * r.n;
            if (r.medRR !== null && r.medRR !== undefined) medRRw += r.medRR * r.n;
        });
        out[k] = {
            n: n,
            surv: n > 0 ? survN / n : 0,
            tgtHit: n > 0 ? tgtN / n : 0,
            stopTgt: stopOutN > 0 ? sotN / stopOutN : null,
            stopOutN: stopOutN,
            medATR: n > 0 ? medATRw / n : null,
            medRR: n > 0 ? medRRw / n : null,
            rrGe15: rrN > 0 ? rrGe15N / rrN : 0
        };
    });
    return out;
}

function pooledPairs() {
    var out = {};
    PAIR_KEYS.forEach(function (k) {
        var pairs = 0, baseW = 0, v2W = 0, rrGe15W = 0, gainW = 0;
        sets.forEach(function (s) {
            var r = (s.data.pairs || {})[k];
            if (!r || !r.pairs) return;
            pairs += r.pairs;
            baseW += (r.baseSurv !== undefined ? r.baseSurv : r.v2Surv - r.dSurv) * r.pairs;
            v2W += r.v2Surv * r.pairs;
            rrGe15W += r.rrGe15 * r.pairs;
            gainW += r.gainButRrLt15 * r.pairs;
        });
        out[k] = {
            pairs: pairs,
            baseSurv: pairs > 0 ? baseW / pairs : 0,
            v2Surv: pairs > 0 ? v2W / pairs : 0,
            dSurv: pairs > 0 ? (v2W - baseW) / pairs : 0,
            rrGe15: pairs > 0 ? rrGe15W / pairs : 0,
            gainButRrLt15: pairs > 0 ? gainW / pairs : 0
        };
    });
    return out;
}

var pooled = pooledMatrix();
var pooledPairsOut = pooledPairs();

console.log('POOLED RESULT (' + sets.map(function (s) { return s.symbol; }).join(' + ') + ')');
console.log('  ' + pad('model', 34) + pad('n', 4) + pad('surv', 6) + pad('tgtHit', 7) +
    pad('stop->tgt', 9) + pad('medATR', 7) + pad('medRR', 6) + pad('RR>=1.5', 8));
KEYS.forEach(function (k) {
    var r = pooled[k];
    if (!r || r.n === 0) {
        console.log('  ' + pad(k, 34) + '  (no candidates)');
        return;
    }
    console.log('  ' + pad(k, 34) + pad(r.n, 4) +
        pad(fmtPct(r.surv), 6) + pad(fmtPct(r.tgtHit), 7) +
        pad(r.stopTgt === null ? 'N/A' : fmtPct(r.stopTgt), 9) +
        pad(fmtMed(r.medATR), 7) + pad(fmtRR(r.medRR), 6) +
        pad(fmtPct(r.rrGe15), 8));
});
console.log('  (pooled medATR/medRR = n 加权平均（近似）; rates = n 加权精确计数合并)');
console.log('');

console.log('POOLED BASELINE vs V2 (paired, same target)');
console.log('  ' + pad('model', 34) + pad('pairs', 5) + pad('baseSurv', 8) + pad('v2Surv', 7) +
    pad('dSurv', 6) + pad('RR>=1.5', 8) + pad('gainButRR<1.5', 13));
PAIR_KEYS.forEach(function (k) {
    var r = pooledPairsOut[k];
    if (!r || r.pairs === 0) return;
    console.log('  ' + pad(k, 34) + pad(r.pairs, 5) +
        pad(fmtPct(r.baseSurv), 8) + pad(fmtPct(r.v2Surv), 7) +
        pad((r.dSurv >= 0 ? '+' : '') + fmtPct(r.dSurv), 6) +
        pad(fmtPct(r.rrGe15), 8) + pad(fmtPct(r.gainButRrLt15), 13));
});
console.log('');
