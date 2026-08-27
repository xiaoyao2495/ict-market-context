'use strict';
// Golden-path notification smoke: WATCH -> FVG FIRST_TOUCH -> formatter -> DingTalk (mocked).
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const REPORT = path.join(ROOT, 'repository-production-core-reduction-v1');

// Mock DingTalk before anything requires it.
const dingTalk = require(path.join(ROOT, 'notify/dingTalk.js'));
let sentMessages = [];
let sendCalled = 0;
dingTalk.sendText = function (webhook, secret, msg) {
  sendCalled++;
  sentMessages.push({ webhook: webhook, secret: secret, msg: msg });
  return { errcode: 0, errmsg: 'ok' };
};

// Try to use the real production runtime's formatter (guarded main -> safe to require).
let live = null;
let buildMsg;
try {
  live = require(path.join(ROOT, 'scripts/live.js'));
  if (typeof live.buildFvgRetracementMessage === 'function') {
    buildMsg = function (watch, price, opts) { return live.buildFvgRetracementMessage(watch, price, opts); };
  }
} catch (e) {
  console.log('WARN: could not require scripts/live.js (' + e.message + '); falling back to notify module directly');
}
if (!buildMsg) {
  const pres = require(path.join(ROOT, 'notify/watchNotificationPresentationV1.js'));
  buildMsg = function (watch, price, opts) { return pres.build(watch, price, opts || {}); };
}

// Representative WATCH (BTCUSDT, BULLISH displacement -> native FVG first touch).
const watch = {
  symbol: 'BTCUSDT',
  direction: 'BULLISH',
  state: 'NOTIFIED',
  firstTouchPrice: 59250,
  touchStatus: 'FIRST_TOUCH',
  liquidityEvidenceV1: {
    primary: {
      source: 'SSL',
      sourcePrice: 58800,
      relation: 'BEFORE_LEG',
      side: 'BULLISH'
    },
    candidates: [{ source: 'SSL', sourcePrice: 58800 }]
  },
  displacement: { direction: 'BULLISH', quality: 'STRONG', startIndex: 0, endIndex: 3 },
  mss: { exists: true, direction: 'BULLISH', referencePrice: 60000, referenceRole: 'PDH', protectedBreak: true },
  nativeFvg: { low: 59000, high: 59500, midpoint: 59250, touchStatus: 'FIRST_TOUCH' }
};

const fmtPrice = function (p) { return p != null ? Number(p).toFixed(2) : '-'; };

let passed = false;
let detail = {};
try {
  const msg = buildMsg(watch, 59250, {
    zhEnabled: true,
    sweepContextEnabled: true,
    keyword: '检测',
    formatPrice: fmtPrice,
    notificationGeneratedAt: Date.now()
  });
  detail.formatterOutputType = typeof msg;
  detail.formatterOutputLength = (msg || '').length;
  detail.containsSymbol = (msg || '').indexOf('BTCUSDT') >= 0;
  detail.containsFvg = (msg || '').indexOf('原生 FVG') >= 0 || (msg || '').indexOf('FVG') >= 0;
  if (typeof msg === 'string' && msg.length > 0 && detail.containsSymbol) {
    // Simulate the production delivery: deliverWatchTouch builds msg then calls dingTalk.sendText.
    const res = dingTalk.sendText('https://oapi.dingtalk.com/robot/send?access_token=MOCK', 'MOCK_SECRET', msg);
    detail.deliveryResult = res;
    detail.sendCalled = sendCalled;
    detail.deliveryErrcode = res ? res.errcode : null;
    passed = (res && res.errcode === 0);
  }
} catch (e) {
  detail.error = e.message;
  detail.stack = e.stack;
}

const report = {
  GOLDEN_NOTIFICATION_SMOKE_PASSED: passed,
  usedLiveRuntime: !!live,
  detail: detail
};
fs.writeFileSync(path.join(REPORT, 'golden-path-smoke.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(passed ? 0 : 1);
