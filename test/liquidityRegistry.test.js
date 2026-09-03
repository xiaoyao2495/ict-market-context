/**
 * liquidityRegistry 单元测试
 *
 * 核心验证点：
 * - id 去重（相同 id 不允许重复加入）
 * - addMany 计数
 * - getById / getAll / getActive / getBySide / getBSL / getSSL / getByType
 * - symbol 过滤
 * - clear / size
 *
 * REMOVE_CALENDAR_NAMED_LIQUIDITY_V1 治理约束：
 * PDH/PDL/PWH/PWL/PMH/PML 已被 liquidityRegistry.add() 的 denylist 拒绝准入
 * （返回 false）。本测试不再使用这 6 类作为 fixture，一律改用合法的
 * 生产类型（EQH/EQL/SWING_HIGH/SWING_LOW）。
 */
var assert = require('assert');
var liquidityRegistry = require('../liquidity/liquidityRegistry');

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

function makeLiquidity(id, symbol, type, side, price) {
    return {
        id: id,
        symbol: symbol,
        timeframe: '5m',
        type: type,
        side: side,
        price: price,
        sourceOpenTime: 0,
        sourceCloseTime: 0,
        createdAt: 0,
        confirmedAt: 0,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {}
    };
}

test('add：新增成功返回 true，重复 id 返回 false', function () {
    var r = liquidityRegistry.createRegistry();
    var l = makeLiquidity('BTCUSDT:5m:SWING_HIGH:1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100);
    assert.strictEqual(r.add(l), true);
    assert.strictEqual(r.add(l), false); // 去重
    assert.strictEqual(r.size(), 1);
});

test('add：无 id / null 不加入', function () {
    var r = liquidityRegistry.createRegistry();
    assert.strictEqual(r.add(null), false);
    assert.strictEqual(r.add({ type: 'EQH', side: 'BSL' }), false); // 缺 id
    assert.strictEqual(r.size(), 0);
});

test('addMany：返回实际加入数量（去重后）', function () {
    var r = liquidityRegistry.createRegistry();
    var list = [
        makeLiquidity('BTCUSDT:EQH:2026-08-16', 'BTCUSDT', 'EQH', 'BSL', 100),
        makeLiquidity('BTCUSDT:EQL:2026-08-16', 'BTCUSDT', 'EQL', 'SSL', 90),
        makeLiquidity('BTCUSDT:EQH:2026-08-16', 'BTCUSDT', 'EQH', 'BSL', 100) // 重复
    ];
    assert.strictEqual(r.addMany(list), 2);
    assert.strictEqual(r.size(), 2);
});

test('getById：命中 / 未命中', function () {
    var r = liquidityRegistry.createRegistry();
    var l = makeLiquidity('X1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100);
    r.add(l);
    assert.strictEqual(r.getById('X1'), l);
    assert.strictEqual(r.getById('NOT_EXIST'), null);
});

test('getAll：按 symbol 过滤，保持加入顺序', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    r.add(makeLiquidity('B1', 'ETHUSDT', 'SWING_LOW', 'SSL', 50));
    r.add(makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 99));

    var btc = r.getAll('BTCUSDT');
    assert.strictEqual(btc.length, 2);
    assert.strictEqual(btc[0].id, 'A1');
    assert.strictEqual(btc[1].id, 'A2');

    var eth = r.getAll('ETHUSDT');
    assert.strictEqual(eth.length, 1);
    assert.strictEqual(eth[0].id, 'B1');

    assert.strictEqual(r.getAll().length, 3); // 不带 symbol = 全部
});

test('getBySide / getBSL / getSSL', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    r.add(makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 99));
    r.add(makeLiquidity('A3', 'BTCUSDT', 'EQH', 'BSL', 110));

    assert.strictEqual(r.getBySide('BTCUSDT', 'BSL').length, 2);
    assert.strictEqual(r.getBySide('BTCUSDT', 'SSL').length, 1);
    assert.strictEqual(r.getBSL('BTCUSDT').length, 2);
    assert.strictEqual(r.getSSL('BTCUSDT').length, 1);
    assert.strictEqual(r.getSSL('ETHUSDT').length, 0);
});

test('getByType', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    r.add(makeLiquidity('A2', 'BTCUSDT', 'EQH', 'BSL', 110));
    r.add(makeLiquidity('A3', 'BTCUSDT', 'EQL', 'SSL', 90));

    assert.strictEqual(r.getByType('BTCUSDT', 'EQH').length, 1);
    assert.strictEqual(r.getByType('BTCUSDT', 'SWING_HIGH').length, 1);
    assert.strictEqual(r.getByType('BTCUSDT', 'PWL').length, 0);
});

test('getActive：只返回 ACTIVE（SWEPT/BROKEN 不进入）', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    var swept = makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 99);
    swept.status = 'SWEPT';
    r.add(swept);
    var broken = makeLiquidity('A3', 'BTCUSDT', 'SWING_HIGH', 'BSL', 110);
    broken.status = 'BROKEN';
    r.add(broken);

    assert.strictEqual(r.getActive('BTCUSDT').length, 1);
    assert.strictEqual(r.getActive('BTCUSDT')[0].id, 'A1');
    assert.strictEqual(r.getAll('BTCUSDT').length, 3); // 全量仍保留
});

test('clear：清空后 size = 0', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    r.clear();
    assert.strictEqual(r.size(), 0);
    assert.strictEqual(r.getById('A1'), null);
});

/* ---------- Phase 3：状态更新 ---------- */

