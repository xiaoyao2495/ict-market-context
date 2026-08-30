/**
 * 方案 Z 审计实验单元测试（§18）
 * 使用项目自带 test(name, fn) 框架；不修改任何现有引擎行为。
 */
var assert = require('assert');
var audit = require('../scripts/auditDeepSeek4hBias');
var validator = require('../ai/biasResponseValidator');
var deepseekClient = require('../ai/deepseekClient');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

// 造 N 根确定性 4H 蜡烛（closeTime 升序，全部 closed）
function makeCandles(n, startMs) {
    var arr = [];
    var iv = 14400000;
    for (var i = 0; i < n; i++) {
        var ot = startMs + i * iv;
        arr.push({
            openTime: ot, open: 100 + i, high: 105 + i,
            low: 95 + i, close: 102 + i,
            closeTime: ot + iv - 1, closed: true, source: 'futures'
        });
    }
    return arr;
}

/* ---------- 确定性抽样 ---------- */

test('固定 seed 可复现（同输入同输出）', function () {
    var c = makeCandles(500, 1700000000000);
    var a = audit.selectEvaluationTimes(c, { seed: 20260822 });
    var b = audit.selectEvaluationTimes(c, { seed: 20260822 });
    assert.deepStrictEqual(a, b);
});

test('不同 seed 通常产生不同序列', function () {
    var c = makeCandles(500, 1700000000000);
    var a = audit.selectEvaluationTimes(c, { seed: 1 });
    var b = audit.selectEvaluationTimes(c, { seed: 2 });
    assert.notDeepStrictEqual(a, b);
});

test('抽取数量正确', function () {
    var c = makeCandles(500, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, { seed: 20260822, count: 10 });
    assert.strictEqual(idxs.length, 10);
});

test('每个点前面至少 120 根（前置窗口满足）', function () {
    var c = makeCandles(500, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, { seed: 20260822, count: 10, window: 120 });
    idxs.forEach(function (idx) {
        assert.ok(idx >= 120, 'idx ' + idx + ' 前置不足 120');
    });
});

test('任意两点间隔 >= MIN_GAP_BARS (24)', function () {
    var c = makeCandles(800, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, { seed: 20260822, count: 10, minGap: 24, window: 120 });
    for (var i = 1; i < idxs.length; i++) {
        assert.ok(idxs[i] - idxs[i - 1] >= 24, '间隔不足：' + idxs[i] + '-' + idxs[i - 1]);
    }
});

test('结果升序', function () {
    var c = makeCandles(800, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, { seed: 20260822, count: 10 });
    for (var i = 1; i < idxs.length; i++) {
        assert.ok(idxs[i] > idxs[i - 1]);
    }
});

test('最近 180 天下界可限制 evaluationTime 抽样范围', function () {
    var c = makeCandles(800, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, {
        seed: 20260822, count: 10, minIndex: 350
    });
    idxs.forEach(function (idx) {
        assert.ok(idx >= 350, 'idx ' + idx + ' 早于 audit 下界');
    });
});

test('指定年份上下界可同时限制 evaluationTime 抽样范围', function () {
    var c = makeCandles(800, 1700000000000);
    var idxs = audit.selectEvaluationTimes(c, {
        seed: 20260822, count: 10, minIndex: 200, maxIndex: 600
    });
    idxs.forEach(function (idx) {
        assert.ok(idx >= 200 && idx <= 600, 'idx ' + idx + ' 超出年份边界');
    });
});

test('findTimeRangeIndices 只选择目标年份 closed candles', function () {
    var start = Date.UTC(2024, 11, 1);
    var c = makeCandles(300, start);
    var yearStart = Date.UTC(2025, 0, 1);
    var yearEnd = Date.UTC(2026, 0, 1);
    var range = audit.findTimeRangeIndices(c, yearStart, yearEnd);
    assert.ok(c[range.startIndex].closeTime >= yearStart);
    assert.ok(c[range.endIndex].closeTime < yearEnd);
    if (range.startIndex > 0) assert.ok(c[range.startIndex - 1].closeTime < yearStart);
});

