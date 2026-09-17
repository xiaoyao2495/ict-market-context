'use strict';

/**
 * REVERSAL_PATTERN_SEMANTIC_AUDIT_V1 - pure logic.
 *
 * Research / audit only. This module never touches production trading code,
 * never fetches data, never calls an LLM and never looks at any outcome.
 *
 * Everything here is a pure function of the supplied closed candles so the
 * causality guarantees can be unit-tested without network access.
 *
 * Hard rule (lookahead ban): a candidate is confirmed at the closeTime of its
 * last bar, and nothing derived from a later bar may enter that candidate's
 * window, facts, prompt or classification.
 */

var VERSION = 'REVERSAL_PATTERN_SEMANTIC_AUDIT_V1';
var CONTEXT_VERSION = 'TWO_BAR_REVERSAL_CONTEXT_AUDIT_V1';
var BAR_MS = 300000; // 5m
var REQUIRED_CANDLES = 288; // 24h
var PRECEDING_MAX_BARS = 10;
var PRECEDING_MIN_BARS = 4;

var PATTERNS = ['PIN_BAR', 'TWO_BAR_REVERSAL', 'THREE_BAR_REVERSAL'];
/**
 * §7 window-length binding: a window may only be judged as the pattern that its
 * own length implies (plus NONE). This is what removes duplicate events: a bar
 * can still sit inside a 1/2/3-bar window, but a 3-bar window can never be
 * reported as PIN_BAR.
 */
var WINDOW_PATTERN = { 1: 'PIN_BAR', 2: 'TWO_BAR_REVERSAL', 3: 'THREE_BAR_REVERSAL' };
var DIRECTIONS = ['BULLISH', 'BEARISH'];
var LABELS = ['CLEAR', 'BORDERLINE', 'NOT_PATTERN'];
var CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
var OVERALL = ['CLEAR_PATTERN', 'BORDERLINE_PATTERN', 'NONE'];

// ------------------------------------------------------------------ §5 facts

function round(value, digits) {
    var m = Math.pow(10, digits === undefined ? 6 : digits);
    return Math.round(value * m) / m;
}

/** Objective per-candle facts. Ratios are null when range === 0 (never 0-filled). */
function candleFacts(candle) {
    if (!candle || typeof candle.open !== 'number') throw new Error('CANDLE_REQUIRED');
    var open = candle.open;
    var high = candle.high;
    var low = candle.low;
    var close = candle.close;
    var range = high - low;
    var body = Math.abs(close - open);
    var upperTail = high - Math.max(open, close);
    var lowerTail = Math.min(open, close) - low;
    var degenerate = !(range > 0);
    var direction = close > open ? 'BULLISH' : (close < open ? 'BEARISH' : 'DOJI');
    return {
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        open: open,
        high: high,
        low: low,
        close: close,
        direction: direction,
        range: round(range, 6),
        body: round(body, 6),
        bodyRatio: degenerate ? null : round(body / range, 6),
        upperTail: round(upperTail, 6),
        lowerTail: round(lowerTail, 6),
        upperTailRatio: degenerate ? null : round(upperTail / range, 6),
        lowerTailRatio: degenerate ? null : round(lowerTail / range, 6),
        closeLocation: degenerate ? null : round((close - low) / range, 6)
    };
}

// ---------------------------------------------------------- §3 data contract

/**
 * Continuity + closure contract. Returns a structured report; never throws so
 * the caller can decide to FAIL loudly.
 */
function continuityReport(candles, serverTime) {
    var problems = [];
    if (!Array.isArray(candles) || candles.length !== REQUIRED_CANDLES) {
        problems.push({
            kind: 'COUNT',
            expected: REQUIRED_CANDLES,
            actual: Array.isArray(candles) ? candles.length : null
        });
    }
    var list = Array.isArray(candles) ? candles : [];
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || c.closed !== true) problems.push({ kind: 'NOT_CLOSED', index: i });
        if (i > 0) {
            var step = c.openTime - list[i - 1].openTime;
            if (step !== BAR_MS) {
                problems.push({ kind: 'GAP_OR_DUPLICATE', index: i, stepMs: step });
            }
        }
        if (typeof serverTime === 'number' && c.closeTime >= serverTime) {
            problems.push({ kind: 'CLOSE_NOT_BEFORE_SERVER_TIME', index: i, closeTime: c.closeTime, serverTime: serverTime });
        }
    }
    return {
        candleCount: list.length,
        expectedCount: REQUIRED_CANDLES,
        strictlyIncreasing: problems.every(function (p) { return p.kind !== 'GAP_OR_DUPLICATE'; }),
        noGap: problems.every(function (p) { return p.kind !== 'GAP_OR_DUPLICATE'; }),
        noDuplicate: problems.every(function (p) { return p.kind !== 'GAP_OR_DUPLICATE'; }),
        allClosed: problems.every(function (p) { return p.kind !== 'NOT_CLOSED'; }),
        lastCandleClosedBeforeServerTime: problems.every(function (p) {
            return p.kind !== 'CLOSE_NOT_BEFORE_SERVER_TIME';
        }),
        problems: problems,
        PASS: problems.length === 0
    };
}

// -------------------------------------------------------------- §6 pins

/** Loose garbage filter only - the LLM decides CLEAR / BORDERLINE / NOT_PATTERN. */
function pinCandidates(facts) {
    var out = [];
    facts.forEach(function (f, index) {
        var bullish = f.lowerTailRatio !== null && f.lowerTailRatio >= 0.35 &&
            f.closeLocation !== null && f.closeLocation >= 0.45;
        var bearish = f.upperTailRatio !== null && f.upperTailRatio >= 0.35 &&
            f.closeLocation !== null && f.closeLocation <= 0.55;
        if (bullish) {
            out.push({ pattern: 'PIN_BAR', direction: 'BULLISH', startIndex: index, endIndex: index });
        }
        if (bearish) {
            out.push({ pattern: 'PIN_BAR', direction: 'BEARISH', startIndex: index, endIndex: index });
        }
    });
    return out;
}

// --------------------------------------------------------- §7 two-bar

function pairFacts(k1, k2) {
    var combinedHigh = Math.max(k1.high, k2.high);
    var combinedLow = Math.min(k1.low, k2.low);
    var combinedRange = combinedHigh - combinedLow;
    var rangeSimilarity = Math.max(k1.range, k2.range) === 0 ? null :
        Math.min(k1.range, k2.range) / Math.max(k1.range, k2.range);
    var bodySimilarity = Math.max(k1.body, k2.body) === 0 ? null :
        Math.min(k1.body, k2.body) / Math.max(k1.body, k2.body);
    var lowDifference = round(k2.low - k1.low, 6);
    var highDifference = round(k2.high - k1.high, 6);
    return {
        rangeSimilarity: rangeSimilarity === null ? null : round(rangeSimilarity, 6),
        bodySimilarity: bodySimilarity === null ? null : round(bodySimilarity, 6),
        combinedHigh: round(combinedHigh, 6),
        combinedLow: round(combinedLow, 6),
        combinedRange: round(combinedRange, 6),
        combinedCloseLocation: combinedRange === 0 ? null : round((k2.close - combinedLow) / combinedRange, 6),
        lowDifference: lowDifference,
        highDifference: highDifference,
        lowDifferenceOverPairRange: combinedRange === 0 ? null : round(lowDifference / combinedRange, 6),
        highDifferenceOverPairRange: combinedRange === 0 ? null : round(highDifference / combinedRange, 6),
        extremeRelation: roundedExtremeRelation(lowDifference, highDifference, combinedRange)
    };
}

function roundedExtremeRelation(lowDifference, highDifference, combinedRange) {
    var epsilon = combinedRange === 0 ? 0 : combinedRange * 1e-9;
    if (Math.abs(lowDifference) <= epsilon) return 'SIMILAR_LOW';
    return lowDifference < 0 ? 'LOWER_LOW' : 'HIGHER_LOW';
}

