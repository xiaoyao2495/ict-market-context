/**
 * LASTNARRATIVE WARMUP STABILITY（Phase 11T.4 验收 —— 有限生命周期证明）
 *
 * 目标：验证 lastNarrative（Narrative Snapshot Retention）在正式化前
 * 是【有限生命周期】状态，不引入新的初始化依赖（warmup 敏感）。
 *
 * 用法：
 *   node scripts/warmupStabilityRetain.js BTCUSDT        # target 30d, warmup 30/60/90, RETAIN ON
 *   WARMUP_TARGET=14 node scripts/warmupStabilityRetain.js BTCUSDT
 *   WARMUPS=60,120 node scripts/warmupStabilityRetain.js BTCUSDT
 *
 * 验收 6 条：
 *   1. lastNarrative age 永远 <= maxAgeBars（1440）
 *   2. 不引用目标窗口前超过 maxAge 的 narrative
 *   3. 不同 warmup 下，若当前 1440 bars 内事件相同 → lastNarrative 应收敛
 *   4. 新 manipulation 必须覆盖旧 narrative（无 stale override）
 *   5. scenario/draw flip 后旧 narrative 不得复活（无 resurrection）
 *   6. RETAIN on/off 不改变 AMD occupancy / Scenario / Funnel（见 7 天 off/on 对照）
 *
 * 判定：以上 violations 全 0 → FINITE_MEMORY（可正式化候选）；否则 FAIL 并列出违规根。
 *
 * IMPORTANT: 诊断脚本。RETAIN 仅作为 shadow 开关，正式 baseline 不变。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');

// RETAIN ON（本脚本专项验证；正式 baseline 默认关闭不受影响）
require('../config/thresholds').amd.lastNarrative.enabled = true;
var maxAge = require('../config/thresholds').amd.lastNarrative.maxAgeBars;

var SYMBOL = process.argv[2] || 'BTCUSDT';
var TARGET_DAYS = parseInt(process.env.WARMUP_TARGET || '30', 10);
var WARMUPS = (process.env.WARMUPS || '30,60,90').split(',').map(function (s) { return parseInt(s, 10); });

var BARS_PER_DAY = 288; // 5m
var HORIZON = maxAge; // 1440 bars = 5 天

function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}

/**
 * 分析单个 warmup 的 lastNarrative 生命周期
 * @param {Array} trace amdTrace（{boundary, lastNarrative}）
 * @param {number} startIndex 目标窗口起始 index
 * @returns {Object} { presentBars, maxAgeObserved, narrativeCount, resurrections, staleOverrides,
 *                     violations: [], spans, flipClears }
 */
function analyzeTrace(trace, startIndex) {
    var out = {
        presentBars: 0,
        maxAgeObserved: 0,
        narrativeCount: 0,
        resurrections: 0,
        staleOverrides: 0,
        violations: [],
        spans: {},
        lastManipIndex: -1
    };
    for (var i = startIndex; i < trace.length; i++) {
        var ln = trace[i] ? trace[i].lastNarrative : null;

        // 新 manipulation confirmed 检测（boundary.hasManipulation false→true）
        var b = trace[i] ? trace[i].boundary : null;
        var bPrev = i > startIndex ? (trace[i - 1] ? trace[i - 1].boundary : null) : null;
        if (b && b.hasManipulation && !(bPrev && bPrev.hasManipulation)) {
            out.lastManipIndex = i;
        }

        if (!ln) {
            continue;
        }
        out.presentBars++;

        var exp = ln.expiresAt !== null && ln.expiresAt !== undefined ? ln.expiresAt : i;
        // 验收 1：未过期（i <= expiresAt；过期即被 updateAmdState 清空，出现即违规）
        if (i > exp) {
            out.violations.push('EXPIRED_PRESENT at i=' + i + ' expiresAt=' + exp);
        }
        var age = maxAge - (exp - i); // 确认根 = exp - maxAge
        if (age > out.maxAgeObserved) out.maxAgeObserved = age;
        // 验收 2：narrative 确认根（expiresAt - maxAge）不得早于 startIndex - HORIZON
        var confirmedRoot = exp - maxAge;
        if (confirmedRoot < startIndex - HORIZON) {
            out.violations.push('HORIZON_VIOLATION at i=' + i + ' confirmedRoot=' + confirmedRoot + ' < startIndex-' + HORIZON);
        }

        // 验收 4：新 manipulation confirmed 之后，旧 narrative 不得残留
        if (out.lastManipIndex !== -1 && i > out.lastManipIndex && confirmedRoot < out.lastManipIndex) {
            out.staleOverrides++;
            out.violations.push('STALE_OVERRIDE at i=' + i + ' confirmedRoot=' + confirmedRoot + ' < lastManip=' + out.lastManipIndex);
        }

        // 验收 5：复活检测 —— 同一 narrative（expiresAt|direction）不连续出现
        var key = exp + '|' + (ln.direction || '');
        if (!out.spans[key]) {
            out.spans[key] = { start: i, end: i, count: 1 };
            out.narrativeCount++;
        } else {
            if (i > out.spans[key].end + 1) {
                out.resurrections++;
                out.violations.push('RESURRECTION at i=' + i + ' key=' + key + ' (gap after ' + out.spans[key].end + ')');
            }
            out.spans[key].end = i;
            out.spans[key].count++;
        }
    }
    return out;
}

