# Remaining structure components

`structure/standardCausalSwingSegmentation.js` and EQ V3 remain unchanged and continue to provide causal swing membership for equal-liquidity construction.

`structure/structuralProvenance5m.js` remains only because the runtime swing-context consumer uses its generic confirmed-pivot lifecycle. Its ACTIVE_PROTECTED state is internal lifecycle bookkeeping, not a production signal. A protected close-through now retires the reference and resets state to UNKNOWN; it emits no MSS, BOS, CHoCH, break signal, direction claim, WATCH field, or notification field.

The 4H DeepSeek/Daily Bias contract is outside this 5m removal and was not redesigned.

No new market-structure engine or Local Balance implementation was added.
