"use strict";
const { cleanCadText } = require("../cad/dxf-reader.js");
const { solveSlabPanelsByFaceWalking } = require("./face-walker.js");
const { extractCadDimensions, validateSpanDimension } = require("../cad/dimension-validator.js");
const {
  buildGridRegistry,
  extractBoundarySegments,
  extractCutoutVoids,
  extractSupportBoxes,
  stitchBoundarySegments,
} = require("./boundary-graph.js");
const { mapReferencePanelsToFaces, readReferenceMarks } = require("../output/reference-readback.js");

const DEFAULT_SLAB_THICKNESS_M = 0.15;

function round3(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
}

function snap(value, toleranceMm) {
  return Math.round(Number(value || 0) / toleranceMm) * toleranceMm;
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function mergedLength(intervals) {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) current = { ...interval };
    else if (interval.start <= current.end + 80) current.end = Math.max(current.end, interval.end);
    else {
      total += current.end - current.start;
      current = { ...interval };
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function lineInterval(boundary) {
  if (boundary.orientation === "H") {
    return {
      axis: "H",
      fixed: (boundary.y1 + boundary.y2) / 2,
      start: Math.min(boundary.x1, boundary.x2),
      end: Math.max(boundary.x1, boundary.x2),
      edgeStyle: boundary.edgeStyle || "",
      lineType: boundary.lineType || "",
    };
  }
  return {
    axis: "V",
    fixed: (boundary.x1 + boundary.x2) / 2,
    start: Math.min(boundary.y1, boundary.y2),
    end: Math.max(boundary.y1, boundary.y2),
    edgeStyle: boundary.edgeStyle || "",
    lineType: boundary.lineType || "",
  };
}

function pointKey(x, y, toleranceMm) {
  return `${snap(x, toleranceMm)}:${snap(y, toleranceMm)}`;
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
  return { eIndex, hIndex, label: `${eBand}/${hBand}` };
}

function buildCadTopologyGraph(entities, options = {}) {
  const nodeToleranceMm = Number(options.nodeToleranceMm || 100);
  const boundarySegments = extractBoundarySegments(entities);
  const supportBoxes = extractSupportBoxes(entities);
  const stitched = stitchBoundarySegments(boundarySegments, supportBoxes, options.stitching || {});
  const boundaries = [...boundarySegments, ...stitched]
    .filter((boundary) => boundary.verified && ["beam_face", "support_face", "cutout_boundary"].includes(boundary.type))
    .filter((boundary) => boundary.orientation === "H" || boundary.orientation === "V")
    .map((boundary) => ({ ...boundary, interval: lineInterval(boundary) }));

  const horizontal = boundaries.filter((boundary) => boundary.orientation === "H");
  const vertical = boundaries.filter((boundary) => boundary.orientation === "V");
  const nodes = new Map();

  function addNode(x, y, source) {
    const key = pointKey(x, y, nodeToleranceMm);
    if (!nodes.has(key)) nodes.set(key, { key, x: snap(x, nodeToleranceMm), y: snap(y, nodeToleranceMm), sources: new Set() });
    nodes.get(key).sources.add(source);
    return nodes.get(key);
  }

  for (const boundary of boundaries) {
    if (boundary.orientation === "H") {
      addNode(boundary.interval.start, boundary.interval.fixed, "endpoint");
      addNode(boundary.interval.end, boundary.interval.fixed, "endpoint");
    } else {
      addNode(boundary.interval.fixed, boundary.interval.start, "endpoint");
      addNode(boundary.interval.fixed, boundary.interval.end, "endpoint");
    }
  }

  for (const h of horizontal) {
    for (const v of vertical) {
      if (
        v.interval.fixed >= h.interval.start - nodeToleranceMm &&
        v.interval.fixed <= h.interval.end + nodeToleranceMm &&
        h.interval.fixed >= v.interval.start - nodeToleranceMm &&
        h.interval.fixed <= v.interval.end + nodeToleranceMm
      ) {
        addNode(v.interval.fixed, h.interval.fixed, "intersection");
      }
    }
  }

  const xCoords = [...new Set([...nodes.values()].map((node) => node.x))].sort((a, b) => a - b);
  const yCoords = [...new Set([...nodes.values()].map((node) => node.y))].sort((a, b) => b - a);
  return { nodes: [...nodes.values()], xCoords, yCoords, boundaries, horizontal, vertical, supportBoxes };
}

function sideCoverage(boundaries, side, box, toleranceMm = 180) {
  if (side === "top" || side === "bottom") {
    const y = side === "top" ? box.maxY : box.minY;
    const intervals = boundaries
      .filter((boundary) => boundary.orientation === "H")
      .filter((boundary) => Math.abs(boundary.interval.fixed - y) <= toleranceMm)
      .map((boundary) => ({
        start: Math.max(boundary.interval.start, box.minX),
        end: Math.min(boundary.interval.end, box.maxX),
      }));
    return mergedLength(intervals) / Math.max(box.maxX - box.minX, 1);
  }
  const x = side === "left" ? box.minX : box.maxX;
  const intervals = boundaries
    .filter((boundary) => boundary.orientation === "V")
    .filter((boundary) => Math.abs(boundary.interval.fixed - x) <= toleranceMm)
    .map((boundary) => ({
      start: Math.max(boundary.interval.start, box.minY),
      end: Math.min(boundary.interval.end, box.maxY),
    }));
  return mergedLength(intervals) / Math.max(box.maxY - box.minY, 1);
}

function weakSideEvidence({ cell, missingSide, cellsByBand, gridBand }) {
  const evidence = [];
  if (!gridBand.label.includes("outside")) evidence.push("grid_band");
  const peerCells = cellsByBand.get(gridBand.label) || [];
  const sameDimensionPeer = peerCells.some((peer) => {
    if (peer === cell) return false;
    const sameWidth = Math.abs((peer.box.maxX - peer.box.minX) - (cell.box.maxX - cell.box.minX)) <= 150;
    const sameHeight = Math.abs((peer.box.maxY - peer.box.minY) - (cell.box.maxY - cell.box.minY)) <= 150;
    return sameWidth || sameHeight;
  });
  if (sameDimensionPeer) evidence.push("adjacent_or_repeated_cell_dimension");
  const weakButPresent = Number(cell.coverage[missingSide] || 0) >= 0.35;
  if (weakButPresent) evidence.push("partial_boundary_trace");
  return evidence;
}

function mappedReferencePanelToSlabPanel(mapped) {
  const lengthM = Number(mapped.lengthM || ((mapped.box.maxX - mapped.box.minX) / 1000));
  const breadthM = Number(mapped.breadthM || ((mapped.box.maxY - mapped.box.minY) / 1000));
  const netAreaSqm = Number(mapped.netAreaSqm || mapped.areaSqm || (lengthM * breadthM));
  const thicknessM = Number(mapped.thicknessM || DEFAULT_SLAB_THICKNESS_M);
  return {
    panel: mapped.id,
    referenceLabel: mapped.label,
    status: "reference-readback",
    gridBand: "reference P-panel",
    lengthM: round3(lengthM),
    breadthM: round3(breadthM),
    thicknessM,
    geometryLengthM: round3(lengthM),
    geometryBreadthM: round3(breadthM),
    grossAreaSqm: round3(mapped.grossAreaSqm || netAreaSqm),
    boundingBoxAreaSqm: round3(lengthM * breadthM),
    geometryAreaSqm: round3(netAreaSqm),
    cutoutAreaSqm: round3(mapped.cutoutAreaSqm || 0),
    netAreaSqm: round3(netAreaSqm),
    concreteCum: round3(netAreaSqm * thicknessM),
    box: mapped.box,
    polygon: mapped.polygon,
    validationGates: {
      referenceReadback: mapped.source || mapped.face?.source || "qss-closed-panel-polyline",
      boundaryEvidence: mapped.boundaryEvidence || null,
    },
    remarks: mapped.remarks || "Reference P mark measured from QSS closed panel polyline.",
  };
}

function referenceReadbackTotals(panels, reviewCells) {
  return {
    directPanels: panels.length,
    inferredPanels: 0,
    reviewCells: reviewCells.length,
    slabShutteringSqm: panels.reduce((sum, panel) => sum + panel.netAreaSqm, 0),
    slabConcreteCum: panels.reduce((sum, panel) => sum + panel.concreteCum, 0),
    cutoutDeductionSqm: panels.reduce((sum, panel) => sum + panel.cutoutAreaSqm, 0),
    reviewAreaSqm: reviewCells.reduce((sum, cell) => sum + (cell.grossAreaSqm || cell.areaSqm || 0), 0),
  };
}

function solveTopologySlabCells(entities, options = {}) {
  const reference = mapReferencePanelsToFaces(entities, options.reference || {});
  if (reference.marks.hasReferenceMarks && reference.referencePolylines > 0 && reference.mappedPanels.length) {
    const mappedPanels = reference.mappedPanels.map(mappedReferencePanelToSlabPanel);
    const reviewCells = [...reference.unmappedPanels];
    return {
      graph: reference.graph || { nodes: 0, edges: 0, faces: 0 },
      source: "reference-readback",
      reference,
      panels: mappedPanels,
      reviewCells,
      totals: referenceReadbackTotals(mappedPanels, reviewCells),
    };
  }

  const faceResult = solveSlabPanelsByFaceWalking(entities, options.faceWalk || options);
  if (!reference.marks.hasReferenceMarks || !reference.marks.panelMarks.length) {
    return { ...faceResult, source: "planar-face-walk" };
  }

  const mappedPanels = [];
  const reviewCells = [...faceResult.reviewCells];
  for (const mapped of reference.mappedPanels) {
    const panel = faceResult.panels.find((candidate) =>
      Math.abs(candidate.box.minX - mapped.box.minX) <= 80 &&
      Math.abs(candidate.box.maxX - mapped.box.maxX) <= 80 &&
      Math.abs(candidate.box.minY - mapped.box.minY) <= 80 &&
      Math.abs(candidate.box.maxY - mapped.box.maxY) <= 80);
    if (!panel && mapped.inferred) {
      mappedPanels.push(mappedReferencePanelToSlabPanel(mapped));
      continue;
    }
    if (!panel) {
      reviewCells.push({ ...mapped, reason: "Reference P mark read back, but the closed face failed slab validation." });
      continue;
    }
    mappedPanels.push({
      ...panel,
      panel: mapped.id,
      referenceLabel: mapped.label,
      status: "reference-readback",
      remarks: `${panel.remarks} Calculated from QSS reference mark read-back.`,
    });
  }
  for (const item of reference.unmappedPanels) reviewCells.push(item);

  return {
    ...faceResult,
    source: "reference-readback",
    reference,
    panels: mappedPanels,
    reviewCells,
    totals: {
      directPanels: mappedPanels.length,
      inferredPanels: 0,
      reviewCells: reviewCells.length,
      slabShutteringSqm: mappedPanels.reduce((sum, panel) => sum + panel.netAreaSqm, 0),
      slabConcreteCum: mappedPanels.reduce((sum, panel) => sum + panel.concreteCum, 0),
      cutoutDeductionSqm: mappedPanels.reduce((sum, panel) => sum + panel.cutoutAreaSqm, 0),
      reviewAreaSqm: reviewCells.reduce((sum, cell) => sum + (cell.grossAreaSqm || cell.areaSqm || 0), 0),
    },
  };
}

function parseSize(text) {
  const match = String(text || "").replace(/\s+/g, "").match(/(\d{2,4})(?:\/(\d{2,4}))?[Xx](\d{2,4})/);
  if (!match) return null;
  const widthA = Number(match[1]);
  const widthB = match[2] ? Number(match[2]) : widthA;
  return {
    widthMm: widthA,
    widthMinMm: Math.min(widthA, widthB),
    widthMaxMm: Math.max(widthA, widthB),
    widthAverageMm: (widthA + widthB) / 2,
    depthMm: Number(match[3]),
  };
}

function isNonBeamSizeText(text) {
  return /\b(?:LIFT|CUT[\s-]*OUT|CUTOUT|DUCT|SHAFT|OPEN|VOID|OTS|STAIR|TOILET)\b/i.test(String(text || ""));
}

function textOrientation(entity) {
  const angle = ((Number(entity.rotation || 0) % 180) + 180) % 180;
  return angle > 45 && angle < 135 ? "V" : "H";
}

function isDottedFace(face) {
  const style = String(face?.edgeStyle || "").toLowerCase();
  const lineType = String(face?.lineType || "").toUpperCase();
  return style === "dotted" || /HIDDEN|DASH|DOTTED|ACAD_ISO0?2|ACAD_ISO0?3/.test(lineType);
}

function beamSideSegmentsFromFaces(faces = [], lengthM = 0, depthM = 0, slabThicknessM = DEFAULT_SLAB_THICKNESS_M) {
  const sourceFaces = faces.length >= 2 ? faces.slice(0, 2) : [{ edgeStyle: "dotted" }, { edgeStyle: "dotted" }];
  return sourceFaces.map((face, index) => {
    const dotted = isDottedFace(face);
    const sideHeightM = Math.max(0, dotted ? depthM - slabThicknessM : depthM);
    return {
      face: dotted ? `dotted slab-side face ${index + 1}` : `continuous elevation face ${index + 1}`,
      lineStyle: dotted ? "dotted/hidden" : "continuous",
      lengthM: round3(lengthM),
      sideHeightM: round3(sideHeightM),
      areaM2: round3(lengthM * sideHeightM),
      slabThicknessDeductedM: dotted ? round3(slabThicknessM) : 0,
    };
  });
}

function insidePlanGridWindow(entity, grid, options = {}) {
  if (!grid.eAxes.length || !grid.hAxes.length) return true;
  const horizontalMarginMm = Number(options.horizontalMarginMm || 8000);
  const verticalMarginMm = Number(options.verticalMarginMm || 4500);
  const xMin = Math.min(...grid.eAxes.map((axis) => axis.coordinate)) - horizontalMarginMm;
  const xMax = Math.max(...grid.eAxes.map((axis) => axis.coordinate)) + horizontalMarginMm;
  const yMin = Math.min(...grid.hAxes.map((axis) => axis.coordinate)) - verticalMarginMm;
  const yMax = Math.max(...grid.hAxes.map((axis) => axis.coordinate)) + verticalMarginMm;
  return entity.x >= xMin && entity.x <= xMax && entity.y >= yMin && entity.y <= yMax;
}

function buildBayWiseUnnumberedBeamCandidates(entities, options = {}) {
  const grid = buildGridRegistry(entities);
  const dimensions = extractCadDimensions(entities);
  const referenceMarks = readReferenceMarks(entities);
  const rawBoundarySegments = extractBoundarySegments(entities);
  const supportBoxes = extractSupportBoxes(entities);
  const stitchedBoundaries = stitchBoundarySegments(rawBoundarySegments, supportBoxes, {
    maxGapMm: Number(options.supportGapBridgeMm || 1400),
    supportToleranceMm: Number(options.supportBridgeToleranceMm || 450),
    coordinateToleranceMm: Number(options.faceStitchCoordinateToleranceMm || 180),
    ...(options.stitching || {}),
  });
  const beamFaces = [...rawBoundarySegments, ...stitchedBoundaries]
    .filter((boundary) => boundary.verified && ["beam_face", "support_face"].includes(boundary.type) && (boundary.orientation === "H" || boundary.orientation === "V"))
    .map((boundary) => {
      const orientation = boundary.orientation;
      return {
        type: boundary.type,
        orientation,
        fixed: orientation === "H" ? (boundary.y1 + boundary.y2) / 2 : (boundary.x1 + boundary.x2) / 2,
        start: orientation === "H" ? Math.min(boundary.x1, boundary.x2) : Math.min(boundary.y1, boundary.y2),
        end: orientation === "H" ? Math.max(boundary.x1, boundary.x2) : Math.max(boundary.y1, boundary.y2),
        layer: boundary.layer,
        lineType: boundary.lineType || "",
        edgeStyle: boundary.edgeStyle || "",
        stitched: Boolean(boundary.stitched),
        sourceCount: boundary.sourceCount || 1,
      };
    });
  const maxSpanM = Number(options.maxSpanM || 12);
  const sizeTexts = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({ ...entity, text: cleanCadText(entity.text), size: parseSize(cleanCadText(entity.text)) }))
    .filter((entity) => !isNonBeamSizeText(entity.text))
    .filter((entity) => insidePlanGridWindow(entity, grid, options.planWindow || {}))
    .filter((entity) => entity.size && Number.isFinite(entity.x) && Number.isFinite(entity.y));
  const maxMarks = Number(options.maxMarks || 450);
  const textMarks = (referenceMarks.beamMarks.length
    ? referenceMarks.beamMarks
      .map((mark) => {
        const nearestSize = sizeTexts
          .map((sizeText) => ({ sizeText, distance: Math.hypot(sizeText.x - mark.x, sizeText.y - mark.y) }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (!nearestSize || nearestSize.distance > Number(options.referenceSizeSearchMm || 1800)) return null;
        return { ...nearestSize.sizeText, id: mark.id, referenceLabel: mark.label, x: mark.x, y: mark.y };
      })
      .filter(Boolean)
    : sizeTexts).slice(0, maxMarks);
  const uniqueSizeOptions = [];
  const uniqueSizeKeys = new Set();
  for (const sizeText of sizeTexts) {
    const size = sizeText.size;
    const key = `${size.widthMinMm || size.widthMm}:${size.widthMaxMm || size.widthMm}:${size.depthMm}`;
    if (uniqueSizeKeys.has(key)) continue;
    uniqueSizeKeys.add(key);
    uniqueSizeOptions.push({ size, text: sizeText.text });
  }
  const autoFacePairMarks = [];
  if (!referenceMarks.beamMarks.length && uniqueSizeOptions.length && uniqueSizeOptions.length <= Number(options.maxUniqueSizesForFacePairAutoMarks || 8)) {
    const seen = new Set();
    const maxAutoMarks = Number(options.maxAutoFacePairMarks || 600);
    for (const orientation of ["H", "V"]) {
      const sameOrientationFaces = beamFaces
        .filter((face) => face.orientation === orientation)
        .filter((face) => face.type === "beam_face" || face.type === "support_face");
      const splitAxes = [
        ...beamFaces
          .filter((face) => face.orientation !== orientation)
          .map((face) => face.fixed),
        ...(orientation === "H" ? grid.eAxes : grid.hAxes).map((axis) => axis.coordinate),
      ].filter(Number.isFinite);
      for (let a = 0; a < sameOrientationFaces.length; a += 1) {
        for (let b = a + 1; b < sameOrientationFaces.length; b += 1) {
          const first = sameOrientationFaces[a];
          const second = sameOrientationFaces[b];
          if (first.type !== "beam_face" && second.type !== "beam_face") continue;
          const faceDistance = Math.abs(first.fixed - second.fixed);
          const matchingSize = uniqueSizeOptions.find(({ size }) => {
            const minWidth = size.widthMinMm || size.widthMm;
            const maxWidth = size.widthMaxMm || size.widthMm;
            const tolerance = Math.max(80, maxWidth * 0.18);
            return faceDistance >= minWidth - tolerance && faceDistance <= maxWidth + tolerance;
          });
          if (!matchingSize) continue;
          const overlapStart = Math.max(first.start, second.start);
          const overlapEnd = Math.min(first.end, second.end);
          if (overlapEnd - overlapStart < Number(options.minAutoFacePairSpanMm || 450)) continue;
          const splitPoints = [overlapStart, overlapEnd];
          for (const support of supportBoxes) {
            const box = support.box;
            if (orientation === "H") {
              const mid = (first.fixed + second.fixed) / 2;
              if (mid >= box.minY - 500 && mid <= box.maxY + 500) {
                if (box.minX > overlapStart && box.minX < overlapEnd) splitPoints.push(box.minX);
                if (box.maxX > overlapStart && box.maxX < overlapEnd) splitPoints.push(box.maxX);
              }
            } else {
              const mid = (first.fixed + second.fixed) / 2;
              if (mid >= box.minX - 500 && mid <= box.maxX + 500) {
                if (box.minY > overlapStart && box.minY < overlapEnd) splitPoints.push(box.minY);
                if (box.maxY > overlapStart && box.maxY < overlapEnd) splitPoints.push(box.maxY);
              }
            }
          }
          for (const axis of splitAxes) {
            if (axis > overlapStart && axis < overlapEnd) splitPoints.push(axis);
          }
          const sorted = [...new Set(splitPoints.map((value) => Math.round(value)))].sort((x, y) => x - y);
          for (let index = 0; index < sorted.length - 1; index += 1) {
            const start = sorted[index];
            const end = sorted[index + 1];
            const length = end - start;
            if (length < Number(options.minAutoFacePairSpanMm || 450) || length > maxSpanM * 1000) continue;
            const fixed = (first.fixed + second.fixed) / 2;
            const key = `${orientation}:${Math.round(fixed / 100)}:${Math.round(start / 100)}:${Math.round(end / 100)}:${Math.round(faceDistance / 10)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            autoFacePairMarks.push({
              text: matchingSize.text || `BEAM(${matchingSize.size.widthMm}X${matchingSize.size.depthMm})`,
              size: matchingSize.size,
              id: `QB${autoFacePairMarks.length + 1}`,
              x: orientation === "H" ? (start + end) / 2 : fixed,
              y: orientation === "H" ? fixed : (start + end) / 2,
              rotation: orientation === "H" ? 0 : 90,
              generatedFromFacePair: true,
              facePairStart: start,
              facePairEnd: end,
              facePairDistanceMm: faceDistance,
            });
            if (autoFacePairMarks.length >= maxAutoMarks) break;
          }
          if (autoFacePairMarks.length >= maxAutoMarks) break;
        }
        if (autoFacePairMarks.length >= maxAutoMarks) break;
      }
      if (autoFacePairMarks.length >= maxAutoMarks) break;
    }
  }
  const marks = [...textMarks, ...autoFacePairMarks].slice(0, maxMarks);

  const candidates = [];
  const review = [];

  function faceSpanForMark(mark, orientation) {
    const widthMm = mark.size.widthMm;
    const widthMinMm = mark.size.widthMinMm || widthMm;
    const widthMaxMm = mark.size.widthMaxMm || widthMm;
    const allowedWidthDiffMm = Math.max(70, widthMaxMm * 0.12);
    const axisPosition = orientation === "H" ? mark.y : mark.x;
    const alongPosition = orientation === "H" ? mark.x : mark.y;
    const alongSearchMm = Math.max(4500, widthMaxMm * 8);
    const axisSearchMm = Math.max(2600, widthMaxMm * 5);
    const local = beamFaces
      .filter((face) => face.orientation === orientation)
      .filter((face) => face.start <= alongPosition + alongSearchMm && face.end >= alongPosition - alongSearchMm)
      .filter((face) => Math.abs(face.fixed - axisPosition) <= axisSearchMm)
      .sort((a, b) => Math.abs(a.fixed - axisPosition) - Math.abs(b.fixed - axisPosition));
    if (local.length < 2) {
      faceSpanForMark.lastFailure = {
        type: "no nearby parallel faces",
        orientation,
        nearbyFaceCount: local.length,
        expectedWidthMinMm: widthMinMm,
        expectedWidthMaxMm: widthMaxMm,
      };
      return null;
    }
    let best = null;
    let bestWidthValid = null;
    for (let a = 0; a < local.length; a += 1) {
      for (let b = a + 1; b < local.length; b += 1) {
        const first = local[a];
        const second = local[b];
        if (first.type !== "beam_face" && second.type !== "beam_face") continue;
        const faceDistance = Math.abs(first.fixed - second.fixed);
        const overlapStart = Math.max(first.start, second.start);
        const overlapEnd = Math.min(first.end, second.end);
        if (overlapEnd <= overlapStart) continue;
        const alongGap = alongPosition < overlapStart
          ? overlapStart - alongPosition
          : alongPosition > overlapEnd
            ? alongPosition - overlapEnd
            : 0;
        if (alongGap > alongSearchMm) continue;
        const widthDiff = faceDistance < widthMinMm
          ? widthMinMm - faceDistance
          : faceDistance > widthMaxMm
            ? faceDistance - widthMaxMm
            : 0;
        const overlapLength = overlapEnd - overlapStart;
        if (overlapLength < 250) continue;
        const stitchSupport = (first.stitched ? first.sourceCount : 0) + (second.stitched ? second.sourceCount : 0);
        const supportFacePenalty = (first.type === "support_face" ? 35 : 0) + (second.type === "support_face" ? 35 : 0);
        const score = widthDiff * 8 +
          alongGap * 0.45 +
          supportFacePenalty +
          Math.abs(((first.fixed + second.fixed) / 2) - axisPosition) * 0.25 -
          Math.min(overlapLength, 12000) * 0.01 -
          stitchSupport * 20;
        const candidate = { first, second, faceDistance, overlapStart, overlapEnd, score, widthDiff, overlapLength, stitchSupport, alongGap };
        if (!best || score < best.score) best = candidate;
        if (widthDiff <= allowedWidthDiffMm && (!bestWidthValid || score < bestWidthValid.score)) bestWidthValid = candidate;
      }
    }
    if (!best) {
      faceSpanForMark.lastFailure = {
        type: "nearby faces do not overlap at beam mark",
        orientation,
        nearbyFaceCount: local.length,
        expectedWidthMinMm: widthMinMm,
        expectedWidthMaxMm: widthMaxMm,
      };
      return null;
    }
    if (!bestWidthValid) {
      faceSpanForMark.lastFailure = {
        type: "paired face width mismatch",
        orientation,
        nearbyFaceCount: local.length,
        faceDistanceMm: best.faceDistance,
        widthDiffMm: best.widthDiff,
        expectedWidthMinMm: widthMinMm,
        expectedWidthMaxMm: widthMaxMm,
        allowedWidthDiffMm,
        overlapLengthMm: best.overlapLength,
        alongGapMm: best.alongGap,
        pairedFaceTypes: [best.first.type, best.second.type],
      };
      return null;
    }
    best = bestWidthValid;
    faceSpanForMark.lastFailure = null;

    const splitPoints = [best.overlapStart, best.overlapEnd];
    for (const support of supportBoxes) {
      const box = support.box;
      if (orientation === "H") {
        const yOverlap = axisPosition >= box.minY - 500 && axisPosition <= box.maxY + 500;
        if (yOverlap) {
          if (box.minX > best.overlapStart && box.minX < best.overlapEnd) splitPoints.push(box.minX);
          if (box.maxX > best.overlapStart && box.maxX < best.overlapEnd) splitPoints.push(box.maxX);
        }
      } else {
        const xOverlap = axisPosition >= box.minX - 500 && axisPosition <= box.maxX + 500;
        if (xOverlap) {
          if (box.minY > best.overlapStart && box.minY < best.overlapEnd) splitPoints.push(box.minY);
          if (box.maxY > best.overlapStart && box.maxY < best.overlapEnd) splitPoints.push(box.maxY);
        }
      }
    }
    const perpendicular = beamFaces.filter((face) => face.orientation !== orientation);
    for (const face of perpendicular) {
      const crosses = face.fixed > best.overlapStart && face.fixed < best.overlapEnd &&
        axisPosition >= face.start - 500 && axisPosition <= face.end + 500;
      if (crosses) splitPoints.push(face.fixed);
    }
    const gridAxes = orientation === "H" ? grid.eAxes : grid.hAxes;
    for (const axis of gridAxes) {
      if (axis.coordinate > best.overlapStart && axis.coordinate < best.overlapEnd) splitPoints.push(axis.coordinate);
    }
    const sorted = [...new Set(splitPoints.map((value) => Math.round(value)))].sort((a, b) => a - b);
    const spanIndex = sorted.findIndex((value, index) => sorted[index + 1] && alongPosition >= value - 80 && alongPosition <= sorted[index + 1] + 80);
    const start = spanIndex >= 0 ? sorted[spanIndex] : best.overlapStart;
    const end = spanIndex >= 0 ? sorted[spanIndex + 1] : best.overlapEnd;
    return {
      start,
      end,
      fixed: (best.first.fixed + best.second.fixed) / 2,
      faceDistance: best.faceDistance,
      faces: [
        {
          type: best.first.type,
          layer: best.first.layer || "",
          lineType: best.first.lineType || "",
          edgeStyle: best.first.edgeStyle || "",
        },
        {
          type: best.second.type,
          layer: best.second.layer || "",
          lineType: best.second.lineType || "",
          edgeStyle: best.second.edgeStyle || "",
        },
      ],
      fullRunStart: best.overlapStart,
      fullRunEnd: best.overlapEnd,
      splitCount: Math.max(0, sorted.length - 2),
    };
  }

  for (const mark of marks) {
    const primaryOrientation = textOrientation(mark);
    const alternateOrientation = primaryOrientation === "H" ? "V" : "H";
    const band = nearestGridBand(grid, { minX: mark.x, maxX: mark.x, minY: mark.y, maxY: mark.y });
    let orientation = primaryOrientation;
    let faceSpan = faceSpanForMark(mark, orientation);
    let primaryFailure = faceSpanForMark.lastFailure;
    if (!faceSpan) {
      const alternateFaceSpan = faceSpanForMark(mark, alternateOrientation);
      const alternateFailure = faceSpanForMark.lastFailure;
      if (alternateFaceSpan) {
        orientation = alternateOrientation;
        faceSpan = alternateFaceSpan;
        primaryFailure = null;
      } else {
        primaryFailure = {
          primary: primaryFailure,
          alternate: alternateFailure,
        };
      }
    }
    if (!faceSpan) {
      const failureType = primaryFailure?.primary?.type || primaryFailure?.alternate?.type || primaryFailure?.type || "No verified local beam face pair found around this beam size/reference mark.";
      review.push({
        text: mark.text,
        id: mark.id || null,
        x: mark.x,
        y: mark.y,
        gridBand: band.label,
        reason: failureType,
        facePairFailure: primaryFailure,
      });
      continue;
    }
    const geometrySpanMm = Math.abs(faceSpan.end - faceSpan.start);
    const geometryLengthM = geometrySpanMm / 1000;
    if (geometryLengthM <= 0 || geometryLengthM > maxSpanM) {
      review.push({ text: mark.text, id: mark.id || null, x: mark.x, y: mark.y, gridBand: band.label, reason: "Bay span is too large or invalid for a single beam candidate." });
      continue;
    }
    const dimensionAudit = validateSpanDimension({
      orientation,
      start: faceSpan.start,
      end: faceSpan.end,
      fixed: faceSpan.fixed,
      textX: mark.x,
      textY: mark.y,
    }, dimensions, options.dimension || {});
    const effectiveSpanMm = dimensionAudit.effectiveMm || geometrySpanMm;
    const lengthM = effectiveSpanMm / 1000;
    if (lengthM <= 0 || lengthM > maxSpanM) {
      review.push({ text: mark.text, id: mark.id || null, x: mark.x, y: mark.y, gridBand: band.label, reason: "CAD-authoritative or geometry span is too large or invalid for a single beam candidate." });
      continue;
    }
    const maxUnconfirmedSplitCount = Number(options.maxUnconfirmedSplitCount || 20);
    if (faceSpan.splitCount > maxUnconfirmedSplitCount && dimensionAudit.status === "missing") {
      review.push({
        text: mark.text,
        id: mark.id || null,
        x: mark.x,
        y: mark.y,
        gridBand: band.label,
        reason: "Beam came from a long stitched run with many split points and no confirming CAD dimension; bay run must be reviewed.",
        geometryLengthM: round3(geometryLengthM),
        effectiveLengthM: round3(lengthM),
        splitCount: faceSpan.splitCount,
        faceSpan,
      });
      continue;
    }
    const minUnconfirmedBeamSpanM = Number(options.minUnconfirmedBeamSpanM || 0.25);
    if (lengthM < minUnconfirmedBeamSpanM && dimensionAudit.status === "missing") {
      review.push({
        text: mark.text,
        id: mark.id || null,
        x: mark.x,
        y: mark.y,
        gridBand: band.label,
        reason: "Beam span is below the minimum accepted short-beam length and has no confirming CAD dimension; possible split fragment.",
        geometryLengthM: round3(geometryLengthM),
        effectiveLengthM: round3(lengthM),
        faceSpan,
      });
      continue;
    }
    const widthM = (mark.size.widthAverageMm || mark.size.widthMm) / 1000;
    const depthM = mark.size.depthMm / 1000;
    const sideShutteringSegments = beamSideSegmentsFromFaces(faceSpan.faces || [], lengthM, depthM, DEFAULT_SLAB_THICKNESS_M);
    const sideSqm = sideShutteringSegments.reduce((sum, segment) => sum + Number(segment.areaM2 || 0), 0);
    candidates.push({
      id: mark.id || `BQ${candidates.length + 1}`,
      text: mark.text,
      gridBand: band.label,
      orientation,
      x: mark.x,
      y: mark.y,
      lengthM,
      geometryLengthM,
      widthM,
      depthM,
      bottomSqm: lengthM * widthM,
      sideSqm,
      totalShutteringSqm: (lengthM * widthM) + sideSqm,
      sideShutteringSegments,
      edgeLineStyleRule: "Dotted/hidden beam side deducts slab thickness; continuous/elevation side is measured full beam depth.",
      faceSpan,
      dimensionAudit,
      calculationSource: dimensionAudit.status === "cad_authoritative" ? "cad_dimension" : "cad_geometry",
      status: dimensionAudit.status === "conflict" ? "review_dimension_conflict" : "bay_face_pair_confirmed",
    });
  }

  const verifiedCandidates = candidates.filter((row) => row.status === "bay_face_pair_confirmed");
  const reviewCandidates = candidates.filter((row) => row.status !== "bay_face_pair_confirmed");
  return {
    candidates,
    verifiedCandidates,
    reviewCandidates,
    review,
    totals: {
      candidates: verifiedCandidates.length,
      rawCandidates: candidates.length,
      review: review.length + reviewCandidates.length,
      textMarks: textMarks.length,
      uniqueSizeOptions: uniqueSizeOptions.length,
      autoFacePairMarks: autoFacePairMarks.length,
      totalMarks: marks.length,
      bottomSqm: verifiedCandidates.reduce((sum, row) => sum + row.bottomSqm, 0),
      sideSqm: verifiedCandidates.reduce((sum, row) => sum + row.sideSqm, 0),
      shutteringSqm: verifiedCandidates.reduce((sum, row) => sum + row.totalShutteringSqm, 0),
    },
  };
}

function applyFailureGate({ slab, beams, maxReviewRatio = 0.05, validation = {} }) {
  const slabVerified = slab.totals.slabShutteringSqm || 0;
  const slabReview = slab.totals.reviewAreaSqm || 0;
  const beamVerified = beams.totals.shutteringSqm || 0;
  const slabReviewRatio = slabVerified + slabReview > 0 ? slabReview / (slabVerified + slabReview) : 1;
  const beamReviewRatio = (beams.totals.candidates + beams.totals.review) > 0
    ? beams.totals.review / (beams.totals.candidates + beams.totals.review)
    : 1;
  const benchmarkMinimums = validation.benchmarkMinimums || {};
  const slabMinimumPassed = !Number.isFinite(benchmarkMinimums.slabShutteringSqm) || slabVerified >= benchmarkMinimums.slabShutteringSqm;
  const beamMinimumPassed = !Number.isFinite(benchmarkMinimums.beamShutteringSqm) || beamVerified >= benchmarkMinimums.beamShutteringSqm;
  const benchmarkMinimumGatePassed = slabMinimumPassed && beamMinimumPassed;
  const ratioGatePassed = slabReviewRatio <= maxReviewRatio && beamReviewRatio <= maxReviewRatio;
  const goldenTestsPassed = validation.goldenTestsPassed === true;
  const benchmarkVariancePassed = validation.benchmarkVariancePassed === true;
  const validationGatePassed = goldenTestsPassed || benchmarkVariancePassed;
  const finalAllowed = ratioGatePassed && validationGatePassed && benchmarkMinimumGatePassed;
  return {
    finalAllowed,
    slabReviewRatio,
    beamReviewRatio,
    benchmarkMinimums,
    slabMinimumPassed,
    beamMinimumPassed,
    benchmarkMinimumGatePassed,
    ratioGatePassed,
    goldenTestsPassed,
    benchmarkVariancePassed,
    validationGatePassed,
    reason: finalAllowed
      ? "Review ratio and validation gates passed; final output may be allowed."
      : !ratioGatePassed
        ? "Review ratio exceeds 5%; output must be verified/review-only, not final MB quantity."
        : !benchmarkMinimumGatePassed
          ? "Calculated quantity is below the project benchmark minimum; output must remain review-only."
          : "Review ratio is low, but golden tests or benchmark variance validation have not passed; output must remain review-only.",
  };
}

function runTakeoffEngineV2(entities, options = {}) {
  const itemType = String(options.itemType || options.mode || "").toLowerCase();
  const slabOnly = itemType === "slab" || itemType === "raft";
  const beamOnly = itemType === "beam";
  const slab = solveTopologySlabCells(entities, options.slab || {});
  const beams = slabOnly
    ? {
        candidates: [],
        verifiedCandidates: [],
        reviewCandidates: [],
        review: [],
        totals: {
          candidates: 0,
          rawCandidates: 0,
          review: 0,
          textMarks: 0,
          uniqueSizeOptions: 0,
          autoFacePairMarks: 0,
          totalMarks: 0,
          bottomSqm: 0,
          sideSqm: 0,
          shutteringSqm: 0,
        },
      }
    : buildBayWiseUnnumberedBeamCandidates(entities, options.beams || {});
  const gate = applyFailureGate({
    slab,
    beams,
    maxReviewRatio: Number(options.maxReviewRatio || 0.05),
    validation: options.validation || {},
  });
  return { slab, beams, gate, mode: beamOnly ? "beam" : slabOnly ? "slab" : "all" };
}

module.exports = {
  buildCadTopologyGraph,
  solveTopologySlabCells,
  buildBayWiseUnnumberedBeamCandidates,
  applyFailureGate,
  runTakeoffEngineV2,
};
