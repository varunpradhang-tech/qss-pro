const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = __dirname;
const configPath = path.join(root, "golden-tests.json");
const serverUrl = process.env.QSS_PRO_URL || "http://127.0.0.1:4175";
const nodePath = process.execPath;
const extractionCache = new Map();
const requestTimeoutMs = Number(process.env.QSS_GOLDEN_REQUEST_TIMEOUT_MS || 120000);

function round(value, digits = 3) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10 ** digits) / 10 ** digits;
}

function beamQuantities(row) {
  const length = Number(row.length || 0);
  const sideLength = Number(row.sideLength || length);
  const width = Number(row.breadth || 0);
  const depth = Number(row.height || 0);
  const slab = Number(row.slabThickness || 0);
  const bottomDeduction = Number(row.bottomJointDeduction || 0);
  const sideDeduction = Number(row.sideJointDeduction || 0);
  const calculatedBottomArea = Math.max(length * width - bottomDeduction, 0);
  const calculatedSideArea = Math.max(2 * sideLength * Math.max(depth - slab, 0) - sideDeduction, 0);
  const bottomArea = Number(row.bottomAreaOverride || 0) || calculatedBottomArea;
  const sideArea = Number(row.sideAreaOverride || 0) || calculatedSideArea;
  const grossConcrete = Number(row.grossConcreteOverride || 0) || (length * width * depth);
  const capDeduction = Number(row.columnCapDeduction || 0);
  return {
    bottomLengthM: length,
    netBottomLengthM: width ? bottomArea / width : 0,
    sideLengthM: sideLength,
    widthM: width,
    depthM: depth,
    slabThicknessM: slab,
    bottomAreaM2: bottomArea,
    sideAreaM2: sideArea,
    totalShutteringM2: bottomArea + sideArea,
    grossConcreteM3: grossConcrete,
    columnCapDeductionM3: capDeduction,
    netConcreteCapsExcludedM3: Math.max(grossConcrete - capDeduction, 0),
  };
}

function sumRows(rows) {
  const totals = {
    count: rows.length,
    bottomLengthM: 0,
    sideLengthM: 0,
    netBottomLengthM: 0,
    bottomAreaM2: 0,
    sideAreaM2: 0,
    totalShutteringM2: 0,
    grossConcreteM3: 0,
    columnCapDeductionM3: 0,
    netConcreteCapsExcludedM3: 0,
    lengthM: 0,
    breadthM: 0,
    thicknessM: 0,
    areaM2: 0,
    concreteM3: 0,
  };
  rows.forEach((row) => {
    if (["slab", "raft"].includes(row.__testItemType)) {
      const length = Number(row.length || 0);
      const breadth = Number(row.breadth || 0);
      const thickness = Number(row.height || 0);
      totals.lengthM += length;
      totals.breadthM += breadth;
      totals.thicknessM = thickness || totals.thicknessM;
      totals.areaM2 += Math.max(length * breadth - Number(row.openings || 0), 0);
      totals.concreteM3 += Math.max(length * breadth - Number(row.openings || 0), 0) * thickness;
    } else {
      const quantities = beamQuantities(row);
      Object.keys(totals).forEach((key) => {
        if (key !== "count") totals[key] += quantities[key] || 0;
      });
    }
  });
  const first = rows[0] || {};
  totals.widthM = Number(first.breadth || 0);
  totals.depthM = Number(first.height || 0);
  totals.slabThicknessM = Number(first.slabThickness || 0);
  totals.localSlabThicknessesM = [
    ...new Set(
      rows
        .flatMap((row) => row.evidence?.localSlabThicknessesM || row.evidence?.slabThicknessSegments?.map((item) => item.thicknessM) || [row.slabThickness])
        .map((value) => round(value, 3))
        .filter((value) => value > 0),
    ),
  ].sort((a, b) => b - a);
  totals.needsReview = rows.some((row) => row.needsReview);
  totals.dimensionBasis = [...new Set(rows.map((row) => row.evidence?.dimensionBasis || "").filter(Boolean))].join(", ");
  totals.hasCadOrGridDimension = rows.some((row) => {
    const basis = row.evidence?.dimensionBasis || "";
    return /cad|grid/i.test(basis) || Number.isFinite(row.evidence?.cadDimensionM);
  });
  return totals;
}

