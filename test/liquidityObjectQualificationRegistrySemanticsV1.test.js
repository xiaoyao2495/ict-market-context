'use strict';

var assert = require('assert');
var audit = require('../audit/liquidityObjectQualificationRegistrySemanticsV1');
var passed = 0;
var failed = 0;
function describe(name, fn) { console.log(name); fn(); }
function it(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.error('FAIL  ' + name + ' -> ' + error.message); }
}

function swing(id, type, confirmedAt, price) {
    return { id:id, symbol:'BTCUSDT', timeframe:'5m', type:type,
        side:type === 'SWING_HIGH' ? 'BSL' : 'SSL', price:price,
        createdAt:confirmedAt, confirmedAt:confirmedAt, status:'ACTIVE',
        touchedAt:null, sweptAt:null, brokenAt:null, metadata:{} };
}
function record(id, history) { return { id:'STRUCT:'+id, sourceSwingId:id, history:history }; }
function candle(t, high, low, close) { return { openTime:t-299999, closeTime:t, open:close, high:high, low:low, close:close, closed:true }; }

describe('Liquidity Object Qualification / Registry Semantics Audit V1', function () {
    it('LOCAL_SWING alone never qualifies as structural', function () {
        assert.strictEqual(audit.structuralQualification(record('s1', [
            { role:'LOCAL_SWING', confirmedAt:100 }
        ])), null);
    });
    it('INTERNAL remains descriptive and is not an independent structural reference', function () {
        assert.strictEqual(audit.structuralQualification(record('s1', [
            { role:'LOCAL_SWING', confirmedAt:100 }, { role:'INTERNAL', confirmedAt:200 }
        ])), null);
    });
    it('uses first existing structural transition as availability time', function () {
        var q = audit.structuralQualification(record('s1', [
            { role:'LOCAL_SWING', confirmedAt:100 },
            { role:'CONTROLLING_SWING', confirmedAt:300 },
            { role:'ACTIVE_PROTECTED', confirmedAt:500 }
        ]));
        assert.deepStrictEqual([q.role, q.availableAt], ['CONTROLLING_SWING', 300]);
    });
    it('does not backfill future structural qualification', function () {
        var r = record('s1', [{role:'LOCAL_SWING',confirmedAt:100},{role:'ACTIVE_PROTECTED',confirmedAt:300}]);
        assert.strictEqual(audit.qualificationAt(r, 299), false);
        assert.strictEqual(audit.qualificationAt(r, 300), true);
    });
    it('roleAt is time-local', function () {
        var r = record('s1', [{role:'LOCAL_SWING',confirmedAt:100},{role:'ACTIVE_PROTECTED',confirmedAt:300}]);
        assert.strictEqual(audit.roleAt(r, 200), 'LOCAL_SWING');
        assert.strictEqual(audit.roleAt(r, 300), 'ACTIVE_PROTECTED');
    });
    it('legacy retains every swing', function () {
        var ids = audit.projectObjectIds([swing('s1','SWING_HIGH',100,10)], {}, 'A_LEGACY');
        assert.strictEqual(ids.s1, true);
    });
    it('structural-only removes an unqualified local pivot', function () {
        var ids = audit.projectObjectIds([swing('s1','SWING_HIGH',100,10)], {s1:record('s1',[{role:'LOCAL_SWING',confirmedAt:100}])}, 'B_STRUCTURAL_ONLY');
        assert.strictEqual(ids.s1, undefined);
    });
    it('structural-only keeps a qualified swing', function () {
        var ids = audit.projectObjectIds([swing('s1','SWING_HIGH',100,10)], {s1:record('s1',[{role:'CONTROLLING_SWING',confirmedAt:200}])}, 'B_STRUCTURAL_ONLY');
        assert.strictEqual(ids.s1, true);
    });
    it('structural-only EQ requires all members qualified at EQ formation', function () {
        var a=swing('a','SWING_HIGH',100,10), b=swing('b','SWING_HIGH',200,10);
        var eq={id:'eq',type:'EQH',confirmedAt:250,metadata:{members:[a,b]}};
        var map={a:record('a',[{role:'CONTROLLING_SWING',confirmedAt:150}]),b:record('b',[{role:'CONTROLLING_SWING',confirmedAt:300}])};
        assert.strictEqual(audit.eqStructurallyFormed(eq,map), false);
    });
    it('EQ-preserving reduction keeps frozen EQ identity', function () {
        var a=swing('a','SWING_HIGH',100,10), b=swing('b','SWING_HIGH',200,10);
        var eq={id:'eq',type:'EQH',confirmedAt:250,metadata:{members:[a,b]}};
        var ids=audit.projectObjectIds([a,b,eq],{},'C_EQ_PRESERVING_REDUCTION');
        assert.strictEqual(ids.eq,true);
        assert.strictEqual(ids.a,undefined);
    });
    it('qualification lifecycle starts at qualification, not pivot confirmation', function () {
        var s=swing('s1','SWING_HIGH',100,10);
        var result=audit.simulateQualifiedSwing(s,{availableAt:300,role:'CONTROLLING_SWING'},[
            candle(200,11,9,9), candle(400,11,9,9)
        ],500);
        assert.strictEqual(result.object.confirmedAt,300);
        assert.strictEqual(result.object.status,'SWEPT');
        assert.strictEqual(result.object.sweptAt,400);
    });
    it('pre-qualification sweep is rejected', function () {
        var s=swing('s1','SWING_HIGH',100,10);
        var result=audit.simulateQualifiedSwing(s,{availableAt:300,role:'CONTROLLING_SWING'},[
            candle(200,11,9,9), candle(400,9.5,8,9)
        ],500);
        assert.strictEqual(result.object.status,'ACTIVE');
        assert.strictEqual(result.sweepEvent,null);
    });
    it('post-qualification break follows frozen lifecycle semantics', function () {
        var s=swing('s1','SWING_HIGH',100,10);
        var result=audit.simulateQualifiedSwing(s,{availableAt:300,role:'CONTROLLING_SWING'},[
            candle(400,11,9,10.5)
        ],500);
        assert.strictEqual(result.object.status,'BROKEN');
        assert.strictEqual(result.sweepEvent,null);
    });
    it('policy projection replaces legacy swing sweep with time-local simulated sweep', function () {
        var s=swing('s1','SWING_HIGH',100,10);
        var old={id:'old',liquidityId:'s1',confirmedAt:200};
        var p=audit.projectPolicy({policy:'B_STRUCTURAL_ONLY',objects:[s],
            structuralBySourceId:{s1:record('s1',[{role:'CONTROLLING_SWING',confirmedAt:300}])},
            sweepEvents:[old],candles:[candle(400,11,9,9)],endTime:500});
        assert.strictEqual(p.sweepEvents.length,1);
        assert.strictEqual(p.sweepEvents[0].confirmedAt,400);
    });
    it('future leak validator accepts qualification-safe projection', function () {
        var s=swing('s1','SWING_LOW',100,10);
        var p=audit.projectPolicy({policy:'C_EQ_PRESERVING_REDUCTION',objects:[s],
            structuralBySourceId:{s1:record('s1',[{role:'ACTIVE_PROTECTED',confirmedAt:300}])},
            candles:[],sweepEvents:[],endTime:500});
        assert.deepStrictEqual(audit.futureLeakViolations(p),[]);
    });
    it('policy projection is deterministic', function () {
        var s=swing('s1','SWING_LOW',100,10), opts={policy:'C_EQ_PRESERVING_REDUCTION',objects:[s],
            structuralBySourceId:{s1:record('s1',[{role:'CONTROLLING_SWING',confirmedAt:300}])},candles:[],sweepEvents:[],endTime:500};
        assert.deepStrictEqual(audit.projectPolicy(opts),audit.projectPolicy(opts));
    });
});

console.log('liquidityObjectQualificationRegistrySemanticsV1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
