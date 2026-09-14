'use strict';

/**
 * TURNING_SIGNIFICANCE_LOCAL_AUDIT_GATE_TESTS —
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §84–§87（本地执行 gate 机制自检）。
 *
 * The real population labeling and the semantic smoke run in the operator's local
 * terminal with `DEEPSEEK_API_KEY` injected from the environment — never from a
 * file, never from chat. That means CI cannot exercise the live transport.
 *
 * What CI CAN and MUST exercise is the gate MACHINERY around it: that a resolved
 * decision persists RAW before PARSE, that a re-run is a cache HIT with zero extra
 * transport calls, that the gate is `(SIGNIFICANT|VALID) + HIGH`, that a failure
 * is fail-closed, and that nothing is ever sent to an exchange. `--dry-run` drives
 * exactly that path with a deterministic synthetic transport and a throwaway
 * store. This test runs it as a subprocess and asserts the report.
 */

var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SCRIPT = path.join(ROOT, 'scripts', 'local', 'turningPointSignificanceSemanticAuditV1.local.js');
var REPORT = path.join(ROOT, 'research-output', 'historical-turning-point-significance-v1', 'smoke-report.dry-run.json');

var contract = require(path.join(ROOT, 'semantic', 'turningPointSignificanceSemanticV1'));

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

// scripts/local/*.local.js is gitignored by repo convention (local-only, never
// committed — same as every other *.local.js here). A fresh clone therefore has
// no audit script, and this file must SKIP rather than fail.
if (!fs.existsSync(SCRIPT)) {
    console.log('SKIP turningPointSignificanceLocalAuditGatesV1: ' +
        'scripts/local/turningPointSignificanceSemanticAuditV1.local.js is absent ' +
        '(gitignored local-only script); the gate self-check runs in the operator terminal.');
    process.exit(0);
}

check('the audit script refuses to run without a key instead of degrading silently', function () {
    var env = Object.assign({}, process.env);
    delete env.DEEPSEEK_API_KEY;
    var result = cp.spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env: env, encoding: 'utf8' });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /DEEPSEEK_API_KEY/);
    assert.match(result.stderr, /--dry-run/);
});

check('the script never imports an execution or exchange module (REAL_ORDERS_SENT=0)', function () {
    var source = fs.readFileSync(SCRIPT, 'utf8');
    ['execution/', 'binanceExecutionClient', 'realOrderExecution', 'userDataStream',
        'dingTalk', 'notify/'].forEach(function (token) {
        assert.strictEqual(source.indexOf(token), -1, 'audit script must not touch ' + token);
    });
    assert.ok(source.indexOf("require(path.join(ROOT, 'live', 'turningPointSignificanceSemanticV1'))") >= 0);
    assert.strictEqual(source.indexOf('DEEPSEEK_API_KEY') >= 0, true);
    // The key is only ever read from env; it is never written to disk.
    assert.strictEqual(/writeFileSync\([^)]*DEEPSEEK/.test(source), false);
});

var run = cp.spawnSync(process.execPath, [SCRIPT, '--dry-run', '--sample', '6'], { cwd: ROOT, encoding: 'utf8' });
var report = null;

check('the offline dry-run completes and writes a smoke report', function () {
    assert.strictEqual(run.status, 0, run.stderr || run.stdout);
    assert.ok(fs.existsSync(REPORT), 'dry-run report missing');
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    assert.strictEqual(report.mode, 'DRY_RUN');
    assert.strictEqual(report.transport, 'SYNTHETIC_OFFLINE');
    assert.strictEqual(report.evaluated, 6);
});

check('strictly serial: exactly one transport call per candidate', function () {
    assert.strictEqual(report.serial, true);
    assert.strictEqual(report.counts.transportCalls, report.evaluated);
    assert.strictEqual(report.gates.filter(function (g) { return g.gate === 'SERIAL_TRANSPORT'; })[0].pass, true);
});

check('raw response is persisted before parse and one frozen decision per anchor', function () {
    assert.strictEqual(report.counts.rawResponsesBefore, 0);
    assert.strictEqual(report.counts.rawResponsesAfter, report.evaluated);
    assert.strictEqual(report.counts.decisionsAfter, report.evaluated);
    var gate = report.gates.filter(function (g) { return g.gate === 'RAW_PERSISTED_BEFORE_PARSE'; })[0];
    assert.strictEqual(gate.pass, true);
});

check('a re-run is a cache HIT with ZERO extra transport calls and an identical decisionKey', function () {
    var gate = report.gates.filter(function (g) { return g.gate === 'CACHE_HIT_ON_RERUN'; })[0];
    assert.strictEqual(gate.pass, true, gate.detail);
    assert.match(gate.detail, /decisionKey stable=true/);
    assert.match(gate.detail, /extra transport calls=0/);
});