function selectRowsForMode(rows, test) {
  if (test.mode === "nearestLabel") {
    const target = test.label || {};
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return [];
    const nearest = rows
      .map((row) => ({
        row,
        distance: Math.hypot(
          Number(row.evidence?.labelX ?? row.evidence?.panelMarkX ?? 0) - target.x,
          Number(row.evidence?.labelY ?? row.evidence?.panelMarkY ?? 0) - target.y,
        ),
      }))
      .sort((a, b) => a.distance - b.distance)[0];
    const tolerance = Number(test.labelToleranceMm || 1000);
    return nearest && nearest.distance <= tolerance ? [nearest.row] : [];
  }
  if (test.mode === "occurrence") {
    const index = Math.max(Number(test.occurrence || 1) - 1, 0);
    return rows[index] ? [rows[index]] : [];
  }
  return rows;
}

function toleranceFor(key, config) {
  if (/M3$/.test(key)) return config.defaultTolerance.volumeM3;
  if (/M2$/.test(key)) return config.defaultTolerance.areaM2;
  if (/LengthM$|lengthM|breadthM|widthM|depthM|ThicknessM|thicknessM/.test(key)) return config.defaultTolerance.lengthM;
  return 0.001;
}

function compareExact(key, actual, expected, config, failures) {
  const tolerance = toleranceFor(key, config);
  if (Math.abs(Number(actual || 0) - Number(expected)) > tolerance) {
    failures.push(`${key}: expected ${expected}, got ${round(actual)} (tolerance ${tolerance})`);
  }
}

