"use strict";
const { cleanCadText } = require("../cad/dxf-reader.js");
const { buildPlanarCadGraph, pointInsidePolygon, walkPlanarFaces } = require("../topology/face-walker.js");

const DEFAULT_SLAB_THICKNESS_M = 0.15;

function cleanLayer(layer) {
  return String(layer || "").toUpperCase();
}

function labelText(entity) {
  return cleanCadText(entity.text || "").toUpperCase();
}

function readReferenceMarks(entities) {
  const panelMarks = [];
  const panelKeys = new Set();
  const beamMarks = [];
  const beamKeys = new Set();
  const reviewMarks = [];

  function addPanelMark(mark) {
    const id = mark.id.toUpperCase();
    const locationKey = `${id}:${Math.round(mark.x / 100)}:${Math.round(mark.y / 100)}`;
    const nearbyKey = [...panelKeys].find((key) => {
      const [existingId, x, y] = key.split(":");
      return existingId === id &&
        Math.abs(Number(x) - Math.round(mark.x / 100)) <= 7 &&
        Math.abs(Number(y) - Math.round(mark.y / 100)) <= 7;
    });
    if (nearbyKey || panelKeys.has(locationKey)) return;
    panelKeys.add(locationKey);
    panelMarks.push({ ...mark, id });
  }

  function addBeamMark(mark) {
    const id = mark.id.toUpperCase();
    const locationKey = `${id}:${Math.round(mark.x / 100)}:${Math.round(mark.y / 100)}`;
    if (beamKeys.has(locationKey)) return;
    beamKeys.add(locationKey);
    beamMarks.push({ ...mark, id });
  }

  for (const entity of entities) {
    if (!["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) || !entity.text) continue;
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
    const layer = cleanLayer(entity.layer);
    const text = labelText(entity);
    const base = { label: text, x: entity.x, y: entity.y, layer: entity.layer || "" };
    const ordinaryPanelMatch = text.match(/^P(\d+)$/);
    const qssPanelMatch = layer.includes("QSS_PANEL_MARKS")
      ? text.match(/^(?:P|RP|TP)(\d+)/)
      : null;
    const panelMatch = ordinaryPanelMatch || qssPanelMatch;
    if (panelMatch) {
      addPanelMark({ ...base, id: `P${panelMatch[1]}` });
    }
    if (layer.includes("QSS_AUTO_BEAM_IDS") && /^QB\d+/.test(text)) {
      addBeamMark({ ...base, id: text.match(/^QB\d+/)[0] });
    }
    if (layer.includes("QSS_REVIEW_AREAS")) reviewMarks.push({ ...base, id: text.match(/^R\d+/)?.[0] || `R${reviewMarks.length + 1}` });
  }

  panelMarks.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  beamMarks.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  return {
    panelMarks,
    beamMarks,
    reviewMarks,
    hasReferenceMarks: panelMarks.length > 0 || beamMarks.length > 0,
  };
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function round3(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
}

function boxFromPolygon(polygon) {
  const xs = polygon.map((point) => point.x).filter(Number.isFinite);
  const ys = polygon.map((point) => point.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function polygonAreaMm2(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += (current.x * next.y) - (next.x * current.y);
  }
  return Math.abs(area) / 2;
}

function referencePanelPolylines(entities, options = {}) {
  const minAreaMm2 = Number(options.minAreaMm2 || 250000);
  return entities
    .filter((entity) => entity.type === "LWPOLYLINE")
    .filter((entity) => cleanLayer(entity.layer).includes("QSS_PANEL_CLOSED_POLYLINES"))
    .map((entity, index) => {
      const polygon = (entity.vertices || [])
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .map((point) => ({ x: point.x, y: point.y }));
      const box = boxFromPolygon(polygon);
      const areaMm2 = polygon.length >= 4 ? polygonAreaMm2(polygon) : 0;
      return {
        index,
        layer: entity.layer || "",
        polygon,
        box,
        areaMm2,
      };
    })
    .filter((panel) => panel.box && panel.areaMm2 >= minAreaMm2)
    .sort((a, b) => a.areaMm2 - b.areaMm2);
}

function panelFromReferencePolyline(mark, panel) {
  const lengthM = round3((panel.box.maxX - panel.box.minX) / 1000);
  const breadthM = round3((panel.box.maxY - panel.box.minY) / 1000);
  const areaSqm = round3(panel.areaMm2 / 1e6);
  return {
    ...mark,
    source: "qss-closed-panel-polyline-readback",
    face: {
      box: panel.box,
      polygon: panel.polygon,
      areaMm2: panel.areaMm2,
      source: "qss-closed-panel-polyline",
    },
    box: panel.box,
    polygon: panel.polygon,
    areaSqm,
    lengthM,
    breadthM,
    netAreaSqm: areaSqm,
    grossAreaSqm: areaSqm,
    cutoutAreaSqm: 0,
    concreteCum: round3(areaSqm * DEFAULT_SLAB_THICKNESS_M),
    remarks: "Reference P mark measured from QSS closed panel polyline.",
  };
}

function markInsideReferencePanel(mark, panel) {
  const point = { x: mark.x, y: mark.y };
  return point.x >= panel.box.minX &&
    point.x <= panel.box.maxX &&
    point.y >= panel.box.minY &&
    point.y <= panel.box.maxY &&
    pointInsidePolygon(point, panel.polygon);
}

function mapMarksToReferencePolylines(panelMarks, referencePolylines) {
  const mapped = [];
  const unmapped = [];
  const usedReferencePolylineIndexes = new Set();

  for (const mark of panelMarks) {
    const referencePolyline = referencePolylines
      .filter((panel) => markInsideReferencePanel(mark, panel))
      .sort((a, b) => a.areaMm2 - b.areaMm2)[0];
    if (referencePolyline) {
      usedReferencePolylineIndexes.add(referencePolyline.index);
      mapped.push(panelFromReferencePolyline(mark, referencePolyline));
    } else {
      unmapped.push(mark);
    }
  }

  return { mapped, unmapped, usedReferencePolylineIndexes };
}

function inferPanelBoxFromBoundaries(point, graph, options = {}) {
  const coverToleranceMm = Number(options.coverToleranceMm || 350);
  const minDimensionMm = Number(options.minDimensionMm || 450);
  const maxDimensionMm = Number(options.maxDimensionMm || 25000);
  const maxSearchMm = Number(options.maxSearchMm || 14000);
  const sourceBoundaries = graph.boundaries || graph.segments || [];
  const boundaries = sourceBoundaries
    .filter((boundary) => ["beam_face", "support_face", "cutout_boundary"].includes(boundary.type))
    .filter((boundary) => boundary.orientation === "H" || boundary.orientation === "V")
    .map((boundary) => ({
      ...boundary,
      interval: boundary.interval || (boundary.orientation === "H"
        ? {
            fixed: boundary.fixed ?? boundary.y1 ?? 0,
            start: boundary.start ?? Math.min(boundary.x1 ?? 0, boundary.x2 ?? 0),
            end: boundary.end ?? Math.max(boundary.x1 ?? 0, boundary.x2 ?? 0),
          }
        : {
            fixed: boundary.fixed ?? boundary.x1 ?? 0,
            start: boundary.start ?? Math.min(boundary.y1 ?? 0, boundary.y2 ?? 0),
            end: boundary.end ?? Math.max(boundary.y1 ?? 0, boundary.y2 ?? 0),
          }),
    }));

  function verticalCandidate(side) {
    return boundaries
      .filter((boundary) => boundary.orientation === "V")
      .filter((boundary) => side === "left" ? boundary.interval.fixed < point.x : boundary.interval.fixed > point.x)
      .filter((boundary) => Math.abs(boundary.interval.fixed - point.x) <= maxSearchMm)
      .filter((boundary) => point.y >= boundary.interval.start - coverToleranceMm && point.y <= boundary.interval.end + coverToleranceMm)
      .map((boundary) => ({
        boundary,
        distance: Math.abs(boundary.interval.fixed - point.x),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.boundary || null;
  }

  function horizontalCandidate(side) {
    return boundaries
      .filter((boundary) => boundary.orientation === "H")
      .filter((boundary) => side === "bottom" ? boundary.interval.fixed < point.y : boundary.interval.fixed > point.y)
      .filter((boundary) => Math.abs(boundary.interval.fixed - point.y) <= maxSearchMm)
      .filter((boundary) => point.x >= boundary.interval.start - coverToleranceMm && point.x <= boundary.interval.end + coverToleranceMm)
      .map((boundary) => ({
        boundary,
        distance: Math.abs(boundary.interval.fixed - point.y),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.boundary || null;
  }

  const left = verticalCandidate("left");
  const right = verticalCandidate("right");
  const bottom = horizontalCandidate("bottom");
  const top = horizontalCandidate("top");
  if (!left || !right || !bottom || !top) return null;

  const box = {
    minX: Math.min(left.interval.fixed, right.interval.fixed),
    maxX: Math.max(left.interval.fixed, right.interval.fixed),
    minY: Math.min(bottom.interval.fixed, top.interval.fixed),
    maxY: Math.max(bottom.interval.fixed, top.interval.fixed),
  };
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (width < minDimensionMm || height < minDimensionMm || width > maxDimensionMm || height > maxDimensionMm) return null;

  const horizontalCoverage = [
    overlap1d(top.interval.start, top.interval.end, box.minX, box.maxX) / Math.max(width, 1),
    overlap1d(bottom.interval.start, bottom.interval.end, box.minX, box.maxX) / Math.max(width, 1),
  ];
  const verticalCoverage = [
    overlap1d(left.interval.start, left.interval.end, box.minY, box.maxY) / Math.max(height, 1),
    overlap1d(right.interval.start, right.interval.end, box.minY, box.maxY) / Math.max(height, 1),
  ];
  const minCoverage = Math.min(...horizontalCoverage, ...verticalCoverage);
  if (minCoverage < Number(options.minSideCoverage || 0.35)) return null;

  const polygon = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  return {
    inferred: true,
    box,
    polygon,
    areaSqm: (width * height) / 1e6,
    boundaryEvidence: {
      left: left.type,
      right: right.type,
      bottom: bottom.type,
      top: top.type,
      minCoverage: round3(minCoverage),
    },
  };
}

function mapReferencePanelsToFaces(entities, options = {}) {
  const marks = readReferenceMarks(entities);
  const referencePolylines = referencePanelPolylines(entities, options.referencePolylines || {});
  const directPolylineReadback = mapMarksToReferencePolylines(marks.panelMarks, referencePolylines);
  const panelMarkCount = marks.panelMarks.length;
  const polylineCoverage = panelMarkCount ? directPolylineReadback.mapped.length / panelMarkCount : 0;
  const maxEntitiesForFaceWalk = Number(options.maxEntitiesForFaceWalk || Infinity);
  const minFastPolylineCoverage = Number(options.minFastPolylineCoverage || 0.75);
  const shouldUsePolylineFastPath = referencePolylines.length > 0 &&
    (
      options.fastPolylineOnly ||
      polylineCoverage >= minFastPolylineCoverage ||
      entities.length > maxEntitiesForFaceWalk
    );

  if (shouldUsePolylineFastPath) {
    return {
      marks,
      graph: {
        nodes: 0,
        edges: 0,
        faces: 0,
        skipped: true,
        reason: "qss-reference-polyline-readback",
      },
      referencePolylines: referencePolylines.length,
      mappedFromReferencePolylines: directPolylineReadback.usedReferencePolylineIndexes.size,
      mappedPanels: directPolylineReadback.mapped,
      unmappedPanels: directPolylineReadback.unmapped.map((mark) => ({
        ...mark,
        reason: "Reference panel mark is not inside a QSS closed panel polyline.",
      })),
      unusedFaces: 0,
    };
  }

  const graph = buildPlanarCadGraph(entities, options.graph || {});
  const faces = walkPlanarFaces(graph, options.walk || {})
    .filter((face) => face.signedArea > 0)
    .map((face) => ({
      ...face,
      center: {
        x: (face.box.minX + face.box.maxX) / 2,
        y: (face.box.minY + face.box.maxY) / 2,
      },
    }));

  const mapped = [];
  const usedFaceIndexes = new Set();
  const usedReferencePolylineIndexes = new Set(directPolylineReadback.usedReferencePolylineIndexes);
  const unresolvedPanelMarks = [];

  mapped.push(...directPolylineReadback.mapped);

  for (const mark of directPolylineReadback.unmapped) {
    const point = { x: mark.x, y: mark.y };
    const candidates = faces
      .map((face, index) => ({ face, index }))
      .filter(({ face }) => point.x >= face.box.minX && point.x <= face.box.maxX && point.y >= face.box.minY && point.y <= face.box.maxY)
      .filter(({ face }) => pointInsidePolygon(point, face.polygon))
      .sort((a, b) => a.face.areaMm2 - b.face.areaMm2);
    const match = candidates[0];
    if (!match) {
      const inferred = inferPanelBoxFromBoundaries(point, graph, options.inferOpenPanel || {});
      if (inferred) {
        mapped.push({
          ...mark,
          ...inferred,
          lengthM: round3((inferred.box.maxX - inferred.box.minX) / 1000),
          breadthM: round3((inferred.box.maxY - inferred.box.minY) / 1000),
          netAreaSqm: round3(inferred.areaSqm),
          grossAreaSqm: round3(inferred.areaSqm),
          cutoutAreaSqm: 0,
          concreteCum: round3(inferred.areaSqm * DEFAULT_SLAB_THICKNESS_M),
          remarks: "Reference P mark measured from nearest four-side beam/support boundary box.",
        });
      } else {
        unresolvedPanelMarks.push({ ...mark, reason: "Reference panel mark is not inside a closed CAD face and no four-side boundary box could be inferred." });
      }
      continue;
    }
    usedFaceIndexes.add(match.index);
    mapped.push({
      ...mark,
      face: match.face,
      areaSqm: match.face.areaMm2 / 1e6,
      box: match.face.box,
    });
  }

  const unresolvedIds = new Set(mapped.map((panel) => `${panel.id}:${Math.round(panel.x)}:${Math.round(panel.y)}`));
  const unmapped = unresolvedPanelMarks
    .filter((mark) => !unresolvedIds.has(`${mark.id}:${Math.round(mark.x)}:${Math.round(mark.y)}`))
    .map((mark) => mark.reason ? mark : {
      ...mark,
      reason: "Reference panel mark is not inside a closed CAD face and no four-side boundary box could be inferred.",
    });

  return {
    marks,
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      faces: faces.length,
    },
    referencePolylines: referencePolylines.length,
    mappedFromReferencePolylines: usedReferencePolylineIndexes.size,
    mappedPanels: mapped,
    unmappedPanels: unmapped,
    unusedFaces: faces.length - usedFaceIndexes.size,
  };
}

module.exports = { readReferenceMarks, mapReferencePanelsToFaces };