function twoBarCandidates(facts) {
    var out = [];
    for (var i = 0; i + 1 < facts.length; i++) {
        var k1 = facts[i];
        var k2 = facts[i + 1];
        var opposite = (k1.direction === 'BEARISH' && k2.direction === 'BULLISH') ||
            (k1.direction === 'BULLISH' && k2.direction === 'BEARISH');
        if (!opposite) continue;
        if (!(k1.bodyRatio >= 0.20) || !(k2.bodyRatio >= 0.20)) continue;
        var pair = pairFacts(k1, k2);
        if (pair.rangeSimilarity !== null && pair.rangeSimilarity < 0.30) continue;
        var bullish = k1.direction === 'BEARISH';
        var k1Body = k1.body === 0 ? null : k1.body;
        var recovery = k1Body === null ? null : round((k2.close - k1.close) / Math.abs(k1.open - k1.close), 6);
        out.push({
            pattern: 'TWO_BAR_REVERSAL',
            direction: bullish ? 'BULLISH' : 'BEARISH',
            startIndex: i,
            endIndex: i + 1,
            derived: {
                rangeSimilarity: pair.rangeSimilarity,
                bodySimilarity: pair.bodySimilarity,
                recovery: recovery,
                combinedHigh: pair.combinedHigh,
                combinedLow: pair.combinedLow,
                combinedCloseLocation: pair.combinedCloseLocation,
                canonicalExtreme: bullish ? pair.combinedLow : pair.combinedHigh,
                extremeRelation: bullish ? pair.extremeRelation : oppositeExtremeRelation(pair),
                lowDifference: pair.lowDifference,
                highDifference: pair.highDifference,
                lowDifferenceOverPairRange: pair.lowDifferenceOverPairRange,
                highDifferenceOverPairRange: pair.highDifferenceOverPairRange
            }
        });
    }
    return out;
}

function oppositeExtremeRelation(pair) {
    return pair.extremeRelation === 'LOWER_LOW' ? 'HIGHER_HIGH'
        : (pair.extremeRelation === 'HIGHER_LOW' ? 'LOWER_HIGH' : 'SIMILAR_HIGH');
}

// ------------------------------------------------------- §8 three-bar

function threeBarCandidates(facts) {
    var out = [];
    for (var i = 0; i + 2 < facts.length; i++) {
        var k1 = facts[i];
        var k2 = facts[i + 1];
        var k3 = facts[i + 2];
        var opposite = (k1.direction === 'BEARISH' && k3.direction === 'BULLISH') ||
            (k1.direction === 'BULLISH' && k3.direction === 'BEARISH');
        if (!opposite) continue;
        if (!(k1.bodyRatio >= 0.20) || !(k3.bodyRatio >= 0.20)) continue;
        var outerMaxRange = Math.max(k1.range, k3.range);
        var outerRangeSimilarity = outerMaxRange === 0 ? null : round(Math.min(k1.range, k3.range) / outerMaxRange, 6);
        var middleRelativeRange = outerMaxRange === 0 ? null : round(k2.range / outerMaxRange, 6);
        var middleBodyRatio = k2.bodyRatio;
        var loose = (middleBodyRatio !== null && middleBodyRatio <= 0.60) ||
            (middleRelativeRange !== null && middleRelativeRange <= 0.80);
        if (!loose) continue;
        var combinedHigh = Math.max(k1.high, k2.high, k3.high);
        var combinedLow = Math.min(k1.low, k2.low, k3.low);
        var combinedRange = combinedHigh - combinedLow;
        var bullish = k1.direction === 'BEARISH';
        out.push({
            pattern: 'THREE_BAR_REVERSAL',
            direction: bullish ? 'BULLISH' : 'BEARISH',
            startIndex: i,
            endIndex: i + 2,
            derived: {
                outerRangeSimilarity: outerRangeSimilarity,
                outerBodySimilarity: Math.max(k1.body, k3.body) === 0 ? null :
                    round(Math.min(k1.body, k3.body) / Math.max(k1.body, k3.body), 6),
                middleRelativeRange: middleRelativeRange,
                middleBodyRatio: middleBodyRatio,
                outerRecovery: k1.body === 0 ? null :
                    round((k3.close - k1.close) / Math.abs(k1.open - k1.close), 6),
                closeLocationK3: k3.closeLocation,
                combinedHigh: round(combinedHigh, 6),
                combinedLow: round(combinedLow, 6),
                combinedCloseLocation: combinedRange === 0 ? null :
                    round((k3.close - combinedLow) / combinedRange, 6),
                canonicalExtreme: bullish ? round(combinedLow, 6) : round(combinedHigh, 6)
            }
        });
    }
    return out;
}

// ------------------------------------------------------------ §14 dedupe

function eventKey(candidate, bars) {
    var first = bars[candidate.startIndex];
    var last = bars[candidate.endIndex];
    return [candidate.pattern, candidate.direction, first.openTime, last.closeTime].join('|');
}

function dedupe(candidates, bars) {
    var seen = {};
    var out = [];
    candidates.forEach(function (c) {
        var key = eventKey(c, bars);
        if (seen[key]) return;
        seen[key] = true;
        out.push(c);
    });
    return out;
}

// --------------------------------------------------- §4/§13 causality guard

var FORBIDDEN_KEY = /(future|outcome|forward|trigger|profit|pnl|return|nextc|after|mfe|mae|winrate)/i;
var TIME_KEY = /(time|at)$/i;

/**
 * Deep scan of everything that will be sent to the LLM.
 * Throws FUTURE_LEAK_* on any violation so a leaking run can never proceed.
 */
function assertNoFutureData(payload, confirmedAt, path) {
    var here = path || '$';
    if (Array.isArray(payload)) {
        payload.forEach(function (item, i) { assertNoFutureData(item, confirmedAt, here + '[' + i + ']'); });
        return true;
    }
    if (payload && typeof payload === 'object') {
        Object.keys(payload).forEach(function (k) {
            if (FORBIDDEN_KEY.test(k)) {
                throw Object.assign(new Error('FUTURE_LEAK_FORBIDDEN_KEY ' + here + '.' + k), {
                    code: 'FUTURE_LEAK_FORBIDDEN_KEY'
                });
            }
            var v = payload[k];
            if (typeof v === 'number' && TIME_KEY.test(k) && v > confirmedAt) {
                throw Object.assign(new Error('FUTURE_LEAK_TIME ' + here + '.' + k + '=' + v + ' > ' + confirmedAt), {
                    code: 'FUTURE_LEAK_TIME'
                });
            }
            assertNoFutureData(v, confirmedAt, here + '.' + k);
        });
    }
    return true;
}

/** Window bars must never extend past the confirmation close. */
function assertWindowWithinConfirmation(bars, confirmedAt) {
    bars.forEach(function (b, i) {
        if (b.closeTime > confirmedAt || b.openTime > confirmedAt) {
            throw Object.assign(new Error('FUTURE_LEAK_WINDOW index=' + i), { code: 'FUTURE_LEAK_WINDOW' });
        }
    });
    return true;
}

// ------------------------------------------------------------- §10/§11 prompt

var SYSTEM_PROMPT = [
    'You classify whether the supplied closed candles form one of exactly three reversal patterns.',
    '',
    'You may answer only with these pattern names:',
    'PIN_BAR, TWO_BAR_REVERSAL, THREE_BAR_REVERSAL.',
    '',
    'PIN_BAR - a single-candle reversal pattern.',
    'Bullish: price probed clearly downward, a significant lower rejection appeared, and the close moved',
    'back away from the low into the upper/middle part of the candle.',
    'Core semantics: significant lower rejection + relatively small/non-dominant body + close clearly',
    'away from the low. A bullish body is NOT required. Bearish is the exact mirror.',
    'Do not reject the shape merely because one ratio misses a fixed threshold; judge the whole shape.',
    '',
    'TWO_BAR_REVERSAL - two consecutive candles.',
    'Bullish: K1 shows clear bearish directional delivery, K2 shows clear bullish directional delivery,',
    'and K2 rapidly and visibly negates K1 bearish control. Normally the two candles are not extremely',
    'different in size, both have a real directional body, and K2 clearly recovers K1 price progress.',
    'Core semantics: bearish control -> rapid bullish takeover. Bearish is the exact mirror.',
    'Do not apply a single ratio as a hard mechanical threshold.',
    '',
    'THREE_BAR_REVERSAL - three consecutive candles.',
    'K1 = directional bar in the original direction; K2 = pause / small / indecisive bar;',
    'K3 = clear directional bar in the opposite direction.',
    'Bullish: bear -> pause -> bull. Bearish: bull -> pause -> bear.',
    'K1 and K3 are the body of the reversal. K2 is the middle pause and should not be the main',
    'directional bar. Do not reject the shape only because K2 is not a perfect doji.',
    '',
    'You may return more than one pattern for the same window; the patterns are not mutually exclusive.',
    'If the window does not form any of the three patterns, return an empty matches array and overall NONE.',
    '',
    'You are forbidden from introducing any other concept, including but not limited to:',
    'MTR, Wedge, Morning Star, Evening Star, Engulfing, ICT, FVG, MSS, Displacement, Order Block,',
    'Support, Resistance, Trendline, Liquidity, EQH, EQL, future outcome, profitability.',
    'Do not judge whether the setup will rise or fall, whether it is worth trading, or what its win rate is.',
    'Judge only the shape semantics itself.',
    '',
    'You have no information after evaluationTime. Do not infer future price action.',
    'Judge only the supplied bars and deterministic candle facts.',
    '',
    'Return one JSON object and no prose outside it:',
    '{',
    '  "matches": [',
    '    {',
    '      "pattern": "PIN_BAR" | "TWO_BAR_REVERSAL" | "THREE_BAR_REVERSAL",',
    '      "direction": "BULLISH" | "BEARISH",',
    '      "label": "CLEAR" | "BORDERLINE" | "NOT_PATTERN",',
    '      "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '      "supportingFacts": ["..."],',
    '      "conflicts": ["..."],',
    '      "reason": "..."',
    '    }',
    '  ],',
    '  "overall": "CLEAR_PATTERN" | "BORDERLINE_PATTERN" | "NONE"',
    '}'
].join('\n');

