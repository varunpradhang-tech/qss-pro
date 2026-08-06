"use strict";
const { cleanCadText } = require("../cad/dxf-reader.js");
const { analyzeDrawingRoute } = require("../cad/route-engine.js");
const { solveSlabPanelsByFaceWalking } = require("../topology/face-walker.js");
const {
  buildGridRegistry,
  extractBoundarySegments,
  extractCutoutVoids,
  extractSupportBoxes,
  solveBoundarySlabPanels,
  stitchBoundarySegments,
} = require("../topology/boundary-graph.js");

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, precision = 1) {
  const factor = 10 ** precision;
  return Math.round(Number(value || 0) * factor) / factor;
}

const MAX_CAD_BOUNDARY_TOLERANCE_MM = 25;

function strictCadBoundaryTolerance(value, fallbackMm = MAX_CAD_BOUNDARY_TOLERANCE_MM) {
  const parsed = Number(value);
  const fallback = Number(fallbackMm);
  const raw = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : Number.isFinite(fallback) && fallback > 0
      ? fallback
      : MAX_CAD_BOUNDARY_TOLERANCE_MM;
  return Math.min(raw, MAX_CAD_BOUNDARY_TOLERANCE_MM);
}

function parseBeamSize(text) {
  const match = String(text || "")
    .replace(/\s+/g, "")
    .match(/(?:BEAM|B)?\(?(\d{2,4})(?:\/\d{2,4})?[Xx](\d{2,4})\)?/i);
  if (!match) return null;
  return {
    widthMm: Number(match[1]),
    depthMm: Number(match[2]),
    label: `${Number(match[1])}x${Number(match[2])}`,
  };
}

function normalizeAngle(rotation = 0) {
  return ((Number(rotation || 0) % 180) + 180) % 180;
}

function textOrientation(entity) {
  const angle = normalizeAngle(entity.rotation);
  return angle > 45 && angle < 135 ? "V" : "H";
}

function gridIndexForPoint(grid, point) {
  const eIndex = grid.eAxes.findIndex((axis, index) => {
    const next = grid.eAxes[index + 1];
    return next && point.x >= Math.min(axis.coordinate, next.coordinate) && point.x <= Math.max(axis.coordinate, next.coordinate);
  });
  const hIndex = grid.hAxes.findIndex((axis, index) => {
    const next = grid.hAxes[index + 1];
    return next && point.y <= Math.max(axis.coordinate, next.coordinate) && point.y >= Math.min(axis.coordinate, next.coordinate);
  });
  return { eIndex, hIndex };
}

function nearestGridBand(grid, point) {
  const eIndex = grid.eAxes.findIndex((axis, index) => {
    const next = grid.eAxes[index + 1];
    return next && point.x >= Math.min(axis.coordinate, next.coordinate) && point.x <= Math.max(axis.coordinate, next.coordinate);
  });
  const hIndex = grid.hAxes.findIndex((axis, index) => {
    const next = grid.hAxes[index + 1];
    return next && point.y <= Math.max(axis.coordinate, next.coordinate) && point.y >= Math.min(axis.coordinate, next.coordinate);
  });
  const eBand = eIndex >= 0 ? `${grid.eAxes[eIndex].label}-${grid.eAxes[eIndex + 1].label}` : "outside E grid";
  const hBand = hIndex >= 0 ? `${grid.hAxes[hIndex].label}-${grid.hAxes[hIndex + 1].label}` : "outside H grid";
  return `${eBand}/${hBand}`;
}

function pointInBox(point, box) {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function entityReferencePoint(entity) {
  if (Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
    if (Number.isFinite(entity.x2) && Number.isFinite(entity.y2)) {
      return { x: (entity.x + entity.x2) / 2, y: (entity.y + entity.y2) / 2 };
    }
    return { x: entity.x, y: entity.y };
  }
  if (Array.isArray(entity.vertices) && entity.vertices.length) {
    const points = entity.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length) {
      return {
        x: median(points.map((point) => point.x)),
        y: median(points.map((point) => point.y)),
      };
    }
  }
  return null;
}

function pointInsideRegion(point, region, marginMm = 0) {
  if (!point || !region) return false;
  return point.x >= Number(region.minX) - marginMm &&
    point.x <= Number(region.maxX) + marginMm &&
    point.y >= Number(region.minY) - marginMm &&
    point.y <= Number(region.maxY) + marginMm;
}

function entityInsideRegion(entity, region, marginMm = 2500) {
  if (!region) return true;
  const point = entityReferencePoint(entity);
  return point ? pointInsideRegion(point, region, marginMm) : false;
}

function pointInAnyZone(point, zones = []) {
  return zones.some((zone) => pointInBox(point, zone));
}

function isSectionDetailPoint(point, zones = [], grid) {
  return pointInAnyZone(point, zones) && !insideGridWindow(grid, point, {
    horizontalMarginMm: 1200,
    verticalMarginMm: 1200,
  });
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function boxOverlapArea(a, b) {
  return overlap1d(a.minX, a.maxX, b.minX, b.maxX) * overlap1d(a.minY, a.maxY, b.minY, b.maxY);
}

function boxArea(box) {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function insideGridWindow(grid, point, options = {}) {
  if (!grid.eAxes?.length || !grid.hAxes?.length) return true;
  const horizontalMarginMm = Number(options.horizontalMarginMm || 9000);
  const verticalMarginMm = Number(options.verticalMarginMm || 6500);
  const minX = Math.min(...grid.eAxes.map((axis) => axis.coordinate)) - horizontalMarginMm;
  const maxX = Math.max(...grid.eAxes.map((axis) => axis.coordinate)) + horizontalMarginMm;
  const minY = Math.min(...grid.hAxes.map((axis) => axis.coordinate)) - verticalMarginMm;
  const maxY = Math.max(...grid.hAxes.map((axis) => axis.coordinate)) + verticalMarginMm;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

function isSectionDetailEntity(entity, zones = [], grid) {
  const point = entityReferencePoint(entity);
  return point ? isSectionDetailPoint(point, zones, grid) : false;
}

function buildSectionDetailExclusionZones(entities, options = {}) {
  const halfWidthMm = Number(options.halfWidthMm || 52000);
  const belowMm = Number(options.belowMm || 9000);
  const aboveMm = Number(options.aboveMm || 34000);
  return entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ text: cleanCadText(entity.text), x: entity.x, y: entity.y, layer: entity.layer }))
    .filter((entity) => /^section\s*\d+/i.test(entity.text) && Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .map((entity) => ({
      label: entity.text,
      minX: entity.x - halfWidthMm,
      maxX: entity.x + halfWidthMm,
      minY: entity.y - belowMm,
      maxY: entity.y + aboveMm,
    }));
}

function sortMarksTopLeft(marks, grid) {
  return [...marks].sort((a, b) => {
    const ai = gridIndexForPoint(grid, a);
    const bi = gridIndexForPoint(grid, b);
    const ah = ai.hIndex >= 0 ? ai.hIndex : 100000 - Math.round(a.y / 1000);
    const bh = bi.hIndex >= 0 ? bi.hIndex : 100000 - Math.round(b.y / 1000);
    if (ah !== bh) return ah - bh;
    const ae = ai.eIndex >= 0 ? ai.eIndex : 100000 + Math.round(a.x / 1000);
    const be = bi.eIndex >= 0 ? bi.eIndex : 100000 + Math.round(b.x / 1000);
    if (ae !== be) return ae - be;
    if (Math.abs(a.x - b.x) > 100) return a.x - b.x;
    return b.y - a.y;
  });
}

function extractManualPanelLeftMarks(correctionEntities = [], existingMarks = [], grid) {
  const raw = correctionEntities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ text: cleanCadText(entity.text), x: entity.x, y: entity.y, layer: entity.layer }))
    .filter((entity) => /^panel\s+left$/i.test(entity.text) && Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .filter((entity) => insideGridWindow(grid, entity, { horizontalMarginMm: 12000, verticalMarginMm: 9000 }));

  const clusters = [];
  for (const mark of raw) {
    const duplicate = clusters.find((cluster) => Math.hypot(cluster.x - mark.x, cluster.y - mark.y) <= 650);
    if (duplicate) {
      duplicate.items.push(mark);
      duplicate.x = median(duplicate.items.map((item) => item.x));
      duplicate.y = median(duplicate.items.map((item) => item.y));
      continue;
    }
    clusters.push({ x: mark.x, y: mark.y, items: [mark] });
  }

  return clusters
    .filter((mark) => !existingMarks.some((existing) => Math.hypot(existing.x - mark.x, existing.y - mark.y) <= 900))
    .map((mark) => ({
      x: mark.x,
      y: mark.y,
      gridBand: nearestGridBand(grid, mark),
      areaSqm: null,
      status: "user-panel-left-readback",
      source: "Panel Left mark from reviewed DWG",
    }));
}

