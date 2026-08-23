#!/usr/bin/env node
'use strict';

/**
 * Read-only Daily Bias MSS response trace.
 *
 * Reuses the production data/context/prompt/API path, but never writes the
 * Daily Bias store. It prints only authoritative MSS facts and the model's
 * structural event references. API keys, the full prompt, and the full model
 * response are never printed or persisted.
 */
var dataSource = require('../live/dataSource');
var contextBuilder = require('../ai/dailyBiasContext');
var ictBiasPrompt = require('../ai/ictBiasPrompt');
var deepseekClient = require('../ai/deepseekClient');
var biasValidator = require('../ai/biasResponseValidator');
var structuralEventReference = require('../ai/structuralEventReference');

var SYMBOL = process.env.DAILY_BIAS_DIAG_SYMBOL || 'BTCUSDT';
var WARMUP_DAYS = 30;

function toMs(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : null;
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
        eventId: structuralEventReference.eventId(event),
        direction: event.direction,
        referenceLevel: event.referenceLevel,
        eventTime: event.eventTime,
        confirmedAt: event.confirmedAt,
        referenceRole: event.referenceRole || null,
        structuralStateBefore: event.structuralStateBefore || null,
        structuralStateAfter: event.structuralStateAfter || null
    };
}

function buildComparison(parsed, marketFacts) {
    var events = (marketFacts && marketFacts.structuralEvents || []).filter(function (event) {
        return event.type === 'STRUCTURAL_MSS';
    });
    var latest = latestStructuralMss(events);
    var delivery = parsed && parsed.delivery || {};
    var references = Array.isArray(delivery.referencedStructuralEventIds)
        ? delivery.referencedStructuralEventIds : [];
    var authoritativeIds = structuralEventReference.mssEventIds(events);
    var unknownReferences = references.filter(function (eventId) {
        return authoritativeIds.indexOf(eventId) < 0;
    });
    var legacyMssFieldPresent = Object.prototype.hasOwnProperty.call(delivery, 'mss');
    return {
        authoritativeMssCount: events.length,
        authoritativeLatestMss: compactAuthoritative(latest),
        authoritativeMssEventIds: authoritativeIds,
        referencedStructuralEventIds: references,
        referencedStructuralEventCount: references.length,
        unknownReferences: unknownReferences,
        legacyMssFieldPresent: legacyMssFieldPresent,
        diagnosis: diagnose(references, authoritativeIds, legacyMssFieldPresent)
    };
}

function diagnose(references, authoritativeIds, legacyMssFieldPresent) {
    if (legacyMssFieldPresent) return 'LEGACY_AI_MSS_FIELD_FORBIDDEN';
    var unknown = (references || []).some(function (eventId) {
        return (authoritativeIds || []).indexOf(eventId) < 0;
    });
    if (unknown) return 'UNKNOWN_AUTHORITATIVE_STRUCTURAL_EVENT_REFERENCE';
    return 'STRUCTURAL_EVENT_REFERENCES_VALID';
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
    latestStructuralMss: latestStructuralMss,
    buildComparison: buildComparison,
    diagnose: diagnose,
    latestClosed4h: latestClosed4h,
    futureLeakDetails: futureLeakDetails,
    run: run
};
