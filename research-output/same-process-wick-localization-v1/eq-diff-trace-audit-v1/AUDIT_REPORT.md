# SAME_PROCESS_WICK_LOCALIZATION_EQ_DIFF_TRACE_AUDIT_V1

## 1. SUMMARY

| Symbol | OLD EQ | NEW EQ | EXACT SAME | PARTNER CHANGED | ADDED | REMOVED |
|---|---:|---:|---:|---:|---:|---:|
| RAYSOLUSDT | 43 | 46 | 13 | 21 | 12 | 9 |
| BTCUSDT | 29 | 22 | 5 | 8 | 9 | 16 |
| ETHUSDT | 27 | 29 | 13 | 8 | 8 | 6 |
| DOGEUSDT | 40 | 44 | 18 | 8 | 18 | 14 |
| LSKUSDT | 73 | 71 | 39 | 23 | 9 | 11 |

## 2. REASON DISTRIBUTION

- ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE: 49 (27.22%)
- ANCHOR_OCCURRENCE_ENTERED_36H_WINDOW: 0 (0.00%)
- ANCHOR_OCCURRENCE_LEFT_36H_WINDOW: 0 (0.00%)
- ANCHOR_PRICE_ENTERED_EQ_TOLERANCE: 0 (0.00%)
- ANCHOR_PRICE_LEFT_EQ_TOLERANCE: 56 (31.11%)
- MULTIPLE_CAUSAL_EFFECTS: 59 (32.78%)
- PAIRING_PRIORITY_CHANGED: 0 (0.00%)
- PAIRING_SWITCHED_TO_DIFFERENT_PROCESS: 16 (8.89%)
- UNEXPLAINED_DIFFERENCE: 0 (0.00%)

Observed causal mechanisms may be multiple within one event-level reason:
- ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE: 69
- ANCHOR_PRICE_ENTERED_EQ_TOLERANCE: 9
- ANCHOR_PRICE_LEFT_EQ_TOLERANCE: 59
- SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED: 52
- SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED: 52

## 3. ADDED EQ EXAMPLES

### RAYSOLUSDT HIGH @ 2026-09-08 10:09:59 UTC+8

