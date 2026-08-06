"use strict";
function classifyDashPattern(dashLengthsMm, context = {}) {
  const lengths = (dashLengthsMm || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (lengths.length < 3) {
    return {
      type: "unknown",
      confidence: 0,
      reason: "Not enough dash segments to classify.",
    };
  }

  const longShortPairs = [];
  for (let index = 0; index < lengths.length - 1; index += 1) {
    const a = lengths[index];
    const b = lengths[index + 1];
    const ratio = Math.max(a, b) / Math.max(Math.min(a, b), 1);
    longShortPairs.push(ratio);
  }

  const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  const maxDeviation = Math.max(...lengths.map((value) => Math.abs(value - average) / Math.max(average, 1)));
  const hasGridLabels = Boolean(context.hasGridLabels);
  const hasGridDimensions = Boolean(context.hasGridDimensions);
  const hasBeamEvidence = Boolean(context.hasBeamLabel || context.hasBeamSize || context.hasParallelBeamEdge);
  const longShortScore = longShortPairs.filter((ratio) => ratio >= 1.65).length / longShortPairs.length;

  if (longShortScore >= 0.6 && (hasGridLabels || hasGridDimensions)) {
    return {
      type: "grid_reference",
      confidence: hasGridLabels && hasGridDimensions ? 0.98 : 0.9,
      reason: "Unequal long-short dash pattern with nearby grid labels/dimensions.",
    };
  }

  if (maxDeviation <= 0.25 && hasBeamEvidence) {
    return {
      type: "beam_hidden_edge_candidate",
      confidence: context.hasBeamLabel && context.hasBeamSize ? 0.92 : 0.78,
      reason: "Nearly equal dash segments with beam evidence.",
    };
  }

  if (maxDeviation <= 0.25) {
    return {
      type: "unverified_hidden_line",
      confidence: 0.55,
      reason: "Equal dash segments but missing beam identity/size/support evidence.",
    };
  }

  if (longShortScore >= 0.6) {
    return {
      type: "possible_grid_reference",
      confidence: 0.65,
      reason: "Unequal long-short dash pattern, but grid labels/dimensions were not confirmed.",
    };
  }

  return {
    type: "unknown",
    confidence: 0.25,
    reason: "Dash pattern does not match a verified grid or beam rule.",
  };
}

function canUseLineAsBeamEdge(classification) {
  return classification?.type === "beam_hidden_edge_candidate" && Number(classification.confidence || 0) >= 0.75;
}

function lineBox(line) {
  return {
    minX: Math.min(line.x1, line.x2),
    maxX: Math.max(line.x1, line.x2),
    minY: Math.min(line.y1, line.y2),
    maxY: Math.max(line.y1, line.y2),
  };
}

function boxArea(box) {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function unionBox(lines) {
  const boxes = lines.map(lineBox);
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minY: Math.min(...boxes.map((box) => box.minY)),
    maxY: Math.max(...boxes.map((box) => box.maxY)),
  };
}

function angleDeg(line) {
  return Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180 / Math.PI;
}

function normalizedDiagonalAngle(line) {
  const angle = ((angleDeg(line) % 180) + 180) % 180;
  return angle > 90 ? 180 - angle : angle;
}

function classifyXCutoutEvidence({ diagonalLines = [], text = "", enclosingPanelBox = null } = {}) {
  const cleanText = String(text || "").toUpperCase();
  const hasCutoutText = /CUT\s*OUT|CUTOUT|OPEN\s*TO\s*SKY|\bOTS\b|SHAFT|LIFT|VOID/.test(cleanText);
  const lines = diagonalLines
    .filter((line) => [line.x1, line.y1, line.x2, line.y2].every((value) => Number.isFinite(Number(value))))
    .map((line) => ({
      x1: Number(line.x1),
      y1: Number(line.y1),
      x2: Number(line.x2),
      y2: Number(line.y2),
    }));

  if (lines.length < 2 && !hasCutoutText) {
    return {
      type: "unknown",
      confidence: 0,
      reason: "No X diagonals or cutout/open-to-sky text found.",
    };
  }

  const diagonalPairs = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = normalizedDiagonalAngle(lines[i]);
      const b = normalizedDiagonalAngle(lines[j]);
      const angleSum = a + b;
      const oppositeDiagonal = Math.abs(angleSum - 90) <= 18;
      if (oppositeDiagonal) diagonalPairs.push([lines[i], lines[j]]);
    }
  }

  const bestPair = diagonalPairs[0];
  const evidenceBox = bestPair ? unionBox(bestPair) : null;
  const evidenceArea = evidenceBox ? boxArea(evidenceBox) : 0;
  const largeInsidePanel = enclosingPanelBox && evidenceBox
    ? evidenceArea >= boxArea(enclosingPanelBox) * 0.03
    : evidenceArea >= 0.25e6;

  if (bestPair && (largeInsidePanel || hasCutoutText)) {
    return {
      type: "slab_cutout_void",
      confidence: hasCutoutText ? 0.98 : 0.9,
      reason: hasCutoutText
        ? "Large crossed X diagonals with cutout/open-to-sky text."
        : "Large crossed X diagonals inside slab panel.",
      box: evidenceBox,
    };
  }

  if (hasCutoutText) {
    return {
      type: "possible_slab_cutout_void",
      confidence: 0.72,
      reason: "Cutout/open-to-sky text found but crossed X boundary was not confirmed.",
      box: evidenceBox,
    };
  }

  return {
    type: "unknown",
    confidence: 0.25,
    reason: "Diagonal lines do not form a verified large X cutout.",
  };
}

