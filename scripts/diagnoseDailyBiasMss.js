#!/usr/bin/env node
'use strict';

/**
 * Read-only Daily Bias MSS response trace.
 *
 * Reuses the production data/context/prompt/API path, but never writes the
 * Daily Bias store. It prints only the authoritative MSS facts, the model's
 * delivery.mss array, and field-level comparisons. API keys, the full prompt,
 * and the full model response are never printed or persisted.
 */
var dataSource = require('../live/dataSource');
var contextBuilder = require('../ai/dailyBiasContext');
var ictBiasPrompt = require('../ai/ictBiasPrompt');
var deepseekClient = require('../ai/deepseekClient');
var biasValidator = require('../ai/biasResponseValidator');

var SYMBOL = process.env.DAILY_BIAS_DIAG_SYMBOL || 'BTCUSDT';
var WARMUP_DAYS = 30;

function toMs(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : null;
}

function sameTime(a, b) {
    var ta = toMs(a), tb = toMs(b);
    return ta !== null && tb !== null && ta === tb;
}

function samePrice(a, b) {
    if (typeof a !== 'number' || !isFinite(a) ||
        typeof b !== 'number' || !isFinite(b)) return false;
    var scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) <= scale * 1e-10;
}

function latestStructuralMss(events) {
    return (events || []).filter(function (event) {
        return event && event.type === 'STRUCTURAL_MSS';
    }).slice().sort(function (a, b) {
        return (toMs(b.confirmedAt) || 0) - (toMs(a.confirmedAt) || 0);
    })[0] || null;
}

function compactAuthoritative(event) {
    if (!event) return null;
    return {
        direction: event.direction,
        referenceLevel: event.referenceLevel,
        eventTime: event.eventTime,
        confirmedAt: event.confirmedAt,
        referenceRole: event.referenceRole || null,
        structuralStateBefore: event.structuralStateBefore || null,
        structuralStateAfter: event.structuralStateAfter || null
    };
}

function compactAiMss(mss) {
    if (!mss || typeof mss !== 'object') return null;
    return {
        type: mss.type,
        brokenSwingPrice: mss.brokenSwingPrice,
        breakTime: mss.breakTime,
        reason: typeof mss.reason === 'string' ? mss.reason : null
    };
}

function compareOne(aiMss, latest, authoritativeEvents) {
    var directionMatch = !!latest && aiMss.type === latest.direction;
    var priceMatch = !!latest && samePrice(aiMss.brokenSwingPrice, latest.referenceLevel);
    var eventTimeMatch = !!latest && sameTime(aiMss.breakTime, latest.eventTime);
    var confirmedAtUsedInstead = !!latest && !eventTimeMatch &&
        sameTime(aiMss.breakTime, latest.confirmedAt);
    var exactAuthoritativeMatch = (authoritativeEvents || []).some(function (event) {
        return aiMss.type === event.direction &&
            samePrice(aiMss.brokenSwingPrice, event.referenceLevel) &&
            sameTime(aiMss.breakTime, event.eventTime);
    });
    return {
        ai: compactAiMss(aiMss),
        againstLatest: {
            directionMatch: directionMatch,
            priceMatch: priceMatch,
            eventTimeMatch: eventTimeMatch,
            confirmedAtUsedInstead: confirmedAtUsedInstead,
            exactLatestMatch: directionMatch && priceMatch && eventTimeMatch
        },
        exactAnyAuthoritativeMatch: exactAuthoritativeMatch
    };
}

function buildComparison(parsed, marketFacts) {
    var events = (marketFacts && marketFacts.structuralEvents || []).filter(function (event) {
        return event.type === 'STRUCTURAL_MSS';
    });
    var latest = latestStructuralMss(events);
    var aiMss = parsed && parsed.delivery && Array.isArray(parsed.delivery.mss)
        ? parsed.delivery.mss : [];
    return {
        authoritativeMssCount: events.length,
        authoritativeLatestMss: compactAuthoritative(latest),
        aiMssCount: aiMss.length,
        aiMssComparisons: aiMss.map(function (mss) {
            return compareOne(mss, latest, events);
        }),
        latestAuthoritativeIncluded: !!latest && aiMss.some(function (mss) {
            return mss.type === latest.direction &&
                samePrice(mss.brokenSwingPrice, latest.referenceLevel) &&
                sameTime(mss.breakTime, latest.eventTime);
        }),
        diagnosis: diagnose(aiMss, latest, events)
    };
}

