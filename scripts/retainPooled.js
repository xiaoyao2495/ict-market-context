/**
 * Phase 11T.4 — Snapshot Retention Shadow Pooled Report
 * 解析三币日志 RET_POOL_ROW → 三币并排 + pooled（n 加权）
 * 用法：node scripts/retainPooled.js /tmp/v4_btc_on.log /tmp/v4_eth_on.log /tmp/v4_bnb_on.log
 */
var fs = require('fs');

var LOGS = process.argv.slice(2);
if (LOGS.length === 0) {
    console.error('usage: node scripts/retainPooled.js <btc.log> [eth.log] [bnb.log]');
    process.exit(1);
}

function parseRows(logPath) {
    var text = fs.readFileSync(logPath, 'utf8');
    var line = text.split('\n').filter(function (l) { return l.indexOf('RET_POOL_ROW ') === 0; }).pop();
    if (!line) return null;
    var symbol = line.split(' ')[1];
    var payload = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
    return { symbol: symbol, data: payload };
}

var sets = LOGS.map(parseRows).filter(Boolean);
if (sets.length === 0) {
    console.error('No RET_POOL_ROW found in logs.');
    process.exit(1);
}

function fmtPct(x) { return x === null || x === undefined ? 'N/A' : (x * 100).toFixed(0) + '%'; }
function fmt2(x) { return x === null || x === undefined ? 'N/A' : x.toFixed(2); }
function pad(s, n) { s = String(s); while (s.length < n) { s = ' ' + s; } return s; }

console.log('RETAIN SHADOW BY SYMBOL (Phase 11T.4 — retention ON, baseline frozen)');
console.log('  ' + pad('metric', 16) + sets.map(function (s) { return pad(s.symbol, 14); }).join(''));
['medAtr', 'stopTgt', 'tgtHit', 'rrGe15', 'missing'].forEach(function (m) {
    var cells = sets.map(function (s) {
        var d = s.data;
        var live = d.live[m];
        var retain = d.retain[m];
        var fmt = (m === 'medAtr') ? fmt2 : fmtPct;
        return pad(fmt(live) + ' → ' + fmt(retain), 14);
    });
    console.log('  ' + pad(m, 16) + cells.join(''));
});
console.log('  ' + pad('watchLost挽回', 16) + sets.map(function (s) {
    return pad(s.data.watchPresentLost + '/' + s.data.n + ' (' + (s.data.watchPresentLost / s.data.n * 100).toFixed(1) + '%)', 14);
}).join(''));
console.log('');

// pooled（n 加权）
var n = 0, liveAtrW = 0, retAtrW = 0, liveSotN = 0, liveSotT = 0, retSotN = 0, retSotT = 0;
var liveTgtN = 0, retTgtN = 0, liveRrN = 0, retRrN = 0, liveMissN = 0, retMissN = 0, lostN = 0;
sets.forEach(function (s) {
    var d = s.data;
    n += d.n;
    liveAtrW += d.live.medAtr * d.n;
    retAtrW += d.retain.medAtr * d.n;
    liveSotN += d.n; liveSotT += (d.live.stopTgt || 0) * d.n;
    retSotN += d.n; retSotT += (d.retain.stopTgt || 0) * d.n;
    liveTgtN += d.live.tgtHit * d.n;
    retTgtN += d.retain.tgtHit * d.n;
    liveRrN += d.live.rrGe15 * d.n;
    retRrN += d.retain.rrGe15 * d.n;
    liveMissN += d.live.missing * d.n;
    retMissN += d.retain.missing * d.n;
    lostN += d.watchPresentLost;
});

console.log('POOLED RETAIN (n=' + n + ', n 加权)');
console.log('  ' + pad('metric', 16) + pad('LIVE', 10) + pad('RETAIN', 10) + pad('delta', 8));
function row(label, live, retain, isAtr) {
    var f = isAtr ? fmt2 : fmtPct;
    var d = isAtr ? retain - live : retain - live;
    var dFmt = isAtr ? (d >= 0 ? '+' : '') + d.toFixed(2) : (d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%';
    console.log('  ' + pad(label, 16) + pad(f(live), 10) + pad(f(retain), 10) + pad(dFmt, 8));
}
row('med stopATR', liveAtrW / n, retAtrW / n, true);
row('stop->target', liveSotT / liveSotN, retSotT / retSotN, false);
row('targetHit', liveTgtN / n, retTgtN / n, false);
row('RR>=1.5', liveRrN / n, retRrN / n, false);
row('boundary missing', liveMissN / n, retMissN / n, false);
console.log('  LOST_AFTER_WATCH 挽回（watch-present 且 live-missing）：' + lostN + ' / ' + n + ' (' + (lostN / n * 100).toFixed(1) + '%)');
console.log('');
