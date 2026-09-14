'use strict';

/**
 * TURNING_SIGNIFICANCE_RESEARCH_PACKAGE_TESTS —
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §82 (sealed review package).
 *
 * The review package is the only place a human can disagree with the model, so
 * its integrity is part of the contract:
 *
 *   - exactly 40 sealed charts, named BLIND-001..040
 *   - NOT ONE bar of future data in any chart (right edge IS the confirmation bar)
 *   - NO label, verdict, confidence, reason or identity drawn on any chart
 *   - the answer key is separate, sealed, and complete
 *   - the audit manifest's hashes match what is actually on disk
 */

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'research-output', 'historical-turning-point-significance-v1');
var MANUAL = path.join(OUT, 'manual-review');
var SEALED = path.join(OUT, 'sealed');

var contract = require(path.join(ROOT, 'semantic', 'turningPointSignificanceSemanticV1'));

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

assert.ok(fs.existsSync(OUT), 'run research/historical-turning-point-significance-v1/buildArtifactsV1.js first');

function parseCsv(text) {
    var lines = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    return lines.map(function (line) {
        var cells = [], cell = '', quoted = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (quoted && ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = !quoted;
            else if (ch === ',' && !quoted) { cells.push(cell); cell = ''; }
            else cell += ch;
        }
        cells.push(cell);
        return cells;
    });
}
var manifestRows = parseCsv(fs.readFileSync(path.join(OUT, 'review-manifest.csv'), 'utf8'));
var manifestHeader = manifestRows.shift();
function column(row, name) { return row[manifestHeader.indexOf(name)]; }

var charts = fs.readdirSync(MANUAL).filter(function (name) { return /^BLIND-\d{3}\.svg$/.test(name); }).sort();
var answerKey = readJson(path.join(SEALED, 'answer-key.json'));

check('every required artifact exists', function () {
    ['PROMPT.md', 'prompt-metadata.json', 'population-audit.csv', 'population-summary.json',
        'review-manifest.csv', 'audit-manifest.json'].forEach(function (name) {
        assert.ok(fs.existsSync(path.join(OUT, name)), 'missing ' + name);
    });
    ['README.md', 'BLIND_REVIEW_INSTRUCTIONS.md'].forEach(function (name) {
        assert.ok(fs.existsSync(path.join(MANUAL, name)), 'missing manual-review/' + name);
    });
    assert.ok(fs.existsSync(path.join(SEALED, 'answer-key.json')));
});

check('the review package is exactly 40 charts named BLIND-001..BLIND-040', function () {
    assert.strictEqual(charts.length, 40);
    charts.forEach(function (name, index) {
        assert.strictEqual(name, 'BLIND-' + String(index + 1).padStart(3, '0') + '.svg');
    });
    assert.strictEqual(manifestRows.length, 40);
    assert.strictEqual(answerKey.sampleSize, 40);
    assert.strictEqual(answerKey.cases.length, 40);
});

check('NOT ONE future bar: every chart ends on its own confirmation candle', function () {
    charts.forEach(function (name) {
        var svg = fs.readFileSync(path.join(MANUAL, name), 'utf8');
        var maxDisplayed = svg.match(/data-max-displayed-open-time="(\d+)"/)[1];
        var confirmation = svg.match(/data-confirmation-candle-open-time="(\d+)"/)[1];
        assert.strictEqual(maxDisplayed, confirmation, name + ' extends past the confirmation candle');
        assert.match(svg, /data-future-bars="0"/, name);
        var times = [];
        var pattern = /data-candle-open-time="(\d+)"/g;
        var match;
        while ((match = pattern.exec(svg)) !== null) times.push(Number(match[1]));
        assert.ok(times.length > 0, name + ' has no candles');
        assert.strictEqual(Math.max.apply(Math, times), Number(confirmation), name + ' contains a later candle');
    });
});

check('NO label leak: no verdict, confidence, reason or identity is drawn anywhere', function () {
    var forbidden = contract.SIGNIFICANCE.concat(contract.CONFIDENCE).concat(contract.REASONS);
    charts.forEach(function (name) {
        var svg = fs.readFileSync(path.join(MANUAL, name), 'utf8');
        // The structural side (SWING_HIGH / SWING_LOW) is deliberately displayed and
        // is the only legitimate source of the HIGH/LOW tokens on a chart.
        var sanitized = svg.split('SWING_HIGH').join('').split('SWING_LOW').join('');
        forbidden.forEach(function (token) {
            assert.strictEqual(sanitized.indexOf(token), -1, name + ' leaks token ' + token);
        });
        var record = answerKey.cases.filter(function (c) { return c.blindId === name.slice(0, -4); })[0];
        assert.ok(record, 'answer key missing ' + name);
        assert.strictEqual(svg.indexOf(record.turningPointId), -1, name + ' leaks the turning point id');
        assert.strictEqual(svg.indexOf(record.processId), -1, name + ' leaks the process id');
        assert.strictEqual(svg.indexOf(record.factsHash), -1, name + ' leaks the facts hash');
        assert.strictEqual(svg.indexOf(record.decisionKey) === -1 || !record.decisionKey, true);
    });
    var docs = fs.readFileSync(path.join(MANUAL, 'README.md'), 'utf8') +
        fs.readFileSync(path.join(MANUAL, 'BLIND_REVIEW_INSTRUCTIONS.md'), 'utf8');
    answerKey.cases.forEach(function (record) {
        assert.strictEqual(docs.indexOf(record.turningPointId), -1, 'review docs leak an identity');
    });
});

