/**
 * AMD Explanation —— Engine 判断，Reporter 只展示
 * 输出 { accumulation, manipulation, distribution, alignment, invalidation }
 */
function buildAmdExplanation(amdResult, alignment) {
    var out = {
        accumulation: [],
        manipulation: [],
        distribution: [],
        alignment: [],
        invalidation: []
    };

    var acc = amdResult.accumulation;
    if (acc && acc.reasons) {
        acc.reasons.forEach(function (r) {
            out.accumulation.push(r);
        });
    }

    var manip = amdResult.manipulation;
    if (manip && manip.reasons) {
        manip.reasons.forEach(function (r) {
            out.manipulation.push(r);
        });
    }

    var dist = amdResult.distribution;
    if (dist && dist.reasons) {
        dist.reasons.forEach(function (r) {
            out.distribution.push(r);
        });
    }

    if (alignment) {
        out.alignment.push(
            'Bias ' + (alignment.biasDirection || 'n/a') +
            ' + AMD ' + (alignment.amdDirection || 'n/a') +
            ' → ' + alignment.alignment +
            (alignment.biasConfidenceLow ? ' (bias confidence LOW)' : '')
        );
    }

    if (amdResult.invalidationReason) {
        out.invalidation.push(amdResult.invalidationReason);
    }

    return out;
}

module.exports = {
    buildAmdExplanation: buildAmdExplanation
};