function extractExistingReferencePanelMarks(correctionEntities = [], grid) {
  const raw = correctionEntities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ text: cleanCadText(entity.text), x: entity.x, y: entity.y, layer: entity.layer }))
    .filter((entity) => /^P\d+$/i.test(entity.text) && Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .filter((entity) => insideGridWindow(grid, entity, { horizontalMarginMm: 12000, verticalMarginMm: 9000 }));

  const clusters = [];
  for (const mark of raw) {
    const normalizedId = mark.text.toUpperCase();
    const duplicate = clusters.find((cluster) =>
      cluster.originalId === normalizedId ||
      Math.hypot(cluster.x - mark.x, cluster.y - mark.y) <= 650);
    if (duplicate) {
      duplicate.items.push(mark);
      duplicate.x = median(duplicate.items.map((item) => item.x));
      duplicate.y = median(duplicate.items.map((item) => item.y));
      continue;
    }
    clusters.push({ x: mark.x, y: mark.y, originalId: normalizedId, items: [mark] });
  }

  return clusters.map((mark) => ({
    originalId: mark.originalId,
    existingReferenceMark: true,
    x: mark.x,
    y: mark.y,
    gridBand: nearestGridBand(grid, mark),
    areaSqm: null,
    status: "existing-reference-p-readback",
    source: "Existing P mark from reviewed DWG",
  }));
}

function mergePanelSeeds(seeds, duplicateToleranceMm = 900) {
  const merged = [];
  for (const seed of seeds) {
    const duplicate = merged.find((item) =>
      (item.originalId && seed.originalId && item.originalId === seed.originalId) ||
      Math.hypot(item.x - seed.x, item.y - seed.y) <= duplicateToleranceMm);
    if (!duplicate) {
      merged.push({ ...seed });
      continue;
    }
    if (!duplicate.originalId && seed.originalId) duplicate.originalId = seed.originalId;
    duplicate.existingReferenceMark = Boolean(duplicate.existingReferenceMark || seed.existingReferenceMark);
    duplicate.sources = [...new Set([...(duplicate.sources || [duplicate.source || duplicate.status]), seed.source || seed.status].filter(Boolean))];
    if (!Number.isFinite(duplicate.areaSqm) && Number.isFinite(seed.areaSqm)) duplicate.areaSqm = seed.areaSqm;
  }
  return merged;
}

function panelBox(seed) {
  return seed.box || null;
}

function hasHeavyOverlapWithExisting(seed, existing, ratio = 0.55) {
  const box = panelBox(seed);
  if (!box) return false;
  return existing.some((item) => {
    const other = panelBox(item);
    if (!other) return false;
    const overlap = boxOverlapArea(box, other);
    if (!overlap) return false;
    return overlap / Math.max(Math.min(boxArea(box), boxArea(other)), 1) >= ratio;
  });
}

function sanitizePanelSeedsBeforeNumbering(seeds, grid, options = {}) {
  const minAreaSqm = Number(options.minAreaSqm || 0.7);
  const maxAreaSqm = Number(options.maxAreaSqm || 260);
  const duplicateOverlapRatio = Number(options.duplicateOverlapRatio || 0.35);
  const containOverlapRatio = Number(options.containOverlapRatio || 0.82);

  const valid = seeds
    .filter((seed) => seed?.box)
    .map((seed) => {
      const areaMm2 = boxArea(seed.box);
      const areaSqm = areaMm2 / 1e6;
      const center = {
        x: (seed.box.minX + seed.box.maxX) / 2,
        y: (seed.box.minY + seed.box.maxY) / 2,
      };
      return {
        ...seed,
        x: center.x,
        y: center.y,
        areaSqm,
      };
    })
    .filter((seed) => {
      const widthMm = seed.box.maxX - seed.box.minX;
      const heightMm = seed.box.maxY - seed.box.minY;
      if (widthMm <= 0 || heightMm <= 0) return false;
      if (seed.areaSqm < minAreaSqm || seed.areaSqm > maxAreaSqm) return false;
      if (/cutout|open.to.sky|shaft|void/i.test(String(seed.status || ""))) return false;
      return true;
    })
    .sort((a, b) => {
      const aReview = /review/i.test(String(a.status || "")) ? 1 : 0;
      const bReview = /review/i.test(String(b.status || "")) ? 1 : 0;
      return aReview - bReview || b.areaSqm - a.areaSqm;
    });

  const accepted = [];

  for (const seed of valid) {
    let overlapsExisting = false;

    for (const existing of accepted) {
      const overlap = boxOverlapArea(seed.box, existing.box);
      if (!overlap) continue;

      const smallerArea = Math.max(Math.min(boxArea(seed.box), boxArea(existing.box)), 1);
      const largerArea = Math.max(Math.max(boxArea(seed.box), boxArea(existing.box)), 1);
      const smallerOverlapRatio = overlap / smallerArea;
      const largerOverlapRatio = overlap / largerArea;

      if (
        smallerOverlapRatio >= containOverlapRatio ||
        largerOverlapRatio >= duplicateOverlapRatio
      ) {
        overlapsExisting = true;
        break;
      }
    }

    if (!overlapsExisting) accepted.push(seed);
  }

  return sortMarksTopLeft(accepted, grid);
}

function assignPanelIds(panelSeeds, grid) {
  const sorted = sortMarksTopLeft(panelSeeds, grid);
  const used = new Set(
    sorted
      .map((panel) => panel.originalId)
      .filter(Boolean)
      .map((id) => id.toUpperCase()),
  );
  let next = 1;
  function nextPanelId() {
    while (used.has(`P${next}`)) next += 1;
    const id = `P${next}`;
    used.add(id);
    next += 1;
    return id;
  }
  return sorted.map((panel) => {
    const id = panel.originalId ? panel.originalId.toUpperCase() : nextPanelId();
    return {
      ...panel,
      id,
      label: id,
      x: round(panel.x, 3),
      y: round(panel.y, 3),
    };
  });
}

function strictBoundaryPanelSeeds(slab, entities) {
  const slabMarks = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({
      text: cleanCadText(entity.text).toUpperCase().replace(/\s+/g, ""),
      x: Number(entity.x),
      y: Number(entity.y),
    }))
    .filter((entity) => /^S\d+[A-Z]?$/.test(entity.text) && Number.isFinite(entity.x) && Number.isFinite(entity.y));

  return (slab.panels || [])
    .filter((panel) => panel?.box)
    .map((panel) => {
      const marksInside = slabMarks.filter((mark) =>
        mark.x > panel.box.minX + 80 &&
        mark.x < panel.box.maxX - 80 &&
        mark.y > panel.box.minY + 80 &&
        mark.y < panel.box.maxY - 80);
      const center = {
        x: (panel.box.minX + panel.box.maxX) / 2,
        y: (panel.box.minY + panel.box.maxY) / 2,
      };
      const nearestMark = marksInside.length
        ? marksInside
            .map((mark) => ({ mark, distance: Math.hypot(mark.x - center.x, mark.y - center.y) }))
            .sort((a, b) => a.distance - b.distance)[0].mark
        : null;
      return {
        box: panel.box,
        x: center.x,
        y: center.y,
        gridBand: panel.gridBand || "",
        status: "verified-boundary-panel",
        source: "strict-boundary-slab-cell",
        coverage: panel.coverage || null,
        slabMark: nearestMark?.text || "",
        slabMarkX: nearestMark?.x ?? null,
        slabMarkY: nearestMark?.y ?? null,
        slabMarksInside: marksInside.map((mark) => mark.text),
        slabMarksInsideCount: marksInside.length,
        areaSqm: panel.netAreaSqm || panel.grossAreaSqm || 0,
      };
    });
}

