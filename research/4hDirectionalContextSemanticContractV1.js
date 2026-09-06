/**
 * Frozen research-only semantic contract derived from the completed
 * 20-sample human-first directional-priority audit.
 */
var CONTRACT_ID = '4H_DIRECTIONAL_CONTEXT_SEMANTIC_CONTRACT_V1';

var PURPOSE = [
    'Determine whether current confirmed 4H market facts provide enough directional evidence',
    'to prioritize future lower-timeframe opportunities toward BULLISH, BEARISH, or NO_PRIORITY.',
    'This is a statement about CURRENT DIRECTIONAL PRIORITY, not a next-candle prediction,',
    'future-return prediction, price target, entry signal, or trade outcome forecast.'
].join(' ');

var PRINCIPLES = [
    {
        id: 1,
        name: 'ALIGNMENT',
        text: 'When price delivery, minor directional state, major directional state, and structural state are coherently aligned, that alignment strongly supports directional priority in the aligned direction.'
    },
    {
        id: 2,
        name: 'CONFLICT_IS_NOT_AN_AUTOMATIC_VETO',
        text: 'The existence of cross-scale conflict alone does not justify NO_PRIORITY. Conflict is evidence that must be evaluated, not an automatic directional veto.'
    },
    {
        id: 3,
        name: 'COUNTER_MINOR_LEG',
        text: 'A counter-directional minor leg can coexist with an otherwise coherent directional context. A minor counter leg alone must not automatically cancel directional priority. Its recency and surrounding price delivery may indicate a correction or pullback inside a broader coherent state.'
    },
    {
        id: 4,
        name: 'RESIDUAL_MAJOR_LEG',
        text: 'An opposing major directional leg can coexist with a newer coherent directional context when more recent price delivery, minor direction, and structural state support the opposite direction. A residual major leg alone must not automatically cancel directional priority.'
    },
    {
        id: 5,
        name: 'MIXED_FACTS',
        text: 'When price delivery is internally mixed across the supplied horizons and directional states are also internally mixed, uncertainty materially increases. This does not automatically equal NO_PRIORITY. Synthesis still considers directional magnitude, signed efficiency, persistence, ageBars, confirmedAt recency, structural transition recency, and raw OHLC context.'
    },
    {
        id: 6,
        name: 'NO_PRIORITY',
        text: 'Return NO_PRIORITY only when neither bullish nor bearish interpretation has sufficient current dominance after considering the supplied facts together. It means there is not enough current directional evidence to prioritize lower-timeframe opportunities to one side; it does not mean future price will be sideways.'
    },
    {
        id: 7,
        name: 'RECENCY_WITHOUT_HARD_WEIGHTS',
        text: 'confirmedAt, ageBars, and lastTransition may distinguish fresh change, persistent state, and older residual state, but no numeric recency score or fixed weighting system may be invented.'
    },
    {
        id: 8,
        name: 'DETERMINISTIC_FACT_AUTHORITY',
        text: 'Deterministic facts are authoritative. rawOhlc32 is contextual evidence only. The synthesis layer must not independently re-detect directional legs, structural transitions, or indicators from raw candles and override supplied facts.'
    },
    {
        id: 9,
        name: 'CONFLICT_VISIBILITY',
        text: 'A final BULLISH or BEARISH decision does not make conflicting evidence disappear. Material opposing facts must remain visible in conflictingFacts.'
    },
    {
        id: 10,
        name: 'NO_HARD_CLASSIFIER',
        text: 'The semantic contract must not be implemented as vote counting, weighted voting, a fixed priority hierarchy, a bull score, a bear score, or an if/else sample classifier. Final synthesis remains contextual.'
    }
];

module.exports = {
    id: CONTRACT_ID,
    sourceResearchStatus: 'CLOSED_SUPPORTED',
    purpose: PURPOSE,
    principles: PRINCIPLES,
    supports: ['current directional-priority interpretation'],
    doesNotSupport: [
        'future prediction',
        'profitability',
        'trade execution',
        'entry timing',
        'target selection',
        'automatic Production gating'
    ]
};