function fingerprintAt(trace, i) {
    var ln = trace && trace[i] ? trace[i].lastNarrative : null;
    if (!ln) return { p: 0 };
    return {
        p: 1,
        d: ln.direction || null,
        exp: ln.expiresAt,
        s: ln.manipulation ? ln.manipulation.sweepId : null,
        acc: ln.accumulation ? (ln.accumulation.rangeLow + '|' + ln.accumulation.rangeHigh) : null
    };
}

/**
 * 归因：两 trace 在差异根前后 HORIZON bars 内的 manipulation 确认事件序列
 */
function manipEventsAround(trace, idx, startIndex) {
    var events = [];
    var lo = Math.max(startIndex, idx - HORIZON);
    var hi = Math.min(trace.length - 1, idx + HORIZON);
    var prev = false;
    for (var i = lo; i <= hi; i++) {
        var b = trace[i] ? trace[i].boundary : null;
        var has = !!(b && b.hasManipulation);
        if (has && !prev) {
            events.push({ i: i, extreme: b.manipulationExtreme });
        }
        prev = has;
    }
    return events;
}

function runWithWarmup(warmupDays) {
    var endTime = Date.now();
    var startTime = endTime - (TARGET_DAYS + warmupDays) * 24 * 3600 * 1000;
    console.log('  warmup ' + warmupDays + 'd: loading ' + (TARGET_DAYS + warmupDays) + 'd ...');
    return historicalLoader.loadAll(SYMBOL, startTime, endTime).then(function (data) {
        var candles5m = data['5m'];
        var startIndex = warmupDays * BARS_PER_DAY;
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            logEvery: 1000000
        }, { fullWarmup: true }).then(function (result) {
            var trace = result.amdTrace || [];
            var analysis = analyzeTrace(trace, startIndex);
            // 目标窗口末尾 lastNarrative 状态
            var tail = [];
            var lastIdx = trace.length - 1;
            for (var i = Math.max(startIndex, lastIdx - 20); i <= lastIdx; i++) {
                var ln = trace[i] ? trace[i].lastNarrative : null;
                if (ln) {
                    var expT = ln.expiresAt !== null && ln.expiresAt !== undefined ? ln.expiresAt : i;
                    tail.push({ i: i, d: ln.direction, exp: expT, age: maxAge - (expT - i) });
                }
            }
            return {
                warmupDays: warmupDays,
                targetBars: result.steps.length,
                analysis: analysis,
                tail: tail,
                trace: trace,
                startIndex: startIndex
            };
        });
    });
}

console.log('========================================');
console.log('LASTNARRATIVE WARMUP STABILITY  ' + SYMBOL + '  target ' + TARGET_DAYS + 'd  warmups [' + WARMUPS.join(',') + ']d');
console.log('RETAIN ON (shadow) | maxAgeBars=' + maxAge + ' | 验收 1-5（有限生命周期证明）');
console.log('IMPORTANT: diagnostic only — lastNarrative finite-memory check before Phase 11T.5.');
console.log('');

// 串行执行（并行加载 60/90/120 天数据易触发代理 ECONNRESET）
var resultsAcc = [];
var chain = Promise.resolve();
WARMUPS.forEach(function (w) {
    chain = chain.then(function () { return runWithWarmup(w); }).then(function (r) { resultsAcc.push(r); });
});

