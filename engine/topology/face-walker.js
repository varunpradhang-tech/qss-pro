"use strict";
const { buildGridRegistry, extractBoundarySegments, extractCutoutVoids, extractSupportBoxes, isXrefEntity } = require("./boundary-graph.js");
const { extractCadDimensions, validateBoxDimensions } = require("../cad/dimension-validator.js");
const { cleanCadText } = require("../cad/dxf-reader.js");

const DEFAULT_SLAB_THICKNESS_M = 0.15;

function round3(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function overlapArea(a, b) {
  return overlap1d(a.minX, a.maxX, b.minX, b.maxX) * overlap1d(a.minY, a.maxY, b.minY, b.maxY);
}

function removeOverlappingSlabPanels(panels, options = {}) {
  const minOverlapSqm = Number(options.minOverlapSqm || 0.05);
  const minOverlapRatio = Number(options.minOverlapRatio || 0.05);
  const maxTrimOverlapRatio = Number(options.maxTrimOverlapRatio || 0.12);
  const maxCumulativeTrimRatio = Number(options.maxCumulativeTrimRatio || 0.18);
  const rejected = new Set();
  const adjusted = panels.map((panel) => ({ ...panel, overlapDeductionSqm: panel.overlapDeductionSqm || 0 }));
  const review = [];

  function trimSmallOverlap(index, overlapSqm) {
    const panel = adjusted[index];
    const nextDeduction = round3((panel.overlapDeductionSqm || 0) + overlapSqm);
    if (nextDeduction / Math.max(panel.grossAreaSqm, 0.001) > maxCumulativeTrimRatio) return false;
    const totalDeductionSqm = round3((panel.cutoutAreaSqm || 0) + overlapSqm);
    const netAreaSqm = Math.max(0, (panel.grossAreaSqm || 0) - totalDeductionSqm);
    adjusted[index] = {
      ...panel,
      overlapDeductionSqm: nextDeduction,
      cutoutAreaSqm: round3(totalDeductionSqm),
      netAreaSqm: round3(netAreaSqm),
      concreteCum: round3(netAreaSqm * (panel.thicknessM || DEFAULT_SLAB_THICKNESS_M)),
      remarks: [
        panel.remarks,
        `small overlap/offset deducted ${round3(overlapSqm)} sqm`,
      ].filter(Boolean).join(" "),
    };
    return true;
  }

  for (let i = 0; i < panels.length; i += 1) {
    for (let j = i + 1; j < panels.length; j += 1) {
      if (rejected.has(i) || rejected.has(j)) continue;
      const overlapSqm = overlapArea(adjusted[i].box, adjusted[j].box) / 1e6;
      if (overlapSqm < minOverlapSqm) continue;
      const smallerArea = Math.min(adjusted[i].grossAreaSqm, adjusted[j].grossAreaSqm);
      if (overlapSqm / Math.max(smallerArea, 0.001) < minOverlapRatio) continue;
      // Preferring the smaller footprint assumes the bigger one wrongly merged two real rooms - a
      // reasonable default. But a face whose true polygon area is far smaller than its own bounding
      // box (a hugely irregular/zigzag shape) is far more likely a broken face-walk artifact than a
      // legitimately stepped room, regardless of which one is smaller. Reject on irregularity first
      // when it clearly distinguishes the two; only fall back to the area heuristic when both shapes
      // look similarly regular.
      const ratioA = Number(adjusted[i].boxToPolygonRatio);
      const ratioB = Number(adjusted[j].boxToPolygonRatio);
      const irregularityGapThreshold = 0.5;
      const rejectIndex = Number.isFinite(ratioA) && Number.isFinite(ratioB) && Math.abs(ratioA - ratioB) > irregularityGapThreshold
        ? (ratioA >= ratioB ? i : j)
        : (adjusted[i].grossAreaSqm >= adjusted[j].grossAreaSqm ? i : j);
      const rejectOverlapRatio = overlapSqm / Math.max(adjusted[rejectIndex].grossAreaSqm, 0.001);
      if (rejectOverlapRatio <= maxTrimOverlapRatio && trimSmallOverlap(rejectIndex, overlapSqm)) continue;
      rejected.add(rejectIndex);
      review.push({
        ...adjusted[rejectIndex],
        reason: `Overlaps another accepted slab panel by ${round3(overlapSqm)} sqm; possible merged/duplicate slab cell.`,
      });
    }
  }
  return {
    panels: adjusted.filter((_, index) => !rejected.has(index)).map((panel, index) => ({ ...panel, panel: `TP${index + 1}` })),
    review,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clusterCoordinate(value, buckets, toleranceMm) {
  for (const bucket of buckets) {
    if (Math.abs(bucket.value - value) <= toleranceMm) {
      bucket.values.push(value);
      bucket.value = median(bucket.values);
      return bucket.value;
    }
  }
  buckets.push({ value, values: [value] });
  return value;
}

function pointKey(x, y) {
  return `${Math.round(x)}:${Math.round(y)}`;
}

function directedKey(from, to) {
  return `${from.key}>${to.key}`;
}

function boxFromPoints(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += (a.x * b.y) - (b.x * a.y);
  }
  return area / 2;
}

function pointInsideBox(point, box) {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function pointInsidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-9) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineInterval(boundary, coordinateToleranceMm) {
  if (boundary.orientation === "H") {
    return {
      type: boundary.type,
      orientation: "H",
      fixed: (boundary.y1 + boundary.y2) / 2,
      start: Math.min(boundary.x1, boundary.x2),
      end: Math.max(boundary.x1, boundary.x2),
      layer: boundary.layer || "",
      lineType: boundary.lineType || "",
      color: boundary.color ?? null,
      lengthMm: boundary.lengthMm,
    };
  }
  return {
    type: boundary.type,
    orientation: "V",
    fixed: (boundary.x1 + boundary.x2) / 2,
    start: Math.min(boundary.y1, boundary.y2),
    end: Math.max(boundary.y1, boundary.y2),
    layer: boundary.layer || "",
    lineType: boundary.lineType || "",
    color: boundary.color ?? null,
    lengthMm: boundary.lengthMm,
  };
}

function supportBoxFaceSegments(supportBoxes) {
  const rows = [];
  for (const support of supportBoxes) {
    const b = support.box;
    rows.push(
      { type: "support_face", orientation: "H", fixed: b.minY, start: b.minX, end: b.maxX, layer: support.layer || "support-box", lengthMm: b.maxX - b.minX },
      { type: "support_face", orientation: "H", fixed: b.maxY, start: b.minX, end: b.maxX, layer: support.layer || "support-box", lengthMm: b.maxX - b.minX },
      { type: "support_face", orientation: "V", fixed: b.minX, start: b.minY, end: b.maxY, layer: support.layer || "support-box", lengthMm: b.maxY - b.minY },
      { type: "support_face", orientation: "V", fixed: b.maxX, start: b.minY, end: b.maxY, layer: support.layer || "support-box", lengthMm: b.maxY - b.minY },
    );
  }
  return rows;
}

function normalizeSegments(entities, options = {}) {
  const coordinateToleranceMm = Number(options.coordinateToleranceMm || 60);
  const minSegmentLengthMm = Number(options.minSegmentLengthMm || 250);
  const supportBoxes = extractSupportBoxes(entities);
  const raw = extractBoundarySegments(entities)
    .filter((boundary) => boundary.verified && ["beam_face", "support_face", "cutout_boundary"].includes(boundary.type))
    .filter((boundary) => boundary.orientation === "H" || boundary.orientation === "V")
    .filter((boundary) => boundary.lengthMm >= minSegmentLengthMm)
    .map((boundary) => lineInterval(boundary, coordinateToleranceMm));
  const supportFaces = supportBoxFaceSegments(supportBoxes);
  const fixedBuckets = { H: [], V: [] };
  return [...raw, ...supportFaces]
    .map((segment) => ({
      ...segment,
      fixed: clusterCoordinate(segment.fixed, fixedBuckets[segment.orientation], coordinateToleranceMm),
      start: Math.min(segment.start, segment.end),
      end: Math.max(segment.start, segment.end),
    }))
    .filter((segment) => segment.end - segment.start >= minSegmentLengthMm);
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
  if (!index.items.length || minKey > maxKey) return [];
  return index.items.slice(lowerBoundKey(index.keys, minKey), upperBoundKey(index.keys, maxKey));
}

function buildElementaryEdges(segments, options = {}) {
  const splitToleranceMm = Number(options.splitToleranceMm || 80);
  // normalizeSegments already enforces minSegmentLengthMm (default 250) on every segment before it
  // reaches here, so a short piece below that length can only come from splitting a real, already-
  // validated segment at a genuine crossing near one of its ends (e.g. a support box's own corner).
  // Dropping those short split pieces - rather than just genuinely degenerate zero-length artifacts -
  // silently breaks the graph's connectivity at that exact corner: a node that should have a third
  // edge closing a support box's face into a proper 4-way junction is left with only two, so the
  // face walk takes the wrong branch there and sweeps a large, badly warped polygon instead of the
  // real room. Only filter out truly degenerate (near-zero-length) pieces here.
  const minEdgeLengthMm = Number(options.minEdgeLengthMm || 5);
  const maxEdges = Number(options.maxEdges || 35000);
  const horizontal = segments.filter((segment) => segment.orientation === "H");
  const vertical = segments.filter((segment) => segment.orientation === "V");
  const horizontalByFixed = sortedIndexByKey(horizontal, (segment) => segment.fixed);
  const verticalByFixed = sortedIndexByKey(vertical, (segment) => segment.fixed);
  const edgeMap = new Map();

  function addEdge(orientation, fixed, start, end, source) {
    if (end - start < minEdgeLengthMm) return;
    const x1 = orientation === "H" ? start : fixed;
    const y1 = orientation === "H" ? fixed : start;
    const x2 = orientation === "H" ? end : fixed;
    const y2 = orientation === "H" ? fixed : end;
    const key = `${orientation}:${Math.round(fixed)}:${Math.round(start)}:${Math.round(end)}`;
    if (!edgeMap.has(key)) {
      if (edgeMap.size >= maxEdges) return;
      edgeMap.set(key, {
        orientation,
        fixed,
        start,
        end,
        x1,
        y1,
        x2,
        y2,
        types: new Set(),
        layers: new Set(),
        lineTypes: new Set(),
        colors: new Set(),
        sourceCount: 0,
      });
    }
    const edge = edgeMap.get(key);
    edge.types.add(source.type);
    if (source.layer) edge.layers.add(source.layer);
    if (source.lineType) edge.lineTypes.add(source.lineType);
    if (Number.isFinite(source.color)) edge.colors.add(source.color);
    edge.sourceCount += 1;
  }

  function uniqueSplitValues(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const clusters = [];
    for (const value of sorted) {
      const last = clusters.at(-1);
      if (!last || Math.abs(value - median(last)) > splitToleranceMm) clusters.push([value]);
      else last.push(value);
    }
    return clusters.map((cluster) => median(cluster)).sort((a, b) => a - b);
  }

  function splitValuesFor(segment, perpendicularIndex, collinearIndex) {
    const values = [segment.start, segment.end];
    const crossing = rangeQuery(perpendicularIndex, segment.start - splitToleranceMm, segment.end + splitToleranceMm);
    for (const other of crossing) {
      if (segment.fixed >= other.start - splitToleranceMm && segment.fixed <= other.end + splitToleranceMm) {
        values.push(other.fixed);
      }
    }
    const collinear = rangeQuery(collinearIndex, segment.fixed - splitToleranceMm, segment.fixed + splitToleranceMm);
    for (const other of collinear) {
      if (other === segment) continue;
      if (other.start > segment.start && other.start < segment.end) values.push(other.start);
      if (other.end > segment.start && other.end < segment.end) values.push(other.end);
    }
    return uniqueSplitValues(values);
  }

  for (const segment of horizontal) {
    if (edgeMap.size >= maxEdges) break;
    const values = splitValuesFor(segment, verticalByFixed, horizontalByFixed);
    for (let index = 0; index < values.length - 1; index += 1) addEdge("H", segment.fixed, values[index], values[index + 1], segment);
  }
  for (const segment of vertical) {
    if (edgeMap.size >= maxEdges) break;
    const values = splitValuesFor(segment, horizontalByFixed, verticalByFixed);
    for (let index = 0; index < values.length - 1; index += 1) addEdge("V", segment.fixed, values[index], values[index + 1], segment);
  }

  return [...edgeMap.values()].map((edge) => ({
    ...edge,
    types: [...edge.types],
    layers: [...edge.layers],
    lineTypes: [...edge.lineTypes],
    colors: [...edge.colors],
  }));
}

function buildPlanarCadGraph(entities, options = {}) {
  const segments = normalizeSegments(entities, options);
  const edges = buildElementaryEdges(segments, options);
  // Two edges meant to meet at the same corner rarely land on the exact same mm coordinate in a
  // real CAD drawing (drafting tolerance, rounding), so endpoints are snapped onto an existing
  // node within tolerance instead of requiring an exact match. Every edge here is axis-aligned
  // (H or V), so a genuine corner is always a crossing of DIFFERENT orientations, while the two
  // parallel faces of the same beam/wall are always the SAME orientation. That lets a same-
  // orientation merge stay tight (nodeMergeToleranceMm, well under any real member width) while a
  // cross-orientation corner merge can safely use a larger tolerance (cornerMergeToleranceMm)
  // without risking collapsing a real member's width down to a single point.
  const nodeMergeToleranceMm = Number(options.nodeMergeToleranceMm || 100);
  const cornerMergeToleranceMm = Number(options.cornerMergeToleranceMm || 280);
  const nodeBuckets = new Map();
  const cellSize = Math.max(nodeMergeToleranceMm, cornerMergeToleranceMm);
  const cellIndex = (value) => Math.floor(value / cellSize);

  function candidatesNear(x, y) {
    const baseX = cellIndex(x);
    const baseY = cellIndex(y);
    const found = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = nodeBuckets.get(`${baseX + dx}:${baseY + dy}`);
        if (bucket) found.push(...bucket);
      }
    }
    return found;
  }

  function node(x, y, orientation) {
    const candidates = candidatesNear(x, y);
    let tightBest = null;
    let tightBestDist = nodeMergeToleranceMm;
    let cornerBest = null;
    let cornerBestDist = cornerMergeToleranceMm;
    for (const candidate of candidates) {
      const dist = Math.hypot(candidate.x - x, candidate.y - y);
      if (dist <= tightBestDist) {
        tightBestDist = dist;
        tightBest = candidate;
      }
      const hasSameOrientation = candidate.orientations.has(orientation);
      if (!hasSameOrientation && dist <= cornerBestDist) {
        cornerBestDist = dist;
        cornerBest = candidate;
      }
    }
    const existing = tightBest || cornerBest;
    if (existing) {
      existing.orientations.add(orientation);
      return existing;
    }
    const created = { key: pointKey(x, y), x: Math.round(x), y: Math.round(y), out: [], orientations: new Set([orientation]) };
    const bucketKey = `${cellIndex(created.x)}:${cellIndex(created.y)}`;
    if (!nodeBuckets.has(bucketKey)) nodeBuckets.set(bucketKey, []);
    nodeBuckets.get(bucketKey).push(created);
    return created;
  }

  for (const edge of edges) {
    const a = node(edge.x1, edge.y1, edge.orientation);
    const b = node(edge.x2, edge.y2, edge.orientation);
    const angleAB = Math.atan2(b.y - a.y, b.x - a.x);
    const angleBA = Math.atan2(a.y - b.y, a.x - b.x);
    const ab = { edge, from: a, to: b, angle: angleAB };
    const ba = { edge, from: b, to: a, angle: angleBA };
    a.out.push(ab);
    b.out.push(ba);
  }

  const allNodes = [...nodeBuckets.values()].flat();
  for (const item of allNodes) item.out.sort((a, b) => a.angle - b.angle);
  return { nodes: allNodes, edges, segments };
}

