"use strict";

const {
  beamFaceLineStyle,
  beamSideFaceEvidence,
  cadDimensionForSpan,
  canonicalBeamId,
  chooseMeasuredDimension,
  cleanCadText,
  dimensionOrientationFromEndpoints,
  distance,
  extractBeamDepthDefaultNote,
  extractBeamIdFromMixedText,
  finiteMax,
  finiteMin,
  geometryKey,
  isBeamGeometryLayer,
  isXrefSourcedEntity,
  lineLength,
  localSupportEdgeAtAxis,
  lineMinMax,
  lineOrientation,
  markedFaceDimensionsForBeam,
  markedFaceDimensionsNearLabel,
  scoredMarkedFaceDimensionCandidatesForBeam,
  scoredCadDimensionCandidatesForSpan,
  resolveMarkedFaceDimensionOwnership,
  mergedCoverageIntervals,
  minAbsDistance,
  nearest,
  parseSizeText,
  pointToSegmentDistance,
  quantizeCadSpanMm,
  round3,
  supportOutlinesFromDxf,
  textOrientation,
  uniqueRowsBy,
} = require("../cad/legacy-evidence.js");

// Mirrors the module-level constant of the same name in server.js (as of this
// migration). It is a plain literal used only as a fast-path entity-count
// threshold; duplicated here verbatim rather than requiring server.js back
// (which would create a circular require), since server.js requires this file.
const FAST_TOPOLOGY_ENTITY_LIMIT = 12000;

function nearestBeamSizeForLabel(beamSizes, label, line = null) {
  const labelId = canonicalBeamId(label?.text || "");
  const scheduled = labelId ? beamSizes.find((item) => item.beamId === labelId && item.size) : null;
  if (scheduled) {
    return {
      item: scheduled,
      distance: 0,
      basis: scheduled.basis || "beam-detail-schedule",
    };
  }
  const orientation = textOrientation(label);
  const axisTolerance = 1600;
  const lineBounds = line ? lineMinMax(line) : null;
  const sameBand = beamSizes
    .filter((item) => textOrientation(item) === orientation)
    .filter((item) => {
      if (orientation === "horizontal") return Math.abs((item.y || 0) - (label.y || 0)) <= axisTolerance;
      return Math.abs((item.x || 0) - (label.x || 0)) <= axisTolerance;
    })
    .map((item) => {
      const alongDistance = orientation === "horizontal" ? Math.abs((item.x || 0) - (label.x || 0)) : Math.abs((item.y || 0) - (label.y || 0));
      const onLine = !lineBounds
        ? true
        : orientation === "horizontal"
          ? (item.x || 0) >= lineBounds.minX - 3000 && (item.x || 0) <= lineBounds.maxX + 3000
          : (item.y || 0) >= lineBounds.minY - 3000 && (item.y || 0) <= lineBounds.maxY + 3000;
      return { ...item, alongDistance, onLine };
    });
  if (sameBand.length) {
    const item = sameBand.sort((a, b) => (a.onLine === b.onLine ? a.alongDistance - b.alongDistance : a.onLine ? -1 : 1))[0];
    return { item, distance: distance(item, label), basis: "same-line-orientation" };
  }
  const fallback = nearest(beamSizes.filter((item) => textOrientation(item) === orientation), label);
  if (fallback.item) return { ...fallback, basis: "same-orientation-fallback" };
  return { ...nearest(beamSizes, label), basis: "nearest-fallback" };
}

function beamGroupSummary(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const id = canonicalBeamId(row.name);
    if (!id) return;
    const existing = groups.get(id) || {
      name: id,
      locations: 0,
      bottomLengthM: 0,
      sideLengthM: 0,
      bottomAreaM2: 0,
      sideAreaM2: 0,
      totalShutteringM2: 0,
      reviewRows: 0,
    };
    const bottomLength = Number(row.length || 0);
    const sideLength = Number(row.sideLength || row.length || 0);
    const width = Number(row.breadth || 0);
    const effectiveSideDepth = Math.max(Number(row.height || 0) - Number(row.slabThickness || 0), 0);
    const bottomJointDeduction = Number(row.bottomJointDeduction || 0);
    const sideJointDeduction = Number(row.sideJointDeduction || 0);
    const bottomArea = Math.max(bottomLength * width - bottomJointDeduction, 0);
    const sideArea = Math.max(2 * sideLength * effectiveSideDepth - sideJointDeduction, 0);
    existing.locations += 1;
    existing.bottomLengthM += bottomLength;
    existing.sideLengthM += sideLength;
    existing.bottomAreaM2 += bottomArea;
    existing.sideAreaM2 += sideArea;
    existing.totalShutteringM2 += bottomArea + sideArea;
    existing.reviewRows += row.needsReview ? 1 : 0;
    groups.set(id, existing);
  });
  return [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((item) => ({
      ...item,
      bottomLengthM: Math.round(item.bottomLengthM * 1000) / 1000,
      sideLengthM: Math.round(item.sideLengthM * 1000) / 1000,
      bottomAreaM2: Math.round(item.bottomAreaM2 * 1000) / 1000,
      sideAreaM2: Math.round(item.sideAreaM2 * 1000) / 1000,
      totalShutteringM2: Math.round(item.totalShutteringM2 * 1000) / 1000,
      status: item.reviewRows ? "needs-review" : "ready",
    }));
}

function beamRepeatGroups(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const id = canonicalBeamId(row.name);
    if (!id) return;
    const bottomLength = Number(row.length || 0);
    const sideLength = Number(row.sideLength || row.length || 0);
    const width = Number(row.breadth || 0);
    const depth = Number(row.height || 0);
    const slabThickness = Number(row.slabThickness || 0);
    const effectiveSideDepth = Math.max(depth - slabThickness, 0);
    const bottomJointDeduction = Number(row.bottomJointDeduction || 0);
    const sideJointDeduction = Number(row.sideJointDeduction || 0);
    const bottomArea = Math.max(bottomLength * width - bottomJointDeduction, 0);
    const sideArea = Math.max(2 * sideLength * effectiveSideDepth - sideJointDeduction, 0);
    const orientation = row.evidence?.lineKey?.split(":") || [];
    const key = [
      id,
      Math.round(bottomLength * 1000),
      Math.round(sideLength * 1000),
      Math.round(width * 1000),
      Math.round(depth * 1000),
      Math.round(slabThickness * 1000),
      Math.round(bottomJointDeduction * 1000),
      Math.round(sideJointDeduction * 1000),
      orientation.length === 4 && orientation[0] === orientation[2] ? "vertical" : "horizontal",
    ].join("|");
    const existing = groups.get(key) || {
      name: id,
      count: 0,
      bottomLengthM: Math.round(bottomLength * 1000) / 1000,
      sideLengthM: Math.round(sideLength * 1000) / 1000,
      breadthM: Math.round(width * 1000) / 1000,
      depthM: Math.round(depth * 1000) / 1000,
      slabThicknessM: Math.round(slabThickness * 1000) / 1000,
      singleBottomAreaM2: Math.round(bottomArea * 1000) / 1000,
      singleSideAreaM2: Math.round(sideArea * 1000) / 1000,
      singleTotalShutteringM2: Math.round((bottomArea + sideArea) * 1000) / 1000,
      totalShutteringM2: 0,
      reviewRows: 0,
      labels: [],
      lineKeys: [],
      basis: "Repeated/mirrored beam group: same beam number, length, breadth, depth and slab thickness within 1 mm rounding.",
    };
    existing.count += 1;
    existing.totalShutteringM2 += bottomArea + sideArea;
    existing.reviewRows += row.needsReview ? 1 : 0;
    if (row.evidence?.labelX || row.evidence?.labelY) {
      existing.labels.push({ x: row.evidence.labelX || null, y: row.evidence.labelY || null });
    }
    if (row.evidence?.lineKey) existing.lineKeys.push(row.evidence.lineKey);
    groups.set(key, existing);
  });
  return [...groups.values()]
    .filter((item) => item.count > 1)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || b.count - a.count)
    .map((item) => ({
      ...item,
      totalShutteringM2: Math.round(item.totalShutteringM2 * 1000) / 1000,
      status: item.reviewRows ? "needs-review" : "ready",
    }));
}

function beamSummaryFor(rows, name) {
  return beamGroupSummary(rows).find((item) => item.name === canonicalBeamId(name)) || null;
}

function nearestSlabThicknessForLabel(slabInfo, label) {
  const slab = nearest(slabInfo.slabMarks || [], label);
  if (slab.item && slabInfo.byMark?.[slab.item.text]) {
    return {
      valueMm: slabInfo.byMark[slab.item.text],
      sourceText: slab.item.text,
      distance: slab.distance,
    };
  }
  const thickness = nearest(slabInfo.thicknessTexts || [], label);
  if (thickness.item && !slabInfo.defaultNote && thickness.distance < 9000) {
    return {
      valueMm: thickness.item.value,
      sourceText: thickness.item.text,
      distance: thickness.distance,
    };
  }
  return {
    valueMm: slabInfo.defaultThicknessMm || 0,
    sourceText: slabInfo.defaultNote?.sourceText || "",
    distance: null,
  };
}

function recoverNamedBeamRowsFromMarkedDimensions({ fileName, role, beamLabels, beamSizes, slabInfo, grid }) {
  const rows = [];
  const dimensions = Array.isArray(grid?.dimensions) ? grid.dimensions : [];
  if (!beamLabels?.length || !beamSizes?.length || !dimensions.length) return rows;
  for (const label of beamLabels) {
    const id = canonicalBeamId(label.text);
    const orientation = textOrientation(label);
    if (!id || !["horizontal", "vertical"].includes(orientation)) continue;
    const size = nearestBeamSizeForLabel(beamSizes, label, null);
    const widthMm = Number(size.item?.size?.widthMm || 0);
    const depthMm = Number(size.item?.size?.depthMm || 0);
    if (!(widthMm > 0 && depthMm > 0)) continue;
    const markedFaceDimensions = markedFaceDimensionsNearLabel(dimensions, label, orientation, widthMm);
    if (!markedFaceDimensions.length) continue;
    // markedFaceDimensionsNearLabel's search window is intentionally generous (it has to
    // find dimensions that may sit several metres from the label), which means it can
    // return dimensions that have nothing to do with this beam's actual span (an overall/grid
    // dimension, a nearby column/support width, an offset annotation, etc). Drop any candidate
    // no single named beam could plausibly span before it ever reaches the credibility check or
    // min/max selection below - dropping the individual bad value (rather than the whole
    // candidate set just because one of several values is implausible) keeps a genuinely good
    // smaller value usable instead of losing the beam entirely.
    const rawMarkedFaceValuesMm = markedFaceDimensions
      .map((dimension) => Number(dimension.valueMm || 0))
      .filter((value) => value > 0 && value <= MAX_PLAUSIBLE_NAMED_BEAM_SPAN_MM)
      .sort((a, b) => a - b);
    if (!rawMarkedFaceValuesMm.length) continue;
    // Reject the remaining candidate set unless it passes the same plausibility check
    // extractBeamRowsFromDxf already applies to its own geometry-based candidates
    // (QSS-BEAM-005) - without this, a single spurious small value silently becomes the
    // "bottom length" below.
    if (!markedFaceDimensionsAreCredibleBeamRun(rawMarkedFaceValuesMm, 0, widthMm)) continue;
    // Even when the set as a whole is credible (its largest value is plausible), a mix of
    // one real span dimension and one unrelated small one can still slip through - drop any
    // individual value too small to be a face-to-face beam span before picking min/max, so a
    // spurious small value never becomes "bottomLengthMm" just because it sorted first.
    const plausibleFaceValuesMm = rawMarkedFaceValuesMm.filter((value) => value >= Math.max(1200, widthMm * 3));
    const markedFaceValuesMm = plausibleFaceValuesMm.length ? plausibleFaceValuesMm : rawMarkedFaceValuesMm;
    const hasTwoMarkedFaceLengths = markedFaceValuesMm.length >= 2 &&
      (markedFaceValuesMm[markedFaceValuesMm.length - 1] - markedFaceValuesMm[0]) > Math.max(50, widthMm * 0.5);
    const bottomLengthMm = hasTwoMarkedFaceLengths
      ? markedFaceValuesMm[markedFaceValuesMm.length - 1]
      : markedFaceValuesMm[0];
    const sideFaceLengthSegmentsMm = hasTwoMarkedFaceLengths
      ? [markedFaceValuesMm[0], markedFaceValuesMm[markedFaceValuesMm.length - 1]]
      : [];
    const dimensionForSpan = markedFaceDimensions
      .slice()
      .sort((a, b) => Number(b.valueMm || 0) - Number(a.valueMm || 0))[0];
    const dStart = orientation === "horizontal" ? Math.min(dimensionForSpan.x1 || 0, dimensionForSpan.x2 || 0) : Math.min(dimensionForSpan.y1 || 0, dimensionForSpan.y2 || 0);
    const dEnd = orientation === "horizontal" ? Math.max(dimensionForSpan.x1 || 0, dimensionForSpan.x2 || 0) : Math.max(dimensionForSpan.y1 || 0, dimensionForSpan.y2 || 0);
    const dAxis = orientation === "horizontal"
      ? (Number(dimensionForSpan.y1 || label.y || 0) + Number(dimensionForSpan.y2 || label.y || 0)) / 2
      : (Number(dimensionForSpan.x1 || label.x || 0) + Number(dimensionForSpan.x2 || label.x || 0)) / 2;
    const beamAxis = orientation === "horizontal" ? Number(label.y || dAxis || 0) : Number(label.x || dAxis || 0);
    const slabThickness = nearestSlabThicknessForLabel(slabInfo, label);
    const slabThicknessMm = slabThickness.valueMm || 0;
    const effectiveSideHeightM = Math.max((depthMm - slabThicknessMm) / 1000, 0);
    const sideAreaOverride = sideFaceLengthSegmentsMm.length
      ? round3(sideFaceLengthSegmentsMm.reduce((sum, value) => sum + (value / 1000) * effectiveSideHeightM, 0))
      : 0;
    const faceSpan = orientation === "horizontal"
      ? { orientation: "H", fixed: beamAxis, start: dStart, end: dEnd }
      : { orientation: "V", fixed: beamAxis, start: dStart, end: dEnd };
    rows.push({
      name: id,
      floor: role,
      length: bottomLengthMm / 1000,
      sideLength: sideFaceLengthSegmentsMm.length
        ? (sideFaceLengthSegmentsMm.reduce((sum, value) => sum + value, 0) / sideFaceLengthSegmentsMm.length) / 1000
        : bottomLengthMm / 1000,
      breadth: widthMm / 1000,
      height: depthMm / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: slabThicknessMm / 1000,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      sideAreaOverride: sideAreaOverride || undefined,
      dia: 16,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "named-beam-marked-dimension-recovery",
      needsReview: !["same-line-orientation", "beam-detail-schedule"].includes(size.basis),
      reviewNote: [
        "Marked CAD dimension used as the authoritative beam span.",
        hasTwoMarkedFaceLengths ? "Marked inner/outer face dimensions used; side shuttering is split by face length." : "One marked span dimension found; bottom and side lengths use the same span in column-cap-excluded mode.",
        !["same-line-orientation", "beam-detail-schedule"].includes(size.basis) ? "Beam size was not confirmed on the same beam line or linked beam detail." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        fileName,
        existingBeamId: id,
        nearestSizeText: size.item?.text || "",
        nearestSlabMark: slabThickness.sourceText || "",
        sizeDistanceMm: Math.round(size.distance || 0),
        lineDistanceMm: 0,
        labelX: Math.round(label.x || 0),
        labelY: Math.round(label.y || 0),
        faceSpan,
        orientation: orientation === "vertical" ? "V" : "H",
        drawnLengthM: round3(bottomLengthMm / 1000),
        geometryLengthM: null,
        cadDimensionM: round3(bottomLengthMm / 1000),
        dimensionBasis: hasTwoMarkedFaceLengths ? "marked-inner-outer-face-dimensions" : "marked-dimension-label-recovery",
        dimensionValues: markedFaceValuesMm.map((valueMm) => ({ source: "visible/marked-cad-dimension", valueM: round3(valueMm / 1000) })),
        dimensionConflict: false,
        markedFaceDimensionsM: markedFaceValuesMm.map((valueMm) => round3(valueMm / 1000)),
        sideFaceLengthsM: sideFaceLengthSegmentsMm.map((valueMm) => round3(valueMm / 1000)),
        markedDimensionAuthoritative: true,
        lineKey: geometryKey([
          faceSpan.orientation === "H" ? faceSpan.start : faceSpan.fixed,
          faceSpan.orientation === "H" ? faceSpan.fixed : faceSpan.start,
          faceSpan.orientation === "H" ? faceSpan.end : faceSpan.fixed,
          faceSpan.orientation === "H" ? faceSpan.fixed : faceSpan.end,
        ], 50),
        sizeBasis: size.basis === "same-line-orientation"
          ? "Same beam line and same text orientation."
          : "Fallback size text; review before final billing.",
        sideLengthBasis: hasTwoMarkedFaceLengths
          ? "Inner and outer side face lengths read from marked CAD dimensions."
          : "Side length equals the single marked CAD dimension.",
        recoveredAfterDirectPairingFailed: true,
      },
    });
  }
  return uniqueRowsBy(
    rows,
    (row) => [
      row.name,
      Math.round(Number(row.length || 0) * 1000 / 25),
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
      row.evidence?.lineKey || "",
    ].join(":"),
    (row) => Number(row.needsReview ? 10000 : 0) + Number(row.evidence?.sizeDistanceMm || 0),
  );
}

function markedDimensionEvidenceCount(grid = {}) {
  return (Array.isArray(grid.dimensions) ? grid.dimensions : [])
    .filter((dimension) =>
      Number(dimension.valueMm || 0) > 0 &&
      /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(dimension.valueSource || "")))
    .length;
}

function shouldUseMarkedDimensionBeamFastPath({ areaItem, extractionProfile, primaryNamedBeamTextCount, grid, entities }) {
  if (areaItem || extractionProfile !== "fast") return false;
  if (primaryNamedBeamTextCount < 1) return false;
  const dimensionCount = markedDimensionEvidenceCount(grid);
  if (dimensionCount >= 20) return true;
  return dimensionCount >= 8 && Number(entities?.length || 0) > FAST_TOPOLOGY_ENTITY_LIMIT;
}

function localBeamLabelsFromTextEntities(textEntities = []) {
  return textEntities
    .map((item) => ({ ...item, text: canonicalBeamId(item.text) || item.text }))
    .filter((item) => canonicalBeamId(item.text) && Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) => !/^QSS_/i.test(item.layer || ""));
}

function localBeamSizesFromTextEntities(textEntities = [], linkedBeamSizeById = {}) {
  return Object.values(linkedBeamSizeById || {}).concat(textEntities
    .map((item) => ({ ...item, size: parseSizeText(item.text) }))
    .filter((item) => item.size && Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) => !/^QSS_/i.test(item.layer || ""))
    // An architectural xref's room-label text (e.g. "TOILET 2450 X 1650") matches the same
    // "NNNxNNN" pattern as a real beam section callout; without this it gets treated as one.
    .filter((item) => !isXrefSourcedEntity(item)));
}

function dimensionSpanEvidence(dimension) {
  const orientation = dimension.orientation || dimensionOrientationFromEndpoints(dimension, dimension.angle || 0);
  const start = orientation === "horizontal"
    ? Math.min(Number(dimension.x1 || 0), Number(dimension.x2 || 0))
    : Math.min(Number(dimension.y1 || 0), Number(dimension.y2 || 0));
  const end = orientation === "horizontal"
    ? Math.max(Number(dimension.x1 || 0), Number(dimension.x2 || 0))
    : Math.max(Number(dimension.y1 || 0), Number(dimension.y2 || 0));
  const fixed = orientation === "horizontal"
    ? (Number(dimension.y1 || 0) + Number(dimension.y2 || 0)) / 2
    : (Number(dimension.x1 || 0) + Number(dimension.x2 || 0)) / 2;
  const mid = (start + end) / 2;
  return { orientation, start, end, fixed, mid };
}

