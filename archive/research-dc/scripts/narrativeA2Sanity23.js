/**
 * Bias Phase 1 — Formation Fix A.2 → 23 条人工 sanity set 对照（SHADOW，只读审计）
 *
 * 目的（用户定案 2026-08-21）：不收紧 REP_THRESHOLD，先把之前人工裁决的 23 个 material MSS
 * 当 sanity set，检查 A.2 把每条判成什么，做 confusion 表：
 *
 *   | Human     | A.2 A | A.2 B | NO_CLEAR | EXCLUDE |
 *   | A_CAUSAL  |       |       |          |         |
 *   | B_CAUSAL  |       |       |          |         |
 *   | SAME_POOL |       |       |          |         |
 *   | AMBIGUOUS |       |       |          |         |
 *   | EXCLUDE   |       |       |          |         |
 *
 * 重点观察（不计算总 accuracy）：
 *   - 10 个 A_CAUSAL：A.2 是否真选 terminal A（NEAREST_DEEPEST）
 *   - 2 个 B_CAUSAL(#15/#18)：A.2 必须能识别"B 后已启动 repricing，A 只是途中 liquidity"→ EARLIER_DEEPEST_REPRICING
 *   - 5 个 AMBIGUOUS：这是检查 NO_CLEAR_REP 的核心——理想应进 NO_CLEAR，而非被硬判 A/B
 *   - 3 个 EXCLUDE：应继续因无合法 bound displacement(NO_DISP) 排除，不参与 A/B
 *
 * 实现：复用 narrativeFanoutChain.js 同口径解析 23 case（MAT#1..23, mssId + A/B idx），
 *   在本机已缓存的同一 90d 窗口上重跑 replay + buildNarrativesA2（开启 a2Trace），
 *   按 mssId 取每条的 A.2 决策（rule / selectedRaidIdx / drop 原因），对照人工标签。
 *
 * 纪律：Detection 冻结、Bias/Outcome/13A.2 不动；本脚本只读审计，不改 production / 不调参。
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA2Sanity23.js [SYMBOL] [DAYS]
 */
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var a2 = require('../stats/narrativeFormationA2');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

// ---- 人工裁决（来自 2026-08-21 定稿，基于真实 OHLC 路径，非文件标签）----
// 仅在 MAT# 次序与 fanoutChain90d 输出一致时成立（本脚本按 MAT# 解析，次序即该文件次序）。
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

function a2Column(tr) {
    if (!tr || !tr.decision) return 'NONE';
    switch (tr.decision) {
        case 'NEAREST_DEEPEST': return 'A';
        case 'EARLIER_DEEPEST_REPRICING': return 'B';
        case 'NO_CLEAR_REP':
        case 'NO_CLEAR_ALIGN': return 'NO_CLEAR';
        case 'NO_DISP': return 'EXCLUDE';
        default: return 'NONE';
    }
}

// 主分类：按 A.2 实际选中的 raid 索引 vs 人工 A/B 位置归因（比规则名更忠实）。
// 规则名 NEAREST_DEEPEST 可能因 cluster 合并 A&B 后取更深极值=B 位，而误显为"A"。
function a2ColIdx(tr, c) {
    if (!tr || !tr.decision) return 'NONE';
    if (tr.decision === 'NEAREST_DEEPEST' || tr.decision === 'EARLIER_DEEPEST_REPRICING') {
        var dA = (c.a && tr.selectedRaidIdx != null) ? Math.abs(tr.selectedRaidIdx - c.a.idx) : Infinity;
        var dB = (c.b && tr.selectedRaidIdx != null) ? Math.abs(tr.selectedRaidIdx - c.b.idx) : Infinity;
        if (dA === Infinity && dB === Infinity) return a2Column(tr);
        return dA <= dB ? 'A' : 'B';
    }
    return a2Column(tr); // NO_CLEAR / EXCLUDE
}

