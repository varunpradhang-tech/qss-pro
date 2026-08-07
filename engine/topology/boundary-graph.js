"use strict";
const { cleanCadText } = require("../cad/dxf-reader.js");

const GRID_LABEL_RE = /^([EH])(\d+)$/i;

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function lineLength(entity) {
  return Math.hypot((entity.x2 || 0) - (entity.x || 0), (entity.y2 || 0) - (entity.y || 0));
}

function normalizedLineType(entity) {
  return String(entity.lineType || entity.linetype || "").toUpperCase();
}

function textOrientation(entity) {
  const angle = ((Number(entity.rotation ?? entity.angle ?? 0) % 180) + 180) % 180;
  return angle > 45 && angle < 135 ? "V" : "H";
}

function parseBeamSizeText(text) {
  const clean = cleanCadText(text).toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/(?:BEAM)?\(?(\d{2,4})(?:\/\d{2,4})?[X](\d{2,4})\)?/);
  if (!match) return null;
  const widthMm = Number(match[1]);
  const depthMm = Number(match[2]);
  if (widthMm < 100 || widthMm > 1500 || depthMm < 150 || depthMm > 2500) return null;
  return { widthMm, depthMm, label: `${widthMm}X${depthMm}` };
}

function isBeamLabelText(text) {
  const clean = cleanCadText(text).toUpperCase().replace(/\s+/g, "");
  const beamNumber = clean.match(/B(\d+)/);
  return (/^(?:[A-Z]{0,4}\d*)?B\d+[A-Z]?$/.test(clean) && Number(beamNumber?.[1] || 0) > 0) ||
    /^BEAM(?:\(|$)/.test(clean);
}

function isGridLikeLine(entity) {
  const layer = normalizeLayer(entity.layer);
  const lineType = normalizedLineType(entity);
  return /GRID|CENTER|CENTRE/.test(layer) || /CENTER|CENTRE/.test(lineType);
}

function isDashedBeamLine(entity) {
  const lineType = normalizedLineType(entity);
  return /HIDDEN|DASH|DOTTED|ACAD_ISO0?2|ACAD_ISO0?3/.test(lineType);
}

function textAlongCoordinate(text, orientation) {
  return orientation === "H" ? Number(text.x || 0) : Number(text.y || 0);
}

function sortedIndexByKey(items, keyFn) {
  const entries = items.map((item) => ({ item, key: keyFn(item) })).sort((a, b) => a.key - b.key);
  return { items: entries.map((entry) => entry.item), keys: entries.map((entry) => entry.key) };
}

function lowerBoundKey(keys, target) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundKey(keys, target) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rangeQuery(index, minKey, maxKey) {
  if (!index || !index.items.length || minKey > maxKey) return [];
  return index.items.slice(lowerBoundKey(index.keys, minKey), upperBoundKey(index.keys, maxKey));
}

function buildOrientedIndex(items, axisValueFn) {
  return {
    H: sortedIndexByKey(items.filter((item) => item.orientation === "H"), axisValueFn),
    V: sortedIndexByKey(items.filter((item) => item.orientation === "V"), axisValueFn),
  };
}

function hasBeamTextEvidenceNearLine(line, beamTextIndexByOrientation, options = {}) {
  const axisToleranceMm = Number(options.axisToleranceMm || 1800);
  const alongToleranceMm = Number(options.alongToleranceMm || 2800);
  const candidates = rangeQuery(beamTextIndexByOrientation[line.orientation], line.fixed - axisToleranceMm, line.fixed + axisToleranceMm);
  return candidates.some((text) => {
    const along = textAlongCoordinate(text, line.orientation);
    return along >= line.start - alongToleranceMm && along <= line.end + alongToleranceMm;
  });
}

function parallelMateCount(line, lineRowIndexByOrientation, options = {}) {
  const minBeamWidthMm = Number(options.minBeamWidthMm || 120);
  const maxBeamWidthMm = Number(options.maxBeamWidthMm || 1400);
  const minOverlapMm = Number(options.minOverlapMm || 450);
  const index = lineRowIndexByOrientation[line.orientation];
  const candidates = [
    ...rangeQuery(index, line.fixed - maxBeamWidthMm, line.fixed - minBeamWidthMm),
    ...rangeQuery(index, line.fixed + minBeamWidthMm, line.fixed + maxBeamWidthMm),
  ];
  return candidates.filter((other) => {
    if (other === line) return false;
    const overlap = overlap1d(line.start, line.end, other.start, other.end);
    return overlap >= minOverlapMm;
  }).length;
}

function lineRecord(entity) {
  const horizontal = isHorizontal(entity, 0.05);
  const vertical = isVertical(entity, 0.05);
  const orientation = horizontal ? "H" : vertical ? "V" : "D";
  return {
    entity,
    orientation,
    fixed: orientation === "H" ? (entity.y + entity.y2) / 2 : (entity.x + entity.x2) / 2,
    start: orientation === "H" ? Math.min(entity.x, entity.x2) : Math.min(entity.y, entity.y2),
    end: orientation === "H" ? Math.max(entity.x, entity.x2) : Math.max(entity.y, entity.y2),
  };
}

function looksXrefBound(value) {
  const text = String(value || "");
  return /\$\d+\$/.test(text) || /^X[A-Za-z]/.test(text);
}

function isXrefEntity(entity) {
  return looksXrefBound(entity?.sourceBlock) || looksXrefBound(entity?.layer);
}

function isHorizontal(entity, toleranceRatio = 0.03) {
  return Math.abs((entity.y2 || 0) - (entity.y || 0)) <= Math.abs((entity.x2 || 0) - (entity.x || 0)) * toleranceRatio;
}

function isVertical(entity, toleranceRatio = 0.03) {
  return Math.abs((entity.x2 || 0) - (entity.x || 0)) <= Math.abs((entity.y2 || 0) - (entity.y || 0)) * toleranceRatio;
}

function entityBox(entity) {
  if (entity.vertices?.length) {
    const xs = entity.vertices.map((point) => point.x);
    const ys = entity.vertices.map((point) => point.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  return {
    minX: Math.min(entity.x, entity.x2),
    maxX: Math.max(entity.x, entity.x2),
    minY: Math.min(entity.y, entity.y2),
    maxY: Math.max(entity.y, entity.y2),
  };
}

function boxArea(box) {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function normalizeLayer(layer) {
  return String(layer || "").toUpperCase();
}

function groupGridLabels(labels) {
  const bySource = new Map();
  for (const label of labels) {
    const source = label.sourceBlock || "__TOP__";
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(label);
  }
  const sourceEntries = [...bySource.entries()]
    .map(([source, rows]) => ({ source, rows, uniqueCount: new Set(rows.map((row) => row.label)).size }))
    .sort((a, b) => b.uniqueCount - a.uniqueCount || b.rows.length - a.rows.length);
  return sourceEntries[0]?.uniqueCount >= 8 ? sourceEntries[0] : { source: "mixed", rows: labels };
}

function buildGridRegistry(entities, options = {}) {
  const labels = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => {
      const label = cleanCadText(entity.text);
      const match = label.match(GRID_LABEL_RE);
      if (!match || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return null;
      return {
        label: `${match[1].toUpperCase()}${Number(match[2])}`,
        axis: match[1].toUpperCase(),
        index: Number(match[2]),
        x: entity.x,
        y: entity.y,
        layer: entity.layer,
        sourceBlock: entity.sourceBlock || "",
      };
    })
    .filter(Boolean);

  const primary = groupGridLabels(labels);
  const rows = primary.rows;
  const lineEntities = entities
    .filter((entity) => entity.type === "LINE" && Number.isFinite(entity.x) && Number.isFinite(entity.y) && Number.isFinite(entity.x2) && Number.isFinite(entity.y2))
    .filter((entity) => !isXrefEntity(entity))
    .filter((entity) => /GRID/i.test(entity.layer || "") || /CENTER/i.test(entity.lineType || ""))
    .filter((entity) => lineLength(entity) >= Number(options.minGridLineLengthMm || 1000));

  function axisRegistry(axis) {
    const grouped = new Map();
    for (const row of rows.filter((item) => item.axis === axis)) {
      if (!grouped.has(row.label)) grouped.set(row.label, []);
      grouped.get(row.label).push(row);
    }
    return [...grouped.entries()]
      .map(([label, items]) => {
        const coordinate = axis === "E" ? median(items.map((item) => item.x)) : median(items.map((item) => item.y));
        const nearestLine = lineEntities
          .filter((line) => axis === "E" ? isVertical(line, 0.08) : isHorizontal(line, 0.08))
          .map((line) => {
            const lineCoordinate = axis === "E" ? (line.x + line.x2) / 2 : (line.y + line.y2) / 2;
            return { line, distance: Math.abs(lineCoordinate - coordinate) };
          })
          .sort((a, b) => a.distance - b.distance)[0];
        return {
          label,
          index: Number(label.slice(1)),
          coordinate,
          labelPoints: items.length,
          lineMatched: Boolean(nearestLine && nearestLine.distance <= Number(options.gridLineSnapMm || 350)),
          lineDistanceMm: nearestLine ? Math.round(nearestLine.distance) : null,
        };
      })
      .sort((a, b) => a.coordinate - b.coordinate);
  }

  const eAxes = axisRegistry("E");
  const hAxes = axisRegistry("H").sort((a, b) => b.coordinate - a.coordinate);
  return {
    sourceBlock: primary.source,
    labelCount: labels.length,
    primaryLabelCount: rows.length,
    eAxes,
    hAxes,
    complete: eAxes.length >= Number(options.minEAxes || 2) && hAxes.length >= Number(options.minHAxes || 2),
    spacings: {
      E: eAxes.slice(1).map((axis, index) => ({ from: eAxes[index].label, to: axis.label, distanceMm: Math.abs(axis.coordinate - eAxes[index].coordinate) })),
      H: hAxes.slice(1).map((axis, index) => ({ from: hAxes[index].label, to: axis.label, distanceMm: Math.abs(axis.coordinate - hAxes[index].coordinate) })),
    },
  };
}

function extractBoundarySegments(entities) {
  const lineEntities = entities
    .filter((entity) => entity.type === "LINE" && Number.isFinite(entity.x) && Number.isFinite(entity.y) && Number.isFinite(entity.x2) && Number.isFinite(entity.y2))
    .filter((entity) => lineLength(entity) >= 200);
  const beamTexts = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({
      ...entity,
      clean: cleanCadText(entity.text),
      orientation: textOrientation(entity),
      size: parseBeamSizeText(entity.text),
      isBeamLabel: isBeamLabelText(entity.text),
    }))
    .filter((entity) => Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .filter((entity) => entity.size || entity.isBeamLabel);
  const lineRows = lineEntities
    .map(lineRecord)
    .filter((line) => line.orientation === "H" || line.orientation === "V");
  const lineRowByEntity = new Map(lineRows.map((line) => [line.entity, line]));
  const beamTextIndexByOrientation = buildOrientedIndex(beamTexts, (text) =>
    text.orientation === "H" ? Number(text.y || 0) : Number(text.x || 0));
  const lineRowIndexByOrientation = buildOrientedIndex(lineRows, (line) => line.fixed);

  return lineEntities.map((entity) => {
      const layer = normalizeLayer(entity.layer);
      const horizontal = isHorizontal(entity, 0.05);
      const vertical = isVertical(entity, 0.05);
      const lineType = normalizedLineType(entity);
      const currentLine = lineRowByEntity.get(entity);
      const hasBeamText = currentLine ? hasBeamTextEvidenceNearLine(currentLine, beamTextIndexByOrientation) : false;
      // A real beam cross-section has exactly two long faces, so a genuine face has exactly one
      // parallel mate at beam-width spacing. Three or more evenly-spaced parallel lines in that same
      // band (e.g. a stirrup/rebar-spacing detail drawn on a generic layer like "0") is a repeated
      // schedule/detail pattern, not a beam face - inferring beam_face there pollutes the slab-panel
      // boundary graph with fake edges near the real beam text they happen to sit next to.
      const parallelMates = currentLine ? parallelMateCount(currentLine, lineRowIndexByOrientation) : 0;
      const hasParallelBeamMate = parallelMates === 1;
      const gridLike = isGridLikeLine(entity);
      const nonStructuralLayer = /NON[\s\-_]*STR/i.test(layer);
      const xrefSourced = isXrefEntity(entity);
      let type = "other";
      if (nonStructuralLayer || xrefSourced) type = "other";
      else if (/BEAM|POD\s*BEAM|ROOF\s*BEAM/.test(layer)) type = "beam_face";
      else if (/WALL|COL|COLUMN|PARDI/.test(layer)) type = "support_face";
      else if (/CUT\s*OUT|CUTOUT|SHAFT/.test(layer)) type = "cutout_boundary";
      else if (/GRID/.test(layer)) type = "grid_reference";
      else if (!gridLike && hasBeamText && hasParallelBeamMate) type = "beam_face";
      return {
        type,
        layer: entity.layer,
        lineType,
        color: entity.color ?? null,
        edgeStyle: isDashedBeamLine(entity) ? "dotted" : "continuous",
        inferredFromBeamText: type === "beam_face" && !/BEAM|POD\s*BEAM|ROOF\s*BEAM/.test(layer),
        orientation: horizontal ? "H" : vertical ? "V" : "D",
        x1: entity.x,
        y1: entity.y,
        x2: entity.x2,
        y2: entity.y2,
        lengthMm: lineLength(entity),
        verified: ["beam_face", "support_face", "cutout_boundary"].includes(type) && (horizontal || vertical),
      };
    });
}

function extractSupportBoxes(entities) {
  return entities
    .filter((entity) => ["LWPOLYLINE", "POLYLINE", "HATCH"].includes(entity.type) && entity.vertices?.length >= 4)
    .map((entity) => ({ entity, box: entityBox(entity), layer: normalizeLayer(entity.layer) }))
    .filter(({ box }) => boxArea(box) >= 0.04e6)
    .filter(({ box }) => (box.maxX - box.minX) <= 80000 && (box.maxY - box.minY) <= 80000)
    .filter(({ entity, box, layer }) => {
      if (/QSS_|PANEL|GRID|DIM|TEXT|CUT\s*OUT|CUTOUT|VOID|BEAM/.test(layer)) return false;
      if (/NON[\s\-_]*STR/i.test(layer)) return false;
      if (isXrefEntity(entity)) return false;
      if (/COL|COLUMN|WALL|PARDI|LIFT|SHAFT/.test(layer)) return true;
      if (entity.type !== "HATCH") return false;
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      const narrow = Math.min(width, height);
      const long = Math.max(width, height);
      return (width <= 2600 && height <= 2600) || (narrow <= 1200 && long >= 1200 && long <= 18000);
    })
    .map(({ entity, box, layer }) => {
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      const ratio = Math.max(width, height) / Math.max(Math.min(width, height), 1);
      return {
        type: /COL|COLUMN/.test(layer) && ratio < 3 ? "column" : /LIFT|SHAFT/.test(layer) ? "lift_wall" : "wall",
        layer: entity.layer,
        box,
        faces: {
          left: box.minX,
          right: box.maxX,
          bottom: box.minY,
          top: box.maxY,
        },
      };
    });
}

function extractCutoutVoids(entities) {
  const cutoutTexts = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .filter((entity) => !isXrefEntity(entity))
    .map((entity) => ({ ...entity, clean: cleanCadText(entity.text).toUpperCase() }))
    .filter((entity) => /CUT\s*OUT|CUTOUT|OPEN\s*TO\s*SKY|\bOTS\b|SHAFT|VOID/.test(entity.clean));

  const cutoutBoxes = entities
    .filter((entity) => ["LWPOLYLINE", "POLYLINE", "HATCH"].includes(entity.type) && entity.vertices?.length >= 4)
    .filter((entity) => !isXrefEntity(entity))
    .map((entity) => ({ entity, box: entityBox(entity), layer: normalizeLayer(entity.layer) }))
    .filter(({ box }) => boxArea(box) >= 0.02e6)
    .filter(({ box }) => (box.maxX - box.minX) <= 80000 && (box.maxY - box.minY) <= 80000)
    .filter(({ layer }) => /CUT\s*OUT|CUTOUT|SHAFT|VOID/.test(layer))
    .map(({ entity, box }) => ({ type: "cutout_boundary", layer: entity.layer, box, areaSqm: boxArea(box) / 1e6 }));

  const diagonalLines = entities
    .filter((entity) => entity.type === "LINE" && Number.isFinite(entity.x) && Number.isFinite(entity.y) && Number.isFinite(entity.x2) && Number.isFinite(entity.y2))
    .filter((entity) => !isXrefEntity(entity))
    .filter((entity) => {
      const dx = Math.abs(entity.x2 - entity.x);
      const dy = Math.abs(entity.y2 - entity.y);
      return dx >= 500 && dy >= 500 && dx / Math.max(dy, 1) >= 0.35 && dx / Math.max(dy, 1) <= 2.8;
    });

  return {
    textVoids: cutoutTexts.map((entity) => {
      const dimensions = [...entity.clean.matchAll(/(\d{2,5})\s*X\s*(\d{2,5})/gi)]
        .map((match) => ({ lengthMm: Number(match[1]), breadthMm: Number(match[2]) }))
        .filter((item) => item.lengthMm > 0 && item.breadthMm > 0);
      return {
        text: entity.clean,
        x: entity.x,
        y: entity.y,
        dimensions,
        areaSqm: dimensions.reduce((sum, item) => sum + (item.lengthMm * item.breadthMm) / 1e6, 0),
      };
    }),
    textCount: cutoutTexts.length,
    boundaryVoids: cutoutBoxes,
    diagonalEvidenceCount: diagonalLines.length,
    complete: cutoutTexts.length > 0 || cutoutBoxes.length > 0 || diagonalLines.length >= 2,
  };
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function intervalOverlapsBox(axis, fixedCoordinate, start, end, box, toleranceMm) {
  if (axis === "H") {
    return fixedCoordinate >= box.minY - toleranceMm &&
      fixedCoordinate <= box.maxY + toleranceMm &&
      overlap1d(start, end, box.minX, box.maxX) > 0;
  }
  return fixedCoordinate >= box.minX - toleranceMm &&
    fixedCoordinate <= box.maxX + toleranceMm &&
    overlap1d(start, end, box.minY, box.maxY) > 0;
}

function isBridgeableGap({ axis, fixedCoordinate, gapStart, gapEnd, supportBoxes, maxGapMm, toleranceMm }) {
  const gap = gapEnd - gapStart;
  if (gap <= maxGapMm) return true;
  return supportBoxes.some((support) => intervalOverlapsBox(axis, fixedCoordinate, gapStart, gapEnd, support.box, toleranceMm));
}

function stitchBoundarySegments(segments, supportBoxes = [], options = {}) {
  const coordinateToleranceMm = Number(options.coordinateToleranceMm || 160);
  const maxGapMm = Number(options.maxGapMm || 850);
  const supportToleranceMm = Number(options.supportToleranceMm || 250);
  const stitchable = segments
    .filter((segment) => segment.verified && ["beam_face", "support_face", "cutout_boundary"].includes(segment.type))
    .filter((segment) => segment.orientation === "H" || segment.orientation === "V")
    .map((segment) => {
      const axis = segment.orientation;
      const fixedCoordinate = axis === "H" ? (segment.y1 + segment.y2) / 2 : (segment.x1 + segment.x2) / 2;
      const start = axis === "H" ? Math.min(segment.x1, segment.x2) : Math.min(segment.y1, segment.y2);
      const end = axis === "H" ? Math.max(segment.x1, segment.x2) : Math.max(segment.y1, segment.y2);
      return { ...segment, axis, fixedCoordinate, start, end };
    })
    .sort((a, b) => a.axis.localeCompare(b.axis) || a.fixedCoordinate - b.fixedCoordinate || a.start - b.start);

  const groups = [];
  for (const segment of stitchable) {
    const last = groups.at(-1);
    if (
      !last ||
      last.axis !== segment.axis ||
      last.type !== segment.type ||
      Math.abs(last.fixedCoordinate - segment.fixedCoordinate) > coordinateToleranceMm
    ) {
      groups.push({ axis: segment.axis, type: segment.type, fixedCoordinates: [segment.fixedCoordinate], items: [segment] });
    } else {
      last.fixedCoordinates.push(segment.fixedCoordinate);
      last.items.push(segment);
    }
  }

  const stitched = [];
  for (const group of groups) {
    const fixedCoordinate = median(group.fixedCoordinates);
    const sorted = group.items.sort((a, b) => a.start - b.start);
    let current = null;
    let sourceCount = 0;
    for (const item of sorted) {
      if (!current) {
        current = { start: item.start, end: item.end };
        sourceCount = 1;
        continue;
      }
      const gap = item.start - current.end;
      if (gap <= 0 || isBridgeableGap({
        axis: group.axis,
        fixedCoordinate,
        gapStart: current.end,
        gapEnd: item.start,
        supportBoxes,
        maxGapMm,
        toleranceMm: supportToleranceMm,
      })) {
        current.end = Math.max(current.end, item.end);
        sourceCount += 1;
      } else {
        stitched.push(makeStitchedBoundary(group, fixedCoordinate, current, sourceCount));
        current = { start: item.start, end: item.end };
        sourceCount = 1;
      }
    }
    if (current) stitched.push(makeStitchedBoundary(group, fixedCoordinate, current, sourceCount));
  }

  return stitched.filter((segment) => segment.lengthMm >= Number(options.minStitchedLengthMm || 450));
}

function makeStitchedBoundary(group, fixedCoordinate, interval, sourceCount) {
  const edgeStyle = group.items?.some((item) => item.edgeStyle === "dotted")
    ? "dotted"
    : group.items?.some((item) => item.edgeStyle === "continuous")
      ? "continuous"
      : "";
  if (group.axis === "H") {
    return {
      type: group.type,
      layer: `stitched ${group.type}`,
      edgeStyle,
      orientation: "H",
      x1: interval.start,
      y1: fixedCoordinate,
      x2: interval.end,
      y2: fixedCoordinate,
      lengthMm: interval.end - interval.start,
      verified: true,
      stitched: sourceCount > 1,
      sourceCount,
    };
  }
  return {
    type: group.type,
    layer: `stitched ${group.type}`,
    edgeStyle,
    orientation: "V",
    x1: fixedCoordinate,
    y1: interval.start,
    x2: fixedCoordinate,
    y2: interval.end,
    lengthMm: interval.end - interval.start,
    verified: true,
    stitched: sourceCount > 1,
    sourceCount,
  };
}

function mergedLength(intervals) {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) {
      current = { ...interval };
    } else if (interval.start <= current.end + 75) {
      current.end = Math.max(current.end, interval.end);
    } else {
      total += current.end - current.start;
      current = { ...interval };
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function boundaryCoverage(boundaries, side, box, toleranceMm) {
  if (side === "top" || side === "bottom") {
    const y = side === "top" ? box.maxY : box.minY;
    const intervals = boundaries
      .filter((boundary) => boundary.verified && boundary.orientation === "H")
      .filter((boundary) => Math.abs(((boundary.y1 + boundary.y2) / 2) - y) <= toleranceMm)
      .map((boundary) => ({ start: Math.max(Math.min(boundary.x1, boundary.x2), box.minX), end: Math.min(Math.max(boundary.x1, boundary.x2), box.maxX) }));
    return mergedLength(intervals) / Math.max(box.maxX - box.minX, 1);
  }
  const x = side === "left" ? box.minX : box.maxX;
  const intervals = boundaries
    .filter((boundary) => boundary.verified && boundary.orientation === "V")
    .filter((boundary) => Math.abs(((boundary.x1 + boundary.x2) / 2) - x) <= toleranceMm)
    .map((boundary) => ({ start: Math.max(Math.min(boundary.y1, boundary.y2), box.minY), end: Math.min(Math.max(boundary.y1, boundary.y2), box.maxY) }));
  return mergedLength(intervals) / Math.max(box.maxY - box.minY, 1);
}

function boxOverlapArea(a, b) {
  const x = overlap1d(a.minX, a.maxX, b.minX, b.maxX);
  const y = overlap1d(a.minY, a.maxY, b.minY, b.maxY);
  return x * y;
}

function pointInsideBox(point, box) {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function cutoutAreaForBox(box, cutouts) {
  const cutoutByBoundary = cutouts.boundaryVoids
    .map((voidBox) => boxOverlapArea(box, voidBox.box) / 1e6)
    .filter((area) => area > 0.01);
  const cutoutByText = cutouts.textVoids
    .filter((voidText) => pointInsideBox(voidText, box))
    .map((voidText) => voidText.areaSqm)
    .filter((area) => area > 0.01);
  return Math.max(
    cutoutByBoundary.reduce((sum, area) => sum + area, 0),
    cutoutByText.reduce((sum, area) => sum + area, 0),
  );
}

function uniqueSortedCoordinates(values, toleranceMm = 150) {
  return clusterCoordinates(values, toleranceMm).sort((a, b) => a - b);
}

function internalSplitBoundaries(panel, rawBoundaries, options = {}) {
  const minInternalCoverage = Number(options.minInternalCoverage || 0.78);
  const edgeClearanceMm = Number(options.edgeClearanceMm || 500);
  const coordinateToleranceMm = Number(options.coordinateToleranceMm || 120);
  const box = panel.box;
  const height = box.maxY - box.minY;
  const width = box.maxX - box.minX;
  const verticalSplits = [];
  const horizontalSplits = [];

  for (const boundary of rawBoundaries) {
    if (!boundary.verified || !["beam_face", "support_face", "cutout_boundary"].includes(boundary.type)) continue;
    if (boundary.orientation === "V") {
      const x = (boundary.x1 + boundary.x2) / 2;
      if (x <= box.minX + edgeClearanceMm || x >= box.maxX - edgeClearanceMm) continue;
      const coverage = overlap1d(Math.min(boundary.y1, boundary.y2), Math.max(boundary.y1, boundary.y2), box.minY, box.maxY) / Math.max(height, 1);
      if (coverage >= minInternalCoverage) verticalSplits.push(x);
    }
    if (boundary.orientation === "H") {
      const y = (boundary.y1 + boundary.y2) / 2;
      if (y <= box.minY + edgeClearanceMm || y >= box.maxY - edgeClearanceMm) continue;
      const coverage = overlap1d(Math.min(boundary.x1, boundary.x2), Math.max(boundary.x1, boundary.x2), box.minX, box.maxX) / Math.max(width, 1);
      if (coverage >= minInternalCoverage) horizontalSplits.push(y);
    }
  }

  return {
    x: uniqueSortedCoordinates(verticalSplits, coordinateToleranceMm),
    y: uniqueSortedCoordinates(horizontalSplits, coordinateToleranceMm),
  };
}

function makePanelFromBox({ panelNumber, box, grid, cutouts, defaultThicknessM, coverage, remarks }) {
  const lengthM = (box.maxX - box.minX) / 1000;
  const breadthM = (box.maxY - box.minY) / 1000;
  const grossAreaSqm = lengthM * breadthM;
  const cutoutAreaSqm = cutoutAreaForBox(box, cutouts);
  const netAreaSqm = Math.max(0, grossAreaSqm - cutoutAreaSqm);
  return {
    panel: `P${panelNumber}`,
    gridBand: nearestGridBand(grid, box),
    lengthM,
    breadthM,
    thicknessM: defaultThicknessM,
    grossAreaSqm,
    cutoutAreaSqm,
    netAreaSqm,
    concreteCum: netAreaSqm * defaultThicknessM,
    coverage,
    box,
    remarks: [
      remarks,
      cutoutAreaSqm > 0 ? `cutout deducted ${Math.round(cutoutAreaSqm * 1000) / 1000} sqm` : "",
    ].filter(Boolean).join("; "),
  };
}

function splitVerifiedPanelsByInternalBoundaries({ panels, rawBoundaries, verifiedBoundaries, grid, cutouts, defaultThicknessM, boundaryToleranceMm, minCoverage, minDimensionM, maxDimensionM, options = {} }) {
  const result = [];
  const review = [];
  const minSplitAreaSqm = Number(options.minSplitAreaSqm || 25);
  let splitPanelCount = 0;

  for (const panel of panels) {
    if (panel.grossAreaSqm < minSplitAreaSqm) {
      result.push({ ...panel, panel: `P${result.length + 1}` });
      continue;
    }
    const splits = internalSplitBoundaries(panel, rawBoundaries, options);
    if (!splits.x.length && !splits.y.length) {
      result.push({ ...panel, panel: `P${result.length + 1}` });
      continue;
    }

    const xs = [panel.box.minX, ...splits.x, panel.box.maxX].sort((a, b) => a - b);
    const ys = [panel.box.maxY, ...splits.y.sort((a, b) => b - a), panel.box.minY];
    const localInternal = [
      ...splits.x.map((x) => ({ type: "internal_split", orientation: "V", x1: x, x2: x, y1: panel.box.minY, y2: panel.box.maxY, verified: true, lengthMm: panel.box.maxY - panel.box.minY })),
      ...splits.y.map((y) => ({ type: "internal_split", orientation: "H", x1: panel.box.minX, x2: panel.box.maxX, y1: y, y2: y, verified: true, lengthMm: panel.box.maxX - panel.box.minX })),
    ];
    const localBoundaries = [...verifiedBoundaries, ...localInternal];
    let created = 0;
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let xi = 0; xi < xs.length - 1; xi += 1) {
        const box = {
          minX: Math.min(xs[xi], xs[xi + 1]),
          maxX: Math.max(xs[xi], xs[xi + 1]),
          minY: Math.min(ys[yi], ys[yi + 1]),
          maxY: Math.max(ys[yi], ys[yi + 1]),
        };
        const lengthM = (box.maxX - box.minX) / 1000;
        const breadthM = (box.maxY - box.minY) / 1000;
        const grossAreaSqm = lengthM * breadthM;
        if (lengthM < minDimensionM || breadthM < minDimensionM || lengthM > maxDimensionM || breadthM > maxDimensionM || grossAreaSqm < 0.5) continue;
        const coverage = {
          top: boundaryCoverage(localBoundaries, "top", box, boundaryToleranceMm),
          bottom: boundaryCoverage(localBoundaries, "bottom", box, boundaryToleranceMm),
          left: boundaryCoverage(localBoundaries, "left", box, boundaryToleranceMm),
          right: boundaryCoverage(localBoundaries, "right", box, boundaryToleranceMm),
        };
        const supportedSides = Object.values(coverage).filter((value) => value >= minCoverage).length;
        if (supportedSides < 4) {
          review.push({ gridBand: nearestGridBand(grid, box), lengthM, breadthM, grossAreaSqm, coverage, reason: "Internal split candidate has weak/missing boundary." });
          continue;
        }
        result.push(makePanelFromBox({
          panelNumber: result.length + 1,
          box,
          grid,
          cutouts,
          defaultThicknessM,
          coverage,
          remarks: `Boundary face cell split from ${panel.panel}`,
        }));
        created += 1;
      }
    }
    if (created > 0) splitPanelCount += 1;
    else result.push({ ...panel, panel: `P${result.length + 1}`, remarks: `${panel.remarks}; internal split reviewed but not accepted` });
  }

  return { panels: result, reviewCells: review, splitPanelCount };
}

function solveGridSlabPanels(entities, options = {}) {
  const grid = buildGridRegistry(entities);
  const boundaries = extractBoundarySegments(entities);
  const cutouts = extractCutoutVoids(entities);
  const toleranceMm = Number(options.boundaryToleranceMm || 950);
  const minCoverage = Number(options.minCoverage || 0.42);
  const defaultThicknessM = Number(options.defaultThicknessM || 0.15);
  const panels = [];
  const reviewCells = [];

  if (!grid.complete) {
    return {
      ok: false,
      reason: "Grid registry is incomplete.",
      grid,
      panels,
      reviewCells,
    };
  }

  for (let h = 0; h < grid.hAxes.length - 1; h += 1) {
    for (let e = 0; e < grid.eAxes.length - 1; e += 1) {
      const left = grid.eAxes[e];
      const right = grid.eAxes[e + 1];
      const top = grid.hAxes[h];
      const bottom = grid.hAxes[h + 1];
      const box = {
        minX: Math.min(left.coordinate, right.coordinate),
        maxX: Math.max(left.coordinate, right.coordinate),
        minY: Math.min(top.coordinate, bottom.coordinate),
        maxY: Math.max(top.coordinate, bottom.coordinate),
      };
      const lengthM = (box.maxX - box.minX) / 1000;
      const breadthM = (box.maxY - box.minY) / 1000;
      if (lengthM < 0.3 || breadthM < 0.3 || lengthM * breadthM < 0.25) continue;

      const coverage = {
        top: boundaryCoverage(boundaries, "top", box, toleranceMm),
        bottom: boundaryCoverage(boundaries, "bottom", box, toleranceMm),
        left: boundaryCoverage(boundaries, "left", box, toleranceMm),
        right: boundaryCoverage(boundaries, "right", box, toleranceMm),
      };
      const supportedSides = Object.values(coverage).filter((value) => value >= minCoverage).length;
      const address = `${left.label}-${right.label}/${top.label}-${bottom.label}`;
      if (supportedSides < 4) {
        if (supportedSides >= 2) {
          reviewCells.push({ address, lengthM, breadthM, coverage, reason: "Not all four slab boundaries verified." });
        }
        continue;
      }

      const cutoutByBoundary = cutouts.boundaryVoids
        .map((voidBox) => boxOverlapArea(box, voidBox.box) / 1e6)
        .filter((area) => area > 0.01);
      const cutoutByText = cutouts.textVoids
        .filter((voidText) => pointInsideBox(voidText, box))
        .map((voidText) => voidText.areaSqm)
        .filter((area) => area > 0.01);
      const cutoutAreaSqm = Math.max(
        cutoutByBoundary.reduce((sum, area) => sum + area, 0),
        cutoutByText.reduce((sum, area) => sum + area, 0),
      );
      const grossAreaSqm = lengthM * breadthM;
      const netAreaSqm = Math.max(0, grossAreaSqm - cutoutAreaSqm);
      panels.push({
        panel: `P${panels.length + 1}`,
        address,
        lengthM,
        breadthM,
        thicknessM: defaultThicknessM,
        grossAreaSqm,
        cutoutAreaSqm,
        netAreaSqm,
        concreteCum: netAreaSqm * defaultThicknessM,
        coverage,
        remarks: cutoutAreaSqm > 0
          ? `Boundary graph grid cell; cutout deducted ${Math.round(cutoutAreaSqm * 1000) / 1000} sqm.`
          : "Boundary graph grid cell.",
      });
    }
  }

  return {
    ok: true,
    grid,
    panels,
    reviewCells,
    totals: {
      slabShutteringSqm: panels.reduce((sum, panel) => sum + panel.netAreaSqm, 0),
      slabConcreteCum: panels.reduce((sum, panel) => sum + panel.concreteCum, 0),
      cutoutDeductionSqm: panels.reduce((sum, panel) => sum + panel.cutoutAreaSqm, 0),
    },
  };
}

function clusterCoordinates(values, toleranceMm) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];
  for (const value of sorted) {
    const last = clusters.at(-1);
    if (!last || Math.abs(value - last.values.at(-1)) > toleranceMm) {
      clusters.push({ values: [value] });
    } else {
      last.values.push(value);
    }
  }
  return clusters.map((cluster) => median(cluster.values));
}

function nearestGridBand(grid, box) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const eLeftIndex = grid.eAxes.findIndex((axis, index) => {
    const next = grid.eAxes[index + 1];
    return next && cx >= Math.min(axis.coordinate, next.coordinate) && cx <= Math.max(axis.coordinate, next.coordinate);
  });
  const hTopIndex = grid.hAxes.findIndex((axis, index) => {
    const next = grid.hAxes[index + 1];
    return next && cy <= Math.max(axis.coordinate, next.coordinate) && cy >= Math.min(axis.coordinate, next.coordinate);
  });
  const eBand = eLeftIndex >= 0 ? `${grid.eAxes[eLeftIndex].label}-${grid.eAxes[eLeftIndex + 1].label}` : "outside E grid";
  const hBand = hTopIndex >= 0 ? `${grid.hAxes[hTopIndex].label}-${grid.hAxes[hTopIndex + 1].label}` : "outside H grid";
  return `${eBand}/${hBand}`;
}

function solveBoundarySlabPanels(entities, options = {}) {
  const grid = buildGridRegistry(entities);
  const rawBoundaries = extractBoundarySegments(entities);
  const supportBoxes = extractSupportBoxes(entities);
  const stitchedBoundaries = stitchBoundarySegments(rawBoundaries, supportBoxes, options.stitching || {});
  const boundaries = options.useRawBoundaries
    ? rawBoundaries
    : [...rawBoundaries, ...stitchedBoundaries];
  const cutouts = extractCutoutVoids(entities);
  const verified = boundaries.filter((boundary) => boundary.verified && ["beam_face", "support_face"].includes(boundary.type));
  const coordinateBoundaries = options.splitUsingRawFaceCoordinates && !options.useRawBoundaries
    ? [...rawBoundaries, ...boundaries]
    : boundaries;
  const verifiedForCoordinates = coordinateBoundaries
    .filter((boundary) => boundary.verified && ["beam_face", "support_face"].includes(boundary.type));
  const horizontal = verifiedForCoordinates.filter((boundary) => boundary.orientation === "H" && boundary.lengthMm >= Number(options.minBoundaryLengthMm || 500));
  const vertical = verifiedForCoordinates.filter((boundary) => boundary.orientation === "V" && boundary.lengthMm >= Number(options.minBoundaryLengthMm || 500));
  const clusterToleranceMm = Number(options.clusterToleranceMm || 120);
  const boundaryToleranceMm = Number(options.boundaryToleranceMm || 180);
  const minCoverage = Number(options.minCoverage || 0.72);
  const minDimensionM = Number(options.minDimensionM || 0.45);
  const maxDimensionM = Number(options.maxDimensionM || 18);
  const defaultThicknessM = Number(options.defaultThicknessM || 0.15);
  const xCoords = clusterCoordinates(vertical.flatMap((boundary) => [boundary.x1, boundary.x2]), clusterToleranceMm);
  const yCoords = clusterCoordinates(horizontal.flatMap((boundary) => [boundary.y1, boundary.y2]), clusterToleranceMm).sort((a, b) => b - a);
  const panels = [];
  const reviewCells = [];

  for (let yi = 0; yi < yCoords.length - 1; yi += 1) {
    for (let xi = 0; xi < xCoords.length - 1; xi += 1) {
      const box = {
        minX: Math.min(xCoords[xi], xCoords[xi + 1]),
        maxX: Math.max(xCoords[xi], xCoords[xi + 1]),
        minY: Math.min(yCoords[yi], yCoords[yi + 1]),
        maxY: Math.max(yCoords[yi], yCoords[yi + 1]),
      };
      const lengthM = (box.maxX - box.minX) / 1000;
      const breadthM = (box.maxY - box.minY) / 1000;
      const grossAreaSqm = lengthM * breadthM;
      if (
        lengthM < minDimensionM ||
        breadthM < minDimensionM ||
        lengthM > maxDimensionM ||
        breadthM > maxDimensionM ||
        grossAreaSqm < Number(options.minAreaSqm || 0.5)
      ) continue;

      const coverage = {
        top: boundaryCoverage(verified, "top", box, boundaryToleranceMm),
        bottom: boundaryCoverage(verified, "bottom", box, boundaryToleranceMm),
        left: boundaryCoverage(verified, "left", box, boundaryToleranceMm),
        right: boundaryCoverage(verified, "right", box, boundaryToleranceMm),
      };
      const supportedSides = Object.values(coverage).filter((value) => value >= minCoverage).length;
      const gridBand = nearestGridBand(grid, box);
      if (supportedSides < 4) {
        if (supportedSides >= 3 && grossAreaSqm >= 1) {
          reviewCells.push({ gridBand, lengthM, breadthM, grossAreaSqm, coverage, reason: "One boundary side is weak/missing." });
        }
        continue;
      }

      const cutoutAreaSqm = cutoutAreaForBox(box, cutouts);
      const netAreaSqm = Math.max(0, grossAreaSqm - cutoutAreaSqm);
      panels.push({
        panel: `P${panels.length + 1}`,
        gridBand,
        lengthM,
        breadthM,
        thicknessM: defaultThicknessM,
        grossAreaSqm,
        cutoutAreaSqm,
        netAreaSqm,
        concreteCum: netAreaSqm * defaultThicknessM,
        coverage,
        box,
        remarks: cutoutAreaSqm > 0
          ? `Boundary face cell; cutout deducted ${Math.round(cutoutAreaSqm * 1000) / 1000} sqm.`
          : "Boundary face cell.",
      });
    }
  }

  const splitResult = options.splitInternalBoundaries === false
    ? { panels, reviewCells: [], splitPanelCount: 0 }
    : splitVerifiedPanelsByInternalBoundaries({
      panels,
      rawBoundaries,
      verifiedBoundaries: verified,
      grid,
      cutouts,
      defaultThicknessM,
      boundaryToleranceMm,
      minCoverage,
      minDimensionM,
      maxDimensionM,
      options: options.internalSplit || {},
    });
  const finalPanels = splitResult.panels;
  const finalReviewCells = [...reviewCells, ...splitResult.reviewCells];

  return {
    ok: true,
    grid,
    boundaryCoordinates: { x: xCoords.length, y: yCoords.length },
    stitching: {
      used: !options.useRawBoundaries,
      rawBoundaries: rawBoundaries.filter((boundary) => boundary.verified).length,
      stitchedBoundaries: stitchedBoundaries.filter((boundary) => boundary.verified).length,
      stitchedJoinedBoundaries: stitchedBoundaries.filter((boundary) => boundary.stitched).length,
    },
    internalSplit: {
      used: options.splitInternalBoundaries !== false,
      splitPanelCount: splitResult.splitPanelCount,
      beforePanels: panels.length,
      afterPanels: finalPanels.length,
    },
    panels: finalPanels,
    reviewCells: finalReviewCells,
    totals: {
      slabShutteringSqm: finalPanels.reduce((sum, panel) => sum + panel.netAreaSqm, 0),
      slabConcreteCum: finalPanels.reduce((sum, panel) => sum + panel.concreteCum, 0),
      cutoutDeductionSqm: finalPanels.reduce((sum, panel) => sum + panel.cutoutAreaSqm, 0),
    },
  };
}

function buildQuantityReadiness(entities) {
  const grid = buildGridRegistry(entities);
  const boundaries = extractBoundarySegments(entities);
  const supports = extractSupportBoxes(entities);
  const cutouts = extractCutoutVoids(entities);
  const verifiedBoundaries = boundaries.filter((boundary) => boundary.verified);
  const beamFaces = verifiedBoundaries.filter((boundary) => boundary.type === "beam_face");
  const supportFaces = verifiedBoundaries.filter((boundary) => boundary.type === "support_face");

  return {
    grid,
    counts: {
      verifiedBoundaries: verifiedBoundaries.length,
      beamFaces: beamFaces.length,
      supportFaces: supportFaces.length,
      supportBoxes: supports.length,
      cutoutTexts: cutouts.textCount,
      cutoutBoundaryVoids: cutouts.boundaryVoids.length,
      cutoutDiagonalEvidence: cutouts.diagonalEvidenceCount,
    },
    gates: {
      gridRegistry: grid.complete,
      boundaryGraphInput: beamFaces.length >= 4 && (supportFaces.length + supports.length) >= 2,
      cutoutMap: cutouts.complete,
    },
  };
}

module.exports = {
  buildGridRegistry,
  extractBoundarySegments,
  extractSupportBoxes,
  extractCutoutVoids,
  stitchBoundarySegments,
  solveGridSlabPanels,
  solveBoundarySlabPanels,
  buildQuantityReadiness,
};