check('the canary gate is exactly (SIGNIFICANT|VALID) + HIGH, and it is fail-closed', function () {
    var consistent = report.gates.filter(function (g) { return g.gate === 'GATE_CONSISTENT'; })[0];
    var failClosed = report.gates.filter(function (g) { return g.gate === 'FAIL_CLOSED'; })[0];
    assert.strictEqual(consistent.pass, true, consistent.detail);
    assert.strictEqual(failClosed.pass, true, failClosed.detail);
    report.results.forEach(function (result) {
        var expected = result.significance !== null
            && (result.significance === 'SIGNIFICANT' || result.significance === 'VALID')
            && result.confidence === 'HIGH';
        assert.strictEqual(result.eligible, expected, 'gate mismatch for ' + result.turningPointId);
        if (result.eligible) assert.strictEqual(result.gateReason, null);
    });
    // The dry-run transport deliberately produces both branches, so the gate is
    // proven to be able to BOTH admit and block in one run.
    assert.ok(report.results.some(function (r) { return r.eligible; }), 'no eligible sample');
    assert.ok(report.results.some(function (r) { return !r.eligible; }), 'no blocked sample');
});

check('every evaluated fact set is future-leak free and hash-pinned to the frozen prompt', function () {
    var gate = report.gates.filter(function (g) { return g.gate === 'FUTURE_LEAK_FALSE'; })[0];
    assert.strictEqual(gate.pass, true, gate.detail);
    assert.strictEqual(report.counts.futureLeakTimestamps, 0);
    assert.strictEqual(report.promptSha256, contract.PROMPT_SHA256);
    assert.strictEqual(report.schemaSha256, contract.SCHEMA_SHA256);
    assert.strictEqual(report.model, contract.MODEL);
    report.results.forEach(function (result) {
        assert.match(result.factsHash, /^[0-9a-f]{64}$/);
        assert.strictEqual(result.promptHash, contract.PROMPT_SHA256);
        assert.strictEqual(result.semanticVersion, contract.VERSION);
    });
});

check('the model identity and schema gates are enforced, not assumed', function () {
    assert.strictEqual(report.gates.filter(function (g) { return g.gate === 'MODEL_IDENTITY_OK'; })[0].pass, true);
    assert.strictEqual(report.counts.modelIdentityViolations, 0);
    assert.strictEqual(report.gates.filter(function (g) { return g.gate === 'SCHEMA_VALID'; })[0].pass, true);
});

check('all ten gates are reported and the overall verdict is PASS', function () {
    var names = report.gates.map(function (g) { return g.gate; });
    assert.deepStrictEqual(names, ['KEY_PRESENT', 'SERIAL_TRANSPORT', 'MODEL_IDENTITY_OK', 'SCHEMA_VALID',
        'RAW_PERSISTED_BEFORE_PARSE', 'CACHE_HIT_ON_RERUN', 'GATE_CONSISTENT', 'FAIL_CLOSED',
        'FUTURE_LEAK_FALSE', 'REAL_ORDERS_SENT']);
    assert.strictEqual(report.gates.length, 10);
    assert.strictEqual(report.verdict, 'PASS');
    assert.strictEqual(report.realOrdersSent, 0);
    assert.match(report.strategyConclusion, /NOT_DRAWN/);
});

check('the dry-run never writes into the live frozen store', function () {
    // The report must ADVERTISE the live store (so the operator's next command is
    // correct) while the actual writes went to a throwaway directory.
    assert.strictEqual(report.storeIsThrowaway, true);
    assert.strictEqual(report.liveDecisionStore, path.join('.live-state', 'turning-point-significance-v1'));
    assert.notStrictEqual(report.decisionStore, report.liveDecisionStore);
    assert.strictEqual(report.decisionStore.indexOf('.live-state'), -1,
        'dry-run must not write into the live store');
    // Guard against a regression that silently points the dry-run at the live dir.
    assert.strictEqual(report.results.some(function (r) { return r.cached; }), false);
});

check('the report itself is not part of the sealed review package manifest', function () {
    var audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'research-output',
        'historical-turning-point-significance-v1', 'audit-manifest.json'), 'utf8'));
    var paths = audit.files.map(function (entry) { return entry.path; });
    assert.strictEqual(paths.indexOf('smoke-report.dry-run.json'), -1);
    assert.strictEqual(paths.indexOf('SMOKE_REPORT.dry-run.md'), -1);
});

console.log('turningPointSignificanceLocalAuditGatesV1: ' + passed + ' checks passed');
