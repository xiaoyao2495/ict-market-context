/**
 * Phase 11L.15 — Live Prioritization Shadow Audit（运行入口）
 *
 * 用法：
 *   node scripts/livePrioritizationAudit.js                # 所有有 prioritization.jsonl 的 symbol
 *   node scripts/livePrioritizationAudit.js BTCUSDT        # 指定 symbol
 *
 * 读取 dataDir/<symbol>/prioritization.jsonl（live.js 写盘）+ candles.jsonl，
 * 按 priority 分组输出 forward：n / NearHit30m / NearHit1h / MFE1h% / MAE1h%。
 *
 * 目的：3-7 天真实 Live 后对比 PRIORITY_HIGH vs STANDARD_HIGH ——
 *   PRIORITY 明显更好且消息量舒服 → 正式钉钉只推 PRIORITY_HIGH；
 *   STANDARD 也不差 → significant 只是加分项，维持现状。
 *
 * 注意：本脚本只读审计 live 已写盘的记录（enabled=true 时 STANDARD 已被 suppress，
 * 属 Live Notification Experiment）；不改钉钉发送、不改 HIGH。11L.15a 起按 id 去重，
 * 且只计完整窗口样本（30m=6 根 / 1h=12 根，刚发生的 HIGH 不算 miss）。
 */
var fs = require('fs');
var path = require('path');
var CONFIG = require('../config/live.json');
var persistence = require('../live/persistence');
var livePrioritizationAudit = require('../stats/livePrioritizationAudit');

function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}
function pct(x) {
    if (x === null || x === undefined) return '-';
    return (x * 100).toFixed(1) + '%';
}

var dataDir = CONFIG.dataDir;
var wanted = process.argv[2];

function auditSymbol(symbol) {
    var dir = path.join(dataDir, symbol);
    var recFile = path.join(dir, 'prioritization.jsonl');
    var candleFile = path.join(dir, 'candles.jsonl');
    if (!fs.existsSync(recFile)) {
        console.log(symbol + ': 无 prioritization.jsonl（shadow 尚未记录）——跳过');
        return;
    }
    var records = [];
    try {
        fs.readFileSync(recFile, 'utf8').split('\n').forEach(function (line) {
            line = line.trim();
            if (!line) return;
            try { records.push(JSON.parse(line)); } catch (e) {}
        });
    } catch (e) {}
    var candles = persistence.loadCandles(candleFile).candles || [];
    var res = livePrioritizationAudit.auditLivePrioritization(records, candles);

    function printRow(label, acc) {
        var near30 = acc.nearCnt30m > 0 ? pct(acc.nearHit30m / acc.nearCnt30m) : '-';
        var near1h = acc.nearCnt1h > 0 ? pct(acc.nearHit1h / acc.nearCnt1h) : '-';
        var mfe = acc.mfeCnt > 0 ? (acc.mfeSum / acc.mfeCnt).toFixed(2) : '-';
        var mae = acc.mfeCnt > 0 ? (acc.maeSum / acc.mfeCnt).toFixed(2) : '-';
        console.log(pad(label, 20) + pad(acc.n, 6) + pad(near30, 12) + pad(near1h, 12) + pad(mfe, 9) + pad(mae, 9));
    }

    console.log('');
    console.log('LIVE PRIORITIZATION SHADOW (' + symbol + ')');
    console.log('记录 raw=' + res.rawRecords + ' unique=' + res.uniqueOpportunities +
        ' dup=' + res.duplicateRecords + '（按 id 去重，重复已剔除）' +
        (res.unmatched ? '  unmatched=' + res.unmatched + '（无 forward）' : ''));
    console.log('规则：HIGH + 48 窗口内 Significant Liquidity → PRIORITY_HIGH（钉钉）；否则 STANDARD_HIGH（只落日志）');
    console.log(pad('Group', 20) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
        pad('MFE1h%', 9) + pad('MAE1h%', 9));
    printRow('PRIORITY_HIGH', res.groups.PRIORITY_HIGH);
    printRow('STANDARD_HIGH', res.groups.STANDARD_HIGH);
    var p = res.groups.PRIORITY_HIGH;
    var s = res.groups.STANDARD_HIGH;
    if (p.n + s.n > 0) {
        console.log('');
        console.log('PRIORITY 占比: ' + p.n + '/' + (p.n + s.n) + ' (' + pct(p.n / (p.n + s.n)) + ')');
        if (p.n >= 10 && s.n >= 10) {
            var pd = p.nearCnt1h > 0 ? p.nearHit1h / p.nearCnt1h : 0;
            var sd = s.nearCnt1h > 0 ? s.nearHit1h / s.nearCnt1h : 0;
            console.log('NearHit1h 差: ' + ((pd - sd) * 100).toFixed(1) + 'pp（PRIORITY vs STANDARD）' +
                (pd > sd ? ' → PRIORITY 更优' : (pd < sd ? ' → STANDARD 更优，门槛需复查' : ' → 无差异')));
        } else {
            console.log('样本不足（各需 >=10 才有对比意义，当前 PRIORITY ' + p.n + ' / STANDARD ' + s.n + '）');
        }
    }
}

if (wanted) {
    auditSymbol(wanted);
} else {
    var dirs = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    dirs.filter(function (d) {
        return fs.existsSync(path.join(dataDir, d, 'prioritization.jsonl'));
    }).sort().forEach(auditSymbol);
}