function walkPlanarFaces(graph, options = {}) {
  const maxSteps = Number(options.maxSteps || 2000);
  const maxFaces = Number(options.maxFaces || 2500);
  const maxDirectedVisits = Number(options.maxDirectedVisits || 200000);
  const visited = new Set();
  const faces = [];
  let directedVisits = 0;

  for (const node of graph.nodes) {
    for (const start of node.out) {
      if (faces.length >= maxFaces || directedVisits >= maxDirectedVisits) return faces;
      const startKey = directedKey(start.from, start.to);
      if (visited.has(startKey)) continue;
      const polygon = [];
      const edgeTypes = new Set();
      const edgeLineTypes = new Set();
      const edgeColors = new Set();
      let current = start;
      let closed = false;

      for (let step = 0; step < maxSteps; step += 1) {
        const key = directedKey(current.from, current.to);
        if (visited.has(key) && key !== startKey) break;
        visited.add(key);
        directedVisits += 1;
        if (directedVisits >= maxDirectedVisits) break;
        polygon.push({ x: current.from.x, y: current.from.y });
        current.edge.types.forEach((type) => edgeTypes.add(type));
        current.edge.lineTypes?.forEach((lineType) => edgeLineTypes.add(lineType));
        current.edge.colors?.forEach((color) => edgeColors.add(color));

        const outgoing = current.to.out;
        const reverseIndex = outgoing.findIndex((candidate) => candidate.to.key === current.from.key);
        if (reverseIndex < 0 || outgoing.length <= 1) break;
        const nextIndex = (reverseIndex - 1 + outgoing.length) % outgoing.length;
        current = outgoing[nextIndex];
        if (current.from.key === start.from.key && current.to.key === start.to.key) {
          closed = true;
          break;
        }
      }

      if (closed && polygon.length >= 4) {
        const signedArea = polygonArea(polygon);
        faces.push({
          polygon,
          signedArea,
          areaMm2: Math.abs(signedArea),
          box: boxFromPoints(polygon),
          edgeTypes: [...edgeTypes],
          edgeLineTypes: [...edgeLineTypes],
          edgeColors: [...edgeColors],
        });
        if (faces.length >= maxFaces) return faces;
      }
    }
  }

  return faces;
}

