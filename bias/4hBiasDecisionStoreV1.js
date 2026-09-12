'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var semanticContract = require('./4hBiasSemanticV3');

var VERSION = '4H_BIAS_DECISION_FREEZE_V1';
var DECISION_KEY_VERSION = 'DECISION_KEY_V1';
var RECORD_FIELDS = [
    'candle', 'createdAt', 'decision', 'decisionKey', 'facts', 'factsHash', 'factsVersion',
    'modelId', 'promptHash', 'promptVersion', 'symbol', 'version'
];

function fail(code, message, cause) {
    var error = new Error(message || code);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

function canonicalize(value) {
    if (value === null) return null;
    if (typeof value === 'number') {
        if (!isFinite(value)) throw fail('CANONICAL_NON_FINITE_NUMBER');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce(function (result, key) {
            if (typeof value[key] === 'undefined') throw fail('CANONICAL_UNDEFINED_VALUE');
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    throw fail('CANONICAL_VALUE_INVALID');
}

function stableSerialize(value) {
    return JSON.stringify(canonicalize(value));
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function buildCanonicalFacts(spec) {
    var payload = {
        symbol: spec.symbol,
        candle: { openTime: spec.openTime, closeTime: spec.closeTime },
        factsVersion: spec.factsVersion,
        facts: spec.facts
    };
    semanticContract.validateInput({
        symbol: payload.symbol,
        timeframe: '4h',
        closedAt: payload.candle.closeTime,
        facts: payload.facts
    });
    if (typeof payload.candle.openTime !== 'number' || !isFinite(payload.candle.openTime)) {
        throw fail('BIAS_CANDLE_OPEN_TIME_INVALID');
    }
    if (typeof payload.factsVersion !== 'string' || !payload.factsVersion) {
        throw fail('BIAS_FACTS_VERSION_INVALID');
    }
    return canonicalize(payload);
}

function buildIdentity(spec) {
    var canonicalFacts = buildCanonicalFacts(spec);
    var factsJson = stableSerialize(canonicalFacts);
    var identity = canonicalize({
        version: DECISION_KEY_VERSION,
        symbol: spec.symbol,
        candle: canonicalFacts.candle,
        factsHash: sha256(factsJson),
        factsVersion: spec.factsVersion,
        promptHash: spec.promptHash,
        promptVersion: spec.promptVersion,
        modelId: spec.modelId
    });
    ['promptHash', 'promptVersion', 'modelId'].forEach(function (key) {
        if (typeof identity[key] !== 'string' || !identity[key]) throw fail('BIAS_IDENTITY_' + key.toUpperCase() + '_INVALID');
    });
    return {
        canonicalFacts: canonicalFacts,
        canonicalFactsJson: factsJson,
        factsHash: identity.factsHash,
        decisionKeyFields: identity,
        decisionKey: sha256(stableSerialize(identity))
    };
}

function validateDecision(decision) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) ||
        Object.keys(decision).sort().join('|') !== 'confidence|direction|strength') {
        throw fail('BIAS_FROZEN_DECISION_SCHEMA_INVALID');
    }
    if (semanticContract.DIRECTIONS.indexOf(decision.direction) < 0 ||
        semanticContract.STRENGTHS.indexOf(decision.strength) < 0 ||
        semanticContract.CONFIDENCE.indexOf(decision.confidence) < 0) {
        throw fail('BIAS_FROZEN_DECISION_VALUE_INVALID');
    }
    return canonicalize(decision);
}

function createStore(options) {
    var opts = options || {};
    var directory = opts.directory;
    if (!directory) throw fail('BIAS_DECISION_STORE_PATH_REQUIRED');

    function recordPath(decisionKey) {
        if (!/^[a-f0-9]{64}$/.test(decisionKey)) throw fail('BIAS_DECISION_KEY_INVALID');
        return path.join(directory, decisionKey + '.json');
    }

    function validateRecord(record, expected) {
        try {
            if (!record || typeof record !== 'object' || Array.isArray(record) ||
                Object.keys(record).sort().join('|') !== RECORD_FIELDS.slice().sort().join('|')) {
                throw fail('BIAS_RECORD_SCHEMA_INVALID');
            }
            if (record.version !== VERSION || record.decisionKey !== expected.decisionKey) throw fail('BIAS_RECORD_IDENTITY_INVALID');
            var rebuilt = buildIdentity({
                symbol: record.symbol,
                openTime: record.candle && record.candle.openTime,
                closeTime: record.candle && record.candle.closeTime,
                factsVersion: record.factsVersion,
                facts: record.facts,
                promptHash: record.promptHash,
                promptVersion: record.promptVersion,
                modelId: record.modelId
            });
            if (rebuilt.decisionKey !== expected.decisionKey || rebuilt.factsHash !== record.factsHash ||
                stableSerialize(rebuilt.decisionKeyFields) !== stableSerialize(expected.decisionKeyFields)) {
                throw fail('BIAS_RECORD_HASH_MISMATCH');
            }
            if (typeof record.createdAt !== 'number' || !isFinite(record.createdAt)) throw fail('BIAS_RECORD_CREATED_AT_INVALID');
            record.decision = validateDecision(record.decision);
            return canonicalize(record);
        } catch (error) {
            if (error.code === 'BIAS_DECISION_STORE_CORRUPT') throw error;
            throw fail('BIAS_DECISION_STORE_CORRUPT', error.code || error.message, error);
        }
    }

    function lookup(expected) {
        var file = recordPath(expected.decisionKey);
        var text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return { status: 'MISS' };
            throw fail('BIAS_DECISION_STORE_ERROR', error.message, error);
        }
        try {
            return { status: 'HIT', record: validateRecord(JSON.parse(text), expected) };
        } catch (error) {
            if (error.code === 'BIAS_DECISION_STORE_CORRUPT') throw error;
            throw fail('BIAS_DECISION_STORE_CORRUPT', error.message, error);
        }
    }

    function syncDirectory() {
        var handle;
        try {
            handle = fs.openSync(directory, 'r');
            fs.fsyncSync(handle);
        } catch (error) {
            // Windows and a few filesystems do not support fsync on a directory.
            if (error.code !== 'EINVAL' && error.code !== 'EPERM' && error.code !== 'EISDIR') throw error;
        } finally {
            if (handle !== undefined) fs.closeSync(handle);
        }
    }

    function freeze(expected, decision, createdAt) {
        var record = canonicalize({
            version: VERSION,
            decisionKey: expected.decisionKey,
            symbol: expected.decisionKeyFields.symbol,
            candle: expected.decisionKeyFields.candle,
            factsHash: expected.factsHash,
            factsVersion: expected.decisionKeyFields.factsVersion,
            promptHash: expected.decisionKeyFields.promptHash,
            promptVersion: expected.decisionKeyFields.promptVersion,
            modelId: expected.decisionKeyFields.modelId,
            facts: expected.canonicalFacts.facts,
            decision: validateDecision(decision),
            createdAt: createdAt
        });
        var destination = recordPath(expected.decisionKey);
        var temporary;
        try {
            fs.mkdirSync(directory, { recursive: true });
            temporary = path.join(directory, '.' + expected.decisionKey + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
            fs.writeFileSync(temporary, stableSerialize(record) + '\n', { flag: 'wx', mode: 0o600 });
            var handle = fs.openSync(temporary, 'r');
            try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
            try {
                // link is an atomic create-if-absent operation. It never replaces
                // the official record if another process won the race.
                fs.linkSync(temporary, destination);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                return { created: false, record: lookup(expected).record };
            }
            syncDirectory();
            return { created: true, record: lookup(expected).record };
        } catch (error) {
            if (error.code === 'BIAS_DECISION_STORE_CORRUPT') throw error;
            throw fail('BIAS_DECISION_STORE_ERROR', error.message, error);
        } finally {
            if (temporary) {
                try { fs.unlinkSync(temporary); } catch (ignore) {}
            }
        }
    }

    return { directory: directory, lookup: lookup, freeze: freeze, recordPath: recordPath };
}

function createMemoryStore() {
    var records = new Map();
    return {
        directory: null,
        lookup: function (expected) {
            return records.has(expected.decisionKey) ?
                { status: 'HIT', record: canonicalize(records.get(expected.decisionKey)) } : { status: 'MISS' };
        },
        freeze: function (expected, decision, createdAt) {
            if (records.has(expected.decisionKey)) {
                return { created: false, record: canonicalize(records.get(expected.decisionKey)) };
            }
            var record = canonicalize({
                version: VERSION,
                decisionKey: expected.decisionKey,
                symbol: expected.decisionKeyFields.symbol,
                candle: expected.decisionKeyFields.candle,
                factsHash: expected.factsHash,
                factsVersion: expected.decisionKeyFields.factsVersion,
                promptHash: expected.decisionKeyFields.promptHash,
                promptVersion: expected.decisionKeyFields.promptVersion,
                modelId: expected.decisionKeyFields.modelId,
                facts: expected.canonicalFacts.facts,
                decision: validateDecision(decision),
                createdAt: createdAt
            });
            records.set(expected.decisionKey, record);
            return { created: true, record: canonicalize(record) };
        },
        size: function () { return records.size; }
    };
}

module.exports = {
    VERSION: VERSION,
    DECISION_KEY_VERSION: DECISION_KEY_VERSION,
    RECORD_FIELDS: RECORD_FIELDS,
    canonicalize: canonicalize,
    stableSerialize: stableSerialize,
    sha256: sha256,
    buildCanonicalFacts: buildCanonicalFacts,
    buildIdentity: buildIdentity,
    validateDecision: validateDecision,
    createStore: createStore,
    createMemoryStore: createMemoryStore
};
