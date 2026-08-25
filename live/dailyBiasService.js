/**
 * Daily Bias V1 service.
 * - evaluates once for each newly observed CLOSED 4H candle
 * - preserves the last valid snapshot on failure
 * - exposes VALID / STALE / UNKNOWN reporting state without changing opportunity decisions
 */
var path = require('path');
var deepseekClient = require('../ai/deepseekClient');
var ictBiasPrompt = require('../ai/ictBiasPrompt');
var biasValidator = require('../ai/biasResponseValidator');
var contextBuilder = require('../ai/dailyBiasContext');
var alignment = require('../bias/dailyBiasAlignment');
var storeModule = require('./dailyBiasStore');

var FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
var EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
var DEFAULT_SKIP_BEIJING_CLOSE_HOURS = [4, 8];

/**
 * Binance candle closeTime is the next interval boundary minus 1ms. Resolve
 * that boundary in Beijing time and only match an exact hour boundary, so
 * arbitrary historical/test timestamps are never mistaken for scheduled 4H
 * closes.
 */
function beijingCloseHour(closeTime) {
    if (typeof closeTime !== 'number' || !isFinite(closeTime)) return null;
    var boundary = new Date(closeTime + 1 + BEIJING_OFFSET_MS);
    if (boundary.getUTCMinutes() !== 0 || boundary.getUTCSeconds() !== 0 || boundary.getUTCMilliseconds() !== 0) return null;
    return boundary.getUTCHours();
}

function shouldSkipDeepSeekAtClose(closeTime, skipHours) {
    var hour = beijingCloseHour(closeTime);
    var hours = skipHours || DEFAULT_SKIP_BEIJING_CLOSE_HOURS;
    return hour !== null && hours.indexOf(hour) >= 0;
}

function defaultRequestBias(symbol, candles, evaluationTime) {
    var context = contextBuilder.buildDailyBiasContext(candles, evaluationTime);
    var userPrompt = ictBiasPrompt.buildUserPrompt({
        symbol: symbol,
        evaluationTime: evaluationTime,
        candles: context.candles,
        confirmedSwings: context.confirmedSwings,
        marketFacts: context.marketFacts
    });
    return deepseekClient.chat({
        systemPrompt: ictBiasPrompt.SYSTEM_PROMPT,
        userPrompt: userPrompt,
        temperature: 0
    }, { maxAttempts: 0 }).then(function (response) {
        var finishReason = response.raw && response.raw.choices && response.raw.choices[0] &&
            response.raw.choices[0].finish_reason;
        if (finishReason === 'length') {
            var truncated = new Error('Daily Bias output truncated at completion token limit');
            truncated.code = 'OUTPUT_TRUNCATED';
            throw truncated;
        }
        var parsed = biasValidator.parseAndValidate(response.text, {
            marketFacts: context.marketFacts
        });
        return {
            bias: parsed.bias,
            confidence: parsed.confidence,
            evaluationTime: evaluationTime,
            biasReason: parsed.biasReason,
            conflicts: parsed.conflicts || [],
            currentDelivery: parsed.delivery && parsed.delivery.currentDelivery || null,
            drawOnLiquidity: parsed.drawOnLiquidity || null,
            structuralState: context.marketFacts.structuralState,
            model: response.raw && response.raw.model || deepseekClient.getModel(),
            apiUsage: response.raw && response.raw.usage || null
        };
    });
}

function latestClosed4h(candles, visibleAt) {
    var boundary = visibleAt !== undefined && visibleAt !== null ? visibleAt : Date.now();
    return (candles || []).filter(function (c) {
        return c.closed && c.closeTime <= boundary;
    })
        .slice().sort(function (a, b) { return b.closeTime - a.closeTime; })[0] || null;
}