chain.then(function () {
    var results = resultsAcc;
    var allViolations = [];

    console.log('LASTNARRATIVE LIFECYCLE (target window, per warmup)');
    console.log('  ' + pad('warmup', 8) + pad('presentBars', 12) + pad('maxAgeObs', 11) + pad('narratives', 11) +
        pad('resurrect', 10) + pad('staleOvrd', 10) + pad('violations', 11));
    results.forEach(function (r) {
        var a = r.analysis;
        allViolations = allViolations.concat(a.violations);
        console.log('  ' + pad(r.warmupDays + 'd', 8) + pad(a.presentBars, 12) + pad(a.maxAgeObserved, 11) +
            pad(a.narrativeCount, 11) + pad(a.resurrections, 10) + pad(a.staleOverrides, 10) + pad(a.violations.length, 11));
    });
    console.log('');

    // 验收 3：收敛对比（fingerprint per bar in target window）
    var ref = results[0];
    var firstDiff = null;
    var diffReasons = [];
    var minLen = Math.min.apply(null, results.map(function (r) { return r.trace.length; }));
    var maxStart = Math.max.apply(null, results.map(function (r) { return r.startIndex; }));
    for (var i = maxStart; i < minLen; i++) {
        var fp = results.map(function (r) { return fingerprintAt(r.trace, i); });
        var refFp = JSON.stringify(fp[0]);
        var differ = fp.some(function (f) { return JSON.stringify(f) !== refFp; });
        if (differ) {
            firstDiff = { i: i, fps: fp };
            break;
        }
    }
    console.log('CONVERGENCE（验收 3：1440 bars 内事件相同则 lastNarrative 应收敛）');
    if (!firstDiff) {
        console.log('  lastNarrative fingerprint 目标窗口内完全一致（3 warmup）→ CONVERGED');
    } else {
        console.log('  第一差异根: bar ' + firstDiff.i +
            ' (' + new Date(results[0].trace[firstDiff.i] ? 0 : 0).toISOString() + ')');
        firstDiff.fps.forEach(function (f, idx) {
            console.log('    warmup ' + results[idx].warmupDays + 'd: ' + JSON.stringify(f));
        });
        // 归因：差异根前后 HORIZON 内 manipulation 确认事件
        var evs = results.map(function (r) {
            return manipEventsAround(r.trace, firstDiff.i, r.startIndex).map(function (e) {
                return e.i + '@' + e.extreme;
            }).join(', ');
        });
        var evRef = evs[0];
        var evSame = evs.every(function (e) { return e === evRef; });
        console.log('  归因（差异根 ±' + HORIZON + ' bars 内 manipulation 确认事件）:');
        results.forEach(function (r, idx) {
            console.log('    warmup ' + r.warmupDays + 'd: [' + evs[idx] + ']');
        });
        if (evSame) {
            diffReasons.push('UNEXPECTED: 事件序列相同但 lastNarrative 分叉');
            console.log('  → UNEXPECTED_DIVERGENCE（同事件不同 lastNarrative — 需定位）');
        } else {
            diffReasons.push('EXPECTED: 事件序列不同（warmup 长 → 更早 narrative 历史影响 1440 bars 内事件）');
            console.log('  → EXPECTED（事件序列不同导致的合法差异，符合"1440 bars 内事件相同才要求收敛"）');
        }
    }
    console.log('');

    // 末尾状态
    console.log('TARGET WINDOW END STATE (last 20 bars with lastNarrative)');
    results.forEach(function (r) {
        var t = r.tail;
        if (t.length === 0) {
            console.log('  ' + pad(r.warmupDays + 'd', 8) + ' (no lastNarrative at end)');
            return;
        }
        var last = t[t.length - 1];
        console.log('  ' + pad(r.warmupDays + 'd', 8) +
            ' direction ' + pad(last.d, 8) + ' expiresAt ' + last.exp + ' age ' + last.age + ' bars');
    });
    console.log('');

    var verdict = 'FINITE_MEMORY';
    if (allViolations.length > 0) {
        verdict = 'FAIL (' + allViolations.length + ' violations)';
        allViolations.slice(0, 10).forEach(function (v) { console.log('    ' + v); });
    }
    if (diffReasons.some(function (r) { return r.indexOf('UNEXPECTED') !== -1; })) {
        verdict = 'FAIL (unexpected divergence)';
    }
    console.log('VERDICT: ' + verdict);
    console.log('  (验收 6：RETAIN on/off 不改变 AMD occupancy/Scenario/Funnel — 由 7 天 off/on 逐位一致证明)');
    console.log('========================================');
}).catch(function (e) {
    console.error('LASTNARRATIVE WARMUP FAILED:', e);
    process.exit(1);
});
