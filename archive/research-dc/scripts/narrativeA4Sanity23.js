/**
 * Bias Phase 1 — Formation Fix A.4 → 23 条人工 sanity set 对照（SHADOW，只读审计）
 *
 * 目的（用户冻结路线 2026-08-21）：把已冻结的 A.4 Terminal Manipulation Episode 定义操作化为
 * Shadow，并在同一 23 条人工 sanity set 上验证。验收标准（用户定）：
 *   能确定的正确归因；不能确定的主动 NO_CLEAR；绝不为了 coverage 污染 Ground Truth。
 *   不追求 23/23 自动命中。
 *
 * 混淆表（行=人类裁决，列=A.4 输出）：
 *   | Human     | A.4 A | A.4 B | NO_CLEAR | EXCLUDE |
 *
 * 重点观察：
 *   - 10 A_CAUSAL：A.4 是否真选 terminal A
 *   - 2 B_CAUSAL(#15/#18)：A.4 必须识别"B 启动 repricing，A 途中" → 选 B
 *   - 5 AMBIGUOUS：应进 NO_CLEAR_CAUSAL_RAID（定义 ⑤/⑥），非硬判 A/B
 *   - 3 EXCLUDE：应因无 bound displacement(NO_DISP) 排除，不参与 causal
 *
 * 实现：复用 narrativeA2Sanity23.js 同 replay 管线 + chain 解析 + confusion 逻辑，
 *   仅把 buildNarrativesA2 换成 buildNarrativesA4（a4Trace）。
 *
 * 纪律：Detection 冻结、Bias/Outcome/13A.2 不动；本脚本只读审计，不改 production / 不调参。
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA4Sanity23.js [SYMBOL] [DAYS]
 */
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var a4 = require('../stats/narrativeFormationA4');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

// ---- 人工裁决（来自 2026-08-21 定稿，基于真实 OHLC 路径）----
var VERDICT = {
    1: 'A_CAUSAL', 2: 'A_CAUSAL', 3: 'AMBIGUOUS', 4: 'AMBIGUOUS', 5: 'A_CAUSAL',
    6: 'A_CAUSAL', 7: 'EXCLUDE', 8: 'A_CAUSAL', 9: 'SAME_POOL', 10: 'A_CAUSAL',
    11: 'AMBIGUOUS', 12: 'AMBIGUOUS', 13: 'A_CAUSAL', 14: 'AMBIGUOUS', 15: 'B_CAUSAL',
    16: 'A_CAUSAL', 17: 'SAME_POOL', 18: 'B_CAUSAL', 19: 'SAME_POOL', 20: 'EXCLUDE',
    21: 'EXCLUDE', 22: 'A_CAUSAL', 23: 'A_CAUSAL'
};

