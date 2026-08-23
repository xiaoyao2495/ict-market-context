/**
 * biasResponseValidator 单元测试
 * 覆盖：
 *  - authoritative Structural Provenance fact consistency
 *  - Draw INTACT_OR_NONE contract
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

function marketFactsForStructure() {
    return {
        sweeps: [
            { refSide: 'HIGH', pivotPrice: 75998.9, status: 'INTACT' },
            { refSide: 'LOW', pivotPrice: 65569.2, status: 'INTACT' }
        ],
        structuralState: 'BEARISH',
        protectedSwings: [{
            price: 75998.9,
            occurredAt: '2026-03-18T04:00:00Z',
            side: 'HIGH',
            role: 'ACTIVE_PROTECTED_HIGH',
            status: 'ACTIVE_PROTECTED'
        }],
        structuralEvents: [{
            type: 'STRUCTURAL_MSS',
            direction: 'BEARISH',
            referenceLevel: 73330.3,
            eventTime: '2026-03-18T08:00:00Z',
            confirmedAt: '2026-03-18T11:59:59.999Z'
        }]
    };
}

function responseMatchingStructure() {
    var p = baseValid();
    p.delivery.mss = [{
        type: 'BEARISH', brokenSwingPrice: 73330.3,
        breakTime: '2026-03-18T08:00:00Z', reason: 'authoritative MSS'
    }];
    return p;
}

test('authoritative structural state/MSS/active protected 全匹配 → 通过', function () {
    validator.validate(responseMatchingStructure(), { marketFacts: marketFactsForStructure() });
});

test('deterministic structure=BEARISH 但 finalBias=UNCLEAR → 合法', function () {
    var p = responseMatchingStructure();
    p.bias = 'UNCLEAR';
    p.confidence = 'LOW';
    validator.validate(p, { marketFacts: marketFactsForStructure() });
});

test('AI structureState=UNCLEAR 明确背离 authoritative BEARISH → 拒绝', function () {
    var p = responseMatchingStructure();
    p.identifiedStructure.structureState = 'UNCLEAR';
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForStructure() });
    }, /structuralState 不一致/);
});

test('AI 省略 latest authoritative STRUCTURAL_MSS → 拒绝', function () {
    var p = responseMatchingStructure();
    p.delivery.mss = [];
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForStructure() });
    }, /缺少 latest authoritative STRUCTURAL_MSS/);
});

test('AI 自创未供应的 STRUCTURAL_MSS → 拒绝', function () {
    var p = responseMatchingStructure();
    p.delivery.mss.push({
        type: 'BULLISH', brokenSwingPrice: 80000,
        breakTime: '2026-03-18T12:00:00Z', reason: 'invented'
    });
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForStructure() });
    }, /未对应 authoritative STRUCTURAL_MSS/);
});

test('AI 省略 ACTIVE_PROTECTED swing → 拒绝', function () {
    var p = responseMatchingStructure();
    p.identifiedStructure.majorSwingHighs = [];
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForStructure() });
    }, /缺少 authoritative ACTIVE_PROTECTED_HIGH/);
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

test('Draw hard validator：NONE + 数字 targetPrice 拒绝', function () {
    var p = baseValid();
    p.drawOnLiquidity = { direction: 'NONE', targetPrice: 65569.2, reason: 'no active draw' };
    assert.throws(function () {
        validator.validate(p, { marketFacts: marketFactsForDraw('TAKEN', 'TAKEN') });
    }, /targetPrice 必须为 null/);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
