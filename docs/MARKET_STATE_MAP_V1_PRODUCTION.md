# Market State Map V1 production status

`MARKET_STATE_MAP_V1` is currently reporting only. It does not gate or modify production trading decisions.

The frozen active design is `TREND_ESTABLISHMENT_MINIMAL_ESCAPE_V1_1` plus LLM1 for birth and `ACTIVE_PROTECTED_STRUCTURE_V3_1` for lifecycle. LLM2 is disabled. A trade captures one immutable, causal snapshot at its entry decision time; failures report `UNAVAILABLE` and execution continues unchanged.
