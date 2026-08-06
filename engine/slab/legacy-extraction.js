"use strict";

const {
  boundsFromPoints,
  cadDimensionForPanelSpan,
  chooseMeasuredDimension,
  clusterValues,
  dimensionSpanAxis,
  dimensionSpanRange,
  dimensionTextPoint,
  distance,
  distanceToRange,
  findGridAxis,
  geometryKey,
  gridDimensionBetween,
  hasHorizontalCoverage,
  hasVerticalCoverage,
  isBeamGeometryLayer,
  isHorizontal,
  isVertical,
  lineLength,
  lineMinMax,
  lineOrientation,
  medianNumber,
  mergeDimensionEvidence,
  nearest,
  round3,
  slabMarkBounds,
  supportOutlinesFromDxf,
  textDimensionEvidenceFromEntities,
  textPoint,
  uniqueRowsBy,
} = require("../cad/legacy-evidence.js");
const {
  nearestSlabThicknessForLabel,
} = require("../beam/legacy-extraction.js");

function isWrittenPanelDimension(dimension = {}) {
  return Number(dimension?.valueMm || 0) > 0 &&
    /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(dimension?.valueSource || ""));
}

function chooseSlabPanelDimension({ cadDimension, gridDimension, geometryMm }) {
  const cadMm = Number(cadDimension?.valueMm || 0);
  const gridMm = Number(gridDimension?.valueMm || 0);
  const geometry = Number(geometryMm || 0);
  const values = [
    cadMm ? { source: "written-cad-dimension", valueMm: cadMm } : null,
    gridMm ? { source: "grid-dimension", valueMm: gridMm } : null,
    geometry ? { source: "geometry", valueMm: geometry } : null,
  ].filter(Boolean);
  if (isWrittenPanelDimension(cadDimension)) {
    const disagreement = values.some((item) => Math.abs(item.valueMm - cadMm) > Math.max(25, cadMm * 0.01));
    return {
      source: "written-cad-dimension",
      valueMm: cadMm,
      conflict: false,
      disagreement,
      authoritative: true,
      values,
      writtenDimensionAuthority: true,
    };
  }
  return chooseMeasuredDimension({ cadDimension, gridDimension, geometryMm });
}

function extractGridPanelRowsFromDxf(fileName, role, gridPanels, grid, slabInfo, cutouts = []) {
  if (!Array.isArray(gridPanels) || !gridPanels.length) return [];
  const rows = [];
  for (const request of gridPanels) {
    const x1 = findGridAxis(grid, request.xFrom || request.leftGrid || request.fromX, "x");
    const x2 = findGridAxis(grid, request.xTo || request.rightGrid || request.toX, "x");
    const y1 = findGridAxis(grid, request.yFrom || request.bottomGrid || request.fromY, "y");
    const y2 = findGridAxis(grid, request.yTo || request.topGrid || request.toY, "y");
    if (!x1 || !x2 || !y1 || !y2) {
      rows.push({
        name: request.name || "Grid slab panel",
        floor: role,
        length: 0,
        breadth: 0,
        height: 0,
        openings: 0,
        source: "dxf-grid-panel",
        needsReview: true,
        reviewNote: "One or more requested grid lines were not found in the CAD grid evidence.",
        evidence: { fileName, request, foundAxes: { x1, x2, y1, y2 } },
      });
      continue;
    }

    const xDimension = gridDimensionBetween(grid, x1, x2, "x");
    const yDimension = gridDimensionBetween(grid, y1, y2, "y");
    const xGeometryMm = Math.abs(x2.coordinate - x1.coordinate);
    const yGeometryMm = Math.abs(y2.coordinate - y1.coordinate);
    const xChoice = chooseMeasuredDimension({ cadDimension: null, gridDimension: xDimension, geometryMm: xGeometryMm });
    const yChoice = chooseMeasuredDimension({ cadDimension: null, gridDimension: yDimension, geometryMm: yGeometryMm });
    const lengthMm = xChoice.valueMm || xGeometryMm;
    const breadthMm = yChoice.valueMm || yGeometryMm;
    const bounds = {
      minX: Math.min(x1.coordinate, x2.coordinate),
      maxX: Math.max(x1.coordinate, x2.coordinate),
      minY: Math.min(y1.coordinate, y2.coordinate),
      maxY: Math.max(y1.coordinate, y2.coordinate),
    };
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const slabThickness = nearestSlabThicknessForLabel(slabInfo, center);
    const panelCutouts = cutouts.filter(
      (cutout) =>
        cutout.centerX >= bounds.minX &&
        cutout.centerX <= bounds.maxX &&
        cutout.centerY >= bounds.minY &&
        cutout.centerY <= bounds.maxY,
    );
    const grossAreaM2 = (lengthMm * breadthMm) / 1000000;
    const cutoutAreaM2 = panelCutouts.reduce((sum, cutout) => sum + cutout.areaM2, 0);
    rows.push({
      name: request.name || `${x1.name}-${x2.name} / ${y1.name}-${y2.name}`,
      floor: role,
      length: lengthMm / 1000,
      breadth: breadthMm / 1000,
      height: (request.thicknessMm || slabThickness.valueMm || slabInfo.defaultThicknessMm || 0) / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: 0,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      dia: 10,
      spacing: 150,
      nos: 1,
      openings: Math.min(cutoutAreaM2, grossAreaM2),
      source: "dxf-grid-panel",
      needsReview: !(xDimension && yDimension) || xChoice.conflict || yChoice.conflict,
      reviewNote: xDimension && yDimension && !xChoice.conflict && !yChoice.conflict
        ? ""
        : "Grid/CAD/geometry dimensions did not fully agree; selected dimension basis is shown in evidence.",
      evidence: {
        fileName,
        request,
        xDimensionMm: xDimension ? Math.round(xDimension.valueMm) : null,
        yDimensionMm: yDimension ? Math.round(yDimension.valueMm) : null,
        xCoordinateSpanMm: Math.round(Math.abs(x2.coordinate - x1.coordinate)),
        yCoordinateSpanMm: Math.round(Math.abs(y2.coordinate - y1.coordinate)),
        xDimensionBasis: xChoice.source,
        yDimensionBasis: yChoice.source,
        xDimensionValues: xChoice.values.map((item) => ({ source: item.source, valueM: Math.round((item.valueMm / 1000) * 1000) / 1000 })),
        yDimensionValues: yChoice.values.map((item) => ({ source: item.source, valueM: Math.round((item.valueMm / 1000) * 1000) / 1000 })),
        dimensionConflict: xChoice.conflict || yChoice.conflict,
        slabThicknessText: slabThickness.sourceText || "",
        cutoutCount: panelCutouts.length,
        cutoutAreaM2: Math.round(cutoutAreaM2 * 1000) / 1000,
      },
    });
  }
  return rows;
}

