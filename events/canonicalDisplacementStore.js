/** Canonical production Displacement: immutable core + append-only raw provenance. */
'use strict';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function overlaps(a, b) { return a.startIndex <= b.endIndex && b.startIndex <= a.endIndex; }
function keyOf(row) { return [row.symbol, row.timeframe, row.direction].join('|'); }
function compareRaw(a, b) {
    return a.confirmedAt - b.confirmedAt || a.startAt - b.startAt || a.endAt - b.endAt || a.id.localeCompare(b.id);
}
function sourceOf(raw, attachedAt) {
    return {
        sourceDetectionId: raw.id,
        source: raw.source,
        formationType: raw.formationType,
        startIndex: raw.startIndex,
        endIndex: raw.endIndex,
        startAt: raw.startAt,
        endAt: raw.endAt,
        confirmedAt: raw.confirmedAt,
        attachedAt: attachedAt,
        startPrice: raw.startPrice,
        endPrice: raw.endPrice,
        atr: raw.atr,
        metrics: clone(raw.metrics)
    };
}

function components(rows) {
    var sorted = rows.slice().sort(compareRaw);
    var out = [];
    sorted.forEach(function (raw) {
        var hits = out.filter(function (component) {
            return component.symbol === raw.symbol && component.timeframe === raw.timeframe &&
                component.direction === raw.direction && component.startIndex <= raw.endIndex && raw.startIndex <= component.endIndex;
        });
        if (!hits.length) {
            out.push({ symbol: raw.symbol, timeframe: raw.timeframe, direction: raw.direction,
                startIndex: raw.startIndex, endIndex: raw.endIndex, rows: [raw] });
            return;
        }
        var target = hits[0];
        target.rows.push(raw);
        target.startIndex = Math.min(target.startIndex, raw.startIndex);
        target.endIndex = Math.max(target.endIndex, raw.endIndex);
        hits.slice(1).forEach(function (other) {
            other.rows.forEach(function (item) { target.rows.push(item); });
            target.startIndex = Math.min(target.startIndex, other.startIndex);
            target.endIndex = Math.max(target.endIndex, other.endIndex);
            out.splice(out.indexOf(other), 1);
        });
    });
    return out;
}

function createCanonicalDisplacementStore() {
    var byId = {};
    var order = [];
    var activeByKey = {};
    var idsByEnd = {};
    var evidenceIds = {};

    function append(event, raw, attachedAt) {
        if (evidenceIds[raw.id]) return false;
        evidenceIds[raw.id] = true;
        event.sourceDetections.push(sourceOf(raw, attachedAt));
        return true;
    }

    function create(component, evaluationTime) {
        var rows = component.rows.slice().sort(compareRaw);
        // Deterministic creation primary: earliest confirmed evidence, then earliest
        // formation start/end, then stable raw ID. No later evidence can change it.
        var primary = rows[0];
        var startAt = Math.min.apply(null, rows.map(function (r) { return r.startAt; }));
        var endAt = Math.max.apply(null, rows.map(function (r) { return r.endAt; }));
        var startRow = rows.slice().sort(function (a, b) { return a.startAt - b.startAt || a.id.localeCompare(b.id); })[0];
        var endRow = rows.slice().sort(function (a, b) { return b.endAt - a.endAt || a.id.localeCompare(b.id); })[0];
        var id = component.symbol + ':' + component.timeframe + ':DISPLACEMENT:' + component.direction + ':' +
            evaluationTime + ':' + startAt + ':' + endAt;
        var event = {
            id: id,
            type: 'DISPLACEMENT',
            schemaVersion: 1,
            detectorVersion: 'A+C2-V1',
            symbol: component.symbol,
            timeframe: component.timeframe,
            direction: component.direction,
            formationType: primary.formationType,
            startIndex: component.startIndex,
            endIndex: component.endIndex,
            startAt: startAt,
            endAt: endAt,
            confirmedAt: evaluationTime,
            startPrice: startRow.startPrice,
            endPrice: endRow.endPrice,
            price: endRow.endPrice,
            atr: primary.atr,
            metrics: clone(primary.metrics),
            sourceDetections: []
        };
        ['id','direction','startAt','endAt','confirmedAt','startIndex','endIndex'].forEach(function (field) {
            Object.defineProperty(event, field, { value:event[field], enumerable:true, writable:false, configurable:false });
        });
        rows.forEach(function (raw) { append(event, raw, evaluationTime); });
        byId[id] = event;
        order.push(id);
        var key = keyOf(event);
        if (!activeByKey[key]) activeByKey[key] = [];
        activeByKey[key].push(id);
        var endKey = event.symbol + '|' + event.endIndex;
        if (!idsByEnd[endKey]) idsByEnd[endKey] = [];
        idsByEnd[endKey].push(id);
        return event;
    }

    function process(rawDetections, evaluationTime) {
        var created = [], updated = [];
        components(rawDetections || []).forEach(function (component) {
            var key = [component.symbol, component.timeframe, component.direction].join('|');
            var active = (activeByKey[key] || []).filter(function (id) { return byId[id].endIndex >= component.startIndex; });
            activeByKey[key] = active;
            var matches = active.map(function (id) { return byId[id]; }).filter(function (event) {
                return overlaps(event, component);
            }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id); });
            if (!matches.length) {
                created.push(create(component, evaluationTime));
                return;
            }
            var target = matches[0];
            var changed = false;
            component.rows.slice().sort(compareRaw).forEach(function (raw) {
                if (append(target, raw, evaluationTime)) changed = true;
            });
            if (changed) updated.push(target);
        });
        return { created: created, updated: updated };
    }

    function project(event, evaluationTime) {
        if (!event || event.confirmedAt > evaluationTime) return null;
        var out = clone(event);
        out.sourceDetections = out.sourceDetections.filter(function (source) { return source.attachedAt <= evaluationTime; });
        return out;
    }
    function getAsOf(evaluationTime, symbol) {
        return order.map(function (id) { return project(byId[id], evaluationTime); }).filter(function (event) {
            return event && (!symbol || event.symbol === symbol);
        });
    }
    function getEndingFrom(minEndIndex, maxEndIndex, evaluationTime, symbol) {
        var out = [];
        for (var index = minEndIndex; index <= maxEndIndex; index++) {
            (idsByEnd[(symbol || '') + '|' + index] || []).forEach(function (id) {
                var projected = project(byId[id], evaluationTime);
                if (projected) out.push(projected);
            });
        }
        return out;
    }
    return {
        process: process,
        getById: function (id) { return byId[id] || null; },
        getProjectedById: function (id, evaluationTime) { return project(byId[id], evaluationTime); },
        getAsOf: getAsOf,
        getEndingAt: function (endIndex, evaluationTime, symbol) { return getEndingFrom(endIndex, endIndex, evaluationTime, symbol); },
        getEndingFrom: getEndingFrom,
        getAll: function (symbol) { return getAsOf(Infinity, symbol); },
        size: function () { return order.length; }
    };
}

module.exports = { createCanonicalDisplacementStore: createCanonicalDisplacementStore, components: components };