- classification: `ADDED_EQ`
- changeReason: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-08 09:55:00 UTC+8 / 1.2275`; confirmedAt=`2026-09-08 10:09:59 UTC+8`; ATR14=`0.01025708810641907`; tolerance=`0.007179961674493349` (0.584926%)
- OLD matching partners: ``
- NEW matching partners: `DYNDPROC:RAYSOLUSDT:5m:HIGH:1788771300000:1788781499999 @ 1.2286 / 2026-09-07 17:00:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:RAYSOLUSDT:5m:HIGH:1788771300000:1788781499999`
    - OLD: `anchor=1.2266@2026-09-07 16:55:00 UTC+8, statusBefore/After=ACTIVE/INACTIVE, ageBars=204, within36h=true, distance=0.0009000000000001229, distanceATR=0.08774420095279153, tolerancePass=true, strictCross=true, matches=false`
    - NEW: `anchor=1.2286@2026-09-07 17:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=203, within36h=true, distance=0.0010999999999998789, distanceATR=0.10724291227560764, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0.0020000000000000018, pricePct=0.001630523398010763, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `{"oldAnchor":1.2266,"newAnchor":1.2286,"oldStatusBeforeEvaluation":"ACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"RAYSOLUSDT:5m:SWING_HIGH:1788832500000","crossingCandleOpenTime":1788832500000,"crossingCandleOpenTimeUtc":"2026-09-08T01:55:00.000Z","crossingHigh":1.2275,"crossingLow":1.2137,"anchor":1.2266,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=24, NEW=24; no primary selector.

### BTCUSDT HIGH @ 2026-09-07 05:29:59 UTC+8

- classification: `ADDED_EQ`
- changeReason: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-07 05:15:00 UTC+8 / 79997`; confirmedAt=`2026-09-07 05:29:59 UTC+8`; ATR14=`52.71429033974045`; tolerance=`36.90000323781831` (0.046127%)
- OLD matching partners: ``
- NEW matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788691200000:1788703799999 @ 79997.9 / 2026-09-06 18:55:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:BTCUSDT:5m:HIGH:1788691200000:1788703799999`
    - OLD: `anchor=79985@2026-09-06 18:40:00 UTC+8, statusBefore/After=ACTIVE/INACTIVE, ageBars=127, within36h=true, distance=12, distanceATR=0.22764225644812283, tolerancePass=true, strictCross=true, matches=false`
    - NEW: `anchor=79997.9@2026-09-06 18:55:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=124, within36h=true, distance=0.8999999999941792, distanceATR=0.017073169233498792, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=12.89999999999418, pricePct=0.00016128024004493567, timeBars=3, timeMinutes=15`
    - statusTransitionEvidence: `{"oldAnchor":79985,"newAnchor":79997.9,"oldStatusBeforeEvaluation":"ACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"BTCUSDT:5m:SWING_HIGH:1788729300000","crossingCandleOpenTime":1788729300000,"crossingCandleOpenTimeUtc":"2026-09-06T21:15:00.000Z","crossingHigh":79997,"crossingLow":79947.4,"anchor":79985,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=7, NEW=7; no primary selector.

### ETHUSDT HIGH @ 2026-09-06 04:24:59 UTC+8

- classification: `ADDED_EQ`
- changeReason: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-06 04:10:00 UTC+8 / 2482.88`; confirmedAt=`2026-09-06 04:24:59 UTC+8`; ATR14=`3.637734676046089`; tolerance=`2.546414273232262` (0.102559%)
- OLD matching partners: ``
- NEW matching partners: `DYNDPROC:ETHUSDT:5m:HIGH:1788630900000:1788637199999 @ 2484.98 / 2026-09-06 01:30:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:ETHUSDT:5m:HIGH:1788630900000:1788637199999`
    - OLD: `anchor=2481.25@2026-09-06 01:55:00 UTC+8, statusBefore/After=ACTIVE/INACTIVE, ageBars=27, within36h=true, distance=1.6300000000001091, distanceATR=0.44808105734962006, tolerancePass=true, strictCross=true, matches=false`
    - NEW: `anchor=2484.98@2026-09-06 01:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=32, within36h=true, distance=2.099999999999909, distanceATR=0.5772823438246002, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=3.730000000000018, pricePct=0.001503274559193962, timeBars=-5, timeMinutes=-25`
    - statusTransitionEvidence: `{"oldAnchor":2481.25,"newAnchor":2484.98,"oldStatusBeforeEvaluation":"ACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"ETHUSDT:5m:SWING_HIGH:1788639000000","crossingCandleOpenTime":1788639000000,"crossingCandleOpenTimeUtc":"2026-09-05T20:10:00.000Z","crossingHigh":2482.88,"crossingLow":2476.63,"anchor":2481.25,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=5, NEW=5; no primary selector.

### DOGEUSDT LOW @ 2026-09-08 00:09:59 UTC+8

- classification: `ADDED_EQ`
- changeReason: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-07 23:55:00 UTC+8 / 0.08861`; confirmedAt=`2026-09-08 00:09:59 UTC+8`; ATR14=`0.0003897792837054559`; tolerance=`0.00027284549859381914` (0.307917%)
- OLD matching partners: ``
- NEW matching partners: `DYNDPROC:DOGEUSDT:5m:LOW:1788766500000:1788768599999 @ 0.08851 / 2026-09-07 15:40:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:DOGEUSDT:5m:LOW:1788766500000:1788768599999`
    - OLD: `anchor=0.08882@2026-09-07 15:35:00 UTC+8, statusBefore/After=ACTIVE/INACTIVE, ageBars=100, within36h=true, distance=0.00021000000000000185, distanceATR=0.5387664475228815, tolerancePass=true, strictCross=true, matches=false`
    - NEW: `anchor=0.08851@2026-09-07 15:40:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=99, within36h=true, distance=0.00009999999999998899, distanceATR=0.2565554512013416, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=-0.00030999999999999084, pricePct=-0.0034902049088042205, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `{"oldAnchor":0.08882,"newAnchor":0.08851,"oldStatusBeforeEvaluation":"ACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"DOGEUSDT:5m:SWING_LOW:1788796500000","crossingCandleOpenTime":1788796500000,"crossingCandleOpenTimeUtc":"2026-09-07T15:55:00.000Z","crossingHigh":0.08898,"crossingLow":0.08861,"anchor":0.08882,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=16, NEW=16; no primary selector.

### LSKUSDT LOW @ 2026-09-06 10:59:59 UTC+8

- classification: `ADDED_EQ`
- changeReason: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-06 10:45:00 UTC+8 / 0.10326`; confirmedAt=`2026-09-06 10:59:59 UTC+8`; ATR14=`0.00019773943494314083`; tolerance=`0.00013841760446019858` (0.134048%)
- OLD matching partners: ``
- NEW matching partners: `DYNDPROC:LSKUSDT:5m:LOW:1788657900000:1788662099999 @ 0.10326 / 2026-09-06 09:30:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:LSKUSDT:5m:LOW:1788657900000:1788662099999`
    - OLD: `anchor=0.1033@2026-09-06 09:25:00 UTC+8, statusBefore/After=ACTIVE/INACTIVE, ageBars=16, within36h=true, distance=0.00003999999999999837, distanceATR=0.20228640792616914, tolerancePass=true, strictCross=true, matches=false`
    - NEW: `anchor=0.10326@2026-09-06 09:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=15, within36h=true, distance=0, distanceATR=0, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=-0.00003999999999999837, pricePct=-0.0003872216844143114, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `{"oldAnchor":0.1033,"newAnchor":0.10326,"oldStatusBeforeEvaluation":"ACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"LSKUSDT:5m:SWING_LOW:1788662700000","crossingCandleOpenTime":1788662700000,"crossingCandleOpenTimeUtc":"2026-09-06T02:45:00.000Z","crossingHigh":0.10347,"crossingLow":0.10326,"anchor":0.1033,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=9, NEW=9; no primary selector.

## 4. REMOVED EQ EXAMPLES

### RAYSOLUSDT HIGH @ 2026-09-06 18:34:59 UTC+8

- classification: `REMOVED_EQ`
- changeReason: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-06 18:20:00 UTC+8 / 1.153`; confirmedAt=`2026-09-06 18:34:59 UTC+8`; ATR14=`0.01621469955249948`; tolerance=`0.011350289686749634` (0.984414%)
- OLD matching partners: `DYNDPROC:RAYSOLUSDT:5m:HIGH:1788674400000:1788675299999 @ 1.1642 / 2026-09-06 14:00:00 UTC+8`
- NEW matching partners: ``
- Anchor traces:
  - `DYNDPROC:RAYSOLUSDT:5m:HIGH:1788674400000:1788675299999`
    - OLD: `anchor=1.1642@2026-09-06 14:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=52, within36h=true, distance=0.011199999999999877, distanceATR=0.6907312691016473, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=1.1694@2026-09-06 14:05:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=51, within36h=true, distance=0.01639999999999997, distanceATR=1.0114279297559927, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=0.0052000000000000934, pricePct=0.004466586497165516, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=16, NEW=16; no primary selector.

### BTCUSDT HIGH @ 2026-09-06 11:54:59 UTC+8

- classification: `REMOVED_EQ`
- changeReason: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-06 11:40:00 UTC+8 / 80080.4`; confirmedAt=`2026-09-06 11:54:59 UTC+8`; ATR14=`58.28055198791521`; tolerance=`40.79638639154064` (0.050944%)
- OLD matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788628200000:1788636899999 @ 80094.2 / 2026-09-06 01:10:00 UTC+8`
- NEW matching partners: ``
- Anchor traces:
  - `DYNDPROC:BTCUSDT:5m:HIGH:1788628200000:1788636899999`
    - OLD: `anchor=80094.2@2026-09-06 01:10:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=126, within36h=true, distance=13.80000000000291, distanceATR=0.2367856777139725, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=80167@2026-09-06 00:55:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=129, within36h=true, distance=86.60000000000582, distanceATR=1.4859159195671792, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=72.80000000000291, pricePct=0.0009089297352367951, timeBars=-3, timeMinutes=-15`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=4, NEW=4; no primary selector.

### ETHUSDT LOW @ 2026-09-07 15:14:59 UTC+8

- classification: `REMOVED_EQ`
- changeReason: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-07 15:00:00 UTC+8 / 2494.59`; confirmedAt=`2026-09-07 15:14:59 UTC+8`; ATR14=`3.371674962052692`; tolerance=`2.3601724734368843` (0.094612%)
- OLD matching partners: `DYNDPROC:ETHUSDT:5m:LOW:1788756600000:1788758399999 @ 2493.31 / 2026-09-07 12:50:00 UTC+8`
- NEW matching partners: ``
- Anchor traces:
  - `DYNDPROC:ETHUSDT:5m:LOW:1788756600000:1788758399999`
    - OLD: `anchor=2493.31@2026-09-07 12:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=26, within36h=true, distance=1.2800000000002, distanceATR=0.37963327260375357, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=2490.23@2026-09-07 12:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=29, within36h=true, distance=4.360000000000127, distanceATR=1.2931258348063712, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=-3.0799999999999272, pricePct=-0.0012353056779942837, timeBars=-3, timeMinutes=-15`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=13, NEW=13; no primary selector.

### DOGEUSDT HIGH @ 2026-09-08 23:54:59 UTC+8

- classification: `REMOVED_EQ`
- changeReason: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-08 23:40:00 UTC+8 / 0.0907`; confirmedAt=`2026-09-08 23:54:59 UTC+8`; ATR14=`0.00034947112034470785`; tolerance=`0.0002446297842412955` (0.269713%)
- OLD matching partners: `DYNDPROC:DOGEUSDT:5m:HIGH:1788861000000:1788865199999 @ 0.09076 / 2026-09-08 17:50:00 UTC+8`
- NEW matching partners: ``
- Anchor traces:
  - `DYNDPROC:DOGEUSDT:5m:HIGH:1788861000000:1788865199999`
    - OLD: `anchor=0.09076@2026-09-08 17:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=70, within36h=true, distance=0.000059999999999990616, distanceATR=0.17168800655346975, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.09095@2026-09-08 18:20:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=64, within36h=true, distance=0.0002500000000000002, distanceATR=0.7153666939729031, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=0.0001900000000000096, pricePct=0.0020934332304981228, timeBars=6, timeMinutes=30`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=22, NEW=22; no primary selector.

### LSKUSDT HIGH @ 2026-09-06 11:14:59 UTC+8

- classification: `REMOVED_EQ`
- changeReason: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-06 11:00:00 UTC+8 / 0.10382`; confirmedAt=`2026-09-06 11:14:59 UTC+8`; ATR14=`0.00021232636245265213`; tolerance=`0.00014862845371685647` (0.143160%)
- OLD matching partners: `DYNDPROC:LSKUSDT:5m:HIGH:1788643800000:1788647099999 @ 0.10392 / 2026-09-06 05:30:00 UTC+8`
- NEW matching partners: ``
- Anchor traces:
  - `DYNDPROC:LSKUSDT:5m:HIGH:1788643800000:1788647099999`
    - OLD: `anchor=0.10392@2026-09-06 05:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=66, within36h=true, distance=0.00010000000000000286, distanceATR=0.4709730758106047, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.10397@2026-09-06 06:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=60, within36h=true, distance=0.00015000000000001124, distanceATR=0.7064596137159397, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=0.00005000000000000837, pricePct=0.00048113933795235154, timeBars=6, timeMinutes=30`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=9, NEW=9; no primary selector.

## 5. PARTNER CHANGED EXAMPLES

### RAYSOLUSDT LOW @ 2026-09-06 04:39:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / SAME_PROCESS_REANCHORED`
- changeReason: `MULTIPLE_CAUSAL_EFFECTS`
- mechanisms: `SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED, SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED`
- Current Point: `2026-09-06 04:25:00 UTC+8 / 0.8679`; confirmedAt=`2026-09-06 04:39:59 UTC+8`; ATR14=`0.004840688811960306`; tolerance=`0.003388482168372214` (0.390423%)
- OLD matching partners: `DYNDPROC:RAYSOLUSDT:5m:LOW:1788637500000:1788638399999 @ 0.8663 / 2026-09-06 03:45:00 UTC+8`
- NEW matching partners: `DYNDPROC:RAYSOLUSDT:5m:LOW:1788637500000:1788638399999 @ 0.8661 / 2026-09-06 03:50:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:RAYSOLUSDT:5m:LOW:1788637500000:1788638399999`
    - OLD: `anchor=0.8663@2026-09-06 03:45:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=8, within36h=true, distance=0.0016000000000000458, distanceATR=0.33053147230757496, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.8661@2026-09-06 03:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=7, within36h=true, distance=0.0018000000000000238, distanceATR=0.37184790634601605, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=-0.00019999999999997797, pricePct=-0.00023086690522911, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=10, NEW=10; no primary selector.

### BTCUSDT HIGH @ 2026-09-09 21:44:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / SAME_PROCESS_REANCHORED`
- changeReason: `MULTIPLE_CAUSAL_EFFECTS`
- mechanisms: `SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED, SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED`
- Current Point: `2026-09-09 21:30:00 UTC+8 / 79648.1`; confirmedAt=`2026-09-09 21:44:59 UTC+8`; ATR14=`146.4700021794877`; tolerance=`102.52900152564138` (0.128727%)
- OLD matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788943800000:1788946199999 @ 79670 / 2026-09-09 16:50:00 UTC+8`
- NEW matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788943800000:1788946199999 @ 79737.3 / 2026-09-09 16:35:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:BTCUSDT:5m:HIGH:1788943800000:1788946199999`
    - OLD: `anchor=79670@2026-09-09 16:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=56, within36h=true, distance=21.89999999999418, distanceATR=0.14951867054086213, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=79737.3@2026-09-09 16:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=59, within36h=true, distance=89.19999999999709, distanceATR=0.6089984206505942, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=67.30000000000291, pricePct=0.0008447345299360225, timeBars=-3, timeMinutes=-15`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=24, NEW=24; no primary selector.

### ETHUSDT LOW @ 2026-09-06 15:24:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / SAME_PROCESS_REANCHORED`
- changeReason: `MULTIPLE_CAUSAL_EFFECTS`
- mechanisms: `SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED, SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED`
- Current Point: `2026-09-06 15:10:00 UTC+8 / 2477.77`; confirmedAt=`2026-09-06 15:24:59 UTC+8`; ATR14=`5.18603609519647`; tolerance=`3.6302252666375288` (0.146512%)
- OLD matching partners: `DYNDPROC:ETHUSDT:5m:LOW:1788649800000:1788654599999 @ 2477.55 / 2026-09-06 07:10:00 UTC+8`
- NEW matching partners: `DYNDPROC:ETHUSDT:5m:LOW:1788649800000:1788654599999 @ 2476.37 / 2026-09-06 07:35:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:ETHUSDT:5m:LOW:1788649800000:1788654599999`
    - OLD: `anchor=2477.55@2026-09-06 07:10:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=96, within36h=true, distance=0.2199999999997999, distanceATR=0.042421609869544366, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=2476.37@2026-09-06 07:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=91, within36h=true, distance=1.400000000000091, distanceATR=0.2699556991700909, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=-1.180000000000291, pricePct=-0.0004762769671652604, timeBars=5, timeMinutes=25`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=7, NEW=7; no primary selector.

### DOGEUSDT HIGH @ 2026-09-07 07:14:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / SAME_PROCESS_REANCHORED`
- changeReason: `MULTIPLE_CAUSAL_EFFECTS`
- mechanisms: `SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED, SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED`
- Current Point: `2026-09-07 07:00:00 UTC+8 / 0.09064`; confirmedAt=`2026-09-07 07:14:59 UTC+8`; ATR14=`0.00021366804917400425`; tolerance=`0.00014956763442180296` (0.165013%)
- OLD matching partners: `DYNDPROC:DOGEUSDT:5m:HIGH:1788730500000:1788732599999 @ 0.09068 / 2026-09-07 05:35:00 UTC+8`
- NEW matching partners: `DYNDPROC:DOGEUSDT:5m:HIGH:1788730500000:1788732599999 @ 0.09075 / 2026-09-07 05:40:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:DOGEUSDT:5m:HIGH:1788730500000:1788732599999`
    - OLD: `anchor=0.09068@2026-09-07 05:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=17, within36h=true, distance=0.00003999999999999837, distanceATR=0.18720627700131096, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.09075@2026-09-07 05:40:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=16, within36h=true, distance=0.00010999999999999899, distanceATR=0.5148172617536214, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0.00007000000000000062, pricePct=0.0007719453021614536, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=10, NEW=10; no primary selector.

### LSKUSDT HIGH @ 2026-09-06 10:44:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / SAME_PROCESS_REANCHORED`
- changeReason: `MULTIPLE_CAUSAL_EFFECTS`
- mechanisms: `SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED, SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED`
- Current Point: `2026-09-06 10:30:00 UTC+8 / 0.10384`; confirmedAt=`2026-09-06 10:44:59 UTC+8`; ATR14=`0.00019143696380699948`; tolerance=`0.00013400587466489962` (0.129050%)
- OLD matching partners: `DYNDPROC:LSKUSDT:5m:HIGH:1788643800000:1788647099999 @ 0.10392 / 2026-09-06 05:30:00 UTC+8`
- NEW matching partners: `DYNDPROC:LSKUSDT:5m:HIGH:1788643800000:1788647099999 @ 0.10397 / 2026-09-06 06:00:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:LSKUSDT:5m:HIGH:1788643800000:1788647099999`
    - OLD: `anchor=0.10392@2026-09-06 05:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=60, within36h=true, distance=0.00007999999999999674, distanceATR=0.4178921270431876, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.10397@2026-09-06 06:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=54, within36h=true, distance=0.0001300000000000051, distanceATR=0.6790747064452343, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0.00005000000000000837, pricePct=0.00048113933795235154, timeBars=6, timeMinutes=30`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=9, NEW=9; no primary selector.

### RAYSOLUSDT LOW @ 2026-09-06 09:34:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- changeReason: `PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-06 09:20:00 UTC+8 / 0.9099`; confirmedAt=`2026-09-06 09:34:59 UTC+8`; ATR14=`0.007290014864410167`; tolerance=`0.0051030104050871165` (0.560832%)
- OLD matching partners: `DYNDPROC:RAYSOLUSDT:5m:LOW:1788654000000:1788655199999 @ 0.9068 / 2026-09-06 08:20:00 UTC+8; DYNDPROC:RAYSOLUSDT:5m:LOW:1788655800000:1788656399999 @ 0.9073 / 2026-09-06 08:50:00 UTC+8`
- NEW matching partners: `DYNDPROC:RAYSOLUSDT:5m:LOW:1788655800000:1788656399999 @ 0.9073 / 2026-09-06 08:50:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:RAYSOLUSDT:5m:LOW:1788654000000:1788655199999`
    - OLD: `anchor=0.9068@2026-09-06 08:20:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=12, within36h=true, distance=0.0030999999999999917, distanceATR=0.4252391878011365, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.9021@2026-09-06 08:05:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=15, within36h=true, distance=0.007800000000000029, distanceATR=1.069956666080286, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=-0.0047000000000000375, pricePct=-0.005183061314512613, timeBars=-3, timeMinutes=-15`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:RAYSOLUSDT:5m:LOW:1788655800000:1788656399999`
    - OLD: `anchor=0.9073@2026-09-06 08:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=6, within36h=true, distance=0.0026000000000000467, distanceATR=0.35665222202676705, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.9073@2026-09-06 08:50:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=6, within36h=true, distance=0.0026000000000000467, distanceATR=0.35665222202676705, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=13, NEW=13; no primary selector.

### BTCUSDT HIGH @ 2026-09-07 06:49:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- changeReason: `PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-07 06:35:00 UTC+8 / 79977.3`; confirmedAt=`2026-09-07 06:49:59 UTC+8`; ATR14=`81.09281908049988`; tolerance=`56.76497335634991` (0.070976%)
- OLD matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788729300000:1788732599999 @ 79997 / 2026-09-07 05:15:00 UTC+8`
- NEW matching partners: `DYNDPROC:BTCUSDT:5m:HIGH:1788691200000:1788703799999 @ 79997.9 / 2026-09-06 18:55:00 UTC+8; DYNDPROC:BTCUSDT:5m:HIGH:1788729300000:1788732599999 @ 79997 / 2026-09-07 05:15:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:BTCUSDT:5m:HIGH:1788729300000:1788732599999`
    - OLD: `anchor=79997@2026-09-07 05:15:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=16, within36h=true, distance=19.69999999999709, distanceATR=0.2429314977993444, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=79997@2026-09-07 05:15:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=16, within36h=true, distance=19.69999999999709, distanceATR=0.2429314977993444, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:BTCUSDT:5m:HIGH:1788691200000:1788703799999`
    - OLD: `anchor=79985@2026-09-06 18:40:00 UTC+8, statusBefore/After=INACTIVE/INACTIVE, ageBars=143, within36h=true, distance=7.69999999999709, distanceATR=0.09495292045962037, tolerancePass=true, strictCross=false, matches=false`
    - NEW: `anchor=79997.9@2026-09-06 18:55:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=140, within36h=true, distance=20.59999999999127, distanceATR=0.25402989109975194, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=12.89999999999418, pricePct=0.00016128024004493567, timeBars=3, timeMinutes=15`
    - statusTransitionEvidence: `{"oldAnchor":79985,"newAnchor":79997.9,"oldStatusBeforeEvaluation":"INACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"BTCUSDT:5m:SWING_HIGH:1788729300000","crossingCandleOpenTime":1788729300000,"crossingCandleOpenTimeUtc":"2026-09-06T21:15:00.000Z","crossingHigh":79997,"crossingLow":79947.4,"anchor":79985,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=8, NEW=8; no primary selector.

### ETHUSDT HIGH @ 2026-09-11 14:24:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- changeReason: `PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-11 14:10:00 UTC+8 / 2470.27`; confirmedAt=`2026-09-11 14:24:59 UTC+8`; ATR14=`2.9448166710027155`; tolerance=`2.061371669701901` (0.083447%)
- OLD matching partners: `DYNDPROC:ETHUSDT:5m:HIGH:1789061400000:1789063799999 @ 2472.22 / 2026-09-11 01:30:00 UTC+8; DYNDPROC:ETHUSDT:5m:HIGH:1789069200000:1789079099999 @ 2471.41 / 2026-09-11 03:40:00 UTC+8`
- NEW matching partners: `DYNDPROC:ETHUSDT:5m:HIGH:1789069200000:1789079099999 @ 2471.41 / 2026-09-11 03:40:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:ETHUSDT:5m:HIGH:1789061400000:1789063799999`
    - OLD: `anchor=2472.22@2026-09-11 01:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=152, within36h=true, distance=1.949999999999818, distanceATR=0.6621804403653554, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=2474.18@2026-09-11 01:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=151, within36h=true, distance=3.9099999999998545, distanceATR=1.327756677860864, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=1.9600000000000364, pricePct=0.0007928097014019936, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:ETHUSDT:5m:HIGH:1789069200000:1789079099999`
    - OLD: `anchor=2471.41@2026-09-11 03:40:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=126, within36h=true, distance=1.1399999999998727, distanceATR=0.3871208728289699, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=2471.41@2026-09-11 03:40:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=126, within36h=true, distance=1.1399999999998727, distanceATR=0.3871208728289699, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=36, NEW=36; no primary selector.

### DOGEUSDT LOW @ 2026-09-11 19:24:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- changeReason: `PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- mechanisms: `ANCHOR_PRICE_LEFT_EQ_TOLERANCE`
- Current Point: `2026-09-11 19:10:00 UTC+8 / 0.08285`; confirmedAt=`2026-09-11 19:24:59 UTC+8`; ATR14=`0.00016267347611705085`; tolerance=`0.00011387143328193558` (0.137443%)
- OLD matching partners: `DYNDPROC:DOGEUSDT:5m:LOW:1789057800000:1789058999999 @ 0.08274 / 2026-09-11 00:30:00 UTC+8; DYNDPROC:DOGEUSDT:5m:LOW:1789084500000:1789085399999 @ 0.08276 / 2026-09-11 07:55:00 UTC+8`
- NEW matching partners: `DYNDPROC:DOGEUSDT:5m:LOW:1789084500000:1789085399999 @ 0.08276 / 2026-09-11 07:55:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:DOGEUSDT:5m:LOW:1789057800000:1789058999999`
    - OLD: `anchor=0.08274@2026-09-11 00:30:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=224, within36h=true, distance=0.00010999999999999899, distanceATR=0.676201201484433, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.08265@2026-09-11 00:35:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=223, within36h=true, distance=0.00019999999999999185, distanceATR=1.2294567299716574, tolerancePass=false, strictCross=false, matches=false`
    - delta: `price=-0.00008999999999999286, pricePct=-0.0010877447425669915, timeBars=1, timeMinutes=5`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:DOGEUSDT:5m:LOW:1789084500000:1789085399999`
    - OLD: `anchor=0.08276@2026-09-11 07:55:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=135, within36h=true, distance=0.00008999999999999286, distanceATR=0.5532555284872245, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.08276@2026-09-11 07:55:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=135, within36h=true, distance=0.00008999999999999286, distanceATR=0.5532555284872245, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
- Candidate ordering: registry insertion order; OLD=36, NEW=36; no primary selector.

### LSKUSDT LOW @ 2026-09-10 06:19:59 UTC+8

- classification: `HISTORICAL_PARTNER_CHANGED_ONLY / PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- changeReason: `PAIRING_SWITCHED_TO_DIFFERENT_PROCESS`
- mechanisms: `ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE`
- Current Point: `2026-09-10 06:05:00 UTC+8 / 0.10871`; confirmedAt=`2026-09-10 06:19:59 UTC+8`; ATR14=`0.0015679053231272453`; tolerance=`0.0010975337261890717` (1.009598%)
- OLD matching partners: `DYNDPROC:LSKUSDT:5m:LOW:1788955800000:1788956699999 @ 0.10801 / 2026-09-09 20:10:00 UTC+8; DYNDPROC:LSKUSDT:5m:LOW:1788962400000:1788964199999 @ 0.1087 / 2026-09-09 22:00:00 UTC+8`
- NEW matching partners: `DYNDPROC:LSKUSDT:5m:LOW:1788953700000:1788954599999 @ 0.10769 / 2026-09-09 19:20:00 UTC+8; DYNDPROC:LSKUSDT:5m:LOW:1788955800000:1788956699999 @ 0.10801 / 2026-09-09 20:10:00 UTC+8; DYNDPROC:LSKUSDT:5m:LOW:1788962400000:1788964199999 @ 0.1087 / 2026-09-09 22:00:00 UTC+8`
- Anchor traces:
  - `DYNDPROC:LSKUSDT:5m:LOW:1788955800000:1788956699999`
    - OLD: `anchor=0.10801@2026-09-09 20:10:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=119, within36h=true, distance=0.0007000000000000062, distanceATR=0.44645552870745425, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.10801@2026-09-09 20:10:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=119, within36h=true, distance=0.0007000000000000062, distanceATR=0.44645552870745425, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:LSKUSDT:5m:LOW:1788962400000:1788964199999`
    - OLD: `anchor=0.1087@2026-09-09 22:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=97, within36h=true, distance=0.000009999999999996123, distanceATR=0.006377936124389675, tolerancePass=true, strictCross=false, matches=true`
    - NEW: `anchor=0.1087@2026-09-09 22:00:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=97, within36h=true, distance=0.000009999999999996123, distanceATR=0.006377936124389675, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=0, pricePct=0, timeBars=0, timeMinutes=0`
    - statusTransitionEvidence: `null`
  - `DYNDPROC:LSKUSDT:5m:LOW:1788953700000:1788954599999`
    - OLD: `anchor=0.10803@2026-09-09 19:35:00 UTC+8, statusBefore/After=INACTIVE/INACTIVE, ageBars=126, within36h=true, distance=0.00068, distanceATR=0.43369965645866604, tolerancePass=true, strictCross=false, matches=false`
    - NEW: `anchor=0.10769@2026-09-09 19:20:00 UTC+8, statusBefore/After=ACTIVE/ACTIVE, ageBars=129, within36h=true, distance=0.001020000000000007, distanceATR=0.6505494846880034, tolerancePass=true, strictCross=false, matches=true`
    - delta: `price=-0.00034000000000000696, pricePct=-0.0031472739053967137, timeBars=-3, timeMinutes=-15`
    - statusTransitionEvidence: `{"oldAnchor":0.10803,"newAnchor":0.10769,"oldStatusBeforeEvaluation":"INACTIVE","newStatusBeforeEvaluation":"ACTIVE","oldStatusAfterEvaluation":"INACTIVE","newStatusAfterEvaluation":"ACTIVE","oldLaneTransition":{"crossingPivotId":"LSKUSDT:5m:SWING_LOW:1788955800000","crossingCandleOpenTime":1788955800000,"crossingCandleOpenTimeUtc":"2026-09-09T12:10:00.000Z","crossingHigh":0.10872,"crossingLow":0.10801,"anchor":0.10803,"oldStatus":"ACTIVE","newStatus":"INACTIVE","reason":"STRICT_CROSS"},"newLaneTransition":null}`
- Candidate ordering: registry insertion order; OLD=40, NEW=40; no primary selector.

## 6. HIDDEN LOGIC CHECK

```json
{
  "RAYSOLUSDT": {
    "dynamicDProcessIdSet": true,
    "dynamicDProcessFields": true,
    "currentPoint": true,
    "currentPointConfirmedAt": true,
    "atr14": true,
    "eqTolerance": true,
    "evaluationTime": true,
    "dynamicDTheta": true,
    "rawFvgSurface": true
  },
  "BTCUSDT": {
    "dynamicDProcessIdSet": true,
    "dynamicDProcessFields": true,
    "currentPoint": true,
    "currentPointConfirmedAt": true,
    "atr14": true,
    "eqTolerance": true,
    "evaluationTime": true,
    "dynamicDTheta": true,
    "rawFvgSurface": true
  },
  "ETHUSDT": {
    "dynamicDProcessIdSet": true,
    "dynamicDProcessFields": true,
    "currentPoint": true,
    "currentPointConfirmedAt": true,
    "atr14": true,
    "eqTolerance": true,
    "evaluationTime": true,
    "dynamicDTheta": true,
    "rawFvgSurface": true
  },
  "DOGEUSDT": {
    "dynamicDProcessIdSet": true,
    "dynamicDProcessFields": true,
    "currentPoint": true,
    "currentPointConfirmedAt": true,
    "atr14": true,
    "eqTolerance": true,
    "evaluationTime": true,
    "dynamicDTheta": true,
    "rawFvgSurface": true
  },
  "LSKUSDT": {
    "dynamicDProcessIdSet": true,
    "dynamicDProcessFields": true,
    "currentPoint": true,
    "currentPointConfirmedAt": true,
    "atr14": true,
    "eqTolerance": true,
    "evaluationTime": true,
    "dynamicDTheta": true,
    "rawFvgSurface": true
  }
}
```

Production pairing rule is registry insertion order with all matching partners retained. There is no primary-partner ranking or selector.

## 7. UNEXPLAINED DIFFERENCES

UNEXPLAINED_DIFFERENCES=0