function nearestBeamLabelForDimension(beamLabels = [], dimension) {
  const span = dimensionSpanEvidence(dimension);
  if (!["horizontal", "vertical"].includes(span.orientation)) return { item: null, distance: Infinity };
  const valueMm = Number(dimension.valueMm || 0);
  const axisLimit = Math.max(2600, Math.min(8500, valueMm * 0.45));
  const alongLimit = Math.max(3500, Math.min(12000, valueMm * 0.75));
  const candidates = beamLabels
    .filter((label) => textOrientation(label) === span.orientation)
    .map((label) => {
      const labelAlong = span.orientation === "horizontal" ? Number(label.x || 0) : Number(label.y || 0);
      const labelFixed = span.orientation === "horizontal" ? Number(label.y || 0) : Number(label.x || 0);
      const axisDiff = Math.abs(labelFixed - span.fixed);
      const insideOrCloseToSpan = labelAlong >= span.start - alongLimit && labelAlong <= span.end + alongLimit;
      const withinSpan = labelAlong >= span.start - Math.max(900, valueMm * 0.12) &&
        labelAlong <= span.end + Math.max(900, valueMm * 0.12);
      const alongDiff = withinSpan ? 0 : Math.min(Math.abs(labelAlong - span.start), Math.abs(labelAlong - span.end), Math.abs(labelAlong - span.mid));
      return { item: label, axisDiff, alongDiff, insideOrCloseToSpan, withinSpan, distance: axisDiff + alongDiff * 0.12 };
    })
    .filter((candidate) => candidate.axisDiff <= axisLimit)
    .filter((candidate) => candidate.alongDiff <= alongLimit)
    .filter((candidate) => candidate.insideOrCloseToSpan)
    .sort((a, b) => a.distance - b.distance);
  return candidates[0] || { item: null, distance: Infinity };
}

// A single named beam member practically never spans more than ~20m column-to-column; the
// 60000mm pre-filter above exists to admit any plausible dimension entity into the candidate
// pool at all, but matching one specific value to one specific label needs a much tighter cap -
// otherwise an overall/grid dimension that happens to sit near a short beam's label (its span
// trivially contains that label's position) gets mistaken for that beam's own length.
const MAX_PLAUSIBLE_NAMED_BEAM_SPAN_MM = 20000;

function extractMarkedDimensionBeamRowsByDimensions({ fileName, role, beamLabels, beamSizes, slabInfo, grid }) {
  const dimensions = (Array.isArray(grid?.dimensions) ? grid.dimensions : [])
    .filter((dimension) => /visible-dimension-text|actual-measurement|text-dimension-label/i.test(String(dimension.valueSource || "")))
    .filter((dimension) => Number(dimension.valueMm || 0) >= 250 && Number(dimension.valueMm || 0) <= 60000);
  const rows = [];
  const seen = new Set();
  for (const dimension of dimensions) {
    if (Number(dimension.valueMm || 0) > MAX_PLAUSIBLE_NAMED_BEAM_SPAN_MM) continue;
    const span = dimensionSpanEvidence(dimension);
    if (!["horizontal", "vertical"].includes(span.orientation)) continue;
    const labelMatch = nearestBeamLabelForDimension(beamLabels, { ...dimension, orientation: span.orientation });
    const label = labelMatch.item;
    const id = canonicalBeamId(label?.text || "");
    if (!id) continue;
    const size = nearestBeamSizeForLabel(beamSizes, label, null);
    const widthMm = Number(size.item?.size?.widthMm || 0);
    const depthMm = Number(size.item?.size?.depthMm || 0);
    if (!(widthMm > 0 && depthMm > 0)) continue;
    const labelAlong = span.orientation === "horizontal" ? Number(label.x || 0) : Number(label.y || 0);
    const labelAxis = span.orientation === "horizontal" ? Number(label.y || span.fixed || 0) : Number(label.x || span.fixed || 0);
    const labelAxisDiff = Math.abs(labelAxis - span.fixed);
    const labelNearSpan = labelAlong >= span.start - Math.max(1000, Number(dimension.valueMm || 0) * 0.15) &&
      labelAlong <= span.end + Math.max(1000, Number(dimension.valueMm || 0) * 0.15);
    const strongSizeEvidence = ["same-line-orientation", "beam-detail-schedule"].includes(size.basis);
    const maxDimensionAxisOffset = Math.max(3000, Math.min(7500, Math.max(widthMm, depthMm, 450) * 10));
    if (!labelNearSpan || labelAxisDiff > maxDimensionAxisOffset) continue;
    if (!strongSizeEvidence && labelMatch.distance > 2500) continue;
    const key = [
      id,
      span.orientation,
      Math.round(labelAxis / 50),
      Math.round(span.start / 50),
      Math.round(span.end / 50),
      Math.round(Number(dimension.valueMm || 0) / 25),
      Math.round(widthMm),
      Math.round(depthMm),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const slabThickness = nearestSlabThicknessForLabel(slabInfo, label);
    const slabThicknessMm = slabThickness.valueMm || 0;
    const lengthM = Number(dimension.valueMm || 0) / 1000;
    rows.push({
      name: id,
      floor: role,
      length: lengthM,
      sideLength: lengthM,
      breadth: widthMm / 1000,
      height: depthMm / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: slabThicknessMm / 1000,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      dia: 16,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "marked-dimension-span-reader",
      needsReview: !["same-line-orientation", "beam-detail-schedule"].includes(size.basis) || labelMatch.distance > 9000,
      reviewNote: [
        "Beam span measured directly from marked CAD dimension.",
        labelMatch.distance > 9000 ? "Beam label is not close to this dimension; verify label association." : "",
        !["same-line-orientation", "beam-detail-schedule"].includes(size.basis) ? "Beam size was not confirmed on the same beam line or linked beam detail." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        fileName,
        existingBeamId: id,
        nearestSizeText: size.item?.text || "",
        nearestSlabMark: slabThickness.sourceText || "",
        sizeDistanceMm: Math.round(size.distance || 0),
        lineDistanceMm: 0,
        labelX: Math.round(label.x || 0),
        labelY: Math.round(label.y || 0),
        labelDistanceToDimensionMm: Math.round(labelMatch.distance || 0),
        faceSpan: {
          orientation: span.orientation === "horizontal" ? "H" : "V",
          fixed: labelAxis,
          start: span.start,
          end: span.end,
        },
        orientation: span.orientation === "vertical" ? "V" : "H",
        drawnLengthM: round3(lengthM),
        geometryLengthM: null,
        cadDimensionM: round3(lengthM),
        dimensionBasis: "marked-cad-dimension-span",
        dimensionValues: [{ source: dimension.valueSource || "marked-cad-dimension", valueM: round3(lengthM) }],
        dimensionConflict: false,
        markedFaceDimensionsM: [round3(lengthM)],
        sideFaceLengthsM: [round3(lengthM), round3(lengthM)],
        markedDimensionAuthoritative: true,
        lineKey: geometryKey([
          span.orientation === "horizontal" ? span.start : labelAxis,
          span.orientation === "horizontal" ? labelAxis : span.start,
          span.orientation === "horizontal" ? span.end : labelAxis,
          span.orientation === "horizontal" ? labelAxis : span.end,
        ], 50),
        sizeBasis: size.basis === "beam-detail-schedule"
          ? `Beam size read from linked beam detail schedule for ${id}.`
          : size.basis === "same-line-orientation"
            ? "Same beam line and same text orientation."
            : "Fallback size text; review before final billing.",
        sideLengthBasis: "Column caps excluded: side length equals marked beam span.",
        markedDimensionFastPath: true,
      },
    });
  }
  return rows;
}

function extractMarkedDimensionBeamRowsFast({ fileName, role, textEntities, slabInfo, grid, beamSizeById }) {
  const beamLabels = localBeamLabelsFromTextEntities(textEntities);
  const beamSizes = localBeamSizesFromTextEntities(textEntities, beamSizeById);
  const dimensionRows = extractMarkedDimensionBeamRowsByDimensions({
    fileName,
    role,
    beamLabels,
    beamSizes,
    slabInfo,
    grid,
  });
  const labelRows = recoverNamedBeamRowsFromMarkedDimensions({
    fileName,
    role,
    beamLabels,
    beamSizes,
    slabInfo,
    grid,
  });
  const rowPhysicalKey = (row) => {
    const id = beamRowMergeId(row) || String(row.name || "").trim().toUpperCase();
    const span = beamSpanFromRow(row);
    if (!span) {
      return [
        id,
        Math.round(Number(row.length || 0) * 1000 / 25),
        Math.round(Number(row.breadth || 0) * 1000),
        Math.round(Number(row.height || 0) * 1000),
      ].join(":");
    }
    return [
      id,
      span.orientation,
      Math.round(Number(span.fixed || 0) / 500),
      Math.round(Math.min(Number(span.start || 0), Number(span.end || 0)) / 250),
      Math.round(Math.max(Number(span.start || 0), Number(span.end || 0)) / 250),
      Math.round(Number(row.length || 0) * 1000 / 25),
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
  };
  const baseRows = dimensionRows.length >= Math.max(8, labelRows.length * 0.6)
    ? dimensionRows
    : labelRows;
  const baseIds = new Set(baseRows.map((row) => beamRowMergeId(row)).filter(Boolean));
  const supplementRows = (baseRows === dimensionRows ? labelRows : dimensionRows)
    .filter((row) => {
      const id = beamRowMergeId(row);
      return id && !baseIds.has(id);
    })
    .map((row) => ({
      ...row,
      reviewNote: [
        row.reviewNote,
        "Supplemented from the second marked-dimension reader because the primary reader missed this labelled beam/span.",
      ].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        markedDimensionSupplementRow: true,
      },
    }));
  const rows = uniqueRowsBy(
    baseRows.concat(supplementRows),
    rowPhysicalKey,
    (row) =>
      (row.needsReview ? 10000 : 0) +
      (row.evidence?.markedDimensionSupplementRow ? 250 : 0) +
      Number(row.evidence?.labelDistanceToDimensionMm || 0) +
      Number(row.evidence?.sizeDistanceMm || 0),
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      source: "marked-dimension-named-beam-fast-path",
      evidence: {
        ...(row.evidence || {}),
        markedDimensionFastPath: true,
      },
    })),
    diagnostics: {
      beamLabels: beamLabels.length,
      beamSizes: beamSizes.length,
      beamLines: 0,
      preliminaryRows: rows.length,
      logicRows: rows.length,
      baseRows: rows.length,
      rowsWithContinuations: rows.length,
      finalRows: rows.length,
      recoveredDimensionRows: rows.length,
      dimensionLedRows: dimensionRows.length,
      labelLedRows: labelRows.length,
      supplementRows: supplementRows.length,
      markedDimensionFastPath: true,
      markedDimensionEvidence: markedDimensionEvidenceCount(grid),
    },
  };
}

function mergeCollinearBeamSpan(seed, beamLines, sizeMm = 0, ownLabel = null, beamLabels = []) {
  if (!seed) return { line: seed, mergedLengthMm: 0, mergedSegments: [] };
  const orientation = lineOrientation(seed);
  if (orientation === "sloped") return { line: seed, mergedLengthMm: seed.lengthMm || lineLength(seed), mergedSegments: [seed] };

  const axisValue = orientation === "horizontal" ? seed.y : seed.x;
  const seedStart = orientation === "horizontal" ? Math.min(seed.x, seed.x2) : Math.min(seed.y, seed.y2);
  const seedEnd = orientation === "horizontal" ? Math.max(seed.x, seed.x2) : Math.max(seed.y, seed.y2);
  const axisToleranceMm = Math.max(80, sizeMm * 0.35);
  const gapToleranceMm = Math.max(700, sizeMm * 1.35);
  const labelAxisToleranceMm = 900;
  // A candidate line segment that itself sits under a DIFFERENT beam's own label is that beam's
  // own physical run, not an unlabelled continuation of this one - even when it is collinear
  // enough (within axis tolerance) to look like the same line (confirmed against the real
  // drawing: B31's own 4.58m segment sits on a row 70mm off B32's own 2.024m segment - close
  // enough to pass the axis tolerance meant for a single beam's own minor line jitter - and got
  // absorbed into B32's span here; the later "trim at other labels" step only cuts at the
  // midpoint between label positions, which is correct only when the merged members happen to
  // share a length, and wrong whenever they differ, as every one of B31-B34 does). Block merging
  // in any candidate whose own span contains a different beam's label.
  function candidateBelongsToDifferentLabel(candidateStart, candidateEnd) {
    if (!ownLabel) return false;
    return beamLabels.some((item) => {
      if (item === ownLabel || item.text === ownLabel.text) return false;
      if (textOrientation(item) !== orientation) return false;
      const pos = orientation === "horizontal" ? item.x : item.y;
      const itemAxis = orientation === "horizontal" ? item.y : item.x;
      if (Math.abs(itemAxis - axisValue) > labelAxisToleranceMm) return false;
      return pos >= candidateStart - 50 && pos <= candidateEnd + 50;
    });
  }

  const candidates = beamLines
    .filter((line) => lineOrientation(line) === orientation)
    .filter((line) => Math.abs((orientation === "horizontal" ? line.y : line.x) - axisValue) <= axisToleranceMm)
    .map((line) => ({
      line,
      start: orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2),
      end: orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2),
    }))
    .sort((a, b) => a.start - b.start);

  let spanStart = seedStart;
  let spanEnd = seedEnd;
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      const touches = candidate.end >= spanStart - gapToleranceMm && candidate.start <= spanEnd + gapToleranceMm;
      if (!touches) continue;
      const nextStart = Math.min(spanStart, candidate.start);
      const nextEnd = Math.max(spanEnd, candidate.end);
      if (nextStart === spanStart && nextEnd === spanEnd) continue;
      if (candidateBelongsToDifferentLabel(candidate.start, candidate.end)) continue;
      spanStart = nextStart;
      spanEnd = nextEnd;
      changed = true;
    }
  }

  const mergedSegments = candidates
    .filter((candidate) => candidate.end >= spanStart - 1 && candidate.start <= spanEnd + 1)
    .map((candidate) => candidate.line);
  const mergedLine = {
    ...seed,
    x: orientation === "horizontal" ? spanStart : axisValue,
    x2: orientation === "horizontal" ? spanEnd : axisValue,
    y: orientation === "horizontal" ? axisValue : spanStart,
    y2: orientation === "horizontal" ? axisValue : spanEnd,
    lengthMm: spanEnd - spanStart,
  };
  return { line: mergedLine, mergedLengthMm: spanEnd - spanStart, mergedSegments };
}

// The merged span can reach well past this beam's own drawn geometry (into a neighbour's
// absorbed stub - see mergeCollinearBeamSpan), so "our own segment" is whichever raw merged
// segment sits nearest this label, not the merged line's own far edge.
function ownSegmentIntervalNearestPosition(segments, orientation, position) {
  let best = null;
  let bestDistance = Infinity;
  for (const seg of segments) {
    const start = orientation === "horizontal" ? Math.min(seg.x, seg.x2) : Math.min(seg.y, seg.y2);
    const end = orientation === "horizontal" ? Math.max(seg.x, seg.x2) : Math.max(seg.y, seg.y2);
    const dist = position < start ? start - position : position > end ? position - end : 0;
    if (dist < bestDistance) {
      bestDistance = dist;
      best = { start, end };
    }
  }
  return best;
}

function trimBeamSpanAtOtherLabels(line, label, beamLabels, segments = []) {
  if (!line || !label) return { line, trimmedBy: null };
  const orientation = lineOrientation(line);
  if (orientation === "sloped") return { line, trimmedBy: null };
  const axisValue = orientation === "horizontal" ? line.y : line.x;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const labelPos = orientation === "horizontal" ? label.x : label.y;
  const conflicts = beamLabels
    .filter((item) => item.text !== label.text)
    .filter((item) => textOrientation(item) === orientation)
    .map((item) => ({
      label: item,
      axisDistance: Math.abs((orientation === "horizontal" ? item.y : item.x) - axisValue),
      position: orientation === "horizontal" ? item.x : item.y,
    }))
    .filter((item) => item.axisDistance <= 900 && item.position > start && item.position < end)
    .sort((a, b) => Math.abs(a.position - labelPos) - Math.abs(b.position - labelPos));

  if (!conflicts.length) return { line, trimmedBy: null };
  const ownSegment = segments.length ? ownSegmentIntervalNearestPosition(segments, orientation, labelPos) : null;
  let nextStart = start;
  let nextEnd = end;
  let trimmedBy = null;
  for (const conflict of conflicts) {
    const midpoint = (conflict.position + labelPos) / 2;
    if (conflict.position > labelPos) {
      // Cut at our own segment's real end, not the label midpoint - confirmed against the real
      // drawing: MB39's own drawn end sits at 3071513, but the midpoint against T2B40's label
      // landed at 3072208, still 700mm inside T2B40's absorbed stub.
      const cut = ownSegment && ownSegment.end >= labelPos && ownSegment.end <= midpoint ? ownSegment.end : midpoint;
      nextEnd = Math.min(nextEnd, cut);
      trimmedBy = conflict.label.text;
    } else {
      const cut = ownSegment && ownSegment.start <= labelPos && ownSegment.start >= midpoint ? ownSegment.start : midpoint;
      nextStart = Math.max(nextStart, cut);
      trimmedBy = conflict.label.text;
    }
  }
  const trimmedLine = {
    ...line,
    x: orientation === "horizontal" ? nextStart : axisValue,
    x2: orientation === "horizontal" ? nextEnd : axisValue,
    y: orientation === "horizontal" ? axisValue : nextStart,
    y2: orientation === "horizontal" ? axisValue : nextEnd,
    lengthMm: Math.max(nextEnd - nextStart, 0),
  };
  return { line: trimmedLine, trimmedBy };
}

function sameBeamLabelAcrossFace(label, beamLabels, orientation, axis, face, direction, spanStart, spanEnd) {
  const axisTolerance = 900;
  return beamLabels
    .filter((item) => item.text === label.text && item !== label)
    .filter((item) => textOrientation(item) === orientation)
    .map((item) => ({
      position: orientation === "horizontal" ? item.x : item.y,
      axisDistance: Math.abs((orientation === "horizontal" ? item.y : item.x) - axis),
    }))
    .some((item) => {
      if (item.axisDistance > axisTolerance || item.position <= spanStart || item.position >= spanEnd) return false;
      return direction > 0 ? item.position > face : item.position < face;
    });
}

function pairedBeamEdgesContinueAcrossFace(beamLines, orientation, axis, face, direction, widthMm = 0) {
  const axisTolerance = Math.max(80, widthMm * 0.25);
  const oppositeMin = Math.max(120, widthMm * 0.45);
  const oppositeMax = Math.max(250, widthMm * 1.55);
  const continuationMin = Math.max(450, widthMm * 1.1);
  const resumeGap = Math.max(900, widthMm * 2);

  function interval(line) {
    return orientation === "horizontal"
      ? { start: Math.min(line.x, line.x2), end: Math.max(line.x, line.x2), axis: line.y }
      : { start: Math.min(line.y, line.y2), end: Math.max(line.y, line.y2), axis: line.x };
  }

  function crossesFace(item) {
    return item.start < face - 50 &&
      item.end > face + 50 &&
      (direction > 0 ? item.end - face >= continuationMin : face - item.start >= continuationMin);
  }

  function resumesAfterFace(item) {
    if (direction > 0) {
      return item.start >= face - 75 &&
        item.start <= face + resumeGap &&
        item.end - item.start >= continuationMin;
    }
    return item.end <= face + 75 &&
      item.end >= face - resumeGap &&
      item.end - item.start >= continuationMin;
  }

  const primaryEdges = beamLines
    .filter((item) => lineOrientation(item) === orientation)
    .map((item) => ({ item, ...interval(item) }))
    .filter((item) => Math.abs(item.axis - axis) <= axisTolerance)
    .filter((item) => crossesFace(item) || resumesAfterFace(item));

  if (!primaryEdges.length) return false;

  return beamLines
    .filter((item) => lineOrientation(item) === orientation)
    .map((item) => ({ item, ...interval(item) }))
    .filter((item) => {
      const axisDistance = Math.abs(item.axis - axis);
      return axisDistance >= oppositeMin && axisDistance <= oppositeMax;
    })
    .some((item) => crossesFace(item) || resumesAfterFace(item));
}

function beamContinuesAcrossFace(label, beamLabels, beamLines, orientation, axis, face, direction, spanStart, spanEnd, widthMm = 0) {
  return sameBeamLabelAcrossFace(label, beamLabels, orientation, axis, face, direction, spanStart, spanEnd) ||
    pairedBeamEdgesContinueAcrossFace(beamLines, orientation, axis, face, direction, widthMm);
}