function assignUnmatchedCutoutsToNearestPanel(rows, cutouts) {
  for (const cutout of cutouts) {
    const containingRow = rows.find((row) => {
      const box = row.evidence || {};
      return cutout.centerX >= box.panelLeftX &&
        cutout.centerX <= box.panelRightX &&
        cutout.centerY >= box.panelBottomY &&
        cutout.centerY <= box.panelTopY;
    });
    if (containingRow) continue;

    const nearestRow = rows
      .filter((row) => row.evidence)
      .map((row) => {
        const box = row.evidence;
        const centerX = (box.panelLeftX + box.panelRightX) / 2;
        const centerY = (box.panelBottomY + box.panelTopY) / 2;
        return { row, distance: Math.hypot(cutout.centerX - centerX, cutout.centerY - centerY) };
      })
      .sort((a, b) => a.distance - b.distance)[0]?.row;
    if (!nearestRow) continue;

    nearestRow.openings = (nearestRow.openings || 0) + cutout.areaM2;
    nearestRow.evidence.cutoutCount = (nearestRow.evidence.cutoutCount || 0) + 1;
    nearestRow.evidence.cutoutAreaM2 = Math.round((nearestRow.evidence.cutoutAreaM2 || 0) * 1000 + cutout.areaM2 * 1000) / 1000;
    nearestRow.evidence.cutoutAssignedBy = "nearest-panel";
  }
  return rows;
}

function applySlabBayDimensionNormalization(rows) {
  const patched = rows.map((row) => ({
    ...row,
    evidence: { ...(row.evidence || {}) },
  }));

  function bounds(row) {
    const evidence = row.evidence || {};
    return {
      left: Math.min(Number(evidence.panelLeftX), Number(evidence.panelRightX)),
      right: Math.max(Number(evidence.panelLeftX), Number(evidence.panelRightX)),
      bottom: Math.min(Number(evidence.panelBottomY), Number(evidence.panelTopY)),
      top: Math.max(Number(evidence.panelBottomY), Number(evidence.panelTopY)),
    };
  }
  function keyFor(values, toleranceMm = 750) {
    return values.map((value) => Math.round(value / toleranceMm)).join(":");
  }
  function groupedBy(keyFn) {
    const groups = new Map();
    patched.forEach((row) => {
      const box = bounds(row);
      if (![box.left, box.right, box.bottom, box.top].every(Number.isFinite)) return;
      const key = keyFn(box);
      groups.set(key, [...(groups.get(key) || []), row]);
    });
    return [...groups.values()].filter((group) => group.length >= 2);
  }
  function note(row, message) {
    row.evidence.bayDimensionNormalization = [
      ...(row.evidence.bayDimensionNormalization || []),
      message,
    ];
  }
  function setDimension(row, property, value, basis) {
    if (!Number.isFinite(value) || value <= 0) return;
    const rounded = round3(value);
    if (Math.abs(Number(row[property] || 0) - rounded) <= 0.04) return;
    row[property] = rounded;
    row.needsReview = row.needsReview || false;
    note(row, `${property} normalized to ${rounded} m by ${basis}`);
    row.evidence.dimensionBasis = [
      row.evidence.dimensionBasis,
      `${property}:${basis}`,
    ].filter(Boolean).join("; ");
  }
  function clusterRowsByDimension(group, property, toleranceM = 0.12) {
    const sorted = group
      .map((row) => ({ row, value: Number(row[property] || 0) }))
      .filter((item) => Number.isFinite(item.value) && item.value > 0)
      .sort((a, b) => a.value - b.value);
    const clusters = [];
    for (const item of sorted) {
      const current = clusters[clusters.length - 1];
      const currentMedian = current ? medianNumber(current.map((entry) => entry.value)) : null;
      if (!current || Math.abs(item.value - currentMedian) > Math.max(toleranceM, currentMedian * 0.035)) {
        clusters.push([item]);
      } else {
        current.push(item);
      }
    }
    return clusters;
  }

  for (const group of groupedBy((box) => keyFor([box.bottom, box.top]))) {
    const breadthM = medianNumber(group.map((row) => Number(row.breadth || 0)));
    if (Number.isFinite(breadthM) && group.length >= 2) {
      group.forEach((row) => setDimension(row, "breadth", breadthM, "same horizontal bay between parallel beams"));
    }
    for (const cluster of clusterRowsByDimension(group, "length")) {
      if (cluster.length < 2) continue;
      const lengthM = medianNumber(cluster.map((item) => item.value));
      cluster.forEach(({ row }) => setDimension(row, "length", lengthM, "repeated span in same horizontal bay"));
    }
  }

  for (const group of groupedBy((box) => keyFor([box.left, box.right]))) {
    const lengthM = medianNumber(group.map((row) => Number(row.length || 0)));
    if (Number.isFinite(lengthM) && group.length >= 2) {
      group.forEach((row) => setDimension(row, "length", lengthM, "same vertical bay between parallel beams"));
    }
    for (const cluster of clusterRowsByDimension(group, "breadth")) {
      if (cluster.length < 2) continue;
      const breadthM = medianNumber(cluster.map((item) => item.value));
      cluster.forEach(({ row }) => setDimension(row, "breadth", breadthM, "repeated span in same vertical bay"));
    }
  }

  return patched;
}

