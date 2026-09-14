'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var contract = require('./eqFvgAssociationSemanticV1');

var VERSION = 'EQ_FVG_ASSOCIATION_FROZEN_STORE_V1';

function fail(code, cause) { var error = new Error(cause && cause.message || code); error.code = code; error.cause = cause; return error; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function buildIdentity(spec) {
    if (!spec || !spec.symbol || !spec.eqId || !spec.fvgId) throw fail('EQ_FVG_IDENTITY_SOURCE_INVALID');
    var canonicalFacts = contract.canonicalize(spec.facts);
    var factsHash = contract.sha256(contract.stableSerialize(canonicalFacts));
    var fields = contract.canonicalize({ semanticVersion: spec.semanticVersion, symbol: spec.symbol,
        eqId: spec.eqId, fvgId: spec.fvgId, factsHash: factsHash,
        promptHash: spec.promptHash, promptVersion: spec.promptVersion, requestedModelId: spec.requestedModelId });
    Object.keys(fields).forEach(function (key) {
        if (fields[key] == null || fields[key] === '') throw fail('EQ_FVG_IDENTITY_' + key.toUpperCase() + '_INVALID');
    });
    return { canonicalFacts: canonicalFacts, factsHash: factsHash, decisionKeyFields: fields,
        decisionKey: contract.sha256(contract.stableSerialize(fields)) };
}

function createStore(options) {
    var directory = options && options.directory;
    if (!directory) throw fail('EQ_FVG_STORE_PATH_REQUIRED');
    var rawDirectory = path.join(directory, 'raw-responses');
    var decisionDirectory = path.join(directory, 'decisions');
    function checkedKey(key) { if (!/^[a-f0-9]{64}$/.test(key)) throw fail('EQ_FVG_DECISION_KEY_INVALID'); return key; }
    function rawPath(key) { return path.join(rawDirectory, checkedKey(key) + '.json'); }
    function decisionPath(key) { return path.join(decisionDirectory, checkedKey(key) + '.json'); }
    function read(file, corruptCode) {
        try { return { status: 'HIT', record: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
        catch (error) { if (error.code === 'ENOENT') return { status: 'MISS' }; throw fail(corruptCode, error); }
    }
    function atomicCreate(file, record) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        var temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
        try {
            fs.writeFileSync(temporary, contract.stableSerialize(record) + '\n', { flag: 'wx', mode: 0o600 });
            var handle = fs.openSync(temporary, 'r+');
            try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
            try { fs.linkSync(temporary, file); return true; }
            catch (error) { if (error.code === 'EEXIST') return false; throw error; }
        } finally { try { fs.unlinkSync(temporary); } catch (ignore) {} }
    }
    function validateRaw(record, expected) {
        if (!record || record.version !== VERSION || record.decisionKey !== expected.decisionKey ||
                record.factsHash !== expected.factsHash ||
                record.requestedModelId !== expected.decisionKeyFields.requestedModelId ||
                typeof record.rawContent !== 'string' ||
                contract.sha256(record.rawContent) !== record.rawContentSha256) throw fail('EQ_FVG_RAW_STORE_CORRUPT');
        return record;
    }
    function validateFrozen(record, expected) {
        if (!record || record.version !== VERSION || record.decisionKey !== expected.decisionKey ||
                record.factsHash !== expected.factsHash || record.promptHash !== expected.decisionKeyFields.promptHash ||
                record.requestedModelId !== expected.decisionKeyFields.requestedModelId ||
                record.eqId !== expected.decisionKeyFields.eqId || record.fvgId !== expected.decisionKeyFields.fvgId ||
                contract.sha256(contract.stableSerialize(record.facts)) !== record.factsHash) {
            throw fail('EQ_FVG_DECISION_STORE_CORRUPT');
        }
        contract.validateDecision(record.decision);
        return record;
    }
    function lookupRaw(expected) {
        var result = read(rawPath(expected.decisionKey), 'EQ_FVG_RAW_STORE_CORRUPT');
        if (result.status === 'HIT') result.record = validateRaw(result.record, expected);
        return result;
    }
    function lookup(expected) {
        var result = read(decisionPath(expected.decisionKey), 'EQ_FVG_DECISION_STORE_CORRUPT');
        if (result.status === 'HIT') result.record = validateFrozen(result.record, expected);
        return result;
    }
    function persistRaw(expected, response, receivedAt) {
        var rawContent = response.rawContent;
        var record = contract.canonicalize({ version: VERSION, decisionKey: expected.decisionKey,
            factsHash: expected.factsHash, requestedModelId: expected.decisionKeyFields.requestedModelId,
            rawResponseModelId: response.rawResponseModelId, normalizedModelIdentity: response.normalizedModelIdentity || null,
            rawContent: rawContent, rawContentSha256: contract.sha256(rawContent), receivedAt: receivedAt,
            usage: response.usage || {}, finishReason: response.finishReason == null ? null : response.finishReason });
        try {
            var created = atomicCreate(rawPath(expected.decisionKey), record);
            return { created: created, record: validateRaw(read(rawPath(expected.decisionKey), 'EQ_FVG_RAW_STORE_CORRUPT').record, expected) };
        } catch (error) { if (/^EQ_FVG_/.test(error.code || '')) throw error; throw fail('EQ_FVG_RAW_PERSIST_FAILED', error); }
    }
    function freeze(expected, rawRecord, decision, createdAt) {
        var record = contract.canonicalize({ version: VERSION, decisionKey: expected.decisionKey,
            semanticVersion: expected.decisionKeyFields.semanticVersion, symbol: expected.decisionKeyFields.symbol,
            eqId: expected.decisionKeyFields.eqId, fvgId: expected.decisionKeyFields.fvgId,
            factsHash: expected.factsHash, facts: expected.canonicalFacts,
            promptHash: expected.decisionKeyFields.promptHash, promptVersion: expected.decisionKeyFields.promptVersion,
            requestedModelId: expected.decisionKeyFields.requestedModelId,
            rawResponseModelId: rawRecord.rawResponseModelId, normalizedModelIdentity: rawRecord.normalizedModelIdentity,
            rawContentSha256: rawRecord.rawContentSha256, usage: rawRecord.usage || {},
            finishReason: rawRecord.finishReason, decision: contract.validateDecision(decision), createdAt: createdAt });
        try {
            var created = atomicCreate(decisionPath(expected.decisionKey), record);
            return { created: created, record: validateFrozen(read(decisionPath(expected.decisionKey), 'EQ_FVG_DECISION_STORE_CORRUPT').record, expected) };
        } catch (error) { if (/^EQ_FVG_/.test(error.code || '')) throw error; throw fail('EQ_FVG_DECISION_STORE_ERROR', error); }
    }
    return { directory: directory, rawPath: rawPath, decisionPath: decisionPath,
        lookupRaw: lookupRaw, lookup: lookup, persistRaw: persistRaw, freeze: freeze };
}

function createMemoryStore() {
    var raw = {}, decisions = {};
    return {
        lookupRaw: function (expected) { return raw[expected.decisionKey] ? { status: 'HIT', record: clone(raw[expected.decisionKey]) } : { status: 'MISS' }; },
        lookup: function (expected) { return decisions[expected.decisionKey] ? { status: 'HIT', record: clone(decisions[expected.decisionKey]) } : { status: 'MISS' }; },
        persistRaw: function (expected, response, receivedAt) {
            if (!raw[expected.decisionKey]) raw[expected.decisionKey] = { version: VERSION, decisionKey: expected.decisionKey,
                factsHash: expected.factsHash, requestedModelId: expected.decisionKeyFields.requestedModelId,
                rawResponseModelId: response.rawResponseModelId, normalizedModelIdentity: response.normalizedModelIdentity,
                rawContent: response.rawContent, rawContentSha256: contract.sha256(response.rawContent), receivedAt: receivedAt,
                usage: response.usage || {}, finishReason: response.finishReason == null ? null : response.finishReason };
            return { created: true, record: clone(raw[expected.decisionKey]) };
        },
        freeze: function (expected, rawRecord, decision, createdAt) {
            if (!decisions[expected.decisionKey]) decisions[expected.decisionKey] = { version: VERSION,
                decisionKey: expected.decisionKey, semanticVersion: expected.decisionKeyFields.semanticVersion,
                symbol: expected.decisionKeyFields.symbol, eqId: expected.decisionKeyFields.eqId,
                fvgId: expected.decisionKeyFields.fvgId, factsHash: expected.factsHash, facts: expected.canonicalFacts,
                promptHash: expected.decisionKeyFields.promptHash, promptVersion: expected.decisionKeyFields.promptVersion,
                requestedModelId: expected.decisionKeyFields.requestedModelId, rawResponseModelId: rawRecord.rawResponseModelId,
                normalizedModelIdentity: rawRecord.normalizedModelIdentity, rawContentSha256: rawRecord.rawContentSha256,
                usage: rawRecord.usage || {}, finishReason: rawRecord.finishReason,
                decision: contract.validateDecision(decision), createdAt: createdAt };
            return { created: true, record: clone(decisions[expected.decisionKey]) };
        }
    };
}

module.exports = { VERSION: VERSION, buildIdentity: buildIdentity, createStore: createStore, createMemoryStore: createMemoryStore };
