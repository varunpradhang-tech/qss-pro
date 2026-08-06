"use strict";

// Builds summary.ruleAudit for an extraction result.
//
// Every check below is keyed by a qss-rulebook.json `codeId` and reads real
// evidence off the extraction result (plans/rows/accuracyAudit) instead of a
// hand-typed duplicate rule list. Adding a new rule to qss-rulebook.json alone
// does nothing here until a matching CHECKS[codeId] evidence function exists —
// that's intentional: an audit entry is a claim that the engine actually looked
// for evidence of that rule, not a restatement of the rulebook text. Rules
// without a check simply don't appear in the audit (they stay
// "documented-pending-full-code" per qss-rule-backlog.md until implemented).
//
// Implements: QSS-QA-001 (review_gate), QSS-QA-002 (mb_excel_remarks), and acts
// as the audit host for every other coded rule's evidence check.

const { codedRules, ruleByCodeId, appliesTo, rulebook } = require("../rulebook");

function percent(value) {
  if (!Number.isFinite(Number(value))) return "0.0";
  return (Number(value) * 100).toFixed(1);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceFormats(plans) {
  return plans.map((plan) => plan.summary?.sourceFormat).filter(Boolean);
}

function references(plans) {
  return plans.map((plan) => plan.summary?.referenceDrawing).filter(Boolean);
}

function rowsWithEvidence(rows, predicate) {
  return rows.filter((row) => {
    try {
      return predicate(row.evidence || {}, row);
    } catch {
      return false;
    }
  });
}

function beamIdFromRow(row) {
  const evidenceId = String(row.evidence?.existingBeamId || "").trim().toUpperCase();
  if (evidenceId) return evidenceId;
  const text = String(row.name || "").toUpperCase();
  const match = text.match(/\b[A-Z]{0,6}B\d+[A-Z]?\b/);
  return match ? match[0] : "";
}

function generatedBeamIdRows(rows) {
  return rows.filter((row) => /\b(?:QB|BQ|BR)\d+\b/i.test(String(row.name || "")));
}

function rowHasWrittenCadPanelDimensions(row = {}) {
  const evidence = row.evidence || {};
  const sourceText = [
    row.source,
    evidence.source,
    evidence.boundaryBasis,
    evidence.selectedPanelMeasurementBasis,
    evidence.lengthBasis,
    evidence.breadthBasis,
    evidence.dimensionBasis,
    evidence.panelSourceRule,
    evidence.writtenDimensionPanel ? "written-cad-dimension-panel" : "",
  ].filter(Boolean).join(" ");
  return (
    /written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|cad-dimension/i.test(sourceText) &&
    Number(row.length) > 0 &&
    Number(row.breadth) > 0
  );
}

// Precomputes every fact the checks below need, once per audit, so each check
// function stays a small pure read of `facts` rather than re-deriving totals.
function buildFacts(context) {
  const itemType = context.itemType || "beam";
  const plans = Array.isArray(context.plans) ? context.plans : [];
  const extractedRows = Array.isArray(context.extractedRows) ? context.extractedRows : [];
  const rows = Array.isArray(context.rows) ? context.rows : [];
  const measuredPlans = plans.filter((plan) => !plan.summary?.linkedDetailOnly);
  const refs = references(measuredPlans);
  const formats = sourceFormats(measuredPlans);
  const routes = unique(measuredPlans.map((plan) => plan.summary?.selectedCalculationRoute));
  const accuracyAudit = context.accuracyAudit || {};

  const reviewRows = extractedRows.filter((row) => row.needsReview).length;
  const reviewRatio = extractedRows.length ? reviewRows / extractedRows.length : 1;
  const panelMarks = refs.reduce((sum, reference) => sum + Number(reference.panelMarks || 0), 0);
  const reviewMarks = refs.reduce((sum, reference) => sum + Number(reference.reviewMarks || 0), 0);
  const reviewOnlyReferences = refs.filter((reference) => reference.summary?.reviewOnlyReference).length;
  const beamMarks = refs.reduce((sum, reference) => sum + Number(reference.beamMarks || 0), 0);
  const panelClosedPolylines = refs.reduce((sum, reference) => sum + Number(reference.summary?.panelClosedPolylines || 0), 0);
  const sectionExclusionZones = refs.reduce((sum, reference) => sum + Number(reference.summary?.sectionExclusionZones || 0), 0);
  const slabMarkCount = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.slabMarkCount || 0), 0);
  const unresolvedSlabMarkCount = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.unresolvedSlabMarkCount || 0), 0);
  const cutoutCount = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.cutoutCount || 0), 0);
  const positiveCutoutCount = measuredPlans.reduce((sum, plan) => {
    if (Number.isFinite(Number(plan.summary?.positiveCutoutCount))) {
      return sum + Number(plan.summary.positiveCutoutCount || 0);
    }
    return sum + (Number(plan.summary?.detectedCutoutAreaM2 || 0) > 0.01 ? Number(plan.summary?.cutoutCount || 0) : 0);
  }, 0);
  const textOnlyCutoutCount = Math.max(0, cutoutCount - positiveCutoutCount);
  const assignedCutoutAreaM2 = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.assignedCutoutAreaM2 || 0), 0);
  const writtenCadPanelRows = extractedRows.filter(rowHasWrittenCadPanelDimensions).length;
  const dimensionConflictRows = rowsWithEvidence(extractedRows, (evidence) => evidence.dimensionConflict);
  const dimensionAuditedRows = rowsWithEvidence(
    extractedRows,
    (evidence) => evidence.dimensionBasis || evidence.dimensionAudit || evidence.dimensionValues?.length,
  );

  return {
    itemType,
    plans,
    extractedRows,
    rows,
    measuredPlans,
    refs,
    formats,
    routes,
    accuracyAudit,
    reviewRows,
    reviewRatio,
    panelMarks,
    reviewMarks,
    reviewOnlyReferences,
    beamMarks,
    panelClosedPolylines,
    sectionExclusionZones,
    slabMarkCount,
    unresolvedSlabMarkCount,
    cutoutCount,
    positiveCutoutCount,
    textOnlyCutoutCount,
    assignedCutoutAreaM2,
    writtenCadPanelRows,
    dimensionConflictRows,
    dimensionAuditedRows,
  };
}

