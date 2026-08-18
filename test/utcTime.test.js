/**
 * utcTime 单元测试：UTC 日 / 周边界
 */
var assert = require('assert');
var utcTime = require('../utils/utcTime');

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

test('startOfDayUTC：2026-08-17 正午 → 2026-08-17 00:00 UTC', function () {
    var ms = Date.UTC(2026, 7, 17, 12, 34, 56, 789);
    assert.strictEqual(utcTime.startOfDayUTC(ms), Date.UTC(2026, 7, 17));
});

test('startOfDayUTC：23:59:59.999 仍属于当天', function () {
    var ms = Date.UTC(2026, 7, 17, 23, 59, 59, 999);
    assert.strictEqual(utcTime.startOfDayUTC(ms), Date.UTC(2026, 7, 17));
});

test('startOfWeekUTC：2026-08-17（周一）→ 2026-08-17 00:00 UTC', function () {
    var ms = Date.UTC(2026, 7, 17, 10, 0, 0);
    assert.strictEqual(utcTime.startOfWeekUTC(ms), Date.UTC(2026, 7, 17));
});

test('startOfWeekUTC：2026-08-16（周日）→ 2026-08-10 00:00 UTC', function () {
    var ms = Date.UTC(2026, 7, 16, 23, 59, 59, 999);
    assert.strictEqual(utcTime.startOfWeekUTC(ms), Date.UTC(2026, 7, 10));
});

test('startOfWeekUTC：2026-08-12（周三）→ 2026-08-10 00:00 UTC', function () {
    var ms = Date.UTC(2026, 7, 12, 12, 0, 0);
    assert.strictEqual(utcTime.startOfWeekUTC(ms), Date.UTC(2026, 7, 10));
});

test('startOfWeekUTC：2026-08-09（周日）→ 2026-08-03 00:00 UTC', function () {
    var ms = Date.UTC(2026, 7, 9, 8, 0, 0);
    assert.strictEqual(utcTime.startOfWeekUTC(ms), Date.UTC(2026, 7, 3));
});

test('formatDateUTC：补零正确', function () {
    assert.strictEqual(utcTime.formatDateUTC(Date.UTC(2026, 7, 17)), '2026-08-17');
    assert.strictEqual(utcTime.formatDateUTC(Date.UTC(2026, 0, 5)), '2026-01-05');
});

/* ---------- 月边界（Phase 4） ---------- */

test('startOfMonthUTC：2026-08-17 → 2026-08-01', function () {
    assert.strictEqual(utcTime.startOfMonthUTC(Date.UTC(2026, 7, 17)), Date.UTC(2026, 7, 1));
});

test('startOfMonthUTC：月末最后一天仍属于当月', function () {
    assert.strictEqual(
        utcTime.startOfMonthUTC(Date.UTC(2026, 7, 31, 23, 59, 59, 999)),
        Date.UTC(2026, 7, 1)
    );
});

test('previousCompleteMonthStart：2026-08-17 → 2026-07-01', function () {
    assert.strictEqual(
        utcTime.previousCompleteMonthStart(Date.UTC(2026, 7, 17)),
        Date.UTC(2026, 6, 1)
    );
});

test('previousCompleteMonthStart：8 月 1 日 00:00 → 上一完整月仍为 7 月', function () {
    assert.strictEqual(
        utcTime.previousCompleteMonthStart(Date.UTC(2026, 7, 1, 0, 0, 0, 0)),
        Date.UTC(2026, 6, 1)
    );
});

test('previousCompleteMonthStart：1 月跨年到上一年 12 月', function () {
    assert.strictEqual(
        utcTime.previousCompleteMonthStart(Date.UTC(2026, 0, 15)),
        Date.UTC(2025, 11, 1)
    );
});

test('formatMonthUTC：YYYY-MM 格式', function () {
    assert.strictEqual(utcTime.formatMonthUTC(Date.UTC(2026, 7, 1)), '2026-08');
    assert.strictEqual(utcTime.formatMonthUTC(Date.UTC(2025, 11, 15)), '2025-12');
});

console.log('----');
console.log('utcTime: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