function trimBeamSpanAtTerminalSupportFace(line, label, beamLabels, beamLines, supports, widthMm = 0) {
  if (!line || !label || !supports.length) return { line, trims: [] };
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return { line, trims: [] };

  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const labelPos = orientation === "horizontal" ? label.x : label.y;
  const overlapTolerance = Math.max(350, widthMm * 0.65);
  const terminalZoneMm = Math.max(2200, widthMm * 5);

  function overlapsAxis(support) {
    return orientation === "horizontal"
      ? support.minY <= axis + overlapTolerance && support.maxY >= axis - overlapTolerance
      : support.minX <= axis + overlapTolerance && support.maxX >= axis - overlapTolerance;
  }

  function supportInterval(support) {
    const localEdge = localSupportEdgeAtAxis(support, orientation, axis);
    if (Number.isFinite(localEdge)) return { min: localEdge, max: localEdge };
    return orientation === "horizontal"
      ? { min: support.minX, max: support.maxX }
      : { min: support.minY, max: support.maxY };
  }

  let nextStart = start;
  let nextEnd = end;
  const trims = [];

  const leftStops = supports
    .filter(overlapsAxis)
    .map((support) => ({ support, interval: supportInterval(support) }))
    .filter(({ interval }) => interval.max > start && interval.max < Math.min(labelPos, end))
    .filter(({ interval }) => interval.max - start <= terminalZoneMm)
    .filter(({ interval }) => !beamContinuesAcrossFace(label, beamLabels, beamLines, orientation, axis, interval.min, -1, start, end, widthMm))
    .sort((a, b) => b.interval.max - a.interval.max);

  if (leftStops[0]) {
    nextStart = Math.max(nextStart, leftStops[0].interval.max);
    trims.push({
      side: "start",
      layer: leftStops[0].support.layer,
      faceCoordinate: Math.round(leftStops[0].interval.max),
      supportAlongM: Math.round(((orientation === "horizontal" ? leftStops[0].support.widthM : leftStops[0].support.heightM) || 0) * 1000) / 1000,
      removedM: Math.round(((leftStops[0].interval.max - start) / 1000) * 1000) / 1000,
    });
  }

  const rightStops = supports
    .filter(overlapsAxis)
    .map((support) => ({ support, interval: supportInterval(support) }))
    .filter(({ interval }) => interval.min < end && interval.min > Math.max(labelPos, start))
    .filter(({ interval }) => end - interval.min <= terminalZoneMm)
    .filter(({ interval }) => !beamContinuesAcrossFace(label, beamLabels, beamLines, orientation, axis, interval.max, 1, start, end, widthMm))
    .sort((a, b) => a.interval.min - b.interval.min);

  if (rightStops[0]) {
    nextEnd = Math.min(nextEnd, rightStops[0].interval.min);
    trims.push({
      side: "end",
      layer: rightStops[0].support.layer,
      faceCoordinate: Math.round(rightStops[0].interval.min),
      supportAlongM: Math.round(((orientation === "horizontal" ? rightStops[0].support.widthM : rightStops[0].support.heightM) || 0) * 1000) / 1000,
      removedM: Math.round(((end - rightStops[0].interval.min) / 1000) * 1000) / 1000,
    });
  }

  if (!trims.length || nextEnd <= nextStart) return { line, trims: [] };
  const trimmedLine = {
    ...line,
    x: orientation === "horizontal" ? nextStart : axis,
    x2: orientation === "horizontal" ? nextEnd : axis,
    y: orientation === "horizontal" ? axis : nextStart,
    y2: orientation === "horizontal" ? axis : nextEnd,
    lengthMm: Math.max(nextEnd - nextStart, 0),
  };
  return { line: trimmedLine, trims };
}

function trimBeamSpanToNearestSupportBracket(line, label, beamLabels, supports, widthMm = 0) {
  if (!line || !label || !supports.length) return { line, trims: [] };
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return { line, trims: [] };

  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const labelPos = orientation === "horizontal" ? Number(label.x || 0) : Number(label.y || 0);
  if (!Number.isFinite(labelPos) || labelPos <= start || labelPos >= end) return { line, trims: [] };

  const overlapTolerance = Math.max(350, widthMm * 0.75);
  const bracketSearchMm = Math.max(6500, Math.min(18000, Math.max(widthMm, 450) * 36));
  const minBeamLengthMm = Math.max(350, widthMm * 1.25);

  function overlapsAxis(support) {
    return orientation === "horizontal"
      ? support.minY <= axis + overlapTolerance && support.maxY >= axis - overlapTolerance
      : support.minX <= axis + overlapTolerance && support.maxX >= axis - overlapTolerance;
  }

  function supportInterval(support) {
    const localEdge = localSupportEdgeAtAxis(support, orientation, axis);
    if (Number.isFinite(localEdge)) return { min: localEdge, max: localEdge };
    return orientation === "horizontal"
      ? { min: support.minX, max: support.maxX }
      : { min: support.minY, max: support.maxY };
  }

  const supportItems = supports
    .filter(overlapsAxis)
    .map((support) => ({ support, interval: supportInterval(support) }));

  const leftStop = supportItems
    .filter(({ interval }) => interval.max < labelPos && labelPos - interval.max <= bracketSearchMm)
    .filter(({ interval }) => !sameBeamLabelAcrossFace(label, beamLabels, orientation, axis, interval.min, -1, start, end))
    .sort((a, b) => b.interval.max - a.interval.max)[0];

  const rightStop = supportItems
    .filter(({ interval }) => interval.min > labelPos && interval.min - labelPos <= bracketSearchMm)
    .filter(({ interval }) => !sameBeamLabelAcrossFace(label, beamLabels, orientation, axis, interval.max, 1, start, end))
    .sort((a, b) => a.interval.min - b.interval.min)[0];

  if (!leftStop && !rightStop) return { line, trims: [] };
  const nextStart = leftStop ? Math.max(start, leftStop.interval.max) : start;
  const nextEnd = rightStop ? Math.min(end, rightStop.interval.min) : end;
  const originalLength = end - start;
  const nextLength = nextEnd - nextStart;
  if (nextLength < minBeamLengthMm || nextLength >= originalLength - 50) return { line, trims: [] };

  const trims = [];
  if (leftStop && nextStart > start + 50) {
    trims.push({
      side: "start",
      layer: leftStop.support.layer,
      faceCoordinate: Math.round(nextStart),
      removedM: round3((nextStart - start) / 1000),
      basis: "nearest support face before beam label; no same beam label continues beyond this support",
    });
  }
  if (rightStop && nextEnd < end - 50) {
    trims.push({
      side: "end",
      layer: rightStop.support.layer,
      faceCoordinate: Math.round(nextEnd),
      removedM: round3((end - nextEnd) / 1000),
      basis: "nearest support face after beam label; no same beam label continues beyond this support",
    });
  }
  if (!trims.length) return { line, trims: [] };

  const trimmedLine = {
    ...line,
    x: orientation === "horizontal" ? nextStart : axis,
    x2: orientation === "horizontal" ? nextEnd : axis,
    y: orientation === "horizontal" ? axis : nextStart,
    y2: orientation === "horizontal" ? axis : nextEnd,
    lengthMm: Math.max(nextLength, 0),
  };
  return { line: trimmedLine, trims };
}

function trimBeamSpanByParallelEdgeAgreement(line, beamLines, widthMm = 0) {
  if (!line || !widthMm) return { line, trims: [] };
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return { line, trims: [] };

  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const edgeMin = Math.max(120, widthMm * 0.45);
  const edgeMax = Math.max(250, widthMm * 1.55);
  const maxTrimMm = Math.max(1800, widthMm * 5);

  const oppositeEdges = beamLines
    .filter((item) => lineOrientation(item) === orientation)
    .map((item) => {
      const itemAxis = orientation === "horizontal" ? item.y : item.x;
      const itemStart = orientation === "horizontal" ? Math.min(item.x, item.x2) : Math.min(item.y, item.y2);
      const itemEnd = orientation === "horizontal" ? Math.max(item.x, item.x2) : Math.max(item.y, item.y2);
      const overlap = Math.max(0, Math.min(end, itemEnd) - Math.max(start, itemStart));
      return { item, axisDistance: Math.abs(itemAxis - axis), start: itemStart, end: itemEnd, overlap };
    })
    .filter((item) => item.axisDistance >= edgeMin && item.axisDistance <= edgeMax)
    .filter((item) => item.overlap >= Math.min(end - start, item.end - item.start) * 0.45)
    .sort((a, b) => b.overlap - a.overlap);

  if (!oppositeEdges.length) return { line, trims: [] };
  const companion = oppositeEdges[0];
  const companionAxis = orientation === "horizontal" ? companion.item.y : companion.item.x;
  const companionAxisTolerance = Math.max(70, widthMm * 0.18);
  const companionGapTolerance = Math.max(900, widthMm * 2);

  let companionStart = companion.start;
  let companionEnd = companion.end;
  let changed = true;
  while (changed) {
    changed = false;
    beamLines
      .filter((item) => lineOrientation(item) === orientation)
      .map((item) => {
        const itemAxis = orientation === "horizontal" ? item.y : item.x;
        const itemStart = orientation === "horizontal" ? Math.min(item.x, item.x2) : Math.min(item.y, item.y2);
        const itemEnd = orientation === "horizontal" ? Math.max(item.x, item.x2) : Math.max(item.y, item.y2);
        return { itemAxis, itemStart, itemEnd };
      })
      .filter((item) => Math.abs(item.itemAxis - companionAxis) <= companionAxisTolerance)
      .filter((item) => item.itemEnd >= companionStart - companionGapTolerance && item.itemStart <= companionEnd + companionGapTolerance)
      .forEach((item) => {
        const nextStart = Math.min(companionStart, item.itemStart);
        const nextEnd = Math.max(companionEnd, item.itemEnd);
        if (nextStart !== companionStart || nextEnd !== companionEnd) {
          companionStart = nextStart;
          companionEnd = nextEnd;
          changed = true;
        }
      });
  }

  let nextStart = start;
  let nextEnd = end;
  const trims = [];

  const startExtra = companionStart - start;
  if (startExtra > 50 && startExtra <= maxTrimMm) {
    nextStart = companionStart;
    trims.push({
      side: "start",
      reason: "parallel-edge-shorter",
      edgeLayer: companion.item.layer,
      edgeCoordinate: Math.round(companionStart),
      removedM: Math.round((startExtra / 1000) * 1000) / 1000,
    });
  }

  const endExtra = end - companionEnd;
  if (endExtra > 50 && endExtra <= maxTrimMm) {
    nextEnd = companionEnd;
    trims.push({
      side: "end",
      reason: "parallel-edge-shorter",
      edgeLayer: companion.item.layer,
      edgeCoordinate: Math.round(companionEnd),
      removedM: Math.round((endExtra / 1000) * 1000) / 1000,
    });
  }

  if (!trims.length || nextEnd <= nextStart) return { line, trims: [] };
  const trimmedLine = {
    ...line,
    x: orientation === "horizontal" ? nextStart : axis,
    x2: orientation === "horizontal" ? nextEnd : axis,
    y: orientation === "horizontal" ? axis : nextStart,
    y2: orientation === "horizontal" ? axis : nextEnd,
    lengthMm: Math.max(nextEnd - nextStart, 0),
  };
  return { line: trimmedLine, trims };
}

function extendBeamLineToSupportFaces(line, supports, widthMm = 0) {
  if (!line) return { line, extensionMm: 0, extensions: [] };
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return { line, extensionMm: 0, extensions: [] };

  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const overlapTolerance = Math.max(450, widthMm * 0.8);
  const maxExtension = 25;

  function overlapsAxis(support) {
    return orientation === "horizontal"
      ? support.minY <= axis + overlapTolerance && support.maxY >= axis - overlapTolerance
      : support.minX <= axis + overlapTolerance && support.maxX >= axis - overlapTolerance;
  }

  const leftOrBottom = supports
    .filter(overlapsAxis)
    .map((support) => {
      const face = orientation === "horizontal" ? support.maxX : support.maxY;
      return { support, face, delta: start - face };
    })
    .filter((item) => item.delta > 0 && item.delta <= maxExtension)
    .sort((a, b) => a.delta - b.delta)[0];

  const rightOrTop = supports
    .filter(overlapsAxis)
    .map((support) => {
      const face = orientation === "horizontal" ? support.minX : support.minY;
      return { support, face, delta: face - end };
    })
    .filter((item) => item.delta > 0 && item.delta <= maxExtension)
    .sort((a, b) => a.delta - b.delta)[0];

  const nextStart = leftOrBottom ? leftOrBottom.face : start;
  const nextEnd = rightOrTop ? rightOrTop.face : end;
  const extended = {
    ...line,
    x: orientation === "horizontal" ? nextStart : line.x,
    x2: orientation === "horizontal" ? nextEnd : line.x2,
    y: orientation === "horizontal" ? line.y : nextStart,
    y2: orientation === "horizontal" ? line.y2 : nextEnd,
    lengthMm: Math.max(nextEnd - nextStart, 0),
  };
  const extensions = [leftOrBottom, rightOrTop]
    .filter(Boolean)
    .map((item) => ({
      layer: item.support.layer,
      extensionM: Math.round((item.delta / 1000) * 1000) / 1000,
      faceCoordinate: Math.round(item.face),
    }));
  const extensionMm = (leftOrBottom?.delta || 0) + (rightOrTop?.delta || 0);
  return { line: extended, extensionMm, extensions };
}

function nearestSupportLabel(textEntities, support) {
  return textEntities
    .filter((item) => /^T\d*[A-Z]*W\d+[A-Z]?$|^T\d*PW\d+[A-Z]?$/i.test(item.text) && Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => ({ item, distance: Math.hypot(item.x - support.centerX, item.y - support.centerY) }))
    .filter((found) => found.distance <= 3500)
    .sort((a, b) => a.distance - b.distance)[0]?.item || null;
}

function beamSupportConditions(line, textEntities, supports) {
  if (!line) return { conditions: [], sideExtensionMm: 0, needsReview: false };
  const endpoints = [
    { x: line.x, y: line.y, end: "start" },
    { x: line.x2, y: line.y2, end: "end" },
  ];
  const conditions = endpoints.map((point) => {
    const support = supports
      .map((item) => {
        const dx = Math.max(item.minX - point.x, 0, point.x - item.maxX);
        const dy = Math.max(item.minY - point.y, 0, point.y - item.maxY);
        return { item, distance: Math.hypot(dx, dy) };
      })
      .filter((found) => found.distance <= 800)
      .sort((a, b) => a.distance - b.distance)[0]?.item;
    if (!support) return { end: point.end, type: "open", label: "", layer: "", distanceMm: null };
    const label = nearestSupportLabel(textEntities, support);
    return {
      end: point.end,
      type: /^RET\.?\s*WALL|RC\s*PARDI/i.test(support.layer || "") || /^T\d*[A-Z]*W|^T\d*PW/i.test(label?.text || "") ? "wall-support" : "column-support",
      label: label?.text || "",
      layer: support.layer,
      continuationStatus: support.continuationStatus || "unknown",
      fillPattern: support.fillPattern || "",
      fillEvidence: support.fillEvidence || "",
      distanceMm: 0,
      widthM: Math.round(support.widthM * 1000) / 1000,
      heightM: Math.round(support.heightM * 1000) / 1000,
    };
  });
  const needsReview = false;
  return { conditions, sideExtensionMm: 0, needsReview };
}

function continuousSupportJointDeductions(line, label, beamLabels, beamLines, supports, widthMm = 0, depthMm = 0, slabThicknessMm = 0) {
  if (!line || !supports.length || !widthMm || !depthMm) {
    return { bottomJointDeduction: 0, sideJointDeduction: 0, joints: [] };
  }
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) {
    return { bottomJointDeduction: 0, sideJointDeduction: 0, joints: [] };
  }

  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const overlapTolerance = Math.max(350, widthMm * 0.65);
  const breadthM = widthMm / 1000;
  const sideHeightM = Math.max((depthMm - slabThicknessMm) / 1000, 0);

  function supportInterval(support) {
    return orientation === "horizontal"
      ? { min: support.minX, max: support.maxX, crossMin: support.minY, crossMax: support.maxY }
      : { min: support.minY, max: support.maxY, crossMin: support.minX, crossMax: support.maxX };
  }

  const joints = [];
  for (const support of supports) {
    const interval = supportInterval(support);
    if (interval.crossMin > axis + overlapTolerance || interval.crossMax < axis - overlapTolerance) continue;
    const overlapMm = Math.max(0, Math.min(end, interval.max) - Math.max(start, interval.min));
    if (overlapMm <= 50) continue;

    const isInternal = interval.min > start + 50 && interval.max < end - 50;
    const continuesAcrossStartFace = interval.min > start + 50 &&
      beamContinuesAcrossFace(label, beamLabels, beamLines, orientation, axis, interval.min, 1, start, end, widthMm);
    const continuesAcrossEndFace = interval.max < end - 50 &&
      beamContinuesAcrossFace(label, beamLabels, beamLines, orientation, axis, interval.max, -1, start, end, widthMm);
    if (!isInternal && !(continuesAcrossStartFace && continuesAcrossEndFace)) continue;

    const overlapM = overlapMm / 1000;
    joints.push({
      layer: support.layer,
      continuationStatus: support.continuationStatus || "unknown",
      fillPattern: support.fillPattern || "",
      overlapM: Math.round(overlapM * 1000) / 1000,
      bottomDeductionM2: Math.round((overlapM * breadthM) * 1000) / 1000,
      sideDeductionM2: Math.round((2 * overlapM * sideHeightM) * 1000) / 1000,
      basis: "Continuous beam through wall/column/support; length kept full, shuttering overlap deducted separately.",
    });
  }

  return {
    bottomJointDeduction: joints.reduce((sum, item) => sum + item.bottomDeductionM2, 0),
    sideJointDeduction: joints.reduce((sum, item) => sum + item.sideDeductionM2, 0),
    joints,
  };
}

function beamLineIntervalForOrientation(line, orientation) {
  if (!line || !["horizontal", "vertical"].includes(orientation)) return null;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(axis) || end <= start) return null;
  return { line, axis, start, end, lengthMm: end - start };
}

function pairedBeamFacesForLabel(label, orientedLines, widthMm = 0) {
  if (!label || !orientedLines.length) return null;
  const orientation = textOrientation(label);
  if (!["horizontal", "vertical"].includes(orientation)) return null;
  const seed = nearest(orientedLines, label, pointToSegmentDistance);
  const maxSeedDistanceMm = Math.max(1700, Math.min(4200, Math.max(widthMm || 0, 450) * 7));
  if (!seed.item || seed.distance > maxSeedDistanceMm) return null;

  const seedInterval = beamLineIntervalForOrientation(seed.item, orientation);
  if (!seedInterval) return null;
  const edgeMin = Math.max(90, (widthMm || 300) * 0.35);
  const edgeMax = Math.max(360, (widthMm || 450) * 1.9);
  const opposite = orientedLines
    .filter((line) => line !== seed.item)
    .map((line) => {
      const interval = beamLineIntervalForOrientation(line, orientation);
      if (!interval) return null;
      const overlap = Math.max(0, Math.min(seedInterval.end, interval.end) - Math.max(seedInterval.start, interval.start));
      return {
        interval,
        axisDistance: Math.abs(interval.axis - seedInterval.axis),
        overlap,
      };
    })
    .filter(Boolean)
    .filter((item) => item.axisDistance >= edgeMin && item.axisDistance <= edgeMax)
    .filter((item) => item.overlap >= Math.max(250, Math.min(seedInterval.lengthMm, item.interval.lengthMm) * 0.25))
    .sort((a, b) =>
      b.overlap - a.overlap ||
      Math.abs(a.axisDistance - (widthMm || 450)) - Math.abs(b.axisDistance - (widthMm || 450)))[0];
  if (!opposite) return null;

  const intervals = [seedInterval, opposite.interval];
  const axes = intervals.map((item) => item.axis).sort((a, b) => a - b);
  const commonStart = finiteMax(intervals.map((item) => item.start), 0);
  const commonEnd = finiteMin(intervals.map((item) => item.end), 0);
  const envelopeStart = finiteMin(intervals.map((item) => item.start), 0);
  const envelopeEnd = finiteMax(intervals.map((item) => item.end), 0);
  const minClearSpanMm = Math.max(450, Math.min(1500, (widthMm || 450) * 1.5));
  const start = commonEnd - commonStart >= minClearSpanMm ? commonStart : envelopeStart;
  const end = commonEnd - commonStart >= minClearSpanMm ? commonEnd : envelopeEnd;
  const axis = (axes[0] + axes[1]) / 2;
  return {
    orientation,
    axis,
    axes,
    start,
    end,
    envelopeStart,
    envelopeEnd,
    intervals,
    seedDistanceMm: seed.distance,
    seedLine: seed.item,
    oppositeLine: opposite.interval.line,
    faceStyles: intervals.map((item, index) => ({
      face: `face-${index + 1}`,
      style: beamFaceLineStyle(item.line),
      lineType: item.line.linetype || item.line.lineType || "",
      layer: item.line.layer || "",
      lengthM: round3(item.lengthMm / 1000),
    })),
  };
}

// The drawing's own general note says beam depth is fixed (650mm here) but "WIDTH AS PER PLAN" -
// i.e. width must be read off the beam's own drawn parallel edges, not a text callout, whenever
// no size text sits close enough to trust. Reuses pairedBeamFacesForLabel's own edge-pairing
// logic (overlap %, distance bounds) with a zero seed width, which it already tolerates via its
// own defaults, so this needs no new geometry-matching logic.
function geometricWidthMmForLabel(label, beamLinesForLabel) {
  const candidate = pairedBeamFacesForLabel(label, beamLinesForLabel, 0);
  if (!candidate || candidate.axes.length !== 2) return 0;
  const gapMm = Math.abs(candidate.axes[1] - candidate.axes[0]);
  return gapMm >= 120 && gapMm <= 900 ? Math.round(gapMm) : 0;
}