check('the manifest records a matching hash for every chart and leaves human fields blank', function () {
    charts.forEach(function (name) {
        var row = manifestRows.filter(function (r) { return column(r, 'blindId') === name.slice(0, -4); })[0];
        assert.ok(row, 'manifest missing ' + name);
        assert.strictEqual(column(row, 'svgSha256'), sha256(fs.readFileSync(path.join(MANUAL, name))));
        assert.strictEqual(column(row, 'futureBars'), '0');
        assert.strictEqual(column(row, 'reviewer_significance'), '');
        assert.strictEqual(column(row, 'reviewer_confidence'), '');
        assert.strictEqual(column(row, 'reviewer_primaryReason'), '');
        assert.strictEqual(column(row, 'reviewer_notes'), '');
    });
});

check('the answer key covers the same 40 identity, and is marked sealed', function () {
    assert.strictEqual(answerKey.sealed, true);
    var keyIds = answerKey.cases.map(function (c) { return c.blindId; });
    assert.deepStrictEqual(keyIds.slice().sort(), charts.map(function (n) { return n.slice(0, -4); }).sort());
    answerKey.cases.forEach(function (record) {
        assert.ok(record.turningPointId && record.processId && record.confirmedAt);
        assert.strictEqual(record.price !== null && record.price !== undefined, true);
        if (record.significance !== null) assert.ok(contract.SIGNIFICANCE.indexOf(record.significance) >= 0);
        if (record.confidence !== null) assert.ok(contract.CONFIDENCE.indexOf(record.confidence) >= 0);
    });
});

check('population-audit.csv meets the >=100 candidate floor with valid enums and hashes', function () {
    var rows = parseCsv(fs.readFileSync(path.join(OUT, 'population-audit.csv'), 'utf8'));
    var header = rows.shift();
    assert.strictEqual(rows.length, 560);
    assert.ok(rows.length >= 100, 'population floor not met: ' + rows.length);
    function cell(row, name) { return row[header.indexOf(name)]; }
    rows.forEach(function (row, index) {
        assert.match(cell(row, 'factsHash'), /^[0-9a-f]{64}$/, 'row ' + index + ' factsHash');
        assert.strictEqual(cell(row, 'promptHash'), contract.PROMPT_SHA256);
        assert.ok(['HIGH', 'LOW'].indexOf(cell(row, 'side')) >= 0);
        var label = cell(row, 'semanticSignificance');
        if (label) assert.ok(contract.SIGNIFICANCE.indexOf(label) >= 0, 'row ' + index + ' label=' + label);
        var confidence = cell(row, 'semanticConfidence');
        if (confidence) assert.ok(contract.CONFIDENCE.indexOf(confidence) >= 0, 'row ' + index + ' confidence');
        var reason = cell(row, 'semanticPrimaryReason');
        if (reason) assert.ok(contract.REASONS.indexOf(reason) >= 0, 'row ' + index + ' reason=' + reason);
    });
});

check('population-summary declares the source purity and refuses a strategy conclusion', function () {
    var summary = readJson(path.join(OUT, 'population-summary.json'));
    assert.strictEqual(summary.semanticVersion, contract.VERSION);
    assert.strictEqual(summary.source.venue.indexOf('USDⓈ-M Futures') >= 0, true);
    assert.match(summary.source.purityNote, /futures/);
    assert.strictEqual(summary.reviewPackage.futureBarsInCharts, 0);
    assert.strictEqual(summary.reviewPackage.charts, 40);
    assert.match(summary.strategyConclusion, /NOT_DRAWN/);
    assert.strictEqual(summary.population.dynamicDCandidates, 560);
    assert.strictEqual(summary.population.bySide.HIGH + summary.population.bySide.LOW, 560);
});