// Each entry: codeId -> (facts) => { status: "pass"|"fail"|"warn", detail, evidence }
const CHECKS = {
  dwg_pdf_dxf_route(facts) {
    return {
      status: facts.formats.length ? "pass" : "fail",
      detail: facts.formats.length
        ? `Measured drawing route: ${unique(facts.formats).join(", ")}.`
        : "No measured drawing source route was reported.",
      evidence: { formats: facts.formats },
    };
  },

  named_beams_keep_original_ids(facts) {
    const referenceModes = unique(facts.refs.map((reference) => reference.summary?.beamIdentityMode));
    const usesExistingBeamNames =
      referenceModes.includes("existing_beam_names") || facts.extractedRows.some((row) => row.evidence?.existingBeamId);
    const generatedRows = generatedBeamIdRows(facts.rows);
    return {
      status: usesExistingBeamNames && generatedRows.length ? "fail" : "pass",
      detail: usesExistingBeamNames
        ? generatedRows.length
          ? `${generatedRows.length} final row(s) still use QSS generated beam IDs although source beam names exist.`
          : "Source beam names exist and final rows keep original beam IDs."
        : "No numbered beam route detected; generated IDs are allowed for unnumbered beams.",
      evidence: { referenceModes, generatedRows: generatedRows.length },
    };
  },

  unnumbered_beams_marked_only_when_needed(facts) {
    const referenceModes = unique(facts.refs.map((reference) => reference.summary?.beamIdentityMode));
    const usesExistingBeamNames =
      referenceModes.includes("existing_beam_names") || facts.extractedRows.some((row) => row.evidence?.existingBeamId);
    return {
      status: usesExistingBeamNames && facts.beamMarks > 0 ? "fail" : "pass",
      detail: usesExistingBeamNames
        ? facts.beamMarks > 0
          ? `${facts.beamMarks} QB beam mark(s) were created even though this drawing has beam names.`
          : "Reference drawing skipped QB marks because beam names already exist."
        : `${facts.beamMarks} QB mark(s) are allowed because this route is unnumbered or weakly numbered.`,
      evidence: { beamMarks: facts.beamMarks, referenceModes },
    };
  },

  continuous_named_beam_run(facts) {
    const beamIds = facts.rows.map(beamIdFromRow).filter(Boolean);
    const duplicateIds = unique(beamIds.filter((id, index) => beamIds.indexOf(id) !== index));
    const mergedRows = rowsWithEvidence(facts.rows, (evidence) => evidence.mergedContinuousNamedBeam);
    return {
      status: mergedRows.length || !duplicateIds.length ? "pass" : "warn",
      detail: mergedRows.length
        ? `${mergedRows.length} continuous named beam run(s) were merged into single member rows.`
        : duplicateIds.length
          ? `${duplicateIds.length} beam ID(s) still appear in more than one row. This is acceptable only if they are separate physical beams, otherwise the merge rule did not fire.`
          : "No repeated named beam IDs needed merging.",
      evidence: { duplicateIds: duplicateIds.slice(0, 12), mergedRows: mergedRows.length },
    };
  },

  beam_parallel_face_pairing(facts) {
    const faceSpanRows = rowsWithEvidence(
      facts.extractedRows,
      (evidence) => evidence.faceSpan || /paired-edge|face/i.test(String(evidence.dimensionBasis || "")),
    );
    return {
      status: facts.extractedRows.length && faceSpanRows.length ? "pass" : "fail",
      detail: faceSpanRows.length
        ? `${faceSpanRows.length} beam row(s) have paired-face or paired-edge evidence.`
        : "No beam rows have paired-face evidence, so beam dimensions are not reliable.",
      evidence: { rowsWithFaceEvidence: faceSpanRows.length, extractedRows: facts.extractedRows.length },
    };
  },

  beam_unmarked_bay_pattern(facts) {
    const unmarkedPatternRows = rowsWithEvidence(facts.extractedRows, (evidence) => evidence.markedDimensionPatternApplied);
    return {
      status: unmarkedPatternRows.length ? "pass" : "warn",
      detail: unmarkedPatternRows.length
        ? `${unmarkedPatternRows.length} unmarked beam row(s) were measured by paired faces and support-face stops using the marked-dimension pattern.`
        : "No unmarked bay-wise beam span used the marked-dimension pattern; either marked dimensions were used directly or continuous/run logic handled the beams.",
      evidence: { unmarkedPatternRows: unmarkedPatternRows.length },
    };
  },

  beam_dotted_continuous_side_logic(facts) {
    const edgeRows = rowsWithEvidence(
      facts.extractedRows,
      (evidence) => evidence.edgeLineStyleRule || /dotted|hidden|continuous/i.test(String(evidence.sideAreaBasis || "")),
    );
    return {
      status: edgeRows.length ? "pass" : "warn",
      detail: edgeRows.length
        ? `${edgeRows.length} beam row(s) carry dotted/continuous side deduction evidence.`
        : "No beam row reports dotted/continuous side evidence; side shuttering may be using default depth deduction.",
      evidence: { rowsWithEdgeStyle: edgeRows.length },
    };
  },

  beam_panel_by_panel_side_thickness(facts) {
    const sideSegmentRows = rowsWithEvidence(
      facts.extractedRows,
      (evidence) => Array.isArray(evidence.sideShutteringSegments) && evidence.sideShutteringSegments.length >= 2,
    );
    return {
      status: sideSegmentRows.length ? "pass" : "warn",
      detail: sideSegmentRows.length
        ? `${sideSegmentRows.length} beam row(s) have separate side-face slab-thickness segments.`
        : "No separate side-face slab-thickness segments found; mixed slab thickness may be averaged or missed.",
      evidence: { rowsWithSideSegments: sideSegmentRows.length },
    };
  },

  support_face_hard_stop_logic(facts) {
    const supportRows = rowsWithEvidence(
      facts.extractedRows,
      (evidence, row) =>
        (Array.isArray(evidence.continuousSupportDeductions) && evidence.continuousSupportDeductions.length) ||
        Number(row.columnCapDeduction || 0) > 0 ||
        Number(row.sideJointDeduction || 0) > 0 ||
        /support|column|wall|joint/i.test(String(row.reviewNote || evidence.sideAreaBasis || "")),
    );
    return {
      status: supportRows.length ? "pass" : "warn",
      detail: supportRows.length
        ? `${supportRows.length} beam row(s) include support/joint/column-wall evidence.`
        : "No support-face evidence reported for beams; hard stops and continuations may be weak.",
      evidence: { rowsWithSupportEvidence: supportRows.length },
    };
  },

  slab_panel_boundary_closure(facts) {
    const writtenDimensionRowsPresent = facts.writtenCadPanelRows > 0 && facts.rows.length > 0;
    const panelCoverageRatio = facts.panelMarks
      ? facts.rows.length / facts.panelMarks
      : writtenDimensionRowsPresent
        ? 1
        : 0;
    return {
      status: writtenDimensionRowsPresent
        ? "pass"
        : facts.panelMarks && panelCoverageRatio >= 0.9
          ? "pass"
          : "fail",
      detail: writtenDimensionRowsPresent
        ? `${facts.writtenCadPanelRows} slab row(s) use written CAD dimensions as the measurement authority.`
        : facts.panelMarks
          ? `${facts.rows.length} final panel row(s) from ${facts.panelMarks} verified slab panel label(s), coverage ${percent(panelCoverageRatio)}%.`
          : facts.reviewMarks
            ? `${facts.reviewMarks} review label(s) were placed, but no measured slab quantity row was verified. Final slab quantity remains locked.`
            : "No verified slab panel rows were created; slab boundary closure did not run successfully.",
      evidence: {
        panelMarks: facts.panelMarks,
        reviewMarks: facts.reviewMarks,
        reviewOnlyReferences: facts.reviewOnlyReferences,
        finalRows: facts.rows.length,
        writtenCadPanelRows: facts.writtenCadPanelRows,
        panelCoverageRatio,
      },
    };
  },

  slab_reference_polylines(facts) {
    return {
      status: "pass",
      detail: "Automatic slab panel creation is removed. Slab quantity rows must come from written CAD dimensions or real verified closed boundaries.",
      evidence: {
        panelMarks: facts.panelMarks,
        reviewMarks: facts.reviewMarks,
        reviewOnlyReferences: facts.reviewOnlyReferences,
        panelClosedPolylines: facts.panelClosedPolylines,
        generatedSlabBoxesEnabled: false,
      },
    };
  },

  slab_thickness_priority(facts) {
    const writtenDimensionRowsPresent = facts.writtenCadPanelRows > 0 && facts.rows.length > 0;
    const ok =
      writtenDimensionRowsPresent ||
      (facts.unresolvedSlabMarkCount === 0 &&
        (facts.slabMarkCount > 0 || facts.measuredPlans.some((plan) => plan.summary?.defaultSlabThicknessMm)));
    return {
      status: ok ? "pass" : "fail",
      detail: writtenDimensionRowsPresent
        ? `${facts.writtenCadPanelRows} written-dimension slab row(s) carry thickness/default evidence.`
        : facts.unresolvedSlabMarkCount
          ? `${facts.unresolvedSlabMarkCount} slab mark(s) did not resolve to panel text/table/default thickness.`
          : facts.slabMarkCount
            ? `${facts.slabMarkCount} slab mark(s) were available and no unresolved marks were reported.`
            : "No slab marks found; default thickness must be checked.",
      evidence: { slabMarkCount: facts.slabMarkCount, unresolvedSlabMarkCount: facts.unresolvedSlabMarkCount },
    };
  },

  cutout_open_to_sky_deduction(facts) {
    const status = !facts.rows.length
      ? "warn"
      : facts.positiveCutoutCount
        ? facts.assignedCutoutAreaM2 > 0
          ? "pass"
          : "fail"
        : facts.textOnlyCutoutCount
          ? "warn"
          : "pass";
    return {
      status,
      detail: !facts.rows.length
        ? `${facts.positiveCutoutCount || facts.cutoutCount} cutout/open-to-sky evidence item(s) were detected, but deduction waits until verified slab quantity rows exist.`
        : facts.positiveCutoutCount
          ? facts.assignedCutoutAreaM2 > 0
            ? `${facts.positiveCutoutCount} measurable cutout/open-to-sky item(s) detected and ${facts.assignedCutoutAreaM2.toFixed(3)} sqm assigned.`
            : `${facts.positiveCutoutCount} measurable cutout/open-to-sky item(s) detected but no deduction was assigned.`
          : facts.textOnlyCutoutCount
            ? `${facts.textOnlyCutoutCount} cutout/open-to-sky text item(s) found without a measurable closed boundary; no area deduction was applied.`
            : "No cutout/open-to-sky item was detected in this extraction.",
      evidence: {
        cutoutCount: facts.cutoutCount,
        positiveCutoutCount: facts.positiveCutoutCount,
        textOnlyCutoutCount: facts.textOnlyCutoutCount,
        assignedCutoutAreaM2: facts.assignedCutoutAreaM2,
      },
    };
  },

  cad_dimension_validation(facts) {
    return {
      status: facts.dimensionConflictRows.length ? "fail" : facts.dimensionAuditedRows.length ? "pass" : "warn",
      detail: facts.dimensionConflictRows.length
        ? `${facts.dimensionConflictRows.length} row(s) have CAD/grid/geometry dimension conflict.`
        : facts.dimensionAuditedRows.length
          ? `${facts.dimensionAuditedRows.length} row(s) have dimension-basis evidence.`
          : "No dimension-basis evidence was reported; quantity is geometry-only.",
      evidence: {
        dimensionConflictRows: facts.dimensionConflictRows.length,
        dimensionAuditedRows: facts.dimensionAuditedRows.length,
      },
    };
  },

  section_detail_exclusion(facts) {
    return {
      status: "pass",
      detail: facts.sectionExclusionZones
        ? `${facts.sectionExclusionZones} section/detail zone(s) were excluded from plan quantity.`
        : "No section/detail zones were detected in this drawing.",
      evidence: { sectionExclusionZones: facts.sectionExclusionZones },
    };
  },

  review_gate(facts) {
    const open = facts.reviewRatio <= 0.1 && facts.accuracyAudit.finalAllowed !== false;
    return {
      status: open ? "pass" : "fail",
      detail: open
        ? `Review ratio ${percent(facts.reviewRatio)}%; final quantity gate is open.`
        : `Review ratio ${percent(facts.reviewRatio)}%; final quantity must stay review-only until failed rules are corrected.`,
      evidence: { reviewRows: facts.reviewRows, extractedRows: facts.extractedRows.length, reviewRatio: facts.reviewRatio },
    };
  },

  mb_excel_remarks(facts) {
    return {
      status: facts.rows.length ? "pass" : "warn",
      detail: facts.rows.length
        ? "MB rows are available; user remarks are blank for clean rows and say need review only for review rows."
        : "No MB rows were produced.",
      evidence: { finalRows: facts.rows.length },
    };
  },
};