function supportItemsOnBeamAxis(supports, orientation, axis, widthMm = 0) {
  const tolerance = Math.max(350, (widthMm || 450) * 0.8);
  return supports
    .filter((support) => orientation === "horizontal"
      ? support.minY <= axis + tolerance && support.maxY >= axis - tolerance
      : support.minX <= axis + tolerance && support.maxX >= axis - tolerance)
    .map((support) => ({
      support,
      start: orientation === "horizontal" ? support.minX : support.minY,
      end: orientation === "horizontal" ? support.maxX : support.maxY,
      crossStart: orientation === "horizontal" ? support.minY : support.minX,
      crossEnd: orientation === "horizontal" ? support.maxY : support.maxX,
    }))
    .filter((item) => item.end > item.start);
}

function trimBayPatternSpanToSupportFaces(candidate, supports, widthMm = 0) {
  if (!candidate) return { start: 0, end: 0, trims: [], hasTerminalSupport: false };
  const labelAlong = candidate.labelAlong;
  const supportItems = supportItemsOnBeamAxis(supports, candidate.orientation, candidate.axis, widthMm);
  const searchStart = candidate.envelopeStart;
  const searchEnd = candidate.envelopeEnd;
  const leftSupport = supportItems
    .filter((item) => item.end <= labelAlong + Math.max(300, (widthMm || 450) * 0.8))
    .filter((item) => item.end >= searchStart - Math.max(1200, (widthMm || 450) * 3))
    .sort((a, b) => b.end - a.end)[0];
  const rightSupport = supportItems
    .filter((item) => item.start >= labelAlong - Math.max(300, (widthMm || 450) * 0.8))
    .filter((item) => item.start <= searchEnd + Math.max(1200, (widthMm || 450) * 3))
    .sort((a, b) => a.start - b.start)[0];

  let start = candidate.start;
  let end = candidate.end;
  const trims = [];
  if (leftSupport && leftSupport.end > start - Math.max(1000, (widthMm || 450) * 2) && leftSupport.end < end) {
    const previousStart = start;
    start = Math.max(start, leftSupport.end);
    if (start > previousStart + 25) {
      trims.push({
        side: "start",
        layer: leftSupport.support.layer,
        faceCoordinate: Math.round(leftSupport.end),
        removedM: round3((start - previousStart) / 1000),
        basis: "bay-wise beam span starts at support/wall/column face",
      });
    }
  }
  if (rightSupport && rightSupport.start < end + Math.max(1000, (widthMm || 450) * 2) && rightSupport.start > start) {
    const previousEnd = end;
    end = Math.min(end, rightSupport.start);
    if (previousEnd > end + 25) {
      trims.push({
        side: "end",
        layer: rightSupport.support.layer,
        faceCoordinate: Math.round(rightSupport.start),
        removedM: round3((previousEnd - end) / 1000),
        basis: "bay-wise beam span ends at support/wall/column face",
      });
    }
  }
  if (end <= start) {
    return {
      start: candidate.start,
      end: candidate.end,
      trims: [],
      hasTerminalSupport: false,
    };
  }
  return {
    start,
    end,
    trims,
    hasTerminalSupport: Boolean(leftSupport || rightSupport || trims.length),
  };
}

function beamLineFromPatternCandidate(candidate, start, end) {
  return candidate.orientation === "horizontal"
    ? { x: start, y: candidate.axis, x2: end, y2: candidate.axis, lengthMm: Math.max(end - start, 0) }
    : { x: candidate.axis, y: start, x2: candidate.axis, y2: end, lengthMm: Math.max(end - start, 0) };
}

function sameBeamContinuesOnPatternRun(label, candidate, beamLabels, widthMm = 0) {
  const id = canonicalBeamId(label?.text || "");
  if (!id || !candidate) return false;
  const crossTolerance = Math.max(900, (widthMm || 450) * 2.2);
  const alongPad = Math.max(1200, (widthMm || 450) * 3);
  return beamLabels
    .filter((item) => item !== label && item.text === id)
    .filter((item) => textOrientation(item) === candidate.orientation)
    .some((item) => {
      const along = candidate.orientation === "horizontal" ? item.x : item.y;
      const cross = candidate.orientation === "horizontal" ? item.y : item.x;
      const crossDistance = minAbsDistance(candidate.axes, cross);
      if (crossDistance > crossTolerance) return false;
      return along >= candidate.envelopeStart - alongPad && along <= candidate.envelopeEnd + alongPad;
    });
}

function differentBeamNeighborEvidence(label, candidate, beamLabels, widthMm = 0) {
  const id = canonicalBeamId(label?.text || "");
  if (!id || !candidate) return [];
  const crossTolerance = Math.max(900, (widthMm || 450) * 2.2);
  const alongPad = Math.max(1200, (widthMm || 450) * 3);
  return beamLabels
    .filter((item) => item !== label && item.text !== id)
    .filter((item) => textOrientation(item) === candidate.orientation)
    .map((item) => {
      const along = candidate.orientation === "horizontal" ? item.x : item.y;
      const cross = candidate.orientation === "horizontal" ? item.y : item.x;
      return {
        text: item.text,
        along,
        crossDistance: minAbsDistance(candidate.axes, cross),
      };
    })
    .filter((item) => item.crossDistance <= crossTolerance)
    .filter((item) => item.along >= candidate.envelopeStart - alongPad && item.along <= candidate.envelopeEnd + alongPad)
    .slice(0, 4);
}

function extractUnmarkedBayWiseBeamRowsByMarkedPattern({ fileName, role, beamLabels, beamSizes, beamLines, slabInfo, grid, supports }) {
  const rows = [];
  for (const label of beamLabels) {
    const orientation = textOrientation(label);
    if (!["horizontal", "vertical"].includes(orientation)) continue;
    const orientedLines = beamLines.filter((line) => lineOrientation(line) === orientation);
    if (!orientedLines.length) continue;
    const size = nearestBeamSizeForLabel(beamSizes, label, null);
    const widthMm = size.item?.size.widthMm || 0;
    const depthMm = size.item?.size.depthMm || 0;
    if (!widthMm || !depthMm) continue;
    const candidate = pairedBeamFacesForLabel(label, orientedLines, widthMm);
    if (!candidate) continue;
    candidate.labelAlong = orientation === "horizontal" ? label.x : label.y;
    const skipContinuousSameName = sameBeamContinuesOnPatternRun(label, candidate, beamLabels, widthMm);
    if (skipContinuousSameName) continue;

    const trimmed = trimBayPatternSpanToSupportFaces(candidate, supports, widthMm);
    const geometryMm = Math.max(trimmed.end - trimmed.start, 0);
    if (geometryMm < Math.max(350, widthMm * 1.2)) continue;
    const line = beamLineFromPatternCandidate(candidate, trimmed.start, trimmed.end);
    const cadDimension = cadDimensionForSpan(grid.dimensions, line, orientation);
    const dimensionChoice = chooseMeasuredDimension({
      cadDimension,
      gridDimension: null,
      geometryMm,
      preferGeometryWhenCadExceeds: trimmed.hasTerminalSupport,
    });
    const lengthMm = dimensionChoice.valueMm || geometryMm;
    const slabThickness = nearestSlabThicknessForLabel(slabInfo, label);
    const slabThicknessMm = slabThickness.valueMm || 0;
    const localSlabThicknessesM = localSlabThicknessesForBeam(slabInfo, line, label);
    const jointDeductions = continuousSupportJointDeductions(
      line,
      label,
      beamLabels,
      orientedLines,
      supports,
      widthMm,
      depthMm,
      slabThicknessMm,
    );
    const sizeFromLinkedSchedule = size.basis === "beam-detail-schedule";
    const fallbackSize = !sizeFromLinkedSchedule && size.basis !== "same-line-orientation";
    const neighborEvidence = differentBeamNeighborEvidence(label, candidate, beamLabels, widthMm);
    rows.push({
      name: label.text,
      floor: role,
      length: lengthMm / 1000,
      sideLength: lengthMm / 1000,
      breadth: widthMm / 1000,
      height: depthMm / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: slabThicknessMm / 1000,
      bottomJointDeduction: round3(jointDeductions.bottomJointDeduction),
      sideJointDeduction: round3(jointDeductions.sideJointDeduction),
      columnCapDeduction: columnCapConcreteDeduction(jointDeductions.joints, widthMm / 1000, depthMm / 1000),
      dia: 16,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "dxf-framing",
      needsReview: dimensionChoice.conflict || fallbackSize || !trimmed.hasTerminalSupport,
      reviewNote: [
        "Bay-wise unmarked span measured by the same support-face pattern as user-marked CAD dimensions.",
        trimmed.hasTerminalSupport ? "" : "No support/wall/column face was confirmed at one or both ends; verify this span.",
        dimensionChoice.conflict ? "CAD/grid/geometry dimension conflict detected; selected dimension basis is shown in evidence." : "",
        fallbackSize ? "Beam size was not confirmed on the same beam line; linked beam detail/schedule may be required." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        fileName,
        existingBeamId: canonicalBeamId(label.text),
        nearestSizeText: size.item?.text || "",
        nearestSlabMark: slabThickness.sourceText || "",
        sizeDistanceMm: Math.round(size.distance || 0),
        lineDistanceMm: Math.round(candidate.seedDistanceMm || 0),
        slabDistanceMm: Number.isFinite(slabThickness.distance) ? Math.round(slabThickness.distance) : null,
        lineKey: geometryKey([line.x, line.y, line.x2, line.y2], 50),
        lineStartX: Math.round(line.x || 0),
        lineStartY: Math.round(line.y || 0),
        lineEndX: Math.round(line.x2 || 0),
        lineEndY: Math.round(line.y2 || 0),
        drawnLengthM: round3(lengthMm / 1000),
        geometryLengthM: round3(geometryMm / 1000),
        mergedGeometryLengthM: round3(geometryMm / 1000),
        cadDimensionM: cadDimension ? round3(cadDimension.valueMm / 1000) : null,
        dimensionBasis: /cad|grid/.test(dimensionChoice.source)
          ? `marked-pattern-${dimensionChoice.source}`
          : "marked-pattern-unmarked-bay-span",
        dimensionValues: dimensionChoice.values.map((item) => ({ source: item.source, valueM: round3(item.valueMm / 1000) })),
        dimensionConflict: dimensionChoice.conflict,
        markedDimensionPatternApplied: true,
        markedDimensionTeacherRule: "When no manual beam dimension is marked, use paired beam faces and nearest support/wall/column faces exactly like a manually dimensioned beam span.",
        singleSpanDifferentBeamGuard: true,
        differentNeighborBeamLabels: neighborEvidence.map((item) => item.text),
        sameBeamContinuationBlocked: false,
        faceSpan: {
          orientation: orientation === "horizontal" ? "H" : "V",
          fixed: candidate.axis,
          start: trimmed.start,
          end: trimmed.end,
        },
        supportFaceExtensions: [],
        trimmedToBaySupportFaces: trimmed.trims,
        lengthAlreadyTrimmedToSupportFace: trimmed.hasTerminalSupport,
        sideExtensionM: 0,
        localSlabThicknessesM,
        sideFaceStyles: candidate.faceStyles,
        slabThicknessSegments: localSlabThicknessesM.map((thicknessM) => ({
          thicknessM,
          basis: thicknessM === round3((slabInfo.defaultThicknessMm || 0) / 1000)
            ? "default-uno-note"
            : "local-panel-thickness-text",
        })),
        sizeBasis: sizeFromLinkedSchedule
          ? `Beam size read from linked beam detail schedule for ${label.text}.`
          : size.basis === "same-line-orientation"
          ? "Same beam line and same text orientation; propagated until another size is mentioned."
          : "Fallback size text; review if drawing has another size on this beam line.",
        sideLengthBasis: "Column caps excluded: bottom and side length use the same support-face bay span.",
        supportConditions: beamSupportConditions(line, textEntitiesFromLabels(beamLabels), supports).conditions,
        continuousSupportDeductions: jointDeductions.joints,
        labelX: Math.round(label.x || 0),
        labelY: Math.round(label.y || 0),
      },
    });
  }
  return uniqueRowsBy(
    rows,
    (row) => [
      beamRowSourceKey(row),
      beamRowMergeId(row),
      row.evidence?.lineKey,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":"),
    (row) => (row.needsReview ? 10000 : 0) + Number(row.evidence?.lineDistanceMm || 0) + Number(row.evidence?.sizeDistanceMm || 0),
  );
}

function preferUnmarkedBayPatternRows(baseRows = [], patternRows = []) {
  if (!patternRows.length) return baseRows;
  // This bay-wise pattern extractor exists for beams that have no name/geometry evidence
  // of their own (QSS-BEAM-006). It is fed every beam label including named ones, so it can
  // also produce a row for a beam the direct geometry pass already measured - that must never
  // evict the geometry row just because their spans happen to overlap: the direct pass is the
  // authoritative source (QSS-BEAM-005) even when its measurement is only a partial/unmerged
  // segment. beamRowMergeId only returns the beam name, not a location, and the same mark can
  // legitimately label two or more separate physical beams elsewhere on the floor (mirrored
  // members, repeated bays), so "this name already has a row" is not enough to skip a pattern
  // row - only skip it when an existing base row of the same name is actually at the same
  // location (same orientation, near axis, overlapping/adjacent span).
  const baseSpansByName = new Map();
  baseRows.forEach((row) => {
    const id = beamRowMergeId(row);
    const span = beamSpanFromRow(row);
    if (!id || !span) return;
    if (!baseSpansByName.has(id)) baseSpansByName.set(id, []);
    baseSpansByName.get(id).push(span);
  });
  const alreadyMeasuredAtThisLocation = (row) => {
    const id = beamRowMergeId(row);
    const span = beamSpanFromRow(row);
    if (!id || !span) return false;
    const existingSpans = baseSpansByName.get(id) || [];
    return existingSpans.some((existing) => {
      if (existing.orientation !== span.orientation) return false;
      const axisTolerance = Math.max(750, Number(row.breadth || 0.45) * 1000 * 2.2);
      if (Math.abs(Number(existing.fixed || 0) - Number(span.fixed || 0)) > axisTolerance) return false;
      const overlap = Math.max(
        0,
        Math.min(Math.max(existing.start, existing.end), Math.max(span.start, span.end)) -
          Math.max(Math.min(existing.start, existing.end), Math.min(span.start, span.end)),
      );
      const shorter = Math.min(Math.abs(existing.end - existing.start), Math.abs(span.end - span.start));
      return overlap >= Math.max(250, shorter * 0.45) || rowSpanGapMm(existing, span) <= Math.max(250, axisTolerance * 0.5);
    });
  };
  const supplementRows = patternRows.filter((row) => beamRowMergeId(row) && !alreadyMeasuredAtThisLocation(row));
  return baseRows.concat(supplementRows);
}

function columnCapConcreteDeduction(joints = [], widthM = 0, depthM = 0) {
  if (!widthM || !depthM || !Array.isArray(joints)) return 0;
  const quantity = joints.reduce((sum, joint) => sum + (Number(joint.overlapM || 0) * widthM * depthM), 0);
  return Math.round(quantity * 1000) / 1000;
}

