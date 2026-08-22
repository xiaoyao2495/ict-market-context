/**
 * biasResponseValidator 单元测试
 * 覆盖：
 *  - strictMssEmpty 契约（marketFacts 提供时 delivery.mss 必须为空）
 *  - mssAssessment 解释层字段校验
 *  - 标准合法响应可通过
 */
var assert = require('assert');
var validator = require('../ai/biasResponseValidator');

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

function baseValid() {
    return {
        bias: 'BEARISH',
        confidence: 'MEDIUM',
        identifiedStructure: {
            majorSwingHighs: [{ price: 75998.9, time: '2026-03-18T04:00:00Z' }],
            majorSwingLows: [{ price: 73330.3, time: '2026-03-17T12:00:00Z' }],
            structureState: 'BEARISH'
        },
        liquidity: {
            buySide: [],
            sellSide: [{ price: 65569.2, time: '2026-02-01T00:00:00Z', type: 'SWING_LOW' }],
            recentSweeps: []
        },
        imbalances: { bullishFvg: [], bearishFvg: [] },
        delivery: {
            mss: [],
            displacement: [{ direction: 'BEARISH', startTime: '2026-03-18T08:00:00Z', endTime: '2026-03-18T12:00:00Z' }],
            currentDelivery: 'BEARISH'
        },
        dealingRange: { high: 75998.9, low: 62979.5, equilibrium: 69489.2, location: 'DISCOUNT' },
        drawOnLiquidity: { direction: 'DOWN', targetPrice: 65569.2, reason: 'external SSL' },
        supportingEvidence: ['bearish displacement'],
        conflicts: ['deep discount caution'],
        biasReason: 'structural shift at 73330.3'
    };
}

test('标准合法响应（无 marketFacts）通过校验', function () {
    validator.validate(baseValid());
    validator.parseAndValidate(JSON.stringify(baseValid()));
});

test('strictMssEmpty=true 且 delivery.mss 为空 → 通过', function () {
    var p = baseValid();
    p.delivery.mss = [];
    validator.validate(p, { strictMssEmpty: true });
});

test('strictMssEmpty=true 但 delivery.mss 非空（AI 把 candidate 升级为 MSS）→ 拒绝', function () {
    var p = baseValid();
    p.delivery.mss = [{ type: 'BEARISH', brokenSwingPrice: 73330.3, breakTime: '2026-03-18T08:00:00Z', reason: 'shift' }];
    var threw = false;
    try {
        validator.validate(p, { strictMssEmpty: true });
    } catch (e) {
        threw = true;
        assert.strictEqual(e.code, 'SCHEMA_INVALID');
        assert.ok(e.message.indexOf('delivery.mss') >= 0, '错误信息应点名 delivery.mss');
    }
    assert.ok(threw, 'strictMssEmpty 下非空 mss 必须被拒');
});

test('非 strict 模式（无 marketFacts）允许 delivery.mss 非空', function () {
    var p = baseValid();
    p.delivery.mss = [{ type: 'BEARISH', brokenSwingPrice: 73330.3, breakTime: '2026-03-18T08:00:00Z', reason: 'shift' }];
    validator.validate(p); // 不抛错
});

test('mssAssessment 合法三项通过', function () {
    var p = baseValid();
    p.mssAssessment = [
        { level: 73330.3, assessment: 'LIKELY_MSS', reason: 'structural shift' },
        { level: 71220.1, assessment: 'NOT_MSS', reason: 'continuation after shift' },
        { level: 70256, assessment: 'UNCERTAIN', reason: 'ambiguous' }
    ];
    validator.validate(p, { strictMssEmpty: true });
});

test('mssAssessment 缺 level → 拒绝', function () {
    var p = baseValid();
    p.mssAssessment = [{ assessment: 'LIKELY_MSS', reason: 'x' }];
    var threw = false;
    try { validator.validate(p, { strictMssEmpty: true }); } catch (e) { threw = true; assert.strictEqual(e.code, 'SCHEMA_INVALID'); }
    assert.ok(threw);
});

test('mssAssessment assessment 非法值 → 拒绝', function () {
    var p = baseValid();
    p.mssAssessment = [{ level: 73330.3, assessment: 'CONFIRMED_MSS', reason: 'x' }];
    var threw = false;
    try { validator.validate(p, { strictMssEmpty: true }); } catch (e) { threw = true; assert.strictEqual(e.code, 'SCHEMA_INVALID'); }
    assert.ok(threw);
});

test('mssAssessment 缺 reason → 拒绝', function () {
    var p = baseValid();
    p.mssAssessment = [{ level: 73330.3, assessment: 'LIKELY_MSS' }];
    var threw = false;
    try { validator.validate(p, { strictMssEmpty: true }); } catch (e) { threw = true; assert.strictEqual(e.code, 'SCHEMA_INVALID'); }
    assert.ok(threw);
});

function marketFactsForDraw(highStatus, lowStatus) {
    return {
        sweeps: [
            { refSide: 'HIGH', pivotPrice: 75998.9, status: highStatus },
            { refSide: 'LOW', pivotPrice: 65569.2, status: lowStatus }
        ]
    };
}

test('Draw hard validator：INTACT target 通过', function () {
    var p = baseValid();
    validator.validate(p, { marketFacts: marketFactsForDraw('INTACT', 'INTACT') });
});

test('Draw hard validator：UP + allowed INTACT high 通过', function () {
    var p = baseValid();
    p.drawOnLiquidity = { direction: 'UP', targetPrice: 75998.9, reason: 'intact BSL' };
    validator.validate(p, { marketFacts: marketFactsForDraw('INTACT', 'INTACT') });
});

test('Draw hard validator：DOWN + allowed INTACT low 通过', function () {
    var p = baseValid();
    p.drawOnLiquidity = { direction: 'DOWN', targetPrice: 65569.2, reason: 'intact SSL' };
    validator.validate(p, { marketFacts: marketFactsForDraw('INTACT', 'INTACT') });
});

test('Draw hard validator：TAKEN target 拒绝', function () {
    var p = baseValid();
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForDraw('INTACT', 'TAKEN') });
    }, /TAKEN liquidity/);
});

test('Draw hard validator：未知 target 不是 INTACT，拒绝', function () {
    var p = baseValid();
    p.drawOnLiquidity.targetPrice = 65000;
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForDraw('INTACT', 'INTACT') });
    }, /未对应任何 INTACT liquidity/);
});

test('Draw hard validator：NONE 不代表 active target，直接通过', function () {
    var p = baseValid();
    p.drawOnLiquidity = { direction: 'NONE', targetPrice: null, reason: 'balanced' };
    validator.validate(p, { marketFacts: marketFactsForDraw('TAKEN', 'TAKEN') });
});

test('Draw hard validator：NONE 兼容既有 schema 的数字 targetPrice', function () {
    var p = baseValid();
    p.drawOnLiquidity = { direction: 'NONE', targetPrice: 65569.2, reason: 'no active draw' };
    validator.validate(p, { marketFacts: marketFactsForDraw('TAKEN', 'TAKEN') });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