test('蜡烛不足时抛错', function () {
    var c = makeCandles(50, 1700000000000);
    assert.throws(function () {
        audit.selectEvaluationTimes(c, { seed: 1, count: 10, window: 120 });
    });
});

/* ---------- 蜡烛切片（exactly 120 / no-future） ---------- */

test('buildCandleSlice 正好返回 120 根', function () {
    var c = makeCandles(300, 1700000000000);
    var slice = audit.buildCandleSlice(c, 250);
    assert.strictEqual(slice.length, 120);
});

test('切片最晚 candle = evalIdx（无未来数据）', function () {
    var c = makeCandles(300, 1700000000000);
    var evalIdx = 200;
    var slice = audit.buildCandleSlice(c, evalIdx);
    assert.strictEqual(slice[slice.length - 1].openTime, c[evalIdx].openTime);
    assert.strictEqual(slice.length, 120);
});

test('切片不含 evalIdx 之后数据', function () {
    var c = makeCandles(300, 1700000000000);
    var evalIdx = 250;
    var slice = audit.buildCandleSlice(c, evalIdx);
    var last = slice[slice.length - 1];
    assert.ok(last.openTime <= c[evalIdx].openTime);
});

test('Structural snapshot index 逐 bar 串接 previousSnapshot', function () {
    var c = makeCandles(30, 1700000000000);
    var out = audit.buildStructuralSnapshotIndex(c, [10, 20]);
    assert.ok(out[10] && out[20]);
    assert.strictEqual(out[10].structural.evaluationTime, c[10].closeTime);
    assert.strictEqual(out[20].structural.evaluationTime, c[20].closeTime);
    assert.strictEqual(out[20].structural.persistence.previousEvaluationTime,
        c[19].closeTime);
    assert.deepStrictEqual(out[20].structural.futureLeakViolations, []);
});

/* ---------- 响应 schema 校验 ---------- */

function baseValid() {
    return {
        bias: 'BULLISH', confidence: 'MEDIUM',
        identifiedStructure: {
            majorSwingHighs: [{ price: 110, time: '2026-01-01T00:00:00Z' }],
            majorSwingLows: [{ price: 90, time: '2026-01-02T00:00:00Z' }],
            structureState: 'BULLISH'
        },
        liquidity: {
            buySide: [{ price: 111, time: '2026-01-01T00:00:00Z', type: 'PDH' }],
            sellSide: [{ price: 89, time: '2026-01-02T00:00:00Z', type: 'PDL' }],
            recentSweeps: [{ side: 'SSL', liquidityPrice: 89, sweepTime: '2026-01-02T00:00:00Z', reason: 'x' }]
        },
        imbalances: {
            bullishFvg: [{ top: 100, bottom: 98, time: '2026-01-03T00:00:00Z' }],
            bearishFvg: []
        },
        delivery: {
            referencedStructuralEventIds: [],
            displacement: [{ direction: 'BULLISH', startTime: '2026-01-04T00:00:00Z', endTime: '2026-01-04T04:00:00Z', reason: 'x' }],
            currentDelivery: 'BULLISH'
        },
        dealingRange: { high: 110, low: 90, equilibrium: 100, location: 'DISCOUNT' },
        drawOnLiquidity: { direction: 'UP', targetPrice: 111, reason: 'x' },
        supportingEvidence: ['SSL taken'], conflicts: [],
        biasReason: 'sell-side taken, bullish repricing'
    };
}

test('合法响应通过校验', function () {
    assert.strictEqual(validator.validate(baseValid()), true);
});

test('bias 非法值被拒', function () {
    var p = baseValid(); p.bias = 'UP';
    assert.throws(function () { validator.validate(p); }, /bias/);
});

test('confidence 非法值被拒', function () {
    var p = baseValid(); p.confidence = 'SOME';
    assert.throws(function () { validator.validate(p); }, /confidence/);
});

test('旧 delivery.mss contract 被拒', function () {
    var p = baseValid(); p.delivery.mss = [{
        type: 'BEARISH', brokenSwingPrice: 76510,
        breakTime: '2026-08-23T04:00:00.000Z', reason: 'invented'
    }];
    assert.throws(function () { validator.validate(p); }, /delivery\.mss 已删除/);
});