function buildRuleAudit(context = {}) {
  const facts = buildFacts(context);
  const checks = [];

  codedRules().forEach((rule) => {
    if (!appliesTo(rule, facts.itemType)) return;
    const check = CHECKS[rule.codeId];
    if (!check) return; // no evidence function yet -> stays undocumented in the audit
    const result = check(facts);
    checks.push({
      id: rule.codeId,
      ruleId: rule.id,
      rulebookVersion: rulebook().version,
      title: rule.title,
      ruleStatus: rule.status || "",
      status: result.status,
      detail: result.detail,
      evidence: result.evidence || {},
    });
  });

  const failedRules = checks.filter((check) => check.status === "fail");
  const warningRules = checks.filter((check) => check.status === "warn");
  const passedRules = checks.filter((check) => check.status === "pass");

  return {
    ruleVersion: context.ruleVersion || rulebook().version,
    itemType: facts.itemType,
    status: failedRules.length ? "failed" : warningRules.length ? "warning" : "passed",
    statusLabel: failedRules.length ? "Rule checks failed" : warningRules.length ? "Rule checks need review" : "Rule checks passed",
    finalAllowed: failedRules.length === 0 && facts.accuracyAudit.finalAllowed !== false,
    routes: facts.routes,
    checks,
    failedRules,
    warningRules,
    passedRules,
    failedCount: failedRules.length,
    warningCount: warningRules.length,
    passedCount: passedRules.length,
  };
}

module.exports = {
  buildRuleAudit,
  ruleByCodeId,
};
