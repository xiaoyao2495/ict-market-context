/**
 * A.2 Sanity Fix A.3 — MAT#4 + MAT#18 逐案 decision trace 打穿（SHADOW，只读审计，不调参）
 *
 * 用户定案 2026-08-21：只审这两条边界病例，不打任何参数（ALIGN_ATR/GAP_MAX/REP_THRESHOLD 冻结）。
 * 目标：把 A.2 对这两条 MSS 的每一步计算原样还原，定位误判根因。
 *
 *   MAT#4  : Human=AMBIGUOUS, A.2=A(NEAREST_DEEPEST)
 *            → 唯一"机器过度自信"病例。要回答：为何人眼认为无法区分，机器却判 terminal A 明确？
 *   MAT#18 : Human=B_CAUSAL, A.2=NO_CLEAR_ALIGN
 *            → ALIGN gate 是否在误杀真正的 causal raid(B)？还是数据语义/cluster extreme 取错？
 *
 * 打穿的计算链（忠实复刻 stats/narrativeFormationA2.js，仅打印，不改动任何常量/逻辑）：
 *   1. eligible sweeps（同方向, prevSameDirMss < bar < MSS）
 *   2. cluster 归并（gap ≤ GAP_MAX=12；同 bar 自动合并）；每 cluster 的 members + extreme + extremeIdx
 *   3. cStar = 最深层 cluster（extreme 最极端）
 *   4. alignment 闸门：atr(Mi,14) → actualReverseLevel[extremeIdx..Mi] → |actualReverse − cStar.extreme| > ALIGN_ATR·atr ?
 *   5. 【盲点暴露】prevMssIdx..Mi 全窗最深 wick（含 cStar.extremeIdx 之前），看是否有"未注册更深极值"
 *   6. 人类 A/B idx + verdict 对照
 *
 * 纪律：Detection 冻结；Bias/Outcome/13A.2 不动；不调参。本脚本只读审计。
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA2Dissect.js [SYMBOL] [DAYS]
 */
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var a2 = require('../stats/narrativeFormationA2');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

// 目标 MSS（来自 fanoutChain90d，本脚本只打这两条）
var TARGETS = [
    { matN: 4, mssId: 'BTCUSDT:5m:MSS:BULLISH:BTCUSDT:DC:SWING_HIGH:1780229399999:2741',
      human: 'AMBIGUOUS', aIdx: 2725, bIdx: 2716, aPx: 73813.4, bPx: 73836.0 },
    { matN: 18, mssId: 'BTCUSDT:5m:MSS:BEARISH:BTCUSDT:DC:SWING_LOW:1785658199999:20834',
      human: 'B_CAUSAL', aIdx: 20807, bIdx: 20791, aPx: 63492.0, bPx: 63550.0 }
];

// 复刻 A.2 内部常量（仅读取，不改）
var GAP_MAX = 12;
var REP_THRESHOLD = 0.6;
var ALIGN_ATR = 1.5;

function extremePriceOf(sw) {
    if (sw.source && sw.source.liquidityPrice != null) return sw.source.liquidityPrice;
    if (sw.price != null) return sw.price;
    return sw.direction === 'BULLISH' ? sw.low : sw.high;
}
function moreExtreme(p1, p2, dir) { return dir === 'BULLISH' ? (p1 < p2) : (p1 > p2); }

function atrWindow(candles5m, idx, n) {
    var sum = 0, cnt = 0;
    for (var i = Math.max(0, idx - n + 1); i <= idx; i++) {
        var c = candles5m[i];
        if (!c) continue;
        sum += (c.high - c.low); cnt++;
    }
    return cnt ? sum / cnt : (candles5m[idx] ? (candles5m[idx].high - candles5m[idx].low) : 1);
}
function actualReverseLevel(candles5m, fromIdx, Mi, D) {
    if (fromIdx < 0 || Mi >= candles5m.length) return null;
    var lvl = null;
    for (var i = fromIdx; i <= Mi; i++) {
        var c = candles5m[i];
        if (!c) continue;
        if (D === 'BULLISH') { if (lvl == null || c.low < lvl) lvl = c.low; }
        else { if (lvl == null || c.high > lvl) lvl = c.high; }
    }
    return lvl;
}
// 全窗 [prevMssIdx..Mi] 最深 wick（暴露 cStar.extremeIdx 之前的未注册极值）
function deepestWickInWindow(candles5m, fromIdx, Mi, D) {
    var lvl = null, lvlIdx = null;
    for (var i = fromIdx; i <= Mi; i++) {
        var c = candles5m[i];
        if (!c) continue;
        var w = D === 'BULLISH' ? c.low : c.high;
        if (lvl == null || moreExtreme(w, lvl, D)) { lvl = w; lvlIdx = i; }
    }
    return { lvl: lvl, idx: lvlIdx };
}