function nearestGridBand(grid, box) {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const eIndex = grid.eAxes.findIndex((axis, index) => {
    const next = grid.eAxes[index + 1];
    return next && cx >= Math.min(axis.coordinate, next.coordinate) && cx <= Math.max(axis.coordinate, next.coordinate);
  });
  const hIndex = grid.hAxes.findIndex((axis, index) => {
    const next = grid.hAxes[index + 1];
    return next && cy <= Math.max(axis.coordinate, next.coordinate) && cy >= Math.min(axis.coordinate, next.coordinate);
  });
  const eBand = eIndex >= 0 ? `${grid.eAxes[eIndex].label}-${grid.eAxes[eIndex + 1].label}` : "outside E grid";
  const hBand = hIndex >= 0 ? `${grid.hAxes[hIndex].label}-${grid.hAxes[hIndex + 1].label}` : "outside H grid";
  return `${eBand}/${hBand}`;
}

function cutoutAreaForFace(face, cutouts) {
  const boundaryArea = cutouts.boundaryVoids.reduce((sum, cutout) => sum + overlapArea(face.box, cutout.box) / 1e6, 0);
  const textArea = cutouts.textVoids
    .filter((text) => pointInsideBox(text, face.box) || pointInsidePolygon(text, face.polygon))
    .reduce((sum, text) => sum + text.areaSqm, 0);
  return Math.max(boundaryArea, textArea);
}