async function isServerReady() {
  try {
    const response = await fetchWithTimeout(serverUrl, { method: "GET" }, 5000, "QSS Pro server readiness check timed out.");
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isServerReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureServer() {
  if (await isServerReady()) return null;
  const child = spawn(nodePath, [path.join(root, "server.js")], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!(await waitForServer())) {
    child.kill();
    throw new Error(`QSS Pro server did not start at ${serverUrl}`);
  }
  return child;
}

async function extractData(test) {
  const drawingPath = path.resolve(root, test.drawing);
  const itemType = test.itemType || "beam";
  const cacheKey = JSON.stringify({
    drawingPath,
    itemType,
    role: test.role || "golden-test",
    gridPanels: test.gridPanels || [],
  });
  let data = extractionCache.get(cacheKey);
  if (!data) {
    const body = {
      itemType,
      files: [
        {
          name: path.basename(drawingPath),
          role: test.role || "golden-test",
          dataBase64: fs.readFileSync(drawingPath).toString("base64"),
        },
      ],
      gridPanels: test.gridPanels || [],
    };
    const response = await fetchWithTimeout(
      `${serverUrl}/api/extract-framing-quantities`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      requestTimeoutMs,
      `Golden extraction timed out after ${Math.round(requestTimeoutMs / 1000)} seconds for ${test.id}.`,
    );
    data = await response.json();
    if (!data.ok) throw new Error(data.error || "Extraction failed");
    data.rows = data.rows.map((row) => ({ ...row, __testItemType: itemType }));
    extractionCache.set(cacheKey, data);
  }
  return data;
}

function selectTestRows(allRows, test) {
  const member = String(test.member || "").replace(/\s+/g, "").toUpperCase();
  const rows = allRows.filter((row) => String(row.name || "").replace(/\s+/g, "").toUpperCase() === member);
  return selectRowsForMode(rows, test);
}

async function extractRows(test) {
  const data = await extractData(test);
  return selectTestRows(data.rows || [], test);
}

function auditFailuresForTest(test, data) {
  if (test.allowRuleAuditFailure) return [];
  const audit = data.summary?.ruleAudit;
  if (!audit) return ["rule audit: missing from extraction response"];
  const failures = [];
  if (audit.failedRules?.length) {
    failures.push(`rule audit: ${audit.failedRules.length} failed rule(s): ${audit.failedRules.map((rule) => rule.title).join(" | ")}`);
  }
  if (test.expected?.mustPassRuleAudit && audit.warningRules?.length) {
    failures.push(`rule audit: ${audit.warningRules.length} warning rule(s): ${audit.warningRules.map((rule) => rule.title).join(" | ")}`);
  }
  return failures;
}

async function runTest(test, config) {
  const data = await extractData(test);
  const rows = selectTestRows(data.rows || [], test);
  const actual = sumRows(rows);
  const expected = test.expected || {};
  const failures = auditFailuresForTest(test, data);

  Object.entries(expected).forEach(([key, value]) => {
    if (value === null || value === undefined || key === "notes") return;
    if (key === "mustHaveCadOrGridDimension") {
      if (value && !actual.hasCadOrGridDimension) failures.push(`dimension evidence: expected CAD/grid dimension, got ${actual.dimensionBasis || "none"}`);
      return;
    }
    if (key === "mustNotNeedReview") {
      if (value && actual.needsReview) failures.push("review status: expected no review flag, got needsReview=true");
      return;
    }
    if (key === "minOpeningAreaM2") {
      const openingArea = rows.reduce((sum, row) => sum + Number(row.openings || 0), 0);
      if (openingArea < Number(value)) failures.push(`opening area: expected at least ${value}, got ${round(openingArea)}`);
      return;
    }
    if (key === "localSlabThicknessesM") {
      const actualValues = actual.localSlabThicknessesM || [];
      const missing = value.filter((expectedThickness) => !actualValues.some((actualThickness) => Math.abs(actualThickness - expectedThickness) <= config.defaultTolerance.lengthM));
      if (missing.length) {
        failures.push(`local slab thickness: expected ${value.join(", ")} m, got ${actualValues.length ? actualValues.join(", ") : "none"} m`);
      }
      return;
    }
    if (key.startsWith("min")) {
      const actualKey = key.charAt(3).toLowerCase() + key.slice(4);
      if (Number(actual[actualKey] || 0) < Number(value)) failures.push(`${actualKey}: expected at least ${value}, got ${round(actual[actualKey])}`);
      return;
    }
    if (typeof value === "number") compareExact(key, actual[key], value, config, failures);
  });

  return { test, actual, failures };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const child = await ensureServer();
  const results = [];
  try {
    for (const test of config.tests) {
      results.push(await runTest(test, config));
    }
  } finally {
    if (child) child.kill();
  }

  let failed = 0;
  results.forEach(({ test, actual, failures }) => {
    const ok = failures.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${test.id}`);
    if (["slab", "raft"].includes(test.itemType)) {
      console.log(`  member=${test.member} count=${actual.count} length=${round(actual.lengthM)} breadth=${round(actual.breadthM)} area=${round(actual.areaM2)} concrete=${round(actual.concreteM3)} thickness=${round(actual.thicknessM)}`);
    } else {
      console.log(`  member=${test.member} count=${actual.count} bottom=${round(actual.bottomLengthM)} side=${round(actual.sideLengthM)} shuttering=${round(actual.totalShutteringM2)} concrete=${round(actual.grossConcreteM3)} slab=${round(actual.slabThicknessM)} basis=${actual.dimensionBasis || "none"}`);
    }
    failures.forEach((failure) => console.log(`  - ${failure}`));
  });

  console.log(`\nGolden tests: ${results.length - failed} passed, ${failed} failed, ${results.length} total.`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(`Golden test runner failed: ${error.message}`);
  process.exit(1);
});