test('update：patch 正确写入，undefined 字段不覆盖', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    var updated = r.update('A1', {
        status: 'SWEPT',
        sweptAt: 12345,
        undefinedField: undefined
    });
    assert.strictEqual(updated.status, 'SWEPT');
    assert.strictEqual(updated.sweptAt, 12345);
    assert.strictEqual(updated.symbol, 'BTCUSDT'); // 未动的字段保留
    assert.strictEqual(updated.touchedAt, null); // 未传的字段不受影响
});

test('update：不存在的 id → null', function () {
    var r = liquidityRegistry.createRegistry();
    assert.strictEqual(r.update('NOPE', { status: 'SWEPT' }), null);
});

test('applyLifecycleEvent：状态变化正确写回', function () {
    var r = liquidityRegistry.createRegistry();
    var l = makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100);
    r.add(l);
    var result = {
        previousStatus: 'ACTIVE',
        status: 'SWEPT',
        touchedAt: 111,
        sweptAt: 222,
        brokenAt: null,
        event: { type: 'LIQUIDITY_SWEPT', side: 'BSL', at: 222 }
    };
    var updated = r.applyLifecycleEvent('A1', result);
    assert.strictEqual(updated.status, 'SWEPT');
    assert.strictEqual(updated.sweptAt, 222);
    assert.strictEqual(updated.touchedAt, 111);
    assert.strictEqual(updated.brokenAt, null);
    // 不删除：getAll 仍包含
    assert.strictEqual(r.getAll('BTCUSDT').length, 1);
});

test('applyLifecycleEvent：null result / 不存在 id → null', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    assert.strictEqual(r.applyLifecycleEvent('A1', null), null);
    assert.strictEqual(r.applyLifecycleEvent('NOPE', { status: 'BROKEN' }), null);
});

test('getByStatus：正确按状态过滤', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    var swept = makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 99);
    swept.status = 'SWEPT';
    r.add(swept);
    var broken = makeLiquidity('A3', 'BTCUSDT', 'SWING_HIGH', 'BSL', 110);
    broken.status = 'BROKEN';
    r.add(broken);

    assert.strictEqual(r.getByStatus('BTCUSDT', 'ACTIVE').length, 1);
    assert.strictEqual(r.getByStatus('BTCUSDT', 'SWEPT').length, 1);
    assert.strictEqual(r.getByStatus('BTCUSDT', 'BROKEN').length, 1);
    assert.strictEqual(r.getByStatus('BTCUSDT', 'TOUCHED').length, 0);
    assert.strictEqual(r.getByStatus('ETHUSDT', 'SWEPT').length, 0);
});

test('SWEPT/BROKEN 不删除：全量仍可查询，getActive 不返回', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    var swept = makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 90);
    swept.status = 'SWEPT';
    r.add(swept);
    var broken = makeLiquidity('A3', 'BTCUSDT', 'SWING_HIGH', 'BSL', 110);
    broken.status = 'BROKEN';
    r.add(broken);

    assert.strictEqual(r.getAll('BTCUSDT').length, 3); // 全部保留
    assert.strictEqual(r.getActive('BTCUSDT').length, 1); // 只 ACTIVE
    assert.strictEqual(r.getActive('BTCUSDT')[0].id, 'A1');
    assert.strictEqual(r.getById('A2').status, 'SWEPT'); // 历史仍可查
    assert.strictEqual(r.getById('A3').status, 'BROKEN');
});

/* ---------- Phase 4：便捷查询 ---------- */

test('getActiveBySide：ACTIVE + side 双条件', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100));
    var swept = makeLiquidity('A2', 'BTCUSDT', 'EQH', 'BSL', 110);
    swept.status = 'SWEPT';
    r.add(swept);
    r.add(makeLiquidity('A3', 'BTCUSDT', 'SWING_LOW', 'SSL', 90));

    var bsl = r.getActiveBySide('BTCUSDT', 'BSL');
    assert.strictEqual(bsl.length, 1);
    assert.strictEqual(bsl[0].id, 'A1'); // SWEPT 的 EQH 不进入
    assert.strictEqual(r.getActiveBySide('BTCUSDT', 'SSL').length, 1);
});

test('getActiveAt：回放时刻之前未确认的流动性不可见', function () {
    var r = liquidityRegistry.createRegistry();
    var early = makeLiquidity('A1', 'BTCUSDT', 'SWING_HIGH', 'BSL', 100);
    early.confirmedAt = 1000;
    r.add(early);
    var late = makeLiquidity('A2', 'BTCUSDT', 'SWING_LOW', 'SSL', 90);
    late.confirmedAt = 5000;
    r.add(late);

    var atT1 = r.getActiveAt('BTCUSDT', 2000);
    assert.strictEqual(atT1.length, 1);
    assert.strictEqual(atT1[0].id, 'A1'); // A2 尚未确认

    var atT2 = r.getActiveAt('BTCUSDT', 6000);
    assert.strictEqual(atT2.length, 2);
});

test('getActiveByType：ACTIVE + type 双条件', function () {
    var r = liquidityRegistry.createRegistry();
    r.add(makeLiquidity('A1', 'BTCUSDT', 'EQH', 'BSL', 100));
    var swept = makeLiquidity('A2', 'BTCUSDT', 'EQH', 'BSL', 110);
    swept.status = 'SWEPT';
    r.add(swept);
    r.add(makeLiquidity('A3', 'BTCUSDT', 'SWING_HIGH', 'BSL', 105));

    var eqh = r.getActiveByType('BTCUSDT', 'EQH');
    assert.strictEqual(eqh.length, 1);
    assert.strictEqual(eqh[0].id, 'A1');
    assert.strictEqual(r.getActiveByType('BTCUSDT', 'SWING_HIGH').length, 1);
});

console.log('----');
console.log('liquidityRegistry: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