check('population-summary reports the label x confidence cross table and the qualified ratio', function () {
    var summary = readJson(path.join(OUT, 'population-summary.json'));
    var labelled = summary.semantic.labelled;
    assert.ok(labelled > 0, 'no labelled candidate');
    // The cross table must be exactly the sum of the individual labels and of the
    // individual confidence levels — no candidate may be double counted or lost.
    var crossTotal = Object.keys(summary.semantic.confidenceLabelCross)
        .reduce(function (sum, key) { return sum + summary.semantic.confidenceLabelCross[key]; }, 0);
    var labelTotal = Object.keys(summary.semantic.labelDistribution)
        .reduce(function (sum, key) { return sum + summary.semantic.labelDistribution[key]; }, 0);
    var confidenceTotal = Object.keys(summary.semantic.confidenceDistribution)
        .reduce(function (sum, key) { return sum + summary.semantic.confidenceDistribution[key]; }, 0);
    assert.strictEqual(crossTotal, labelled);
    assert.strictEqual(labelTotal, labelled);
    assert.strictEqual(confidenceTotal, labelled);
    // The canary gate is (SIGNIFICANT|VALID) + HIGH, and nothing else.
    assert.strictEqual(summary.semantic.significantHigh,
        summary.semantic.confidenceLabelCross['SIGNIFICANT/HIGH'] || 0);
    assert.strictEqual(summary.semantic.validHigh,
        summary.semantic.confidenceLabelCross['VALID/HIGH'] || 0);
    assert.strictEqual(summary.semantic.highQualified,
        summary.semantic.significantHigh + summary.semantic.validHigh);
    assert.strictEqual(summary.semantic.highConfidence, summary.semantic.confidenceDistribution.HIGH);
    // Every labelled candidate that is not qualified must be reported as blocked.
    assert.strictEqual(summary.semantic.eligibleAnchors + summary.semantic.blockedAnchors, labelled);
    // The gate-derived eligibility count and the label x confidence count are two
    // independent computations of the same canary rule; they must agree.
    assert.strictEqual(summary.semantic.highQualified, summary.semantic.eligibleAnchors);
    // Distribution anomalies are RECORDED, never acted on (spec §7).
    assert.ok(summary.anomalyFlags);
    assert.strictEqual(typeof summary.anomalyFlags.zeroHighConfidence, 'boolean');
    assert.strictEqual(typeof summary.anomalyFlags.zeroEligibleAnchors, 'boolean');
    assert.match(summary.anomalyFlags.note, /REPORTED ONLY/);
    assert.match(summary.anomalyFlags.note, /No prompt/);
});

check('prompt-metadata pins the frozen hashes and enumerates the forbidden model powers', function () {
    var metadata = readJson(path.join(OUT, 'prompt-metadata.json'));
    assert.strictEqual(metadata.promptSha256, contract.PROMPT_SHA256);
    assert.strictEqual(metadata.schemaSha256, contract.SCHEMA_SHA256);
    assert.strictEqual(metadata.model, contract.MODEL);
    assert.strictEqual(metadata.temperature, 0);
    assert.deepStrictEqual(metadata.significance, contract.SIGNIFICANCE);
    assert.deepStrictEqual(metadata.confidence, contract.CONFIDENCE);
    assert.deepStrictEqual(metadata.primaryReason, contract.REASONS);
    assert.strictEqual(metadata.failClosed, true);
    assert.strictEqual(metadata.requiredConfidence, 'HIGH');
    assert.deepStrictEqual(metadata.allowedLabels, ['SIGNIFICANT', 'VALID']);
    assert.ok(metadata.detectionOwnership.indexOf('UNCHANGED') >= 0);
    ['discover turning points', 'move turning points', 'change 2L/2R',
        'decide Entry / SL / TP / sizing / orders'].forEach(function (entry) {
        assert.ok(metadata.llmForbidden.indexOf(entry) >= 0, 'missing forbidden power: ' + entry);
    });
});

check('PROMPT.md reproduces the frozen prompt byte-for-byte', function () {
    var doc = fs.readFileSync(path.join(OUT, 'PROMPT.md'), 'utf8');
    assert.ok(doc.indexOf(contract.SYSTEM_PROMPT) >= 0, 'SYSTEM_PROMPT is not reproduced verbatim');
    assert.ok(doc.indexOf(contract.USER_PREFIX.trimEnd()) >= 0, 'USER_PREFIX is not reproduced verbatim');
    assert.ok(doc.indexOf(contract.PROMPT_SHA256) >= 0);
    assert.ok(doc.indexOf(contract.SCHEMA_SHA256) >= 0);
    assert.strictEqual(sha256(contract.PROMPT_TEMPLATE), contract.PROMPT_SHA256);
});

check('audit-manifest hashes match every file actually on disk', function () {
    var audit = readJson(path.join(OUT, 'audit-manifest.json'));
    assert.strictEqual(audit.promptSha256, contract.PROMPT_SHA256);
    assert.strictEqual(audit.reviewSeed, 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1|REVIEW_4004');
    assert.ok(audit.files.length >= 40);
    audit.files.forEach(function (entry) {
        var full = path.join(OUT, entry.path);
        assert.ok(fs.existsSync(full), 'manifest lists a missing file: ' + entry.path);
        assert.strictEqual(sha256(fs.readFileSync(full)), entry.sha256, 'hash mismatch for ' + entry.path);
        assert.strictEqual(fs.statSync(full).size, entry.bytes, 'size mismatch for ' + entry.path);
    });
    var listed = audit.files.map(function (entry) { return entry.path; });
    assert.strictEqual(listed.indexOf('audit-manifest.json'), -1, 'the manifest must not hash itself');
    assert.ok(listed.indexOf(path.join('sealed', 'answer-key.json')) >= 0, 'answer key must be hashed');
});

console.log('turningPointSignificanceResearchPackageV1: ' + passed + ' checks passed');