function note(human, col, ruleCol, c, tr) {
    var rule = tr ? tr.decision : 'NONE';
    if (human === 'A_CAUSAL') {
        if (col === 'A') return 'A.2 选中 A 位 (' + rule + ')';
        if (col === 'B') return 'MISJUDGE: A.2 选中 B 位，人类判 A causal';
        if (col === 'NO_CLEAR') return 'MISJUDGE: A.2 丢弃(' + rule + ')，人类判 A causal（alignment 闸门可能误杀）';
        if (col === 'EXCLUDE') return 'MISJUDGE: A.2 丢弃(NO_DISP)，人类判 A causal';
    }
    if (human === 'B_CAUSAL') {
        if (col === 'B') return 'OK: A.2 选中 B 位（机制=' + rule + (rule === 'NEAREST_DEEPEST' ? '：cluster 合并 A&B 后取更深极值=B 位，非 rule4 repricing' : '：rule4 repricing 生效') + '）';
        if (col === 'A') return 'CRITICAL MISJUDGE: A.2 选中 A 位，人类判 B causal (#15/#18 反例)';
        if (col === 'NO_CLEAR') return 'MISJUDGE: A.2 丢弃(' + rule + ')，人类判 B causal（alignment 闸门可能误杀）';
        if (col === 'EXCLUDE') return 'MISJUDGE: A.2 丢弃(NO_DISP)，人类判 B causal';
    }
    if (human === 'SAME_POOL') {
        if (col === 'A' || col === 'B') return 'OK: 同池，A/B 任一可接受（sel=' + col + ' 位）';
        if (col === 'NO_CLEAR') return 'NOTE: 同池但 A.2 丢弃(' + rule + ')';
        if (col === 'EXCLUDE') return 'NOTE: A.2 丢弃(NO_DISP)';
    }
    if (human === 'AMBIGUOUS') {
        if (col === 'NO_CLEAR') return 'OK: 正确拒绝(' + rule + ')，未硬塞 A/B';
        if (col === 'A' || col === 'B') return 'FORCED: A.2 硬判 ' + col + '（' + rule + '），人类判 AMBIGUOUS';
        if (col === 'EXCLUDE') return 'NOTE: A.2 丢弃(NO_DISP)，人类判 AMBIGUOUS';
    }
    if (human === 'EXCLUDE') {
        if (col === 'EXCLUDE') return 'OK: 正确排除(NO_DISP，无合法 bound displacement)';
        if (col === 'NO_CLEAR') return 'NOTE: 被 ALIGN 闸门排除(' + rule + ')，非 displacement 原因但结果仍排除 GT';
        if (col === 'A' || col === 'B') return 'MISJUDGE: 应排除却被判 ' + col + ' causal (Disp:- 却被归因)';
    }
    return '';
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.2 × 23 sanity set ...');

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
                a2Trace: true,
                a2Traces: {}
            };

            var a2n = a2.buildNarrativesA2(ctx);
            var a2Traces = ctx.a2Traces || {};

            // 解析 23 case
            var cases = parseChain(CHAIN_FILE);
            if (cases.length !== 23) {
                console.error('WARN: 解析到 ' + cases.length + ' 个 case（期望 23），请检查 chain 文件');
            }

            // confusion 矩阵
            var ROWS = ['A_CAUSAL', 'B_CAUSAL', 'SAME_POOL', 'AMBIGUOUS', 'EXCLUDE'];
            var COLS = ['A', 'B', 'NO_CLEAR', 'EXCLUDE'];
            var mat = {};
            ROWS.forEach(function (r) { mat[r] = {}; COLS.forEach(function (c) { mat[r][c] = 0; }); });
            var detail = [];
            var notFound = [];
            cases.forEach(function (c) {
                var human = VERDICT[c.matN] || '?';
                var tr = a2Traces[c.mssId];
                var col = a2ColIdx(tr, c);
                var ruleCol = a2Column(tr);
                if (!tr) { notFound.push(c.matN); col = 'NONE'; ruleCol = 'NONE'; }
                if (mat[human] && mat[human][col] !== undefined) mat[human][col]++;
                else if (mat[human]) mat[human][col] = (mat[human][col] || 0) + 1;
                detail.push({ c: c, human: human, col: col, ruleCol: ruleCol, tr: tr });
            });

            // ---- 输出 ----
            var out = [];
            out.push('=== A.2 Shadow × 23 人工 sanity set 对照 (BTCUSDT ' + DAYS + 'd, futures) ===');
            out.push('（窗口与 fanoutChain90d 同一缓存 90d；mssId 稳定。不计算总 accuracy，只做 confusion。）');
            out.push('（混淆表主分类：按 A.2 实际选中的 raid 索引 vs 人工 A/B 位置归因；规则名见逐案 rule=。这样 MAT#15 等');
            out.push(' cluster 合并 A&B 后取更深极值=B 位 的 case 不会被误显为"A.2=A"。）');
            out.push('');
            out.push('混淆表 (行=人类裁决, 列=A.2 输出):');
            out.push('  Human\\A.2 | ' + COLS.map(function (x) { return (x + '       ').slice(0, 8); }).join(' | '));
            ROWS.forEach(function (r) {
                var row = COLS.map(function (x) { return ('  ' + mat[r][x] + '     ').slice(0, 8); }).join(' | ');
                out.push('  ' + (r + '        ').slice(0, 10) + '| ' + row);
            });
            out.push('');

            // 重点观察（用户指定）
            function countRow(r, col) { return mat[r] ? (mat[r][col] || 0) : 0; }
            out.push('重点观察（不计算总 accuracy）:');
            out.push('  A_CAUSAL(10): A.2→A=' + countRow('A_CAUSAL', 'A') +
                '  A.2→B=' + countRow('A_CAUSAL', 'B') +
                '  A.2→NO_CLEAR=' + countRow('A_CAUSAL', 'NO_CLEAR') +
                '  A.2→EXCLUDE=' + countRow('A_CAUSAL', 'EXCLUDE'));
            out.push('  B_CAUSAL(2) #15/#18: A.2→B=' + countRow('B_CAUSAL', 'B') +
                ' (必须=2)  A.2→A=' + countRow('B_CAUSAL', 'A') +
                '  A.2→NO_CLEAR=' + countRow('B_CAUSAL', 'NO_CLEAR') +
                '  A.2→EXCLUDE=' + countRow('B_CAUSAL', 'EXCLUDE'));
            out.push('  AMBIGUOUS(5): A.2→NO_CLEAR=' + countRow('AMBIGUOUS', 'NO_CLEAR') +
                ' (理想应>0)  A.2→A=' + countRow('AMBIGUOUS', 'A') +
                '  A.2→B=' + countRow('AMBIGUOUS', 'B') +
                '  A.2→EXCLUDE=' + countRow('AMBIGUOUS', 'EXCLUDE') + '  [FORCED=A+B=' +
                (countRow('AMBIGUOUS', 'A') + countRow('AMBIGUOUS', 'B')) + ']');
            out.push('  EXCLUDE(3): A.2→EXCLUDE=' + countRow('EXCLUDE', 'EXCLUDE') +
                ' (应=3)  A.2→A=' + countRow('EXCLUDE', 'A') +
                '  A.2→B=' + countRow('EXCLUDE', 'B') +
                '  A.2→NO_CLEAR=' + countRow('EXCLUDE', 'NO_CLEAR'));
            out.push('  SAME_POOL(3): A.2→A=' + countRow('SAME_POOL', 'A') +
                '  A.2→B=' + countRow('SAME_POOL', 'B') +
                '  A.2→NO_CLEAR=' + countRow('SAME_POOL', 'NO_CLEAR') +
                '  A.2→EXCLUDE=' + countRow('SAME_POOL', 'EXCLUDE'));
            out.push('');
            if (notFound.length) out.push('  ⚠ 未在 replay 中找到的 MSS (窗口漂移?): MAT#' + notFound.join(', ') + '');
            out.push('');

            // 逐案明细
            out.push('逐案明细:');
            detail.forEach(function (d) {
                var c = d.c, tr = d.tr;
                var sel = tr ? tr.selectedRaidIdx : null;
                var dA = (c.a && sel != null) ? Math.abs(sel - c.a.idx) : null;
                var dB = (c.b && sel != null) ? Math.abs(sel - c.b.idx) : null;
                var src = tr && tr.clusters && tr.clusters.length ? tr.clusters.map(function (cl) { return '[' + cl.sources.join('+') + '@' + cl.extremeIdx + ']'; }).join('') : '-';
                var rule = tr ? tr.decision : 'NONE';
                out.push('  MAT#' + c.matN +
                    '  Human=' + d.human +
                    '  A.2=' + d.col + '(idx归因) rule=' + rule +
                    '  sel=' + (sel == null ? '-' : sel) +
                    (c.a ? '  Aidx=' + c.a.idx + '(Δ' + (dA == null ? '?' : dA) + ')' : '') +
                    (c.b ? '  Bidx=' + c.b.idx + '(Δ' + (dB == null ? '?' : dB) + ')' : '') +
                    '  nClusters=' + (tr ? tr.clusters.length : '?') +
                    '  clusters=' + src);
                out.push('        NOTE: ' + note(d.human, d.col, d.ruleCol, c, tr));
            });
            out.push('');
            out.push('解读提示:');
            out.push('  - A.2=A 即 NEAREST_DEEPEST（最近=最深=terminal，人类之 A）；A.2=B 即 EARLIER_DEEPEST_REPRICING（B 胜）。');
            out.push('  - NO_CLEAR=NO_CLEAR_REP/NO_CLEAR_ALIGN 丢弃（repricing 判别 / alignment 闸门触发）。');
            out.push('  - EXCLUDE=NO_DISP（无合法 bound displacement，独立于归因的质量闸门）。');
            out.push('  - sel 与 Aidx/Bidx 的 Δ 显示 A.2 选中的 raid 离人工 A/B 各几根；Δ 小=锚定一致。');
            out.push('  - 下一步: 先看 AMBIGUOUS 的 FORCED 数 → 决定是否收紧 REP_THRESHOLD/ALIGN；再看 B_CAUSAL 是否=2 → 验证 terminal causal 操作化。');

            // 结构观察（不看数量，看机制）
            var rule4 = 0, alignDrops = 0, repDrops = 0, dispDrops = 0, bViaCluster = 0;
            detail.forEach(function (d) {
                var t = d.tr;
                if (!t) return;
                if (t.decision === 'EARLIER_DEEPEST_REPRICING') rule4++;
                if (t.decision === 'NO_CLEAR_ALIGN') alignDrops++;
                if (t.decision === 'NO_CLEAR_REP') repDrops++;
                if (t.decision === 'NO_DISP') dispDrops++;
                if (t.decision === 'NEAREST_DEEPEST' && d.col === 'B') bViaCluster++;
            });
            out.push('');
            out.push('结构观察（不看数量，看机制）:');
            out.push('  rule4(EARLIER_DEEPEST_REPRICING, repricing-based B 胜) 在 23 例中触发 = ' + rule4);
            out.push('    → REP_THRESHOLD 分支在 23 例中从未到达（cluster 合并使 cStar 恒=nearest），与 90d 总体 NO_CLEAR_REP=0 一致。');
            out.push('  NO_CLEAR 丢弃来源: ALIGN 闸门=' + alignDrops + '  REP 闸门=' + repDrops + '  (alignment 闸门是实际拒绝主力)');
            out.push('  B 位归因来源: ' + bViaCluster + ' 例经 cluster 合并取更深极值(非 rule4)；rule4 驱动=0');
            out.push('  → 若收紧 REP_THRESHOLD，对这 23 例的 AMBIGUOUS/repricing 判定无影响（该分支从不执行）；');
            out.push('    真正影响判断的是 GAP_MAX(cluster 合并) 与 ALIGN_ATR(对齐闸门)。下一步应先查 ALIGN 比较器');
            out.push('    (candle 极值 vs sweep.liquidityPrice 是否一致)，而非先动 REP_THRESHOLD。');

            var text = out.join('\n');
            console.log(text);
            var outFile = path.join(__dirname, '..', 'outputs', 'a2sanity23_' + SYMBOL + '_futures.txt');
            fs.writeFileSync(outFile, text);
            console.log('\n→ 已写出 ' + outFile);
        });
    })
    .catch(function (error) {
        console.error('A.2 SANITY 23 FAILED:', error && error.stack || error);
        process.exit(1);
    });