/**
 * Builds the per-candidate user prompt.
 * Deliberately does NOT name the candidate pattern (§9 anchoring ban).
 */
function buildUserPayload(symbol, interval, bars, facts, confirmedAt) {
    return {
        symbol: symbol,
        interval: interval,
        evaluationTime: confirmedAt,
        evaluationTimeIso: new Date(confirmedAt).toISOString(),
        windowBarCount: bars.length,
        allowedPattern: patternForWindow(bars.length),
        bars: bars.map(function (b, i) {
            var f = facts[i];
            return {
                openTime: b.openTime,
                closeTime: b.closeTime,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                direction: f.direction,
                range: f.range,
                body: f.body,
                bodyRatio: f.bodyRatio,
                upperTail: f.upperTail,
                lowerTail: f.lowerTail,
                upperTailRatio: f.upperTailRatio,
                lowerTailRatio: f.lowerTailRatio,
                closeLocation: f.closeLocation
            };
        })
    };
}

function buildUserPrompt(payload) {
    return 'This window contains exactly ' + payload.windowBarCount + ' closed candle(s).\n'
        + 'For this window you may report only ' + payload.allowedPattern + ', or return no match at all.\n'
        + 'Judge it against the supplied reversal pattern definitions.\n\n'
        + JSON.stringify(payload, null, 2);
}

// ------------------------------------------------------------ §12 validation

function fail(code) {
    return Object.assign(new Error(code), { code: code });
}

function patternForWindow(barCount) {
    return WINDOW_PATTERN[barCount] || null;
}

/**
 * expectedPattern (optional) enforces the §7 window binding: a 2-bar window may
 * not come back labelled PIN_BAR or THREE_BAR_REVERSAL.
 */
function validateLlmOutput(output, expectedPattern) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw fail('LLM_OUTPUT_SCHEMA_INVALID');
    var keys = Object.keys(output).sort().join('|');
    if (keys !== 'matches|overall') throw fail('LLM_OUTPUT_SCHEMA_INVALID');
    if (!Array.isArray(output.matches)) throw fail('LLM_OUTPUT_MATCHES_INVALID');
    if (OVERALL.indexOf(output.overall) < 0) throw fail('LLM_OUTPUT_OVERALL_INVALID');
    output.matches.forEach(function (m) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw fail('LLM_MATCH_SCHEMA_INVALID');
        var mk = Object.keys(m).sort().join('|');
        if (mk !== 'confidence|conflicts|direction|label|pattern|reason|supportingFacts') {
            throw fail('LLM_MATCH_SCHEMA_INVALID');
        }
        if (PATTERNS.indexOf(m.pattern) < 0) throw fail('LLM_MATCH_PATTERN_INVALID');
        if (expectedPattern && m.pattern !== expectedPattern) {
            throw fail('LLM_MATCH_PATTERN_NOT_ALLOWED_FOR_WINDOW');
        }
        if (DIRECTIONS.indexOf(m.direction) < 0) throw fail('LLM_MATCH_DIRECTION_INVALID');
        if (LABELS.indexOf(m.label) < 0) throw fail('LLM_MATCH_LABEL_INVALID');
        if (CONFIDENCE.indexOf(m.confidence) < 0) throw fail('LLM_MATCH_CONFIDENCE_INVALID');
        if (!Array.isArray(m.supportingFacts)) throw fail('LLM_MATCH_SUPPORTING_FACTS_INVALID');
        if (!Array.isArray(m.conflicts)) throw fail('LLM_MATCH_CONFLICTS_INVALID');
        if (typeof m.reason !== 'string' || !m.reason.trim()) throw fail('LLM_MATCH_REASON_INVALID');
    });
    return output;
}

// ------------------------------------------------------- §2 UTC+8 formatting

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * Asia/Shanghai has no daylight saving, so a fixed +8 offset is exact.
 * The value formatted is the candle OPEN time, never the close/confirmedAt.
 */