test('structural event reference 必须为字符串', function () {
    var p = baseValid(); p.delivery.referencedStructuralEventIds = [123];
    assert.throws(function () { validator.validate(p); }, /必须是字符串/);
});

test('Sweep 缺 sweepTime 被拒', function () {
    var p = baseValid(); p.liquidity.recentSweeps[0].sweepTime = undefined;
    assert.throws(function () { validator.validate(p); }, /sweepTime/);
});

test('dealingRange.location 非法被拒', function () {
    var p = baseValid(); p.dealingRange.location = 'MID';
    assert.throws(function () { validator.validate(p); }, /location/);
});

test('draw direction 非 NONE 但缺 targetPrice 被拒', function () {
    var p = baseValid(); p.drawOnLiquidity.targetPrice = undefined;
    assert.throws(function () { validator.validate(p); }, /targetPrice/);
});

test('malformed JSON 文本解析失败', function () {
    var thrown = false;
    try {
        validator.parseAndValidate('{not valid json');
    } catch (e) {
        thrown = true;
        assert.strictEqual(e.code, 'MALFORMED_JSON');
    }
    assert.ok(thrown, '应抛出 MALFORMED_JSON');
});

test('合法 JSON 文本解析+校验通过', function () {
    var parsed = validator.parseAndValidate(JSON.stringify(baseValid()));
    assert.strictEqual(parsed.bias, 'BULLISH');
});

/* ---------- DeepSeek Client 安全 ---------- */

test('未设置 API Key 抛 MISSING_API_KEY', function () {
    var old = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
        assert.throws(function () {
            deepseekClient.chat({ systemPrompt: 'x', userPrompt: 'y' });
        }, /DEEPSEEK_API_KEY/);
    } finally {
        if (old !== undefined) process.env.DEEPSEEK_API_KEY = old;
    }
});

test('base url / model 可经环境变量覆盖，不写死', function () {
    var oldB = process.env.DEEPSEEK_BASE_URL;
    var oldM = process.env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_BASE_URL = 'https://example.test';
    process.env.DEEPSEEK_MODEL = 'test-model';
    try {
        assert.strictEqual(deepseekClient.getBaseUrl(), 'https://example.test');
        assert.strictEqual(deepseekClient.getModel(), 'test-model');
    } finally {
        if (oldB !== undefined) process.env.DEEPSEEK_BASE_URL = oldB; else delete process.env.DEEPSEEK_BASE_URL;
        if (oldM !== undefined) process.env.DEEPSEEK_MODEL = oldM; else delete process.env.DEEPSEEK_MODEL;
    }
});

/* ---------- Deterministic context：confirmedSwings / pivot detector ---------- */

var auditPivots = require('../ai/auditPivots');
var ictBiasPrompt = require('../ai/ictBiasPrompt');

// 构造确定性 zigzag 4H 序列：price 在 1000 附近三角波摆动，
// 每 4 根一个完整波（峰在 i%4===0，谷在 i%4===2），确保局部极值严格高于/低于两侧。
function makeZigzag(n, startMs) {
    var arr = [];
    var iv = 14400000;
    function level(i) {
        // 周期 4 的三角波：0→+100→0→-100→...
        var m = i % 4;
        if (m === 0) return 1000 + 100; // 峰
        if (m === 1) return 1000;
        if (m === 2) return 1000 - 100; // 谷
        return 1000; // m===3 上升中
    }
    for (var i = 0; i < n; i++) {
        var ot = startMs + i * iv;
        var lv = level(i);
        // 峰 candle：high 明显高于两侧；谷 candle：low 明显低于两侧
        var isPeak = (i % 4 === 0);
        var isTrough = (i % 4 === 2);
        var high = isPeak ? lv + 30 : lv + 5;
        var low = isTrough ? lv - 30 : lv - 5;
        arr.push({
            openTime: ot, open: lv, high: high, low: low, close: lv,
            closeTime: ot + iv - 1, closed: true, source: 'futures'
        });
    }
    return arr;
}