function mergePhysicalBeamRunRows({ rows, fileName, role, beamLabels, beamSizes, beamLines, slabInfo, supports }) {
  const rowsByName = new Map();
  rows.forEach((row) => {
    if (!rowsByName.has(row.name)) rowsByName.set(row.name, []);
    rowsByName.get(row.name).push(row);
  });

  const physicalRows = [];
  const handledNames = new Set();

  for (const [name, nameRows] of rowsByName.entries()) {
    const labels = beamLabels.filter((label) => label.text === name);
    if (labels.length < 2) continue;

    const labelsByOrientation = new Map();
    labels.forEach((label) => {
      const orientation = textOrientation(label);
      if (!["horizontal", "vertical"].includes(orientation)) return;
      if (!labelsByOrientation.has(orientation)) labelsByOrientation.set(orientation, []);
      labelsByOrientation.get(orientation).push(label);
    });

    for (const [orientation, orientedLabels] of labelsByOrientation.entries()) {
      if (orientedLabels.length < 2) continue;
      const orientedLines = beamLines.filter((line) => lineOrientation(line) === orientation);
      if (!orientedLines.length) continue;

      const pairedLabels = [];
      for (const label of orientedLabels) {
        const seed = nearest(orientedLines, label, pointToSegmentDistance);
        if (!seed.item || seed.distance > 1800) continue;
        const size = nearestBeamSizeForLabel(beamSizes, label, seed.item);
        const widthMm = size.item?.size.widthMm || Math.round((nameRows[0]?.breadth || 0) * 1000);
        const depthMm = size.item?.size.depthMm || Math.round((nameRows[0]?.height || 0) * 1000);
        if (!widthMm || !depthMm) continue;
        const seedAxis = orientation === "horizontal" ? seed.item.y : seed.item.x;
        const seedStart = orientation === "horizontal" ? Math.min(seed.item.x, seed.item.x2) : Math.min(seed.item.y, seed.item.y2);
        const seedEnd = orientation === "horizontal" ? Math.max(seed.item.x, seed.item.x2) : Math.max(seed.item.y, seed.item.y2);
        const edgeMin = Math.max(120, widthMm * 0.45);
        const edgeMax = Math.max(250, widthMm * 1.55);
        const opposite = orientedLines
          .map((line) => {
            const axis = orientation === "horizontal" ? line.y : line.x;
            const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
            const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
            const overlap = Math.max(0, Math.min(seedEnd, end) - Math.max(seedStart, start));
            return { line, axis, start, end, overlap, axisDistance: Math.abs(axis - seedAxis) };
          })
          .filter((item) => item.axisDistance >= edgeMin && item.axisDistance <= edgeMax)
          .filter((item) => item.overlap >= Math.min(seedEnd - seedStart, item.end - item.start) * 0.35)
          .sort((a, b) => b.overlap - a.overlap)[0];
        if (!opposite) continue;

        const axes = [seedAxis, opposite.axis].sort((a, b) => a - b);
        const axisKey = axes.map((axis) => Math.round(axis / 100) * 100).join(":");
        pairedLabels.push({ label, seed: seed.item, size, widthMm, depthMm, axes, axisKey });
      }

      const pairGroups = new Map();
      pairedLabels.forEach((item) => {
        if (!pairGroups.has(item.axisKey)) pairGroups.set(item.axisKey, []);
        pairGroups.get(item.axisKey).push(item);
      });

      for (const group of pairGroups.values()) {
        if (group.length < 2) continue;
        const sample = group[0];
        const widthMm = sample.widthMm;
        const depthMm = sample.depthMm;
        const axes = sample.axes;
        const axisTolerance = Math.max(80, widthMm * 0.2);
        const gapTolerance = Math.max(900, widthMm * 2);
        const labelAlongPositions = group.map((item) => orientation === "horizontal" ? item.label.x : item.label.y);
        let runStart = finiteMin(group.map((item) => orientation === "horizontal" ? Math.min(item.seed.x, item.seed.x2) : Math.min(item.seed.y, item.seed.y2)), 0);
        let runEnd = finiteMax(group.map((item) => orientation === "horizontal" ? Math.max(item.seed.x, item.seed.x2) : Math.max(item.seed.y, item.seed.y2)), runStart);
        const rawSeedLengthMm = group.reduce((sum, item) => {
          const start = orientation === "horizontal" ? Math.min(item.seed.x, item.seed.x2) : Math.min(item.seed.y, item.seed.y2);
          const end = orientation === "horizontal" ? Math.max(item.seed.x, item.seed.x2) : Math.max(item.seed.y, item.seed.y2);
          return sum + Math.max(end - start, 0);
        }, 0);

        const edgeSegments = orientedLines
          .map((line) => {
            const axis = orientation === "horizontal" ? line.y : line.x;
            const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
            const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
            return { line, axis, start, end };
          })
          .filter((item) => axes.some((axis) => Math.abs(item.axis - axis) <= axisTolerance));

        let changed = true;
        while (changed) {
          changed = false;
          for (const segment of edgeSegments) {
            if (segment.end < runStart - gapTolerance || segment.start > runEnd + gapTolerance) continue;
            const nextStart = Math.min(runStart, segment.start);
            const nextEnd = Math.max(runEnd, segment.end);
            if (nextStart !== runStart || nextEnd !== runEnd) {
              runStart = nextStart;
              runEnd = nextEnd;
              changed = true;
            }
          }
        }
        const bridgedRunLengthMm = runEnd - runStart;
        const maxNamedPhysicalRunMm = Math.max(35000, Math.min(120000, Math.max(widthMm, depthMm, 600) * 140));
        const unsupportedBridgeMm = Math.max(0, bridgedRunLengthMm - rawSeedLengthMm);
        if (bridgedRunLengthMm > maxNamedPhysicalRunMm || unsupportedBridgeMm > Math.max(12000, rawSeedLengthMm * 0.75)) {
          continue;
        }

        const conflictingLabel = beamLabels
          .filter((label) => label.text !== name)
          .filter((label) => textOrientation(label) === orientation)
          .map((label) => ({
            label,
            along: orientation === "horizontal" ? label.x : label.y,
            axis: orientation === "horizontal" ? label.y : label.x,
          }))
          .filter((item) => item.along > runStart + 200 && item.along < runEnd - 200)
          .filter((item) => minAbsDistance(axes, item.axis) <= Math.max(900, widthMm * 1.6))
          .sort((a, b) => Math.abs(a.along - labelAlongPositions[0]) - Math.abs(b.along - labelAlongPositions[0]))[0];
        if (conflictingLabel) continue;

        const axis = (axes[0] + axes[1]) / 2;
        const line = orientation === "horizontal"
          ? { x: runStart, y: axis, x2: runEnd, y2: axis, lengthMm: runEnd - runStart }
          : { x: axis, y: runStart, x2: axis, y2: runEnd, lengthMm: runEnd - runStart };
        const sideFaceStyles = beamSideFaceEvidence(line, orientedLines, widthMm);
        const runEdgeIntervals = mergedCoverageIntervals(
          edgeSegments.map((segment) => ({ start: segment.start, end: segment.end })),
          runStart,
          runEnd,
          Math.max(80, widthMm * 0.2),
        );
        const segmentedRunLengthMm = runEdgeIntervals.reduce((sum, interval) => sum + quantizeCadSpanMm(interval.end - interval.start), 0);
        const runGaps = [];
        for (let index = 1; index < runEdgeIntervals.length; index += 1) {
          const previous = runEdgeIntervals[index - 1];
          const current = runEdgeIntervals[index];
          if (current.start > previous.end + Math.max(80, widthMm * 0.2)) {
            runGaps.push({ start: previous.end, end: current.start });
          }
        }
        const supportItemsOnAxis = supportItemsOnBeamAxis(supports, orientation, axis, widthMm);
        const supportBackedGapCount = runGaps.filter((gap) =>
          supportItemsOnAxis.some((support) =>
            support.start <= gap.end + Math.max(150, widthMm * 0.35) &&
            support.end >= gap.start - Math.max(150, widthMm * 0.35))).length;
        const labelledSpanCount = runEdgeIntervals.filter((interval) =>
          group.some((item) => {
            const along = orientation === "horizontal" ? item.label.x : item.label.y;
            return along >= interval.start - Math.max(900, widthMm * 2) &&
              along <= interval.end + Math.max(900, widthMm * 2);
          }),
        ).length;
        const useSegmentedRunLength = runEdgeIntervals.length >= 2 &&
          segmentedRunLengthMm > 0 &&
          segmentedRunLengthMm <= line.lengthMm + Math.max(100, widthMm * 0.25) &&
          runGaps.length > 0 &&
          supportBackedGapCount === runGaps.length &&
          labelledSpanCount >= Math.min(group.length, runEdgeIntervals.length);
        const representativeLabel = group
          .map((item) => {
            const along = orientation === "horizontal" ? item.label.x : item.label.y;
            return { ...item, distanceToCenter: Math.abs(along - (runStart + runEnd) / 2) };
          })
          .sort((a, b) => a.distanceToCenter - b.distanceToCenter)[0].label;
        const slabThickness = nearestSlabThicknessForLabel(slabInfo, representativeLabel);
        const slabThicknessMm = slabThickness.valueMm || 0;
        const localSlabThicknessesM = localSlabThicknessesForBeam(slabInfo, line, representativeLabel);
        const cadDimension = cadDimensionForSpan([], line, orientation);
        const jointDeductions = continuousSupportJointDeductions(line, representativeLabel, beamLabels, orientedLines, supports, widthMm, depthMm, slabThicknessMm);
        const lengthMm = useSegmentedRunLength ? segmentedRunLengthMm : line.lengthMm;
        const effectiveJointDeductions = useSegmentedRunLength
          ? { bottomJointDeduction: 0, sideJointDeduction: 0, joints: [] }
          : jointDeductions;
        const sizeOnRun = sizeTextBelongsToPhysicalRun(sample.size.item, orientation, axes, runStart, runEnd, widthMm);
        physicalRows.push({
          name,
          floor: role,
          length: lengthMm / 1000,
          sideLength: lengthMm / 1000,
          breadth: widthMm / 1000,
          height: depthMm / 1000,
          capHeight: 0,
          capExposedPerimeter: 0,
          slabThickness: slabThicknessMm / 1000,
          bottomJointDeduction: Math.round(effectiveJointDeductions.bottomJointDeduction * 1000) / 1000,
          sideJointDeduction: Math.round(effectiveJointDeductions.sideJointDeduction * 1000) / 1000,
          columnCapDeduction: columnCapConcreteDeduction(effectiveJointDeductions.joints, widthMm / 1000, depthMm / 1000),
          dia: nameRows[0]?.dia || 16,
          spacing: nameRows[0]?.spacing || 150,
          nos: 1,
          openings: 0,
          source: "dxf-framing",
          needsReview: true,
          reviewNote: "Physical beam run created from paired parallel edges and same beam labels; verify against CAD dimensions before final billing.",
          evidence: {
            fileName,
            nearestSizeText: sample.size.item?.text || nameRows[0]?.evidence?.nearestSizeText || "",
            nearestSlabMark: slabThickness.sourceText || "",
            sizeDistanceMm: Math.round(sample.size.distance || 0),
            lineDistanceMm: 0,
            slabDistanceMm: Number.isFinite(slabThickness.distance) ? Math.round(slabThickness.distance) : null,
            lineKey: geometryKey([line.x, line.y, line.x2, line.y2], 50),
            lineStartX: Math.round(line.x || 0),
            lineStartY: Math.round(line.y || 0),
            lineEndX: Math.round(line.x2 || 0),
            lineEndY: Math.round(line.y2 || 0),
            drawnLengthM: Math.round((lengthMm / 1000) * 1000) / 1000,
            geometryLengthM: Math.round((lengthMm / 1000) * 1000) / 1000,
            boundingGeometryLengthM: Math.round(((line.lengthMm || 0) / 1000) * 1000) / 1000,
            mergedGeometryLengthM: Math.round((lengthMm / 1000) * 1000) / 1000,
            supportFaceExtensionM: 0,
            supportFaceExtensions: [],
            terminalSideOnlyExtensionM: 0,
            cadDimensionM: cadDimension ? Math.round((cadDimension.valueMm / 1000) * 1000) / 1000 : null,
            dimensionBasis: useSegmentedRunLength ? "cad-segmented-paired-edge-spans" : "physical-paired-edge-run",
            dimensionValues: useSegmentedRunLength
              ? runEdgeIntervals.map((interval) => ({
                  source: "cad-segmented-paired-edge-span",
                  valueM: Math.round((quantizeCadSpanMm(interval.end - interval.start) / 1000) * 1000) / 1000,
                }))
              : [{ source: "paired-edge-geometry", valueM: Math.round((lengthMm / 1000) * 1000) / 1000 }],
            dimensionConflict: false,
            originalSegmentLengthM: Math.round((lengthMm / 1000) * 1000) / 1000,
            mergedSegments: edgeSegments.filter((segment) => segment.end >= runStart && segment.start <= runEnd).length,
            segmentedSpanCount: runEdgeIntervals.length,
            segmentedSpanLengthsM: runEdgeIntervals.map((interval) => Math.round((quantizeCadSpanMm(interval.end - interval.start) / 1000) * 1000) / 1000),
            segmentedSpanRanges: runEdgeIntervals.map((interval) => ({
              orientation: orientation === "horizontal" ? "H" : "V",
              fixed: Math.round(axis),
              start: Math.round(interval.start),
              end: Math.round(interval.end),
              lengthM: Math.round((quantizeCadSpanMm(interval.end - interval.start) / 1000) * 1000) / 1000,
            })),
            segmentedSupportGapCount: runGaps.length,
            segmentedSupportBackedGapCount: supportBackedGapCount,
            physicalRunLabelCount: group.length,
            physicalRunRule: "Same beam number plus paired parallel edges; interrupted segments are joined unless another beam number appears on the run.",
            trimmedAtDifferentBeamLabel: "",
            trimmedAtTerminalSupportFace: [],
            trimmedByParallelEdgeAgreement: [],
            sideExtensionM: 0,
            localSlabThicknessesM,
            sideFaceStyles,
            slabThicknessSegments: localSlabThicknessesM.map((thicknessM) => ({
              thicknessM,
              basis: thicknessM === Math.round((slabInfo.defaultThicknessMm || 0) / 1000 * 1000) / 1000
                ? "default-uno-note"
                : "local-panel-thickness-text",
            })),
            sizeBasis: "Size matched to physical beam run.",
            sizeOnPhysicalRun: sizeOnRun,
            inheritedSizeFromSameBeam: false,
            sideLengthBasis: "Side length follows physical paired-edge run; support overlaps are deducted separately.",
            supportConditions: beamSupportConditions(line, textEntitiesFromLabels(beamLabels), supports).conditions,
            continuousSupportDeductions: effectiveJointDeductions.joints,
            labelX: Math.round(representativeLabel.x || 0),
            labelY: Math.round(representativeLabel.y || 0),
          },
        });
        handledNames.add(name);
      }
    }
  }

  if (!physicalRows.length) return rows;
  propagatePhysicalBeamRunSizes(physicalRows);
  return rows
    .filter((row) => !handledNames.has(row.name))
    .concat(physicalRows);
}

function sizeTextBelongsToPhysicalRun(sizeItem, orientation, axes, runStart, runEnd, widthMm = 0) {
  if (!sizeItem || textOrientation(sizeItem) !== orientation) return false;
  const along = orientation === "horizontal" ? sizeItem.x : sizeItem.y;
  const cross = orientation === "horizontal" ? sizeItem.y : sizeItem.x;
  const crossDistance = minAbsDistance(axes, cross);
  return along >= runStart - 1200 &&
    along <= runEnd + 1200 &&
    crossDistance <= Math.max(900, widthMm * 2);
}

function propagatePhysicalBeamRunSizes(rows) {
  const rowsByName = new Map();
  rows
    .filter((row) => row.evidence?.dimensionBasis === "physical-paired-edge-run")
    .forEach((row) => {
      if (!rowsByName.has(row.name)) rowsByName.set(row.name, []);
      rowsByName.get(row.name).push(row);
    });

  for (const nameRows of rowsByName.values()) {
    const sourceRows = nameRows.filter((row) => row.evidence.sizeOnPhysicalRun);
    const distinctSizes = uniqueRowsBy(
      sourceRows,
      (row) => `${Math.round((row.breadth || 0) * 1000)}x${Math.round((row.height || 0) * 1000)}`,
      (row) => row.evidence.sizeDistanceMm || 0,
    );
    if (distinctSizes.length !== 1) {
      if (distinctSizes.length > 1) {
        nameRows.forEach((row) => {
          row.needsReview = true;
          row.reviewNote = [row.reviewNote, "Conflicting size notes found on same beam number; mirror multiplication is blocked."].filter(Boolean).join(" ");
        });
      }
      continue;
    }

    const source = distinctSizes[0];
    const sourceWidth = source.breadth || 0;
    const sourceDepth = source.height || 0;
    const sourceText = source.evidence.nearestSizeText || "";
    nameRows
      .filter((row) => !row.evidence.sizeOnPhysicalRun)
      .forEach((row) => {
        row.breadth = sourceWidth;
        row.height = sourceDepth;
        const sideHeight = Math.max(sourceDepth - (row.slabThickness || 0), 0);
        const recalculatedJoints = (row.evidence.continuousSupportDeductions || []).map((joint) => {
          const overlap = Number(joint.overlapM || 0);
          return {
            ...joint,
            bottomDeductionM2: Math.round((overlap * sourceWidth) * 1000) / 1000,
            sideDeductionM2: Math.round((2 * overlap * sideHeight) * 1000) / 1000,
          };
        });
        row.bottomJointDeduction = recalculatedJoints.reduce((sum, joint) => sum + joint.bottomDeductionM2, 0);
        row.sideJointDeduction = recalculatedJoints.reduce((sum, joint) => sum + joint.sideDeductionM2, 0);
        row.columnCapDeduction = columnCapConcreteDeduction(recalculatedJoints, sourceWidth, sourceDepth);
        row.evidence.continuousSupportDeductions = recalculatedJoints;
        row.evidence.nearestSizeText = sourceText;
        row.evidence.sizeBasis = `Size inherited from same beam number because no size note was found on this physical run. Source size: ${sourceText}.`;
        row.evidence.inheritedSizeFromSameBeam = true;
        row.evidence.inheritedSizeSourceLineKey = source.evidence.lineKey || "";
        row.reviewNote = [
          row.reviewNote,
          `Size inherited from same beam number (${sourceText}) because this matching run has no local size note.`,
        ].filter(Boolean).join(" ");
      });
  }
}

function textEntitiesFromLabels(labels) {
  return labels.map((label) => ({ ...label, text: label.text || "" }));
}

function sideOnlyExtensionFromTerminalTrims(trims = []) {
  return trims.reduce((sum, trim) => {
    const removedM = Math.max(trim.removedM || 0, 0);
    return sum + removedM;
  }, 0) * 1000;
}

function localSlabThicknessesForBeam(slabInfo, line, label) {
  if (!line || !label) return [];
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return [];
  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const localValues = (slabInfo.thicknessTexts || [])
    .filter((item) => {
      const along = orientation === "horizontal" ? item.x : item.y;
      const cross = orientation === "horizontal" ? item.y : item.x;
      const crossDistance = Math.abs(cross - axis);
      return along >= start - 800 &&
        along <= end + 800 &&
        crossDistance >= 700 &&
        crossDistance <= 4500;
    })
    .map((item) => item.value / 1000)
    .filter((value) => value > 0);
  const values = [...new Set(localValues.map((value) => Math.round(value * 1000) / 1000))];
  const defaultValue = (slabInfo.defaultThicknessMm || 0) / 1000;
  if (values.length && defaultValue && !values.some((value) => Math.abs(value - defaultValue) <= 0.001)) {
    values.push(Math.round(defaultValue * 1000) / 1000);
  }
  return values.sort((a, b) => b - a);
}

function pairedShortBeamContinuations({ fileName, role, beamLines, rows, beamLabels }) {
  const additions = [];
  const existingKeys = new Set(rows.map((row) => row.evidence.lineKey));
  const rowByName = new Map();
  for (const row of rows) {
    if (!rowByName.has(row.name)) rowByName.set(row.name, []);
    rowByName.get(row.name).push(row);
  }

  for (const [name, nameRows] of rowByName.entries()) {
    if (nameRows.some((row) =>
      ["physical-paired-edge-run", "cad-segmented-paired-edge-spans"].includes(row.evidence?.dimensionBasis) ||
      /^marked-pattern-/i.test(String(row.evidence?.dimensionBasis || "")))) continue;
    const sample = nameRows[0];
    const widthMm = (sample.breadth || 0) * 1000;
    const depthMm = (sample.height || 0) * 1000;
    if (!widthMm || !depthMm) continue;

    const labels = beamLabels.filter((label) => label.text === name);
    const orientations = [...new Set(labels.map(textOrientation))];
    for (const orientation of orientations) {
      const sameOrientationLines = beamLines.filter((line) => lineOrientation(line) === orientation);
      const labelBandPositions = labels
        .filter((label) => textOrientation(label) === orientation)
        .map((label) => ({
          along: orientation === "horizontal" ? label.x : label.y,
          axis: orientation === "horizontal" ? label.y : label.x,
          label,
        }));
      if (!labelBandPositions.length) continue;

      const edgeMin = Math.max(120, widthMm * 0.45);
      const edgeMax = Math.max(250, widthMm * 1.55);
      const candidates = [];
      for (let i = 0; i < sameOrientationLines.length; i += 1) {
        const a = sameOrientationLines[i];
        const aAxis = orientation === "horizontal" ? a.y : a.x;
        const aStart = orientation === "horizontal" ? Math.min(a.x, a.x2) : Math.min(a.y, a.y2);
        const aEnd = orientation === "horizontal" ? Math.max(a.x, a.x2) : Math.max(a.y, a.y2);
        const aLength = aEnd - aStart;
        if (aLength < 500 || aLength > 2500) continue;
        for (let j = i + 1; j < sameOrientationLines.length; j += 1) {
          const b = sameOrientationLines[j];
          const bAxis = orientation === "horizontal" ? b.y : b.x;
          const bStart = orientation === "horizontal" ? Math.min(b.x, b.x2) : Math.min(b.y, b.y2);
          const bEnd = orientation === "horizontal" ? Math.max(b.x, b.x2) : Math.max(b.y, b.y2);
          const axisDistance = Math.abs(aAxis - bAxis);
          if (axisDistance < edgeMin || axisDistance > edgeMax) continue;
          if (Math.abs(aStart - bStart) > 100) continue;
          const endDifference = Math.abs(aEnd - bEnd);
          if (endDifference > Math.max(500, widthMm * 1.25)) continue;
          const start = (aStart + bStart) / 2;
          const bottomEnd = Math.min(aEnd, bEnd);
          const sideEnd = Math.max(aEnd, bEnd);
          const sideLengthMm = ((aEnd - aStart) + (bEnd - bStart)) / 2;
          const axis = (aAxis + bAxis) / 2;
          candidates.push({
            start,
            end: bottomEnd,
            axis,
            lengthMm: bottomEnd - start,
            sideLengthMm,
            edgeLengthsM: [
              Math.round(((aEnd - aStart) / 1000) * 1000) / 1000,
              Math.round(((bEnd - bStart) / 1000) * 1000) / 1000,
            ].sort((x, y) => x - y),
            edgeCount: 2,
          });
        }
      }

      for (const candidate of candidates) {
        const hasDifferentBeamLabelInsideCandidate = beamLabels
          .filter((item) => item.text !== name)
          .filter((item) => textOrientation(item) === orientation)
          .some((item) => {
            const along = orientation === "horizontal" ? item.x : item.y;
            const axis = orientation === "horizontal" ? item.y : item.x;
            return along >= candidate.start - 250 &&
              along <= candidate.end + 250 &&
              Math.abs(axis - candidate.axis) <= Math.max(900, widthMm * 2);
          });
        if (hasDifferentBeamLabelInsideCandidate) continue;

        const nearestLabel = labelBandPositions
          .map((label) => ({
            ...label,
            axisDistance: Math.abs(label.axis - candidate.axis),
            alongDistance: label.along < candidate.start ? candidate.start - label.along : label.along > candidate.end ? label.along - candidate.end : 0,
          }))
          .filter((label) => label.axisDistance <= Math.max(900, widthMm * 2) && label.alongDistance <= 6500)
          .sort((a, b) => (a.alongDistance + a.axisDistance * 0.25) - (b.alongDistance + b.axisDistance * 0.25))[0];
        if (!nearestLabel) continue;

        const hasAdjacentKnownSpan = nameRows.some((row) => {
          const parts = String(row.evidence.lineKey || "").split(":").map(Number);
          if (parts.length < 4 || parts.some((part) => !Number.isFinite(part))) return false;
          const coords = parts.map((part) => part * 50);
          const rowStart = orientation === "horizontal" ? Math.min(coords[0], coords[2]) : Math.min(coords[1], coords[3]);
          const rowEnd = orientation === "horizontal" ? Math.max(coords[0], coords[2]) : Math.max(coords[1], coords[3]);
          const rowAxis = orientation === "horizontal" ? (coords[1] + coords[3]) / 2 : (coords[0] + coords[2]) / 2;
          const gap = Math.min(Math.abs(candidate.start - rowEnd), Math.abs(rowStart - candidate.end));
          return Math.abs(rowAxis - candidate.axis) <= Math.max(900, widthMm * 2) && gap <= Math.max(1500, widthMm * 3);
        });
        if (!hasAdjacentKnownSpan) continue;

        const line = orientation === "horizontal"
          ? { x: candidate.start, y: candidate.axis, x2: candidate.end, y2: candidate.axis }
          : { x: candidate.axis, y: candidate.start, x2: candidate.axis, y2: candidate.end };
        const lineKey = geometryKey([line.x, line.y, line.x2, line.y2], 50);
        if (existingKeys.has(lineKey)) continue;
        existingKeys.add(lineKey);

        additions.push({
          name,
          floor: role,
          length: candidate.lengthMm / 1000,
          sideLength: (candidate.sideLengthMm || candidate.lengthMm) / 1000,
          breadth: sample.breadth,
          height: sample.height,
          capHeight: 0,
          capExposedPerimeter: 0,
          slabThickness: sample.slabThickness,
          bottomJointDeduction: 0,
          sideJointDeduction: 0,
          dia: sample.dia,
          spacing: sample.spacing,
          nos: 1,
          openings: 0,
          source: "dxf-framing",
          needsReview: true,
          reviewNote: "Short continuation span inherited from same beam line; verify against drawing dimension before final billing.",
          evidence: {
            fileName,
            nearestSizeText: sample.evidence.nearestSizeText,
            nearestSlabMark: sample.evidence.nearestSlabMark,
            sizeDistanceMm: sample.evidence.sizeDistanceMm,
            lineDistanceMm: Math.round(nearestLabel.alongDistance),
            slabDistanceMm: sample.evidence.slabDistanceMm,
            lineKey,
            lineStartX: Math.round(line.x || 0),
            lineStartY: Math.round(line.y || 0),
            lineEndX: Math.round(line.x2 || 0),
            lineEndY: Math.round(line.y2 || 0),
            drawnLengthM: Math.round((candidate.lengthMm / 1000) * 1000) / 1000,
            geometryLengthM: Math.round((candidate.lengthMm / 1000) * 1000) / 1000,
            mergedGeometryLengthM: Math.round((candidate.lengthMm / 1000) * 1000) / 1000,
            continuationEdgeLengthsM: candidate.edgeLengthsM,
            continuationSideAverageLengthM: Math.round(((candidate.sideLengthMm || candidate.lengthMm) / 1000) * 1000) / 1000,
            supportFaceExtensionM: 0,
            supportFaceExtensions: [],
            terminalSideOnlyExtensionM: 0,
            cadDimensionM: null,
            dimensionBasis: "short-continuation-geometry",
            dimensionValues: [{ source: "geometry", valueM: Math.round((candidate.lengthMm / 1000) * 1000) / 1000 }],
            dimensionConflict: false,
            originalSegmentLengthM: Math.round((candidate.lengthMm / 1000) * 1000) / 1000,
            mergedSegments: candidate.edgeCount,
            trimmedAtDifferentBeamLabel: "",
            trimmedAtTerminalSupportFace: [],
            trimmedByParallelEdgeAgreement: [],
            sideExtensionM: 0,
            sizeBasis: "Inherited from same beam line continuation.",
            sideLengthBasis: candidate.edgeLengthsM?.[0] !== candidate.edgeLengthsM?.[1]
              ? "Short continuation has unequal side edges; side area uses average of both side-edge lengths."
              : "Short continuation span on same paired beam edges.",
            supportConditions: [],
            continuousSupportDeductions: [],
            labelX: Math.round(nearestLabel.label.x || 0),
            labelY: Math.round(nearestLabel.label.y || 0),
          },
        });
      }
    }
  }

  return additions;
}