function diagnose(aiMss, latest, events) {
    if (!latest && aiMss.length === 0) return 'NO_AUTHORITATIVE_MSS_AND_AI_EMPTY';
    if (!latest && aiMss.length > 0) return 'AI_INVENTED_MSS_WITHOUT_AUTHORITATIVE_EVENT';
    if (latest && aiMss.length === 0) return 'AI_OMITTED_LATEST_AUTHORITATIVE_MSS';
    var exact = aiMss.some(function (mss) {
        return mss.type === latest.direction &&
            samePrice(mss.brokenSwingPrice, latest.referenceLevel) &&
            sameTime(mss.breakTime, latest.eventTime);
    });
    var invented = aiMss.some(function (mss) {
        return !(events || []).some(function (event) {
            return mss.type === event.direction &&
                samePrice(mss.brokenSwingPrice, event.referenceLevel) &&
                sameTime(mss.breakTime, event.eventTime);
        });
    });
    if (exact && !invented) return 'MSS_ECHO_VALID';
    if (invented) return 'AI_MSS_FIELD_MISMATCH_OR_INVENTED_EVENT';
    return 'LATEST_AUTHORITATIVE_MSS_OMITTED';
}

function latestClosed4h(candles, now) {
    return (candles || []).filter(function (candle) {
        return candle.closed && candle.closeTime <= now;
    }).slice().sort(function (a, b) {
        return b.closeTime - a.closeTime;
    })[0] || null;
}

function futureLeakDetails(context, evaluationTime) {
    var details = [];
    (context.candles || []).forEach(function (candle) {
        if (candle.closeTime > evaluationTime) {
            details.push({ type: 'CANDLE', closeTime: candle.closeTime });
        }
    });
    (context.marketFacts.structuralEvents || []).forEach(function (event) {
        if (toMs(event.confirmedAt) > evaluationTime) {
            details.push({ type: event.type, confirmedAt: event.confirmedAt });
        }
    });
    return details;
}

function run() {
    return dataSource.fetchInitial(SYMBOL, WARMUP_DAYS).then(function (data) {
        var purity = dataSource.checkFuturesPurity(data);
        if (!purity.ok) {
            var degraded = new Error('DATA_SOURCE_DEGRADED: ' + purity.issues[0]);
            degraded.code = 'DATA_SOURCE_DEGRADED';
            throw degraded;
        }
        var latest = latestClosed4h(data['4h'], Date.now());
        if (!latest) throw new Error('NO_CLOSED_4H');
        var evaluationTime = latest.closeTime;
        var context = contextBuilder.buildDailyBiasContext(data['4h'], evaluationTime);
        var prompt = ictBiasPrompt.buildUserPrompt({
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            candles: context.candles,
            confirmedSwings: context.confirmedSwings,
            marketFacts: context.marketFacts
        });
        return deepseekClient.chat({
            systemPrompt: ictBiasPrompt.SYSTEM_PROMPT,
            userPrompt: prompt,
            temperature: 0
        }, { maxAttempts: 0 }).then(function (response) {
            var parsed;
            try {
                parsed = JSON.parse(response.text);
            } catch (error) {
                var malformed = new Error('MALFORMED_MODEL_JSON: ' + error.message);
                malformed.code = 'MALFORMED_MODEL_JSON';
                throw malformed;
            }
            var validator = { passed: true, code: null, message: null };
            try {
                biasValidator.validate(parsed, { marketFacts: context.marketFacts });
            } catch (error) {
                validator = {
                    passed: false,
                    code: error.code || 'VALIDATION_ERROR',
                    message: error.message
                };
            }
            var future = futureLeakDetails(context, evaluationTime);
            var report = {
                audit: 'Daily Bias MSS Response Trace V1',
                readOnly: true,
                productionStateWritten: false,
                fullPromptPrinted: false,
                fullResponsePrinted: false,
                symbol: SYMBOL,
                model: response.raw && response.raw.model || deepseekClient.getModel(),
                evaluationTime: evaluationTime,
                evaluationTimeIso: new Date(evaluationTime).toISOString(),
                candleCount: context.candles.length,
                candleWindow: {
                    firstOpenTime: new Date(context.candles[0].openTime).toISOString(),
                    lastOpenTime: new Date(context.candles[context.candles.length - 1].openTime).toISOString(),
                    lastCloseTime: new Date(context.candles[context.candles.length - 1].closeTime).toISOString()
                },
                structuralState: context.marketFacts.structuralState,
                comparison: buildComparison(parsed, context.marketFacts),
                validator: validator,
                apiUsage: response.raw && response.raw.usage || null,
                FUTURE_LEAK_VIOLATIONS: future.length,
                futureLeakDetails: future,
                OUTCOME_USED: false,
                PRODUCTION_CHANGED: false
            };
            console.log(JSON.stringify(report, null, 2));
            return report;
        });
    });
}

if (require.main === module) {
    run().catch(function (error) {
        console.error(JSON.stringify({
            audit: 'Daily Bias MSS Response Trace V1',
            readOnly: true,
            error: { code: error.code || 'DIAGNOSTIC_ERROR', message: error.message },
            OUTCOME_USED: false,
            PRODUCTION_CHANGED: false
        }, null, 2));
        process.exitCode = 1;
    });
}

module.exports = {
    toMs: toMs,
    sameTime: sameTime,
    samePrice: samePrice,
    latestStructuralMss: latestStructuralMss,
    buildComparison: buildComparison,
    diagnose: diagnose,
    latestClosed4h: latestClosed4h,
    futureLeakDetails: futureLeakDetails,
    run: run
};
