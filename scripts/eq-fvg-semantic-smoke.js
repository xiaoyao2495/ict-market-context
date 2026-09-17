#!/usr/bin/env node
'use strict';

require('../config/loadEnv')();
var path = require('path');
var dataSource = require('../live/dataSource');
var liveEngine = require('../live/liveEngine');
var watchModel = require('../live/eqFvgCountWatchV1');
var semanticService = require('../live/eqFvgAssociationSemanticV1');
var semanticStore = require('../semantic/eqFvgAssociationDecisionStoreV1');
var caseArchive = require('../semantic/eqFvgAssociationCaseArchiveV1');
var notification = require('../notify/eqFvgCountWatchNotificationV1');
var dingTalk = require('../notify/dingTalk');

async function main() {
    if (process.env.LIVE_TRADING_ENABLED !== 'false') throw new Error('SMOKE_REQUIRES_LITERAL_LIVE_TRADING_ENABLED_FALSE');
    if (!process.env.DINGTALK_WEBHOOK) throw new Error('DINGTALK_WEBHOOK_REQUIRED');
    var symbol = process.env.EQ_FVG_SEMANTIC_SMOKE_SYMBOL || 'BTCUSDT';
    var at = Date.now(), data = await dataSource.fetchProductionBootstrap(symbol, at);
    if (!dataSource.analysisHistoryReady(data)) throw new Error('SMOKE_PRODUCTION_HISTORY_NOT_READY');
    var engine = liveEngine.createLiveEngine({ symbol: symbol, exchangeInfo: data.exchangeInfo,
        structureCandles: { '1h': data['1h'], '4h': data['4h'], '1d': data['1d'] } });
    // TWO_BAR_PRODUCTION_REPLACEMENT_V1: the live engine no longer emits the
    // retired EQ -> WATCH -> raw-FVG step stream, so this research smoke rebuilds
    // it from the closed-candle window with the retired model's own builder.
    var machine = watchModel.createStateMachine(), candidates = [];
    for (var i = 0; i < data['5m'].length; i++) {
        var eqBefore = engine.getState().productionEq.events.length;
        await engine.onBar(data['5m'][i], i);
        var step = watchModel.buildStep(engine.getWindowSnapshot(), i, symbol,
            engine.getState().productionEq.events.slice(eqBefore), [], data['5m'][i].closeTime);
        var result = machine.step({ evaluationTime: step.evaluationTime,
            newEqualLiquidity: step.newEqualLiquidity || [], rawFvg: step.rawFvg });
        (result.notifications || []).forEach(function (event) { if (event.ordinal === 1) candidates.push(event); });
    }
    if (!candidates.length) throw new Error('SMOKE_NO_EQ_FIRST_MATCHING_FVG_IN_PRODUCTION_WINDOW');
    var candidate = candidates[candidates.length - 1];
    var root = path.join(__dirname, '..', '.live-state');
    var service = semanticService.createService({ config: { enabled: true, liveGateEnabled: true, failClosed: true },
        store: semanticStore.createStore({ directory: path.join(root, 'eq-fvg-association-semantic-v1') }),
        archive: caseArchive.createArchive({ directory: path.join(root, symbol, 'eq-fvg-association-cases-v1') }).write,
        observe: function (record) { console.log(record.event + ' ' + JSON.stringify(record)); },
        notify: function (event, result) {
            var enriched = Object.assign({}, event, { eqFvgSemantic: result });
            var message = notification.build(enriched, { keyword: process.env.DINGTALK_KEYWORD || '检测' });
            return dingTalk.sendText(process.env.DINGTALK_WEBHOOK, process.env.DINGTALK_SECRET || '', message).then(function (response) {
                if (!response || response.errcode !== 0) throw new Error('DINGTALK_DELIVERY_FAILED');
            });
        }
    });
    var result = await service.evaluate(candidate, { state: engine.getState(), candles: engine.getWindowSnapshot() });
    console.log('SEMANTIC_SMOKE=' + (result.status === 'AVAILABLE' ? 'PASS' : 'FAIL'));
    console.log('LIVE_TRADING_ENABLED=false');
    console.log('REAL_ORDERS_SENT=0');
    console.log('ACCOUNT_MUTATIONS=0');
    console.log('SAMPLE=' + JSON.stringify({ symbol: symbol, eqId: candidate.liquidityId, fvgId: candidate.rawFvg.id,
        association: result.decision && result.decision.association, confidence: result.decision && result.decision.confidence,
        primaryReason: result.decision && result.decision.primaryReason, semanticGate: result.gateResult,
        semanticGateReason: result.gateReason, factsHash: result.factsHash, decisionKey: result.decisionKey,
        decisionSource: result.decisionSource, usage: result.usage, semanticCallDurationMs: result.semanticCallDurationMs }));
    if (result.status !== 'AVAILABLE') process.exitCode = 1;
}

if (require.main === module) main().catch(function (error) {
    console.error('SEMANTIC_SMOKE=FAIL'); console.error('ERROR=' + (error.code || error.message));
    console.log('REAL_ORDERS_SENT=0'); console.log('ACCOUNT_MUTATIONS=0'); process.exitCode = 1;
});

module.exports = { main: main };