test('pivot detector：峰在 i%4===0、谷在 i%4===2', function () {
    var c = makeZigzag(60, 1700000000000);
    var evalIdx = 50;
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    // 检查 high[0]._idx 为 4 的倍数（峰），low[0]._idx 为 i%4===2（谷）
    if (pv.highs.length) assert.strictEqual(pv.highs[0]._idx % 4, 0, 'high 应在 i%4===0');
    if (pv.lows.length) assert.strictEqual(pv.lows[0]._idx % 4, 2, 'low 应在 i%4===2');
});

test('pivot detector：confirmedAt 严格 <= evaluationTime（无未来泄漏）', function () {
    var c = makeZigzag(200, 1700000000000);
    var evalIdx = 150;
    var evalTime = c[evalIdx].closeTime;
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var all = pv.highs.concat(pv.lows);
    assert.ok(all.length > 0, '应检出 pivot');
    all.forEach(function (p) {
        assert.ok(Date.parse(p.confirmedAt) <= evalTime,
            'confirmedAt 越界：' + p.confirmedAt + ' > evalTime');
    });
});

test('pivot detector：occurredAt 为 pivot candle openTime', function () {
    var c = makeZigzag(60, 1700000000000);
    var pv = auditPivots.detectPivots(c, 50, { left: 2, right: 2, window: 120 });
    if (pv.highs.length) {
        var h = pv.highs[0];
        assert.strictEqual(h.occurredAt, new Date(c[h._idx].openTime).toISOString());
    }
});

test('pivot detector：confirmedAt 为右侧第 right 根 closeTime', function () {
    var c = makeZigzag(60, 1700000000000);
    var pv = auditPivots.detectPivots(c, 50, { left: 2, right: 2, window: 120 });
    if (pv.highs.length) {
        var h = pv.highs[0];
        var expect = c[h._idx + 2].closeTime;
        assert.strictEqual(h.confirmedAt, new Date(expect).toISOString());
    }
});

test('Daily Bias V1 prompt 必须注入 confirmedSwings 和 marketFacts', function () {
    var c = makeZigzag(200, 1700000000000);
    var evalIdx = 150;
    var evalTime = c[evalIdx].closeTime;
    var slice = c.slice(evalIdx - 119, evalIdx + 1);
    var pv = auditPivots.detectPivots(c, evalIdx, { left: 2, right: 2, window: 120 });
    var prompt = ictBiasPrompt.buildUserPrompt({
        symbol: 'BTCUSDT', evaluationTime: evalTime, candles: slice,
        confirmedSwings: { highs: pv.highs, lows: pv.lows },
        marketFacts: { sweeps: [], breaks: [], protectedSwings: [], structuralEvents: [], structuralState: 'UNKNOWN' }
    });
    assert.ok(prompt.indexOf('confirmedSwings') >= 0, '应含 confirmedSwings');
    assert.ok(prompt.indexOf('marketFacts') >= 0, '应含 marketFacts');
    assert.ok(prompt.indexOf('MUST NOT invent') >= 0 || prompt.indexOf('Do NOT invent') >= 0,
        '应含禁止自创约束');
    assert.throws(function () {
        ictBiasPrompt.buildUserPrompt({ symbol: 'BTCUSDT', evaluationTime: evalTime, candles: slice });
    }, /requires confirmedSwings and marketFacts/);
});

test('System prompt 以 Structural Provenance 为 authoritative MSS 来源', function () {
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('structuralEvents types are authoritative') >= 0);
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('STRUCTURAL_CONTINUATION is continuation') >= 0);
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('mssAssessment') < 0, '旧 mssAssessment 合同应退休');
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('referencedStructuralEventIds') >= 0,
        '应只允许引用 authoritative structural event ID');
    assert.ok(ictBiasPrompt.SYSTEM_PROMPT.indexOf('brokenSwingPrice') < 0,
        'response contract 不得再要求 AI 重建 MSS price');
});

