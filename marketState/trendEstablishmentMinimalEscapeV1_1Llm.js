'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var deepseekClient = require('../ai/deepseekClient');
var packetBuilder = require('../research/trend-establishment-minimal-escape-v1-1/lib/trendEstablishmentMinimalEscapeV1_1');

var MODEL = 'deepseek-v4-flash';
var PROMPT_SHA256 = '2b0bf9b6eb60c486fdb896591178c3bee8ae2150f80ed569070fa278521bff50';
var PACKET_SCHEMA_SHA256 = '0794f0c6fcdf0b1c0b6a9a414f8bd97a2be8a7ef71541221f569fde23f70baa2';
var PROMPT = 'You are judging whether a directional trend has become established. The deterministic engine has already identified the candidate direction. Do not choose direction.\n\n' +
    'You are given the minimal current confirmed market structure: the latest two confirmed swing highs, the latest two confirmed swing lows, their directional migration, the short structural leg sequence connecting them, ATR-normalized distances, and a preceding structural envelope when causally available.\n\n' +
    'Directional HH/HL or LH/LL does not automatically equal Trend. A Range can contain a directional local structure. Use the preceding structural envelope to judge whether the current price process shows meaningful directional migration or translation away from the preceding price area. Structural escape is context, not a hard rule. It does not require an explosive breakout, and a pullback need not remain completely outside the old envelope. Gradual but meaningful directional migration may establish Trend. If preceding structural context is unavailable, judge only the supplied local structure and do not infer missing history.\n\n' +
    'If the evidence still looks more like a directional leg inside a broader price area, choose NOT_ESTABLISHED. Otherwise, when the causal evidence is sufficient to describe an active directional price-migration process, choose ESTABLISHED.\n\n' +
    'Return exact JSON with exactly these keys:\n' +
    '{"decision":"ESTABLISHED|NOT_ESTABLISHED","candidateDirection":"BULLISH|BEARISH","primaryReason":"DIRECTIONAL_STRUCTURE_ESTABLISHED|MIGRATION_TOO_WEAK|LOCAL_OSCILLATION|INSUFFICIENT_STRUCTURE","briefReason":"one concise sentence"}\n';

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
if (sha(PROMPT) !== PROMPT_SHA256) throw new Error('MARKET_STATE_LLM1_PROMPT_IDENTITY_MISMATCH');

function strictParse(text, direction) {
    var value;
    try { value = JSON.parse(text); } catch (error) { return null; }
    var keys = ['briefReason', 'candidateDirection', 'decision', 'primaryReason'];
    if (!value || Array.isArray(value) || Object.keys(value).sort().join('|') !== keys.sort().join('|') ||
            typeof value.briefReason !== 'string') return null;
    if (['ESTABLISHED', 'NOT_ESTABLISHED'].indexOf(value.decision) < 0 || value.candidateDirection !== direction) return null;
    if (['DIRECTIONAL_STRUCTURE_ESTABLISHED', 'MIGRATION_TOO_WEAK', 'LOCAL_OSCILLATION',
            'INSUFFICIENT_STRUCTURE'].indexOf(value.primaryReason) < 0) return null;
    return value;
}

function safeWrite(file, value) {
    var text = JSON.stringify(value, null, 2) + '\n';
    if (process.env.DEEPSEEK_API_KEY && text.indexOf(process.env.DEEPSEEK_API_KEY) >= 0) throw new Error('CREDENTIAL_LEAK');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
}

function createDecisionProvider(options) {
    var opts = options || {};
    var directory = opts.storeDirectory;
    var requestSemantic = opts.requestSemantic || function (packetJson) {
        if (deepseekClient.getModel() !== MODEL) throw new Error('MARKET_STATE_LLM1_MODEL_IDENTITY_MISMATCH');
        return deepseekClient.chat({ systemPrompt: PROMPT, userPrompt: packetJson, temperature: 0, maxTokens: 256 },
            { maxAttempts: 0 }).then(function (response) { return { text: response.text, raw: response.raw }; });
    };
    function file(key) { return directory && path.join(directory, key + '.json'); }
    return function decide(packet, direction, evaluationTime) {
        var canonical = packetBuilder.stableJson(packet);
        var packetSHA256 = sha(canonical);
        var requestKey = sha(MODEL + PROMPT_SHA256 + canonical);
        var target = file(requestKey), cached = null;
        if (target && fs.existsSync(target)) cached = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (cached) {
            var cachedParsed = cached.parsedResponse || cached.parsedDecision;
            if (!cachedParsed || cachedParsed.candidateDirection !== direction) throw new Error('MARKET_STATE_LLM1_CACHE_IDENTITY_MISMATCH');
            return Promise.resolve({ response: cachedParsed, requestKey: requestKey, packetSHA256: packetSHA256, source: 'FROZEN_STORE' });
        }
        return Promise.resolve(requestSemantic(canonical, { direction: direction, evaluationTime: evaluationTime }))
            .then(function (raw) {
                var parsed = strictParse(raw.text, direction);
                if (!parsed) throw new Error('MARKET_STATE_LLM1_INVALID_RESPONSE');
                var record = { requestKey: requestKey, evaluationTime: evaluationTime, candidateDirection: direction,
                    packetSHA256: packetSHA256, promptSHA256: PROMPT_SHA256,
                    packetSchemaSHA256: PACKET_SCHEMA_SHA256, model: MODEL,
                    rawResponse: raw.raw || null, parsedResponse: parsed, createdAt: new Date().toISOString() };
                if (target) safeWrite(target, record);
                return { response: parsed, requestKey: requestKey, packetSHA256: packetSHA256, source: 'LLM_FRESH' };
            });
    };
}

module.exports = { MODEL: MODEL, PROMPT: PROMPT, PROMPT_SHA256: PROMPT_SHA256,
    PACKET_SCHEMA_SHA256: PACKET_SCHEMA_SHA256, strictParse: strictParse,
    createDecisionProvider: createDecisionProvider };
