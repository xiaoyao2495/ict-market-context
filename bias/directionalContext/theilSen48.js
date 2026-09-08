'use strict';

var WINDOW = 48;

function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Exact frozen scipy.stats.theilslopes slope coordinate used by research:
 * median((logClose[j]-logClose[i])/(j-i)) for every i<j in the last 48 bars.
 * For 48 inputs there are 1128 slopes, so the median is the mean of the two
 * central sorted slopes, matching NumPy/SciPy even-length median semantics.
 */
function slope48(candles) {
    if (!Array.isArray(candles) || candles.length < WINDOW) {
        throw new Error('THEIL_SEN48_WARMUP_NOT_READY');
    }
    var sample = candles.slice(-WINDOW).map(function (c) {
        var close = c && c.close;
        if (typeof close !== 'number' || !isFinite(close) || close <= 0) {
            throw new Error('THEIL_SEN48_INVALID_CLOSE');
        }
        return Math.log(close);
    });
    var slopes = [];
    for (var i = 0; i < WINDOW - 1; i++) {
        for (var j = i + 1; j < WINDOW; j++) {
            slopes.push((sample[j] - sample[i]) / (j - i));
        }
    }
    return median(slopes);
}

module.exports = { WINDOW: WINDOW, median: median, slope48: slope48 };