function formatUtc8(ms) {
    var d = new Date(ms + 8 * 3600000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
        + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function formatClockUtc8(ms) { return formatUtc8(ms).slice(11); }

// ============================================ preceding directional context

/**
 * Wilder ATR14 computed strictly up to `endIndex` (no future bar is read).
 * Local implementation so this research module stays dependency-free.
 */
function wilderAtr14(candles, endIndex) {
    var p = 14;
    var atr = new Array(endIndex + 1).fill(null);
    if (endIndex + 1 < p) return atr;
    var trs = [];
    for (var i = 0; i <= endIndex; i++) {
        var c = candles[i];
        var prev = i === 0 ? null : candles[i - 1].close;
        var range = c.high - c.low;
        trs.push(prev === null ? range : Math.max(range, Math.abs(c.high - prev), Math.abs(c.low - prev)));
    }
    var sum = 0;
    for (var k = 0; k < p; k++) sum += trs[k];
    atr[p - 1] = sum / p;
    for (var j = p; j <= endIndex; j++) atr[j] = (atr[j - 1] * (p - 1) + trs[j]) / p;
    return atr;
}

function sumAbsCloseMove(bars) {
    var total = 0;
    for (var i = 1; i < bars.length; i++) total += Math.abs(bars[i].close - bars[i - 1].close);
    return total;
}

function segmentFacts(bars, atrValue) {
    var startClose = bars[0].close;
    var endClose = bars[bars.length - 1].close;
    var net = endClose - startClose;
    var travelled = sumAbsCloseMove(bars);
    var bull = 0;
    var bear = 0;
    var doji = 0;
    bars.forEach(function (b) {
        if (b.close > b.open) bull += 1;
        else if (b.close < b.open) bear += 1;
        else doji += 1;
    });
    return {
        availableBars: bars.length,
        startClose: round(startClose, 6),
        endClose: round(endClose, 6),
        netMove: round(net, 6),
        netMoveAtr: atrValue ? round(net / atrValue, 6) : null,
        directionalEfficiency: travelled === 0 ? 0 : round(Math.abs(net) / travelled, 6),
        bullBarCount: bull,
        bearBarCount: bear,
        dojiCount: doji
    };
}

function tailNetMove(bars, n, atrValue) {
    if (bars.length < n) return { netMove: null, netMoveAtr: null };
    var tail = bars.slice(-n);
    var net = tail[tail.length - 1].close - tail[0].close;
    return {
        netMove: round(net, 6),
        netMoveAtr: atrValue ? round(net / atrValue, 6) : null
    };
}

/**
 * Objective facts for the preceding window (P10..P1) plus an "including K1"
 * view so the model can see whether a leg continues into K1.
 * Everything is derived from bars at or before K1's close.
 */
function buildPrecedingFacts(precedingBars, k1, allCandlesUpToK1) {
    var atrSeries = wilderAtr14(allCandlesUpToK1, allCandlesUpToK1.length - 1);
    var atrAtK1 = atrSeries[atrSeries.length - 1];
    var seq = precedingBars;
    var withK1 = precedingBars.concat([k1]);
    var base = segmentFacts(seq, atrAtK1);
    var highPos = 0;
    var lowPos = 0;
    seq.forEach(function (b, i) {
        if (b.high > seq[highPos].high) highPos = i;
        if (b.low < seq[lowPos].low) lowPos = i;
    });
    var lowerHigh = 0;
    var higherHigh = 0;
    var lowerLow = 0;
    var higherLow = 0;
    for (var i = 1; i < seq.length; i++) {
        if (seq[i].high < seq[i - 1].high) lowerHigh += 1;
        if (seq[i].high > seq[i - 1].high) higherHigh += 1;
        if (seq[i].low < seq[i - 1].low) lowerLow += 1;
        if (seq[i].low > seq[i - 1].low) higherLow += 1;
    }
    var last3 = tailNetMove(seq, 3, atrAtK1);
    var last5 = tailNetMove(seq, 5, atrAtK1);
    var last7 = tailNetMove(seq, 7, atrAtK1);
    return Object.assign(base, {
        highestHigh: round(Math.max.apply(null, seq.map(function (b) { return b.high; })), 6),
        lowestLow: round(Math.min.apply(null, seq.map(function (b) { return b.low; })), 6),
        highestHighPosition: highPos,
        lowestLowPosition: lowPos,
        highestHighBarsFromEnd: seq.length - 1 - highPos,
        lowestLowBarsFromEnd: seq.length - 1 - lowPos,
        firstHigh: round(seq[0].high, 6),
        lastHigh: round(seq[seq.length - 1].high, 6),
        firstLow: round(seq[0].low, 6),
        lastLow: round(seq[seq.length - 1].low, 6),
        lowerHighCount: lowerHigh,
        higherHighCount: higherHigh,
        lowerLowCount: lowerLow,
        higherLowCount: higherLow,
        last3NetMove: last3.netMove,
        last3NetMoveAtr: last3.netMoveAtr,
        last5NetMove: last5.netMove,
        last5NetMoveAtr: last5.netMoveAtr,
        last7NetMove: last7.netMove,
        last7NetMoveAtr: last7.netMoveAtr,
        atr14AtK1: atrAtK1 === null ? null : round(atrAtK1, 6),
        includingK1: segmentFacts(withK1, atrAtK1)
    });
}

var CONTEXT_DIRECTIONS = ['BEARISH', 'BULLISH', 'SIDEWAYS', 'UNCLEAR'];
var CONTEXT_LABELS = ['CLEAR', 'BORDERLINE', 'NOT_TREND', 'INSUFFICIENT_CONTEXT'];

function expectedContextDirection(twoBarDirection) {
    return twoBarDirection === 'BULLISH' ? 'BEARISH' : 'BULLISH';
}

var CONTEXT_SYSTEM_PROMPT = [
    'A two-bar reversal has ALREADY been confirmed. Do not re-judge whether it is a two-bar reversal.',
    'Your only task is to decide whether a clear directional leg, opposite to the reversal direction,',
    'existed in the price process immediately BEFORE K1 and continued into or up to K1.',
    '',
    'Do NOT ask "are the previous bars a trend". A genuine reversal may be preceded by a leg that only',
    'formed over the most recent few bars. Ask instead: is there a clear directional leg that runs into',
    'or up to K1?',
    '',
    'PRECEDING BEARISH LEG (expected when the two-bar reversal is BULLISH):',
    'Price kept pressing toward lower prices into K1. Small bullish pullbacks, inside bars, dojis and',
    'one or two opposite-colour candles are allowed. The recent process as a whole must still show',
    'lower price progression and bearish directional control.',
    'NOT CLEAR when: pure sideways; two-way chop; only K1 itself drops suddenly; the down leg ended well',
    'before K1 and price had already turned up; there is essentially no sustained downward progression.',
    '',
    'PRECEDING BULLISH LEG (expected when the two-bar reversal is BEARISH): the exact mirror - price kept',
    'pressing toward higher prices into K1, small bearish pullbacks allowed, bullish control dominant.',
    '',
    'Do not require a fixed number of bars and do not count same-colour candles as a rule.',
    'Judge the directional process, not the colour sequence.',
    'If there are too few supplied preceding bars to judge, answer INSUFFICIENT_CONTEXT.',
    '',
    'You are forbidden from introducing any other concept, including but not limited to:',
    'MTR, Wedge, Morning Star, Evening Star, Engulfing, ICT, FVG, MSS, Displacement, Order Block,',
    'Support, Resistance, Trendline, Liquidity, EQH, EQL, future outcome, profitability.',
    'Do not judge whether the setup will rise or fall, whether it is worth trading, or its win rate.',
    '',
    'You have no information after evaluationTime. Do not infer future price action.',
    '',
    'Return one JSON object and no prose outside it:',
    '{',
    '  "expectedDirection": "BEARISH" | "BULLISH",',
    '  "detectedDirection": "BEARISH" | "BULLISH" | "SIDEWAYS" | "UNCLEAR",',
    '  "label": "CLEAR" | "BORDERLINE" | "NOT_TREND" | "INSUFFICIENT_CONTEXT",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "estimatedLegBars": <integer>,',
    '  "reason": "short explanation"',
    '}'
].join('\n');

/**
 * §12 payload. Contains only the preceding window plus K1/K2 - never K3 or later.
 */
function buildContextPayload(symbol, interval, twoBarDirection, twoBarLabel, precedingBars,
    k1, k2, precedingFacts, evaluationTime, targetPatternType) {
    return {
        symbol: symbol,
        interval: interval,
        targetPattern: {
            type: targetPatternType || 'TWO_BAR_REVERSAL',
            direction: twoBarDirection,
            label: twoBarLabel
        },
        expectedContextDirection: expectedContextDirection(twoBarDirection),
        precedingBars: precedingBars.map(function (b) {
            return {
                openTime: b.openTime,
                closeTime: b.closeTime,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                direction: b.close > b.open ? 'BULLISH' : (b.close < b.open ? 'BEARISH' : 'DOJI')
            };
        }),
        k1: { openTime: k1.openTime, closeTime: k1.closeTime, open: k1.open, high: k1.high, low: k1.low, close: k1.close },
        k2: { openTime: k2.openTime, closeTime: k2.closeTime, open: k2.open, high: k2.high, low: k2.low, close: k2.close },
        precedingFacts: precedingFacts,
        evaluationTime: evaluationTime,
        evaluationTimeIso: new Date(evaluationTime).toISOString()
    };
}

function buildContextUserPrompt(payload) {
    return 'The two-bar reversal is already confirmed as ' + payload.targetPattern.direction + '. '
        + 'You are judging ONLY the preceding directional context. '
        + 'The expected preceding direction is ' + payload.expectedContextDirection + '. '
        + 'The evaluation time is ' + payload.evaluationTime + ' and you have no information after it.\n\n'
        + JSON.stringify(payload, null, 2);
}

function validateContextOutput(output, expectedDirection) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw fail('CONTEXT_OUTPUT_SCHEMA_INVALID');
    var keys = Object.keys(output).sort().join('|');
    if (keys !== 'confidence|detectedDirection|estimatedLegBars|expectedDirection|label|reason') {
        throw fail('CONTEXT_OUTPUT_SCHEMA_INVALID');
    }
    if (DIRECTIONS.indexOf(output.expectedDirection) < 0) throw fail('CONTEXT_EXPECTED_DIRECTION_INVALID');
    if (CONTEXT_DIRECTIONS.indexOf(output.detectedDirection) < 0) throw fail('CONTEXT_DETECTED_DIRECTION_INVALID');
    if (CONTEXT_LABELS.indexOf(output.label) < 0) throw fail('CONTEXT_LABEL_INVALID');
    if (CONFIDENCE.indexOf(output.confidence) < 0) throw fail('CONTEXT_CONFIDENCE_INVALID');
    if (!Number.isInteger(output.estimatedLegBars) || output.estimatedLegBars < 0) {
        throw fail('CONTEXT_ESTIMATED_LEG_BARS_INVALID');
    }
    if (typeof output.reason !== 'string' || !output.reason.trim()) throw fail('CONTEXT_REASON_INVALID');
    return Object.assign({}, output, {
        expectedDirectionMatched: output.expectedDirection === expectedDirection
    });
}

/** true when the two-bar is CLEAR and the preceding leg is the opposite direction and CLEAR. */
function isContextAligned(twoBarDirection, context) {
    return context.label === 'CLEAR'
        && context.detectedDirection === expectedContextDirection(twoBarDirection);
}

/**
 * §16 estimated leg start: count back `estimatedLegBars` bars from K1 inside the
 * available preceding window. Helper for human location only.
 */
function estimatedLegStartOpenTime(precedingBars, estimatedLegBars) {
    if (!Number.isInteger(estimatedLegBars) || estimatedLegBars <= 0) return null;
    var n = Math.min(estimatedLegBars, precedingBars.length);
    if (n <= 0) return null;
    return precedingBars[precedingBars.length - n].openTime;
}

// ================================================ bullish pin bar (stage 1)

var PIN_LABELS = ['CLEAR', 'BORDERLINE', 'NOT_PATTERN'];
var PIN_BODY = ['BULL', 'BEAR', 'DOJI'];

/** Body colour of a single candle. Research observation only, never a gate. */
function pinBodyColor(candle) {
    if (candle.close > candle.open) return 'BULL';
    if (candle.close < candle.open) return 'BEAR';
    return 'DOJI';
}

var BULLISH_PIN_SYSTEM_PROMPT = [
    'You classify whether ONE closed candle is a BULLISH PIN BAR.',
    '',
    'BULLISH PIN BAR - a single-candle pattern.',
    'Inside that bar price probed clearly downward, the lower prices were rejected, a significant lower',
    'wick / lower tail formed, and the close moved clearly back away from the low.',
    'Core semantics: downward exploration -> lower-price rejection -> price closes back away from the low.',
    'Typical properties: the lower tail is visually significant, the body is relatively non-dominant,',
    'and the close sits clearly away from the low.',
    'Do NOT apply any single ratio as a hard threshold; judge the whole shape.',
    '',
    'Very important: a bullish pin bar does NOT require close > open.',
    'A green body is fine and a red body is fine, as long as the candle still clearly expresses a lower',
    'rejection.',
    '',
    'You are forbidden from introducing any other concept, including but not limited to:',
    'TWO_BAR_REVERSAL, THREE_BAR_REVERSAL, MTR, Wedge, Morning Star, Evening Star, Engulfing, ICT, FVG,',
    'MSS, Displacement, Order Block, Support, Resistance, Trendline, Liquidity, EQH, EQL, future outcome,',
    'profitability, trend context.',
    'Judge the single candle only. Do not judge whether the setup will rise or fall or whether it is',
    'worth trading.',
    '',
    'You have no information after evaluationTime. Do not infer future price action.',
    '',
    'Return one JSON object and no prose outside it:',
    '{',
    '  "pattern": "PIN_BAR",',
    '  "direction": "BULLISH",',
    '  "label": "CLEAR" | "BORDERLINE" | "NOT_PATTERN",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "reason": "short explanation"',
    '}'
].join('\n');

/** Single-bar payload: the pin candle and its deterministic facts only. */
function buildPinPayload(symbol, interval, pinBar, pinFacts, evaluationTime) {
    return {
        symbol: symbol,
        interval: interval,
        evaluationTime: evaluationTime,
        evaluationTimeIso: new Date(evaluationTime).toISOString(),
        windowBarCount: 1,
        allowedPattern: 'PIN_BAR',
        bar: {
            openTime: pinBar.openTime,
            closeTime: pinBar.closeTime,
            open: pinBar.open,
            high: pinBar.high,
            low: pinBar.low,
            close: pinBar.close,
            direction: pinFacts.direction,
            range: pinFacts.range,
            body: pinFacts.body,
            bodyRatio: pinFacts.bodyRatio,
            upperTail: pinFacts.upperTail,
            lowerTail: pinFacts.lowerTail,
            upperTailRatio: pinFacts.upperTailRatio,
            lowerTailRatio: pinFacts.lowerTailRatio,
            closeLocation: pinFacts.closeLocation
        }
    };
}

function buildPinUserPrompt(payload) {
    return 'This window contains exactly 1 closed candle. Judge only whether it is a BULLISH PIN BAR.\n'
        + 'The evaluation time is ' + payload.evaluationTime + ' and you have no information after it.\n\n'
        + JSON.stringify(payload, null, 2);
}

function validatePinOutput(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw fail('PIN_OUTPUT_SCHEMA_INVALID');
    var keys = Object.keys(output).sort().join('|');
    if (keys !== 'confidence|direction|label|pattern|reason') throw fail('PIN_OUTPUT_SCHEMA_INVALID');
    if (output.pattern !== 'PIN_BAR') throw fail('PIN_PATTERN_INVALID');
    if (output.direction !== 'BULLISH') throw fail('PIN_DIRECTION_INVALID');
    if (PIN_LABELS.indexOf(output.label) < 0) throw fail('PIN_LABEL_INVALID');
    if (CONFIDENCE.indexOf(output.confidence) < 0) throw fail('PIN_CONFIDENCE_INVALID');
    if (typeof output.reason !== 'string' || !output.reason.trim()) throw fail('PIN_REASON_INVALID');
    return output;
}

/** Research label: bullish pin CLEAR plus a CLEAR preceding bearish leg. */
function isBullishPinContextAligned(pinLabel, context) {
    return pinLabel === 'CLEAR' && context.label === 'CLEAR' && context.detectedDirection === 'BEARISH';
}

var BULLISH_PIN_CONTEXT_SYSTEM_PROMPT = [
    'A BULLISH PIN BAR has ALREADY been confirmed. Do not re-judge whether it is a pin bar.',
    'Your only task is to decide whether a clear BEARISH directional leg existed in the price process',
    'immediately BEFORE the pin bar and continued into or up to it.',
    '',
    'Do NOT ask "are the previous bars a trend". A genuine pin bar may be preceded by a leg that only',
    'formed over the most recent few bars. Ask instead: is there a clear downward leg that runs into or',
    'up to the pin?',
    '',
    'PRECEDING BEARISH LEG:',
    'Price kept pressing toward lower prices into the pin bar. Small bullish pullbacks, inside bars,',
    'dojis and one or two opposite-colour candles are allowed. The recent process as a whole must still',
    'show lower-price progression and bearish directional control.',
    'NOT CLEAR when: sideways; two-way chop; the recent move is actually upward; the down leg ended well',
    'before the pin and price had already turned up; only the bar immediately before the pin dropped;',
    'there is essentially no sustained downward progression.',
    '',
    'Do not require a fixed number of bars and do not count same-colour candles as a rule.',
    'Judge the directional process, not the colour sequence.',
    'If there are too few supplied preceding bars to judge, answer INSUFFICIENT_CONTEXT.',
    '',
    'You are forbidden from introducing any other concept, including but not limited to:',
    'TWO_BAR_REVERSAL, THREE_BAR_REVERSAL, MTR, Wedge, Morning Star, Evening Star, Engulfing, ICT, FVG,',
    'MSS, Displacement, Order Block, Support, Resistance, Trendline, Liquidity, EQH, EQL, future outcome,',
    'profitability.',
    'Do not judge whether the setup will rise or fall, whether it is worth trading, or its win rate.',
    '',
    'You have no information after evaluationTime. Do not infer future price action.',
    '',
    'Return one JSON object and no prose outside it:',
    '{',
    '  "expectedDirection": "BEARISH" | "BULLISH",',
    '  "detectedDirection": "BEARISH" | "BULLISH" | "SIDEWAYS" | "UNCLEAR",',
    '  "label": "CLEAR" | "BORDERLINE" | "NOT_TREND" | "INSUFFICIENT_CONTEXT",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "estimatedLegBars": <integer>,',
    '  "reason": "short explanation"',
    '}'
].join('\n');

// ------------------------------------------------- §7 event identity / dedupe

/**
 * Human-review identity, exactly as specified:
 *   PIN     : symbol + K1.openTime + direction
 *   TWO     : symbol + K1.openTime + K2.openTime + direction
 *   THREE   : symbol + K1.openTime + K2.openTime + K3.openTime + direction
 * Note that the label is deliberately NOT part of the identity, so the same
 * window+direction can never appear twice in the review list.
 */
function eventIdentity(symbol, event) {
    var times = event.bars.map(function (b) { return b.openTime; });
    return [symbol, event.pattern, event.direction].concat(times).join('|');
}

function dedupeEvents(symbol, events) {
    var seen = {};
    var duplicates = 0;
    var out = [];
    events.forEach(function (e) {
        var id = eventIdentity(symbol, e);
        if (seen[id]) { duplicates += 1; return; }
        seen[id] = true;
        out.push(Object.assign({}, e, { eventId: id }));
    });
    return { events: out, duplicateCount: duplicates };
}

// ----------------------------------------------------- §9 human review text

var REVIEW_SECTIONS = [
    { pattern: 'PIN_BAR', label: 'CLEAR', title: 'PIN_BAR | CLEAR' },
    { pattern: 'PIN_BAR', label: 'BORDERLINE', title: 'PIN_BAR | BORDERLINE' },
    { pattern: 'TWO_BAR_REVERSAL', label: 'CLEAR', title: 'TWO_BAR_REVERSAL | CLEAR' },
    { pattern: 'TWO_BAR_REVERSAL', label: 'BORDERLINE', title: 'TWO_BAR_REVERSAL | BORDERLINE' },
    { pattern: 'THREE_BAR_REVERSAL', label: 'CLEAR', title: 'THREE_BAR_REVERSAL | CLEAR' },
    { pattern: 'THREE_BAR_REVERSAL', label: 'BORDERLINE', title: 'THREE_BAR_REVERSAL | BORDERLINE' }
];

function ohlcText(bar) {
    return 'O=' + bar.open + ' H=' + bar.high + ' L=' + bar.low + ' C=' + bar.close;
}

/**
 * Human review text. Times are candle OPEN times in UTC+8, and every bar of the
 * window is listed so a reviewer can find the exact candles in Binance.
 */
function buildHumanReviewText(symbol, interval, events) {
    var lines = [];
    lines.push(symbol + ' ' + interval);
    lines.push('Timezone: UTC+8 / Asia/Shanghai');
    lines.push('Timestamp meaning: 5m candle OPEN TIME');
    lines.push('');
    REVIEW_SECTIONS.forEach(function (section) {
        var rows = events
            .filter(function (e) { return e.pattern === section.pattern && e.label === section.label; })
            .sort(function (a, b) { return a.bars[0].openTime - b.bars[0].openTime; });
        lines.push('');
        lines.push('==============================');
        lines.push(section.title + '  (' + rows.length + ')');
        lines.push('==============================');
        lines.push('');
        if (!rows.length) {
            lines.push('(none)');
            lines.push('');
            return;
        }
        rows.forEach(function (e, i) {
            lines.push('#' + pad3(i + 1));
            lines.push('Direction: ' + e.direction);
            lines.push('Confidence: ' + e.confidence);
            e.bars.forEach(function (b, bi) {
                lines.push('K' + (bi + 1) + ': ' + formatUtc8(b.openTime));
            });
            lines.push('');
            e.bars.forEach(function (b, bi) {
                lines.push('K' + (bi + 1) + ' OHLC: ' + ohlcText(b));
            });
            lines.push('');
        });
    });
    return lines.join('\n');
}

function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n); }

