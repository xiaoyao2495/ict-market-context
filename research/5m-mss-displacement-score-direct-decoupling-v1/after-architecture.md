# After architecture

The production path is now:

```text
Closed 5m candles
  |-- Narrative Liquidity and Sweep
  |-- price-only Displacement
  `-- native FVG geometry

direction-matched Sweep + Displacement leg
  -> WATCH
  -> native FVG FIRST_TOUCH
  -> notification
```

Displacement uses explicit facts, not votes:

`rangeAtr >= 1.2 AND bodyAtr >= 0.8 AND bodyRatio >= 0.6 AND closeExtremeRatio >= 0.75`

The first two facts form `expansionPass`; the latter two form `directionalDeliveryPass`; both are required. Direction and identity come only from the closed candle. No structure, liquidity, FVG, AMD, Bias, WATCH, or Entry input can create a Displacement.

AMD Distribution now consumes the first same-direction price-only Displacement within its existing six-bar window. Delivery Bias uses Sweep -> same-direction Displacement within 18 bars. WATCH, opportunity, FVG score, Entry, persistence, and notifications expose no retired structure signal.
