"use strict";
const { cleanCadText } = require("./dxf-reader.js");
const { buildGridRegistry, buildQuantityReadiness, extractBoundarySegments, extractCutoutVoids, extractSupportBoxes } = require("../topology/boundary-graph.js");

function textEntities(entities) {
  return entities
    .filter((entity) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text)
    .map((entity) => ({
      text: cleanCadText(entity.text),
      x: entity.x,
      y: entity.y,
      layer: entity.layer,
    }))
    .filter((entity) => entity.text);
}

function hasPositiveBeamNumber(text = "") {
  const match = String(text || "").toUpperCase().match(/B(\d+)/);
  return Boolean(match && Number(match[1]) > 0);
}

function beamLabels(texts) {
  return texts.filter((item) => /\b(?:[A-Z]*B\d+[A-Z]?|T\d+B\d+[A-Z]?)\b/i.test(item.text) && hasPositiveBeamNumber(item.text));
}

function beamSizeTexts(texts) {
  return texts.filter((item) => /\b(?:BEAM|B)\s*\(?\s*\d{2,4}(?:\/\d{2,4})?\s*[Xx]\s*\d{2,4}\s*\)?/i.test(item.text));
}

function slabMarks(texts) {
  return texts.filter((item) => /^S\d+[A-Z]?$/i.test(item.text) || /\bS\d+[A-Z]?\b/i.test(item.text));
}

function pickCalculationRoute({ labels, grid, beamSizes }) {
  if (labels.length >= 3) {
    return {
      route: "numbered_beam_route",
      label: "Beam number sequence",
      reason: "Beam/member labels are available, so calculate by member identity first.",
    };
  }
  if (grid.complete && beamSizes.length >= 3) {
    return {
      route: "grid_unnumbered_beam_route",
      label: "Grid-wise unnumbered beam route",
      reason: "Beam sizes are available but beam numbers are missing, so calculate by E/H grid bands.",
    };
  }
  if (grid.complete) {
    return {
      route: "grid_auto_marking_route",
      label: "Grid-based auto marking required",
      reason: "Grids are available but beam identity/size evidence is weak; app must auto-mark beams/panels for checking.",
    };
  }
  return {
    route: "auto_marking_required",
    label: "Auto-marking reference drawing required",
    reason: "Beam labels and reliable grids are not enough; app must create QB/P reference IDs before quantity extraction.",
  };
}

function analyzeDrawingRoute(entities) {
  const texts = textEntities(entities);
  const labels = beamLabels(texts);
  const sizes = beamSizeTexts(texts);
  const marks = slabMarks(texts);
  const grid = buildGridRegistry(entities);
  const readiness = buildQuantityReadiness(entities);
  const boundaries = extractBoundarySegments(entities);
  const supports = extractSupportBoxes(entities);
  const cutouts = extractCutoutVoids(entities);
  const route = pickCalculationRoute({ labels, grid, beamSizes: sizes });
  const requiredActions = [];

  if (!grid.complete) requiredActions.push("Create auto grid/reference axes or require marked grid dimensions.");
  if (!labels.length && sizes.length) requiredActions.push("Build unnumbered beam runs by grid band and beam size.");
  if (!labels.length && !sizes.length) requiredActions.push("Auto-number beams as QB1, QB2, ... in reference working drawing.");
  if (!marks.length) requiredActions.push("Use default slab thickness or read slab thickness from notes/schedule.");
  if (!cutouts.complete) requiredActions.push("Flag cutout/open-to-sky deduction review.");
  requiredActions.push("Create reference working drawing with panel IDs and review markers before premium MB output.");

  return {
    route,
    health: {
      gridAxes: { E: grid.eAxes.length, H: grid.hAxes.length, complete: grid.complete },
      beamLabels: labels.length,
      beamSizeTexts: sizes.length,
      slabMarks: marks.length,
      verifiedBoundaries: boundaries.filter((item) => item.verified).length,
      beamFaces: boundaries.filter((item) => item.verified && item.type === "beam_face").length,
      supportFaces: boundaries.filter((item) => item.verified && item.type === "support_face").length,
      supportBoxes: supports.length,
      cutoutTexts: cutouts.textCount,
      cutoutBoundaryVoids: cutouts.boundaryVoids.length,
      cutoutDiagonalEvidence: cutouts.diagonalEvidenceCount,
    },
    gates: readiness.gates,
    requiredActions,
    sampleEvidence: {
      beamLabels: labels.slice(0, 10).map((item) => item.text),
      beamSizes: sizes.slice(0, 10).map((item) => item.text),
      slabMarks: marks.slice(0, 10).map((item) => item.text),
    },
  };
}

module.exports = { analyzeDrawingRoute };