/** Compact console list: every bar's open time, per §10. */
function buildCompactTimeList(events) {
    var lines = [];
    [['PIN_BAR', 'PIN CLEAR'],
        ['TWO_BAR_REVERSAL', 'TWO BAR CLEAR'],
        ['THREE_BAR_REVERSAL', 'THREE BAR CLEAR']].forEach(function (pair) {
        var rows = events
            .filter(function (e) { return e.pattern === pair[0] && e.label === 'CLEAR'; })
            .sort(function (a, b) { return a.bars[0].openTime - b.bars[0].openTime; });
        if (!rows.length) return;
        lines.push(pair[1]);
        rows.forEach(function (e) {
            lines.push(e.bars.map(function (b) { return formatClockUtc8(b.openTime); }).join(' / ')
                + ' ' + e.direction);
        });
        lines.push('');
    });
    return lines.join('\n');
}

// ------------------------------- §17 two-bar context human review text

function contextSectionLines(title, rows, directionLabels) {
    var lines = [];
    lines.push('========================================');
    lines.push(title);
    lines.push('========================================');
    lines.push('');
    if (!rows.length) {
        lines.push('(none)');
        lines.push('');
        return lines;
    }
    rows.forEach(function (e, i) {
        var bullish = e.twoBarDirection === 'BULLISH';
        lines.push('#' + pad3(i + 1));
        lines.push('Confidence: ' + e.context.confidence);
        lines.push('');
        if (e.estimatedLegStartOpenTime !== null) {
            lines.push('Leg approx:');
            lines.push(formatUtc8(e.estimatedLegStartOpenTime));
            lines.push('\u2192');
            lines.push(formatUtc8(e.k1.openTime));
        } else {
            lines.push('Leg approx: (not estimated)');
        }
        lines.push('');
        lines.push('K1 ' + (bullish ? 'BEAR' : 'BULL') + ':');
        lines.push(formatUtc8(e.k1.openTime));
        lines.push('');
        lines.push('K2 ' + (bullish ? 'BULL' : 'BEAR') + ':');
        lines.push(formatUtc8(e.k2.openTime));
        lines.push('');
        lines.push('estimatedLegBars: ' + e.context.estimatedLegBars
            + '  detectedDirection: ' + e.context.detectedDirection);
        lines.push('');
        lines.push('Context reason:');
        lines.push(e.context.reason);
        lines.push('');
    });
    return lines;
}

