"use strict";
const { cleanCadText } = require("./dxf-reader.js");

const DEFAULT_TOLERANCE_MM = 40;

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function midpoint(a, b) {
  return (a + b) / 2;
}

function distance(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0));
}

function orientationFromPoints(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dx >= dy * 3) return "H";
  if (dy >= dx * 3) return "V";
  return "D";
}

function textOrientation(entity) {
  const angle = ((Number(entity.rotation || 0) % 180) + 180) % 180;
  return angle > 45 && angle < 135 ? "V" : "H";
}

function parseSingleNumericText(text) {
  const clean = cleanCadText(text).replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  if (!Number.isFinite(value) || value < 100 || value > 100000) return null;
  return value;
}

function dimensionTextReliability(dimension, options = {}) {
  const rawText = cleanCadText(dimension.rawText || "").replace(/,/g, "").trim();
  if (!rawText) return { reliable: true, reason: "no override text" };
  if (/\b(?:SCALE|NTS|TYP|FLOOR|LEVEL|SECTION|DETAIL|SHEET)\b/i.test(rawText)) {
    return { reliable: false, reason: "dimension text is drawing/detail note, not a measurement" };
  }
  const numericText = parseSingleNumericText(rawText);
  if (numericText !== null) {
    const textDiff = Math.abs(numericText - dimension.valueMm);
    const textTolerance = Math.max(Number(options.textValueToleranceMm || 60), dimension.valueMm * Number(options.textValueToleranceRatio || 0.02));
    return textDiff <= textTolerance
      ? { reliable: true, reason: "visible dimension text matches CAD measurement" }
      : { reliable: false, reason: "visible dimension text does not match CAD measurement" };
  }
  return { reliable: true, reason: "dimension text is not a rejected note" };
}

function dimensionFromEntity(entity) {
  const valueMm = numeric(entity.actualMeasurement);
  const x1 = numeric(entity.ext1X);
  const y1 = numeric(entity.ext1Y);
  const x2 = numeric(entity.ext2X);
  const y2 = numeric(entity.ext2Y);
  if (!valueMm || valueMm <= 0) return null;

  const hasExtensionPoints = [x1, y1, x2, y2].every((value) => value !== null);
  const fallbackX1 = numeric(entity.x);
  const fallbackY1 = numeric(entity.y);
  const fallbackX2 = numeric(entity.x2);
  const fallbackY2 = numeric(entity.y2);
  const startX = hasExtensionPoints ? x1 : fallbackX1;
  const startY = hasExtensionPoints ? y1 : fallbackY1;
  const endX = hasExtensionPoints ? x2 : fallbackX2;
  const endY = hasExtensionPoints ? y2 : fallbackY2;
  if ([startX, startY, endX, endY].some((value) => value === null)) return null;

  const orientation = orientationFromPoints(startX, startY, endX, endY);
  if (orientation === "D") return null;
  return {
    source: "dimension-entity",
    valueMm,
    orientation,
    start: orientation === "H" ? Math.min(startX, endX) : Math.min(startY, endY),
    end: orientation === "H" ? Math.max(startX, endX) : Math.max(startY, endY),
    fixed: orientation === "H" ? midpoint(startY, endY) : midpoint(startX, endX),
    textX: numeric(entity.x2) ?? midpoint(startX, endX),
    textY: numeric(entity.y2) ?? midpoint(startY, endY),
    layer: entity.layer || "",
    rawText: cleanCadText(entity.text || ""),
    hasExtensionPoints,
  };
}

function dimensionFromText(entity) {
  const valueMm = parseSingleNumericText(entity.text);
  if (!valueMm) return null;
  const orientation = textOrientation(entity);
  return {
    source: "dimension-text",
    valueMm,
    orientation,
    start: null,
    end: null,
    fixed: orientation === "H" ? numeric(entity.y) : numeric(entity.x),
    textX: numeric(entity.x),
    textY: numeric(entity.y),
    layer: entity.layer || "",
    rawText: cleanCadText(entity.text || ""),
  };
}