function canUseAreaAsBillableSlab(classification) {
  return !["slab_cutout_void", "possible_slab_cutout_void"].includes(classification?.type);
}

function isVerticalBoundary(boundary) {
  return Math.abs((boundary.x2 ?? boundary.x1) - boundary.x1) <= Math.abs((boundary.y2 ?? boundary.y1) - boundary.y1) * 0.05;
}

function isHorizontalBoundary(boundary) {
  return Math.abs((boundary.y2 ?? boundary.y1) - boundary.y1) <= Math.abs((boundary.x2 ?? boundary.x1) - boundary.x1) * 0.05;
}

function boundaryRange(boundary, axis) {
  if (axis === "x") return [Math.min(boundary.x1, boundary.x2), Math.max(boundary.x1, boundary.x2)];
  return [Math.min(boundary.y1, boundary.y2), Math.max(boundary.y1, boundary.y2)];
}

function rangeOverlap(a, b) {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

function repeatedSlabBayDimension(boundaryA, boundaryB, context = {}) {
  if (!boundaryA?.verified || !boundaryB?.verified) {
    return {
      ok: false,
      reason: "Both bay boundaries must be verified beam/wall/support faces.",
    };
  }
  if (boundaryA.classification === "grid_reference" || boundaryB.classification === "grid_reference") {
    return {
      ok: false,
      reason: "Grid references cannot define billable slab bay dimensions.",
    };
  }

  const aVertical = isVerticalBoundary(boundaryA);
  const bVertical = isVerticalBoundary(boundaryB);
  const aHorizontal = isHorizontalBoundary(boundaryA);
  const bHorizontal = isHorizontalBoundary(boundaryB);
  const minSharedRunMm = Number(context.minSharedRunMm || 500);

  if (aVertical && bVertical) {
    const sharedRun = rangeOverlap(boundaryRange(boundaryA, "y"), boundaryRange(boundaryB, "y"));
    if (sharedRun < minSharedRunMm) return { ok: false, reason: "Vertical boundaries do not share enough run length." };
    return {
      ok: true,
      direction: "horizontal",
      dimensionMm: Math.abs(boundaryB.faceX - boundaryA.faceX),
      reason: "Verified vertical parallel boundaries define repeated horizontal slab bay width.",
    };
  }

  if (aHorizontal && bHorizontal) {
    const sharedRun = rangeOverlap(boundaryRange(boundaryA, "x"), boundaryRange(boundaryB, "x"));
    if (sharedRun < minSharedRunMm) return { ok: false, reason: "Horizontal boundaries do not share enough run length." };
    return {
      ok: true,
      direction: "vertical",
      dimensionMm: Math.abs(boundaryB.faceY - boundaryA.faceY),
      reason: "Verified horizontal parallel boundaries define repeated vertical slab bay dimension.",
    };
  }

  return {
    ok: false,
    reason: "Boundaries are not parallel in the same direction.",
  };
}

function normalizeBeamSize(sizeText) {
  const match = String(sizeText || "").toUpperCase().replace(/\s+/g, "").match(/(\d{2,4})(?:\/\d{2,4})?[X×](\d{2,4})/);
  if (!match) return "";
  return `${Number(match[1])}X${Number(match[2])}`;
}

function segmentUnnumberedBeamRun({ spans = [], sizeMarks = [], supportFaces = [] } = {}) {
  const sortedSpans = spans
    .filter((span) => Number.isFinite(Number(span.start)) && Number.isFinite(Number(span.end)))
    .map((span) => ({ ...span, start: Number(span.start), end: Number(span.end) }))
    .sort((a, b) => a.start - b.start);
  const sortedMarks = sizeMarks
    .map((mark) => ({ ...mark, at: Number(mark.at), size: normalizeBeamSize(mark.size) }))
    .filter((mark) => Number.isFinite(mark.at) && mark.size)
    .sort((a, b) => a.at - b.at);
  const supports = supportFaces
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sortedSpans.length || !sortedMarks.length || supports.length < 2) {
    return {
      ok: false,
      reason: "Unnumbered beam needs continuous spans, size text, and support faces.",
      runs: [],
    };
  }

  const drawingStart = Math.min(sortedSpans[0].start, supports[0]);
  const drawingEnd = Math.max(sortedSpans.at(-1).end, supports.at(-1));
  const changeSupports = new Set([drawingStart, drawingEnd]);
  let currentSize = sortedMarks[0].size;

  for (const mark of sortedMarks) {
    if (mark.size === currentSize) continue;
    const split = supports
      .filter((support) => support <= mark.at)
      .sort((a, b) => b - a)[0];
    if (Number.isFinite(split)) changeSupports.add(split);
    currentSize = mark.size;
  }

  const splitPoints = [...changeSupports].sort((a, b) => a - b);
  const runs = [];
  for (let index = 0; index < splitPoints.length - 1; index += 1) {
    const start = splitPoints[index];
    const end = splitPoints[index + 1];
    const mark = sortedMarks
      .filter((item) => item.at >= start && item.at <= end)
      .at(0) || sortedMarks.filter((item) => item.at <= start).at(-1) || sortedMarks[0];
    if (!mark?.size || end <= start) continue;
    runs.push({
      name: `AUTO-BEAM-${String(runs.length + 1).padStart(3, "0")} (${mark.size})`,
      size: mark.size,
      start,
      end,
      length: end - start,
      reason: "Unnumbered continuous beam run split by size change at verified support face.",
    });
  }

  return {
    ok: runs.length > 0,
    reason: runs.length ? "Unnumbered beam run segmented by size and support faces." : "No billable unnumbered beam runs created.",
    runs,
  };
}

