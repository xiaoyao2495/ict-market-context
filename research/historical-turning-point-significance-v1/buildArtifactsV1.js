'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — research artifact builder.
 *
 * Produces, from real Binance USDⓈ-M 5m futures candles, the frozen research
 * package for the semantic layer:
 *
 *   research-output/historical-turning-point-significance-v1/
 *     PROMPT.md                  frozen prompt + schema, verbatim from the contract
 *     prompt-metadata.json       versions, model, temperature, hashes, enumerations
 *     population-audit.csv       one deterministic fact row per candidate
 *     population-summary.json    population shape (NO strategy conclusions)
 *     review-manifest.csv        40 sealed review charts + blank human labels
 *     manual-review/BLIND-###.svg   review charts (pre-confirmedAt data ONLY)
 *     manual-review/README.md
 *     manual-review/BLIND_REVIEW_INSTRUCTIONS.md
 *     sealed/answer-key.json     withheld identity of every blind chart
 *     audit-manifest.json        sha256 of every produced file + provenance
 *
 * The builder is READ-ONLY with respect to production: it drives the production
 * detector through `lib/prefixReplayV1` and the production facts builder. It owns
 * no threshold and writes no strategy conclusion.
 *
 * Usage:
 *   node research/historical-turning-point-significance-v1/buildArtifactsV1.js
 *   node research/historical-turning-point-significance-v1/buildArtifactsV1.js \
 *        --symbol FILUSDT --cache data-cache/FILUSDT_5m_<start>_<end>.json \
 *        --decisions data/live/turning-point-significance-v1
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var prefixReplay = require(path.join(__dirname, 'lib', 'prefixReplayV1'));
var factsModule = require(path.join(ROOT, 'semantic', 'turningPointSignificanceFactsV1'));
var contract = require(path.join(ROOT, 'semantic', 'turningPointSignificanceSemanticV1'));
var storeModule = require(path.join(ROOT, 'semantic', 'turningPointSignificanceDecisionStoreV1'));

var REVIEW_SAMPLE_SIZE = 40;
var REVIEW_SEED = 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1|REVIEW_4004';
var CHART_LEFT_BARS = 72;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
    return sha256(fs.readFileSync(file));
}

function parseArgs(argv) {
    var args = { symbol: 'BTCUSDT' };
    for (var i = 0; i < argv.length; i++) {
        var token = argv[i];
        if (token === '--symbol') args.symbol = argv[++i];
        else if (token === '--cache') args.cache = argv[++i];
        else if (token === '--decisions') args.decisions = argv[++i];
        else if (token === '--out') args.out = argv[++i];
    }
    return args;
}

function defaultCache(symbol) {
    var dir = path.join(ROOT, 'data-cache');
    if (!fs.existsSync(dir)) throw new Error('DATA_CACHE_DIRECTORY_MISSING');
    var match = fs.readdirSync(dir).filter(function (name) {
        return name.indexOf(symbol + '_5m_') === 0 && /\.json$/.test(name);
    }).map(function (name) {
        return { name: name, bytes: fs.statSync(path.join(dir, name)).size };
    }).sort(function (a, b) { return b.bytes - a.bytes; });
    if (!match.length) {
        throw new Error('NO_5M_CACHE_FOR_' + symbol +
            '（本地无该币种 5m futures 缓存；请在本地终端取数后以 --cache 指定）');
    }
    // Widest available window wins: the population floor (>=100 candidates) is a
    // property of how many bars are replayed, not of the file name.
    return path.join(dir, match[0].name);
}

function readCandles(cachePath) {
    var candles = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!Array.isArray(candles) || !candles.length) throw new Error('CACHE_NOT_A_CANDLE_ARRAY');
    candles.forEach(function (candle, index) {
        if (candle.source !== 'futures') {
            throw new Error('DATA_SOURCE_PURITY_VIOLATION: candle ' + index + ' source=' + candle.source);
        }
        if (index) {
            var gap = candle.openTime - candles[index - 1].openTime;
            if (gap !== 300000) throw new Error('CANDLE_CONTINUITY_VIOLATION at ' + index + ' gap=' + gap);
        }
    });
    return candles;
}

function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function utc8(ms) {
    return ms == null ? null : new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}