function createDailyBiasService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var nowFn = opts.now || Date.now;
    var requestBias = opts.requestBias || defaultRequestBias;
    var skipBeijingCloseHours = opts.skipBeijingCloseHours || DEFAULT_SKIP_BEIJING_CLOSE_HOURS;
    var store = opts.store || storeModule.createDailyBiasStore(
        opts.file || path.join(opts.dataDir || '.live-state', symbol, 'daily-bias.json'), symbol);

    function updateOnClosed4h(candles) {
        var latest = latestClosed4h(candles, nowFn());
        if (!latest) return Promise.resolve({ attempted: false, reason: 'NO_CLOSED_4H' });

        if (shouldSkipDeepSeekAtClose(latest.closeTime, skipBeijingCloseHours)) {
            return Promise.resolve({
                attempted: false,
                reason: 'BEIJING_CLOSE_HOUR_SKIPPED',
                evaluationTime: latest.closeTime,
                beijingCloseHour: beijingCloseHour(latest.closeTime),
                snapshot: store.getSnapshot()
            });
        }

        var lastAttempt = store.getLastAttempt();
        if (lastAttempt && lastAttempt.evaluationTime >= latest.closeTime) {
            return Promise.resolve({ attempted: false, reason: 'ALREADY_ATTEMPTED', snapshot: store.getSnapshot() });
        }

        var attemptedAt = nowFn();
        return Promise.resolve().then(function () {
            return requestBias(symbol, candles, latest.closeTime);
        }).then(function (snapshot) {
            if (!snapshot || ['BULLISH', 'BEARISH', 'UNCLEAR'].indexOf(snapshot.bias) < 0) {
                var invalid = new Error('Daily Bias requester returned invalid bias');
                invalid.code = 'INVALID_DAILY_BIAS';
                throw invalid;
            }
            snapshot.symbol = symbol;
            snapshot.evaluationTime = latest.closeTime;
            snapshot.updatedAt = nowFn();
            store.recordSuccess(snapshot, attemptedAt);
            return { attempted: true, updated: true, snapshot: snapshot };
        }).catch(function (error) {
            store.recordFailure(latest.closeTime, attemptedAt, error);
            return {
                attempted: true,
                updated: false,
                snapshot: store.getSnapshot(),
                error: { code: error.code || 'DAILY_BIAS_ERROR', message: error.message }
            };
        });
    }

    function getDailyBias(opportunityDirection, atTime) {
        var at = atTime !== undefined && atTime !== null ? atTime : nowFn();
        var snapshot = store.getSnapshot();
        if (!snapshot || snapshot.evaluationTime > at) return alignment.unknownDailyBias();

        var ageMs = Math.max(0, at - snapshot.evaluationTime);
        if (ageMs > EIGHT_HOURS_MS) return alignment.unknownDailyBias();

        var lastAttempt = store.getLastAttempt();
        var failedNewerEvaluation = lastAttempt && lastAttempt.status === 'FAILED' &&
            lastAttempt.evaluationTime > snapshot.evaluationTime;
        var status = (failedNewerEvaluation || ageMs > FOUR_HOURS_MS) ? 'STALE' : 'VALID';
        var view = {
            bias: snapshot.bias,
            confidence: snapshot.confidence,
            status: status,
            evaluationTime: snapshot.evaluationTime,
            ageMs: ageMs
        };
        view.alignment = alignment.computeBiasAlignment(view, opportunityDirection);
        return view;
    }

    return {
        updateOnClosed4h: updateOnClosed4h,
        getDailyBias: getDailyBias,
        getState: store.getState,
        getSnapshot: store.getSnapshot
    };
}

module.exports = {
    createDailyBiasService: createDailyBiasService,
    defaultRequestBias: defaultRequestBias,
    latestClosed4h: latestClosed4h,
    beijingCloseHour: beijingCloseHour,
    shouldSkipDeepSeekAtClose: shouldSkipDeepSeekAtClose,
    DEFAULT_SKIP_BEIJING_CLOSE_HOURS: DEFAULT_SKIP_BEIJING_CLOSE_HOURS,
    FOUR_HOURS_MS: FOUR_HOURS_MS,
    EIGHT_HOURS_MS: EIGHT_HOURS_MS
};
