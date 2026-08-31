# Test report

- New Displacement tests cover no-structure creation, explicit boolean requirements, failed-core non-rescue, bullish/bearish price direction, identity fields, arbitrary bullish/bearish legacy-shaped input invariance, and prefix immutability.
- WATCH tests verify absence of MSS fields and immunity to legacy-shaped enrichment.
- AMD and delivery Bias tests validate direct price-only Displacement consumption and legacy-input invariance.
- FVG tests retain geometry coverage and validate the scorer without a structure contribution.
- Notification and narrative lifecycle tests verify that no structure signal or snapshot is presented/persisted.
- Standard Causal Swing and EQ V3 regression suites remain active.
- Frozen fixture prefix checks: 0 mutations; future-leak checks: 0 violations.
- Static active runtime scan terms: `mss`, `STRUCTURAL_MSS`, `mssGrade`, `protectedBreak`, `minScore`, and `scoreBreakdown`.
- Full command: `npm test`.
- Final result: `ALL TESTS PASSED`.
