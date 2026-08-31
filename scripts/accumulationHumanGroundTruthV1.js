'use strict';

var fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
var audit=require('../audit/accumulationGroundTruthV1');
var thresholds=require('../config/thresholds');
var pivotDetector=require('../structure/pivotDetector');
var swingLiquidity=require('../liquidity/swingLiquidity');
var structural=require('../structure/structuralProvenance5m');
var displacementDetector=require('../events/displacementDetector');
var replayEngine=require('../replay/replayEngine');

var ROOT='/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var SOURCE=path.join(ROOT,'accumulation-detection-research-v1');
var INPUT=path.join(ROOT,'eqh-eql-persistent-cluster-shadow-v3','BTCUSDT-5m-bounded-input.json');
var OUT=process.argv[2]?path.resolve(process.argv[2]):path.join(ROOT,'accumulation-human-ground-truth-v1');
function ensure(){fs.mkdirSync(OUT,{recursive:true});}
function json(name,x){fs.writeFileSync(path.join(OUT,name),JSON.stringify(x,null,2)+'\n');}
function sha(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function csvValue(v){if(v===null||v===undefined)return'';var s=typeof v==='object'?JSON.stringify(v):String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}

function buildProductionDisplacements(candles){
    var pivots=pivotDetector.detectPivots(candles,{left:2,right:2});
    var swings=swingLiquidity.buildSwingLiquidity('BTCUSDT','5m',pivots,candles,2);
    var byConfirmed={};swings.forEach(function(s){(byConfirmed[s.confirmedAt]=byConfirmed[s.confirmedAt]||[]).push(s);});
    var state=structural.createState({symbol:'BTCUSDT',timeframe:'5m'}),mss=[];
    candles.forEach(function(c,i){var step=structural.step(state,c,i,byConfirmed[c.closeTime]||[]);Array.prototype.push.apply(mss,step.mss);});
    var atrSeries={},prev=null;
    candles.forEach(function(c,i){prev=replayEngine._updateAtrIncremental(atrSeries,candles,i,prev,14);});
    return displacementDetector.detectSingleCandleDisplacement(candles,{symbol:'BTCUSDT',timeframe:'5m',baseIndex:0,atrSeries:atrSeries,thresholds:thresholds}).map(function(d){return Object.assign({candleIndex:d.endIndex},d);});
}

var columns=['caseId','detectorLabel','humanLabel','durationBars','rangeWidthATR','directionalEfficiency','directionalDriftATR','upperTouchCount','lowerTouchCount','midCrossCount','rangeOccupancy','preRangeDirectionalMoveATR','preRangeSlope','preRangeContext','firstHalfUpperTouches','secondHalfUpperTouches','firstHalfLowerTouches','secondHalfLowerTouches','firstHalfMidCrosses','secondHalfMidCrosses','touchTemporalCoverage','midCrossTemporalCoverage','longestOneSideResidenceBars','longestNoMidCrossBars','lowerOccupancyPct','midOccupancyPct','upperOccupancyPct','highEstablishedBar','lowEstablishedBar','highEstablishedPct','lowEstablishedPct','rangeExpansionEvents','lateRangeExpansionPct','lateBoundaryFormation','firstThirdMeanPosition','middleThirdMeanPosition','lastThirdMeanPosition','formationPositionShift','internalDisplacementCount','bullishInternalDisplacementCount','bearishInternalDisplacementCount','strongInternalDisplacementCount','largestInternalDisplacementATR','eqContribution','scoreWithEQ','scoreWithoutEQ','passesThresholdWithEQ','passesThresholdWithoutEQ','eqDependentConfirmation','rawScoreComponents','totalScore'];
function writeTable(name,rows){var lines=[columns.join(',')];rows.forEach(function(r){lines.push(columns.map(function(k){var v=k==='caseId'?r.caseId:k==='detectorLabel'?r.detectorLabel:k==='humanLabel'?r.humanLabel:r.featureSnapshot[k];return csvValue(v);}).join(','));});fs.writeFileSync(path.join(OUT,name),lines.join('\n')+'\n');}

function numericAudit(rows){var out={};columns.slice(3).forEach(function(k){var vals=rows.map(function(r){return r.featureSnapshot[k];}).filter(Number.isFinite);if(vals.length)out[k]=audit.distribution(vals);});return out;}
function countDiagnostic(diags,name){return diags.filter(function(x){return x.diagnosis.indexOf(name)!==-1;}).length;}

function makeReport(summary,gt,featureAudit,diagnoses){
    var fp=gt.filter(function(x){return audit.FALSE_POSITIVE_CASES.indexOf(x.caseId)!==-1;});
    var borderline=gt.filter(function(x){return x.humanLabel==='BORDERLINE_A';});
    var eqFp=fp.filter(function(x){return x.featureSnapshot.eqDependentConfirmation;}).length;
    var eqBorder=borderline.filter(function(x){return x.featureSnapshot.eqDependentConfirmation;}).length;
    var fpWidth=featureAudit.cohorts.FALSE_POSITIVE.rangeWidthATR;
    var borderWidth=featureAudit.cohorts.BORDERLINE_A.rangeWidthATR;
    return '# Human Ground Truth V1 + False Positive Feature Audit\n\n'+
        '## 1. Human Ground Truth current status\n\nThis is a **PARTIAL_HUMAN_AUDIT**. Explicit human labels only: CLEAR_A 0, BORDERLINE_A 4, NO_A 17, UNREVIEWED 59. No accuracy, precision, recall, F1, or complete confusion matrix is reported. `REFERENCE_POSITIVE_COHORT_STATUS = INSUFFICIENT_HUMAN_LABELS`.\n\n'+
        'Human CLEAR/VALID Accumulation means persistent balance, a stable bounded range, repeated two-sided auction, repeated internal rebalancing, and lack of sustained directional delivery inside formation. **BOUNDING BOX ≠ ACCUMULATION.** Low efficiency, range width, mid-cross count, or EQ evidence alone is not the definition.\n\n'+
        '## 2. Confirmed false-positive cohort\n\n`'+audit.FALSE_POSITIVE_CASES.join(', ')+'` are the 13 explicit machine-positive `NO_A` cases. Their diagnoses are deterministic feature flags, not reject decisions.\n\n'+
        '## 3. Borderline cohort\n\nMachine-positive: `case022, case036, case037`; machine-negative protection case: `case071`. Borderline remains distinct from both CLEAR_A and NO_A.\n\n'+
        '## 4. Control feedback\n\n`case071` is a borderline false-negative protection case. `case074, case076, case078, case080` are correct-negative controls and are not detector false positives.\n\n'+
        '## 5. False-positive common diagnostics\n\n- LOW_TWO_SIDED_INTERACTION: '+countDiagnostic(diagnoses,'LOW_TWO_SIDED_INTERACTION')+'/13\n- ASYMMETRIC_BOUNDARY_INTERACTION: '+countDiagnostic(diagnoses,'ASYMMETRIC_BOUNDARY_INTERACTION')+'/13\n- LOW_TEMPORAL_INTERACTION_COVERAGE: '+countDiagnostic(diagnoses,'LOW_TEMPORAL_INTERACTION_COVERAGE')+'/13\n- LATE_BOUNDARY_FORMATION: '+countDiagnostic(diagnoses,'LATE_BOUNDARY_FORMATION')+'/13\n- INTERNAL_DIRECTIONAL_MIGRATION: '+countDiagnostic(diagnoses,'INTERNAL_DIRECTIONAL_MIGRATION')+'/13\n- HIGH_ONE_SIDE_RESIDENCE: '+countDiagnostic(diagnoses,'HIGH_ONE_SIDE_RESIDENCE')+'/13\n- STRONG_INTERNAL_DISPLACEMENT: '+countDiagnostic(diagnoses,'STRONG_INTERNAL_DISPLACEMENT')+'/13\n\n'+
        '## 6. EQ contribution audit\n\nEQ-dependent confirmation: false positives '+eqFp+'/13; borderline '+eqBorder+'/4. This is a counterfactual subtraction of the frozen EQ score contribution only; EQ scoring was not changed. CLEAR_A comparison is unavailable.\n\n'+
        '## 7. RangeWidthATR audit\n\nFalse positive distribution: `'+JSON.stringify(fpWidth)+'`. Borderline distribution: `'+JSON.stringify(borderWidth)+'`. `case071 = 4.121 ATR` and remains human BORDERLINE_A. **CURRENT HUMAN EVIDENCE DOES NOT SUPPORT USING RANGE WIDTH ALONE AS A HARD A DEFINITION.** This does not authorize widening the frozen maximum.\n\n'+
        '## 8–11. Formation diagnostics\n\nTemporal interaction separates aggregate counts into formation halves and temporal quartile coverage. Occupancy uses fixed lower/mid/upper thirds. Boundary stability measures when final high/low first appeared and how many running-range expansions occurred late. Migration compares mean normalized position across formation thirds. Internal Displacement is linked read-only only when its confirmed candle lies inside formation and at/before A confirmedAt; production Displacement code is unchanged.\n\n'+
        '## 12. Feature hypotheses for a later bounded study\n\n1. **Temporal Two-Sided Auction Coverage** may distinguish persistent auction from aggregate touch-count bounding boxes.\n2. **Internal Directional Migration / One-Side Residence** may explain visually directional formations that still have low endpoint efficiency.\n3. **EQ-dependent confirmation** may explain a subset of weak balance candidates crossing the frozen score threshold.\n\n'+
        'These are hypotheses only. No threshold, score, gate, or detector code was added. No session, Manipulation, Distribution, Outcome, PnL, WATCH, or notification information was used.\n\n'+
        '## Final flags\n\n```ini\n'+Object.keys(summary).map(function(k){return k+' = '+summary[k];}).join('\n')+'\n```\n';
}

function main(){
    ensure();
    ['baseline-config.json','sample-manifest.json'].forEach(function(f){if(!fs.existsSync(path.join(SOURCE,f)))throw new Error('Missing frozen source '+f);});
    if(!fs.existsSync(INPUT))throw new Error('Missing original fixed candle input');
    var baseline=JSON.parse(fs.readFileSync(path.join(SOURCE,'baseline-config.json'),'utf8'));
    var baselineHash=sha(path.join(SOURCE,'baseline-config.json'));
    var manifest=JSON.parse(fs.readFileSync(path.join(SOURCE,'sample-manifest.json'),'utf8'));
    var candles=JSON.parse(fs.readFileSync(INPUT,'utf8'));
    console.log('[Displacement] build frozen production event stream');
    var displacements=buildProductionDisplacements(candles);
    console.log('[Features] 80 frozen review cases');
    var gt=audit.buildGroundTruth(manifest,candles,displacements,baseline);
    var gt2=audit.buildGroundTruth(manifest,candles,displacements,baseline);
    var fp=gt.filter(function(x){return audit.FALSE_POSITIVE_CASES.indexOf(x.caseId)!==-1;});
    var borderline=gt.filter(function(x){return x.humanLabel==='BORDERLINE_A';});
    var clear=gt.filter(function(x){return x.humanLabel==='CLEAR_A';});
    var diagnoses=fp.map(function(x){return{caseId:x.caseId,diagnosis:audit.diagnose(x.featureSnapshot),diagnosticThresholds:{lowTwoSidedMinTouch:1,asymmetryRatio:2.5,temporalCoverage:0.5,lateBoundaryPct:2/3,migrationShift:0.35,oneSideResidenceRatio:0.5,strongDisplacementMinProductionScore:4},shouldReject:null};});
    var featureAudit={sampleSizeWarning:'Small partial human cohorts; descriptive distributions only.',referencePositiveCohortStatus:clear.length?'AVAILABLE':'INSUFFICIENT_HUMAN_LABELS',cohorts:{FALSE_POSITIVE:numericAudit(fp),BORDERLINE_A:numericAudit(borderline),CLEAR_A:clear.length?numericAudit(clear):null},eqDependentConfirmation:{FALSE_POSITIVE:fp.filter(function(x){return x.featureSnapshot.eqDependentConfirmation;}).length,BORDERLINE_A:borderline.filter(function(x){return x.featureSnapshot.eqDependentConfirmation;}).length,CLEAR_A:clear.length?clear.filter(function(x){return x.featureSnapshot.eqDependentConfirmation;}).length:null}};
    var counts={CLEAR_A:clear.length,BORDERLINE_A:borderline.length,NO_A:gt.filter(function(x){return x.humanLabel==='NO_A';}).length,UNREVIEWED:gt.filter(function(x){return x.humanLabel==='UNREVIEWED';}).length};
    var gtSummary={TOTAL_CASES:gt.length,CLEAR_A:counts.CLEAR_A,BORDERLINE_A:counts.BORDERLINE_A,NO_A:counts.NO_A,UNREVIEWED:counts.UNREVIEWED,FALSE_POSITIVES_CONFIRMED:fp.length,BORDERLINE_MACHINE_POSITIVES:3,BORDERLINE_MACHINE_NEGATIVES:1,CONFIRMED_CORRECT_NEGATIVE_CONTROLS:4,REFERENCE_POSITIVE_COHORT_STATUS:clear.length?'AVAILABLE':'INSUFFICIENT_HUMAN_LABELS',AUDIT_STATUS:'PARTIAL_HUMAN_AUDIT'};
    var productionFiles=['amd/accumulationDetector.js','config/thresholds.js','events/displacementDetector.js','liquidity/persistentEqualLiquidityV3.js','liquidity/equalLiquidity.js','live/liveEngine.js','notify/watchNotificationPresentationV1.js'];
    var before={};productionFiles.forEach(function(f){before[f]=sha(path.join(__dirname,'..',f));});
    var futureLeaks=gt.filter(function(x){return x.featureSnapshot.featureSourceEndIndex>x.featureSnapshot.featureSourceEndIndex||x.featureSnapshot.featureSourceConfirmedAt>x.featureSnapshot.featureSourceConfirmedAt;}).length;
    // Explicit checks use source rows because all computed windows are sliced [startIndex..endIndex].
    futureLeaks=gt.filter(function(x){var src=manifest.filter(function(m){return m.caseId===x.caseId;})[0].row;return x.featureSnapshot.featureSourceEndIndex>src.endIndex||x.featureSnapshot.featureSourceConfirmedAt>src.confirmedAt;}).length;
    var deterministic=JSON.stringify(gt)===JSON.stringify(gt2);
    console.log('[Tests] full repository regression suite');
    var tests=cp.spawnSync(process.execPath,[path.join(__dirname,'..','test','run.js')],{cwd:path.join(__dirname,'..'),encoding:'utf8',maxBuffer:32*1024*1024});
    var after={};productionFiles.forEach(function(f){after[f]=sha(path.join(__dirname,'..',f));});
    var productionUnchanged=productionFiles.every(function(f){return before[f]===after[f];});
    var acceptance={sourceArtifactsLoaded:true,groundTruthCases:gt.length,falsePositiveCohortExact:fp.length===13,borderlineCohortExact:borderline.length===4,unreviewedPreserved:counts.UNREVIEWED===59,clearACohortAvailable:clear.length>0,referencePositiveCohortStatus:clear.length?'AVAILABLE':'INSUFFICIENT_HUMAN_LABELS',baselineConfigSourceSha256:baselineHash,baselineConfigCopySha256:null,FUTURE_LEAK_VIOLATIONS:futureLeaks,DETERMINISM_VIOLATIONS:deterministic?0:1,productionHashesBefore:before,productionHashesAfter:after,productionBehaviorChanged:!productionUnchanged,allTestsPassed:tests.status===0,parameterSearchPerformed:false,newGateImplemented:false,newScoreImplemented:false};
    json('baseline-config-copy.json',baseline);acceptance.baselineConfigCopySha256=sha(path.join(OUT,'baseline-config-copy.json'));
    var pass=acceptance.sourceArtifactsLoaded&&acceptance.falsePositiveCohortExact&&acceptance.borderlineCohortExact&&acceptance.unreviewedPreserved&&acceptance.baselineConfigCopySha256===baselineHash&&futureLeaks===0&&acceptance.DETERMINISM_VIOLATIONS===0&&!acceptance.productionBehaviorChanged&&acceptance.allTestsPassed;
    var summary={HUMAN_GROUND_TRUTH_V1:pass?'PASS':'FAIL',GROUND_TRUTH_STATUS:'PARTIAL',FALSE_POSITIVE_FEATURE_AUDIT:pass?'PASS':'FAIL',FALSE_POSITIVE_CASES:13,BORDERLINE_A_CASES:4,UNREVIEWED_CASES:counts.UNREVIEWED,BASELINE_CONFIG_CHANGED:false,ACCUMULATION_DETECTOR_CHANGED:false,DISPLACEMENT_ENGINE_CHANGED:false,EQ_V3_CHANGED:false,LIQUIDITY_ENGINE_CHANGED:false,WATCH_ALGORITHM_CHANGED:false,NOTIFICATION_LOGIC_CHANGED:false,PARAMETER_SEARCH_PERFORMED:false,NEW_GATE_IMPLEMENTED:false,NEW_SCORE_IMPLEMENTED:false,FUTURE_LEAK_VIOLATIONS:futureLeaks,DETERMINISM_VIOLATIONS:acceptance.DETERMINISM_VIOLATIONS,ALL_TESTS_PASSED:acceptance.allTestsPassed,READY_FOR_ACCUMULATION_V2:false,READY_FOR_MANIPULATION_RESEARCH:false};
    json('human-ground-truth-v1.json',gt);json('human-ground-truth-summary.json',gtSummary);writeTable('false-positive-feature-table.csv',fp);writeTable('borderline-feature-table.csv',borderline);json('feature-audit.json',featureAudit);json('case-diagnosis.json',diagnoses);json('acceptance.json',acceptance);json('test-results.json',{command:'node test/run.js',exitCode:tests.status,passed:tests.status===0,stdoutSha256:crypto.createHash('sha256').update(tests.stdout||'').digest('hex'),stdoutTail:(tests.stdout||'').split('\n').slice(-30),stderr:tests.stderr||''});fs.writeFileSync(path.join(OUT,'REPORT.md'),makeReport(summary,gt,featureAudit,diagnoses));
    console.log(JSON.stringify(summary,null,2));
}
if(require.main===module)main();
module.exports={buildProductionDisplacements:buildProductionDisplacements};