/**
 * §17 review text: exactly three groups.
 *   A: two-bar CLEAR + preceding leg CLEAR
 *   B: two-bar CLEAR + preceding leg BORDERLINE
 *   C: two-bar CLEAR + preceding NOT_TREND (INSUFFICIENT_CONTEXT listed here too)
 */
function buildTwoBarContextReviewText(symbol, interval, events) {
    var lines = [];
    lines.push(symbol + ' ' + interval);
    lines.push('Timezone: UTC+8 / Asia/Shanghai');
    lines.push('Timestamp meaning: 5m candle OPEN TIME');
    lines.push('Scope: TWO_BAR_REVERSAL only (PIN_BAR and THREE_BAR_REVERSAL are not audited)');
    lines.push('');
    lines.push('=== A. TWO_BAR + PRECEDING TREND CLEAR ===');
    lines.push('');
    var clearRows = events.filter(function (e) { return e.context.label === 'CLEAR'; });
    lines = lines.concat(contextSectionLines('BULLISH TWO_BAR\nPRECEDING BEARISH LEG = CLEAR',
        clearRows.filter(function (e) { return e.twoBarDirection === 'BULLISH'; })));
    lines = lines.concat(contextSectionLines('BEARISH TWO_BAR\nPRECEDING BULLISH LEG = CLEAR',
        clearRows.filter(function (e) { return e.twoBarDirection === 'BEARISH'; })));
    lines.push('=== B. TWO_BAR + PRECEDING TREND BORDERLINE ===');
    lines.push('');
    var borderlineRows = events.filter(function (e) { return e.context.label === 'BORDERLINE'; });
    lines = lines.concat(contextSectionLines('BULLISH TWO_BAR\nPRECEDING BEARISH LEG = BORDERLINE',
        borderlineRows.filter(function (e) { return e.twoBarDirection === 'BULLISH'; })));
    lines = lines.concat(contextSectionLines('BEARISH TWO_BAR\nPRECEDING BULLISH LEG = BORDERLINE',
        borderlineRows.filter(function (e) { return e.twoBarDirection === 'BEARISH'; })));
    lines.push('=== C. TWO_BAR + NOT_TREND ===');
    lines.push('');
    var notTrendRows = events.filter(function (e) {
        return e.context.label === 'NOT_TREND' || e.context.label === 'INSUFFICIENT_CONTEXT';
    });
    lines = lines.concat(contextSectionLines('TWO_BAR CLEAR\nPRECEDING CONTEXT = NOT_TREND',
        notTrendRows));
    return lines.join('\n');
}

/** §19 minimal list: only the aligned CLEAR setups, every bar open time. */
function buildContextCompactList(events) {
    var lines = [];
    [['BULLISH', '=== BULLISH TWO_BAR + CLEAR BEARISH LEG ==='],
        ['BEARISH', '=== BEARISH TWO_BAR + CLEAR BULLISH LEG ===']].forEach(function (pair) {
        var rows = events.filter(function (e) {
            return e.twoBarDirection === pair[0] && e.context.label === 'CLEAR'
                && e.context.detectedDirection === expectedContextDirection(pair[0]);
        }).sort(function (a, b) { return a.k1.openTime - b.k1.openTime; });
        if (!rows.length) return;
        lines.push(pair[1]);
        lines.push('');
        rows.forEach(function (e) {
            lines.push(formatUtc8(e.k1.openTime) + ' / ' + formatClockUtc8(e.k2.openTime));
        });
        lines.push('');
    });
    return lines.join('\n');
}

// -------------------------------------- §16 bullish pin human review text

function pinSectionLines(title, rows) {
    var lines = [];
    lines.push('===================================');
    lines.push(title);
    lines.push('===================================');
    lines.push('');
    if (!rows.length) {
        lines.push('(none)');
        lines.push('');
        return lines;
    }
    rows.forEach(function (e, i) {
        lines.push('#' + pad3(i + 1));
        lines.push('PIN: ' + formatUtc8(e.pin.openTime));
        lines.push('Confidence: ' + e.context.confidence);
        lines.push('Pin confidence: ' + e.pinLabelConfidence + '  Pin body: ' + e.pinBody);
        lines.push('');
        if (e.estimatedLegStartOpenTime !== null) {
            lines.push('Estimated leg:');
            lines.push(formatUtc8(e.estimatedLegStartOpenTime));
            lines.push('\u2192');
            lines.push(formatUtc8(e.pin.openTime));
        } else {
            lines.push('Estimated leg: (not estimated)');
        }
        lines.push('');
        lines.push('PIN OHLC:');
        lines.push('O=' + e.pin.open);
        lines.push('H=' + e.pin.high);
        lines.push('L=' + e.pin.low);
        lines.push('C=' + e.pin.close);
        lines.push('');
        lines.push('Context reason:');
        lines.push(e.context.reason);
        lines.push('');
    });
    return lines;
}

/**
 * §16 review text: three groups.
 *   A: PIN CLEAR + preceding bearish leg CLEAR
 *   B: PIN CLEAR + preceding bearish leg BORDERLINE
 *   C: PIN CLEAR + preceding context NOT_TREND (INSUFFICIENT_CONTEXT listed here too)
 */