function dissect(ctx, t) {
    var candles5m = ctx.candles5m;
    var sweeps = (ctx.sweeps || []).filter(function (s) {
        return (s.direction === 'BULLISH' || s.direction === 'BEARISH') && typeof s.candleIndex === 'number';
    }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });
    var mssEvents = (ctx.mssEvents || []).filter(function (m) {
        return m && (m.direction === 'BULLISH' || m.direction === 'BEARISH') && typeof m.candleIndex === 'number';
    }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

    var m = null;
    for (var i = 0; i < mssEvents.length; i++) { if (mssEvents[i].id === t.mssId) { m = mssEvents[i]; break; } }
    if (!m) return ['  ⚠ 未找到 MSS ' + t.mssId + '（窗口漂移?）'];

    var Mi = m.candleIndex, D = m.direction;
    var prevIdx = -Infinity;
    for (var p = 0; p < mssEvents.length; p++) {
        if (mssEvents[p].candleIndex >= Mi) break;
        if (mssEvents[p].direction === D) prevIdx = mssEvents[p].candleIndex;
    }
    var elig = sweeps.filter(function (s) {
        return s.direction === D && s.candleIndex > prevIdx && s.candleIndex < Mi;
    });

    var out = [];
    out.push('  MSS idx=' + Mi + '  D=' + D + '  prevSameDirMssIdx=' + (prevIdx === -Infinity ? 'none' : prevIdx));
    out.push('  ATR(Mi,14)=' + atrWindow(candles5m, Mi, 14).toFixed(2));

    // 1. eligible
    out.push('  ── 1. eligible sweeps (' + elig.length + ' 条, 同方向, prevMss<bar<MSS) ──');
    elig.forEach(function (s) {
        var c = candles5m[s.candleIndex];
        var lp = extremePriceOf(s);
        out.push('     idx=' + s.candleIndex +
            '  type=' + ((s.source && s.source.liquidityType) || '?') +
            '  liquidityPrice=' + lp.toFixed(1) +
            '  candle ' + (D === 'BULLISH' ? 'L' : 'H') + '=' + (c ? (D === 'BULLISH' ? c.low : c.high).toFixed(1) : '?') +
            (s.candleIndex === t.aIdx ? '  ←A' : '') + (s.candleIndex === t.bIdx ? '  ←B' : ''));
    });

    // 2. cluster
    var clusters = [];
    var cur = null;
    elig.forEach(function (s) {
        if (!cur || (s.candleIndex - cur.lastIdx) > GAP_MAX) {
            cur = { members: [], firstIdx: s.candleIndex, lastIdx: s.candleIndex, sources: [], extreme: extremePriceOf(s), extremeIdx: s.candleIndex };
            clusters.push(cur);
        } else { cur.lastIdx = s.candleIndex; }
        cur.members.push(s);
        var lt = (s.source && s.source.liquidityType) || '?';
        if (cur.sources.indexOf(lt) < 0) cur.sources.push(lt);
        var e = extremePriceOf(s);
        if (moreExtreme(e, cur.extreme, D)) { cur.extreme = e; cur.extremeIdx = s.candleIndex; }
    });
    out.push('  ── 2. cluster 归并 (GAP_MAX=' + GAP_MAX + ', 同 bar 自动合并) → ' + clusters.length + ' clusters ──');
    clusters.forEach(function (c, ci) {
        var mem = c.members.map(function (s) { return s.candleIndex + '(' + ((s.source && s.source.liquidityType) || '?') + ':' + extremePriceOf(s).toFixed(1) + ')'; }).join(',');
        out.push('     C' + ci + ' [' + c.firstIdx + '..' + c.lastIdx + '] extreme=' + c.extreme.toFixed(1) + '@' + c.extremeIdx +
            '  sources=[' + c.sources.join('+') + ']');
        out.push('         members: ' + mem);
    });

    // 3. cStar
    var cStar = clusters[0];
    clusters.forEach(function (c) { if (moreExtreme(c.extreme, cStar.extreme, D)) cStar = c; });
    var nearest = clusters[clusters.length - 1];
    out.push('  ── 3. cStar = 最深层 cluster ──');
    out.push('     cStar extreme=' + cStar.extreme.toFixed(1) + ' @idx=' + cStar.extremeIdx + '  (sources=[' + cStar.sources.join('+') + '])');
    out.push('     nearest extreme=' + nearest.extreme.toFixed(1) + ' @idx=' + nearest.extremeIdx);
    out.push('     cStar===nearest ? ' + (cStar === nearest ? 'YES → NEAREST_DEEPEST (A 胜, rule3)' : 'NO → 走 rule4 repricing 判定'));

    // 4. alignment gate
    var atr = atrWindow(candles5m, Mi, 14);
    var actualReverse = actualReverseLevel(candles5m, cStar.extremeIdx, Mi, D);
    var diff = actualReverse != null ? Math.abs(actualReverse - cStar.extreme) : null;
    var alignPass = diff != null && diff <= ALIGN_ATR * atr;
    out.push('  ── 4. alignment 闸门 (ALIGN_ATR=' + ALIGN_ATR + ') ──');
    out.push('     actualReverseLevel[' + cStar.extremeIdx + '..' + Mi + '] = ' + (actualReverse != null ? actualReverse.toFixed(1) : 'null') +
        '  (' + (D === 'BULLISH' ? '最低 low' : '最高 high') + ' in 该窗)');
    out.push('     |actualReverse(' + (actualReverse != null ? actualReverse.toFixed(1) : '?') + ') − cStar.extreme(' + cStar.extreme.toFixed(1) + ')| = ' +
        (diff != null ? diff.toFixed(1) : '?') + '  vs 阈值 ' + (ALIGN_ATR * atr).toFixed(1) + ' (' + ALIGN_ATR + '×ATR)');
    out.push('     → ALIGN ' + (alignPass ? 'PASS（保留 causal）' : 'FAIL → NO_CLEAR_ALIGN（丢弃）'));

    // 5. 盲点暴露：全窗最深 wick
    var wick = deepestWickInWindow(candles5m, prevIdx < 0 ? 0 : prevIdx, Mi, D);
    out.push('  ── 5. 盲点暴露：全窗最深 wick [prevMssIdx..Mi] ──');
    out.push('     最深 ' + (D === 'BULLISH' ? 'low' : 'high') + '=' + (wick.lvl != null ? wick.lvl.toFixed(1) : '?') + ' @idx=' + wick.idx);
    out.push('     cStar.extremeIdx=' + cStar.extremeIdx + ' → 该最深 wick ' +
        (wick.idx != null && wick.idx < cStar.extremeIdx ? '在 cStar 之前 (align 窗看不到!)' : '在 cStar 之后或同根') +
        (wick.lvl != null && moreExtreme(wick.lvl, cStar.extreme, D) ? ' 且比 cStar.extreme 更深 → 真正 terminal 极值未注册/未选' : ''));

    // 6. 人类对照
    out.push('  ── 6. 人类裁决对照 ──');
    out.push('     Human=' + t.human + '  A=idx' + t.aIdx + '(' + t.aPx + ')  B=idx' + t.bIdx + '(' + t.bPx + ')');
    // 若 B 在 eligible 内，算 B 的 align（假设 B 为 causal）
    var bInElig = elig.filter(function (s) { return s.candleIndex === t.bIdx; })[0];
    if (bInElig) {
        var bExt = extremePriceOf(bInElig);
        var bRev = actualReverseLevel(candles5m, t.bIdx, Mi, D);
        var bDiff = bRev != null ? Math.abs(bRev - bExt) : null;
        out.push('     若以 B 为 causal: extreme=' + bExt.toFixed(1) + '  actualReverse[' + t.bIdx + '..' + Mi + ']=' +
            (bRev != null ? bRev.toFixed(1) : '?') + '  |diff|=' + (bDiff != null ? bDiff.toFixed(1) : '?') +
            '  vs ' + (ALIGN_ATR * atr).toFixed(1) + ' → ' + (bDiff != null && bDiff <= ALIGN_ATR * atr ? 'ALIGN PASS' : 'ALIGN FAIL'));
    } else {
        out.push('     ⚠ B(idx' + t.bIdx + ') 不在 eligible 集合内（prevMss/方向过滤）');
    }
    return out;
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.2 dissect MAT#4 + MAT#18 ...');

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
            var ctx = {
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                swings: result.swings || [],
                candles5m: candles5m,
                a2Trace: true,
                a2Traces: {}
            };
            var a2n = a2.buildNarrativesA2(ctx); // 跑一次，确保 a2Trace 一致（不改任何决策）
            var traces = ctx.a2Traces || {};

            var out = [];
            out.push('=== A.2 Sanity Fix A.3 — MAT#4 / MAT#18 decision trace 打穿 (BTCUSDT ' + DAYS + 'd, futures) ===');
            out.push('（不调参：GAP_MAX=12, REP_THRESHOLD=0.6, ALIGN_ATR=1.5。仅还原每一步计算定位误判根因。）');
            out.push('');

            TARGETS.forEach(function (t) {
                out.push('████ MAT#' + t.matN + '  (' + t.human + ')  mssId=' + t.mssId + ' ████');
                var tr = traces[t.mssId];
                out.push('  A.2 实际决策: ' + (tr ? tr.decision + '  sel=' + tr.selectedRaidIdx : 'NONE (未生成 Narrative)'));
                out.push('');
                var lines = dissect(ctx, t);
                lines.forEach(function (l) { out.push(l); });
                out.push('');
                out.push('  ────────────────────────────────────────────');
                out.push('');
            });

            var text = out.join('\n');
            console.log(text);
            var outFile = path.join(__dirname, '..', 'outputs', 'a2dissect_MAT4_MAT18_' + SYMBOL + '_futures.txt');
            fs.writeFileSync(outFile, text);
            console.log('→ 已写出 ' + outFile);
        });
    })
    .catch(function (error) {
        console.error('A.2 DISSECT FAILED:', error && error.stack || error);
        process.exit(1);
    });