function extractSlabMarks(entities) {
  return entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ text: cleanCadText(entity.text).toUpperCase(), x: entity.x, y: entity.y }))
    .filter((entity) => Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .filter((entity) => /^S\d+[A-Z]?$/.test(entity.text) || /SLAB/.test(entity.text));
}

function faceHasSlabMark(face, slabMarks) {
  return slabMarks.some((mark) => pointInsideBox(mark, face.box) && pointInsidePolygon(mark, face.polygon));
}

// A slab mark can fail to resolve for two very different reasons: (1) the primary drawing's own
// boundary lines genuinely don't close around it (a drafting or classification issue, worth more
// investigation), or (2) most of the nearby linework is xref-bound (an external reference we
// deliberately don't trust for quantities), so the real boundary simply isn't available in this
// file at all. Only the second case is a dead end - flag it distinctly so it reads as "measure this
// one manually" rather than a generic unresolved count that invites more (futile) debugging.
function xrefDependentUnresolvedMarks(entities, unresolvedMarks, options = {}) {
  const radiusMm = Number(options.radiusMm || 3000);
  const minXrefRatio = Number(options.minXrefRatio || 0.7);
  const maxNonXrefLines = Number(options.maxNonXrefLines || 12);
  const lines = entities.filter((entity) => entity.type === "LINE" &&
    Number.isFinite(entity.x) && Number.isFinite(entity.y) && Number.isFinite(entity.x2) && Number.isFinite(entity.y2));

  return unresolvedMarks.map((mark) => {
    const nearby = lines.filter((line) => {
      const midX = (line.x + line.x2) / 2;
      const midY = (line.y + line.y2) / 2;
      return Math.hypot(midX - mark.x, midY - mark.y) < radiusMm;
    });
    const xrefCount = nearby.filter((line) => isXrefEntity(line)).length;
    const nonXrefCount = nearby.length - xrefCount;
    const xrefRatio = nearby.length ? xrefCount / nearby.length : 0;
    const xrefDependent = nearby.length > 0 && xrefRatio >= minXrefRatio && nonXrefCount <= maxNonXrefLines;
    return {
      ...mark,
      xrefDependent,
      reason: xrefDependent
        ? "Boundary not resolvable from the primary drawing: nearby geometry is mostly xref-bound (external reference), which is excluded from quantity extraction. Measure this panel manually from the reference/architectural file."
        : "Slab mark did not resolve to a closed panel boundary in the primary drawing.",
    };
  });
}