test('Prompt 序列化 structuralState/protectedSwings/structuralEvents 且过滤未来事实', function () {
    var c = makeZigzag(130, 1700000000000);
    var evaluationTime = c[129].closeTime;
    var visible = new Date(c[110].openTime).toISOString();
    var confirmed = new Date(c[112].closeTime).toISOString();
    var future = new Date(evaluationTime + 14400000).toISOString();
    var prompt = ictBiasPrompt.buildUserPrompt({
        symbol: 'BTCUSDT', evaluationTime: evaluationTime, candles: c.slice(-120),
        confirmedSwings: { highs: [], lows: [] },
        marketFacts: {
            sweeps: [], breaks: [], structuralState: 'BULLISH',
            protectedSwings: [{
                price: 95, occurredAt: visible, confirmedAt: confirmed,
                protectedConfirmedAt: confirmed, side: 'LOW',
                role: 'ACTIVE_PROTECTED_LOW', status: 'ACTIVE_PROTECTED'
            }, {
                price: 999, occurredAt: future, confirmedAt: future,
                protectedConfirmedAt: future, side: 'HIGH',
                role: 'ACTIVE_PROTECTED_HIGH', status: 'ACTIVE_PROTECTED'
            }],
            structuralEvents: [{
                type: 'STRUCTURAL_MSS', direction: 'BULLISH', referenceLevel: 100,
                referenceRole: 'ACTIVE_PROTECTED_HIGH', eventTime: visible,
                confirmedAt: confirmed, structuralStateBefore: 'BEARISH',
                structuralStateAfter: 'BULLISH', stateChanged: true
            }, {
                type: 'STRUCTURAL_MSS', direction: 'BEARISH', referenceLevel: 999,
                eventTime: future, confirmedAt: future
            }]
        }
    });
    assert.ok(prompt.indexOf('"structuralState": "BULLISH"') >= 0);
    assert.ok(prompt.indexOf('"protectedSwings"') >= 0);
    assert.ok(prompt.indexOf('"role": "ACTIVE_PROTECTED_LOW"') >= 0);
    assert.ok(prompt.indexOf('"type": "STRUCTURAL_MSS"') >= 0);
    assert.ok(prompt.indexOf('"eventId": "AUTHORITATIVE_STRUCTURAL_EVENT:') >= 0,
        'authoritative event 应带稳定 eventId');
    assert.ok(prompt.indexOf('"referenceLevel": 100') >= 0);
    assert.ok(prompt.indexOf('"referenceLevel": 999') < 0, 'future event 不得进入 prompt');
    assert.ok(prompt.indexOf('"price": 999') < 0, 'future protected swing 不得进入 prompt');
    assert.ok(prompt.indexOf('Classify each supplied pivot') < 0, '旧 pivot reclassification 指令应删除');
});

test('Live 默认配置固定监控 BTCUSDT / ZECUSDT / PROMUSDT，不启用 top10', function () {
    var liveConfig = require('../config/live.json');
    assert.strictEqual(liveConfig.symbolsMode, 'fixed');
    assert.deepStrictEqual(liveConfig.symbols, ['BTCUSDT', 'ZECUSDT', 'PROMUSDT']);
});

test('allowedDrawTargets 只包含 time-local INTACT liquidity', function () {
    var evaluationTime = Date.parse('2026-04-08T00:00:00.000Z');
    var allowed = ictBiasPrompt.buildAllowedDrawTargets({ sweeps: [
        { refSide: 'HIGH', pivotPrice: 100, status: 'INTACT',
            occurredAt: '2026-04-07T00:00:00.000Z', confirmedAt: '2026-04-07T12:00:00.000Z' },
        { refSide: 'LOW', pivotPrice: 90, status: 'INTACT',
            occurredAt: '2026-04-07T04:00:00.000Z', confirmedAt: '2026-04-07T16:00:00.000Z' },
        { refSide: 'HIGH', pivotPrice: 110, status: 'TAKEN',
            occurredAt: '2026-04-06T00:00:00.000Z', confirmedAt: '2026-04-06T12:00:00.000Z' },
        { refSide: 'LOW', pivotPrice: 80, status: 'INTACT',
            occurredAt: '2026-04-08T04:00:00.000Z', confirmedAt: '2026-04-08T16:00:00.000Z' }
    ] }, evaluationTime);
    assert.deepStrictEqual(allowed.up.map(function (x) { return x.price; }), [100]);
    assert.deepStrictEqual(allowed.down.map(function (x) { return x.price; }), [90]);
    assert.strictEqual(allowed.up[0].type, 'SWING_HIGH');
    assert.strictEqual(allowed.down[0].type, 'SWING_LOW');
});

