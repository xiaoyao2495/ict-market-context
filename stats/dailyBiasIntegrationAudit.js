/** Non-interference audit for Daily Bias enrichment. */

function countByTier(opportunities) {
    var out = {};
    (opportunities || []).forEach(function (opp) {
        out[opp.tier] = (out[opp.tier] || 0) + 1;
    });
    return out;
}

function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function sortedIds(opportunities) {
    return (opportunities || []).map(function (opp) { return String(opp.id); }).sort();
}

function tierById(opportunities) {
    return (opportunities || []).map(function (opp) {
        return String(opp.id) + ':' + String(opp.tier);
    }).sort();
}

function enrichOpportunities(opportunities, resolveDailyBias) {
    return (opportunities || []).map(function (opp) {
        var enriched = Object.assign({}, opp);
        enriched.dailyBias = resolveDailyBias(opp);
        return enriched;
    });
}

function audit(before, after, shouldNotify) {
    var notify = shouldNotify || function () { return true; };
    var beforeNotifications = (before || []).filter(notify).length;
    var afterNotifications = (after || []).filter(notify).length;
    var beforeNotificationIds = sortedIds((before || []).filter(notify));
    var afterNotificationIds = sortedIds((after || []).filter(notify));
    var beforeTiers = countByTier(before);
    var afterTiers = countByTier(after);
    return {
        opportunityCountBefore: (before || []).length,
        opportunityCountAfter: (after || []).length,
        tierCountBefore: beforeTiers,
        tierCountAfter: afterTiers,
        notificationCountBefore: beforeNotifications,
        notificationCountAfter: afterNotifications,
        DETECTION_CHANGED: !sameJson(sortedIds(before), sortedIds(after)),
        TIER_CHANGED: !sameJson(tierById(before), tierById(after)),
        NOTIFICATION_FILTER_CHANGED: !sameJson(beforeNotificationIds, afterNotificationIds)
    };
}

module.exports = {
    audit: audit,
    countByTier: countByTier,
    enrichOpportunities: enrichOpportunities
};