function isLikelyStructuralBodyFace(face, slabMarks, options = {}) {
  if (faceHasSlabMark(face, slabMarks)) return false;
  const widthM = (face.box.maxX - face.box.minX) / 1000;
  const heightM = (face.box.maxY - face.box.minY) / 1000;
  const narrowM = Math.min(widthM, heightM);
  const longM = Math.max(widthM, heightM);
  const narrowLimitM = Number(options.narrowStructuralFaceM || 0.95);
  const smallBlockLimitM = Number(options.smallStructuralBlockM || 1.2);
  const onlyStructuralEdges = face.edgeTypes.length > 0 &&
    face.edgeTypes.every((type) => ["beam_face", "support_face"].includes(type));
  if (!onlyStructuralEdges) return false;
  if (widthM <= smallBlockLimitM && heightM <= smallBlockLimitM) return true;
  return narrowM <= narrowLimitM && longM >= Number(options.minStructuralStripLengthM || 1.2);
}

function beamEnclosureGates(face, slabMarks, options = {}) {
  const hasSlabMark = faceHasSlabMark(face, slabMarks);
  const hasBeamBoundary = face.edgeTypes.includes("beam_face");
  const hasSupportBoundary = face.edgeTypes.includes("support_face");
  const hasCutoutBoundary = face.edgeTypes.includes("cutout_boundary");
  const hasOnlyAllowedBoundaries = face.edgeTypes.every((type) => ["beam_face", "support_face", "cutout_boundary"].includes(type));
  const hasDashedEvidence = (face.edgeLineTypes || []).some((lineType) => /DASH|HIDDEN|CENTER|ACAD_ISO/i.test(String(lineType || "")));
  const requireBeamBoundary = options.requireBeamBoundary !== false;

  return {
    rule: "beam-enclosed-slab-panel",
    hasBeamBoundary,
    hasSupportBoundary,
    hasCutoutBoundary,
    hasOnlyAllowedBoundaries,
    hasDashedEvidence,
    hasSlabMark,
    passed: hasOnlyAllowedBoundaries && (!requireBeamBoundary || hasBeamBoundary || hasSlabMark),
  };
}