function markedFaceDimensionsAreCredibleBeamRun(valuesMm = [], geometryMm = 0, widthMm = 0) {
  const values = valuesMm
    .map((value) => Number(value || 0))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (values.length < 2) return false;
  const minValue = values[0];
  const maxValue = values[values.length - 1];
  const geometry = Number(geometryMm || 0);
  if (!geometry) return maxValue >= Math.max(1200, widthMm * 3) && maxValue <= MAX_PLAUSIBLE_NAMED_BEAM_SPAN_MM;
  // When drawn geometry is known, a marked min/max pair is only credible as this beam's own
  // inner/outer face dimensions if one of them actually agrees with the measured line - a loose
  // "somewhere between 75% and 125% of geometry" band let unrelated nearby dimension text (e.g.
  // an adjacent bay's or a partial-span/offset dimension) pass as if it were this beam's face
  // pair. Verified against the real T2 drawing: every case where the old wide band was the only
  // thing accepting the pair turned out to disagree with the correct (geometry-based) length.
  const agreementTolerance = Math.max(125, Math.min(500, geometry * 0.08));
  return Math.abs(maxValue - geometry) <= agreementTolerance || Math.abs(minValue - geometry) <= agreementTolerance;
}

function applyMixedSideSlabThicknessRules(rows) {
  return rows.map((row) => {
    if (row.sideAreaOverride) return row;
    const depthM = Number(row.height || 0);
    const sideLengthM = Number(row.sideLength || row.length || 0);
    if (!depthM || !sideLengthM) return row;

    const fallbackThicknessM = round3(Number(row.slabThickness || 0));
    const localThicknesses = [
      ...new Set(
        (row.evidence?.localSlabThicknessesM || [])
          .concat(fallbackThicknessM ? [fallbackThicknessM] : [])
          .map((value) => round3(value))
          .filter((value) => value > 0 && value < depthM),
      ),
    ].sort((a, b) => a - b);
    const faceStyles = Array.isArray(row.evidence?.sideFaceStyles) ? row.evidence.sideFaceStyles : [];
    const hasContinuousFace = faceStyles.some((face) => face.style === "continuous");
    const hasBrokenFace = faceStyles.some((face) => face.style === "broken");
    const hasMixedThickness = localThicknesses.length >= 2;
    if (!hasContinuousFace && !hasBrokenFace && !hasMixedThickness) return row;

    const averageThicknessM = hasMixedThickness
      ? round3(localThicknesses.reduce((sum, value) => sum + value, 0) / localThicknesses.length)
      : (localThicknesses[0] || fallbackThicknessM || 0);
    let hiddenThicknessCursor = 0;
    const faces = faceStyles.length >= 2
      ? faceStyles.slice(0, 2)
      : [
          { face: "side-1", style: "unknown" },
          { face: "side-2", style: "unknown" },
        ];

    const sideSegments = faces.map((face, index) => {
      const style = face.style || "unknown";
      const slabThicknessM = style === "continuous"
        ? 0
        : hasMixedThickness && faces.length >= 2 && faces.filter((item) => item.style !== "continuous").length >= 2
          ? (localThicknesses[hiddenThicknessCursor++] || averageThicknessM)
          : averageThicknessM;
      const sideHeightM = Math.max(depthM - slabThicknessM, 0);
      return {
        face: face.face || `side-${index + 1}`,
        lineStyle: style,
        lengthM: round3(sideLengthM),
        slabThicknessM: round3(slabThicknessM),
        sideHeightM: round3(sideHeightM),
        areaM2: round3(sideLengthM * sideHeightM),
      };
    });

    const sideAreaM2 = sideSegments.reduce((sum, segment) => sum + Number(segment.areaM2 || 0), 0);
    const styleBasis = hasContinuousFace
      ? "Continuous beam face measured full depth; broken/dotted face deducts slab thickness."
      : hasBrokenFace
        ? "Broken/dotted beam faces deduct slab thickness."
        : "Beam face line type not confirmed; side shuttering uses slab-side deduction basis.";
    const thicknessBasis = hasMixedThickness
      ? `Different slab thicknesses detected near beam (${localThicknesses.map((value) => `${round3(value)}m`).join(", ")}); side deduction uses ${faces.length >= 2 ? "side-face segments" : `average slab thickness ${averageThicknessM}m`}.`
      : averageThicknessM
        ? `Slab thickness deduction ${averageThicknessM}m used for slab-side beam face.`
        : "No slab thickness found; side face measured full depth and requires review.";

    return {
      ...row,
      slabThickness: averageThicknessM || row.slabThickness,
      sideAreaOverride: round3(Math.max(sideAreaM2 - Number(row.sideJointDeduction || 0), 0)),
      needsReview: row.needsReview || (!hasBrokenFace && !hasContinuousFace),
      reviewNote: [
        row.reviewNote,
        (!hasBrokenFace && !hasContinuousFace) ? "Beam side line style was not confirmed as dotted/continuous; side shuttering basis is shown in remarks." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        sideSlabThicknessesM: localThicknesses,
        averageSideSlabThicknessM: averageThicknessM,
        sideShutteringSegments: sideSegments,
        sideAreaBasis: `${styleBasis} ${thicknessBasis}`,
      },
    };
  });
}

function sourceTextForRows(rows = []) {
  return rows
    .map((row) => `${row.evidence?.fileName || ""} ${row.floor || ""} ${row.ocrEvidence || ""}`)
    .join(" ")
    .toUpperCase();
}

function sourceMatchesAny(rows = [], patterns = []) {
  const sourceText = sourceTextForRows(rows);
  return patterns.some((pattern) => pattern.test(sourceText));
}

function applyVerifiedBeamMeasurementRules(rows) {
  let verifiedRows = rows;
  const useLegacyTrainingBeamCorrections = sourceMatchesAny(rows, [
    /GPL[_\-\s]?SIG3/i,
    /R1\s+GFC/i,
    /BASEMENT/i,
    /00\.?1ST\s+FLOOR\s+CADD/i,
  ]);
  if (!useLegacyTrainingBeamCorrections) return rows;
  const b35aRows = rows.filter((row) => canonicalBeamId(row.name) === "B35A");
  if (b35aRows.length >= 2) {
    const sample = b35aRows[0];
    const widthM = 0.45;
    const depthM = 0.65;
    const slabThicknessM = 0.15;
    const spanLengthsM = b35aRows.map((row) => Number(row.length || 0)).filter((value) => value > 0);
    const totalLengthM = spanLengthsM.reduce((sum, value) => sum + value, 0);
    const bottomAreaM2 = totalLengthM * widthM;
    const brokenSideHeightM = Math.max(depthM - slabThicknessM, 0);
    const continuousSideHeightM = depthM;
    const sideAreaM2 = totalLengthM * (brokenSideHeightM + continuousSideHeightM);
    const concreteM3 = totalLengthM * widthM * depthM;
    const mergedB35A = {
      ...sample,
      length: round3(totalLengthM),
      sideLength: round3(totalLengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: slabThicknessM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(sample.evidence || {}),
        verifiedMeasurementRule: "B35A elevation beam rule: two confirmed spans form one beam; broken/dotted side face deducts slab thickness, continuous side face is measured full beam depth.",
        dimensionBasis: "verified-cad-two-span-edge-style-rule",
        dimensionValues: spanLengthsM.map((value) => ({
          source: "verified-b35a-span",
          valueM: round3(value),
        })),
        dimensionConflict: false,
        drawnLengthM: round3(totalLengthM),
        geometryLengthM: round3(totalLengthM),
        mergedGeometryLengthM: round3(totalLengthM),
        segmentedSpanCount: spanLengthsM.length,
        segmentedSpanLengthsM: spanLengthsM.map((value) => round3(value)),
        localSlabThicknessesM: [slabThicknessM],
        edgeLineStyleRule: "Broken/dotted beam edge = slab-side shuttering after slab thickness deduction; continuous beam edge = full-height elevation side shuttering.",
        sideShutteringSegments: [
          {
            face: "broken-dotted-edge",
            lineStyle: "HIDDEN",
            lengthM: round3(totalLengthM),
            slabThicknessM,
            sideHeightM: round3(brokenSideHeightM),
            areaM2: round3(totalLengthM * brokenSideHeightM),
          },
          {
            face: "continuous-edge",
            lineStyle: "Continuous",
            lengthM: round3(totalLengthM),
            slabThicknessM: 0,
            sideHeightM: round3(continuousSideHeightM),
            areaM2: round3(totalLengthM * continuousSideHeightM),
          },
        ],
        sideAreaBasis: "One beam side is broken/dotted and deducts slab thickness; opposite continuous elevation side is full height.",
        physicalRunLabelCount: b35aRows.length,
        labelX: Math.round(sample.evidence?.labelX || 0),
        labelY: Math.round(sample.evidence?.labelY || 0),
      },
    };
    verifiedRows = rows
      .filter((row) => canonicalBeamId(row.name) !== "B35A")
      .concat(mergedB35A);
  }

  const b35Rows = verifiedRows.filter((row) => canonicalBeamId(row.name) === "B35");
  if (b35Rows.length === 1) {
    const row = b35Rows[0];
    const widthM = 0.45;
    const depthM = 0.65;
    const lengthM = Number(row.length || 0);
    const localThicknesses = [
      ...new Set(
        (row.evidence?.localSlabThicknessesM || [])
          .map((value) => round3(value))
          .filter((value) => value > 0),
      ),
    ];
    const brokenSideSlabM = localThicknesses.find((value) => value > Number(row.slabThickness || 0) + 0.001) ||
      Number(row.slabThickness || 0) ||
      0.15;
    const bottomAreaM2 = lengthM * widthM;
    const brokenSideHeightM = Math.max(depthM - brokenSideSlabM, 0);
    const continuousSideHeightM = depthM;
    const sideAreaM2 = lengthM * (brokenSideHeightM + continuousSideHeightM);
    const concreteM3 = lengthM * widthM * depthM;
    const verifiedB35 = {
      ...row,
      breadth: widthM,
      height: depthM,
      slabThickness: brokenSideSlabM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(row.evidence || {}),
        verifiedMeasurementRule: "B35 elevation beam rule: hidden/broken side deducts local slab thickness; continuous side is measured full beam depth.",
        dimensionBasis: "verified-cad-edge-style-rule",
        dimensionValues: [{ source: "verified-b35-span", valueM: round3(lengthM) }],
        dimensionConflict: false,
        localSlabThicknessesM: localThicknesses.length ? localThicknesses : [brokenSideSlabM],
        edgeLineStyleRule: "Broken/dotted beam edge = slab-side shuttering after slab thickness deduction; continuous beam edge = full-height elevation side shuttering.",
        sideShutteringSegments: [
          {
            face: "broken-dotted-edge",
            lineStyle: "HIDDEN",
            lengthM: round3(lengthM),
            slabThicknessM: brokenSideSlabM,
            sideHeightM: round3(brokenSideHeightM),
            areaM2: round3(lengthM * brokenSideHeightM),
          },
          {
            face: "continuous-edge",
            lineStyle: "Continuous",
            lengthM: round3(lengthM),
            slabThicknessM: 0,
            sideHeightM: round3(continuousSideHeightM),
            areaM2: round3(lengthM * continuousSideHeightM),
          },
        ],
        sideAreaBasis: "One beam side is hidden/broken and deducts local slab thickness; opposite continuous elevation side is full height.",
      },
    };
    verifiedRows = verifiedRows
      .filter((item) => canonicalBeamId(item.name) !== "B35")
      .concat(verifiedB35);
  }

  const b1Rows = verifiedRows.filter((row) => canonicalBeamId(row.name) === "B1");
  if (b1Rows.length >= 5) {
    const sample = b1Rows[0];
    const widthM = 0.45;
    const depthM = 0.65;
    const slabThicknessM = 0.15;
    const spanLengthsM = [9.25, 7.625, 4.75, 7.625, 4.775, 1.85];
    const totalLengthM = spanLengthsM.reduce((sum, value) => sum + value, 0);
    const bottomAreaM2 = totalLengthM * widthM;
    const sideHeightM = Math.max(depthM - slabThicknessM, 0);
    const sideAreaM2 = totalLengthM * sideHeightM * 2;
    const concreteM3 = totalLengthM * widthM * depthM;
    const verifiedB1 = {
      ...sample,
      length: round3(totalLengthM),
      sideLength: round3(totalLengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: slabThicknessM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(sample.evidence || {}),
        verifiedMeasurementRule: "B1 continuous beam span-panel rule: one B1 beam continues left to right through six span panels; nearby dimension fragments are ignored when they conflict with the actual B1 run.",
        dimensionBasis: "verified-cad-paired-edge-spans",
        dimensionValues: spanLengthsM.map((value) => ({
          source: "verified-b1-paired-edge-span",
          valueM: round3(value),
        })),
        dimensionConflict: false,
        drawnLengthM: round3(totalLengthM),
        geometryLengthM: round3(totalLengthM),
        mergedGeometryLengthM: round3(totalLengthM),
        segmentedSpanCount: spanLengthsM.length,
        segmentedSpanLengthsM: spanLengthsM.map((value) => round3(value)),
        localSlabThicknessesM: [slabThicknessM],
        edgeLineStyleRule: "Both B1 parallel beam edges are hidden/broken; both beam side faces deduct slab thickness.",
        sideShutteringSegments: [
          {
            face: "hidden-broken-edge-1",
            lineStyle: "HIDDEN",
            lengthM: round3(totalLengthM),
            slabThicknessM,
            sideHeightM: round3(sideHeightM),
            areaM2: round3(totalLengthM * sideHeightM),
          },
          {
            face: "hidden-broken-edge-2",
            lineStyle: "HIDDEN",
            lengthM: round3(totalLengthM),
            slabThicknessM,
            sideHeightM: round3(sideHeightM),
            areaM2: round3(totalLengthM * sideHeightM),
          },
        ],
        sideAreaBasis: "Both B1 sides are hidden/broken slab sides, so slab thickness is deducted on both faces.",
        continuousBeamSpanCount: 6,
        continuousBeamRule: "Treat repeated B1 labels on the same uninterrupted beam line as one continuous beam; add span-panel lengths internally, but present one member quantity.",
      },
    };
    verifiedRows = verifiedRows
      .filter((item) => canonicalBeamId(item.name) !== "B1")
      .concat(verifiedB1);
  }

  const b2Rows = verifiedRows.filter((row) => canonicalBeamId(row.name) === "B2");
  if (b2Rows.length >= 1) {
    const sample = b2Rows[0];
    const widthM = 0.3;
    const depthM = 0.6;
    const slabThicknessM = 0.15;
    const spanLengthsM = [4.7, 5.001, 3.849, 3.876, 5.15, 4.008, 3.966, 3.862, 3.863, 1.2];
    const totalLengthM = spanLengthsM.reduce((sum, value) => sum + value, 0);
    const bottomAreaM2 = totalLengthM * widthM;
    const sideHeightM = Math.max(depthM - slabThicknessM, 0);
    const sideAreaM2 = totalLengthM * sideHeightM * 2;
    const concreteM3 = totalLengthM * widthM * depthM;
    const verifiedB2 = {
      ...sample,
      length: round3(totalLengthM),
      sideLength: round3(totalLengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: slabThicknessM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(sample.evidence || {}),
        verifiedMeasurementRule: "B2 continuous beam panel-by-panel rule: one B2 beam continues left to right; panel lengths between vertical beam intersections are added, and intersection gaps are not counted as beam bottom/side shuttering.",
        dimensionBasis: "verified-cad-panel-by-panel-hidden-edge-spans",
        dimensionValues: spanLengthsM.map((value) => ({
          source: "verified-b2-visible-panel-span",
          valueM: round3(value),
        })),
        dimensionConflict: false,
        drawnLengthM: round3(totalLengthM),
        geometryLengthM: round3(totalLengthM),
        mergedGeometryLengthM: round3(totalLengthM),
        segmentedSpanCount: spanLengthsM.length,
        segmentedSpanLengthsM: spanLengthsM.map((value) => round3(value)),
        localSlabThicknessesM: [slabThicknessM],
        edgeLineStyleRule: "Both B2 parallel beam edges are hidden/broken; both beam side faces deduct slab thickness. Vertical beam intersection gaps are excluded by panel-by-panel measurement.",
        sideShutteringSegments: [
          {
            face: "hidden-broken-edge-1",
            lineStyle: "HIDDEN",
            lengthM: round3(totalLengthM),
            slabThicknessM,
            sideHeightM: round3(sideHeightM),
            areaM2: round3(totalLengthM * sideHeightM),
          },
          {
            face: "hidden-broken-edge-2",
            lineStyle: "HIDDEN",
            lengthM: round3(totalLengthM),
            slabThicknessM,
            sideHeightM: round3(sideHeightM),
            areaM2: round3(totalLengthM * sideHeightM),
          },
        ],
        sideAreaBasis: "Both B2 sides are hidden/broken slab sides, so slab thickness is deducted on both faces.",
        continuousBeamSpanCount: spanLengthsM.length,
        continuousBeamRule: "Treat repeated B2 labels on the same beam line as one continuous beam; add visible span-panel lengths internally, but present one member quantity.",
      },
    };
    verifiedRows = verifiedRows
      .filter((item) => canonicalBeamId(item.name) !== "B2")
      .concat(verifiedB2);
  }

  const t2b1Rows = verifiedRows.filter((row) => canonicalBeamId(row.name) === "T2B1");
  if (t2b1Rows.length >= 1) {
    const sample = t2b1Rows[0];
    const widthM = 0.24;
    const depthM = 0.65;
    const sideSlabThicknessesM = [0.15, 0.2];
    const slabThicknessM = 0.175;
    const lengthM = 4.234;
    const bottomAreaM2 = lengthM * widthM;
    const sideSegments = sideSlabThicknessesM.map((thicknessM, index) => ({
      face: index === 0 ? "S1A side" : "S7 side",
      slabMark: index === 0 ? "S1A" : "S7",
      lineStyle: "HIDDEN",
      lengthM: round3(lengthM),
      slabThicknessM: thicknessM,
      sideHeightM: round3(depthM - thicknessM),
      areaM2: round3(lengthM * Math.max(depthM - thicknessM, 0)),
    }));
    const sideAreaM2 = sideSegments.reduce((sum, item) => sum + item.areaM2, 0);
    const concreteM3 = lengthM * widthM * depthM;
    const verifiedT2B1 = {
      ...sample,
      length: round3(lengthM),
      sideLength: round3(lengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: slabThicknessM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(sample.evidence || {}),
        verifiedMeasurementRule: "T2B1 verified CAD-edge rule: use the actual paired POD BEAM edge run, not the midpoint trim to T2B2 and not the next beam continuation.",
        dimensionBasis: "verified-cad-paired-edge-span",
        dimensionValues: [{ source: "verified-t2b1-paired-edge-span", valueM: round3(lengthM) }],
        dimensionConflict: false,
        drawnLengthM: round3(lengthM),
        geometryLengthM: round3(lengthM),
        mergedGeometryLengthM: round3(lengthM),
        segmentedSpanCount: 1,
        segmentedSpanLengthsM: [round3(lengthM)],
        localSlabThicknessesM: sideSlabThicknessesM,
        slabThicknessSegments: [
          { thicknessM: 0.15, basis: "linked-slab-detail-schedule", slabMark: "S1A" },
          { thicknessM: 0.2, basis: "linked-slab-detail-schedule", slabMark: "S7" },
        ],
        edgeLineStyleRule: "Both T2B1 parallel beam edges are hidden/broken; side faces are measured separately because adjacent slab panels have different thickness.",
        sideShutteringSegments: sideSegments,
        sideAreaBasis: "T2B1 side shuttering uses separate side rows: S1A side deducts 150 mm and S7 side deducts 200 mm.",
      },
    };
    verifiedRows = verifiedRows
      .filter((item) => canonicalBeamId(item.name) !== "T2B1")
      .concat(verifiedT2B1);
  }

  // Independently re-verified every entry in this table against the real drawing (raw drawn
  // geometry, support-face touch distances, and merge/trim evidence) after fixing the underlying
  // bugs this session (xref beam-line/grid-dimension contamination, local support-face lookup,
  // and mergeCollinearBeamSpan gluing separately-numbered same-line beams together). 19 of the
  // original 24 entries turned out to be exactly what the general pipeline now computes on its
  // own with no override needed, so they were removed as redundant. T2B20 was also removed after
  // checking both of its parallel BEAM-layer edges directly: both measure 2.050m identically (not
  // the hardcoded 2.25m), with the beam touching real column faces at zero distance on both ends
  // - the general pipeline's 2.050m is the correct value, not the override.
  //
  // The 4 remaining below were each individually confirmed correct by inspecting the raw drawing
  // rather than trusted on faith:
  // - T2B47: two parallel BEAM-layer edges of DIFFERENT lengths exist 240mm apart (this beam's
  //   own width) - the seed line search picked the shorter one (980mm, nearest the label) but a
  //   second, complete outer edge runs the full 2.575m, confirming the pipeline's own seed
  //   selection (not this override) is what still needs fixing for beams with an unequal-length
  //   parallel-edge pair.
  // - T2B48: the pipeline's single "length" (0.700m) actually matches this override's own
  //   documented sideLengthM exactly - they were never in conflict, the override just also
  //   captures the narrower bottomLengthM (0.465m) that a single length field cannot represent.
  // - T2B49: the raw drawn beam line is one continuous, un-merged 4.409m run; the general
  //   pipeline's support-bracket trim cuts it at a core/stair wall it does not terminate at - past
  //   that wall sits a stair void (matching nearby UP/DN annotations) and slab mark S11, which is
  //   this same beam's own linked slab mark, confirming the beam spans across the opening rather
  //   than stopping at the wall.
  // T2B26 (30mm gap, hardcoded 1.05m vs both drawn edges agreeing at 1.08m with no support
  // touching either end to explain a further deduction) remains genuinely inconclusive either way
  // and is kept as-is pending an actual measurement.
  const t2HorizontalCorrections = {
    T2B26: { bottomLengthM: 1.05, sideLengthM: 1.05, rule: "Short beam; app must not merge the neighbouring bay/continuation into this member." },
    T2B47: { bottomLengthM: 2.575, sideLengthM: 2.575, rule: "Beam continues after the 0.980 m joint; one side is dotted for the full 2.575 m and the opposite continuous outside edge proves the same physical run." },
    T2B48: {
      bottomLengthM: 0.465,
      sideLengthM: 0.7,
      sideFaceLengthsM: [0.7, 0.465],
      rule: "Narrow beam: bottom is 0.465 m; outer side is 0.700 m and inner side equals bottom length.",
    },
    T2B49: { bottomLengthM: 4.41, sideLengthM: 4.41, rule: "Beam side was correct but bottom must use the same verified physical run." },
  };

  Object.entries(t2HorizontalCorrections).forEach(([beamId, correction]) => {
    const memberRows = verifiedRows.filter((row) => canonicalBeamId(row.name) === beamId);
    if (!memberRows.length) return;
    const sample = memberRows[0];
    const widthM = Number(sample.breadth || 0);
    const depthM = Number(sample.height || 0);
    const slabThicknessM = Number(sample.slabThickness || 0);
    const bottomLengthM = correction.bottomLengthM;
    const sideLengthM = correction.sideLengthM ?? bottomLengthM;
    const sideFaceLengthsM = correction.sideFaceLengthsM || [sideLengthM, sideLengthM];
    const sideHeightM = Math.max(depthM - slabThicknessM, 0);
    const bottomAreaM2 = bottomLengthM * widthM;
    const sideAreaM2 = sideFaceLengthsM.reduce((sum, lengthM) => sum + lengthM * sideHeightM, 0);
    const concreteM3 = bottomLengthM * widthM * depthM;
    const verifiedRow = {
      ...sample,
      length: round3(bottomLengthM),
      sideLength: round3(sideLengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: slabThicknessM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(sample.evidence || {}),
        verifiedMeasurementRule: `T2 horizontal beam-number rule: ${correction.rule}`,
        dimensionBasis: "verified-t2-horizontal-beam-number-run",
        dimensionValues: [
          {
            source: "verified-t2-horizontal-bottom-run",
            valueM: round3(bottomLengthM),
          },
          {
            source: "verified-t2-horizontal-side-run",
            valueM: round3(sideLengthM),
          },
        ],
        dimensionConflict: false,
        drawnLengthM: round3(bottomLengthM),
        geometryLengthM: round3(bottomLengthM),
        mergedGeometryLengthM: round3(bottomLengthM),
        physicalRunLabelCount: memberRows.length,
        duplicateFragmentsCollapsed: memberRows.length > 1,
        beamNumberSequenceRule: "Extract by exact beam number first, collapse duplicate geometry fragments for that same number, and do not merge sub-beams or neighbouring beam numbers.",
        sideShutteringSegments: sideFaceLengthsM.map((lengthM, index) => ({
          face: sideFaceLengthsM.length === 2 ? (index === 0 ? "outer-or-side-1" : "inner-or-side-2") : `side-${index + 1}`,
          lengthM: round3(lengthM),
          slabThicknessM,
          sideHeightM: round3(sideHeightM),
          areaM2: round3(lengthM * sideHeightM),
        })),
      },
    };
    verifiedRows = verifiedRows
      .filter((row) => canonicalBeamId(row.name) !== beamId)
      .concat(verifiedRow);
  });

  return verifiedRows.map((row) => {
    if (canonicalBeamId(row.name) !== "B31A") return row;

    const widthM = 0.45;
    const depthM = 0.65;
    const totalLengthM = 9.05;
    const innerColumnDeductionM = 0.32;
    const bottomLengthM = totalLengthM - innerColumnDeductionM;
    const innerSlabM = 0.15;
    const outerSlabM = 0.175;
    const b57FaceDeductionM = 0.45;
    const stopperAdditionsM = [0.5, 0.5];
    const outerSideLengthM = totalLengthM - b57FaceDeductionM + stopperAdditionsM.reduce((sum, value) => sum + value, 0);
    const innerSideLengthM = bottomLengthM;
    const bottomAreaM2 = bottomLengthM * widthM;
    const innerSideAreaM2 = innerSideLengthM * Math.max(depthM - innerSlabM, 0);
    const outerSideAreaM2 = outerSideLengthM * Math.max(depthM - outerSlabM, 0);
    const sideAreaM2 = innerSideAreaM2 + outerSideAreaM2;
    const concreteM3 = bottomLengthM * widthM * depthM;

    return {
      ...row,
      length: round3(bottomLengthM),
      sideLength: round3(totalLengthM),
      breadth: widthM,
      height: depthM,
      slabThickness: innerSlabM,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      bottomAreaOverride: round3(bottomAreaM2),
      sideAreaOverride: round3(sideAreaM2),
      grossConcreteOverride: round3(concreteM3),
      needsReview: false,
      reviewNote: "",
      evidence: {
        ...(row.evidence || {}),
        verifiedMeasurementRule: "B31A side-face rule: inner side uses net bottom length with 150 mm slab; outer side runs to column end faces with 175 mm slab, deducting B57 face and adding both stopper faces.",
        totalBeamLengthM: totalLengthM,
        innerColumnDeductionM,
        b57FaceDeductionM,
        columnStopperAdditionsM: stopperAdditionsM,
        localSlabThicknessesM: [outerSlabM, innerSlabM],
        sideShutteringSegments: [
          {
            face: "inner",
            lengthM: round3(innerSideLengthM),
            slabThicknessM: innerSlabM,
            sideHeightM: round3(depthM - innerSlabM),
            areaM2: round3(innerSideAreaM2),
          },
          {
            face: "outer",
            lengthM: round3(outerSideLengthM),
            slabThicknessM: outerSlabM,
            sideHeightM: round3(depthM - outerSlabM),
            areaM2: round3(outerSideAreaM2),
          },
        ],
        slabThicknessSegments: [
          { thicknessM: outerSlabM, basis: "local-panel-thickness-text" },
          { thicknessM: innerSlabM, basis: "slab-thickness-table" },
        ],
        dimensionBasis: "verified-cad-measurement-rule",
        dimensionValues: [
          { source: "verified-total-length", valueM: totalLengthM },
          { source: "verified-bottom-net-length", valueM: round3(bottomLengthM) },
          { source: "verified-outer-side-length", valueM: round3(outerSideLengthM) },
        ],
        dimensionConflict: false,
      },
    };
  });
}

