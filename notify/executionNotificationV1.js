'use strict';
function build(event, keyword) {
    var lines = [(keyword || '检测') + ' REAL ORDER EXECUTION V1',
        'event=' + event.type, 'symbol=' + event.symbol];
    if (event.tradeId) lines.push('tradeId=' + event.tradeId);
    if (event.reasonCode) lines.push('reason=' + event.reasonCode);
    if (event.critical) lines.push('severity=CRITICAL');
    if (event.detail) lines.push('detail=' + event.detail);
    return lines.join('\n');
}
module.exports = { build: build };