// ---- 解析 chain 文件：23 case 的 mssId + A/B idx ----
var CHAIN_FILE = path.join(__dirname, '..', 'outputs', 'fanoutChain90d_' + SYMBOL + '_futures.txt');
function parseChain(file) {
    var txt = fs.readFileSync(file, 'utf8');
    var lines = txt.split('\n');
    var cases = [];
    for (var i = 0; i < lines.length; i++) {
        var h = lines[i].match(/^★MAT#(\d+)\s+MSS#(\S+)\s+(BULLISH|BEARISH)/);
        if (!h) continue;
        var matN = +h[1], mssId = h[2], D = h[3];
        var aLine = null, bLine = null;
        for (var j = i + 1; j < Math.min(i + 8, lines.length); j++) {
            if (!aLine) {
                var am = lines[j].match(/A\(nearest[^:]*:\s*(\S+)\s+@([\d.]+)\s+idx=(\d+)/);
                if (am) aLine = { type: am[1], px: +am[2], idx: +am[3] };
            }
            if (!bLine) {
                var bm = lines[j].match(/B\(structural[^:]*:\s*(\S+)\s+@([\d.]+)\s+idx=(\d+)/);
                if (bm) bLine = { type: bm[1], px: +bm[2], idx: +bm[3] };
            }
        }
        cases.push({ matN: matN, mssId: mssId, D: D, a: aLine, b: bLine });
    }
    return cases;
}

// A.4 主分类：按实际选中 raid 索引 vs 人工 A/B 位置归因（比规则名更忠实）。
function a4Column(tr, c) {
    if (!tr || !tr.decision) return 'NONE';
    if (tr.decision === 'TERMINAL_MANIPULATION_EPISODE') {
        var dA = (c.a && tr.selectedRaidIdx != null) ? Math.abs(tr.selectedRaidIdx - c.a.idx) : Infinity;
        var dB = (c.b && tr.selectedRaidIdx != null) ? Math.abs(tr.selectedRaidIdx - c.b.idx) : Infinity;
        if (dA === Infinity && dB === Infinity) return 'A';
        return dA <= dB ? 'A' : 'B';
    }
    if (tr.decision === 'NO_CLEAR_CAUSAL_RAID') return 'NO_CLEAR';
    if (tr.decision === 'NO_DISP') return 'EXCLUDE';
    return 'NONE';
}

function note(human, col, rule, c, tr) {
    if (human === 'A_CAUSAL') {
        if (col === 'A') return 'OK: A.4 选中 A 位 (' + rule + ')';
        if (col === 'B') return 'MISJUDGE: A.4 选中 B 位，人类判 A causal';
        if (col === 'NO_CLEAR') return 'MISJUDGE: A.4 丢弃(' + rule + ')，人类判 A causal';
        if (col === 'EXCLUDE') return 'MISJUDGE: A.4 丢弃(NO_DISP)，人类判 A causal';
    }
    if (human === 'B_CAUSAL') {
        if (col === 'B') return 'OK: A.4 选中 B 位（' + rule + '：episode 内最早启动 repricing 的 interaction）';
        if (col === 'A') return 'CRITICAL MISJUDGE: A.4 选中 A 位，人类判 B causal (#15/#18 反例)';
        if (col === 'NO_CLEAR') return 'MISJUDGE: A.4 丢弃(' + rule + ')，人类判 B causal';
        if (col === 'EXCLUDE') return 'MISJUDGE: A.4 丢弃(NO_DISP)，人类判 B causal';
    }
    if (human === 'SAME_POOL') {
        if (col === 'A' || col === 'B') return 'OK: 同池，A/B 任一可接受（sel=' + col + ' 位）';
        if (col === 'NO_CLEAR') return 'NOTE: 同池但 A.4 丢弃(' + rule + ')';
        if (col === 'EXCLUDE') return 'NOTE: A.4 丢弃(NO_DISP)';
    }
    if (human === 'AMBIGUOUS') {
        if (col === 'NO_CLEAR') return 'OK: 正确拒绝(' + rule + ')，未硬塞 A/B（定义 ⑤/⑥）';
        if (col === 'A' || col === 'B') return 'FORCED: A.4 硬判 ' + col + '（' + rule + '），人类判 AMBIGUOUS';
        if (col === 'EXCLUDE') return 'NOTE: A.4 丢弃(NO_DISP)，人类判 AMBIGUOUS';
    }
    if (human === 'EXCLUDE') {
        if (col === 'EXCLUDE') return 'OK: 正确排除(NO_DISP，无合法 bound displacement)';
        if (col === 'NO_CLEAR') return 'NOTE: 被 NO_CLEAR 排除(' + rule + ')，非 displacement 原因但结果仍排除 GT';
        if (col === 'A' || col === 'B') return 'MISJUDGE: 应排除却被判 ' + col + ' causal (Disp:- 却被归因)';
    }
    return '';
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.4 × 23 sanity set ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
        var t0 = Date.now();
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: SNAPSHOT_INTERVAL,
            logEvery: 999999
        }).then(function (result) {
            console.log('Replay 完成 (' + Math.round((Date.now() - t0) / 1000) + 's)');

            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );
            var ctx = {
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                swings: result.swings || [],
                legByDispId: legByDispId,
                candles5m: candles5m,
                a4Trace: true,
                a4Traces: {}
            };

            var a4n = a4.buildNarrativesA4(ctx);
            var a4Traces = ctx.a4Traces || {};

            var cases = parseChain(CHAIN_FILE);
            if (cases.length !== 23) {
                console.error('WARN: 解析到 ' + cases.length + ' 个 case（期望 23），请检查 chain 文件');
            }

            var ROWS = ['A_CAUSAL', 'B_CAUSAL', 'SAME_POOL', 'AMBIGUOUS', 'EXCLUDE'];
            var COLS = ['A', 'B', 'NO_CLEAR', 'EXCLUDE'];
            var mat = {};
            ROWS.forEach(function (r) { mat[r] = {}; COLS.forEach(function (c) { mat[r][c] = 0; }); });
            var detail = [];
            var notFound = [];
            cases.forEach(function (c) {
                var human = VERDICT[c.matN] || '?';
                var tr = a4Traces[c.mssId];
                var col = a4Column(tr, c);
                if (!tr) { notFound.push(c.matN); col = 'NONE'; }
                if (mat[human] && mat[human][col] !== undefined) mat[human][col]++;
                else if (mat[human]) mat[human][col] = (mat[human][col] || 0) + 1;
                detail.push({ c: c, human: human, col: col, tr: tr });
            });

            var out = [];
            out.push('=== A.4 Shadow × 23 人工 sanity set 对照 (BTCUSDT ' + DAYS + 'd, futures) ===');
            out.push('（窗口与 fanoutChain90d 同一缓存 90d；mssId 稳定。不计算总 accuracy，只做 confusion。）');
            out.push('（混淆表主分类：按 A.4 实际选中的 raid 索引 vs 人工 A/B 位置归因；规则名见逐案 rule=。）');
            out.push('');
            out.push('混淆表 (行=人类裁决, 列=A.4 输出):');
            out.push('  Human\\A.4 | ' + COLS.map(function (x) { return (x + '       ').slice(0, 8); }).join(' | '));
            ROWS.forEach(function (r) {
                var row = COLS.map(function (x) { return ('  ' + mat[r][x] + '     ').slice(0, 8); }).join(' | ');
                out.push('  ' + (r + '        ').slice(0, 10) + '| ' + row);
            });
            out.push('');

            function countRow(r, col) { return mat[r] ? (mat[r][col] || 0) : 0; }
            out.push('重点观察（验收标准：能确定才归因，不能确定主动 NO_CLEAR，不污染 GT）:');
            out.push('  A_CAUSAL(10): A.4→A=' + countRow('A_CAUSAL', 'A') +
                '  A.4→B=' + countRow('A_CAUSAL', 'B') +
                '  A.4→NO_CLEAR=' + countRow('A_CAUSAL', 'NO_CLEAR') +
                '  A.4→EXCLUDE=' + countRow('A_CAUSAL', 'EXCLUDE'));
            out.push('  B_CAUSAL(2) #15/#18: A.4→B=' + countRow('B_CAUSAL', 'B') +
                ' (应=2)  A.4→A=' + countRow('B_CAUSAL', 'A') +
                '  A.4→NO_CLEAR=' + countRow('B_CAUSAL', 'NO_CLEAR') +
                '  A.4→EXCLUDE=' + countRow('B_CAUSAL', 'EXCLUDE'));
            out.push('  AMBIGUOUS(5): A.4→NO_CLEAR=' + countRow('AMBIGUOUS', 'NO_CLEAR') +
                ' (理想应>0)  A.4→A=' + countRow('AMBIGUOUS', 'A') +
                '  A.4→B=' + countRow('AMBIGUOUS', 'B') +
                '  A.4→EXCLUDE=' + countRow('AMBIGUOUS', 'EXCLUDE') + '  [FORCED=A+B=' +
                (countRow('AMBIGUOUS', 'A') + countRow('AMBIGUOUS', 'B')) + ']');
            out.push('  EXCLUDE(3): A.4→EXCLUDE=' + countRow('EXCLUDE', 'EXCLUDE') +
                ' (应=3)  A.4→A=' + countRow('EXCLUDE', 'A') +
                '  A.4→B=' + countRow('EXCLUDE', 'B') +
                '  A.4→NO_CLEAR=' + countRow('EXCLUDE', 'NO_CLEAR'));
            out.push('  SAME_POOL(3): A.4→A=' + countRow('SAME_POOL', 'A') +
                '  A.4→B=' + countRow('SAME_POOL', 'B') +
                '  A.4→NO_CLEAR=' + countRow('SAME_POOL', 'NO_CLEAR') +
                '  A.4→EXCLUDE=' + countRow('SAME_POOL', 'EXCLUDE'));
            out.push('');
            out.push('（窗口与 fanoutChain90d 同一缓存 90d；mssId 稳定。不计算总 accuracy，只做 confusion。）');
            out.push('');

            // 逐案明细
            out.push('逐案明细:');
            detail.forEach(function (d) {
                var c = d.c, tr = d.tr;
                var rule = tr ? tr.decision : 'NONE';
                var sel = tr ? tr.selectedRaidIdx : null;
                var src = tr && tr.episode ? tr.episode.sources.join('/') : '?';
                var dA = (c.a && sel != null) ? Math.abs(sel - c.a.idx) : null;
                var dB = (c.b && sel != null) ? Math.abs(sel - c.b.idx) : null;
                out.push('  MAT#' + c.matN +
                    '  Human=' + d.human +
                    '  A.4=' + d.col + '(' + rule + ')' +
                    '  sel=' + (sel == null ? '-' : sel) +
                    (c.a ? '  Aidx=' + c.a.idx + '(Δ' + (dA == null ? '?' : dA) + ')' : '') +
                    (c.b ? '  Bidx=' + c.b.idx + '(Δ' + (dB == null ? '?' : dB) + ')' : '') +
                    '  ep=' + (tr && tr.episodeFirstIdx != null ? (tr.episodeFirstIdx + '..' + tr.episodeLastIdx) : '?') +
                    '  sources=' + src);
                out.push('        NOTE: ' + note(d.human, d.col, rule, c, tr));
                if (tr && tr.pricePathVeto) {
                    out.push('        pricePathVeto=' + tr.pricePathVeto +
                        '  actReverseInEp=' + (tr.actualReverseInEpisode == null ? '-' : tr.actualReverseInEpisode) +
                        '  deepestReg=' + (tr.deepestRegisteredExtreme == null ? '-' : tr.deepestRegisteredExtreme) +
                        '  repStartIdx=' + (tr.repricingStartIdx == null ? '-' : tr.repricingStartIdx) +
                        '  certaintyGate=' + (tr.certaintyGate == null ? '-' : tr.certaintyGate));
                }
            });
            out.push('');
            if (notFound.length) {
                out.push('WARN: 未找到 trace 的 mssId: MAT#' + notFound.join(', MAT#'));
            } else {
                out.push('全部 23/23 MSS id 命中 trace（窗口与 chain 文件一致）。');
            }

            var text = out.join('\n');
            var outFile = path.join(__dirname, '..', 'outputs', 'a4sanity23_' + SYMBOL + '_futures.txt');
            fs.writeFileSync(outFile, text);
            console.log(text);
            console.log('\n[written] ' + outFile);
        });
    })
    .catch(function (err) {
        console.error('FATAL', err);
        process.exit(1);
    });