function shouldReviewSkippedSlabFace(face, supportBoxes, options = {}) {
  const widthM = (face.box.maxX - face.box.minX) / 1000;
  const heightM = (face.box.maxY - face.box.minY) / 1000;
  const areaSqm = face.areaMm2 / 1e6;
  if (areaSqm < Number(options.minAreaSqm || 4)) return false;
  if (widthM < Number(options.minDimensionM || 0.8) || heightM < Number(options.minDimensionM || 0.8)) return false;
  if (!face.edgeTypes.includes("beam_face")) return false;
  const supportOverlapSqm = supportBoxes.reduce((sum, support) => sum + overlapArea(face.box, support.box) / 1e6, 0);
  if (supportOverlapSqm / Math.max(areaSqm, 0.001) > Number(options.maxSupportOverlapRatio || 0.35)) return false;
  return true;
}

function makeSkippedSlabReviewRow(face, grid, reason) {
  const widthM = (face.box.maxX - face.box.minX) / 1000;
  const heightM = (face.box.maxY - face.box.minY) / 1000;
  const areaSqm = face.areaMm2 / 1e6;
  return {
    panel: `SR${Math.round(face.box.minX)}-${Math.round(face.box.minY)}`,
    gridBand: nearestGridBand(grid, face.box),
    lengthM: round3(widthM),
    breadthM: round3(heightM),
    thicknessM: DEFAULT_SLAB_THICKNESS_M,
    grossAreaSqm: round3(areaSqm),
    geometryAreaSqm: round3(areaSqm),
    cutoutAreaSqm: 0,
    netAreaSqm: round3(areaSqm),
    concreteCum: round3(areaSqm * DEFAULT_SLAB_THICKNESS_M),
    box: face.box,
    polygon: face.polygon,
    edgeTypes: face.edgeTypes,
    edgeLineTypes: face.edgeLineTypes || [],
    edgeColors: face.edgeColors || [],
    remarks: "possible missed slab panel",
    reason,
  };
}