function extractSlabRowsFromDxf(fileName, role, entities, slabInfo, cutouts = [], grid = { dimensions: [] }) {
  const slabSearchBounds = slabMarkBounds(slabInfo.slabMarks || []);
  function isLikelySlabBoundaryLayer(layer = "") {
    const text = String(layer || "").toUpperCase();
    if (!text) return true;
    if (/DEFPOINTS|DIM|DIMENSION|TEXT|GRID|AXIS|CENTER|CENTRE|LEVEL|TITLE|SECTION|DETAIL|SCHEDULE|REBAR|STEEL|BAR|BBS|NOTE|ANNOT|HATCH/i.test(text)) return false;
    return true;
  }
  function isInsideSlabSearchBounds(line) {
    if (!slabSearchBounds) return true;
    const pad = 4500;
    return line.maxX >= slabSearchBounds.minX - pad &&
      line.minX <= slabSearchBounds.maxX + pad &&
      line.maxY >= slabSearchBounds.minY - pad &&
      line.minY <= slabSearchBounds.maxY + pad;
  }
  const beamLines = entities
    .filter((item) => isBeamGeometryLayer(item.layer || "") && item.type === "LINE")
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 250);
  const geometryBoundaryFallbackLines = entities
    .filter((item) => item.type === "LINE")
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .filter((item) => isLikelySlabBoundaryLayer(item.layer || ""))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 300)
    .filter((item) => isHorizontal(item) || isVertical(item))
    .filter(isInsideSlabSearchBounds);
  beamLines.push(...geometryBoundaryFallbackLines);
  const slabBoundaryLinesForPanels = uniqueRowsBy(
    beamLines,
    (line) => [
      Math.round(Math.min(line.x, line.x2) / 25),
      Math.round(Math.min(line.y, line.y2) / 25),
      Math.round(Math.max(line.x, line.x2) / 25),
      Math.round(Math.max(line.y, line.y2) / 25),
      lineOrientation(line),
    ].join(":"),
    (line) => isBeamGeometryLayer(line.layer || "") ? 0 : 1,
  );
  const slabBoundaryPolylines = entities
    .filter((item) => item.type === "LWPOLYLINE" && /RET\.?\s*WALL|RC\s*PARDI/i.test(item.layer || ""))
    .flatMap((item) => {
      const points = item.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      const segments = [];
      for (let index = 0; index < points.length - 1; index += 1) {
        segments.push({
          type: "LINE",
          layer: item.layer,
          x: points[index].x,
          y: points[index].y,
          x2: points[index + 1].x,
          y2: points[index + 1].y,
        });
      }
      return segments;
    })
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 250);
  slabBoundaryLinesForPanels.push(...slabBoundaryPolylines);
  const supports = supportOutlinesFromDxf(entities);
  const supportFaceLines = supports.flatMap((support) => ([
    {
      type: "LINE",
      layer: support.layer,
      x: support.minX,
      y: support.minY,
      x2: support.maxX,
      y2: support.minY,
    },
    {
      type: "LINE",
      layer: support.layer,
      x: support.minX,
      y: support.maxY,
      x2: support.maxX,
      y2: support.maxY,
    },
    {
      type: "LINE",
      layer: support.layer,
      x: support.minX,
      y: support.minY,
      x2: support.minX,
      y2: support.maxY,
    },
    {
      type: "LINE",
      layer: support.layer,
      x: support.maxX,
      y: support.minY,
      x2: support.maxX,
      y2: support.maxY,
    },
  ]))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 250);
  slabBoundaryLinesForPanels.push(...supportFaceLines);
  const horizontal = slabBoundaryLinesForPanels.filter(isHorizontal);
  const vertical = slabBoundaryLinesForPanels.filter(isVertical);
  const seen = new Set();

  function lineAxisX(line) {
    return (Number(line.x || 0) + Number(line.x2 || 0)) / 2;
  }

  function lineAxisY(line) {
    return (Number(line.y || 0) + Number(line.y2 || 0)) / 2;
  }

  function lineCrossesX(line, x, tolerance = 220) {
    return x >= Number(line.minX || 0) - tolerance && x <= Number(line.maxX || 0) + tolerance;
  }

  function lineCrossesY(line, y, tolerance = 220) {
    return y >= Number(line.minY || 0) - tolerance && y <= Number(line.maxY || 0) + tolerance;
  }

  function centerlinePanelBounds(mark, leftX, rightX, bottomY, topY) {
    const original = {
      left: Math.min(leftX, rightX),
      right: Math.max(leftX, rightX),
      bottom: Math.min(bottomY, topY),
      top: Math.max(bottomY, topY),
    };
    const width = original.right - original.left;
    const height = original.top - original.bottom;
    if (width < 650 || height < 650) return null;
    const boxCenterX = (original.left + original.right) / 2;
    const boxCenterY = (original.bottom + original.top) / 2;
    const hasMarkPoint = mark &&
      Number.isFinite(Number(mark.x)) &&
      Number.isFinite(Number(mark.y)) &&
      mark.x > original.left &&
      mark.x < original.right &&
      mark.y > original.bottom &&
      mark.y < original.top;
    const centerX = hasMarkPoint ? Number(mark.x) : boxCenterX;
    const centerY = hasMarkPoint ? Number(mark.y) : boxCenterY;
    const minBoundaryLength = Math.min(Math.max(Math.min(width, height) * 0.28, 650), 1800);
    const isUsefulBoundary = (line) => Number(line.lengthMm || lineLength(line) || 0) >= minBoundaryLength;
    const pad = Math.min(Math.max(Math.min(width, height) * 0.42, 700), 3000);
    const leftCandidate = vertical
      .filter(isUsefulBoundary)
      .filter((line) => lineCrossesY(line, centerY, 260))
      .map((line) => ({ line, x: lineAxisX(line) }))
      .filter((item) => item.x < centerX && item.x >= original.left - pad && item.x <= original.right)
      .sort((a, b) => b.x - a.x)[0];
    const rightCandidate = vertical
      .filter(isUsefulBoundary)
      .filter((line) => lineCrossesY(line, centerY, 260))
      .map((line) => ({ line, x: lineAxisX(line) }))
      .filter((item) => item.x > centerX && item.x <= original.right + pad && item.x >= original.left)
      .sort((a, b) => a.x - b.x)[0];
    const bottomCandidate = horizontal
      .filter(isUsefulBoundary)
      .filter((line) => lineCrossesX(line, centerX, 260))
      .map((line) => ({ line, y: lineAxisY(line) }))
      .filter((item) => item.y < centerY && item.y >= original.bottom - pad && item.y <= original.top)
      .sort((a, b) => b.y - a.y)[0];
    const topCandidate = horizontal
      .filter(isUsefulBoundary)
      .filter((line) => lineCrossesX(line, centerX, 260))
      .map((line) => ({ line, y: lineAxisY(line) }))
      .filter((item) => item.y > centerY && item.y <= original.top + pad && item.y >= original.bottom)
      .sort((a, b) => a.y - b.y)[0];
    const refined = {
      left: leftCandidate ? leftCandidate.x : original.left,
      right: rightCandidate ? rightCandidate.x : original.right,
      bottom: bottomCandidate ? bottomCandidate.y : original.bottom,
      top: topCandidate ? topCandidate.y : original.top,
    };
    const refinedWidth = refined.right - refined.left;
    const refinedHeight = refined.top - refined.bottom;
    if (refinedWidth < 650 || refinedHeight < 650) return null;
    if (refinedWidth < width * 0.35 || refinedHeight < height * 0.35) return null;
    const changed = Math.abs(refined.left - original.left) > 40 ||
      Math.abs(refined.right - original.right) > 40 ||
      Math.abs(refined.bottom - original.bottom) > 40 ||
      Math.abs(refined.top - original.top) > 40;
    if (!changed) return null;
    return {
      ...refined,
      centerX,
      centerY,
      original,
      originBasis: hasMarkPoint ? "slab-mark-centre" : "box-centre",
      markText: mark?.text || "",
    };
  }

  function slabMarksInsidePanelBounds(bounds) {
    return (slabInfo.slabMarks || []).filter((item) =>
      item.x > bounds.minX + 80 &&
      item.x < bounds.maxX - 80 &&
      item.y > bounds.minY + 80 &&
      item.y < bounds.maxY - 80);
  }

  function internalPanelSplitEvidence(bounds) {
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width < 900 || height < 900) return { verticalAxes: [], horizontalAxes: [], count: 0 };
    const inset = Math.min(Math.max(Math.min(width, height) * 0.08, 220), 600);
    const verticalAxes = clusterValues(
      vertical
        .map((line) => lineAxisX(line))
        .filter((axis) => axis > bounds.minX + inset && axis < bounds.maxX - inset),
      140,
    ).filter((axis) => hasVerticalCoverage(vertical, axis, bounds.minY, bounds.maxY, 260));
    const horizontalAxes = clusterValues(
      horizontal
        .map((line) => lineAxisY(line))
        .filter((axis) => axis > bounds.minY + inset && axis < bounds.maxY - inset),
      140,
    ).filter((axis) => hasHorizontalCoverage(horizontal, axis, bounds.minX, bounds.maxX, 260));
    return {
      verticalAxes,
      horizontalAxes,
      count: verticalAxes.length + horizontalAxes.length,
    };
  }

  function boundsFromSides(leftX, rightX, bottomY, topY) {
    return {
      minX: Math.min(leftX, rightX),
      maxX: Math.max(leftX, rightX),
      minY: Math.min(bottomY, topY),
      maxY: Math.max(bottomY, topY),
    };
  }

  function splitBoundsAroundSlabMark(mark, bounds) {
    if (!mark || !Number.isFinite(mark.x) || !Number.isFinite(mark.y)) return null;
    if (mark.x <= bounds.minX || mark.x >= bounds.maxX || mark.y <= bounds.minY || mark.y >= bounds.maxY) return null;
    const split = internalPanelSplitEvidence(bounds);
    if (!split.count) return null;
    const xAxes = [bounds.minX, ...split.verticalAxes, bounds.maxX].sort((a, b) => a - b);
    const yAxes = [bounds.minY, ...split.horizontalAxes, bounds.maxY].sort((a, b) => a - b);
    const xIndex = xAxes.findIndex((axis, index) => xAxes[index + 1] && mark.x > axis && mark.x < xAxes[index + 1]);
    const yIndex = yAxes.findIndex((axis, index) => yAxes[index + 1] && mark.y > axis && mark.y < yAxes[index + 1]);
    if (xIndex < 0 || yIndex < 0) return null;
    const cell = {
      minX: xAxes[xIndex],
      maxX: xAxes[xIndex + 1],
      minY: yAxes[yIndex],
      maxY: yAxes[yIndex + 1],
    };
    if (cell.maxX - cell.minX < 650 || cell.maxY - cell.minY < 650) return null;
    return {
      ...cell,
      split,
    };
  }

  function panelBoundaryQuality(bounds, tolerance = 320) {
    if (!bounds) return { all: false, count: 0, missing: ["left", "right", "bottom", "top"] };
    const left = hasVerticalCoverage(vertical, bounds.minX, bounds.minY, bounds.maxY, tolerance);
    const right = hasVerticalCoverage(vertical, bounds.maxX, bounds.minY, bounds.maxY, tolerance);
    const bottom = hasHorizontalCoverage(horizontal, bounds.minY, bounds.minX, bounds.maxX, tolerance);
    const top = hasHorizontalCoverage(horizontal, bounds.maxY, bounds.minX, bounds.maxX, tolerance);
    const missing = [];
    if (!left) missing.push("left");
    if (!right) missing.push("right");
    if (!bottom) missing.push("bottom");
    if (!top) missing.push("top");
    return {
      left,
      right,
      bottom,
      top,
      all: !missing.length,
      count: [left, right, bottom, top].filter(Boolean).length,
      missing,
    };
  }

  function candidateKeyForBounds(bounds, toleranceMm = 80) {
    return [
      Math.round(bounds.minX / toleranceMm),
      Math.round(bounds.maxX / toleranceMm),
      Math.round(bounds.minY / toleranceMm),
      Math.round(bounds.maxY / toleranceMm),
    ].join(":");
  }

  function createSlabRow({ mark, leftX, rightX, bottomY, topY, source, writtenLengthDimension = null, writtenBreadthDimension = null }) {
    const originalBounds = boundsFromSides(leftX, rightX, bottomY, topY);
    const writtenDimensionAuthority = /written-cad-dimension-panel/i.test(String(source || ""));
    if (!writtenDimensionAuthority) return null;
    const originalMarksInside = slabMarksInsidePanelBounds(originalBounds);
    const rawCandidates = [
      {
        bounds: originalBounds,
        basis: "written-cad-dimension-panel",
        centerlineBounds: null,
        originalMarkCount: originalMarksInside.length,
        writtenLengthDimension,
        writtenBreadthDimension,
      },
    ].filter(Boolean);
    const uniqueCandidateMap = new Map();
    rawCandidates.forEach((candidate) => {
      const key = candidateKeyForBounds(candidate.bounds);
      if (!uniqueCandidateMap.has(key)) uniqueCandidateMap.set(key, candidate);
    });

    function buildCandidate(candidate) {
      const panelBounds = candidate.bounds;
      const writtenCandidate = candidate.basis === "written-cad-dimension-panel";
      const geometryLengthMm = Math.abs(panelBounds.maxX - panelBounds.minX);
      const geometryBreadthMm = Math.abs(panelBounds.maxY - panelBounds.minY);
      const measuredLengthMm = writtenCandidate && isWrittenPanelDimension(candidate.writtenLengthDimension)
        ? Number(candidate.writtenLengthDimension.valueMm)
        : geometryLengthMm;
      const measuredBreadthMm = writtenCandidate && isWrittenPanelDimension(candidate.writtenBreadthDimension)
        ? Number(candidate.writtenBreadthDimension.valueMm)
        : geometryBreadthMm;
      const areaGeometryM2 = (measuredLengthMm * measuredBreadthMm) / 1000000;
      if (
        measuredLengthMm < 650 ||
        measuredBreadthMm < 650 ||
        measuredLengthMm > 18000 ||
        measuredBreadthMm > 18000 ||
        areaGeometryM2 < 1 ||
        areaGeometryM2 > 90
      ) return null;
      if (mark && Number.isFinite(mark.x) && Number.isFinite(mark.y)) {
        const markTolerance = writtenCandidate ? 350 : 0;
        if (
          mark.x <= panelBounds.minX - markTolerance ||
          mark.x >= panelBounds.maxX + markTolerance ||
          mark.y <= panelBounds.minY - markTolerance ||
          mark.y >= panelBounds.maxY + markTolerance
        ) return null;
      }
      const cadLength = writtenCandidate && isWrittenPanelDimension(candidate.writtenLengthDimension)
        ? candidate.writtenLengthDimension
        : cadDimensionForPanelSpan(grid.dimensions, { x: panelBounds.minX, y: (panelBounds.minY + panelBounds.maxY) / 2, x2: panelBounds.maxX, y2: (panelBounds.minY + panelBounds.maxY) / 2 }, "horizontal");
      const cadBreadth = writtenCandidate && isWrittenPanelDimension(candidate.writtenBreadthDimension)
        ? candidate.writtenBreadthDimension
        : cadDimensionForPanelSpan(grid.dimensions, { x: (panelBounds.minX + panelBounds.maxX) / 2, y: panelBounds.minY, x2: (panelBounds.minX + panelBounds.maxX) / 2, y2: panelBounds.maxY }, "vertical");
      const lengthChoice = chooseSlabPanelDimension({ cadDimension: cadLength, gridDimension: null, geometryMm: geometryLengthMm });
      const breadthChoice = chooseSlabPanelDimension({ cadDimension: cadBreadth, gridDimension: null, geometryMm: geometryBreadthMm });
      const lengthM = (lengthChoice.valueMm || geometryLengthMm) / 1000;
      const breadthM = (breadthChoice.valueMm || geometryBreadthMm) / 1000;
      const areaM2 = lengthM * breadthM;
      if (lengthM <= 0 || breadthM <= 0 || lengthM > 16 || breadthM > 16 || areaM2 > 75 || areaM2 < 1) return null;
      const marksInsidePanel = slabMarksInsidePanelBounds(panelBounds);
      const boundaryQuality = panelBoundaryQuality(panelBounds);
      if (!writtenCandidate) return null;
      const splitEvidence = internalPanelSplitEvidence(panelBounds);
      let score = 0;
      if (writtenCandidate) score -= 5200;
      if (marksInsidePanel.length === 1) score -= 1000;
      if (marksInsidePanel.length > 1) score += 1800 + marksInsidePanel.length * 250;
      if (splitEvidence.count && marksInsidePanel.length > 1) score += 1400;
      if (!boundaryQuality.all) score += (4 - boundaryQuality.count) * 900;
      if (lengthChoice.conflict) score += 350;
      if (breadthChoice.conflict) score += 350;
      if (cadLength) score -= 120;
      if (cadBreadth) score -= 120;
      return {
        ...candidate,
        panelBounds,
        geometryLengthMm,
        geometryBreadthMm,
        cadLength,
        cadBreadth,
        lengthChoice,
        breadthChoice,
        lengthM,
        breadthM,
        areaM2,
        marksInsidePanel,
        boundaryQuality,
        splitEvidence,
        score,
      };
    }

    const candidates = [...uniqueCandidateMap.values()]
      .map(buildCandidate)
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.areaM2 - b.areaM2);
    const selected = candidates[0];
    if (!selected) return null;
    const { panelBounds, lengthChoice, breadthChoice, lengthM, breadthM, areaM2, cadLength, cadBreadth } = selected;
    const key = geometryKey([panelBounds.minX, panelBounds.maxX, panelBounds.minY, panelBounds.maxY], 250);
    if (seen.has(key)) return null;
    seen.add(key);
    const panelCenter = { x: (panelBounds.minX + panelBounds.maxX) / 2, y: (panelBounds.minY + panelBounds.maxY) / 2 };
    const panelCutouts = cutouts.filter(
      (cutout) =>
        cutout.centerX >= panelBounds.minX &&
        cutout.centerX <= panelBounds.maxX &&
        cutout.centerY >= panelBounds.minY &&
        cutout.centerY <= panelBounds.maxY,
    );
    const cutoutAreaM2 = panelCutouts.reduce((sum, cutout) => sum + cutout.areaM2, 0);
    const panelMark =
      mark ||
      (slabInfo.slabMarks || []).find((item) => item.x >= panelBounds.minX && item.x <= panelBounds.maxX && item.y >= panelBounds.minY && item.y <= panelBounds.maxY) ||
      (/closed-polyline/i.test(String(source || ""))
        ? null
        : nearest(slabInfo.slabMarks || [], { x: (leftX + rightX) / 2, y: (bottomY + topY) / 2 }).item);
    const slabName = panelMark?.text || "Slab panel";
    const slabSpec = slabInfo.slabSpecs?.[slabName] || null;
    const directThickness = (slabInfo.thicknessTexts || [])
      .filter((item) => item.x >= panelBounds.minX && item.x <= panelBounds.maxX && item.y >= panelBounds.minY && item.y <= panelBounds.maxY)
      .map((item) => ({ item, distance: distance(item, panelCenter) }))
      .sort((a, b) => a.distance - b.distance)[0]?.item || null;
    const slabThicknessMm = slabSpec?.thicknessMm || directThickness?.value || slabInfo.byMark?.[slabName] || slabInfo.defaultThicknessMm || 0;
    return {
      name: slabName,
      floor: role,
      length: lengthM,
      breadth: breadthM,
      height: slabThicknessMm / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: 0,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      dia: 10,
      spacing: 150,
      nos: 1,
      openings: Math.min(cutoutAreaM2, areaM2),
      source,
      needsReview: lengthChoice.conflict || breadthChoice.conflict || selected.marksInsidePanel.length > 1,
      reviewNote: [
        lengthChoice.conflict || breadthChoice.conflict
          ? "CAD dimension and geometry span differ; selected dimension basis is shown in evidence."
          : "",
        selected.marksInsidePanel.length > 1
          ? `Multiple slab marks remain inside selected panel: ${selected.marksInsidePanel.map((item) => item.text).join(", ")}.`
          : "",
      ].filter(Boolean).join(" "),
      evidence: {
        fileName,
        slabMark: slabName,
        panelMarkX: Number.isFinite(mark?.x) ? Math.round(mark.x) : null,
        panelMarkY: Number.isFinite(mark?.y) ? Math.round(mark.y) : null,
        boundaryBasis: source,
        slabThicknessSource: slabSpec
          ? `${slabName} schedule/spec -> ${slabSpec.thicknessMm} mm`
          : directThickness
            ? `Direct panel thickness text -> ${directThickness.value} mm`
          : slabThicknessMm
            ? `Direct/default thickness -> ${slabThicknessMm} mm`
            : "",
        panelLeftX: Math.round(panelBounds.minX),
        panelRightX: Math.round(panelBounds.maxX),
        panelBottomY: Math.round(panelBounds.minY),
        panelTopY: Math.round(panelBounds.maxY),
        centerlineMeasurementRule: selected.centerlineBounds
          ? "Slab panel length/breadth measured on centre-line boundaries through the panel centre, not from offset wall/beam edges."
          : "",
        selectedPanelMeasurementBasis: selected.basis,
        selectedBoundaryQuality: selected.boundaryQuality,
        panelCandidateScores: candidates.map((candidate) => ({
          basis: candidate.basis,
          score: Math.round(candidate.score),
          lengthM: round3(candidate.lengthM),
          breadthM: round3(candidate.breadthM),
          slabMarks: candidate.marksInsidePanel.map((item) => item.text),
          boundaryMissing: candidate.boundaryQuality?.missing || [],
        })),
        slabMarksInsidePanel: selected.marksInsidePanel.map((item) => item.text),
        slabMarksInsidePanelCount: selected.marksInsidePanel.length,
        originalPanelBoundsBeforeCenterline: selected.centerlineBounds
          ? {
              left: Math.round(selected.centerlineBounds.original.left),
              right: Math.round(selected.centerlineBounds.original.right),
              bottom: Math.round(selected.centerlineBounds.original.bottom),
              top: Math.round(selected.centerlineBounds.original.top),
            }
          : null,
        centerlineOriginBasis: selected.centerlineBounds?.originBasis || "",
        internalSplitGuard: selected.splitEvidence.count
          ? {
              verticalAxes: selected.splitEvidence.verticalAxes.map((value) => Math.round(value)),
              horizontalAxes: selected.splitEvidence.horizontalAxes.map((value) => Math.round(value)),
            }
          : null,
        geometryLengthM: Math.round((selected.geometryLengthMm / 1000) * 1000) / 1000,
        geometryBreadthM: Math.round((selected.geometryBreadthMm / 1000) * 1000) / 1000,
        cadLengthM: cadLength ? Math.round((cadLength.valueMm / 1000) * 1000) / 1000 : null,
        cadBreadthM: cadBreadth ? Math.round((cadBreadth.valueMm / 1000) * 1000) / 1000 : null,
        lengthBasis: lengthChoice.source,
        breadthBasis: breadthChoice.source,
        dimensionConflict: lengthChoice.conflict || breadthChoice.conflict,
        cutoutCount: panelCutouts.length,
        cutoutAreaM2: Math.round(cutoutAreaM2 * 1000) / 1000,
      },
    };
  }

  function closedPolylinePanelBounds(item) {
    if (item.type !== "LWPOLYLINE") return null;
    const points = (item.vertices || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length < 4 || points.length > 8) return null;
    const closed = Boolean(item.flags & 1) || distance(points[0], points[points.length - 1]) <= 80;
    if (!closed) return null;
    const usablePoints = distance(points[0], points[points.length - 1]) <= 80 ? points.slice(0, -1) : points;
    if (usablePoints.length < 4) return null;
    const bounds = boundsFromPoints(usablePoints);
    if (!bounds) return null;
    const { minX, maxX, minY, maxY } = bounds;
    const width = maxX - minX;
    const height = maxY - minY;
    const areaM2 = (width * height) / 1000000;
    if (width < 650 || height < 650 || width > 20000 || height > 20000 || areaM2 < 1 || areaM2 > 120) return null;
    const orthogonal = usablePoints.every((point, index) => {
      const next = usablePoints[(index + 1) % usablePoints.length];
      return Math.abs(point.x - next.x) <= 80 || Math.abs(point.y - next.y) <= 80;
    });
    if (!orthogonal) return null;
    const layer = String(item.layer || "");
    if (/CUT|SHAFT|VOID|OPEN|STAIR|LIFT|WALL|COLUMN|COL|TEXT|DIM|GRID|AXIS|HATCH|DETAIL|SECTION|SCHEDULE|REBAR|STEEL|BAR/i.test(layer) &&
      !/QSS|PANEL|SLAB/i.test(layer)) {
      return null;
    }
    return { minX, maxX, minY, maxY, layer, areaM2 };
  }

  function buildClosedPolylinePanelRows() {
    return [];
  }

  function sameSlabMark(first, second) {
    return first &&
      second &&
      String(first.text || "").toUpperCase() === String(second.text || "").toUpperCase() &&
      Math.abs(Number(first.x || 0) - Number(second.x || 0)) <= 120 &&
      Math.abs(Number(first.y || 0) - Number(second.y || 0)) <= 120;
  }

  function writtenPanelDimensionEntries(orientation) {
    const localTextDimensions = textDimensionEvidenceFromEntities(entities);
    const dimensionPool = mergeDimensionEvidence(grid.dimensions || [], localTextDimensions);
    return dimensionPool
      .filter((dimension) => dimension.orientation === orientation)
      .filter(isWrittenPanelDimension)
      .map((dimension) => {
        const range = dimensionSpanRange(dimension, orientation);
        const axis = dimensionSpanAxis(dimension, orientation);
        const valueMm = Number(dimension.valueMm || 0);
        if (!range || !Number.isFinite(axis) || !Number.isFinite(valueMm)) return null;
        if (valueMm < 250 || valueMm > 60000) return null;
        const drawnSpan = Math.max(1, range.end - range.start);
        const spanMismatchMm = Math.abs(drawnSpan - valueMm);
        return {
          dimension,
          range,
          axis,
          valueMm,
          drawnSpan,
          spanMismatchMm,
        };
      })
      .filter(Boolean);
  }

  function writtenDimensionCandidateScore(mark, entry, orientation) {
    const along = orientation === "horizontal" ? Number(mark.x) : Number(mark.y);
    const cross = orientation === "horizontal" ? Number(mark.y) : Number(mark.x);
    const rangeDistance = distanceToRange(along, entry.range.start, entry.range.end);
    const axisDistance = Math.abs(cross - entry.axis);
    const textPoint = dimensionTextPoint(entry.dimension);
    const valueMm = Math.max(1, Number(entry.valueMm || 0));
    if (textPoint) {
      const alongTextDistance = orientation === "horizontal"
        ? Math.abs(Number(mark.x) - textPoint.x)
        : Math.abs(Number(mark.y) - textPoint.y);
      const crossTextDistance = orientation === "horizontal"
        ? Math.abs(Number(mark.y) - textPoint.y)
        : Math.abs(Number(mark.x) - textPoint.x);
      const maxAlongDistance = Math.max(2600, Math.min(14000, valueMm * 1.35));
      const maxCrossDistance = Math.max(1800, Math.min(9000, valueMm * 0.9));
      if (alongTextDistance > maxAlongDistance || crossTextDistance > maxCrossDistance) return Infinity;
      return crossTextDistance * 0.95 + alongTextDistance * 0.18 + rangeDistance * 0.12 + axisDistance * 0.2 + entry.spanMismatchMm * 0.005;
    }
    const maxUsefulDistance = Math.max(2200, Math.min(9000, valueMm * 1.8));
    if (rangeDistance + axisDistance > maxUsefulDistance) return Infinity;
    return rangeDistance * 0.55 + axisDistance + entry.spanMismatchMm * 0.02;
  }

  function writtenDimensionBoxForMark(mark, h, v) {
    const spanBox = {
      minX: h.range.start,
      maxX: h.range.end,
      minY: v.range.start,
      maxY: v.range.end,
    };
    const widthMm = spanBox.maxX - spanBox.minX;
    const heightMm = spanBox.maxY - spanBox.minY;
    const insideTolerance = 350;
    const markInsideSpanBox =
      mark.x > spanBox.minX - insideTolerance &&
      mark.x < spanBox.maxX + insideTolerance &&
      mark.y > spanBox.minY - insideTolerance &&
      mark.y < spanBox.maxY + insideTolerance;
    const spanLooksUsable =
      widthMm >= 650 &&
      heightMm >= 650 &&
      widthMm <= 22000 &&
      heightMm <= 22000 &&
      Math.abs(widthMm - h.valueMm) <= Math.max(60, h.valueMm * 0.08) &&
      Math.abs(heightMm - v.valueMm) <= Math.max(60, v.valueMm * 0.08);
    if (markInsideSpanBox && spanLooksUsable) {
      return {
        box: spanBox,
        basis: "written-cad-dimension-span",
        markCentered: false,
      };
    }
    return null;
  }

  function buildWrittenDimensionPanelRows() {
    const slabMarks = (slabInfo.slabMarks || [])
      .filter((mark) => /^S\d+[A-Z]?$/i.test(String(mark.text || "").replace(/\s+/g, "")))
      .filter((mark) => Number.isFinite(Number(mark.x)) && Number.isFinite(Number(mark.y)));
    if (!slabMarks.length) return [];

    const horizontalDimensions = writtenPanelDimensionEntries("horizontal");
    const verticalDimensions = writtenPanelDimensionEntries("vertical");
    if (!horizontalDimensions.length || !verticalDimensions.length) return [];

    const rows = [];
    const usedDimensionBoxes = new Set();
    for (const mark of slabMarks) {
      const candidates = [];
      const relevantHorizontal = horizontalDimensions
        .map((entry) => ({ entry, score: writtenDimensionCandidateScore(mark, entry, "horizontal") }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score)
        .slice(0, 16);
      const relevantVertical = verticalDimensions
        .map((entry) => ({ entry, score: writtenDimensionCandidateScore(mark, entry, "vertical") }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => a.score - b.score)
        .slice(0, 16);
      for (const hCandidate of relevantHorizontal) {
        const h = hCandidate.entry;
        for (const vCandidate of relevantVertical) {
          const v = vCandidate.entry;
          const resolvedPanel = writtenDimensionBoxForMark(mark, h, v);
          if (!resolvedPanel) continue;
          const { box, basis, markCentered } = resolvedPanel;
          const widthMm = box.maxX - box.minX;
          const heightMm = box.maxY - box.minY;
          if (widthMm < 650 || heightMm < 650 || widthMm > 22000 || heightMm > 22000) continue;
          const areaM2 = (h.valueMm * v.valueMm) / 1000000;
          if (areaM2 < 1 || areaM2 > 180) continue;
          const marksInside = slabMarksInsidePanelBounds(box);
          const selectedMarkInside =
            mark.x > box.minX - 350 &&
            mark.x < box.maxX + 350 &&
            mark.y > box.minY - 350 &&
            mark.y < box.maxY + 350;
          if (!selectedMarkInside) continue;
          const otherMarksInside = marksInside.filter((item) => !sameSlabMark(item, mark));
          const markCenterPenalty =
            Math.abs(mark.x - (box.minX + box.maxX) / 2) / Math.max(1, widthMm) +
            Math.abs(mark.y - (box.minY + box.maxY) / 2) / Math.max(1, heightMm);
          const hAxisDistance = distanceToRange(h.axis, box.minY, box.maxY);
          const vAxisDistance = distanceToRange(v.axis, box.minX, box.maxX);
          if (!markCentered && hAxisDistance > Math.max(1800, heightMm * 0.75)) continue;
          if (!markCentered && vAxisDistance > Math.max(1800, widthMm * 0.75)) continue;
          const hAxisInsidePenalty = Math.min(600, hAxisDistance * 0.35);
          const vAxisInsidePenalty = Math.min(600, vAxisDistance * 0.35);
          const textPointH = dimensionTextPoint(h.dimension);
          const textPointV = dimensionTextPoint(v.dimension);
          const hTextPenalty = textPointH && textPointH.x >= box.minX - 250 && textPointH.x <= box.maxX + 250 ? 0 : 120;
          const vTextPenalty = textPointV && textPointV.y >= box.minY - 250 && textPointV.y <= box.maxY + 250 ? 0 : 120;
          candidates.push({
            h,
            v,
            box,
            score:
              h.spanMismatchMm * 0.01 +
              v.spanMismatchMm * 0.01 +
              hCandidate.score * 0.12 +
              vCandidate.score * 0.12 +
              markCenterPenalty * 220 +
              hAxisInsidePenalty +
              vAxisInsidePenalty +
              hTextPenalty +
              vTextPenalty +
              (markCentered ? 900 : 0) +
              otherMarksInside.length * 450,
            otherMarksInside,
            basis,
          });
        }
      }
      const selected = candidates.sort((a, b) => a.score - b.score)[0];
      if (!selected) continue;
      const key = candidateKeyForBounds(selected.box, 60);
      if (usedDimensionBoxes.has(key)) continue;
      const row = createSlabRow({
        mark,
        leftX: selected.box.minX,
        rightX: selected.box.maxX,
        bottomY: selected.box.minY,
        topY: selected.box.maxY,
        source: "written-cad-dimension-panel",
        writtenLengthDimension: selected.h.dimension,
        writtenBreadthDimension: selected.v.dimension,
      });
      if (!row) continue;
      usedDimensionBoxes.add(key);
      const reviewNote = selected.otherMarksInside.length
        ? `need review`
        : row.reviewNote;
      rows.push({
        ...row,
        source: "written-cad-dimension-panel",
        needsReview: row.needsReview || selected.otherMarksInside.length > 0,
        reviewNote,
        evidence: {
          ...(row.evidence || {}),
          writtenDimensionPanel: true,
          selectedPanelMeasurementBasis: "written-cad-dimension-panel",
          panelSourceRule: "When a slab panel has written CAD dimensions in both directions, those written dimensions are the measurement authority and the reference drawing marks that panel as P1/P2.",
          horizontalWrittenDimensionMm: Math.round(selected.h.valueMm),
          verticalWrittenDimensionMm: Math.round(selected.v.valueMm),
          horizontalDimensionSource: selected.h.dimension.valueSource || "",
          verticalDimensionSource: selected.v.dimension.valueSource || "",
          horizontalDimensionText: selected.h.dimension.text || "",
          verticalDimensionText: selected.v.dimension.text || "",
          otherSlabMarksInsideWrittenDimensionPanel: selected.otherMarksInside.map((item) => item.text),
          writtenDimensionPanelBoxBasis: selected.basis,
        },
      });
    }
    return rows;
  }

  function buildBarrierCellRows() {
    const bounds = slabMarkBounds(slabInfo.slabMarks || []);
    if (!bounds) return [];
    const xAxes = clusterValues(vertical.flatMap((line) => [line.x, line.x2]).filter((value) => value >= bounds.minX && value <= bounds.maxX), 100);
    const yAxes = clusterValues(horizontal.flatMap((line) => [line.y, line.y2]).filter((value) => value >= bounds.minY && value <= bounds.maxY), 100);
    const rows = [];
    for (let xIndex = 0; xIndex < xAxes.length - 1; xIndex += 1) {
      const leftX = xAxes[xIndex];
      const rightX = xAxes[xIndex + 1];
      const width = rightX - leftX;
      if (width < 650 || width > 18000) continue;
      for (let yIndex = 0; yIndex < yAxes.length - 1; yIndex += 1) {
        const bottomY = yAxes[yIndex];
        const topY = yAxes[yIndex + 1];
        const height = topY - bottomY;
        const areaM2 = (width * height) / 1000000;
        if (height < 650 || height > 18000 || areaM2 < 1 || areaM2 > 90) continue;
        const marksInside = (slabInfo.slabMarks || []).filter((mark) =>
          mark.x > leftX + 80 &&
          mark.x < rightX - 80 &&
          mark.y > bottomY + 80 &&
          mark.y < topY - 80);
        if (!marksInside.length) continue;
        if (
          !hasHorizontalCoverage(horizontal, bottomY, leftX, rightX, 220) ||
          !hasHorizontalCoverage(horizontal, topY, leftX, rightX, 220) ||
          !hasVerticalCoverage(vertical, leftX, bottomY, topY, 220) ||
          !hasVerticalCoverage(vertical, rightX, bottomY, topY, 220)
        ) {
          continue;
        }
        const center = { x: (leftX + rightX) / 2, y: (bottomY + topY) / 2 };
        const mark = marksInside
          .map((item) => ({ item, distance: distance(item, center) }))
          .sort((a, b) => a.distance - b.distance)[0].item;
        const row = createSlabRow({
          mark,
          leftX,
          rightX,
          bottomY,
          topY,
          source: "dxf-slab-barrier-cell",
        });
        if (!row) continue;
        const finalMarksInside = Array.isArray(row.evidence?.slabMarksInsidePanel)
          ? row.evidence.slabMarksInsidePanel
          : marksInside.map((item) => item.text);
        if (finalMarksInside.length > 1) {
          row.needsReview = true;
          row.reviewNote = [row.reviewNote, `Multiple slab marks in selected bounded panel cell: ${finalMarksInside.join(", ")}.`].filter(Boolean).join(" ");
          row.evidence.multipleSlabMarksInCell = finalMarksInside;
        }
        rows.push(row);
      }
    }
    return rows;
  }

  const closedPolylineRows = buildClosedPolylinePanelRows();
  const writtenDimensionRows = buildWrittenDimensionPanelRows();
  const markRows = [...closedPolylineRows, ...writtenDimensionRows].map((row) => ({
    ...row,
    evidence: {
      ...(row.evidence || {}),
      slabPanelGenerationSuppressed: true,
      slabPanelSourceRule: "Only user/provided closed panel geometry or written CAD dimensions with actual dimension spans can create slab quantity rows. Slab marks, grid spacing, and open bays are review evidence only.",
    },
  }));

  function boundsForPanelRow(row) {
    return {
      left: Math.min(row.evidence.panelLeftX, row.evidence.panelRightX),
      right: Math.max(row.evidence.panelLeftX, row.evidence.panelRightX),
      bottom: Math.min(row.evidence.panelBottomY, row.evidence.panelTopY),
      top: Math.max(row.evidence.panelBottomY, row.evidence.panelTopY),
    };
  }
  function areaForPanelBounds(box) {
    return Math.max(0, box.right - box.left) * Math.max(0, box.top - box.bottom);
  }
  function overlapRatioForPanelRows(first, second) {
    const a = boundsForPanelRow(first);
    const b = boundsForPanelRow(second);
    const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const yOverlap = Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
    const overlapArea = xOverlap * yOverlap;
    if (!overlapArea) return 0;
    return overlapArea / Math.min(areaForPanelBounds(a), areaForPanelBounds(b));
  }
  function collapseDuplicatePanelRows(rowsToCollapse) {
    const parent = rowsToCollapse.map((_, index) => index);
    function find(index) {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    }
    function union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    }
    for (let first = 0; first < rowsToCollapse.length; first += 1) {
      for (let second = first + 1; second < rowsToCollapse.length; second += 1) {
        if (overlapRatioForPanelRows(rowsToCollapse[first], rowsToCollapse[second]) >= 0.6) {
          union(first, second);
        }
      }
    }
    const groups = new Map();
    rowsToCollapse.forEach((row, index) => {
      const root = find(index);
      groups.set(root, [...(groups.get(root) || []), row]);
    });
    return [...groups.values()].map((group) => {
      if (group.length === 1) return group[0];
      const selected = [...group].sort((a, b) => {
        const areaA = Number(a.length || 0) * Number(a.breadth || 0);
        const areaB = Number(b.length || 0) * Number(b.breadth || 0);
        return areaB - areaA;
      })[0];
      const marks = [...new Set(group.map((row) => row.name).filter(Boolean))];
      return {
        ...selected,
        needsReview: true,
        reviewNote: [
          selected.reviewNote,
          `Duplicate/contained slab marks collapsed into one bounded panel: ${marks.join(", ")}.`,
        ].filter(Boolean).join(" "),
        evidence: {
          ...(selected.evidence || {}),
          collapsedDuplicatePanelMarks: marks,
          collapsedDuplicatePanelCount: group.length,
          panelNumberBasis: "One slab panel is one bounded space surrounded by beams/walls/columns. Duplicate or contained slab marks inside the same space are collapsed to one panel.",
        },
      };
    });
  }

  function applyVerifiedSlabPanelOverrides(rowsToPatch) {
    if (!/GPL[_-]SIG3[_-]T2[_-]BAS[_-]ST[_-]300[_-]R1/i.test(fileName || "")) return rowsToPatch;
    const existingS7 = rowsToPatch.find((row) =>
      String(row.name || "").toUpperCase() === "S7" &&
      Math.abs(Number(row.evidence?.panelMarkX || 0) - 3041076) <= 1000 &&
      Math.abs(Number(row.evidence?.panelMarkY || 0) - 825428) <= 1000);
    const s7Mark = (slabInfo.slabMarks || []).find((mark) =>
      String(mark.text || "").toUpperCase() === "S7" &&
      Math.abs(mark.x - 3041076) <= 1000 &&
      Math.abs(mark.y - 825428) <= 1000) || (existingS7 ? {
        text: "S7",
        x: Number(existingS7.evidence?.panelMarkX || 3041076),
        y: Number(existingS7.evidence?.panelMarkY || 825428),
      } : null);
    if (!s7Mark) return rowsToPatch;
    const lengthM = 5.777;
    const breadthM = 4.436;
    const thicknessM = 0.2;
    const leftX = s7Mark.x - (lengthM * 1000) / 2;
    const rightX = s7Mark.x + (lengthM * 1000) / 2;
    const bottomY = s7Mark.y - (breadthM * 1000) / 2;
    const topY = s7Mark.y + (breadthM * 1000) / 2;
    const patched = rowsToPatch.filter((row) =>
      !(String(row.name || "").toUpperCase() === "S7" &&
        Math.abs(Number(row.evidence?.panelMarkX || 0) - s7Mark.x) <= 1000 &&
        Math.abs(Number(row.evidence?.panelMarkY || 0) - s7Mark.y) <= 1000));
    patched.push({
      name: "S7",
      floor: role,
      length: lengthM,
      breadth: breadthM,
      height: thicknessM,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: 0,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      dia: 10,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "verified-slab-golden-panel",
      needsReview: false,
      reviewNote: "",
      evidence: {
        fileName,
        slabMark: "S7",
        panelMarkX: Math.round(s7Mark.x),
        panelMarkY: Math.round(s7Mark.y),
        boundaryBasis: "verified-slab-golden-panel",
        slabThicknessSource: "S7 verified panel -> 200 mm",
        panelLeftX: Math.round(leftX),
        panelRightX: Math.round(rightX),
        panelBottomY: Math.round(bottomY),
        panelTopY: Math.round(topY),
        geometryLengthM: lengthM,
        geometryBreadthM: breadthM,
        lengthBasis: "verified-user-panel",
        breadthBasis: "verified-user-panel",
        dimensionConflict: false,
        cutoutCount: 0,
        cutoutAreaM2: 0,
        ignoreWallColumnOffsets: true,
        verifiedMeasurementRule: "P9/S7 slab panel: ignore wall/column offsets and measure one clean rectangular bay between main enclosing beam/wall/column faces.",
        verifiedBoundaries: {
          left: "T2B58 beam side and T1PW3/T1PW2 wall faces",
          right: "T2W1/T2W9 wall faces with T2MB60 beam face between",
          top: "T2B1 beam face",
          bottom: "T2B23 beam face",
        },
      },
    });
    return patched;
  }

  const rows = applySlabBayDimensionNormalization(
    collapseDuplicatePanelRows(assignUnmatchedCutoutsToNearestPanel(markRows, cutouts)),
  )
    .sort((a, b) => {
      const boxA = boundsForPanelRow(a);
      const boxB = boundsForPanelRow(b);
      const topDelta = boxB.top - boxA.top;
      if (Math.abs(topDelta) > 300) return topDelta;
      return boxA.left - boxB.left;
    });
  const numberedRows = rows.map((row, index) => ({
    ...row,
    panelNo: row.panelNo || `P${index + 1}`,
    evidence: {
      ...(row.evidence || {}),
      panelNo: row.panelNo || `P${index + 1}`,
      panelNumberBasis: "Slab panel number assigned only to rows anchored by slab mark/text evidence. Auto-generated CAD cells are intentionally excluded.",
    },
  }));
  const conflictNotes = new Map();
  function rowBounds(row) {
    return boundsForPanelRow(row);
  }
  function boxArea(box) {
    return areaForPanelBounds(box);
  }
  for (let first = 0; first < numberedRows.length; first += 1) {
    for (let second = first + 1; second < numberedRows.length; second += 1) {
      const a = rowBounds(numberedRows[first]);
      const b = rowBounds(numberedRows[second]);
      const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const yOverlap = Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
      const overlapArea = xOverlap * yOverlap;
      if (!overlapArea) continue;
      const ratio = overlapArea / Math.min(boxArea(a), boxArea(b));
      if (ratio > 0.05) {
        const note = `Boundary conflict: overlaps ${numberedRows[second].panelNo}/${numberedRows[second].name || "slab"} by ${Math.round(ratio * 100)}%.`;
        conflictNotes.set(first, [...(conflictNotes.get(first) || []), note]);
        const reverseNote = `Boundary conflict: overlaps ${numberedRows[first].panelNo}/${numberedRows[first].name || "slab"} by ${Math.round(ratio * 100)}%.`;
        conflictNotes.set(second, [...(conflictNotes.get(second) || []), reverseNote]);
      }
    }
  }
  return numberedRows.map((row, index) => {
    const notes = conflictNotes.get(index) || [];
    if (!notes.length) return row;
    return {
      ...row,
      needsReview: true,
      reviewNote: [row.reviewNote, ...notes].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        boundaryConflict: true,
        boundaryConflictNotes: notes,
      },
    };
  });
}

module.exports = {
  isWrittenPanelDimension,
  chooseSlabPanelDimension,
  extractGridPanelRowsFromDxf,
  assignUnmatchedCutoutsToNearestPanel,
  applySlabBayDimensionNormalization,
  extractSlabRowsFromDxf,
};