test('Daily Bias V1 prompt 注入 allowedDrawTargets hard contract', function () {
    var c = makeZigzag(130, 1700000000000);
    var evaluationTime = c[129].closeTime;
    var prompt = ictBiasPrompt.buildUserPrompt({
        symbol: 'BTCUSDT', evaluationTime: evaluationTime, candles: c.slice(-120),
        confirmedSwings: { highs: [], lows: [] },
        marketFacts: { sweeps: [{
            refSide: 'HIGH', pivotPrice: 1100, status: 'INTACT',
            occurredAt: new Date(c[100].openTime).toISOString(),
            confirmedAt: new Date(c[102].closeTime).toISOString()
        }], breaks: [] }
    });
    assert.ok(prompt.indexOf('"allowedDrawTargets"') >= 0);
    assert.ok(prompt.indexOf('targetPrice MUST exactly match') >= 0);
    assert.ok(prompt.indexOf('Never invent a draw target from raw OHLC') >= 0);
});

test('Audit completion token limit 固定为 4096', function () {
    assert.strictEqual(deepseekClient.getAuditCompletionTokenLimit(), 4096);
});

test('finish_reason=length 显式分类 OUTPUT_TRUNCATED', function () {
    var evaluated = audit.evaluateAuditResponse({
        text: '{"bias":"BEARISH"',
        raw: { choices: [{ finish_reason: 'length' }] }
    }, { sweeps: [] });
    assert.strictEqual(evaluated.caseStatus, 'OUTPUT_TRUNCATED');
    assert.strictEqual(evaluated.validationError.code, 'OUTPUT_TRUNCATED');
});

test('非 length 的 JSON 解析失败仍分类 MALFORMED_JSON', function () {
    var evaluated = audit.evaluateAuditResponse({
        text: '{"bias":"BEARISH"',
        raw: { choices: [{ finish_reason: 'stop' }] }
    }, { sweeps: [] });
    assert.strictEqual(evaluated.caseStatus, 'CASE_SCHEMA_INVALID');
    assert.strictEqual(evaluated.validationError.code, 'MALFORMED_JSON');
});

test('parseCaseIdxs：解析固定索引（DEEPSEEK_CASE_IDXS）', function () {
    var old = process.env.DEEPSEEK_CASE_IDXS;
    process.env.DEEPSEEK_CASE_IDXS = '381,663,772,825,1056';
    try {
        var idxs = audit.parseCaseIdxs();
        assert.deepStrictEqual(idxs, [381, 663, 772, 825, 1056]);
    } finally {
        if (old !== undefined) process.env.DEEPSEEK_CASE_IDXS = old; else delete process.env.DEEPSEEK_CASE_IDXS;
    }
});

test('parseCaseIdxs：未设置返回 null', function () {
    var old = process.env.DEEPSEEK_CASE_IDXS;
    delete process.env.DEEPSEEK_CASE_IDXS;
    try {
        assert.strictEqual(audit.parseCaseIdxs(), null);
    } finally {
        if (old !== undefined) process.env.DEEPSEEK_CASE_IDXS = old;
    }
});

test('固定索引重跑与已审 case 对齐（381→2026-04-07）', function () {
    var fs = require('fs');
    var f = 'outputs/deepseek-4h-bias/klines_4h.json';
    if (!fs.existsSync(f)) { console.log('SKIP 固定索引对齐（无落盘数据）'); return; }
    var data = JSON.parse(fs.readFileSync(f, 'utf8'));
    var candles = data.candles;
    var evalTime = candles[381].closeTime;
    assert.strictEqual(new Date(evalTime).toISOString(), '2026-04-07T23:59:59.999Z');
});

console.log('----');
console.log('deepseek4hBiasAudit: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) { process.exit(1); }
