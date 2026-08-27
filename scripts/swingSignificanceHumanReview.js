#!/usr/bin/env node
'use strict';

/**
 * Swing Significance Local Human Review Console V1.
 *
 * Audit-only harness. It reads frozen swing features/candles and only writes the
 * human-ground-truth ledger, its CSV mirror, an append-only review log, and the
 * completion summary. Production market logic is never imported or mutated.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const LEDGER_FILE = 'human-ground-truth-v1.json';
const CSV_FILE = 'human-ground-truth-v1.csv';
const FEATURE_FILE = 'feature-alignment.json';
const LOG_FILE = 'human-ground-truth-review-log-v1.jsonl';
const COMPLETE_FILE = 'human-ground-truth-v1-complete-summary.json';
const CANONICAL_RE = /^([A-Z0-9]+):(\d+[mhdwM]):(SWING_HIGH|SWING_LOW):(\d{13})$/;
const LABELS = new Set(['HIGH', 'MEDIUM', 'LOW']);
const ROLES = new Set([
    '',
    'STRUCTURAL_EXTREME',
    'REACTION_CONFIRMED_SIGNIFICANT_SWING',
    'LIQUIDITY_REFERENCE',
    'INTERNAL_SECONDARY',
    'NON_SIGNIFICANT_LOCAL_SWING',
    'OTHER'
]);
const AVAILABLE_AT_FIELDS = [
    'formationFeaturesAvailableAt',
    'prominenceAvailableAt',
    'sameSideFeaturesAvailableAt',
    'higherOrderFeaturesAvailableAt',
    'reactionATR_3AvailableAt',
    'reactionATR_5AvailableAt',
    'reactionATR_10AvailableAt',
    'reactionEfficiencyAvailableAt',
    'directionalClosesAvailableAt'
];
const CSV_BASE_COLUMNS = [
    'canonicalSwingId', 'symbol', 'timeframe', 'side', 'occurredAt',
    'occurredAtIso', 'humanSignificance', 'labelStatus', 'significanceTiming',
    'labelSource', 'labelEvidence', 'humanNarrative', 'humanReason', 'humanRole',
    'humanNote', 'reviewedAt', 'lastModifiedAt', 'previousHumanSignificance',
    'counterexampleToProminenceOnly', 'formationTopology', 'humanReactionPath'
];

function parseArgs(argv) {
    const out = { port: DEFAULT_PORT, dataDir: null, candleFile: null, repoRoot: path.resolve(__dirname, '..') };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--data-dir') out.dataDir = path.resolve(argv[++i]);
        else if (arg === '--candles') out.candleFile = path.resolve(argv[++i]);
        else if (arg === '--port') out.port = Number(argv[++i]);
        else if (arg === '--help') out.help = true;
        else throw new Error('Unknown argument: ' + arg);
    }
    if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('Invalid --port');
    return out;
}

function walkForLedger(root, maxDepth) {
    const found = [];
    function visit(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        if (entries.some((entry) => entry.isFile() && entry.name === LEDGER_FILE) &&
            entries.some((entry) => entry.isFile() && entry.name === FEATURE_FILE)) {
            found.push({ dir, mtimeMs: fs.statSync(path.join(dir, LEDGER_FILE)).mtimeMs });
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path.join(dir, entry.name), depth + 1);
        }
    }
    visit(root, 0);
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found.length ? found[0].dir : null;
}

function discoverDataDir(explicit) {
    if (explicit) return explicit;
    if (process.env.SWING_REVIEW_DATA_DIR) return path.resolve(process.env.SWING_REVIEW_DATA_DIR);
    const root = path.join(os.homedir(), '.codex', 'visualizations');
    const found = walkForLedger(root, 7);
    if (!found) throw new Error('Could not discover review ledger. Pass --data-dir <directory>.');
    return found;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function duplicates(rows, key) {
    const seen = new Set();
    const dupes = new Set();
    for (const row of rows) {
        const value = row[key];
        if (seen.has(value)) dupes.add(value);
        seen.add(value);
    }
    return [...dupes];
}

function validateCanonical(row) {
    const match = CANONICAL_RE.exec(row.canonicalSwingId || '');
    if (!match) return false;
    return match[1] === row.symbol && match[2] === row.timeframe &&
        match[3] === row.side && Number(match[4]) === Number(row.occurredAt);
}

function integrityCheck(ledger, features) {
    const violations = [];
    if (!Array.isArray(ledger) || !Array.isArray(features)) violations.push('ledger/features must be arrays');
    const ledgerDupes = duplicates(ledger, 'canonicalSwingId');
    const featureDupes = duplicates(features, 'canonicalSwingId');
    if (ledgerDupes.length) violations.push('duplicate ledger IDs: ' + ledgerDupes.join(', '));
    if (featureDupes.length) violations.push('duplicate feature IDs: ' + featureDupes.join(', '));
    const featureById = new Map(features.map((row) => [row.canonicalSwingId, row]));
    for (const row of ledger) {
        if (!validateCanonical(row)) violations.push('invalid canonical identity: ' + row.canonicalSwingId);
        const feature = featureById.get(row.canonicalSwingId);
        if (!feature) {
            violations.push('missing feature: ' + row.canonicalSwingId);
            continue;
        }
        if (!validateCanonical(feature)) violations.push('invalid feature identity: ' + row.canonicalSwingId);
        const evaluationTime = Number(feature.evaluationTime);
        if (!Number.isFinite(evaluationTime)) violations.push('invalid evaluationTime: ' + row.canonicalSwingId);
        if (Number(feature.confirmedAt) > evaluationTime) violations.push('confirmedAt after evaluationTime: ' + row.canonicalSwingId);
        if (feature.futureLeakViolation === true) violations.push('upstream futureLeakViolation: ' + row.canonicalSwingId);
        for (const field of AVAILABLE_AT_FIELDS) {
            const value = feature[field];
            if (value == null || !Number.isFinite(Number(value))) violations.push('missing availability ' + field + ': ' + row.canonicalSwingId);
            else if (Number(value) > evaluationTime) violations.push(field + ' after evaluationTime: ' + row.canonicalSwingId);
        }
    }
    const ledgerIds = new Set(ledger.map((row) => row.canonicalSwingId));
    for (const feature of features) {
        if (!ledgerIds.has(feature.canonicalSwingId)) violations.push('feature without ledger row: ' + feature.canonicalSwingId);
    }
    return { futureLeakViolations: violations.length, violations };
}

function chooseCandleFile(repoRoot, features, explicit) {
    if (explicit) return explicit;
    const cacheDir = path.join(repoRoot, 'data-cache');
    const minimum = Math.min(...features.map((x) => Number(x.occurredAt))) - 96 * 300000;
    const maximum = Math.max(...features.map((x) => Number(x.evaluationTime)));
    const candidates = fs.readdirSync(cacheDir)
        .filter((name) => /^BTCUSDT_5m_.*\.json$/.test(name))
        .map((name) => {
            const file = path.join(cacheDir, name);
            const rows = readJson(file);
            if (!rows.length) return null;
            const byOpen = new Map(rows.map((candle) => [Number(candle.openTime), candle]));
            let targetPriceError = 0;
            let targetsPresent = 0;
            for (const feature of features) {
                const candle = byOpen.get(Number(feature.occurredAt));
                if (!candle) continue;
                targetsPresent += 1;
                const candlePrice = feature.side === 'SWING_HIGH' ? Number(candle.high) : Number(candle.low);
                targetPriceError += Math.abs(candlePrice - Number(feature.price));
            }
            return {
                file, rows, targetPriceError, targetsPresent,
                start: Number(rows[0].openTime), end: Number(rows[rows.length - 1].closeTime)
            };
        })
        .filter((x) => x && x.start <= minimum && x.end >= maximum && x.targetsPresent === features.length)
        .sort((a, b) => {
            const aFutures = a.rows[0].source === 'futures' ? 0 : 1;
            const bFutures = b.rows[0].source === 'futures' ? 0 : 1;
            return a.targetPriceError - b.targetPriceError || aFutures - bFutures ||
                (a.end - maximum) - (b.end - maximum) || a.rows.length - b.rows.length;
        });
    if (!candidates.length) throw new Error('No single BTCUSDT 5m cache covers every review chart. Pass --candles <file>.');
    return candidates[0].file;
}

function loadCandles(file) {
    const rows = readJson(file);
    const byOpen = new Map();
    for (const candle of rows) {
        if (candle.closed !== true) continue;
        if (![candle.openTime, candle.closeTime, candle.open, candle.high, candle.low, candle.close].every((v) => Number.isFinite(Number(v)))) continue;
        byOpen.set(Number(candle.openTime), {
            openTime: Number(candle.openTime), closeTime: Number(candle.closeTime),
            open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close),
            closed: true
        });
    }
    return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

function safeFeature(feature) {
    return {
        canonicalSwingId: feature.canonicalSwingId,
        symbol: feature.symbol,
        timeframe: feature.timeframe,
        side: feature.side,
        occurredAt: feature.occurredAt,
        occurredAtIso: feature.occurredAtIso,
        confirmedAt: feature.confirmedAt,
        confirmedAtIso: feature.confirmedAtIso,
        evaluationTime: feature.evaluationTime,
        evaluationTimeIso: feature.evaluationTimeIso,
        price: feature.price,
        atrAtConfirmation: feature.atrAtConfirmation,
        prominenceATR: feature.prominenceATR,
        reactionATR_3: feature.reactionATR_3,
        reactionATR_5: feature.reactionATR_5,
        reactionATR_10: feature.reactionATR_10,
        reactionEfficiency: feature.reactionEfficiency,
        directionalCloses: feature.directionalCloses,
        sameSideCountWithin0_25ATR: feature.sameSideCountWithin0_25ATR,
        sameSideCountWithin0_5ATR: feature.sameSideCountWithin0_5ATR,
        sameSideCountWithin1_0ATR: feature.sameSideCountWithin1_0ATR,
        nearestSameSideDistanceATR: feature.nearestSameSideDistanceATR,
        nearestSameSideBarsApart: feature.nearestSameSideBarsApart,
        nearestHigherOrderType: feature.nearestHigherOrderType,
        nearestHigherOrderPrice: feature.nearestHigherOrderPrice,
        nearestHigherOrderDistanceATR: feature.nearestHigherOrderDistanceATR,
        nearestHigherOrderProvenance: feature.nearestHigherOrderProvenance,
        structuralProvenanceAtFormation: feature.structuralProvenanceAtFormation,
        reactionATR_3AvailableAt: feature.reactionATR_3AvailableAt,
        reactionATR_5AvailableAt: feature.reactionATR_5AvailableAt,
        reactionATR_10AvailableAt: feature.reactionATR_10AvailableAt
    };
}

function buildChartData(feature, candles, allSwings) {
    const eligible = candles.filter((c) => c.closeTime <= Number(feature.evaluationTime));
    const targetIndex = eligible.findIndex((c) => c.openTime === Number(feature.occurredAt));
    if (targetIndex < 0) throw new Error('Target candle missing: ' + feature.canonicalSwingId);
    const targetCandle = eligible[targetIndex];
    const candleSwingPrice = feature.side === 'SWING_HIGH' ? targetCandle.high : targetCandle.low;
    if (Math.abs(Number(candleSwingPrice) - Number(feature.price)) > 1e-8) {
        throw new Error('Candle source does not match frozen swing price: ' + feature.canonicalSwingId);
    }
    const startIndex = Math.max(0, targetIndex - 72);
    const chartCandles = eligible.slice(startIndex);
    if (!chartCandles.length || chartCandles.some((c) => c.closed !== true || c.closeTime > Number(feature.evaluationTime))) {
        throw new Error('Future candle rejection: ' + feature.canonicalSwingId);
    }
    const minTime = chartCandles[0].openTime;
    const maxTime = chartCandles[chartCandles.length - 1].closeTime;
    const sameSide = (allSwings || [])
        .filter((s) => s.canonicalSwingId !== feature.canonicalSwingId && s.side === feature.side)
        .filter((s) => Number(s.confirmedAt) <= Number(feature.evaluationTime))
        .filter((s) => Number(s.occurredAt) >= minTime && Number(s.occurredAt) <= maxTime)
        .map((s) => ({ canonicalSwingId: s.canonicalSwingId, occurredAt: s.occurredAt, price: s.price, side: s.side }));
    return {
        candles: chartCandles,
        sameSide,
        target: { occurredAt: feature.occurredAt, price: feature.price, side: feature.side },
        higherOrder: feature.nearestHigherOrderPrice == null ? null : {
            type: feature.nearestHigherOrderType,
            price: feature.nearestHigherOrderPrice,
            provenance: feature.nearestHigherOrderProvenance
        }
    };
}

function csvEscape(value) {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function ledgerToCsv(rows) {
    const columns = [...CSV_BASE_COLUMNS];
    for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    return columns.join(',') + '\n' + rows.map((row) => columns.map((key) => csvEscape(row[key])).join(',')).join('\n') + '\n';
}

function atomicWrite(file, content) {
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
}

function counts(rows) {
    const resolved = rows.filter((x) => x.labelStatus === 'RESOLVED' && LABELS.has(x.humanSignificance));
    return {
        total: rows.length,
        resolved: resolved.length,
        unresolved: rows.length - resolved.length,
        high: resolved.filter((x) => x.humanSignificance === 'HIGH').length,
        medium: resolved.filter((x) => x.humanSignificance === 'MEDIUM').length,
        low: resolved.filter((x) => x.humanSignificance === 'LOW').length
    };
}

function publicRow(row) {
    return {
        canonicalSwingId: row.canonicalSwingId,
        humanSignificance: row.humanSignificance,
        labelStatus: row.labelStatus,
        humanReason: row.humanReason || '',
        humanRole: row.humanRole || '',
        humanNote: row.humanNote || '',
        reviewedAt: row.reviewedAt || null,
        lastModifiedAt: row.lastModifiedAt || null
    };
}

function createStore(options) {
    const dataDir = options.dataDir;
    const ledgerPath = path.join(dataDir, LEDGER_FILE);
    const csvPath = path.join(dataDir, CSV_FILE);
    const featurePath = path.join(dataDir, FEATURE_FILE);
    const logPath = path.join(dataDir, LOG_FILE);
    const completePath = path.join(dataDir, COMPLETE_FILE);
    let ledger = readJson(ledgerPath);
    const features = readJson(featurePath);
    const integrity = integrityCheck(ledger, features);
    if (integrity.futureLeakViolations !== 0) {
        throw new Error('Integrity check failed; FUTURE_LEAK_VIOLATIONS = ' + integrity.futureLeakViolations + '\n' + integrity.violations.join('\n'));
    }
    const featureById = new Map(features.map((x) => [x.canonicalSwingId, x]));
    const candles = options.candles;
    for (const feature of features) buildChartData(feature, candles, options.allSwings || features);

    function reload() {
        ledger = readJson(ledgerPath);
        const check = integrityCheck(ledger, features);
        if (check.futureLeakViolations) throw new Error('Ledger integrity failed after reload: ' + check.violations.join('; '));
    }

    function persist(next, logEntry) {
        atomicWrite(ledgerPath, JSON.stringify(next, null, 2) + '\n');
        atomicWrite(csvPath, ledgerToCsv(next));
        fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', { encoding: 'utf8', mode: 0o600 });
        ledger = next;
        const summary = counts(ledger);
        if (summary.unresolved === 0) {
            atomicWrite(completePath, JSON.stringify({
                task: 'Swing Significance Human Ground Truth V1',
                status: 'COMPLETE',
                completedAt: new Date().toISOString(),
                counts: summary,
                canonicalIdSafe: true,
                futureLeakViolations: 0
            }, null, 2) + '\n');
        }
        return summary;
    }

    function state() {
        reload();
        return {
            rows: ledger.map(publicRow),
            counts: counts(ledger),
            futureLeakViolations: 0,
            invariants: {
                productionChanged: false, swingDetectorChanged: false, eqhEqlChanged: false,
                watchChanged: false, notificationChanged: false, outcomeUsed: false
            }
        };
    }

    function sample(id) {
        reload();
        const row = ledger.find((x) => x.canonicalSwingId === id);
        const feature = featureById.get(id);
        if (!row || !feature) return null;
        return { row: publicRow(row), feature: safeFeature(feature), chart: buildChartData(feature, candles, options.allSwings || features) };
    }

    function label(payload) {
        reload();
        const id = String(payload.canonicalSwingId || '');
        const label = String(payload.humanSignificance || '');
        if (!CANONICAL_RE.test(id)) throw httpError(400, 'Invalid canonicalSwingId');
        if (!LABELS.has(label)) throw httpError(400, 'Invalid humanSignificance');
        const role = payload.humanRole == null ? '' : String(payload.humanRole);
        if (!ROLES.has(role)) throw httpError(400, 'Invalid humanRole');
        const index = ledger.findIndex((x) => x.canonicalSwingId === id);
        if (index < 0) throw httpError(404, 'Canonical swing not found');
        const old = ledger[index];
        const changingResolved = old.labelStatus === 'RESOLVED' && old.humanSignificance !== label;
        if (changingResolved && (payload.confirmChange !== true || payload.expectedCurrentSignificance !== old.humanSignificance)) {
            throw httpError(409, 'Resolved label change requires exact confirmation', { requiresConfirmation: true, current: old.humanSignificance, requested: label });
        }
        const now = new Date().toISOString();
        const updated = {
            ...old,
            humanSignificance: label,
            labelStatus: 'RESOLVED',
            significanceTiming: 'POST_CONFIRMATION_HUMAN_REVIEW',
            labelSource: 'LOCAL_HUMAN_REVIEW_CONSOLE_V1',
            labelEvidence: 'Canonical-ID-bound immediate human review persistence',
            humanReason: cleanText(payload.humanReason, 2000),
            humanRole: role || null,
            humanNote: cleanText(payload.humanNote, 8000),
            reviewedAt: old.reviewedAt || now,
            lastModifiedAt: now,
            previousHumanSignificance: old.humanSignificance || null
        };
        const next = ledger.slice();
        next[index] = updated;
        const summary = persist(next, {
            timestamp: now,
            action: old.labelStatus === 'RESOLVED' ? 'UPDATE_LABEL' : 'RESOLVE_LABEL',
            canonicalSwingId: id,
            oldSignificance: old.humanSignificance || null,
            newSignificance: label,
            oldStatus: old.labelStatus,
            newStatus: 'RESOLVED',
            oldRecord: publicRow(old),
            newRecord: publicRow(updated)
        });
        return { row: publicRow(updated), counts: summary };
    }

    function undo(payload) {
        reload();
        const id = String(payload.canonicalSwingId || '');
        if (!CANONICAL_RE.test(id)) throw httpError(400, 'Invalid canonicalSwingId');
        if (payload.confirmUndo !== true) throw httpError(409, 'Undo requires confirmation');
        if (!fs.existsSync(logPath)) throw httpError(409, 'No audit history for this swing');
        const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const last = [...entries].reverse().find((entry) => entry.canonicalSwingId === id && entry.action !== 'UNDO');
        if (!last || !last.oldRecord) throw httpError(409, 'No reversible history for this swing');
        const index = ledger.findIndex((x) => x.canonicalSwingId === id);
        if (index < 0) throw httpError(404, 'Canonical swing not found');
        const current = ledger[index];
        if (current.humanSignificance !== last.newSignificance) throw httpError(409, 'Ledger changed since the selected history entry');
        const restored = { ...current, ...last.oldRecord, lastModifiedAt: new Date().toISOString() };
        const next = ledger.slice();
        next[index] = restored;
        const now = new Date().toISOString();
        const summary = persist(next, {
            timestamp: now, action: 'UNDO', canonicalSwingId: id,
            oldSignificance: current.humanSignificance, newSignificance: restored.humanSignificance || null,
            oldStatus: current.labelStatus, newStatus: restored.labelStatus,
            revertedLogTimestamp: last.timestamp,
            oldRecord: publicRow(current), newRecord: publicRow(restored)
        });
        return { row: publicRow(restored), counts: summary };
    }

    return { state, sample, label, undo, paths: { ledgerPath, csvPath, logPath, completePath }, integrity };
}

function cleanText(value, maxLength) {
    if (value == null) return null;
    const text = String(value).trim();
    if (text.length > maxLength) throw httpError(400, 'Text field exceeds ' + maxLength + ' characters');
    return text || null;
}

function httpError(statusCode, message, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = details;
    return error;
}

function jsonResponse(res, status, body) {
    const content = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(content),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 64 * 1024) reject(httpError(413, 'Request too large'));
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (_) { reject(httpError(400, 'Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

function createRequestHandler(store) {
    let writeQueue = Promise.resolve();
    return async function handler(req, res) {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (req.method === 'GET' && url.pathname === '/') {
                const body = REVIEW_HTML;
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body),
                    'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
                });
                res.end(body);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/state') {
                jsonResponse(res, 200, store.state());
                return;
            }
            if (req.method === 'GET' && url.pathname === '/api/sample') {
                const id = url.searchParams.get('id') || '';
                const sample = store.sample(id);
                if (!sample) throw httpError(404, 'Canonical swing not found');
                jsonResponse(res, 200, sample);
                return;
            }
            if (req.method === 'POST' && (url.pathname === '/api/label' || url.pathname === '/api/undo')) {
                const payload = await readBody(req);
                const operation = url.pathname === '/api/label' ? () => store.label(payload) : () => store.undo(payload);
                const result = await (writeQueue = writeQueue.then(operation, operation));
                jsonResponse(res, 200, result);
                return;
            }
            jsonResponse(res, 404, { error: 'Not found' });
        } catch (error) {
            jsonResponse(res, error.statusCode || 500, { error: error.message, ...(error.details || {}) });
        }
    };
}

function startServer(options) {
    const dataDir = discoverDataDir(options.dataDir);
    const ledger = readJson(path.join(dataDir, LEDGER_FILE));
    const features = readJson(path.join(dataDir, FEATURE_FILE));
    const candleFile = chooseCandleFile(options.repoRoot, features, options.candleFile);
    const candles = loadCandles(candleFile);
    let allSwings = features;
    const allFeatureFile = path.join(path.dirname(dataDir), 'swing-significance-feature-audit-v1', 'features.json');
    if (fs.existsSync(allFeatureFile)) {
        const raw = readJson(allFeatureFile);
        allSwings = Array.isArray(raw) ? raw.map((s) => ({
            canonicalSwingId: s.canonicalSwingId || s.id,
            side: s.side === 'BSL' ? 'SWING_HIGH' : s.side === 'SSL' ? 'SWING_LOW' : s.type || s.side,
            occurredAt: s.occurredAt || s.sourceOpenTime,
            confirmedAt: s.confirmedAt,
            price: s.price
        })) : features;
    }
    const store = createStore({ dataDir, candles, allSwings });
    const initial = counts(ledger);
    const server = http.createServer(createRequestHandler(store));
    server.listen(options.port, HOST, () => {
        const address = server.address();
        console.log('Human Review: http://' + HOST + ':' + address.port);
        console.log('DATA_DIR = ' + dataDir);
        console.log('CANDLE_FILE = ' + candleFile);
        console.log('TOTAL = ' + initial.total);
        console.log('INITIAL_RESOLVED = ' + initial.resolved);
        console.log('INITIAL_UNRESOLVED = ' + initial.unresolved);
        console.log('FUTURE_LEAK_VIOLATIONS = 0');
    });
    return { server, store, dataDir, candleFile };
}

const REVIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swing Significance Human Review</title>
<style>
:root{color-scheme:dark;--bg:#090c12;--panel:#111722;--line:#263044;--muted:#8f9bb0;--text:#eef3fa;--cyan:#61d8ff;--green:#4ee1a0;--red:#ff6f7d;--amber:#ffc857}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#142239 0,transparent 30%),var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif}.shell{max-width:1500px;margin:auto;padding:20px}.top{display:flex;align-items:center;gap:16px;justify-content:space-between;margin-bottom:14px}.title{font-size:19px;font-weight:740;letter-spacing:.02em}.status{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid var(--line);background:#0d1320;padding:7px 11px;border-radius:999px}.good{color:var(--green)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:14px}.card{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 50px #0005}.identity{padding:16px 18px;margin-bottom:14px}.id{font:650 17px/1.4 ui-monospace,SFMono-Regular,monospace;color:var(--cyan);word-break:break-all}.meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px}.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.value{font-family:ui-monospace,SFMono-Regular,monospace;margin-top:3px}.chart{height:610px;padding:12px;position:relative}canvas{width:100%;height:100%;display:block}.side{display:flex;flex-direction:column;gap:14px}.features{padding:15px}.section{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.section:first-child{border:0;padding:0;margin:0}.section h3{font-size:12px;color:#c5d2e8;margin:0 0 9px;text-transform:uppercase;letter-spacing:.1em}.feature-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0}.feature-row span:first-child{color:var(--muted)}.feature-row span:last-child{font-family:ui-monospace,SFMono-Regular,monospace}.form{padding:15px}.buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}button,select,input,textarea{border:1px solid var(--line);border-radius:8px;background:#0b111b;color:var(--text);font:inherit}button{padding:10px 12px;cursor:pointer;font-weight:700}button:hover{border-color:#51617d}button[data-label=HIGH]{color:var(--green)}button[data-label=MEDIUM]{color:var(--amber)}button[data-label=LOW]{color:var(--red)}button.active{background:#1c2b40;border-color:var(--cyan)}select,input,textarea{width:100%;padding:9px 10px;margin-top:5px}textarea{min-height:62px;resize:vertical}.field{margin-top:9px}.nav{display:grid;grid-template-columns:1fr 1fr;gap:8px}.jump{display:flex;gap:8px;margin-top:8px}.jump input{margin:0}.jump button{flex:0 0 auto}.message{min-height:20px;margin-top:8px;color:var(--muted)}.complete{display:none;padding:24px;text-align:center;font-size:20px;color:var(--green)}.warn{color:var(--amber)}@media(max-width:1050px){.grid{grid-template-columns:1fr}.side{display:grid;grid-template-columns:1fr 1fr}.chart{height:520px}}@media(max-width:720px){.meta,.side{grid-template-columns:1fr 1fr}.shell{padding:10px}.chart{height:430px}.top{align-items:flex-start;flex-direction:column}}
</style></head><body><main class="shell">
<div class="top"><div><div class="title">Swing Significance · Human Ground Truth V1</div><div class="label">chart + raw features only · canonical ID persistence</div></div><div class="status"><span class="pill" id="progress">Loading…</span><span class="pill good">FUTURE LEAK 0</span><select id="filter" aria-label="Filter"><option value="UNRESOLVED">UNRESOLVED</option><option value="ALL">ALL</option><option value="RESOLVED">RESOLVED</option></select></div></div>
<section id="complete" class="card complete"></section>
<section id="workspace"><div class="card identity"><div class="id" id="id"></div><div class="meta"><div><div class="label">Occurred at · UTC</div><div class="value" id="occurred"></div></div><div><div class="label">Side</div><div class="value" id="side"></div></div><div><div class="label">Confirmed at</div><div class="value" id="confirmed"></div></div><div><div class="label">Evaluation time</div><div class="value" id="evaluation"></div></div></div></div>
<div class="grid"><div class="card chart"><canvas id="chart"></canvas></div><aside class="side"><div class="card features" id="features"></div><div class="card form"><div class="buttons"><button data-label="HIGH">HIGH</button><button data-label="MEDIUM">MEDIUM</button><button data-label="LOW">LOW</button></div><label class="field">Human role<select id="role"><option value="">— optional —</option><option>STRUCTURAL_EXTREME</option><option>REACTION_CONFIRMED_SIGNIFICANT_SWING</option><option>LIQUIDITY_REFERENCE</option><option>INTERNAL_SECONDARY</option><option>NON_SIGNIFICANT_LOCAL_SWING</option><option>OTHER</option></select></label><label class="field">Reason<input id="reason" maxlength="2000" placeholder="Optional concise reason"></label><label class="field">Note<textarea id="note" maxlength="8000" placeholder="Optional review note"></textarea></label><div class="nav"><button id="previous">← Previous</button><button id="next">Next unresolved →</button><button id="skip">Skip</button><button id="undo">Undo current</button></div><div class="jump"><input id="jumpId" placeholder="Jump by exact canonicalSwingId"><button id="jump">Jump</button></div><div class="message" id="message"></div></div></aside></div></section>
</main><script>
'use strict';let state=null,currentId=null,sample=null;const $=id=>document.getElementById(id);const fmt=n=>n==null?'—':Number(n).toFixed(6).replace(/0+$/,'').replace(/\.$/,'');const iso=n=>n?new Date(Number(n)).toISOString():'—';
async function api(url,options){const r=await fetch(url,options);const b=await r.json();if(!r.ok){const e=new Error(b.error||'Request failed');Object.assign(e,b);throw e}return b}
function visible(){const f=$('filter').value;return state.rows.filter(r=>f==='ALL'||r.labelStatus===f)}
function nextId(from,unresolvedOnly){const rows=unresolvedOnly?state.rows.filter(r=>r.labelStatus==='UNRESOLVED'):visible();if(!rows.length)return null;const i=rows.findIndex(r=>r.canonicalSwingId===from);return rows[(i+1+rows.length)%rows.length].canonicalSwingId}
async function refresh(preferred){state=await api('/api/state');const c=state.counts;$('progress').textContent='Resolved '+c.resolved+'/'+c.total+' · Unresolved '+c.unresolved+'/'+c.total;if(c.unresolved===0){$('complete').style.display='block';$('complete').textContent='COMPLETE · HIGH '+c.high+' · MEDIUM '+c.medium+' · LOW '+c.low}else $('complete').style.display='none';const rows=visible();if(!rows.length){$('workspace').style.display='none';return}$('workspace').style.display='block';await load(rows.some(r=>r.canonicalSwingId===preferred)?preferred:rows[0].canonicalSwingId)}
async function load(id){sample=await api('/api/sample?id='+encodeURIComponent(id));currentId=id;const f=sample.feature,r=sample.row;$('id').textContent=f.canonicalSwingId;$('occurred').textContent=f.occurredAtIso||iso(f.occurredAt);$('side').textContent=f.side;$('confirmed').textContent=f.confirmedAtIso||iso(f.confirmedAt);$('evaluation').textContent=f.evaluationTimeIso||iso(f.evaluationTime);$('role').value=r.humanRole||'';$('reason').value=r.humanReason||'';$('note').value=r.humanNote||'';document.querySelectorAll('[data-label]').forEach(b=>b.classList.toggle('active',b.dataset.label===r.humanSignificance));renderFeatures(f);drawChart(sample.chart);$('message').textContent=(r.labelStatus==='RESOLVED'?'Resolved '+r.humanSignificance:'Unresolved')+' · page '+(visible().findIndex(x=>x.canonicalSwingId===id)+1)+'/'+visible().length}
function row(k,v){return '<div class="feature-row"><span>'+k+'</span><span>'+v+'</span></div>'}function section(name,rows){return '<div class="section"><h3>'+name+'</h3>'+rows.join('')+'</div>'}
function renderFeatures(f){$('features').innerHTML=section('Formation',[row('prominenceATR',fmt(f.prominenceATR)),row('ATR',fmt(f.atrAtConfirmation)),row('provenance',f.structuralProvenanceAtFormation||'—')])+section('Reaction',[row('reactionATR_3',fmt(f.reactionATR_3)),row('reactionATR_5',fmt(f.reactionATR_5)),row('reactionATR_10',fmt(f.reactionATR_10)),row('reactionEfficiency',fmt(f.reactionEfficiency)),row('directionalCloses',fmt(f.directionalCloses))])+section('Topology',[row('sameSide ≤ 0.25 ATR',fmt(f.sameSideCountWithin0_25ATR)),row('sameSide ≤ 0.5 ATR',fmt(f.sameSideCountWithin0_5ATR)),row('sameSide ≤ 1.0 ATR',fmt(f.sameSideCountWithin1_0ATR)),row('nearest distance ATR',fmt(f.nearestSameSideDistanceATR)),row('nearest bars apart',fmt(f.nearestSameSideBarsApart))])+section('Higher-order context',[row('type',f.nearestHigherOrderType||'—'),row('price',fmt(f.nearestHigherOrderPrice)),row('distance ATR',fmt(f.nearestHigherOrderDistanceATR)),row('provenance',f.nearestHigherOrderProvenance||'—')])+section('Timing',[row('confirmedAt',iso(f.confirmedAt)),row('reaction 3 available',iso(f.reactionATR_3AvailableAt)),row('reaction 5 available',iso(f.reactionATR_5AvailableAt)),row('reaction 10 available',iso(f.reactionATR_10AvailableAt)),row('evaluationTime',iso(f.evaluationTime))])}
function drawChart(data){const canvas=$('chart'),dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();canvas.width=Math.floor(rect.width*dpr);canvas.height=Math.floor(rect.height*dpr);const x=canvas.getContext('2d');x.scale(dpr,dpr);const W=rect.width,H=rect.height,p={l:58,r:76,t:24,b:34},cs=data.candles;const prices=cs.flatMap(c=>[c.high,c.low]);if(data.higherOrder)prices.push(Number(data.higherOrder.price));const lo=Math.min(...prices),hi=Math.max(...prices),pad=(hi-lo)*.07||1,min=lo-pad,max=hi+pad;const px=i=>p.l+(i+.5)*(W-p.l-p.r)/cs.length,py=v=>p.t+(max-v)*(H-p.t-p.b)/(max-min);x.fillStyle='#0b1018';x.fillRect(0,0,W,H);x.strokeStyle='#202a3b';x.lineWidth=1;x.font='11px ui-monospace';x.fillStyle='#8491a7';for(let i=0;i<=5;i++){const y=p.t+i*(H-p.t-p.b)/5;x.beginPath();x.moveTo(p.l,y);x.lineTo(W-p.r,y);x.stroke();const price=max-i*(max-min)/5;x.fillText(price.toFixed(2),W-p.r+8,y+4)}const cw=Math.max(2,(W-p.l-p.r)/cs.length*.62);cs.forEach((c,i)=>{const green=c.close>=c.open;x.strokeStyle=green?'#45d49a':'#f06478';x.fillStyle=x.strokeStyle;x.beginPath();x.moveTo(px(i),py(c.high));x.lineTo(px(i),py(c.low));x.stroke();const y=Math.min(py(c.open),py(c.close)),h=Math.max(1,Math.abs(py(c.open)-py(c.close)));x.fillRect(px(i)-cw/2,y,cw,h)});if(data.higherOrder){x.setLineDash([6,5]);x.strokeStyle='#ffc857';x.beginPath();x.moveTo(p.l,py(data.higherOrder.price));x.lineTo(W-p.r,py(data.higherOrder.price));x.stroke();x.setLineDash([]);x.fillStyle='#ffc857';x.fillText(data.higherOrder.type+' '+Number(data.higherOrder.price).toFixed(2),p.l+6,py(data.higherOrder.price)-6)}data.sameSide.forEach(s=>{const i=cs.findIndex(c=>c.openTime===Number(s.occurredAt));if(i<0)return;x.fillStyle='#78869c';x.beginPath();const y=py(s.price)+(s.side==='SWING_HIGH'?-6:6);x.arc(px(i),y,2.5,0,Math.PI*2);x.fill()});const ti=cs.findIndex(c=>c.openTime===Number(data.target.occurredAt));if(ti>=0){const y=py(data.target.price),up=data.target.side==='SWING_HIGH';x.fillStyle='#61d8ff';x.beginPath();x.moveTo(px(ti),y+(up?-15:15));x.lineTo(px(ti)-7,y+(up?-26:26));x.lineTo(px(ti)+7,y+(up?-26:26));x.closePath();x.fill();x.fillText('TARGET',Math.min(W-p.r-48,px(ti)+9),y+(up?-18:24))}x.fillStyle='#8491a7';x.fillText(new Date(cs[0].openTime).toISOString().slice(5,16).replace('T',' '),p.l,H-10);x.fillText(new Date(cs[cs.length-1].closeTime).toISOString().slice(5,16).replace('T',' '),W-p.r-85,H-10)}
async function save(label,confirmed){try{const old=sample.row.humanSignificance;if(sample.row.labelStatus==='RESOLVED'&&old!==label&&!confirmed){if(!confirm('Change '+old+' → '+label+'?'))return;confirmed=true}await api('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canonicalSwingId:currentId,humanSignificance:label,humanRole:$('role').value,humanReason:$('reason').value,humanNote:$('note').value,confirmChange:confirmed===true,expectedCurrentSignificance:old})});const next=nextId(currentId,true);await refresh(next||currentId)}catch(e){$('message').textContent=e.message;$('message').className='message warn'}}
document.querySelectorAll('[data-label]').forEach(b=>b.onclick=()=>save(b.dataset.label,false));$('filter').onchange=()=>refresh(currentId);$('next').onclick=async()=>load(nextId(currentId,true)||nextId(currentId,false));$('skip').onclick=$('next').onclick;$('previous').onclick=async()=>{const rows=visible();const i=rows.findIndex(r=>r.canonicalSwingId===currentId);await load(rows[(i-1+rows.length)%rows.length].canonicalSwingId)};$('jump').onclick=async()=>{const id=$('jumpId').value.trim();if(!state.rows.some(r=>r.canonicalSwingId===id)){$('message').textContent='Exact canonicalSwingId not found';return}await load(id)};$('undo').onclick=async()=>{if(!confirm('Undo latest saved change for this canonicalSwingId?'))return;try{await api('/api/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({canonicalSwingId:currentId,confirmUndo:true})});await refresh(currentId)}catch(e){$('message').textContent=e.message}};window.addEventListener('resize',()=>sample&&drawChart(sample.chart));refresh();
</script></body></html>`;

if (require.main === module) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            console.log('Usage: node scripts/swingSignificanceHumanReview.js [--data-dir DIR] [--candles FILE] [--port PORT]');
        } else startServer(options);
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    CANONICAL_RE, parseArgs, integrityCheck, buildChartData, ledgerToCsv,
    createStore, createRequestHandler, loadCandles, counts, startServer
};