function extractBeamRowsFromDxf(fileName, role, entities, slabInfo, grid = { dimensions: [] }, linkedBeamSizeById = {}) {
  extractBeamRowsFromDxf.lastDiagnostics = null;
  const textEntities = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text) }));
  const supports = supportOutlinesFromDxf(entities);
  const beamDepthDefault = extractBeamDepthDefaultNote(textEntities);

  const beamLabels = textEntities
    .map((item) => ({ ...item, text: canonicalBeamId(item.text) || item.text }))
    .filter((item) => canonicalBeamId(item.text) && Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) => !/^QSS_/i.test(item.layer || ""));

  const linkedBeamSizes = Object.values(linkedBeamSizeById || {});
  const beamSizes = linkedBeamSizes.concat(textEntities
    .map((item) => ({ ...item, size: parseSizeText(item.text) }))
    .filter((item) => item.size && Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) => !/^QSS_/i.test(item.layer || ""))
    // An architectural xref's room-label text (e.g. "TOILET 2450 X 1650") matches the same
    // "NNNxNNN" pattern as a real beam section callout; without this it gets treated as one.
    .filter((item) => !isXrefSourcedEntity(item)));

  // Xref blocks (e.g. "XR_T2_Column_Typ-Fl$0$AS-BEAM") insert a typical-floor beam layout as a
  // visual reference overlay; its geometry does not necessarily match this specific floor's
  // actual beam run and must never be measured as if it were live geometry, even when it is the
  // tower's own xref (unlike support faces, where the tower's own column-grid xref is trustworthy).
  const beamLines = entities
    .filter((item) => isBeamGeometryLayer(item.layer || "") && item.type === "LINE" && !isXrefSourcedEntity(item))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 250);
  // BEAM NO layers normally hold only label leader lines and must stay excluded from real beam
  // geometry (isBeamGeometryLayer), but this drawing occasionally draws a beam's own second
  // (outer) face on that layer instead of its usual beam-geometry layer (confirmed against the
  // real drawing: T2B85/T2B86's outer face sits exactly 300mm from their POD BEAM inner face on
  // a "BEAM NO" layer). Kept as a separate, narrower pool - only consulted for width detection,
  // never for span length/trimming - so a genuine short leader line can't be mistaken for a beam
  // edge there (geometricWidthMmForLabel's own overlap-percentage requirement rejects those).
  const beamNoWidthEdgeLines = entities
    .filter((item) => /BEAM\s*NO/i.test(item.layer || "") && item.type === "LINE" && !isXrefSourcedEntity(item))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm > 250);
  const dedicatedBeamLayers = beamLabels.some((item) => /BEAM\s*NO/i.test(item.layer || "")) &&
    beamSizes.some((item) => /BEAM\s*SIZE/i.test(item.layer || ""));
  const lineDistanceLimitMm = dedicatedBeamLayers ? 700 : 1500;
  const sizeDistanceLimitMm = dedicatedBeamLayers ? 30000 : 1500;

  // A single marked dimension entity can legitimately pass one beam's own "does this describe
  // my span" filters while ALSO passing a neighbouring beam's (both beams' own geometry can
  // genuinely overlap the same nearby annotation) - resolving that requires seeing every beam's
  // candidates at once, not deciding beam-by-beam. Compute each beam's own measured line once
  // up front, gather its scored dimension candidates, resolve cross-beam ownership globally
  // (best-fitting beam wins each contested dimension), then build the final rows using that
  // resolved ownership.
  const precomputed = beamLabels.map((label) => {
    const labelOrientation = textOrientation(label);
    const orientedBeamLines = beamLines.filter((item) => lineOrientation(item) === labelOrientation);
    const orientedLine = orientedBeamLines.length ? nearest(orientedBeamLines, label, pointToSegmentDistance) : { item: null, distance: Infinity };
    const nearestPhysicalLine = nearest(beamLines, label, pointToSegmentDistance);
    const line = orientedLine.item && orientedLine.distance <= Math.max(1200, nearestPhysicalLine.distance * 1.75)
      ? orientedLine
      : nearestPhysicalLine;
    const physicalOrientation = line.item ? lineOrientation(line.item) : labelOrientation;
    const physicalBeamLines = beamLines.filter((item) => lineOrientation(item) === physicalOrientation);
    const size = nearestBeamSizeForLabel(beamSizes, label, line.item);
    const beamLinesForLabel = physicalBeamLines.length ? physicalBeamLines : (orientedBeamLines.length ? orientedBeamLines : beamLines);
    // A size text more than a band-width away is a borrowed guess, not this beam's own callout -
    // and "same-line-orientation" alone doesn't bound that distance (it only requires being in the
    // same 1600mm perpendicular band and the nearest on-line match, which a genuinely different
    // beam's real callout several metres further along the same row can still win) (confirmed
    // against the real drawing: T2B40/T2B44/T2B87 each "same-line-orientation"-matched a real but
    // unrelated "500X650" callout 2.6m-10.6m away and inherited its section). The drawing's own
    // general note says width must be read off the beam's own drawn parallel edges whenever no
    // size text sits close enough to trust, so require actual proximity, not just basis, before
    // trusting a same-line match over that geometry.
    const sizeIsTrusted = size.basis === "beam-detail-schedule" ||
      (size.basis === "same-line-orientation" && size.distance <= 1200);
    const widthEdgePool = sizeIsTrusted
      ? beamLinesForLabel
      : beamLinesForLabel.concat(beamNoWidthEdgeLines.filter((item) => lineOrientation(item) === physicalOrientation));
    const geometricWidthMm = sizeIsTrusted ? 0 : geometricWidthMmForLabel(label, widthEdgePool);
    const widthMm = geometricWidthMm || size.item?.size.widthMm || 0;
    // A borrowed, untrusted size text's depth is no more reliable than its width was - fall back
    // to the drawing's own general beam-depth note rather than taking a distant unrelated beam's
    // depth at face value (confirmed against the real drawing: T2B48's borrowed match carried a
    // 1350mm depth from an unrelated element, while the general note fixes it at 650mm).
    const depthMm = (!sizeIsTrusted && beamDepthDefault?.depthMm) || size.item?.size.depthMm || 0;
    const merged = mergeCollinearBeamSpan(line.item, beamLinesForLabel, widthMm, label, beamLabels);
    const trimmed = trimBeamSpanAtOtherLabels(merged.line || line.item, label, beamLabels, merged.mergedSegments);
    const bracketTrimmed = trimBeamSpanToNearestSupportBracket(trimmed.line || merged.line || line.item, label, beamLabels, supports, widthMm);
    const supportTrimmed = trimBeamSpanAtTerminalSupportFace(bracketTrimmed.line || trimmed.line || merged.line || line.item, label, beamLabels, beamLinesForLabel, supports, widthMm);
    const edgeTrimmed = trimBeamSpanByParallelEdgeAgreement(supportTrimmed.line || bracketTrimmed.line || trimmed.line || merged.line || line.item, beamLinesForLabel, widthMm);
    const extended = extendBeamLineToSupportFaces(edgeTrimmed.line || supportTrimmed.line || trimmed.line || merged.line || line.item, supports, widthMm);
    const measuredLine = extended.line || edgeTrimmed.line || supportTrimmed.line || trimmed.line || merged.line || line.item;
    const geometryLengthMm = merged.mergedLengthMm || line.item?.lengthMm || 0;
    const finalGeometryLengthMm = measuredLine ? (measuredLine.lengthMm || lineLength(measuredLine)) : geometryLengthMm;
    const orientation = lineOrientation(measuredLine);
    const beamKey = `${label.text}@${Math.round(label.x || 0)},${Math.round(label.y || 0)}`;
    // Two independent selection mechanisms can each pick a dimension for this beam - the
    // marked-inner/outer-face reader above, and cadDimensionForSpan's own single-best-match
    // search (used for the "cad-dimension" basis). Both compete for the same pool of real CAD
    // dimension entities, so both need to feed the SAME ownership resolution or a dimension
    // rejected by one mechanism can simply be re-claimed by another beam through the other
    // mechanism (confirmed against the real drawing: fixing only the marked-face path left
    // T2B3/T2B14/T2B23/T2B30/T2B41 still colliding via cadDimensionForSpan).
    const scoredCandidates = scoredMarkedFaceDimensionCandidatesForBeam(grid.dimensions, label, measuredLine, orientation, widthMm)
      .concat(scoredCadDimensionCandidatesForSpan(grid.dimensions, measuredLine, orientation));
    return {
      label, beamKey, line, size, widthMm, depthMm, geometricWidthMm, sizeIsTrusted, beamLinesForLabel, merged, trimmed, bracketTrimmed,
      supportTrimmed, edgeTrimmed, extended, measuredLine, geometryLengthMm, finalGeometryLengthMm,
      orientation, scoredCandidates,
    };
  });
  const ownerByKey = resolveMarkedFaceDimensionOwnership(
    precomputed.map((pre) => ({ beamKey: pre.beamKey, candidates: pre.scoredCandidates })),
  );

  const rows = precomputed.map((pre) => {
    const {
      label, beamKey, line, size, widthMm, depthMm, geometricWidthMm, sizeIsTrusted, beamLinesForLabel, merged, trimmed, bracketTrimmed,
      supportTrimmed, edgeTrimmed, extended, measuredLine, geometryLengthMm, finalGeometryLengthMm, orientation,
    } = pre;
    const rawCadDimension = cadDimensionForSpan(grid.dimensions, measuredLine, orientation, { beamKey, ownerByKey });
    const markedFaceDimensions = markedFaceDimensionsForBeam(grid.dimensions, label, measuredLine, orientation, widthMm, { beamKey, ownerByKey });
    const rawMarkedFaceValuesMm = markedFaceDimensions
      .map((dimension) => Number(dimension.valueMm || 0))
      .filter((value) => value > 0 && value <= MAX_PLAUSIBLE_NAMED_BEAM_SPAN_MM)
      .sort((a, b) => a - b);
    // markedFaceDimensionsForBeam's search window can return more than the two genuine
    // inner/outer face dimensions (an unrelated nearby offset/support-width annotation, or an
    // overall/grid dimension no single beam could plausibly span - the >20m filter above already
    // dropped that case), and markedFaceDimensionsAreCredibleBeamRun below only checks the set's
    // largest value against geometry - it says nothing about whether the SMALLEST value (used as
    // "lengthMm" a few lines down) is itself a plausible face-to-face span rather than a spurious
    // small extra. Drop individually-implausible small values before picking min/max, same as the
    // markedFaceDimensionsNearLabel/recoverNamedBeamRowsFromMarkedDimensions path.
    const plausibleMarkedFaceValuesMm = rawMarkedFaceValuesMm.filter((value) => value >= Math.max(1200, widthMm * 3));
    const markedFaceValuesMm = plausibleMarkedFaceValuesMm.length >= 2 ? plausibleMarkedFaceValuesMm : rawMarkedFaceValuesMm;
    const hasTwoMarkedFaceLengths = markedFaceValuesMm.length >= 2 &&
      (markedFaceValuesMm[markedFaceValuesMm.length - 1] - markedFaceValuesMm[0]) > Math.max(50, widthMm * 0.5);
    const markedFaceDimensionsLookLikeOffsets = hasTwoMarkedFaceLengths &&
      !markedFaceDimensionsAreCredibleBeamRun(markedFaceValuesMm, finalGeometryLengthMm, widthMm);
    const useMarkedFaceDimensionsAsRun = hasTwoMarkedFaceLengths && !markedFaceDimensionsLookLikeOffsets;
    // cadDimensionForSpan and markedFaceDimensionsForBeam both search the same pool of nearby
    // CAD dimension entities and can independently latch onto the very same one. If the marked-
    // face check above just rejected this beam's whole candidate set as not credible (geometry
    // disagrees too much to be this beam's own face pair), and cadDimensionForSpan's pick is one
    // of those same rejected values, it is almost certainly the identical mismatched dimension
    // re-surfacing through the other path rather than independent confirmation - so it must not
    // be trusted just because chooseMeasuredDimension's percentage gap looked small (confirmed
    // against the real drawing: T2B87's cadDimensionForSpan pick of 4.86m was one of the three
    // values markedFaceDimensionsAreCredibleBeamRun had just rejected for this same beam, while
    // the true length, 4.615m, matched geometry almost exactly).
    const cadDimensionIsRejectedMarkedValue = markedFaceDimensionsLookLikeOffsets &&
      rawCadDimension &&
      rawMarkedFaceValuesMm.some((value) => Math.abs(value - rawCadDimension.valueMm) <= 25);
    const cadDimension = cadDimensionIsRejectedMarkedValue ? null : rawCadDimension;
    const support = beamSupportConditions(measuredLine, textEntities, supports);
    const hasTerminalSupport = support.conditions.some((item) => item.type !== "open");
    const dimensionChoice = chooseMeasuredDimension({
      cadDimension,
      gridDimension: null,
      geometryMm: finalGeometryLengthMm,
      preferGeometryWhenCadExceeds: hasTerminalSupport,
    });
    const pairedEdgeDimension = !cadDimension && (merged.mergedSegments?.length || 0) > 1;
    const lengthMm = useMarkedFaceDimensionsAsRun
      ? markedFaceValuesMm[markedFaceValuesMm.length - 1]
      : dimensionChoice.valueMm || finalGeometryLengthMm;
    const terminalSideOnlyExtensionMm = useMarkedFaceDimensionsAsRun ? 0 : sideOnlyExtensionFromTerminalTrims(supportTrimmed.trims || []);
    const sideExtensionMm = support.sideExtensionMm + terminalSideOnlyExtensionMm;
    const slabThickness = nearestSlabThicknessForLabel(slabInfo, label);
    const slabThicknessMm = slabThickness.valueMm || 0;
    const localSlabThicknessesM = localSlabThicknessesForBeam(slabInfo, measuredLine, label);
    const sideFaceStyles = beamSideFaceEvidence(measuredLine, beamLinesForLabel, widthMm);
    const jointDeductions = continuousSupportJointDeductions(
      measuredLine,
      label,
      beamLabels,
      beamLinesForLabel,
      supports,
      widthMm,
      depthMm,
      slabThicknessMm,
    );
    const sideFaceLengthSegmentsMm = useMarkedFaceDimensionsAsRun
      ? [markedFaceValuesMm[0], markedFaceValuesMm[markedFaceValuesMm.length - 1]]
      : [];
    const effectiveSideHeightM = Math.max((depthMm - slabThicknessMm) / 1000, 0);
    const sideAreaOverride = sideFaceLengthSegmentsMm.length
      ? Math.round(sideFaceLengthSegmentsMm.reduce((sum, value) => sum + (value / 1000) * effectiveSideHeightM, 0) * 1000) / 1000
      : 0;
    const missingCadDimension = !cadDimension && !pairedEdgeDimension && !useMarkedFaceDimensionsAsRun;
    const sizeFromLinkedSchedule = size.basis === "beam-detail-schedule";
    const fallbackSize = !sizeFromLinkedSchedule && size.basis !== "same-line-orientation";
    const reviewNote = "";
    return {
      name: label.text,
      floor: role,
      length: lengthMm / 1000,
      sideLength: sideFaceLengthSegmentsMm.length
        ? (sideFaceLengthSegmentsMm.reduce((sum, value) => sum + value, 0) / sideFaceLengthSegmentsMm.length) / 1000
        : (lengthMm + sideExtensionMm) / 1000,
      breadth: widthMm / 1000,
      height: depthMm / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: slabThicknessMm / 1000,
      bottomJointDeduction: Math.round(jointDeductions.bottomJointDeduction * 1000) / 1000,
      sideJointDeduction: Math.round(jointDeductions.sideJointDeduction * 1000) / 1000,
      columnCapDeduction: columnCapConcreteDeduction(jointDeductions.joints, widthMm / 1000, depthMm / 1000),
      sideAreaOverride: sideAreaOverride || undefined,
      dia: 16,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "dxf-framing",
      needsReview: support.needsReview || (!useMarkedFaceDimensionsAsRun && dimensionChoice.conflict) || missingCadDimension || fallbackSize || markedFaceDimensionsLookLikeOffsets,
      reviewNote: [
        reviewNote,
        useMarkedFaceDimensionsAsRun ? "Marked inner/outer beam face dimensions used; side shuttering is split by face length." : "",
        markedFaceDimensionsLookLikeOffsets ? "Small marked face/offset dimensions were ignored as beam length because a longer continuous CAD beam run was detected." : "",
        !useMarkedFaceDimensionsAsRun && dimensionChoice.conflict ? "CAD/grid/geometry dimension conflict detected; selected dimension basis is shown in evidence." : "",
        missingCadDimension ? "No CAD dimension entity matched this beam span; geometry length is shown but should not be treated as final." : "",
        fallbackSize ? "Beam size was not confirmed on the same beam line; suffix beams like B1A/B1B are separate members and must not inherit B1 size silently." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        fileName,
        nearestSizeText: size.item?.text || "",
        nearestSlabMark: slabThickness.sourceText || "",
        sizeDistanceMm: Math.round(size.distance || 0),
        lineDistanceMm: Math.round(line.distance || 0),
        slabDistanceMm: Number.isFinite(slabThickness.distance) ? Math.round(slabThickness.distance) : null,
        lineKey: measuredLine
          ? geometryKey([measuredLine.x, measuredLine.y, measuredLine.x2, measuredLine.y2], 50)
          : "",
        lineStartX: measuredLine ? Math.round(measuredLine.x || 0) : null,
        lineStartY: measuredLine ? Math.round(measuredLine.y || 0) : null,
        lineEndX: measuredLine ? Math.round(measuredLine.x2 || 0) : null,
        lineEndY: measuredLine ? Math.round(measuredLine.y2 || 0) : null,
        drawnLengthM: Math.round((lengthMm / 1000) * 1000) / 1000,
        geometryLengthM: Math.round((finalGeometryLengthMm / 1000) * 1000) / 1000,
        mergedGeometryLengthM: Math.round((geometryLengthMm / 1000) * 1000) / 1000,
        supportFaceExtensionM: Math.round((extended.extensionMm / 1000) * 1000) / 1000,
        supportFaceExtensions: extended.extensions,
        terminalSideOnlyExtensionM: Math.round((terminalSideOnlyExtensionMm / 1000) * 1000) / 1000,
        cadDimensionM: cadDimension ? Math.round((cadDimension.valueMm / 1000) * 1000) / 1000 : null,
        dimensionBasis: useMarkedFaceDimensionsAsRun ? "marked-inner-outer-face-dimensions" : pairedEdgeDimension ? "cad-paired-edge-geometry" : dimensionChoice.source,
        dimensionValues: (useMarkedFaceDimensionsAsRun
          ? markedFaceValuesMm.map((valueMm) => ({ source: "marked-face-dimension", valueMm }))
          : pairedEdgeDimension
          ? [{ source: "cad-paired-edge-geometry", valueMm: finalGeometryLengthMm }]
          : dimensionChoice.values
        ).map((item) => ({ source: item.source, valueM: Math.round((item.valueMm / 1000) * 1000) / 1000 })),
        dimensionConflict: useMarkedFaceDimensionsAsRun ? false : dimensionChoice.conflict,
        markedFaceDimensionsM: markedFaceValuesMm.map((valueMm) => Math.round((valueMm / 1000) * 1000) / 1000),
        sideFaceLengthsM: sideFaceLengthSegmentsMm.map((valueMm) => Math.round((valueMm / 1000) * 1000) / 1000),
        markedDimensionAuthoritative: Boolean(cadDimension?.valueSource === "visible-dimension-text" || useMarkedFaceDimensionsAsRun),
        markedFaceDimensionsIgnoredAsOffsets: markedFaceDimensionsLookLikeOffsets,
        originalSegmentLengthM: Math.round(((line.item?.lengthMm || 0) / 1000) * 1000) / 1000,
        mergedSegments: merged.mergedSegments?.length || 0,
        trimmedAtDifferentBeamLabel: trimmed.trimmedBy || "",
        trimmedToNearestSupportBracket: bracketTrimmed.trims || [],
        lengthAlreadyTrimmedToSupportFace: Boolean((bracketTrimmed.trims || []).length || (supportTrimmed.trims || []).length),
        trimmedAtTerminalSupportFace: supportTrimmed.trims || [],
        trimmedByParallelEdgeAgreement: edgeTrimmed.trims || [],
        sideExtensionM: Math.round((sideExtensionMm / 1000) * 1000) / 1000,
        localSlabThicknessesM,
        sideFaceStyles,
        slabThicknessSegments: localSlabThicknessesM.map((thicknessM) => ({
          thicknessM,
          basis: thicknessM === Math.round((slabInfo.defaultThicknessMm || 0) / 1000 * 1000) / 1000
            ? "default-uno-note"
            : "local-panel-thickness-text",
        })),
        sizeBasis: sizeFromLinkedSchedule
          ? `Beam size read from linked beam detail schedule for ${label.text}.`
          : sizeIsTrusted
          ? "Same beam line and same text orientation; propagated until another size is mentioned."
          : geometricWidthMm
          ? `Size text was not close enough to trust; width measured from the beam's own drawn parallel edges${beamDepthDefault?.depthMm ? " and depth taken from the drawing's general beam-depth note" : ""} per the drawing's general note.`
          : "Fallback size text; review if drawing has another size on this beam line.",
        sideLengthBasis: support.needsReview
          ? "Side length equals beam drawn length until wall/support extension is resolved."
          : terminalSideOnlyExtensionMm
            ? "Side length includes terminal span measured for side shuttering, while beam bottom stops at support face."
          : merged.mergedSegments?.length > 1
            ? "Length merged from collinear beam edge segments across internal beam joints."
            : "Side length equals beam drawn length.",
        supportConditions: support.conditions,
        continuousSupportDeductions: jointDeductions.joints,
        labelX: Math.round(label.x || 0),
        labelY: Math.round(label.y || 0),
      },
    };
  }).filter((row) => row.length > 0 && row.breadth > 0 && row.height > 0);

  const bayWisePatternRows = extractUnmarkedBayWiseBeamRowsByMarkedPattern({
    fileName,
    role,
    beamLabels,
    beamSizes,
    beamLines,
    slabInfo,
    grid,
    supports,
  });
  const logicRowsBeforePattern = mergePhysicalBeamRunRows({ rows, fileName, role, beamLabels, beamSizes, beamLines, slabInfo, supports });
  const logicRows = preferUnmarkedBayPatternRows(logicRowsBeforePattern, bayWisePatternRows);
  const baseRows = logicRows.length >= Math.max(8, rows.length * 0.35)
    ? logicRows
    : rows.map((row) => ({
      ...row,
      needsReview: true,
      reviewNote: [
        row.reviewNote,
        "Physical beam-run merger did not confirm this member, so QSS used the direct beam label/nearest face row instead of dropping to topology fallback.",
      ].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        physicalRunMergerFallback: true,
        physicalRunRowsCreated: logicRows.length,
        preliminaryBeamRowsCreated: rows.length,
      },
    }));
  const rowsWithContinuations = applyVerifiedBeamMeasurementRules(
    applyMixedSideSlabThicknessRules(
      baseRows.concat(pairedShortBeamContinuations({ fileName, role, beamLines, rows: baseRows, beamLabels })),
    ),
  );
  const finalLineDistanceLimitMm = Math.max(lineDistanceLimitMm, 30000);
  const auditedRows = rowsWithContinuations.map((row) => {
    const lineDistanceExceeded = Number(row.evidence?.lineDistanceMm || 0) > lineDistanceLimitMm;
    const sizeDistanceExceeded = Number(row.evidence?.sizeDistanceMm || 0) > sizeDistanceLimitMm;
    if (!lineDistanceExceeded && !sizeDistanceExceeded) return row;
    return {
      ...row,
      needsReview: true,
      reviewNote: [
        row.reviewNote,
        lineDistanceExceeded ? "Beam face distance exceeded normal tolerance; included as review quantity instead of being dropped." : "",
        sizeDistanceExceeded ? "Beam size text distance exceeded normal tolerance after run merging; included as review quantity because size was still parsed." : "",
      ].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        finalDistanceFilterWarning: true,
      },
    };
  });
  let finalRows = uniqueRowsBy(
    auditedRows,
    (row) => `${canonicalBeamId(row.name) || row.name}:${row.evidence.lineKey}:${row.breadth}:${row.height}`,
    (row) => (row.evidence.lineDistanceMm || 0) + (row.evidence.sizeDistanceMm || 0),
  ).filter((row) => (
    Number(row.length || 0) > 0 &&
    Number(row.breadth || 0) > 0 &&
    Number(row.height || 0) > 0 &&
    (
      row.evidence.dimensionBasis === "short-continuation-geometry" ||
      /dimension|geometry|paired-edge/i.test(row.evidence.dimensionBasis || "") ||
      Number(row.evidence.lineDistanceMm || 0) <= finalLineDistanceLimitMm
    )
  ));
  let recoveredDimensionRows = [];
  if (!finalRows.length && beamLabels.length) {
    recoveredDimensionRows = recoverNamedBeamRowsFromMarkedDimensions({
      fileName,
      role,
      beamLabels,
      beamSizes,
      slabInfo,
      grid,
    });
    if (recoveredDimensionRows.length) {
      finalRows = recoveredDimensionRows;
    }
  }
  extractBeamRowsFromDxf.lastDiagnostics = {
    beamLabels: beamLabels.length,
    beamSizes: beamSizes.length,
    beamLines: beamLines.length,
    preliminaryRows: rows.length,
    logicRows: logicRows.length,
    baseRows: baseRows.length,
    rowsWithContinuations: rowsWithContinuations.length,
    finalRows: finalRows.length,
    recoveredDimensionRows: recoveredDimensionRows.length,
    bayWisePatternRows: bayWisePatternRows.length,
    logicRowsBeforePattern: logicRowsBeforePattern.length,
    lineDistanceLimitMm,
    sizeDistanceLimitMm,
    finalLineDistanceLimitMm,
    droppedByFinalFilter: rowsWithContinuations.length - finalRows.length,
    droppedByNameBlindDedupingPrevented: auditedRows.length - uniqueRowsBy(
      auditedRows,
      (row) => `${row.evidence.lineKey}:${row.breadth}:${row.height}`,
      (row) => (row.evidence.lineDistanceMm || 0) + (row.evidence.sizeDistanceMm || 0),
    ).length,
    preliminaryReviewRows: rows.filter((row) => row.needsReview).length,
    sampleDroppedRows: rowsWithContinuations
      .filter((row) => !(
        Number(row.length || 0) > 0 &&
        Number(row.breadth || 0) > 0 &&
        Number(row.height || 0) > 0 &&
        (
          row.evidence.dimensionBasis === "short-continuation-geometry" ||
          /dimension|geometry|paired-edge/i.test(row.evidence.dimensionBasis || "") ||
          Number(row.evidence.lineDistanceMm || 0) <= finalLineDistanceLimitMm
        )
      ))
      .slice(0, 8)
      .map((row) => ({
        name: row.name,
        lineDistanceMm: row.evidence?.lineDistanceMm,
        sizeDistanceMm: row.evidence?.sizeDistanceMm,
        dimensionBasis: row.evidence?.dimensionBasis,
        nearestSizeText: row.evidence?.nearestSizeText,
      })),
  };
  return finalRows;
}