function csvCell(value) {
    if (value === null || value === undefined) return '';
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function csvLine(values) { return values.map(csvCell).join(',') + '\n'; }

function seededRandom(seed) {
    var state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
    return function () {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}
function shuffle(items, seed) {
    var result = items.slice();
    var random = seededRandom(seed);
    for (var i = result.length - 1; i > 0; i--) {
        var j = Math.floor(random() * (i + 1));
        var tmp = result[i]; result[i] = result[j]; result[j] = tmp;
    }
    return result;
}

/* ------------------------------------------------------------------ facts */

var FACT_CSV_HEADER = ['turningPointId', 'processId', 'symbol', 'side', 'price', 'selectorPrice',
    'occurredAtUtc', 'confirmedAtUtc', 'confirmedAtMs', 'confirmationBarIndex',
    'atr14AtSelector', 'atr14PctPrice', 'sigma1hAtSelector', 'thetaAtExtreme',
    'incomingMoveAtr', 'incomingEfficiency', 'incomingSpeedAtrPerBar', 'incomingDurationBars',
    'reversalCloseMoveAtr', 'reversalExcursionAtr', 'reversalEfficiency', 'reversalSpeedAtrPerBar',
    'reversalDurationBars', 'displacementSame', 'displacementOpposite',
    'extremeIsCausalPivot', 'pivotRoleAtConfirmation', 'prePivotHighCount', 'prePivotLowCount',
    'turnPivotHighCount', 'turnPivotLowCount', 'newOppositePivotCount', 'newSameDirectionPivotCount',
    'structureDirectionBeforeExtreme', 'structureDirectionAtConfirmation',
    'oppositeStructureBreakOccurred', 'oppositeStructureBreakConfirmedAtUtc',
    'sameDirectionContinuationObservedBeforeConfirmation',
    'factsHash', 'semanticVersion', 'semanticSignificance', 'semanticConfidence',
    'semanticPrimaryReason', 'semanticEligible', 'semanticGateReason', 'semanticErrorCode',
    'promptHash', 'decisionKey'];

function factRow(point, facts, identity) {
    return [identity.turningPointId, facts.turningPoint.processId, identity.symbol, facts.turningPoint.side,
        facts.turningPoint.localizedExtremePrice, facts.turningPoint.selectorClose,
        facts.turningPoint.localizedExtremeOpenTime, facts.turningPoint.confirmedAt,
        identity.confirmedAt, identity.confirmationBarIndex,
        facts.volatility.atr14AtSelector, facts.volatility.atr14PctPrice,
        facts.volatility.sigma1hAtSelector, facts.volatility.thetaAtExtreme,
        facts.incomingProcess.moveAtr, facts.incomingProcess.efficiency,
        facts.incomingProcess.speedAtrPerBar, facts.incomingProcess.durationBars,
        facts.reversalProcess.closeMoveAtr, facts.reversalProcess.excursionAtr,
        facts.reversalProcess.efficiency, facts.reversalProcess.speedAtrPerBar,
        facts.reversalProcess.durationBars,
        facts.displacement.sameDirectionCount, facts.displacement.oppositeDirectionCount,
        facts.pivots.extremeIsCausalPivot, facts.pivots.pivotRoleAtConfirmation,
        facts.pivots.prePivotHighCount, facts.pivots.prePivotLowCount,
        facts.pivots.turnPivotHighCount, facts.pivots.turnPivotLowCount,
        facts.pivots.newOppositePivotCount, facts.pivots.newSameDirectionPivotCount,
        facts.structure.directionBeforeExtreme, facts.structure.directionAtConfirmation,
        facts.structure.oppositeStructureBreakOccurred,
        facts.structure.oppositeStructureBreakConfirmedAt,
        facts.structure.sameDirectionContinuationObservedBeforeConfirmation,
        identity.factsHash, identity.semanticVersion, identity.significance, identity.confidence,
        identity.primaryReason, identity.eligible, identity.gateReason, identity.errorCode,
        identity.promptHash, identity.decisionKey];
}

/* ----------------------------------------------------------------- charts */

function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Review chart for one anchor.
 *
 * HARD CONSTRAINTS (§82):
 *   - the right edge IS the confirmation candle; not one bar after it exists
 *   - no significance / confidence / label is drawn anywhere
 *   - the facts that the model sees are NOT reproduced here; a reviewer must
 *     judge the chart on its own, then be compared against the model
 */
function reviewChartSvg(item) {
    var width = 1280, height = 720, left = 82, right = 28, top = 96, bottom = 118;
    var plotW = width - left - right, plotH = height - top - bottom;
    var candles = item.displayedCandles;
    var lows = candles.map(function (c) { return c.low; }).concat([item.price]);
    var highs = candles.map(function (c) { return c.high; }).concat([item.price]);
    var min = Math.min.apply(Math, lows), max = Math.max.apply(Math, highs);
    var pad = (max - min || 1) * 0.08;
    min -= pad; max += pad;
    function xAt(index) { return left + (index + 0.5) * plotW / candles.length; }
    function yAt(price) { return top + (max - price) / (max - min) * plotH; }
    var bodyW = Math.max(2, Math.min(12, plotW / candles.length * 0.62));
    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
        '" viewBox="0 0 ' + width + ' ' + height +
        '" data-max-displayed-open-time="' + candles[candles.length - 1].openTime +
        '" data-confirmation-candle-open-time="' + item.confirmationCandleOpenTime +
        '" data-future-bars="0" data-label-leak="none">');
    out.push('<rect width="100%" height="100%" fill="#10151d"/>');
    out.push('<text x="' + left + '" y="38" fill="#eef3f8" font-family="sans-serif" font-size="20" font-weight="600">' +
        escapeXml(item.symbol) + ' · 5m · ' + escapeXml(item.blindId) + ' · SWING_' + escapeXml(item.side) + '</text>');
    out.push('<text x="' + left + '" y="62" fill="#9aa9b8" font-family="sans-serif" font-size="13">' +
        'CONFIRMED AT ' + escapeXml(item.confirmedAtUtc8) + ' UTC+8 · right edge is the confirmation candle</text>');
    out.push('<text x="' + left + '" y="82" fill="#9aa9b8" font-family="sans-serif" font-size="13">' +
        'Judge ONLY the intrinsic significance of the marked turning point. No labels, no verdicts, no future bars are shown.</text>');
    for (var g = 0; g <= 4; g++) {
        var gy = top + g * plotH / 4;
        var gp = max - g * (max - min) / 4;
        out.push('<line x1="' + left + '" y1="' + gy.toFixed(2) + '" x2="' + (width - right) + '" y2="' + gy.toFixed(2) + '" stroke="#27313d" stroke-width="1"/>');
        out.push('<text x="' + (left - 8) + '" y="' + (gy + 4).toFixed(2) + '" text-anchor="end" fill="#9aa9b8" font-family="monospace" font-size="12">' + gp.toFixed(2) + '</text>');
    }
    candles.forEach(function (c, index) {
        var x = xAt(index);
        var up = c.close >= c.open;
        var color = up ? '#38b68b' : '#e05d68';
        var yHigh = yAt(c.high), yLow = yAt(c.low), yOpen = yAt(c.open), yClose = yAt(c.close);
        out.push('<g data-candle-open-time="' + c.openTime + '"><line x1="' + x.toFixed(2) + '" y1="' + yHigh.toFixed(2) +
            '" x2="' + x.toFixed(2) + '" y2="' + yLow.toFixed(2) + '" stroke="' + color + '" stroke-width="1.4"/>');
        out.push('<rect x="' + (x - bodyW / 2).toFixed(2) + '" y="' + Math.min(yOpen, yClose).toFixed(2) +
            '" width="' + bodyW.toFixed(2) + '" height="' + Math.max(1, Math.abs(yOpen - yClose)).toFixed(2) +
            '" fill="' + color + '"/></g>');
    });
    var confirmX = xAt(candles.length - 1);
    out.push('<line x1="' + confirmX.toFixed(2) + '" y1="' + top + '" x2="' + confirmX.toFixed(2) +
        '" y2="' + (top + plotH) + '" stroke="#c3cad3" stroke-width="2" stroke-dasharray="6 5"/>');
    var markerIndex = item.markerIndex;
    if (markerIndex < 0 || markerIndex >= candles.length) throw new Error('MARKER_NOT_VISIBLE_' + item.blindId);
    var markerX = xAt(markerIndex), markerY = yAt(item.price);
    out.push('<circle cx="' + markerX.toFixed(2) + '" cy="' + markerY.toFixed(2) + '" r="6" fill="#57a6ff" stroke="#f7fafc" stroke-width="2"/>');
    out.push('<line x1="' + markerX.toFixed(2) + '" y1="' + (markerY + 9).toFixed(2) + '" x2="' + markerX.toFixed(2) +
        '" y2="' + (top + plotH + 8) + '" stroke="#57a6ff" stroke-width="1.5" stroke-dasharray="4 4"/>');
    out.push('<text x="' + left + '" y="' + (height - bottom + 36) + '" fill="#57a6ff" font-family="sans-serif" font-size="15" font-weight="600">' +
        'MARKED TURNING POINT · ' + escapeXml(utc8(item.occurredAt)) + ' UTC+8 · ' + item.price + '</text>');
    out.push('<text x="' + left + '" y="' + (height - bottom + 62) + '" fill="#8594a4" font-family="sans-serif" font-size="13">' +
        'Detection is already confirmed and frozen. Your task is significance only — never re-place, move or re-price the point.</text>');
    out.push('<text x="' + (width - right) + '" y="' + (height - 18) + '" text-anchor="end" fill="#8594a4" font-family="sans-serif" font-size="12">' +
        'candle labels use open time · pre-confirmation data only</text>');
    out.push('</svg>');
    return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------- main */

function main() {
    var args = parseArgs(process.argv.slice(2));
    var cachePath = args.cache ? path.resolve(args.cache) : defaultCache(args.symbol);
    var outDir = args.out ? path.resolve(args.out)
        : path.join(ROOT, 'research-output', 'historical-turning-point-significance-v1');
    var manualDir = path.join(outDir, 'manual-review');
    var sealedDir = path.join(outDir, 'sealed');
    [outDir, manualDir, sealedDir].forEach(function (dir) { fs.mkdirSync(dir, { recursive: true }); });

    var candles = readCandles(cachePath);
    var replay = prefixReplay.runPrefixReplay(candles, { symbol: args.symbol });
    if (!replay.dynamicDPoints.length) throw new Error('EMPTY_DYNAMIC_D_POPULATION');

    // Frozen decisions, when a live store exists, are joined read-only. An absent
    // store simply leaves the semantic columns blank — never fabricated.
    //
    // A frozen decision file nests the model's four-field verdict under
    // `record.decision`; eligibility is NOT stored, it is derived by re-running
    // the frozen canary gate over the stored verdict. Both facts are honoured here
    // so the research package reports the same answer the production seam would.
    var decisions = {};
    if (args.decisions) {
        var store = storeModule.createStore({ directory: path.resolve(args.decisions) });
        store.listDecisionRecords().forEach(function (record) {
            if (!record || !record.turningPointId) return;
            var verdict = record.decision || null;
            var gate = verdict ? contract.evaluateGate(verdict) : { result: 'BLOCK', reason: 'TURNING_SIGNIFICANCE_DECISION_ABSENT' };
            decisions[record.turningPointId] = {
                semanticVersion: record.semanticVersion,
                significance: verdict ? verdict.significance : null,
                confidence: verdict ? verdict.confidence : null,
                primaryReason: verdict ? verdict.primaryReason : null,
                eligible: gate.result === 'PASS',
                gateReason: gate.result === 'PASS' ? null : gate.reason,
                errorCode: null,
                factsHash: record.factsHash,
                promptHash: record.promptHash,
                decisionKey: record.decisionKey
            };
        });
    }

    var reviewPicks = shuffle(replay.dynamicDPoints, REVIEW_SEED).slice(0, REVIEW_SAMPLE_SIZE)
        .sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    var reviewIds = {};
    reviewPicks.forEach(function (point) { reviewIds[point.id] = true; });

    // ONE checkpointed pass over every candidate. Snapshotting inside the single
    // replay is O(N); re-running the whole replay per candidate would be O(N * P)
    // and is exactly the accidental quadratic that OOMs on a 17k-bar series.
    var allTimes = replay.dynamicDPoints.map(function (point) { return point.confirmedAt; });
    var snapshots = prefixReplay.runPrefixReplay(candles, { symbol: args.symbol, checkpoints: allTimes }).checkpoints;

    var rows = [FACT_CSV_HEADER.slice()];
    var reviewFacts = {};
    replay.dynamicDPoints.forEach(function (point) {
        var snapshot = snapshots[point.confirmedAt];
        if (!snapshot) throw new Error('CHECKPOINT_MISSING_' + point.id);
        var facts = factsModule.buildCanonicalFacts({ candidate: point, candles: snapshot.candles,
            swings: snapshot.swings, displacements: snapshot.displacements });
        var serialized = contract.stableSerialize(facts);
        if (reviewIds[point.id]) reviewFacts[point.id] = { facts: facts, snapshot: snapshot, serialized: serialized };
        var decision = decisions[point.id] || null;
        rows.push(factRow(point, facts, {
            turningPointId: point.id,
            symbol: point.symbol,
            confirmedAt: point.confirmedAt,
            confirmationBarIndex: point.confirmationBarIndex,
            factsHash: sha256(serialized),
            semanticVersion: decision ? decision.semanticVersion : null,
            significance: decision ? decision.significance : null,
            confidence: decision ? decision.confidence : null,
            primaryReason: decision ? decision.primaryReason : null,
            eligible: decision ? decision.eligible === true : null,
            gateReason: decision ? decision.gateReason : null,
            errorCode: decision ? decision.errorCode : null,
            promptHash: contract.PROMPT_SHA256,
            decisionKey: decision ? decision.decisionKey : null
        }));
    });
    fs.writeFileSync(path.join(outDir, 'population-audit.csv'), rows.map(function (row) { return csvLine(row); }).join(''), 'utf8');

    /* Review charts. */
    var manifest = [['blindId', 'symbol', 'side', 'confirmedAtUtc', 'confirmedAtUtc8',
        'displayStartIndex', 'displayEndIndex', 'candleCount', 'futureBars', 'svgPath', 'svgSha256',
        'reviewer_significance', 'reviewer_confidence', 'reviewer_primaryReason', 'reviewer_notes']];
    var answerKey = [];
    reviewPicks.forEach(function (point, index) {
        var cached = reviewFacts[point.id];
        if (!cached) throw new Error('REVIEW_FACTS_MISSING_' + point.id);
        var snapshot = cached.snapshot;
        var markerIndex = snapshot.candles.findIndex(function (candle) { return candle.openTime === point.occurredAt; });
        if (markerIndex < 0) throw new Error('MARKER_CANDLE_NOT_IN_PREFIX_' + point.id);
        var leftIndex = Math.max(0, markerIndex - CHART_LEFT_BARS);
        var displayed = snapshot.candles.slice(leftIndex);
        if (displayed[displayed.length - 1].closeTime !== point.confirmedAt) {
            throw new Error('CHART_RIGHT_EDGE_IS_NOT_CONFIRMATION_' + point.id);
        }
        var blindId = 'BLIND-' + String(index + 1).padStart(3, '0');
        var svg = reviewChartSvg({
            blindId: blindId, symbol: point.symbol, side: point.pointSide,
            confirmedAtUtc: iso(point.confirmedAt), confirmedAtUtc8: utc8(point.confirmedAt),
            confirmationCandleOpenTime: displayed[displayed.length - 1].openTime,
            displayedCandles: displayed, markerIndex: markerIndex - leftIndex,
            price: point.price, occurredAt: point.occurredAt
        });
        var file = path.join(manualDir, blindId + '.svg');
        fs.writeFileSync(file, svg, 'utf8');
        manifest.push([blindId, point.symbol, point.pointSide, iso(point.confirmedAt), utc8(point.confirmedAt),
            leftIndex, snapshot.candles.length - 1, displayed.length, 0,
            path.relative(outDir, file), sha256(svg), '', '', '', '']);
        var decision = decisions[point.id] || null;
        answerKey.push({
            blindId: blindId, turningPointId: point.id, processId: point.processId,
            symbol: point.symbol, side: point.pointSide, price: point.price,
            occurredAt: point.occurredAt, occurredAtUtc: iso(point.occurredAt),
            confirmedAt: point.confirmedAt, confirmedAtUtc: iso(point.confirmedAt),
            confirmationBarIndex: point.confirmationBarIndex,
            factsHash: sha256(cached.serialized),
            semanticVersion: decision ? decision.semanticVersion : null,
            significance: decision ? decision.significance : null,
            confidence: decision ? decision.confidence : null,
            primaryReason: decision ? decision.primaryReason : null,
            eligible: decision ? decision.eligible === true : null,
            gateReason: decision ? decision.gateReason : null,
            evidence: decision ? decision.evidence : null,
            counterEvidence: decision ? decision.counterEvidence : null,
            decisionKey: decision ? decision.decisionKey : null
        });
    });
    fs.writeFileSync(path.join(outDir, 'review-manifest.csv'),
        manifest.map(function (row) { return csvLine(row); }).join(''), 'utf8');
    fs.writeFileSync(path.join(sealedDir, 'answer-key.json'),
        JSON.stringify({ sealed: true, note: 'Do not open before human review is complete.',
            reviewSeed: REVIEW_SEED, sampleSize: REVIEW_SAMPLE_SIZE, cases: answerKey }, null, 2) + '\n', 'utf8');

    /* Population summary. Descriptive statistics only — no strategy conclusion. */
    var bySide = { HIGH: 0, LOW: 0 };
    var labelled = { SIGNIFICANT: 0, VALID: 0, WEAK: 0, UNCLEAR: 0 };
    var confidence = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    var confidenceLabelCross = {};
    var sideCross = {};
    var eligibleCount = 0, blockedCount = 0, unlabelled = 0;
    replay.dynamicDPoints.forEach(function (point) {
        bySide[point.pointSide] = (bySide[point.pointSide] || 0) + 1;
        var decision = decisions[point.id];
        if (!decision) { unlabelled += 1; return; }
        if (labelled[decision.significance] !== undefined) labelled[decision.significance] += 1;
        if (confidence[decision.confidence] !== undefined) confidence[decision.confidence] += 1;
        var key = decision.significance + '/' + decision.confidence;
        confidenceLabelCross[key] = (confidenceLabelCross[key] || 0) + 1;
        var sideKey = point.pointSide + ' ' + key;
        sideCross[sideKey] = (sideCross[sideKey] || 0) + 1;
        if (decision.eligible === true) eligibleCount += 1; else blockedCount += 1;
    });
    var significantHigh = confidenceLabelCross['SIGNIFICANT/HIGH'] || 0;
    var validHigh = confidenceLabelCross['VALID/HIGH'] || 0;
    var highQualified = significantHigh + validHigh;
    var summary = {
        semanticVersion: contract.VERSION,
        generatedAt: new Date().toISOString(),
        symbol: args.symbol,
        source: {
            role: 'PRIMARY_SOURCE',
            venue: 'Binance USDⓈ-M Futures (fapi.binance.com)',
            cache: path.relative(ROOT, cachePath),
            cacheSha256: sha256File(cachePath),
            candleCount: candles.length,
            firstOpenTimeUtc: iso(candles[0].openTime),
            lastCloseTimeUtc: iso(candles[candles.length - 1].closeTime),
            purityNote: 'Every candle is source=futures and continuous 5m. No spot-mirror bar enters this population.'
        },
        population: {
            dynamicDCandidates: replay.dynamicDPoints.length,
            productionEqEvents: replay.equalLiquidity.length,
            confirmedSwings: replay.swings.length,
            bySide: bySide
        },
        semantic: {
            decisionsJoinedFrom: args.decisions ? path.relative(ROOT, path.resolve(args.decisions)) : null,
            labelled: replay.dynamicDPoints.length - unlabelled,
            unlabelled: unlabelled,
            labelDistribution: labelled,
            confidenceDistribution: confidence,
            confidenceLabelCross: confidenceLabelCross,
            sideCross: sideCross,
            highConfidence: confidence.HIGH,
            significantHigh: significantHigh,
            validHigh: validHigh,
            highQualified: highQualified,
            highQualifiedRatio: (replay.dynamicDPoints.length - unlabelled) > 0
                ? highQualified / (replay.dynamicDPoints.length - unlabelled) : null,
            eligibleAnchors: eligibleCount,
            blockedAnchors: blockedCount
        },
        reviewPackage: {
            sampleSize: REVIEW_SAMPLE_SIZE,
            reviewSeed: REVIEW_SEED,
            charts: reviewPicks.length,
            chartLeftBars: CHART_LEFT_BARS,
            futureBarsInCharts: 0
        },
        sampleSizeNote: replay.dynamicDPoints.length < 100
            ? 'POPULATION_BELOW_100_CANDIDATES — additional symbols/dates are required before any distribution is read.'
            : 'Population meets the >=100 candidate floor for a descriptive audit.',
        // Descriptive anomaly flags only. §7 of the task forbids any automatic
        // prompt change in response to distribution shape, so these are recorded,
        // never acted on.
        anomalyFlags: {
            singleLabelPopulation: (function () {
                var present = ['SIGNIFICANT', 'VALID', 'WEAK', 'UNCLEAR'].filter(function (l) { return labelled[l] > 0; });
                return present.length === 1 ? 'ALL_DECISIONS_SHARE_ONE_LABEL:' + present[0] : null;
            })(),
            zeroHighConfidence: confidence.HIGH === 0 && (replay.dynamicDPoints.length - unlabelled) > 0,
            zeroEligibleAnchors: eligibleCount === 0 && (replay.dynamicDPoints.length - unlabelled) > 0,
            note: 'These flags are REPORTED ONLY. No prompt, schema, threshold or gate is modified in response.'
        },
        strategyConclusion: 'NOT_DRAWN — this package describes population shape and semantic agreement only.'
    };
    fs.writeFileSync(path.join(outDir, 'population-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

    /* Frozen prompt, printed straight from the contract so it cannot drift. */
    var promptDoc = [
        '# ' + contract.PROMPT_VERSION,
        '',
        '- semanticVersion: `' + contract.VERSION + '`',
        '- model: `' + contract.MODEL + '` (response alias `' + contract.RESPONSE_MODEL_ALIAS + '`)',
        '- temperature: `' + contract.TEMPERATURE + '`',
        '- PROMPT_SHA256: `' + contract.PROMPT_SHA256 + '`',
        '- SCHEMA_SHA256: `' + contract.SCHEMA_SHA256 + '`',
        '',
        '## System prompt',
        '',
        '```text',
        contract.SYSTEM_PROMPT,
        '```',
        '',
        '## User prefix',
        '',
        '```text',
        contract.USER_PREFIX.trimEnd(),
        '```',
        '',
        '## Full template',
        '',
        '```text',
        contract.PROMPT_TEMPLATE,
        '```',
        '',
        '## Output schema',
        '',
        '```json',
        JSON.stringify(contract.SCHEMA, null, 2),
        '```',
        '',
        '## Enumerations',
        '',
        '- significance: ' + contract.SIGNIFICANCE.join(' | '),
        '- confidence: ' + contract.CONFIDENCE.join(' | '),
        '- primaryReason: ' + contract.REASONS.join(' | '),
        '',
        '## Gate',
        '',
        '`evaluateGate` returns PASS only for `(SIGNIFICANT|VALID) + HIGH`. A WEAK/UNCLEAR label is',
        'blocked by the label first, then by confidence. Only PASS anchors become',
        '`LLM_QUALIFIED_HISTORICAL_ANCHOR`.',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(outDir, 'PROMPT.md'), promptDoc, 'utf8');

    fs.writeFileSync(path.join(outDir, 'prompt-metadata.json'), JSON.stringify({
        semanticVersion: contract.VERSION,
        promptVersion: contract.PROMPT_VERSION,
        model: contract.MODEL,
        responseModelAlias: contract.RESPONSE_MODEL_ALIAS,
        temperature: contract.TEMPERATURE,
        maxTokens: contract.MAX_TOKENS,
        promptSha256: contract.PROMPT_SHA256,
        schemaSha256: contract.SCHEMA_SHA256,
        outputKeys: contract.OUTPUT_KEYS,
        significance: contract.SIGNIFICANCE,
        confidence: contract.CONFIDENCE,
        primaryReason: contract.REASONS,
        gateRule: '(SIGNIFICANT|VALID) + HIGH => LLM_QUALIFIED_HISTORICAL_ANCHOR',
        detectionOwnership: 'UNCHANGED — Dynamic-D + SAME_PROCESS_WICK_V1 remain deterministic and frozen.',
        llmForbidden: ['discover turning points', 'create turning points', 'move turning points',
            'modify prices, times or wicks', 'change Dynamic-D process / theta / wick',
            'change 2L/2R', 'decide Entry / SL / TP / sizing / orders'],
        failClosed: true,
        requiredConfidence: 'HIGH',
        allowedLabels: ['SIGNIFICANT', 'VALID']
    }, null, 2) + '\n', 'utf8');

    fs.writeFileSync(path.join(manualDir, 'README.md'), [
        '# ' + contract.VERSION + ' — manual review package',
        '',
        'Open `BLIND-001.svg` … `BLIND-040.svg` in a browser. Each chart shows a',
        'confirmed Dynamic-D turning point marked in blue.',
        '',
        '- The right edge of every chart IS the confirmation candle. There is not one',
        '  bar of future data in this directory.',
        '- No label, verdict, confidence or reason is drawn on any chart.',
        '- Detection is frozen: you are asked to judge **intrinsic significance only**.',
        '',
        'Fill in `../review-manifest.csv` (reviewer_significance / reviewer_confidence /',
        'reviewer_primaryReason / reviewer_notes). The withheld identity and the model',
        'verdict live in `../sealed/answer-key.json` — do not open it before you finish.',
        ''
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(manualDir, 'BLIND_REVIEW_INSTRUCTIONS.md'), [
        '# Blind review instructions',
        '',
        'For each chart, answer one question:',
        '',
        '> As of the confirmation candle, is this turning point intrinsically',
        '> significant enough to be preserved as a historical market anchor?',
        '',
        'Judge the anchor itself, not the current market and not what happened later.',
        '',
        '| field | allowed values |',
        '|---|---|',
        '| reviewer_significance | ' + contract.SIGNIFICANCE.join(' / ') + ' |',
        '| reviewer_confidence | ' + contract.CONFIDENCE.join(' / ') + ' |',
        '| reviewer_primaryReason | ' + contract.REASONS.join(' / ') + ' |',
        '| reviewer_notes | free text |',
        '',
        'Definitions:',
        '',
        '- **SIGNIFICANT** — an independent, meaningful directional turn.',
        '- **VALID** — a genuine turn, real but less consequential.',
        '- **WEAK** — a real excursion with no independent directional meaning.',
        '- **UNCLEAR** — the visible evidence does not settle it.',
        '',
        'Only `(SIGNIFICANT|VALID) + HIGH` would qualify an anchor in production.',
        ''
    ].join('\n'), 'utf8');

    /* Manifest of everything produced, with hashes. */
    // Not part of the sealed package: the manifest cannot hash itself, and the
    // offline DRY-RUN self-check outputs are local diagnostics whose whole point
    // is to be produced outside the delivered package.
    var NOT_IN_PACKAGE = ['audit-manifest.json', 'smoke-report.dry-run.json', 'SMOKE_REPORT.dry-run.md'];
    var files = [];
    (function walk(dir) {
        fs.readdirSync(dir).sort().forEach(function (name) {
            var full = path.join(dir, name);
            var stat = fs.statSync(full);
            if (stat.isDirectory()) walk(full);
            else if (NOT_IN_PACKAGE.indexOf(path.basename(full)) < 0) {
                files.push({ path: path.relative(outDir, full), bytes: stat.size, sha256: sha256File(full) });
            }
        });
    })(outDir);
    fs.writeFileSync(path.join(outDir, 'audit-manifest.json'), JSON.stringify({
        semanticVersion: contract.VERSION,
        promptVersion: contract.PROMPT_VERSION,
        promptSha256: contract.PROMPT_SHA256,
        schemaSha256: contract.SCHEMA_SHA256,
        generatedAt: new Date().toISOString(),
        symbol: args.symbol,
        sourceCache: path.relative(ROOT, cachePath),
        sourceCacheSha256: sha256File(cachePath),
        detectorPath: 'research/historical-turning-point-significance-v1/lib/prefixReplayV1.js',
        detectorNote: 'reuses replay/replayState + events/displacementDetector; owns no threshold',
        reviewSeed: REVIEW_SEED,
        files: files
    }, null, 2) + '\n', 'utf8');

    console.log('symbol=' + args.symbol + ' candles=' + candles.length +
        ' candidates=' + replay.dynamicDPoints.length + ' charts=' + reviewPicks.length);
    console.log('out=' + outDir);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error('BUILD_FAILED ' + (error && error.message));
        process.exitCode = 1;
    }
}

module.exports = { main: main, reviewChartSvg: reviewChartSvg, FACT_CSV_HEADER: FACT_CSV_HEADER };