function formatUnnumberedBeamName({ gridBand = "", size = "", startGrid = "", endGrid = "", orientation = "horizontal" } = {}) {
  const normalizedSize = normalizeBeamSize(size) || normalizeBeamSize(`B(${size})`) || String(size || "").replace(/\s+/g, "").toUpperCase();
  const sizeText = normalizedSize ? `B(${normalizedSize})` : "B(size unknown)";
  const location = String(gridBand || "").trim() || (orientation === "vertical" ? "on E-grid" : "on H-grid");
  const start = String(startGrid || "").trim();
  const end = String(endGrid || "").trim();
  const gridTrace = start && end ? ` / ${start} to ${end}` : "";
  return `Beam ${location} ${sizeText}${gridTrace}`;
}

function classifySoilFillBeamEvidence({ hatchBox = null, nearbyText = "", hasParallelBeamFaces = false, insideCutout = false } = {}) {
  if (!hatchBox || insideCutout) {
    return {
      type: insideCutout ? "cutout_hatch" : "unknown",
      confidence: insideCutout ? 0.9 : 0,
      reason: insideCutout ? "Hatch is inside cutout/void zone, not beam evidence." : "No hatch box supplied.",
    };
  }

  const width = Math.max(0, Number(hatchBox.maxX) - Number(hatchBox.minX));
  const height = Math.max(0, Number(hatchBox.maxY) - Number(hatchBox.minY));
  const longer = Math.max(width, height);
  const shorter = Math.max(Math.min(width, height), 1);
  const elongated = longer / shorter >= 3;
  const hasBeamText = /\bB(?:EAM)?\s*\(?\s*\d{2,4}\s*[X×]\s*\d{2,4}\s*\)?|\bB\d+[A-Z]?\b/i.test(String(nearbyText || ""));

  if (elongated && hasParallelBeamFaces && hasBeamText) {
    return {
      type: "beam_soil_fill_evidence",
      confidence: 0.9,
      reason: "Long narrow hatch aligned with parallel beam faces and nearby beam text.",
    };
  }

  if (elongated && (hasParallelBeamFaces || hasBeamText)) {
    return {
      type: "possible_beam_soil_fill_evidence",
      confidence: 0.65,
      reason: "Long narrow hatch has partial beam evidence but needs beam faces and text together.",
    };
  }

  return {
    type: "unknown_hatch",
    confidence: 0.25,
    reason: "Hatch pattern does not satisfy soil-fill beam evidence gates.",
  };
}