function beamSizeTexts(entities, grid) {
  return entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ text: cleanCadText(entity.text), x: entity.x, y: entity.y, layer: entity.layer }))
    .filter((entity) => /\b(?:BEAM|B)\s*\(?\s*\d{2,4}(?:\/\d{2,4})?\s*[Xx]\s*\d{2,4}\s*\)?/i.test(entity.text))
    .map((entity, index) => ({
      id: `QB${index + 1}`,
      label: `QB${index + 1} ${entity.text}`,
      sizeText: entity.text,
      x: entity.x,
      y: entity.y,
      gridBand: nearestGridBand(grid, entity),
      status: "review-run-length",
      remarks: "Auto beam ID from size text; run length must be built from grid/support faces before billing.",
    }));
}

function intervalFromBoundary(boundary) {
  if (boundary.orientation === "H") {
    return {
      type: boundary.type,
      edgeStyle: boundary.edgeStyle || "",
      layer: boundary.layer || "",
      orientation: "H",
      fixed: (boundary.y1 + boundary.y2) / 2,
      start: Math.min(boundary.x1, boundary.x2),
      end: Math.max(boundary.x1, boundary.x2),
      lengthMm: boundary.lengthMm,
    };
  }
  if (boundary.orientation === "V") {
    return {
      type: boundary.type,
      edgeStyle: boundary.edgeStyle || "",
      layer: boundary.layer || "",
      orientation: "V",
      fixed: (boundary.x1 + boundary.x2) / 2,
      start: Math.min(boundary.y1, boundary.y2),
      end: Math.max(boundary.y1, boundary.y2),
      lengthMm: boundary.lengthMm,
    };
  }
  return null;
}

function supportBoxFaceIntervals(supportBoxes) {
  const rows = [];
  for (const support of supportBoxes) {
    const box = support.box;
    rows.push(
      { type: "support_face", orientation: "H", fixed: box.minY, start: box.minX, end: box.maxX, lengthMm: box.maxX - box.minX },
      { type: "support_face", orientation: "H", fixed: box.maxY, start: box.minX, end: box.maxX, lengthMm: box.maxX - box.minX },
      { type: "support_face", orientation: "V", fixed: box.minX, start: box.minY, end: box.maxY, lengthMm: box.maxY - box.minY },
      { type: "support_face", orientation: "V", fixed: box.maxX, start: box.minY, end: box.maxY, lengthMm: box.maxY - box.minY },
    );
  }
  return rows;
}

function uniqueCoordinates(values, toleranceMm = MAX_CAD_BOUNDARY_TOLERANCE_MM) {
  const coordinateToleranceMm = strictCadBoundaryTolerance(toleranceMm);
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];
  for (const value of sorted) {
    const last = clusters.at(-1);
    if (!last || Math.abs(value - median(last)) > coordinateToleranceMm) clusters.push([value]);
    else last.push(value);
  }
  return clusters.map((cluster) => median(cluster)).sort((a, b) => a - b);
}

