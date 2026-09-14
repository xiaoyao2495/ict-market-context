# HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — LOCAL semantic audit

- symbol: `BTCUSDT`
- candles: 17580（2026-07-02T23:00:00.000Z → 2026-09-01T23:59:59.999Z）
- cache: `data-cache/BTCUSDT_5m_20636_20697.json` sha256=4be395f34dc319c9
- decision store: `.live-state/turning-point-significance-v1`
- model: `deepseek-v4-flash` temperature=0
- PROMPT_SHA256: `e1962266a20c67182dc11859d0b68f1b166dd3beddb591727f4a92ce5cf917e0`
- SCHEMA_SHA256: `43cde0b84a26136472b3f2353ffc4fc7e8eefe07363d18a2c5e3e126276caa50`

- population: 560 candidates
- this run: 560 candidates（LABEL_ALL，串行）

## Gate results

| gate | result | detail |
|---|---|---|
| KEY_PRESENT | PASS | DEEPSEEK_API_KEY injected via env only |
| SERIAL_TRANSPORT | PASS | transport calls=557 for 560 candidates (strictly serial) |
| MODEL_IDENTITY_OK | PASS | unexpected response model id count=0 |
| SCHEMA_VALID | PASS | schema-invalid results=0 |
| RAW_PERSISTED_BEFORE_PARSE | PASS | raw-responses 3→558, decisions 3→558 |
| CACHE_HIT_ON_RERUN | PASS | decisionKey stable=true, extra transport calls=0 |
| GATE_CONSISTENT | PASS | eligible ⇔ (SIGNIFICANT|VALID)+HIGH for all 560 results |
| FAIL_CLOSED | PASS | no anchor is eligible through an error path |
| FUTURE_LEAK_FALSE | PASS | timestamps beyond confirmedAt across all fact sets=0 |
| REAL_ORDERS_SENT | PASS | 0 —— 本脚本不加载任何 execution / binance 模块 |

## Sample outcome

- resolved: 558 / 560
- eligible (LLM_QUALIFIED_HISTORICAL_ANCHOR): 0
- blocked: 560
- label distribution: SIGNIFICANT=0 VALID=429 WEAK=129 UNCLEAR=0
- OVERALL VERDICT: **INSUFFICIENT_SAMPLE**
  （抽样内没有出现 `(SIGNIFICANT|VALID) + HIGH`，无法验证 eligible 路径；请扩大 `--sample` 或运行 `--label-all` 后再判定。此处不做策略结论。）

## Next commands

```bash
# 1) 全量标注（串行，耗时较长），把冻结决策写入 live store
DEEPSEEK_API_KEY=... node scripts/local/turningPointSignificanceSemanticAuditV1.local.js --label-all

# 2) 把冻结决策 join 回 population audit
node research/historical-turning-point-significance-v1/buildArtifactsV1.js \
  --symbol BTCUSDT --decisions .live-state/turning-point-significance-v1

# 3) 复核研究包完整性
node test/turningPointSignificanceResearchPackageV1.test.js
```

