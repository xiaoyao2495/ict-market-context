'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var projectorModule = require('../audit/swingContextProjectorV1');

function swing() {
    return { canonicalSwingId: 's1', side: 'LOW', price: 100, occurredAt: 10, confirmedAt: 20, timeframeMembership: {
        '5m': { member: true, htfSwingId: 's1', occurredAt: 10, confirmedAt: 20 },
        '15m': { member: true, htfSwingId: '15', occurredAt: 0, confirmedAt: 40, mappingProvenance: { method: 'exact' } },
        '1h': { member: true, htfSwingId: '1h', occurredAt: 0, confirmedAt: 60, mappingProvenance: { method: 'exact' } },
        '4h': { member: true, htfSwingId: '4h', occurredAt: 0, confirmedAt: 80, mappingProvenance: { method: 'exact' } }
    } };
}
function transitions() {
    return [
        { sourceSwingId: 's1', role: 'LOCAL_SWING', status: 'CANDIDATE', confirmedAt: 20, sequence: 0 },
        { sourceSwingId: 's1', role: 'CONTROLLING_SWING', status: 'CANDIDATE', confirmedAt: 30, sequence: 1 },
        { sourceSwingId: 's1', role: 'ACTIVE_PROTECTED', status: 'ACTIVE_PROTECTED', confirmedAt: 40, sequence: 2 },
        { sourceSwingId: 's1', role: 'SUPERSEDED_PROTECTED', status: 'SUPERSEDED_PROTECTED', confirmedAt: 50, sequence: 3 },
        { sourceSwingId: 's1', role: 'ACTIVE_PROTECTED', status: 'ACTIVE_PROTECTED', confirmedAt: 70, sequence: 4 },
        { sourceSwingId: 's1', role: 'BROKEN', status: 'BROKEN', confirmedAt: 90, sequence: 5 }
    ];
}
function make(ts) { return projectorModule.createSwingContextProjectorV1({ swings: [swing()], structuralTransitions: ts || transitions() }); }

test('fail closed before 5m confirmation', function () { assert.equal(make().projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 19 }), null); });
test('LOCAL to CONTROLLING preserves past snapshot', function () { var p = make(), before = p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 25 }), frozen = projectorModule.hash(before); assert.equal(before.structural.currentRole, 'LOCAL_SWING'); assert.equal(p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 35 }).structural.currentRole, 'CONTROLLING_SWING'); assert.equal(projectorModule.hash(before), frozen); });
test('CONTROLLING to ACTIVE_PROTECTED', function () { assert.equal(make().projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 40 }).structural.currentRole, 'ACTIVE_PROTECTED'); });
test('ACTIVE_PROTECTED to SUPERSEDED_PROTECTED', function () { assert.equal(make().projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 50 }).structural.currentRole, 'SUPERSEDED_PROTECTED'); });
test('ACTIVE_PROTECTED to BROKEN is not visible before break', function () { var p = make(); assert.equal(p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 89 }).structural.currentRole, 'ACTIVE_PROTECTED'); assert.equal(p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 90 }).structural.currentRole, 'BROKEN'); });
test('MTF evolves only at each confirmedAt and withholds future identity', function () { var p = make(), t1 = p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 20 }), t2 = p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 40 }), t3 = p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 60 }), t4 = p.projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 80 }); assert.equal(t1.timeframeMembership['15m'].confirmed, false); assert.equal(t1.timeframeMembership['15m'].swingId, null); assert.equal(t2.timeframeMembership['15m'].confirmed, true); assert.equal(t2.timeframeMembership['1h'].confirmed, false); assert.equal(t3.timeframeMembership['1h'].confirmed, true); assert.equal(t4.timeframeMembership['4h'].confirmed, true); });
test('structural and MTF dimensions stay orthogonal and no score exists', function () { var context = make().projectSwingContextV1({ canonicalSwingId: 's1', evaluationTime: 80 }); assert.equal(context.structural.currentRole, 'ACTIVE_PROTECTED'); assert.equal(context.timeframeMembership['4h'].confirmed, true); assert.equal(JSON.stringify(context).includes('Score'), false); });
test('normal/reversed/shuffled transitions and batch identity are deterministic', function () { var normal = make(), reversed = make(transitions().reverse()), shuffled = make([transitions()[3], transitions()[0], transitions()[5], transitions()[1], transitions()[4], transitions()[2]]), request = { canonicalSwingId: 's1', evaluationTime: 90 }; assert.equal(projectorModule.hash(normal.projectSwingContextV1(request)), projectorModule.hash(reversed.projectSwingContextV1(request))); assert.equal(projectorModule.hash(normal.projectSwingContextV1(request)), projectorModule.hash(shuffled.projectSwingContextV1(request))); assert.equal(normal.projectSwingContextsV1({ canonicalSwingIds: ['s1'], evaluationTime: 90 }).length, 1); });