function coveredLength(intervals, start, end) {
  const clipped = intervals
    .map((item) => ({ start: Math.max(item.start, start), end: Math.min(item.end, end) }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current = null;
  for (const item of clipped) {
    if (!current) current = { ...item };
    else if (item.start <= current.end + 120) current.end = Math.max(current.end, item.end);
    else {
      total += current.end - current.start;
      current = { ...item };
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function boundaryCoverageForBox(boundaries, side, box, toleranceMm = MAX_CAD_BOUNDARY_TOLERANCE_MM) {
  const boundaryToleranceMm = strictCadBoundaryTolerance(toleranceMm);
  if (side === "top" || side === "bottom") {
    const y = side === "top" ? box.maxY : box.minY;
    const intervals = boundaries
      .filter((item) => item.orientation === "H" && Math.abs(item.fixed - y) <= boundaryToleranceMm)
      .map((item) => ({ start: item.start, end: item.end }));
    return coveredLength(intervals, box.minX, box.maxX) / Math.max(box.maxX - box.minX, 1);
  }
  const x = side === "left" ? box.minX : box.maxX;
  const intervals = boundaries
    .filter((item) => item.orientation === "V" && Math.abs(item.fixed - x) <= boundaryToleranceMm)
    .map((item) => ({ start: item.start, end: item.end }));
  return coveredLength(intervals, box.minY, box.maxY) / Math.max(box.maxY - box.minY, 1);
}

function slabBoundaryCoverageForBox(boundaries, side, box, toleranceMm = MAX_CAD_BOUNDARY_TOLERANCE_MM) {
  return boundaryCoverageForBox(boundaries.filter(isReliableSlabPanelBoundary), side, box, toleranceMm);
}

function slabPanelBoundaryPriority(boundary) {
  const type = String(boundary?.type || "");
  const edgeStyle = String(boundary?.edgeStyle || "");
  if (type === "dotted_chain_face") return 0;
  if (type === "support_face" || type === "cutout_boundary") return 1;
  if (type === "beam_face" && /dotted|dash/i.test(edgeStyle)) return 2;
  return 99;
}

function isReliableSlabPanelBoundary(boundary) {
  return slabPanelBoundaryPriority(boundary) < 99;
}

function boundarySideCoverage(boundary, side, box) {
  const verticalSide = side === "left" || side === "right";
  const spanStart = verticalSide ? box.minY : box.minX;
  const spanEnd = verticalSide ? box.maxY : box.maxX;
  return overlap1d(boundary.start, boundary.end, spanStart, spanEnd) / Math.max(spanEnd - spanStart, 1);
}

function nearestInnerBoundaryForPanelSide(point, box, boundaries, side, options = {}) {
  const verticalSide = side === "left" || side === "right";
  const orientation = verticalSide ? "V" : "H";
  const pointFixed = verticalSide ? point.x : point.y;
  const sideFixed = side === "left"
    ? box.minX
    : side === "right"
    ? box.maxX
    : side === "bottom"
    ? box.minY
    : box.maxY;
  const sideToleranceMm = strictCadBoundaryTolerance(options.sideToleranceMm);
  const minCoverage = Number(options.minInnerFaceCoverage || 0.72);
  const minFixed = Math.min(pointFixed, sideFixed) - sideToleranceMm;
  const maxFixed = Math.max(pointFixed, sideFixed) + sideToleranceMm;
  const sideSpanStart = verticalSide ? box.minY : box.minX;
  const sideSpanEnd = verticalSide ? box.maxY : box.maxX;
  const groups = [];
  for (const boundary of boundaries
    .filter((boundary) => boundary.orientation === orientation)
    .filter((boundary) => boundary.fixed >= minFixed && boundary.fixed <= maxFixed)
    .filter(isReliableSlabPanelBoundary)
    .filter((boundary) => {
      if (side === "left" || side === "bottom") return boundary.fixed < pointFixed;
      return boundary.fixed > pointFixed;
    })) {
    const group = groups.find((item) => Math.abs(item.fixed - boundary.fixed) <= sideToleranceMm);
    if (group) {
      group.boundaries.push(boundary);
      group.fixed = median(group.boundaries.map((item) => item.fixed));
    } else {
      groups.push({ fixed: boundary.fixed, boundaries: [boundary] });
    }
  }
  return groups
    .map((group) => {
      const intervals = group.boundaries.map((boundary) => ({ start: boundary.start, end: boundary.end }));
      const coverage = coveredLength(intervals, sideSpanStart, sideSpanEnd) / Math.max(sideSpanEnd - sideSpanStart, 1);
      const priority = Math.min(...group.boundaries.map(slabPanelBoundaryPriority));
      const boundary = group.boundaries.slice().sort((a, b) =>
        slabPanelBoundaryPriority(a) - slabPanelBoundaryPriority(b) ||
        boundarySideCoverage(b, side, box) - boundarySideCoverage(a, side, box))[0];
      return {
        boundary: { ...boundary, fixed: group.fixed },
        coverage,
        priority,
        distance: Math.abs(group.fixed - pointFixed),
        boundaryCount: group.boundaries.length,
      };
    })
    .filter((candidate) => candidate.coverage >= minCoverage)
    .sort((a, b) => a.distance - b.distance || a.priority - b.priority || b.coverage - a.coverage)[0] || null;
}

function snapBoxToInnerBoundaryFaces(point, box, boundaries, options = {}) {
  if (!point || !box) return null;
  const minimumClearanceMm = Number(options.minimumClearanceMm || 80);
  const snapped = { ...box };
  const sides = {};
  for (const side of ["left", "right", "bottom", "top"]) {
    const match = nearestInnerBoundaryForPanelSide(point, box, boundaries, side, options);
    if (!match) return null;
    sides[side] = {
      type: match.boundary.type,
      fixed: round(match.boundary.fixed, 0),
      coverage: round(match.coverage, 3),
    };
    if (side === "left") snapped.minX = match.boundary.fixed;
    else if (side === "right") snapped.maxX = match.boundary.fixed;
    else if (side === "bottom") snapped.minY = match.boundary.fixed;
    else snapped.maxY = match.boundary.fixed;
  }
  if (snapped.maxX <= snapped.minX || snapped.maxY <= snapped.minY) return null;
  if (
    point.x <= snapped.minX + minimumClearanceMm ||
    point.x >= snapped.maxX - minimumClearanceMm ||
    point.y <= snapped.minY + minimumClearanceMm ||
    point.y >= snapped.maxY - minimumClearanceMm
  ) {
    return null;
  }
  return { box: snapped, sides };
}

function inferBoundaryBoxForPoint(point, boundaries, options = {}) {
  const maxSearchMm = Number(options.maxSearchMm || 16000);
  const coverToleranceMm = strictCadBoundaryTolerance(options.coverToleranceMm);
  const minSideCoverage = Number(options.minSideCoverage || 0.28);

  function vertical(side) {
    return boundaries
      .filter((item) => item.orientation === "V")
      .filter((item) => side === "left" ? item.fixed < point.x : item.fixed > point.x)
      .filter((item) => Math.abs(item.fixed - point.x) <= maxSearchMm)
      .filter((item) => point.y >= item.start - coverToleranceMm && point.y <= item.end + coverToleranceMm)
      .map((item) => ({ item, distance: Math.abs(item.fixed - point.x) }))
      .sort((a, b) => a.distance - b.distance)[0]?.item || null;
  }

  function horizontal(side) {
    return boundaries
      .filter((item) => item.orientation === "H")
      .filter((item) => side === "bottom" ? item.fixed < point.y : item.fixed > point.y)
      .filter((item) => Math.abs(item.fixed - point.y) <= maxSearchMm)
      .filter((item) => point.x >= item.start - coverToleranceMm && point.x <= item.end + coverToleranceMm)
      .map((item) => ({ item, distance: Math.abs(item.fixed - point.y) }))
      .sort((a, b) => a.distance - b.distance)[0]?.item || null;
  }

  const left = vertical("left");
  const right = vertical("right");
  const bottom = horizontal("bottom");
  const top = horizontal("top");
  if (!left || !right || !bottom || !top) return null;
  const box = {
    minX: Math.min(left.fixed, right.fixed),
    maxX: Math.max(left.fixed, right.fixed),
    minY: Math.min(bottom.fixed, top.fixed),
    maxY: Math.max(bottom.fixed, top.fixed),
  };
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const widthM = width / 1000;
  const heightM = height / 1000;
  const areaSqm = (width * height) / 1e6;
  if (widthM < Number(options.minDimensionM || 1.35) || heightM < Number(options.minDimensionM || 1.35)) return null;
  if (widthM > Number(options.maxDimensionM || 18) || heightM > Number(options.maxDimensionM || 18)) return null;
  if (areaSqm < Number(options.minAreaSqm || 0.75) || areaSqm > Number(options.maxAreaSqm || 95)) return null;

  const coverage = {
    top: boundaryCoverageForBox(boundaries, "top", box, coverToleranceMm),
    bottom: boundaryCoverageForBox(boundaries, "bottom", box, coverToleranceMm),
    left: boundaryCoverageForBox(boundaries, "left", box, coverToleranceMm),
    right: boundaryCoverageForBox(boundaries, "right", box, coverToleranceMm),
  };
  const weakest = Math.min(coverage.top, coverage.bottom, coverage.left, coverage.right);
  if (weakest < minSideCoverage) return null;

  return {
    box,
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    areaSqm,
    coverage,
    boundaryTypes: {
      left: left.type,
      right: right.type,
      top: top.type,
      bottom: bottom.type,
    },
  };
}

function axisCoverage(boundaries, orientation, fixed, start, end, toleranceMm = MAX_CAD_BOUNDARY_TOLERANCE_MM) {
  const boundaryToleranceMm = strictCadBoundaryTolerance(toleranceMm);
  const intervals = boundaries
    .filter((item) => item.orientation === orientation && Math.abs(item.fixed - fixed) <= boundaryToleranceMm)
    .map((item) => ({ start: item.start, end: item.end }));
  return coveredLength(intervals, start, end) / Math.max(end - start, 1);
}

function splitBoundaryBoxAroundPoint(point, box, boundaries, options = {}) {
  const axisToleranceMm = strictCadBoundaryTolerance(options.axisToleranceMm);
  const minCoverage = Number(options.minSplitCoverage || 0.22);
  const edgeInsetMm = Number(options.edgeInsetMm || 180);
  const minDimensionMm = Number(options.minDimensionMm || 420);
  const verticalAxes = uniqueCoordinates(
    boundaries
      .filter((item) => item.orientation === "V")
      .map((item) => item.fixed)
      .filter((fixed) => fixed > box.minX + edgeInsetMm && fixed < box.maxX - edgeInsetMm),
    strictCadBoundaryTolerance(options.axisClusterToleranceMm),
  )
    .filter((fixed) => axisCoverage(boundaries, "V", fixed, box.minY, box.maxY, axisToleranceMm) >= minCoverage);
  const horizontalAxes = uniqueCoordinates(
    boundaries
      .filter((item) => item.orientation === "H")
      .map((item) => item.fixed)
      .filter((fixed) => fixed > box.minY + edgeInsetMm && fixed < box.maxY - edgeInsetMm),
    strictCadBoundaryTolerance(options.axisClusterToleranceMm),
  )
    .filter((fixed) => axisCoverage(boundaries, "H", fixed, box.minX, box.maxX, axisToleranceMm) >= minCoverage);
  if (!verticalAxes.length && !horizontalAxes.length) return null;

  const xAxes = [box.minX, ...verticalAxes, box.maxX].sort((a, b) => a - b);
  const yAxes = [box.minY, ...horizontalAxes, box.maxY].sort((a, b) => a - b);
  const xIndex = xAxes.findIndex((axis, index) => xAxes[index + 1] && point.x > axis && point.x < xAxes[index + 1]);
  const yIndex = yAxes.findIndex((axis, index) => yAxes[index + 1] && point.y > axis && point.y < yAxes[index + 1]);
  if (xIndex < 0 || yIndex < 0) return null;
  const cell = {
    minX: xAxes[xIndex],
    maxX: xAxes[xIndex + 1],
    minY: yAxes[yIndex],
    maxY: yAxes[yIndex + 1],
  };
  if (cell.maxX - cell.minX < minDimensionMm || cell.maxY - cell.minY < minDimensionMm) return null;
  return {
    box: cell,
    splitAxes: {
      vertical: verticalAxes.map((value) => round(value, 0)),
      horizontal: horizontalAxes.map((value) => round(value, 0)),
    },
  };
}

function splitBoxBySlabMarkMidlines(point, box, slabMarks = [], options = {}) {
  if (!box) return null;
  const paddingMm = Number(options.paddingMm || 80);
  const minGapMm = Number(options.minMarkGapMm || 650);
  const minDimensionMm = Number(options.minDimensionMm || 420);
  const marksInside = slabMarks
    .filter((mark) =>
      Number.isFinite(mark.x) &&
      Number.isFinite(mark.y) &&
      mark.x > box.minX + paddingMm &&
      mark.x < box.maxX - paddingMm &&
      mark.y > box.minY + paddingMm &&
      mark.y < box.maxY - paddingMm)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (marksInside.length <= 1) return null;

  const clusterAxis = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const clusters = [];
    for (const value of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last.values[last.values.length - 1] - value) <= minGapMm) {
        last.values.push(value);
      } else {
        clusters.push({ values: [value] });
      }
    }
    return clusters.map((cluster) =>
      cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length);
  };

  const xClusters = clusterAxis(marksInside.map((mark) => mark.x));
  const yClusters = clusterAxis(marksInside.map((mark) => mark.y));
  const xCuts = [];
  const yCuts = [];
  for (let index = 0; index < xClusters.length - 1; index += 1) {
    const cut = (xClusters[index] + xClusters[index + 1]) / 2;
    if (cut - box.minX >= minDimensionMm && box.maxX - cut >= minDimensionMm) xCuts.push(cut);
  }
  for (let index = 0; index < yClusters.length - 1; index += 1) {
    const cut = (yClusters[index] + yClusters[index + 1]) / 2;
    if (cut - box.minY >= minDimensionMm && box.maxY - cut >= minDimensionMm) yCuts.push(cut);
  }
  if (!xCuts.length && !yCuts.length) return null;
  const xAxes = [box.minX, ...xCuts, box.maxX].sort((a, b) => a - b);
  const yAxes = [box.minY, ...yCuts, box.maxY].sort((a, b) => a - b);
  const xIndex = xAxes.findIndex((value, index) =>
    index < xAxes.length - 1 &&
    point.x > value + paddingMm &&
    point.x < xAxes[index + 1] - paddingMm);
  const yIndex = yAxes.findIndex((value, index) =>
    index < yAxes.length - 1 &&
    point.y > value + paddingMm &&
    point.y < yAxes[index + 1] - paddingMm);
  if (xIndex < 0 || yIndex < 0) return null;
  const cell = {
    minX: xAxes[xIndex],
    maxX: xAxes[xIndex + 1],
    minY: yAxes[yIndex],
    maxY: yAxes[yIndex + 1],
  };
  if (cell.maxX - cell.minX < minDimensionMm || cell.maxY - cell.minY < minDimensionMm) return null;
  return {
    box: cell,
    splitAxes: {
      vertical: xAxes.map((value) => round(value, 0)),
      horizontal: yAxes.map((value) => round(value, 0)),
    },
    source: "slab-mark-midline-split",
  };
}

function inferBestBoundaryBoxForPoint(point, boundaries, slabMarks = [], options = {}) {
  const maxSearchMm = Number(options.maxSearchMm || 26000);
  const coverToleranceMm = strictCadBoundaryTolerance(options.coverToleranceMm);
  const minSideCoverage = Number(options.minSideCoverage || 0.12);
  const maxCandidatesPerSide = Number(options.maxCandidatesPerSide || 9);
  const minDimensionM = Number(options.minDimensionM || 0.42);
  const maxDimensionM = Number(options.maxDimensionM || 24);
  const minAreaSqm = Number(options.minAreaSqm || 0.18);
  const maxAreaSqm = Number(options.maxAreaSqm || 180);

  function sideCandidates(orientation, side) {
    const directional = boundaries
      .filter((item) => item.orientation === orientation)
      .filter(isReliableSlabPanelBoundary)
      .filter((item) => {
        if (orientation === "V") {
          if (side === "left" && item.fixed >= point.x) return false;
          if (side === "right" && item.fixed <= point.x) return false;
          if (Math.abs(item.fixed - point.x) > maxSearchMm) return false;
          return true;
        }
        if (side === "bottom" && item.fixed >= point.y) return false;
        if (side === "top" && item.fixed <= point.y) return false;
        if (Math.abs(item.fixed - point.y) > maxSearchMm) return false;
        return true;
      })
      .map((item) => {
        const directCross = orientation === "V"
          ? point.y >= item.start - coverToleranceMm && point.y <= item.end + coverToleranceMm
          : point.x >= item.start - coverToleranceMm && point.x <= item.end + coverToleranceMm;
        const axisDistance = Math.abs(item.fixed - (orientation === "V" ? point.x : point.y));
        return {
          item,
          distance: axisDistance + (directCross ? 0 : Number(options.axisFallbackPenaltyMm || 1800)),
          directCross,
        };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxCandidatesPerSide)
      .map((entry) => entry.item);
    return directional;
  }

  const lefts = sideCandidates("V", "left");
  const rights = sideCandidates("V", "right");
  const bottoms = sideCandidates("H", "bottom");
  const tops = sideCandidates("H", "top");
  let best = null;
  for (const left of lefts) {
    for (const right of rights) {
      const minX = Math.min(left.fixed, right.fixed);
      const maxX = Math.max(left.fixed, right.fixed);
      const widthM = (maxX - minX) / 1000;
      if (widthM < minDimensionM || widthM > maxDimensionM) continue;
      for (const bottom of bottoms) {
        for (const top of tops) {
          const minY = Math.min(bottom.fixed, top.fixed);
          const maxY = Math.max(bottom.fixed, top.fixed);
          const heightM = (maxY - minY) / 1000;
          if (heightM < minDimensionM || heightM > maxDimensionM) continue;
          const areaSqm = widthM * heightM;
          if (areaSqm < minAreaSqm || areaSqm > maxAreaSqm) continue;
          const box = { minX, maxX, minY, maxY };
          const coverage = {
            top: boundaryCoverageForBox(boundaries, "top", box, coverToleranceMm),
            bottom: boundaryCoverageForBox(boundaries, "bottom", box, coverToleranceMm),
            left: boundaryCoverageForBox(boundaries, "left", box, coverToleranceMm),
            right: boundaryCoverageForBox(boundaries, "right", box, coverToleranceMm),
          };
          const weakest = Math.min(coverage.top, coverage.bottom, coverage.left, coverage.right);
          if (weakest < minSideCoverage) continue;
          const marksInside = slabMarks.filter((mark) =>
            mark.x > box.minX + 80 &&
            mark.x < box.maxX - 80 &&
            mark.y > box.minY + 80 &&
            mark.y < box.maxY - 80);
          const distanceScore = Math.abs(left.fixed - point.x) +
            Math.abs(right.fixed - point.x) +
            Math.abs(bottom.fixed - point.y) +
            Math.abs(top.fixed - point.y);
          const markScore = marksInside.length === 1 ? -5000 : Math.abs(marksInside.length - 1) * 3000;
          const coverageScore = -weakest * 2500;
          const areaScore = areaSqm < 1 ? 800 : 0;
          const score = distanceScore * 0.01 + markScore + coverageScore + areaScore;
          if (!best || score < best.score) {
            best = {
              box,
              x: (minX + maxX) / 2,
              y: (minY + maxY) / 2,
              areaSqm,
              coverage,
              boundaryTypes: {
                left: left.type,
                right: right.type,
                top: top.type,
                bottom: bottom.type,
              },
              marksInside,
              score,
            };
          }
        }
      }
    }
  }
  return best;
}

function inferAxisBoundaryBoxForPoint(point, boundaries, slabMarks = [], options = {}) {
  const maxSearchMm = Number(options.maxSearchMm || 26000);
  const coverToleranceMm = strictCadBoundaryTolerance(options.coverToleranceMm);
  const minDimensionM = Number(options.minDimensionM || 0.42);
  const maxDimensionM = Number(options.maxDimensionM || 24);
  const minAreaSqm = Number(options.minAreaSqm || 0.18);
  const maxAreaSqm = Number(options.maxAreaSqm || 180);
  const minGapMm = Number(options.minAxisGapMm || 220);
  const maxCandidatesPerSide = Number(options.maxCandidatesPerSide || 5);

  function sideCandidates(orientation, side) {
    const fixedPoint = orientation === "V" ? point.x : point.y;
    const alongPoint = orientation === "V" ? point.y : point.x;
    const seenAxis = new Set();
    return boundaries
      .filter((item) => item.orientation === orientation)
      .filter(isReliableSlabPanelBoundary)
      .map((item) => {
        const delta = item.fixed - fixedPoint;
        if (side === "left" && delta >= -minGapMm) return null;
        if (side === "right" && delta <= minGapMm) return null;
        if (side === "bottom" && delta >= -minGapMm) return null;
        if (side === "top" && delta <= minGapMm) return null;
        const axisDistance = Math.abs(delta);
        if (axisDistance > maxSearchMm) return null;
        const directCross = alongPoint >= item.start - coverToleranceMm && alongPoint <= item.end + coverToleranceMm;
        const axisKey = `${orientation}:${Math.round(item.fixed / 80)}`;
        if (seenAxis.has(axisKey)) return null;
        seenAxis.add(axisKey);
        return {
          item,
          directCross,
          axisDistance,
          score: axisDistance + (directCross ? 0 : Number(options.axisFallbackPenaltyMm || 2200)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, maxCandidatesPerSide);
  }

  const lefts = sideCandidates("V", "left");
  const rights = sideCandidates("V", "right");
  const bottoms = sideCandidates("H", "bottom");
  const tops = sideCandidates("H", "top");
  let best = null;
  for (const left of lefts) {
    for (const right of rights) {
      const minX = Math.min(left.item.fixed, right.item.fixed);
      const maxX = Math.max(left.item.fixed, right.item.fixed);
      const widthM = (maxX - minX) / 1000;
      if (widthM < minDimensionM || widthM > maxDimensionM) continue;
      for (const bottom of bottoms) {
        for (const top of tops) {
          const minY = Math.min(bottom.item.fixed, top.item.fixed);
          const maxY = Math.max(bottom.item.fixed, top.item.fixed);
          const heightM = (maxY - minY) / 1000;
          if (heightM < minDimensionM || heightM > maxDimensionM) continue;
          const areaSqm = widthM * heightM;
          if (areaSqm < minAreaSqm || areaSqm > maxAreaSqm) continue;
          const box = { minX, maxX, minY, maxY };
          const marksInside = slabMarks.filter((mark) =>
            mark.x > box.minX + 80 &&
            mark.x < box.maxX - 80 &&
            mark.y > box.minY + 80 &&
            mark.y < box.maxY - 80);
          const directCrossCount = [left, right, bottom, top].filter((item) => item.directCross).length;
          const distanceScore = left.axisDistance + right.axisDistance + bottom.axisDistance + top.axisDistance;
          const markScore = marksInside.length === 1 ? -9000 : Math.abs(marksInside.length - 1) * 8000;
          const directScore = (4 - directCrossCount) * 2200;
          const score = distanceScore * 0.01 + markScore + directScore;
          if (!best || score < best.score) {
            best = {
              box,
              x: (minX + maxX) / 2,
              y: (minY + maxY) / 2,
              areaSqm,
              coverage: null,
              boundaryTypes: {
                left: left.item.type,
                right: right.item.type,
                top: top.item.type,
                bottom: bottom.item.type,
              },
              directCrossCount,
              marksInside,
              score,
            };
          }
        }
      }
    }
  }
  if (best) {
    best.coverage = {
      top: boundaryCoverageForBox(boundaries, "top", best.box, coverToleranceMm),
      bottom: boundaryCoverageForBox(boundaries, "bottom", best.box, coverToleranceMm),
      left: boundaryCoverageForBox(boundaries, "left", best.box, coverToleranceMm),
      right: boundaryCoverageForBox(boundaries, "right", best.box, coverToleranceMm),
    };
  }
  return best;
}

function inferNeighborBoundaryBoxForPoint(point, boundaries, slabMarks = [], options = {}) {
  const rowToleranceMm = Number(options.rowToleranceMm || 2200);
  const columnToleranceMm = Number(options.columnToleranceMm || 2200);
  const crossToleranceMm = strictCadBoundaryTolerance(options.crossToleranceMm);
  const outerSearchMm = Number(options.outerSearchMm || 18000);
  const betweenSlackMm = Number(options.betweenSlackMm || 450);
  const targetToleranceMm = Number(options.targetToleranceMm || 4200);
  const minDimensionM = Number(options.minDimensionM || 0.75);
  const maxDimensionM = Number(options.maxDimensionM || 32);
  const minAreaSqm = Number(options.minAreaSqm || 0.7);
  const maxAreaSqm = Number(options.maxAreaSqm || 260);
  const usefulBoundaryLengthMm = Number(options.usefulBoundaryLengthMm || 1200);
  const supportPenalty = Number(options.supportPenalty ?? 0);
  const shortBoundaryPenalty = Number(options.shortBoundaryPenalty || 1400);
  const nonCrossPenalty = Number(options.nonCrossPenalty || 1800);

  const sameRow = slabMarks
    .filter((mark) => mark !== point && Math.abs(mark.y - point.y) <= rowToleranceMm)
    .sort((a, b) => a.x - b.x);
  const sameColumn = slabMarks
    .filter((mark) => mark !== point && Math.abs(mark.x - point.x) <= columnToleranceMm)
    .sort((a, b) => a.y - b.y);
  const leftMark = sameRow.filter((mark) => mark.x < point.x).at(-1) || null;
  const rightMark = sameRow.find((mark) => mark.x > point.x) || null;
  const bottomMark = sameColumn.filter((mark) => mark.y < point.y).at(-1) || null;
  const topMark = sameColumn.find((mark) => mark.y > point.y) || null;

  function chooseBoundary(side, neighbor) {
    const verticalSide = side === "left" || side === "right";
    const orientation = verticalSide ? "V" : "H";
    const pointFixed = verticalSide ? point.x : point.y;
    const pointAlong = verticalSide ? point.y : point.x;
    const neighborFixed = neighbor ? (verticalSide ? neighbor.x : neighbor.y) : null;
    const target = neighbor ? (pointFixed + neighborFixed) / 2 : null;
    const lower = neighbor
      ? Math.min(pointFixed, neighborFixed) - betweenSlackMm
      : (side === "left" || side === "bottom" ? pointFixed - outerSearchMm : pointFixed + betweenSlackMm);
    const upper = neighbor
      ? Math.max(pointFixed, neighborFixed) + betweenSlackMm
      : (side === "left" || side === "bottom" ? pointFixed - betweenSlackMm : pointFixed + outerSearchMm);
    const candidates = boundaries
      .filter((item) => item.orientation === orientation)
      .filter(isReliableSlabPanelBoundary)
      .filter((item) => item.fixed >= Math.min(lower, upper) && item.fixed <= Math.max(lower, upper))
      .map((item) => {
        const crosses = pointAlong >= item.start - crossToleranceMm && pointAlong <= item.end + crossToleranceMm;
        const targetDistance = target === null
          ? Math.abs(item.fixed - pointFixed)
          : Math.abs(item.fixed - target);
        if (target !== null && targetDistance > targetToleranceMm) return null;
        const innerFaceDistance = Math.abs(item.fixed - pointFixed);
        const typePenalty = /support/i.test(String(item.type || "")) ? supportPenalty : 0;
        const lengthPenalty = Number(item.lengthMm || 0) < usefulBoundaryLengthMm ? shortBoundaryPenalty : 0;
        return {
          item,
          crosses,
          score: innerFaceDistance + targetDistance * 0.08 + typePenalty + lengthPenalty + (crosses ? 0 : nonCrossPenalty),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    return candidates[0]?.item || null;
  }

  const left = chooseBoundary("left", leftMark);
  const right = chooseBoundary("right", rightMark);
  const bottom = chooseBoundary("bottom", bottomMark);
  const top = chooseBoundary("top", topMark);
  if (!left || !right || !bottom || !top) return null;

  const box = {
    minX: Math.min(left.fixed, right.fixed),
    maxX: Math.max(left.fixed, right.fixed),
    minY: Math.min(bottom.fixed, top.fixed),
    maxY: Math.max(bottom.fixed, top.fixed),
  };
  const widthM = (box.maxX - box.minX) / 1000;
  const heightM = (box.maxY - box.minY) / 1000;
  const areaSqm = widthM * heightM;
  if (widthM < minDimensionM || heightM < minDimensionM || widthM > maxDimensionM || heightM > maxDimensionM) return null;
  if (areaSqm < minAreaSqm || areaSqm > maxAreaSqm) return null;
  if (point.x <= box.minX + 80 || point.x >= box.maxX - 80 || point.y <= box.minY + 80 || point.y >= box.maxY - 80) return null;

  const coverage = {
    top: boundaryCoverageForBox(boundaries, "top", box, crossToleranceMm),
    bottom: boundaryCoverageForBox(boundaries, "bottom", box, crossToleranceMm),
    left: boundaryCoverageForBox(boundaries, "left", box, crossToleranceMm),
    right: boundaryCoverageForBox(boundaries, "right", box, crossToleranceMm),
  };
  const marksInside = slabMarks.filter((mark) =>
    mark.x > box.minX + 80 &&
    mark.x < box.maxX - 80 &&
    mark.y > box.minY + 80 &&
    mark.y < box.maxY - 80);
  return {
    box,
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    areaSqm,
    coverage,
    boundaryTypes: {
      left: left.type,
      right: right.type,
      top: top.type,
      bottom: bottom.type,
    },
    directCrossCount: Object.values(coverage).filter((value) => Number(value) >= 0.18).length,
    marksInside,
    score: areaSqm,
    neighborBasis: {
      left: leftMark?.text || "",
      right: rightMark?.text || "",
      bottom: bottomMark?.text || "",
      top: topMark?.text || "",
    },
  };
}

function createSlabMarkGridBoxInferrer(slabMarks = [], boundaries = [], options = {}) {
  const rowToleranceMm = Number(options.rowToleranceMm || 2600);
  const columnToleranceMm = Number(options.columnToleranceMm || 2600);
  const snapToleranceMm = strictCadBoundaryTolerance(options.snapToleranceMm);
  const minGapMm = Number(options.minGapMm || 650);
  const minDimensionM = Number(options.minDimensionM || 0.75);
  const maxDimensionM = Number(options.maxDimensionM || 22);
  const minAreaSqm = Number(options.minAreaSqm || 0.7);
  const maxAreaSqm = Number(options.maxAreaSqm || 180);

  const clusterMarks = (items, key, toleranceMm) => {
    const sorted = items
      .filter((item) => Number.isFinite(item[key]))
      .sort((a, b) => a[key] - b[key]);
    const clusters = [];
    for (const item of sorted) {
      const last = clusters.at(-1);
      const value = item[key];
      if (!last || Math.abs(value - last.center) > toleranceMm) {
        clusters.push({ center: value, marks: [item] });
      } else {
        last.marks.push(item);
        last.center = median(last.marks.map((mark) => mark[key]));
      }
    }
    return clusters;
  };

  const xClusters = clusterMarks(slabMarks, "x", columnToleranceMm);
  const yClusters = clusterMarks(slabMarks, "y", rowToleranceMm);
  if (xClusters.length < 2 || yClusters.length < 2) return () => null;

  const medianGap = (clusters) => {
    const gaps = [];
    for (let index = 0; index < clusters.length - 1; index += 1) {
      const gap = clusters[index + 1].center - clusters[index].center;
      if (gap >= minGapMm) gaps.push(gap);
    }
    return gaps.length ? median(gaps) : 0;
  };

  const defaultXGap = medianGap(xClusters);
  const defaultYGap = medianGap(yClusters);

  const nearestClusterIndex = (clusters, value) => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    clusters.forEach((cluster, index) => {
      const distanceToCluster = Math.abs(cluster.center - value);
      if (distanceToCluster < bestDistance) {
        bestDistance = distanceToCluster;
        bestIndex = index;
      }
    });
    return bestIndex;
  };

  const boundaryNear = (orientation, target, alongStart, alongEnd) => {
    const mid = (alongStart + alongEnd) / 2;
    return boundaries
      .filter((boundary) => boundary.orientation === orientation)
      .filter(isReliableSlabPanelBoundary)
      .map((boundary) => {
        const distanceToTarget = Math.abs(boundary.fixed - target);
        if (distanceToTarget > snapToleranceMm) return null;
        const overlap = overlap1d(boundary.start, boundary.end, alongStart, alongEnd);
        const crossesMid = mid >= boundary.start - snapToleranceMm && mid <= boundary.end + snapToleranceMm;
        return {
          boundary,
          score: distanceToTarget + (crossesMid ? 0 : 900) - Math.min(overlap, 6000) * 0.05,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)[0]?.boundary || null;
  };

  const edgeAt = (clusters, index, side, defaultGap) => {
    if (side < 0) {
      if (index > 0) return (clusters[index - 1].center + clusters[index].center) / 2;
      const gap = clusters[index + 1] ? clusters[index + 1].center - clusters[index].center : defaultGap;
      return clusters[index].center - (gap || defaultGap || 4000) / 2;
    }
    if (index < clusters.length - 1) return (clusters[index].center + clusters[index + 1].center) / 2;
    const gap = clusters[index - 1] ? clusters[index].center - clusters[index - 1].center : defaultGap;
    return clusters[index].center + (gap || defaultGap || 4000) / 2;
  };

  return (point) => {
    const xIndex = nearestClusterIndex(xClusters, point.x);
    const yIndex = nearestClusterIndex(yClusters, point.y);
    if (xIndex < 0 || yIndex < 0) return null;

    let minX = edgeAt(xClusters, xIndex, -1, defaultXGap);
    let maxX = edgeAt(xClusters, xIndex, 1, defaultXGap);
    let minY = edgeAt(yClusters, yIndex, -1, defaultYGap);
    let maxY = edgeAt(yClusters, yIndex, 1, defaultYGap);
    if (minX > maxX) [minX, maxX] = [maxX, minX];
    if (minY > maxY) [minY, maxY] = [maxY, minY];

    const leftSnap = boundaryNear("V", minX, minY, maxY);
    const rightSnap = boundaryNear("V", maxX, minY, maxY);
    const bottomSnap = boundaryNear("H", minY, minX, maxX);
    const topSnap = boundaryNear("H", maxY, minX, maxX);
    if (![leftSnap, rightSnap, bottomSnap, topSnap].every(Boolean)) return null;
    if (leftSnap) minX = leftSnap.fixed;
    if (rightSnap) maxX = rightSnap.fixed;
    if (bottomSnap) minY = bottomSnap.fixed;
    if (topSnap) maxY = topSnap.fixed;
    if (minX > maxX) [minX, maxX] = [maxX, minX];
    if (minY > maxY) [minY, maxY] = [maxY, minY];

    const box = { minX, maxX, minY, maxY };
    const widthM = (box.maxX - box.minX) / 1000;
    const heightM = (box.maxY - box.minY) / 1000;
    const areaSqm = widthM * heightM;
    if (widthM < minDimensionM || heightM < minDimensionM || widthM > maxDimensionM || heightM > maxDimensionM) return null;
    if (areaSqm < minAreaSqm || areaSqm > maxAreaSqm) return null;
    if (point.x <= box.minX + 80 || point.x >= box.maxX - 80 || point.y <= box.minY + 80 || point.y >= box.maxY - 80) return null;

    const marksInside = slabMarks.filter((mark) =>
      mark.x > box.minX + 80 &&
      mark.x < box.maxX - 80 &&
      mark.y > box.minY + 80 &&
      mark.y < box.maxY - 80);
    return {
      box,
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      areaSqm,
      coverage: {
        top: topSnap ? 1 : 0,
        bottom: bottomSnap ? 1 : 0,
        left: leftSnap ? 1 : 0,
        right: rightSnap ? 1 : 0,
      },
      boundaryTypes: {
        left: leftSnap?.type || "slab-mark-grid-edge",
        right: rightSnap?.type || "slab-mark-grid-edge",
        top: topSnap?.type || "slab-mark-grid-edge",
        bottom: bottomSnap?.type || "slab-mark-grid-edge",
      },
      directCrossCount: [leftSnap, rightSnap, bottomSnap, topSnap].filter(Boolean).length,
      marksInside,
      score: areaSqm,
      gridBasis: {
        xIndex,
        yIndex,
        xClusterCount: xClusters.length,
        yClusterCount: yClusters.length,
      },
    };
  };
}

function mergedBeamRunMarks(entities, grid, options = {}) {
  const fixedToleranceMm = Number(options.fixedToleranceMm || 1200);
  const maxSameRunTextGapMm = Number(options.maxSameRunTextGapMm || 14000);
  const sectionZones = buildSectionDetailExclusionZones(entities, options.sectionExclusion || {});
  const raw = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({
      text: cleanCadText(entity.text),
      x: entity.x,
      y: entity.y,
      layer: entity.layer,
      rotation: entity.rotation || 0,
      orientation: textOrientation(entity),
    }))
    .map((entity) => ({ ...entity, size: parseBeamSize(entity.text) }))
    .filter((entity) => entity.size && Number.isFinite(entity.x) && Number.isFinite(entity.y))
    .filter((entity) => insideGridWindow(grid, entity, options.planWindow || {}))
    .filter((entity) => !sectionZones.some((zone) => pointInBox(entity, zone)));

  const groups = [];
  for (const mark of raw) {
    const fixed = mark.orientation === "H" ? mark.y : mark.x;
    const along = mark.orientation === "H" ? mark.x : mark.y;
    const group = groups.find((candidate) =>
      candidate.orientation === mark.orientation &&
      candidate.size.label === mark.size.label &&
      Math.abs(candidate.fixed - fixed) <= fixedToleranceMm);
    if (group) {
      group.marks.push({ ...mark, fixed, along });
      group.fixed = median(group.marks.map((item) => item.fixed));
    } else {
      groups.push({
        orientation: mark.orientation,
        size: mark.size,
        fixed,
        marks: [{ ...mark, fixed, along }],
      });
    }
  }

  const runs = [];
  for (const group of groups) {
    const sorted = group.marks.sort((a, b) => a.along - b.along);
    let current = [];
    for (const mark of sorted) {
      const previous = current.at(-1);
      if (previous && mark.along - previous.along > maxSameRunTextGapMm) {
        runs.push({ ...group, marks: current });
        current = [];
      }
      current.push(mark);
    }
    if (current.length) runs.push({ ...group, marks: current });
  }

  return sortMarksTopLeft(runs.map((run) => {
    const alongValues = run.marks.map((mark) => mark.along);
    const fixed = median(run.marks.map((mark) => mark.fixed));
    const along = (Math.min(...alongValues) + Math.max(...alongValues)) / 2;
    const point = run.orientation === "H" ? { x: along, y: fixed } : { x: fixed, y: along };
    return {
      label: `${run.size.label}`,
      sizeText: run.size.label,
      sourceTexts: run.marks.length,
      x: point.x,
      y: point.y,
      orientation: run.orientation === "H" ? "horizontal" : "vertical",
      gridBand: nearestGridBand(grid, point),
      status: run.marks.length > 1 ? "merged-same-size-run" : "single-size-run",
      remarks: run.marks.length > 1
        ? "Merged same-size unnumbered beam texts on one line into one continuous QB run."
        : "Single unnumbered beam size text; run length still validated by beam faces.",
    };
  }), grid).map((run, index) => ({
    id: `QB${index + 1}`,
    ...run,
    label: `QB${index + 1} ${run.label}`,
  }));
}

function createReferenceWorkingDrawingData(entities, options = {}) {
  const regionEntities = options.planRegion
    ? entities.filter((entity) => entityInsideRegion(entity, options.planRegion, 3500))
    : entities;
  const correctionEntities = options.planRegion && Array.isArray(options.correctionEntities)
    ? options.correctionEntities.filter((entity) => entityInsideRegion(entity, options.planRegion, 3500))
    : (options.correctionEntities || []);
  const grid = buildGridRegistry(regionEntities);
  const sectionZones = buildSectionDetailExclusionZones(regionEntities, options.sectionExclusion || {});
  const planEntities = regionEntities.filter((entity) => !isSectionDetailEntity(entity, sectionZones, grid));
  const fullRoute = analyzeDrawingRoute(regionEntities);
  const planRoute = analyzeDrawingRoute(planEntities);
  const route = planRoute.route.route === "numbered_beam_route"
    ? planRoute
    : fullRoute.route.route === "numbered_beam_route"
      ? planRoute
      : fullRoute.route.route === "grid_unnumbered_beam_route"
        ? fullRoute
        : planRoute;
  const slabMarkCandidateCountForFastPath = 0;
  const skipFaceWalkForSlabMarks = false;
  const slab = solveBoundarySlabPanels(planEntities, {
    boundaryToleranceMm: 25,
    clusterToleranceMm: 25,
    minCoverage: 0.9,
    minDimensionM: 0.45,
    maxDimensionM: 32,
    minAreaSqm: 0.7,
    splitUsingRawFaceCoordinates: true,
    stitching: {
      coordinateToleranceMm: 25,
      maxGapMm: 650,
      supportToleranceMm: 25,
      minStitchedLengthMm: 450,
    },
    internalSplit: {
      coordinateToleranceMm: 25,
      minInternalCoverage: 0.9,
      edgeClearanceMm: 150,
    },
    ...(options.boundarySlabPanels || {}),
  });
  const legacyBeamTextMarks = beamSizeTexts(planEntities, grid);
  const beamIdentityMode = route.route.route === "numbered_beam_route"
    ? "existing_beam_names"
    : "auto_qb_for_unnumbered_beams";
  const beamMarks = beamIdentityMode === "existing_beam_names"
    ? []
    : mergedBeamRunMarks(planEntities, grid, options.beams || {});
  const detectedPanelMarks = [];
  const existingReferencePanelMarks = extractExistingReferencePanelMarks(correctionEntities, grid)
    .filter((panel) => !isSectionDetailPoint(panel, sectionZones, grid));
  const manualPanelMarks = extractManualPanelLeftMarks(correctionEntities, [...existingReferencePanelMarks, ...detectedPanelMarks], grid)
    .filter((panel) => !isSectionDetailPoint(panel, sectionZones, grid));
  const slabMarkPanelMarks = [];
  const openBayMarks = [];
  const slabMarkCoverageRatio = slabMarkCandidateCountForFastPath
    ? slabMarkPanelMarks.length / slabMarkCandidateCountForFastPath
    : (slabMarkPanelMarks.length ? 1 : 0);
  const slabMarkSeedsAreComplete = false;
  const slabMarkSeedsCanDriveReference = false;
  const rawPanelSeeds = strictBoundaryPanelSeeds(slab, planEntities);

  const panelSeeds = sanitizePanelSeedsBeforeNumbering(rawPanelSeeds, grid, {
    minAreaSqm: 0.7,
    maxAreaSqm: 260,
    duplicateOverlapRatio: 0.35,
    containOverlapRatio: 0.82,
  });

  const panelMarks = assignPanelIds(panelSeeds, grid);
  const reviewMarks = [];

  return {
    route,
    layers: {
      panels: "QSS_PANEL_MARKS",
      beams: "QSS_AUTO_BEAM_IDS",
      reviews: "QSS_REVIEW_AREAS",
    },
    panelMarks,
    beamMarks,
    reviewMarks,
    summary: {
      route: route.route.route,
      panels: panelMarks.length,
      autoBeamMarks: beamMarks.length,
      rawBeamSizeTexts: legacyBeamTextMarks.length,
      beamIdentityMode,
      mergedBeamRuns: beamMarks.length,
      existingReferencePanelMarks: existingReferencePanelMarks.length,
      userPanelLeftMarks: manualPanelMarks.length,
      slabMarkPanelMarks: slabMarkPanelMarks.length,
      slabMarkCoverageRatio,
      slabMarkSeedsAreComplete: Boolean(slabMarkSeedsAreComplete),
      slabMarkSeedsCanDriveReference: Boolean(slabMarkSeedsCanDriveReference),
      slabBoxGeneratorRemoved: true,
      strictBoundaryPanels: slab.panels?.length || 0,
      strictBoundaryReviewCells: slab.reviewCells?.length || 0,
      strictBoundaryGraph: slab.boundaryCoordinates || null,
      strictBoundaryStitching: slab.stitching || null,
      strictBoundaryInternalSplit: slab.internalSplit || null,
      slabMarkPanelDiagnostics: null,
      slabMarkCandidateCountForFastPath,
      faceWalkSkippedForSlabMarks: skipFaceWalkForSlabMarks,
      openBayPanelMarks: openBayMarks.length,
      sectionExclusionZones: sectionZones.length,
      planRegionApplied: Boolean(options.planRegion),
      reviewAreas: reviewMarks.length,
    },
  };
}

module.exports = { createReferenceWorkingDrawingData };