function extractCadDimensions(entities) {
  const entityDimensions = entities
    .filter((entity) => entity.type === "DIMENSION")
    .map(dimensionFromEntity)
    .filter(Boolean);
  const textDimensions = entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .filter((entity) => !/[A-Z]/i.test(cleanCadText(entity.text).replace(/[xX]/g, "")))
    .map(dimensionFromText)
    .filter(Boolean);
  return [...entityDimensions, ...textDimensions];
}

function validateSpanDimension(span, dimensions, options = {}) {
  const toleranceMm = Number(options.toleranceMm || DEFAULT_TOLERANCE_MM);
  const endpointToleranceMm = Number(options.endpointToleranceMm || 450);
  const axisToleranceMm = Number(options.axisToleranceMm || 1200);
  const maxCadOverrideDiffMm = Number(options.maxCadOverrideDiffMm || 350);
  const valueMm = Math.abs(span.end - span.start);
  const orientation = span.orientation;
  const candidates = dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .map((dimension) => {
      const textReliability = dimensionTextReliability(dimension, options);
      const extensionSpanMm = Number.isFinite(dimension.start) && Number.isFinite(dimension.end)
        ? Math.abs(dimension.end - dimension.start)
        : null;
      const extensionSpanDiffMm = extensionSpanMm !== null
        ? Math.abs(extensionSpanMm - dimension.valueMm)
        : Infinity;
      const valueDiffMm = Math.abs(dimension.valueMm - valueMm);
      const axisDiffMm = Number.isFinite(dimension.fixed) && Number.isFinite(span.fixed)
        ? Math.abs(dimension.fixed - span.fixed)
        : Infinity;
      const endpointDiffMm = Number.isFinite(dimension.start) && Number.isFinite(dimension.end)
        ? Math.max(
          Math.abs(dimension.start - Math.min(span.start, span.end)),
          Math.abs(dimension.end - Math.max(span.start, span.end)),
        )
        : Infinity;
      const textDistanceMm = Number.isFinite(dimension.textX) && Number.isFinite(dimension.textY) && Number.isFinite(span.textX) && Number.isFinite(span.textY)
        ? Math.hypot(dimension.textX - span.textX, dimension.textY - span.textY)
        : Infinity;
      const endpointAligned = Number.isFinite(dimension.start) &&
        Number.isFinite(dimension.end) &&
        endpointDiffMm <= endpointToleranceMm;
      const textOnlyMatched = dimension.source === "dimension-text" &&
        valueDiffMm <= toleranceMm &&
        (axisDiffMm <= axisToleranceMm || textDistanceMm <= axisToleranceMm * 2);
      const positionOk = dimension.source === "dimension-entity" ? endpointAligned : textOnlyMatched;
      const dimensionSelfConsistent = dimension.source === "dimension-entity" &&
        extensionSpanDiffMm <= Math.max(toleranceMm, Number(options.extensionToleranceMm || 60), dimension.valueMm * 0.03);
      const authoritativePositionOk =
        (dimension.source === "dimension-entity" && dimensionSelfConsistent && endpointAligned) ||
        (dimension.source === "dimension-text" && (axisDiffMm <= axisToleranceMm || textDistanceMm <= axisToleranceMm * 2));
      return {
        dimension,
        valueDiffMm,
        axisDiffMm,
        endpointDiffMm,
        textDistanceMm,
        positionOk,
        endpointAligned,
        authoritativePositionOk,
        textReliable: textReliability.reliable,
        textReliabilityReason: textReliability.reason,
        extensionSpanMm,
        extensionSpanDiffMm,
        score: valueDiffMm + Math.min(endpointDiffMm, axisDiffMm, textDistanceMm) * 0.15,
      };
    })
    .filter((candidate) => candidate.textReliable || candidate.valueDiffMm <= toleranceMm)
    .filter((candidate) => candidate.positionOk || (candidate.textReliable && candidate.authoritativePositionOk))
    .sort((a, b) => a.score - b.score);

  const best = candidates[0];
  if (!best) {
    return {
      status: "missing",
      geometryMm: valueMm,
      dimensionMm: null,
      differenceMm: null,
      source: "geometry-only",
      note: "No nearby CAD dimension text/entity matched this span.",
    };
  }

  const conflict = best.valueDiffMm > toleranceMm;
  const spanEndpointNearDimension = best.endpointDiffMm > toleranceMm && best.endpointDiffMm <= endpointToleranceMm;
  const cadWildlyDisagreesWithGeometry = valueMm > 0 &&
    (best.dimension.valueMm < valueMm * 0.4 || best.dimension.valueMm > valueMm * 2.5);
  const canUseCadDimension = conflict &&
    best.textReliable &&
    best.authoritativePositionOk &&
    !cadWildlyDisagreesWithGeometry &&
    (best.dimension.source === "dimension-text" || spanEndpointNearDimension || best.axisDiffMm <= axisToleranceMm * 2);
  if (canUseCadDimension) {
    return {
      status: "cad_authoritative",
      geometryMm: valueMm,
      dimensionMm: best.dimension.valueMm,
      effectiveMm: best.dimension.valueMm,
      differenceMm: best.valueDiffMm,
      source: best.dimension.source,
      rawText: best.dimension.rawText,
      axisDiffMm: best.axisDiffMm,
      endpointDiffMm: best.endpointDiffMm,
      textReliabilityReason: best.textReliabilityReason,
      extensionSpanMm: best.extensionSpanMm,
      extensionSpanDiffMm: best.extensionSpanDiffMm,
      note: `CAD dimension is self-consistent and near this span; using CAD value over geometry by ${Math.round(best.valueDiffMm)} mm.`,
    };
  }

  if (conflict && cadWildlyDisagreesWithGeometry) {
    return {
      status: "geometry_over_implausible_dimension",
      geometryMm: valueMm,
      dimensionMm: best.dimension.valueMm,
      effectiveMm: valueMm,
      differenceMm: best.valueDiffMm,
      source: best.dimension.source,
      rawText: best.dimension.rawText,
      axisDiffMm: best.axisDiffMm,
      endpointDiffMm: best.endpointDiffMm,
      textReliabilityReason: best.textReliabilityReason,
      extensionSpanMm: best.extensionSpanMm,
      extensionSpanDiffMm: best.extensionSpanDiffMm,
      note: `Nearby CAD dimension (${Math.round(best.dimension.valueMm)} mm) is implausible against geometry (${Math.round(valueMm)} mm); using geometry.`,
    };
  }

  return {
    status: conflict ? "conflict" : "matched",
    geometryMm: valueMm,
    dimensionMm: best.dimension.valueMm,
    effectiveMm: conflict ? valueMm : best.dimension.valueMm,
    differenceMm: best.valueDiffMm,
    source: best.dimension.source,
    rawText: best.dimension.rawText,
    axisDiffMm: best.axisDiffMm,
    endpointDiffMm: best.endpointDiffMm,
    textReliabilityReason: best.textReliabilityReason,
    extensionSpanMm: best.extensionSpanMm,
    extensionSpanDiffMm: best.extensionSpanDiffMm,
    note: conflict
      ? `CAD dimension differs from geometry by ${Math.round(best.valueDiffMm)} mm.`
      : `CAD dimension matched within ${toleranceMm} mm.`,
  };
}

function validateBoxDimensions(box, dimensions, options = {}) {
  const centerX = midpoint(box.minX, box.maxX);
  const centerY = midpoint(box.minY, box.maxY);
  const length = validateSpanDimension({
    orientation: "H",
    start: box.minX,
    end: box.maxX,
    fixed: centerY,
    textX: centerX,
    textY: centerY,
  }, dimensions, options);
  const breadth = validateSpanDimension({
    orientation: "V",
    start: box.minY,
    end: box.maxY,
    fixed: centerX,
    textX: centerX,
    textY: centerY,
  }, dimensions, options);
  const okStatuses = ["matched", "missing", "cad_authoritative", "geometry_over_implausible_dimension"];
  return {
    length,
    breadth,
    effectiveLengthMm: length.effectiveMm || length.geometryMm,
    effectiveBreadthMm: breadth.effectiveMm || breadth.geometryMm,
    ok: [length.status, breadth.status].every((status) => okStatuses.includes(status)),
    hasConflict: length.status === "conflict" || breadth.status === "conflict",
    hasBothDimensions: length.status === "matched" && breadth.status === "matched",
  };
}

module.exports = { extractCadDimensions, validateSpanDimension, validateBoxDimensions };