function solveSlabPanelsByFaceWalking(entities, options = {}) {
  const graph = buildPlanarCadGraph(entities, options.graph || {});
  const faces = walkPlanarFaces(graph, options.walk || {});
  const grid = buildGridRegistry(entities);
  const supportBoxes = extractSupportBoxes(entities);
  const cutouts = extractCutoutVoids(entities);
  const dimensions = extractCadDimensions(entities);
  const slabMarks = extractSlabMarks(entities);
  const minAreaSqm = Number(options.minAreaSqm || 0.5);
  const minDimensionM = Number(options.minDimensionM || 0.45);
  const maxDimensionM = Number(options.maxDimensionM || 25);
  const thicknessM = Number(options.defaultThicknessM || DEFAULT_SLAB_THICKNESS_M);
  const review = [];
  const panels = [];

  const interiorFaces = faces
    .filter((face) => face.signedArea > 0)
    .sort((a, b) => a.areaMm2 - b.areaMm2);

  for (const face of interiorFaces) {
    const widthM = (face.box.maxX - face.box.minX) / 1000;
    const heightM = (face.box.maxY - face.box.minY) / 1000;
    const areaSqm = face.areaMm2 / 1e6;
    if (areaSqm < minAreaSqm || widthM < minDimensionM || heightM < minDimensionM || widthM > maxDimensionM || heightM > maxDimensionM) continue;
    const enclosureGates = beamEnclosureGates(face, slabMarks, options.beamEnclosure || {});
    if (!enclosureGates.passed) {
      if (shouldReviewSkippedSlabFace(face, supportBoxes, options.skippedFaceAudit || {})) {
        review.push(makeSkippedSlabReviewRow(face, grid, "Possible missed slab panel: failed beam enclosure gate."));
      }
      continue;
    }
    if (isLikelyStructuralBodyFace(face, slabMarks, options.structuralBodyFilter || {})) {
      if (shouldReviewSkippedSlabFace(face, supportBoxes, options.skippedFaceAudit || {})) {
        review.push(makeSkippedSlabReviewRow(face, grid, "Possible missed slab panel: filtered as structural body/narrow strip."));
      }
      continue;
    }

    const supportOverlapSqm = supportBoxes.reduce((sum, support) => sum + overlapArea(face.box, support.box) / 1e6, 0);
    if (supportOverlapSqm / Math.max(areaSqm, 0.001) > 0.65) {
      if (shouldReviewSkippedSlabFace(face, supportBoxes, options.skippedFaceAudit || {})) {
        review.push(makeSkippedSlabReviewRow(face, grid, "Possible missed slab panel: high support overlap."));
      }
      continue;
    }

    const cutoutAreaSqm = cutoutAreaForFace(face, cutouts);
    const dimensionAudit = validateBoxDimensions(face.box, dimensions, options.dimension || {});
    const effectiveWidthM = (dimensionAudit.effectiveLengthMm || (face.box.maxX - face.box.minX)) / 1000;
    const effectiveHeightM = (dimensionAudit.effectiveBreadthMm || (face.box.maxY - face.box.minY)) / 1000;
    const boxAreaSqm = effectiveWidthM * effectiveHeightM;
    const boxToPolygonRatio = boxAreaSqm / Math.max(areaSqm, 0.001);
    const maxBoxAreaRatio = Number(options.maxBoxAreaRatio || 1.08);
    const useBoxArea = dimensionAudit.hasBothDimensions && boxToPolygonRatio <= maxBoxAreaRatio;
    const effectiveAreaSqm = useBoxArea ? boxAreaSqm : areaSqm;
    const netAreaSqm = Math.max(0, effectiveAreaSqm - cutoutAreaSqm);
    const isIrregularShape = !useBoxArea && boxToPolygonRatio > maxBoxAreaRatio;
    // For a stepped/irregular boundary the bounding box overstates the true footprint, so a plain
    // width x height no longer multiplies out to the real area. Keep whichever axis is best-grounded
    // (a written CAD dimension, else the longer geometric extent) and derive the other axis from the
    // true polygon area so the two reported numbers stay consistent with netAreaSqm.
    let reportedLengthM = effectiveWidthM;
    let reportedBreadthM = effectiveHeightM;
    if (isIrregularShape) {
      const lengthIsAuthoritative = dimensionAudit.length.status === "cad_authoritative";
      const breadthIsAuthoritative = dimensionAudit.breadth.status === "cad_authoritative";
      const keepLength = lengthIsAuthoritative || (!breadthIsAuthoritative && widthM >= heightM);
      if (keepLength && effectiveWidthM > 0) {
        reportedLengthM = effectiveWidthM;
        reportedBreadthM = areaSqm / effectiveWidthM;
      } else if (effectiveHeightM > 0) {
        reportedBreadthM = effectiveHeightM;
        reportedLengthM = areaSqm / effectiveHeightM;
      }
    }
    const row = {
      panel: `TP${panels.length + 1}`,
      gridBand: nearestGridBand(grid, face.box),
      lengthM: round3(reportedLengthM),
      breadthM: round3(reportedBreadthM),
      thicknessM,
      geometryLengthM: round3(widthM),
      geometryBreadthM: round3(heightM),
      shapeType: isIrregularShape ? "irregular" : "rectangular",
      grossAreaSqm: round3(effectiveAreaSqm),
      boundingBoxAreaSqm: round3(boxAreaSqm),
      geometryAreaSqm: round3(areaSqm),
      boxToPolygonRatio: round3(boxToPolygonRatio),
      cutoutAreaSqm: round3(cutoutAreaSqm),
      netAreaSqm: round3(netAreaSqm),
      concreteCum: round3(netAreaSqm * thicknessM),
      box: face.box,
      polygon: face.polygon,
      edgeTypes: face.edgeTypes,
      edgeLineTypes: face.edgeLineTypes || [],
      edgeColors: face.edgeColors || [],
      validationGates: {
        beamEnclosure: enclosureGates,
        structuralBodyFilter: "passed",
        dimensionValidation: dimensionAudit.hasConflict ? "review" : "passed",
        cutoutDeduction: cutoutAreaSqm > 0 ? "deducted" : "not_applicable",
      },
      dimensionAudit,
      remarks: [
        "Beam-enclosed CAD topology face.",
        [dimensionAudit.length.status, dimensionAudit.breadth.status].includes("cad_authoritative") ? "CAD dimension used for panel size." : "",
        isIrregularShape ? "Irregular/stepped boundary; CAD polygon area used, and one reported dimension is an effective value derived from true area (bounding rectangle would overstate the panel)." : "",
        dimensionAudit.hasConflict ? "review needed: dimension conflict" : "",
        cutoutAreaSqm > 0 ? `cutout deducted ${round3(cutoutAreaSqm)} sqm` : "",
      ].filter(Boolean).join(" "),
    };

    if (dimensionAudit.hasConflict) review.push({ ...row, reason: "CAD dimension and closed face geometry disagree." });
    else panels.push(row);
  }

  const overlapGate = removeOverlappingSlabPanels(panels, options.overlapGate || {});
  const acceptedPanels = overlapGate.panels;
  const reviewCells = [...review, ...overlapGate.review];

  // extractSlabMarks also matches free-text mentions of "SLAB" (schedule notes, block labels) for
  // other callers' purposes; a reported "unresolved mark" should only ever be an actual mark like
  // S12/S21A, not a sentence that happens to contain the word slab.
  const unresolvedSlabMarks = slabMarks
    .filter((mark) => /^S\d+[A-Z]?$/.test(mark.text))
    .filter((mark) => !acceptedPanels.some((panel) => pointInsideBox(mark, panel.box) && pointInsidePolygon(mark, panel.polygon)));
  const unresolvedMarks = xrefDependentUnresolvedMarks(entities, unresolvedSlabMarks, options.unresolvedMarks || {});

  return {
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      rawSegments: graph.segments.length,
      faces: faces.length,
      interiorFaces: interiorFaces.length,
    },
    panels: acceptedPanels,
    reviewCells,
    unresolvedMarks,
    totals: {
      directPanels: acceptedPanels.length,
      inferredPanels: 0,
      reviewCells: reviewCells.length,
      slabShutteringSqm: round3(acceptedPanels.reduce((sum, panel) => sum + panel.netAreaSqm, 0)),
      slabConcreteCum: round3(acceptedPanels.reduce((sum, panel) => sum + panel.concreteCum, 0)),
      cutoutDeductionSqm: round3(acceptedPanels.reduce((sum, panel) => sum + panel.cutoutAreaSqm, 0)),
      reviewAreaSqm: round3(reviewCells.reduce((sum, cell) => sum + cell.grossAreaSqm, 0)),
      unresolvedMarks: unresolvedMarks.length,
      xrefDependentUnresolvedMarks: unresolvedMarks.filter((mark) => mark.xrefDependent).length,
    },
  };
}

function findFaceContainingPoint(faces, point) {
  return faces.find((face) => pointInsideBox(point, face.box) && pointInsidePolygon(point, face.polygon)) || null;
}

module.exports = {
  pointInsidePolygon,
  buildPlanarCadGraph,
  walkPlanarFaces,
  solveSlabPanelsByFaceWalking,
  findFaceContainingPoint,
};