function buildBullishPinReviewText(symbol, interval, events) {
    var lines = [];
    lines.push(symbol + ' ' + interval);
    lines.push('Timezone: UTC+8 / Asia/Shanghai');
    lines.push('Timestamp meaning: 5m candle OPEN TIME');
    lines.push('Scope: BULLISH PIN BAR only (bearish pin, TWO_BAR_REVERSAL and THREE_BAR_REVERSAL are not audited)');
    lines.push('');
    lines.push('=== A. PIN CLEAR + PRECEDING BEARISH LEG CLEAR ===');
    lines.push('');
    lines = lines.concat(pinSectionLines('BULLISH PIN\nPRECEDING BEARISH LEG = CLEAR',
        events.filter(function (e) { return e.context.label === 'CLEAR'; })));
    lines.push('=== B. PIN CLEAR + PRECEDING BEARISH LEG BORDERLINE ===');
    lines.push('');
    lines = lines.concat(pinSectionLines('BULLISH PIN\nPRECEDING BEARISH LEG = BORDERLINE',
        events.filter(function (e) { return e.context.label === 'BORDERLINE'; })));
    lines.push('=== C. PIN CLEAR + NOT_TREND ===');
    lines.push('');
    lines = lines.concat(pinSectionLines('BULLISH PIN\nPRECEDING CONTEXT = NOT_TREND',
        events.filter(function (e) {
            return e.context.label === 'NOT_TREND' || e.context.label === 'INSUFFICIENT_CONTEXT';
        })));
    return lines.join('\n');
}

/** §17 minimal list: only the aligned setups, pin open time only. */
function buildBullishPinCompactList(events) {
    var rows = events.filter(function (e) {
        return isBullishPinContextAligned(e.pinLabel, e.context);
    }).sort(function (a, b) { return a.pin.openTime - b.pin.openTime; });
    var lines = [];
    lines.push('=== BULLISH PIN + CLEAR BEARISH LEG ===');
    lines.push('');
    if (!rows.length) {
        lines.push('(none)');
        return lines.join('\n');
    }
    rows.forEach(function (e) { lines.push(formatUtc8(e.pin.openTime)); });
    return lines.join('\n');
}

/** §19 body-colour tally for the aligned setups. Observation only. */
function pinBodyTally(events) {
    var tally = { BULL: 0, BEAR: 0, DOJI: 0 };
    events.filter(function (e) {
        return isBullishPinContextAligned(e.pinLabel, e.context);
    }).forEach(function (e) { tally[e.pinBody] = (tally[e.pinBody] || 0) + 1; });
    return tally;
}

// =============================================== three bar reversal (stage 1)

var THREE_BAR_LABELS = ['CLEAR', 'BORDERLINE', 'NOT_PATTERN'];

var THREE_BAR_SYSTEM_PROMPT = [
    'You classify whether THREE consecutive closed candles form a THREE BAR REVERSAL.',
    '',
    'BULLISH / BOTTOM three-bar reversal:',
    'K1 = a bearish directional bar, K2 = a pause / small / indecisive bar, K3 = a clear bullish',
    'directional bar. Core semantics: bearish control -> hesitation / pause -> bullish takeover.',
    '',
    'BEARISH / TOP three-bar reversal:',
    'K1 = a bullish directional bar, K2 = a pause / small / indecisive bar, K3 = a clear bearish',
    'directional bar. Core semantics: bullish control -> hesitation / pause -> bearish takeover.',
    '',
    'K2 is the middle pause. It does NOT have to be a doji. Any of these are acceptable: a small bullish',
    'bar, a small bearish bar, a doji, a narrow bar, or a visually indecisive bar. The colour is not the',
    'point. The point is that K2 must NOT be the main directional bar of the three-bar structure:',
    'K1 and K3 are the two ends of the reversal.',
    'Do not apply any single ratio as a hard threshold; judge the whole three-bar shape.',
    '',
    'You are forbidden from introducing any other concept, including but not limited to:',
    'PIN_BAR, TWO_BAR_REVERSAL, MTR, Wedge, Morning Star, Evening Star, Engulfing, ICT, FVG, MSS,',
    'Displacement, Order Block, Support, Resistance, Trendline, Liquidity, EQH, EQL, future outcome,',
    'profitability, preceding trend context.',
    'Judge only these three candles. Do not judge whether the setup will rise or fall or whether it is',
    'worth trading.',
    '',
    'You have no information after evaluationTime. Do not infer future price action.',
    '',
    'Return one JSON object and no prose outside it:',
    '{',
    '  "pattern": "THREE_BAR_REVERSAL",',
    '  "direction": "BULLISH" | "BEARISH",',
    '  "label": "CLEAR" | "BORDERLINE" | "NOT_PATTERN",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "reason": "short explanation"',
    '}'
].join('\n');

function validateThreeBarOutput(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw fail('THREE_BAR_OUTPUT_SCHEMA_INVALID');
    var keys = Object.keys(output).sort().join('|');
    if (keys !== 'confidence|direction|label|pattern|reason') throw fail('THREE_BAR_OUTPUT_SCHEMA_INVALID');
    if (output.pattern !== 'THREE_BAR_REVERSAL') throw fail('THREE_BAR_PATTERN_INVALID');
    if (DIRECTIONS.indexOf(output.direction) < 0) throw fail('THREE_BAR_DIRECTION_INVALID');
    if (THREE_BAR_LABELS.indexOf(output.label) < 0) throw fail('THREE_BAR_LABEL_INVALID');
    if (CONFIDENCE.indexOf(output.confidence) < 0) throw fail('THREE_BAR_CONFIDENCE_INVALID');
    if (typeof output.reason !== 'string' || !output.reason.trim()) throw fail('THREE_BAR_REASON_INVALID');
    return output;
}

function buildThreeBarUserPrompt(payload) {
    return 'This window contains exactly 3 closed candles. Judge only whether they form a '
        + 'THREE BAR REVERSAL.\nThe evaluation time is ' + payload.evaluationTime
        + ' and you have no information after it.\n\n' + JSON.stringify(payload, null, 2);
}

/**
 * §14 canonical extreme: bullish uses the lowest low of the three bars, bearish
 * the highest high, and we record which bar carried it.
 */
function canonicalExtremeOf(bars, direction) {
    var want = direction === 'BULLISH' ? 'low' : 'high';
    var best = 0;
    bars.forEach(function (b, i) {
        if (direction === 'BULLISH' ? b.low < bars[best].low : b.high > bars[best].high) best = i;
    });
    return {
        canonicalExtreme: bars[best][want],
        extremeBar: 'K' + (best + 1),
        extremeBarOpenTime: bars[best].openTime
    };
}

/** §15 stage-2 payload: P10..P1 plus K1,K2,K3 only. */
function buildThreeBarContextPayload(symbol, interval, direction, precedingBars,
    k1, k2, k3, precedingFacts, evaluationTime) {
    function slim(b) {
        return { openTime: b.openTime, closeTime: b.closeTime, open: b.open, high: b.high, low: b.low, close: b.close };
    }
    return {
        symbol: symbol,
        interval: interval,
        targetPattern: { type: 'THREE_BAR_REVERSAL', direction: direction, label: 'CLEAR' },
        expectedContextDirection: expectedContextDirection(direction),
        precedingBars: precedingBars.map(function (b) {
            return Object.assign(slim(b), {
                direction: b.close > b.open ? 'BULLISH' : (b.close < b.open ? 'BEARISH' : 'DOJI')
            });
        }),
        k1: slim(k1),
        k2: slim(k2),
        k3: slim(k3),
        precedingFacts: precedingFacts,
        evaluationTime: evaluationTime,
        evaluationTimeIso: new Date(evaluationTime).toISOString()
    };
}

// ------------------------------- §17 three-bar context human review text

/** Research label: CLEAR three-bar plus a CLEAR opposite-direction preceding leg. */
function isThreeBarContextAligned(direction, context) {
    return context.label === 'CLEAR'
        && context.detectedDirection === expectedContextDirection(direction);
}