function canStrengthenBeamRun(classification) {
  return ["beam_soil_fill_evidence", "possible_beam_soil_fill_evidence"].includes(classification?.type);
}

function gridNumber(label) {
  const match = String(label || "").match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function centerOfCandidate(candidate, axis) {
  if (axis === "y") return Number(candidate.centerY ?? ((Number(candidate.minY) + Number(candidate.maxY)) / 2));
  return Number(candidate.centerX ?? ((Number(candidate.minX) + Number(candidate.maxX)) / 2));
}

function orderHorizontalBeamsByHGrid(candidates = [], hGrids = [], toleranceMm = 250) {
  const grids = hGrids
    .map((grid) => ({ label: String(grid.label || "").toUpperCase(), y: Number(grid.y) }))
    .filter((grid) => grid.label && Number.isFinite(grid.y))
    .sort((a, b) => gridNumber(a.label) - gridNumber(b.label) || b.y - a.y);

  if (!grids.length) {
    return candidates.map((candidate) => ({
      ...candidate,
      gridBand: "grid missing",
      needsReview: true,
      review: "Horizontal beam cannot be assigned because H grids were not read.",
    }));
  }

  function bandFor(y) {
    for (const grid of grids) {
      if (Math.abs(y - grid.y) <= toleranceMm) return { rank: grids.indexOf(grid) * 2 + 1, label: `on ${grid.label}` };
    }
    if (y > grids[0].y) return { rank: 0, label: `above ${grids[0].label}` };
    for (let index = 0; index < grids.length - 1; index += 1) {
      const upper = grids[index];
      const lower = grids[index + 1];
      const topY = Math.max(upper.y, lower.y);
      const bottomY = Math.min(upper.y, lower.y);
      if (y < topY && y > bottomY) return { rank: index * 2 + 2, label: `between ${upper.label}-${lower.label}` };
    }
    return { rank: grids.length * 2, label: `below ${grids.at(-1).label}` };
  }

  return candidates
    .map((candidate) => {
      const y = centerOfCandidate(candidate, "y");
      const band = bandFor(y);
      return { ...candidate, gridBand: band.label, gridBandRank: band.rank };
    })
    .sort((a, b) => a.gridBandRank - b.gridBandRank || Number(a.minX ?? a.centerX ?? 0) - Number(b.minX ?? b.centerX ?? 0));
}

function orderVerticalBeamsByEGrid(candidates = [], eGrids = [], toleranceMm = 250) {
  const grids = eGrids
    .map((grid) => ({ label: String(grid.label || "").toUpperCase(), x: Number(grid.x) }))
    .filter((grid) => grid.label && Number.isFinite(grid.x))
    .sort((a, b) => gridNumber(a.label) - gridNumber(b.label) || a.x - b.x);

  if (!grids.length) {
    return candidates.map((candidate) => ({
      ...candidate,
      gridBand: "grid missing",
      needsReview: true,
      review: "Vertical beam cannot be assigned because E grids were not read.",
    }));
  }

  function bandFor(x) {
    for (const grid of grids) {
      if (Math.abs(x - grid.x) <= toleranceMm) return { rank: grids.indexOf(grid) * 2 + 1, label: `on ${grid.label}` };
    }
    if (x < grids[0].x) return { rank: 0, label: `left of ${grids[0].label}` };
    for (let index = 0; index < grids.length - 1; index += 1) {
      const left = grids[index];
      const right = grids[index + 1];
      if (x > left.x && x < right.x) return { rank: index * 2 + 2, label: `between ${left.label}-${right.label}` };
    }
    return { rank: grids.length * 2, label: `right of ${grids.at(-1).label}` };
  }

  return candidates
    .map((candidate) => {
      const x = centerOfCandidate(candidate, "x");
      const band = bandFor(x);
      return { ...candidate, gridBand: band.label, gridBandRank: band.rank };
    })
    .sort((a, b) => a.gridBandRank - b.gridBandRank || Number(b.maxY ?? b.centerY ?? 0) - Number(a.maxY ?? a.centerY ?? 0));
}

function hasBeamNumber(candidate) {
  const text = String(candidate.member || candidate.name || candidate.label || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]*\d*B\d+[A-Z]?$/.test(text) || /^B\d+[A-Z]?$/.test(text);
}

function beamNumberSortValue(candidate) {
  const text = String(candidate.member || candidate.name || candidate.label || "").replace(/\s+/g, "").toUpperCase();
  const match = text.match(/B(\d+)([A-Z]?)$/);
  return {
    number: match ? Number(match[1]) : Number.POSITIVE_INFINITY,
    suffix: match?.[2] || "",
  };
}

function chooseBeamReadingOrder({ candidates = [], hGrids = [], eGrids = [], drawingHasBeamNumbers = null } = {}) {
  const hasNumbers = drawingHasBeamNumbers ?? candidates.some(hasBeamNumber);
  if (hasNumbers) {
    const horizontal = candidates
      .filter((candidate) => candidate.orientation !== "vertical")
      .sort((a, b) => {
        const an = beamNumberSortValue(a);
        const bn = beamNumberSortValue(b);
        return an.number - bn.number ||
          an.suffix.localeCompare(bn.suffix) ||
          Number(b.maxY ?? b.centerY ?? 0) - Number(a.maxY ?? a.centerY ?? 0) ||
          Number(a.minX ?? a.centerX ?? 0) - Number(b.minX ?? b.centerX ?? 0);
      })
      .map((candidate) => ({ ...candidate, readingOrderBasis: "beam-number-sequence" }));
    const vertical = candidates
      .filter((candidate) => candidate.orientation === "vertical")
      .sort((a, b) => {
        const an = beamNumberSortValue(a);
        const bn = beamNumberSortValue(b);
        return an.number - bn.number ||
          an.suffix.localeCompare(bn.suffix) ||
          Number(a.minX ?? a.centerX ?? 0) - Number(b.minX ?? b.centerX ?? 0) ||
          Number(b.maxY ?? b.centerY ?? 0) - Number(a.maxY ?? a.centerY ?? 0);
      })
      .map((candidate) => ({ ...candidate, readingOrderBasis: "beam-number-sequence" }));
    return {
      mode: "beam-number-sequence",
      ordered: [...horizontal, ...vertical],
    };
  }

  const horizontal = orderHorizontalBeamsByHGrid(candidates.filter((candidate) => candidate.orientation !== "vertical"), hGrids)
    .map((candidate) => ({ ...candidate, readingOrderBasis: "grid-first-unnumbered-horizontal" }));
  const vertical = orderVerticalBeamsByEGrid(candidates.filter((candidate) => candidate.orientation === "vertical"), eGrids)
    .map((candidate) => ({ ...candidate, readingOrderBasis: "grid-first-unnumbered-vertical" }));
  return {
    mode: "grid-first-unnumbered",
    ordered: [...horizontal, ...vertical],
  };
}

function classifySupportMember({
  box = null,
  color = "",
  layer = "",
  beamOffsetsAtMember = false,
  liftOrShaftTextNearby = false,
  solidFilled = false,
  lShaped = false,
  dottedBeamLinesInterrupted = false,
  beamLinesBecomeSolidAtMember = false,
  sizeChangesAtMember = false,
} = {}) {
  if (!box) {
    return {
      type: "unknown",
      verified: false,
      confidence: 0,
      reason: "No support box supplied.",
    };
  }

  const width = Math.max(0, Number(box.maxX) - Number(box.minX));
  const height = Math.max(0, Number(box.maxY) - Number(box.minY));
  const longer = Math.max(width, height);
  const shorter = Math.max(Math.min(width, height), 1);
  const area = width * height;
  const ratio = longer / shorter;
  const supportColor = /blue|grey|gray|8|5/i.test(String(color || ""));
  const supportLayer = /col|column|wall|lift|shear|support/i.test(String(layer || ""));
  const geometryEvidence = Boolean(
    solidFilled ||
    lShaped ||
    dottedBeamLinesInterrupted ||
    beamLinesBecomeSolidAtMember ||
    beamOffsetsAtMember ||
    sizeChangesAtMember,
  );
  const supportEvidence = geometryEvidence || supportColor || supportLayer || liftOrShaftTextNearby;

  if (!supportEvidence || area < 0.04e6) {
    return {
      type: "unknown",
      verified: false,
      confidence: 0.2,
      reason: "Rectangle does not have enough support evidence.",
    };
  }

  let type = "column";
  if (liftOrShaftTextNearby || (area >= 8e6 && ratio <= 4)) type = "lift_wall";
  else if (lShaped || ratio >= 3 || longer >= 2500) type = "wall";

  return {
    type,
    verified: true,
    confidence: geometryEvidence || supportLayer ? 0.95 : 0.82,
    faces: {
      left: Number(box.minX),
      right: Number(box.maxX),
      bottom: Number(box.minY),
      top: Number(box.maxY),
      centerX: (Number(box.minX) + Number(box.maxX)) / 2,
      centerY: (Number(box.minY) + Number(box.maxY)) / 2,
    },
    reason: geometryEvidence
      ? "Beam behavior/solid-filled geometry identifies this member as verified support."
      : "Support member classified from color/layer/nearby lift-wall evidence.",
  };
}

function classifyContinuousBeamOrSupport({ solidFilled = false, hasBeamSizeText = false, hasParallelBeamFaces = false, lShaped = false } = {}) {
  if (solidFilled || lShaped) {
    return {
      type: "support_member",
      confidence: 0.9,
      reason: "Continuous rectangle/square/L-shape is solid filled, so classify as wall/column/support.",
    };
  }
  if (hasBeamSizeText && hasParallelBeamFaces) {
    return {
      type: "beam_continuous_edge",
      confidence: 0.86,
      reason: "Continuous line is not solid filled and has beam size/parallel-face evidence.",
    };
  }
  return {
    type: "unknown_continuous_geometry",
    confidence: 0.35,
    reason: "Continuous geometry lacks enough beam/support evidence.",
  };
}

function supportFaceForBeam(support, orientation, side = "start") {
  if (!support?.verified || !support.faces) return null;
  if (orientation === "horizontal") return side === "start" ? support.faces.right : support.faces.left;
  if (orientation === "vertical") return side === "start" ? support.faces.top : support.faces.bottom;
  return null;
}

module.exports = {
  classifyDashPattern,
  canUseLineAsBeamEdge,
  classifyXCutoutEvidence,
  canUseAreaAsBillableSlab,
  repeatedSlabBayDimension,
  segmentUnnumberedBeamRun,
  formatUnnumberedBeamName,
  classifySoilFillBeamEvidence,
  canStrengthenBeamRun,
  orderHorizontalBeamsByHGrid,
  orderVerticalBeamsByEGrid,
  chooseBeamReadingOrder,
  classifySupportMember,
  classifyContinuousBeamOrSupport,
  supportFaceForBeam,
};