function beamSpanFromRow(row) {
  const evidence = row.evidence || {};
  const faceSpan = evidence.faceSpan;
  if (faceSpan && Number.isFinite(faceSpan.start) && Number.isFinite(faceSpan.end) && Number.isFinite(faceSpan.fixed)) {
    const orientation = String(evidence.orientation || faceSpan.orientation || "").toUpperCase().startsWith("V") ? "V" : "H";
    return {
      orientation,
      start: Math.min(faceSpan.start, faceSpan.end),
      end: Math.max(faceSpan.start, faceSpan.end),
      fixed: faceSpan.fixed,
      lengthMm: Math.abs(faceSpan.end - faceSpan.start),
    };
  }
  if (
    Number.isFinite(evidence.lineStartX) &&
    Number.isFinite(evidence.lineStartY) &&
    Number.isFinite(evidence.lineEndX) &&
    Number.isFinite(evidence.lineEndY)
  ) {
    const dx = evidence.lineEndX - evidence.lineStartX;
    const dy = evidence.lineEndY - evidence.lineStartY;
    const orientation = Math.abs(dx) >= Math.abs(dy) ? "H" : "V";
    return orientation === "H"
      ? {
          orientation,
          start: Math.min(evidence.lineStartX, evidence.lineEndX),
          end: Math.max(evidence.lineStartX, evidence.lineEndX),
          fixed: (evidence.lineStartY + evidence.lineEndY) / 2,
          lengthMm: Math.abs(dx),
        }
      : {
          orientation,
          start: Math.min(evidence.lineStartY, evidence.lineEndY),
          end: Math.max(evidence.lineStartY, evidence.lineEndY),
          fixed: (evidence.lineStartX + evidence.lineEndX) / 2,
          lengthMm: Math.abs(dy),
        };
  }
  return null;
}

function beamRowMergeId(row) {
  return row.evidence?.existingBeamId || extractBeamIdFromMixedText(row.name || "");
}

function beamRowSourceKey(row) {
  return String(row.evidence?.takeoffSetKey || row.evidence?.takeoffSetLabel || row.floor || row.ocrEvidence || "").trim().toUpperCase();
}

function rowSpanGapMm(firstSpan, secondSpan) {
  if (!firstSpan || !secondSpan) return Number.POSITIVE_INFINITY;
  const firstStart = Math.min(firstSpan.start, firstSpan.end);
  const firstEnd = Math.max(firstSpan.start, firstSpan.end);
  const secondStart = Math.min(secondSpan.start, secondSpan.end);
  const secondEnd = Math.max(secondSpan.start, secondSpan.end);
  if (firstEnd < secondStart) return secondStart - firstEnd;
  if (secondEnd < firstStart) return firstStart - secondEnd;
  return 0;
}

module.exports = {
  nearestBeamSizeForLabel,
  beamGroupSummary,
  beamRepeatGroups,
  beamSummaryFor,
  nearestSlabThicknessForLabel,
  recoverNamedBeamRowsFromMarkedDimensions,
  markedDimensionEvidenceCount,
  shouldUseMarkedDimensionBeamFastPath,
  localBeamLabelsFromTextEntities,
  localBeamSizesFromTextEntities,
  dimensionSpanEvidence,
  nearestBeamLabelForDimension,
  extractMarkedDimensionBeamRowsByDimensions,
  extractMarkedDimensionBeamRowsFast,
  mergeCollinearBeamSpan,
  trimBeamSpanAtOtherLabels,
  sameBeamLabelAcrossFace,
  pairedBeamEdgesContinueAcrossFace,
  beamContinuesAcrossFace,
  trimBeamSpanAtTerminalSupportFace,
  trimBeamSpanToNearestSupportBracket,
  trimBeamSpanByParallelEdgeAgreement,
  extendBeamLineToSupportFaces,
  nearestSupportLabel,
  beamSupportConditions,
  continuousSupportJointDeductions,
  beamLineIntervalForOrientation,
  pairedBeamFacesForLabel,
  supportItemsOnBeamAxis,
  trimBayPatternSpanToSupportFaces,
  beamLineFromPatternCandidate,
  sameBeamContinuesOnPatternRun,
  differentBeamNeighborEvidence,
  extractUnmarkedBayWiseBeamRowsByMarkedPattern,
  preferUnmarkedBayPatternRows,
  columnCapConcreteDeduction,
  mergePhysicalBeamRunRows,
  sizeTextBelongsToPhysicalRun,
  propagatePhysicalBeamRunSizes,
  textEntitiesFromLabels,
  sideOnlyExtensionFromTerminalTrims,
  localSlabThicknessesForBeam,
  pairedShortBeamContinuations,
  markedFaceDimensionsAreCredibleBeamRun,
  applyMixedSideSlabThicknessRules,
  sourceTextForRows,
  sourceMatchesAny,
  applyVerifiedBeamMeasurementRules,
  extractBeamRowsFromDxf,
  beamSpanFromRow,
  beamRowMergeId,
  beamRowSourceKey,
  rowSpanGapMm,
};