function threeBarSectionLines(title, rows) {
    var lines = [];
    lines.push('===================================');
    lines.push(title);
    lines.push('===================================');
    lines.push('');
    if (!rows.length) {
        lines.push('(none)');
        lines.push('');
        return lines;
    }
    rows.forEach(function (e, i) {
        var bullish = e.direction === 'BULLISH';
        lines.push('#' + pad3(i + 1));
        lines.push('Confidence: ' + e.context.confidence);
        lines.push('Three-Bar confidence: ' + e.threeBarConfidence + '  K2 body: ' + e.k2Body);
        lines.push('');
        if (e.estimatedLegStartOpenTime !== null) {
            lines.push('Estimated ' + (bullish ? 'bearish' : 'bullish') + ' leg:');
            lines.push(formatUtc8(e.estimatedLegStartOpenTime));
            lines.push('\u2192');
            lines.push(formatUtc8(e.k1.openTime));
        } else {
            lines.push('Estimated leg: (not estimated)');
        }
        lines.push('');
        lines.push('K1 ' + (bullish ? 'BEAR' : 'BULL') + ':');
        lines.push(formatUtc8(e.k1.openTime));
        lines.push('');
        lines.push('K2 PAUSE:');
        lines.push(formatUtc8(e.k2.openTime));
        lines.push('');
        lines.push('K3 ' + (bullish ? 'BULL' : 'BEAR') + ':');
        lines.push(formatUtc8(e.k3.openTime));
        lines.push('');
        lines.push('Extreme:');
        lines.push(e.extremeBar + ' @ ' + formatClockUtc8(e.extremeBarOpenTime));
        lines.push('price = ' + e.canonicalExtreme);
        lines.push('');
        lines.push('Context reason:');
        lines.push(e.context.reason);
        lines.push('');
    });
    return lines;
}

function buildThreeBarContextReviewText(symbol, interval, events) {
    var lines = [];
    lines.push(symbol + ' ' + interval);
    lines.push('Timezone: UTC+8 / Asia/Shanghai');
    lines.push('Timestamp meaning: 5m candle OPEN TIME');
    lines.push('Scope: THREE_BAR_REVERSAL only (PIN_BAR and TWO_BAR_REVERSAL are not audited)');
    lines.push('');
    var aligned = events.filter(function (e) { return isThreeBarContextAligned(e.direction, e.context); });
    var borderline = events.filter(function (e) { return e.context.label === 'BORDERLINE'; });
    var notTrend = events.filter(function (e) {
        return e.context.label === 'NOT_TREND' || e.context.label === 'INSUFFICIENT_CONTEXT';
    });
    lines = lines.concat(threeBarSectionLines('BULLISH THREE_BAR\nPRECEDING BEARISH LEG = CLEAR',
        aligned.filter(function (e) { return e.direction === 'BULLISH'; })));
    lines = lines.concat(threeBarSectionLines('BEARISH THREE_BAR\nPRECEDING BULLISH LEG = CLEAR',
        aligned.filter(function (e) { return e.direction === 'BEARISH'; })));
    lines = lines.concat(threeBarSectionLines('THREE_BAR\nPRECEDING LEG = BORDERLINE', borderline));
    lines = lines.concat(threeBarSectionLines('THREE_BAR\nPRECEDING CONTEXT = NOT_TREND', notTrend));
    return lines.join('\n');
}

/** §18 minimal list: only the aligned setups, all three open times. */
function buildThreeBarCompactList(events) {
    var lines = [];
    [['BULLISH', '=== BULLISH / BOTTOM THREE_BAR + CLEAR BEARISH LEG ==='],
        ['BEARISH', '=== BEARISH / TOP THREE_BAR + CLEAR BULLISH LEG ===']].forEach(function (pair) {
        var rows = events.filter(function (e) {
            return e.direction === pair[0] && isThreeBarContextAligned(e.direction, e.context);
        }).sort(function (a, b) { return a.k1.openTime - b.k1.openTime; });
        if (!rows.length) return;
        lines.push(pair[1]);
        lines.push('');
        rows.forEach(function (e) {
            lines.push(formatUtc8(e.k1.openTime) + ' / ' + formatClockUtc8(e.k2.openTime)
                + ' / ' + formatClockUtc8(e.k3.openTime));
        });
        lines.push('');
    });
    return lines.join('\n');
}

/** §20 observation-only statistics for the aligned setups. */
function threeBarK2Stats(events) {
    var aligned = events.filter(function (e) { return isThreeBarContextAligned(e.direction, e.context); });
    function bodyTally(rows) {
        var t = { BULL: 0, BEAR: 0, DOJI: 0 };
        rows.forEach(function (e) { t[e.k2Body] = (t[e.k2Body] || 0) + 1; });
        return t;
    }
    function extremeTally(rows) {
        var t = { K1: 0, K2: 0, K3: 0 };
        rows.forEach(function (e) { t[e.extremeBar] = (t[e.extremeBar] || 0) + 1; });
        return t;
    }
    var bullish = aligned.filter(function (e) { return e.direction === 'BULLISH'; });
    var bearish = aligned.filter(function (e) { return e.direction === 'BEARISH'; });
    return {
        alignedTotal: aligned.length,
        bullish: { count: bullish.length, k2Body: bodyTally(bullish), extremeBar: extremeTally(bullish) },
        bearish: { count: bearish.length, k2Body: bodyTally(bearish), extremeBar: extremeTally(bearish) }
    };
}

module.exports = {
    VERSION: VERSION,
    CONTEXT_VERSION: CONTEXT_VERSION,
    BAR_MS: BAR_MS,
    REQUIRED_CANDLES: REQUIRED_CANDLES,
    PRECEDING_MAX_BARS: PRECEDING_MAX_BARS,
    PRECEDING_MIN_BARS: PRECEDING_MIN_BARS,
    PATTERNS: PATTERNS,
    WINDOW_PATTERN: WINDOW_PATTERN,
    patternForWindow: patternForWindow,
    DIRECTIONS: DIRECTIONS,
    LABELS: LABELS,
    CONFIDENCE: CONFIDENCE,
    OVERALL: OVERALL,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    round: round,
    candleFacts: candleFacts,
    continuityReport: continuityReport,
    pinCandidates: pinCandidates,
    twoBarCandidates: twoBarCandidates,
    threeBarCandidates: threeBarCandidates,
    pairFacts: pairFacts,
    eventKey: eventKey,
    dedupe: dedupe,
    assertNoFutureData: assertNoFutureData,
    assertWindowWithinConfirmation: assertWindowWithinConfirmation,
    buildUserPayload: buildUserPayload,
    buildUserPrompt: buildUserPrompt,
    validateLlmOutput: validateLlmOutput,
    formatUtc8: formatUtc8,
    formatClockUtc8: formatClockUtc8,
    eventIdentity: eventIdentity,
    dedupeEvents: dedupeEvents,
    buildHumanReviewText: buildHumanReviewText,
    buildCompactTimeList: buildCompactTimeList,
    REVIEW_SECTIONS: REVIEW_SECTIONS,
    CONTEXT_DIRECTIONS: CONTEXT_DIRECTIONS,
    CONTEXT_LABELS: CONTEXT_LABELS,
    CONTEXT_SYSTEM_PROMPT: CONTEXT_SYSTEM_PROMPT,
    wilderAtr14: wilderAtr14,
    buildPrecedingFacts: buildPrecedingFacts,
    expectedContextDirection: expectedContextDirection,
    buildContextPayload: buildContextPayload,
    buildContextUserPrompt: buildContextUserPrompt,
    validateContextOutput: validateContextOutput,
    isContextAligned: isContextAligned,
    estimatedLegStartOpenTime: estimatedLegStartOpenTime,
    buildTwoBarContextReviewText: buildTwoBarContextReviewText,
    buildContextCompactList: buildContextCompactList,
    PIN_LABELS: PIN_LABELS,
    PIN_BODY: PIN_BODY,
    BULLISH_PIN_SYSTEM_PROMPT: BULLISH_PIN_SYSTEM_PROMPT,
    BULLISH_PIN_CONTEXT_SYSTEM_PROMPT: BULLISH_PIN_CONTEXT_SYSTEM_PROMPT,
    pinBodyColor: pinBodyColor,
    buildPinPayload: buildPinPayload,
    buildPinUserPrompt: buildPinUserPrompt,
    validatePinOutput: validatePinOutput,
    isBullishPinContextAligned: isBullishPinContextAligned,
    buildBullishPinReviewText: buildBullishPinReviewText,
    buildBullishPinCompactList: buildBullishPinCompactList,
    pinBodyTally: pinBodyTally,
    THREE_BAR_LABELS: THREE_BAR_LABELS,
    THREE_BAR_SYSTEM_PROMPT: THREE_BAR_SYSTEM_PROMPT,
    validateThreeBarOutput: validateThreeBarOutput,
    buildThreeBarUserPrompt: buildThreeBarUserPrompt,
    canonicalExtremeOf: canonicalExtremeOf,
    buildThreeBarContextPayload: buildThreeBarContextPayload,
    isThreeBarContextAligned: isThreeBarContextAligned,
    buildThreeBarContextReviewText: buildThreeBarContextReviewText,
    buildThreeBarCompactList: buildThreeBarCompactList,
    threeBarK2Stats: threeBarK2Stats
};
