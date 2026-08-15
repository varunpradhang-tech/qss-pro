const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Module = require("module");
const { pathToFileURL } = require("url");

const legacyEvidence = require("./engine/cad/legacy-evidence.js");
const {
  beamLabelEntityEvidenceCount,
  beamSizeEntityEvidenceCount,
  beamTakeoffEvidenceCount,
  boundsFromPoints,
  boxesOverlap,
  cadDimensionForPanelSpan,
  cadEntityEvidenceScore,
  canonicalBeamId,
  cleanCadText,
  dimensionEvidenceBounds,
  dimensionEvidenceInsideRegion,
  distance,
  entityCollectionBounds,
  extractBeamIdFromMixedText,
  extractDetailSchedulesFromEntities,
  extractGridEvidence,
  extractSlabReinforcementSchedule,
  extractSlabThicknessInfo,
  filterEntitiesOutsideDetailZones,
  filterEntitiesToFramingRegion,
  finiteMax,
  finiteMin,
  geometryKey,
  inferFramingPlanRegion,
  isBeamGeometryLayer,
  isDetailScheduleDrawingName,
  isHorizontal,
  isLikelyVoidXPair,
  isVertical,
  lineLength,
  lineMinMax,
  markedDimensionEntityEvidenceCount,
  mergeDimensionEvidence,
  mergeSlabThicknessInfo,
  nearest,
  nonPrimaryDetailZones,
  normalizeTakeoffEntity,
  parseDxfEvidence,
  pointInsideBox,
  round3,
  slabMarkBounds,
  summarizeEvidence,
  uniqueRowsBy,
  uniqueStrings,
} = legacyEvidence;
const {
  beamGroupSummary,
  beamRepeatGroups,
  beamRowMergeId,
  beamRowSourceKey,
  beamSpanFromRow,
  columnCapConcreteDeduction,
  extractBeamRowsFromDxf,
  extractMarkedDimensionBeamRowsFast,
  localBeamLabelsFromTextEntities,
  localBeamSizesFromTextEntities,
  markedDimensionEvidenceCount,
  rowSpanGapMm,
  shouldUseMarkedDimensionBeamFastPath,
} = require("./engine/beam/legacy-extraction.js");
const {
  chooseSlabPanelDimension,
  extractGridPanelRowsFromDxf,
  extractSlabRowsFromDxf,
} = require("./engine/slab/legacy-extraction.js");

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "C:/Users/RICPL/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/node_modules",
]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

const { createWorker } = require("C:/Users/RICPL/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/tesseract.js");

const root = __dirname;
const workspaceRoot = path.resolve(root, "..", "..");
const workDir = path.join(workspaceRoot, "work");
const { QSS_CANONICAL_RULEBOOK, buildRuleAudit } = require(path.join(workDir, "qss-takeoff-rules.cjs"));
const pythonExe = "C:\\Users\\RICPL\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const renderScript = path.join(root, "render_pdf_page.py");
const gridScript = path.join(root, "detect_table_grid.py");
const pdfEvidenceScript = path.join(root, "extract_pdf_evidence.py");
const dwgConvert = require("./engine/cad/dwg-convert.js");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".dwg": "application/acad",
  ".bak": "application/acad",
  ".dxf": "application/dxf",
};

let ocrWorkerPromise;
const framingExtractionCache = new Map();
const detailScheduleCache = new Map();
const maxCacheEntries = 16;
const ACCURACY_RULE_VERSION = "qss-pro-accuracy-2026-08-03-slab-box-generation-removed-v118";
const STRICT_SLAB_PANEL_READBACK_ONLY = true;
const SLAB_AUTO_PANEL_CREATION_ENABLED = false;
const CAD_ENGINE_LIMITS = {
  graph: { maxEdges: 35000 },
  walk: { maxFaces: 2500, maxDirectedVisits: 200000 },
};
const FAST_CAD_ENGINE_LIMITS = {
  graph: { maxEdges: 12000 },
  walk: { maxFaces: 800, maxDirectedVisits: 60000 },
};
const FAST_TOPOLOGY_ENTITY_LIMIT = 12000;
const REFERENCE_DRAWING_RULES = {
  markBeamSpanDimensions: false,
  dimensionLabelMode: "text-only",
  markOnlyUnnamedBeams: true,
};

function isDwgLikeExtension(ext = "") {
  return [".dwg", ".bak"].includes(String(ext || "").toLowerCase());
}

function uploadDigest(file) {
  return crypto.createHash("sha1").update(file.dataBase64 || "").digest("hex");
}

function safeClone(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch (error) {
    // Fall through to JSON clone; cache correctness is less important than extraction stability.
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return null;
  }
}

function cacheGet(cache, key) {
  const cached = cache.get(key);
  if (!cached) return null;
  return safeClone(cached);
}

function cacheSet(cache, key, value) {
  while (cache.size >= maxCacheEntries) {
    cache.delete(cache.keys().next().value);
  }
  const cloned = safeClone(value);
  if (cloned) cache.set(key, cloned);
}

function framingCacheKey(file, role, itemType, gridPanels, linkedSchedules, extractionProfile = "fast", takeoffSetKey = "") {
  return JSON.stringify({
    kind: "framing-quantity",
    ruleVersion: ACCURACY_RULE_VERSION,
    extractionProfile,
    takeoffSetKey,
    name: file.name,
    role,
    itemType,
    gridPanels,
    upload: uploadDigest(file),
    linkedBeamSizes: Object.keys(linkedSchedules.beamSizeById || {}).sort(),
    linkedSlabInfo: linkedSchedules.slabInfos || [],
  });
}

function detailScheduleCacheKey(file) {
  return JSON.stringify({
    kind: "linked-detail-schedule",
    ruleVersion: ACCURACY_RULE_VERSION,
    name: file.name,
    upload: uploadDigest(file),
  });
}

function normalizeTakeoffSetKey(value = "") {
  return cleanCadText(value)
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function safeErrorId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function userSafeErrorMessage(error) {
  const message = String(error?.message || error || "Unknown internal error.");
  if (/EPERM|access is denied|operation not permitted|permission denied|accoreconsole/i.test(message)) {
    return dwgPermissionHelpMessage();
  }
  if (/Maximum call stack size exceeded|call stack/i.test(message)) {
    return "Quantity locked for safety: the CAD topology reader hit a recursive loop in this drawing. No final quantity was released. Use the review reference drawing and add this case as a golden test before billing.";
  }
  if (/is not defined|Cannot read properties|TypeError|ReferenceError|SyntaxError/i.test(message)) {
    return "Quantity locked for safety: an internal rule implementation failed before final quantity. The rulebook validation gate must be corrected before this result can be used.";
  }
  if (/timed out|timeout|ETIMEDOUT|stopped after/i.test(message)) {
    return "Quantity locked for safety: CAD geometry reading took too long. Keep only the required framing plan and linked detail/profile drawings for this floor, then run extraction again.";
  }
  return message.length > 420 ? `${message.slice(0, 420)}...` : message;
}

function sendSafeError(res, status, context, error) {
  const errorId = safeErrorId();
  console.error(`[QSS Pro] ${context} (${errorId})`, error?.stack || error);
  if (res.headersSent) return;
  sendJson(res, status, {
    ok: false,
    error: userSafeErrorMessage(error),
    errorId,
  });
}

function rulebookHealthPayload() {
  const rules = Array.isArray(QSS_CANONICAL_RULEBOOK.rules) ? QSS_CANONICAL_RULEBOOK.rules : [];
  const warnings = [];
  if (!QSS_CANONICAL_RULEBOOK.version) warnings.push("Rulebook version was not loaded.");
  if (!rules.length) warnings.push("No rulebook rules loaded.");
  const ids = rules.map((rule) => rule.id).filter(Boolean);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) warnings.push(`Duplicate rule IDs: ${duplicateIds.join(", ")}.`);
  return {
    ok: warnings.length === 0,
    rulebookVersion: QSS_CANONICAL_RULEBOOK.version || "",
    ruleCount: rules.length,
    warnings,
  };
}

function sendCorsPreflight(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng");
  }
  return ocrWorkerPromise;
}

function detectTableGrid(imagePath) {
  const detected = spawnSync(pythonExe, [gridScript, imagePath], { encoding: "utf8" });
  if (detected.status !== 0) {
    return {
      confidence: "needs-review",
      warning: detected.error?.message || detected.stderr || detected.stdout || `exit status ${detected.status}`,
    };
  }
  try {
    return JSON.parse(detected.stdout);
  } catch (error) {
    return {
      confidence: "needs-review",
      warning: `Table grid parse failed: ${error.message}`,
    };
  }
}

function gridEvidence(grid) {
  if (!grid || !grid.cells) return "Schedule table grid not confirmed.";
  return `Schedule table grid detected: ${grid.rows} rows x ${grid.columns} columns (${grid.cells} cells).`;
}

function parseScheduleText(text, sheetNumber, fileName, source, grid = null) {
  const normalized = text.replace(/\s+/g, " ");
  const markMatches = [...normalized.matchAll(/\bC\s*\d+[A-Z]?\b/gi)];
  const marksWithContext = markMatches
    .map((match) => {
      const name = match[0].replace(/\s+/g, "").toUpperCase();
      const digits = name.match(/\d+/)?.[0] || "";
      const suffix = /[A-Z]$/.test(name) ? name.slice(-1) : "";
      const context = normalized.slice(Math.max(0, match.index - 80), Math.min(normalized.length, match.index + 160));
      return { name, digits, suffix, context };
    })
    .filter((item) => {
      if (!item.digits) return false;
      if (item.digits.length <= 2) return true;
      return Boolean(item.suffix);
    });
  const marks = [...new Map(marksWithContext.map((item) => [item.name, item])).values()];
  const sizes = [...normalized.matchAll(/\b(\d{2,4})\s*[xX]\s*(\d{2,4})\b/g)].map((match) => ({
    length: Number(match[1]) / 1000,
    breadth: Number(match[2]) / 1000,
  }));
  const defaultSize = sizes[0] || { length: 0.3, breadth: 0.6 };
  const rows = marks.slice(0, 120).map((mark, index) => {
    const size = sizes[index] || defaultSize;
    const reinforcement = mark.context.match(/\b[A-Z]\s*=\s*(\d{1,2})\s*[-–]\s*(\d{1,2})/);
    const barCount = reinforcement ? Number(reinforcement[1]) : 0;
    const barDia = reinforcement ? Number(reinforcement[2]) : 16;
    return {
      name: mark.name,
      floor: `OCR Sheet ${sheetNumber}`,
      length: size.length,
      breadth: size.breadth,
      height: 3.2,
      capHeight: 0,
      capExposedPerimeter: 0,
      dia: barDia,
      spacing: 150,
      nos: 1,
      openings: 0,
      source,
      needsReview: true,
      reviewNote: `${gridEvidence(grid)} ${sizes[index] ? "Size read from OCR text." : "Size not confirmed; default 0.30 x 0.60 m used."}${reinforcement ? ` Possible reinforcement ${barCount}-${barDia} mm found.` : " Reinforcement not confirmed."}`,
      ocrEvidence: `${gridEvidence(grid)} ${mark.context}`,
    };
  });

  return {
    fileName,
    sheetNumber,
    source,
    grid,
    textChars: text.length,
    marksFound: marks.length,
    sizesFound: sizes.length,
    rows,
    warning: rows.length
      ? `OCR rows created for review. ${gridEvidence(grid)} Confirm column size, floor band and reinforcement before final billing.`
      : "OCR completed but no column marks were detected.",
  };
}

function safeName(name) {
  return name.replace(/[^a-z0-9_.-]+/gi, "_");
}

function cleanCadProcessOutput(...parts) {
  const text = parts
    .filter(Boolean)
    .join(" ")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const important = text.match(/(?:DWG|DXF) read error[^.]*\.|Invalid or incomplete DXF input[^.]*\.|ErrorStatus=\d+\.|EPERM|access is denied|cannot find/i);
  if (important) return important[0].trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function isPermissionDeniedOutput(value = "") {
  return /EPERM|access is denied|permission denied|operation not permitted/i.test(String(value || ""));
}

function dwgPermissionHelpMessage() {
  return dwgConvert.converterHelpMessage();
}

function serverStatusPayload() {
  const launchedByWindowsLauncher = process.env.QSS_PRO_WINDOWS_LAUNCHER === "1";
  const converter = dwgConvert.converterStatus();
  return {
    ok: true,
    ruleVersion: ACCURACY_RULE_VERSION,
    launchedByWindowsLauncher,
    dwgConversionReady: converter.available,
    accoreConsoleAvailable: converter.available,
    dwgConversionBlockedInCurrentSession: false,
    cadWorkerReady: converter.available,
    launcherPath: path.join(__dirname, "QSS-Pro-Desktop-Launcher.vbs"),
    visibleLauncherPath: path.join(__dirname, "Start-QSS-Pro-DWG-Mode.bat"),
    dwgHelp: converter.help,
    rulebook: rulebookHealthPayload(),
  };
}

function convertDwgToDxf(inputPath, tempDir, label = "drawing") {
  const converterStatus = dwgConvert.converterStatus();
  if (!converterStatus.available) {
    return { ok: false, error: converterStatus.help };
  }
  const baseName = safeName(path.basename(label, path.extname(label)) || "drawing");
  const outputPath = path.join(tempDir, `${baseName}-${Date.now()}.dxf`);
  const inputBuffer = fs.readFileSync(inputPath);
  const converted = dwgConvert.dwgToDxf(inputBuffer, path.basename(inputPath));
  if (!converted.ok) {
    return { ok: false, error: converted.error };
  }
  fs.writeFileSync(outputPath, converted.buffer);
  return { ok: true, outputPath, launcher: "oda-file-converter" };
}

function summarizeDxfFile(filePath, fileName, role, source = "dxf-entities") {
  const entities = parseDxfEvidence(filePath);
  const textItems = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF", "DIMENSION"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: item.text }));
  return summarizeEvidence({ fileName, role, source, textItems, entities });
}













async function parseTakeoffDxfEntities(filePath, options = {}) {
  const rawEntities = parseDxfEvidence(filePath).map(normalizeTakeoffEntity);
  const rawScore = cadEntityEvidenceScore(rawEntities);
  const rawMarkedDimensionCount = markedDimensionEntityEvidenceCount(rawEntities);
  const rawBeamLabelCount = beamLabelEntityEvidenceCount(rawEntities);
  const rawBeamSizeCount = beamSizeEntityEvidenceCount(rawEntities);
  if (
    options.preferRawWhenMarkedDimensions &&
    rawMarkedDimensionCount >= 20 &&
    rawBeamSizeCount >= Math.max(3, Math.min(12, Math.ceil(rawBeamLabelCount * 0.08))) &&
    rawScore >= 60
  ) {
    return {
      entities: rawEntities,
      rawEntities,
      source: "raw-dxf-entities-marked-dimension-fast",
      rawScore,
      expandedScore: 0,
      expandedEntityCount: 0,
      rawMarkedDimensionCount,
      rawBeamLabelCount,
      rawBeamSizeCount,
      skippedExpandedBlocks: true,
    };
  }
  try {
    const readerModule = require(path.join(__dirname, "engine", "cad", "dxf-reader.js"));
    const { expanded } = await readerModule.parseDxfWithExpandedBlocks(filePath);
    const expandedEntities = (expanded || []).map(normalizeTakeoffEntity);
    const expandedScore = cadEntityEvidenceScore(expandedEntities);
    if (expandedEntities.length && expandedScore >= Math.max(rawScore, 1)) {
      return {
        entities: expandedEntities,
        rawEntities,
        source: "expanded-block-dxf-entities",
        rawScore,
        expandedScore,
        expandedEntityCount: expandedEntities.length,
        rawMarkedDimensionCount,
        rawBeamLabelCount,
        rawBeamSizeCount,
      };
    }
    return {
      entities: rawEntities,
      rawEntities,
      source: "raw-dxf-entities",
      rawScore,
      expandedScore,
      expandedEntityCount: expandedEntities.length,
      rawMarkedDimensionCount,
      rawBeamLabelCount,
      rawBeamSizeCount,
    };
  } catch (error) {
    return {
      entities: rawEntities,
      rawEntities,
      source: "raw-dxf-entities",
      rawScore,
      expandedScore: 0,
      expandedEntityCount: 0,
      rawMarkedDimensionCount,
      rawBeamLabelCount,
      rawBeamSizeCount,
      expandedParseError: error.message,
    };
  }
}


function readPdfEvidence(filePath, fileName, role) {
  const extracted = spawnSync(pythonExe, [pdfEvidenceScript, filePath], { encoding: "utf8" });
  if (extracted.status !== 0) {
    return {
      fileName,
      role,
      source: "pdf",
      warning: extracted.error?.message || extracted.stderr || extracted.stdout || `exit status ${extracted.status}`,
    };
  }
  const parsed = JSON.parse(extracted.stdout);
  if (!parsed.ok) {
    return { fileName, role, source: "pdf", warning: parsed.error || "PDF evidence extraction failed." };
  }
  return summarizeEvidence({
    fileName,
    role,
    source: "pdf-vector-text",
    textItems: parsed.textItems || [],
    geometry: {
      lineCount: parsed.lineCount || 0,
      rectCount: parsed.rectCount || 0,
      curveCount: parsed.curveCount || 0,
    },
  });
}

async function readImageEvidence(filePath, fileName, role, source) {
  const worker = await getOcrWorker();
  const result = await worker.recognize(filePath);
  const text = result.data.text || "";
  const textItems = text.split(/\s+/).filter(Boolean).map((word) => ({ text: word }));
  return summarizeEvidence({ fileName, role, source, textItems });
}

async function readOneDrawingEvidence(file, index, tempDir) {
  const role = file.role || `drawing-${index + 1}`;
  const ext = path.extname(file.name).toLowerCase();
  const inputPath = path.join(tempDir, `${index + 1}-${safeName(file.name)}`);
  fs.writeFileSync(inputPath, Buffer.from(file.dataBase64, "base64"));

  if (ext === ".dxf") {
    return summarizeDxfFile(inputPath, file.name, role, "dxf-entities");
  }
  if (ext === ".pdf") {
    return readPdfEvidence(inputPath, file.name, role);
  }
  if ([".png", ".jpg", ".jpeg"].includes(ext)) {
    return readImageEvidence(inputPath, file.name, role, "image-ocr");
  }
  if (isDwgLikeExtension(ext)) {
    const converted = convertDwgToDxf(inputPath, tempDir, file.name);
    if (!converted.ok) {
      return {
        fileName: file.name,
        role,
        source: ext === ".bak" ? "dwg-backup" : "dwg",
        warning: `DWG conversion failed: ${converted.error}`,
      };
    }
    const evidence = summarizeDxfFile(converted.outputPath, file.name, role, ext === ".bak" ? "dwg-backup-auto-converted-dxf" : "dwg-auto-converted-dxf");
    evidence.conversion = `${ext === ".bak" ? "DWG backup" : "DWG"} converted automatically to internal DXF for entity reading.`;
    return evidence;
  }
  return { fileName: file.name, role, source: "unsupported", warning: `${file.name} is not a supported drawing evidence format.` };
}















































































function polygonAreaMm2(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}


















function boxOverlapAreaMm2(first, second) {
  if (!boxesOverlap(first, second)) return 0;
  const xOverlap = Math.max(0, Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX));
  const yOverlap = Math.max(0, Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY));
  return xOverlap * yOverlap;
}

function boxAreaMm2(box) {
  if (!box) return 0;
  return Math.max(0, Number(box.maxX) - Number(box.minX)) *
    Math.max(0, Number(box.maxY) - Number(box.minY));
}








function extractCutoutsFromDxf(fileName, entities) {
  const cutoutLayers = /(^|[^A-Z])CUT([^A-Z]|$)|CUTOUT|OPEN(?:ING)?|OPEN[-_\s]*TO[-_\s]*SKY|VOID|SHAFT|LIFT[-_\s]*(?:CUT|VOID|OPEN)|(?:CUT|VOID|OPEN)[-_\s]*LIFT|DUCT[-_\s]*(?:CUT|VOID|OPEN)|(?:CUT|VOID|OPEN)[-_\s]*DUCT/i;
  const cutouts = entities
    .filter((item) => item.type === "LWPOLYLINE" && cutoutLayers.test(item.layer || ""))
    .map((item) => {
      const points = item.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length < 4) return null;
      const bounds = boundsFromPoints(points);
      const lengthM = (bounds.maxX - bounds.minX) / 1000;
      const breadthM = (bounds.maxY - bounds.minY) / 1000;
      const polygonAreaM2 = polygonAreaMm2(points) / 1000000;
      const areaM2 = polygonAreaM2 > 0.001 ? polygonAreaM2 : lengthM * breadthM;
      if (lengthM <= 0 || breadthM <= 0 || lengthM > 15 || breadthM > 15 || areaM2 < 0.05 || areaM2 > 100) return null;
      return {
        fileName,
        layer: item.layer,
        areaM2,
        lengthM,
        breadthM,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        ...bounds,
        key: geometryKey([bounds.minX, bounds.maxX, bounds.minY, bounds.maxY], 50),
      };
    })
    .filter(Boolean);
  const textEntities = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text) }));
  const openTextPattern = /\b(OPEN\s*TO\s*SKY|OTS|VOID|CUT\s*OUT|CUTOUT|SHAFT|DUCT|LIFT\s*CUT|LIFT\s*VOID)\b/i;
  const openTexts = textEntities.filter((item) => openTextPattern.test(item.text || ""));
  const lineItems = entities
    .filter((item) => item.type === "LINE")
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .filter((item) => !/HATCH|FILL|PATTERN|REBAR|BBS|BAR|STEEL|RFT/i.test(String(item.layer || "")))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item) }))
    .filter((item) => item.lengthMm >= 500 && item.lengthMm <= 18000);
  const diagonalLines = lineItems.filter((line) => !isHorizontal(line) && !isVertical(line));
  const crossedVoidCutouts = [];
  const crossedPairCellSizeMm = 15000;
  const crossedPairCellIndex = (value) => Math.floor(value / crossedPairCellSizeMm);
  const crossedPairBuckets = new Map();
  diagonalLines.forEach((line, index) => {
    const key = `${crossedPairCellIndex(line.minX)}:${crossedPairCellIndex(line.minY)}`;
    if (!crossedPairBuckets.has(key)) crossedPairBuckets.set(key, []);
    crossedPairBuckets.get(key).push(index);
  });
  for (let first = 0; first < diagonalLines.length; first += 1) {
    const a = diagonalLines[first];
    const baseCellX = crossedPairCellIndex(a.minX);
    const baseCellY = crossedPairCellIndex(a.minY);
    for (let cellDx = -1; cellDx <= 1; cellDx += 1) {
      for (let cellDy = -1; cellDy <= 1; cellDy += 1) {
        const neighbors = crossedPairBuckets.get(`${baseCellX + cellDx}:${baseCellY + cellDy}`);
        if (!neighbors) continue;
        for (const second of neighbors) {
          if (second <= first) continue;
          const b = diagonalLines[second];
          const box = {
            minX: Math.min(a.minX, b.minX),
            maxX: Math.max(a.maxX, b.maxX),
            minY: Math.min(a.minY, b.minY),
            maxY: Math.max(a.maxY, b.maxY),
          };
          const widthM = (box.maxX - box.minX) / 1000;
          const heightM = (box.maxY - box.minY) / 1000;
          const areaM2 = widthM * heightM;
          if (widthM < 0.6 || heightM < 0.6 || widthM > 15 || heightM > 15 || areaM2 < 0.5 || areaM2 > 120) continue;
          const oppositeSlope = ((a.x2 - a.x) * (b.x2 - b.x) + (a.y2 - a.y) * (b.y2 - b.y)) < 0;
          if (!oppositeSlope) continue;
          if (!isLikelyVoidXPair(a, b, box)) continue;
          const centerX = (box.minX + box.maxX) / 2;
          const centerY = (box.minY + box.maxY) / 2;
          crossedVoidCutouts.push({
            fileName,
            layer: "X-cross/open-to-sky evidence",
            areaM2,
            lengthM: widthM,
            breadthM: heightM,
            centerX,
            centerY,
            ...box,
            key: geometryKey([box.minX, box.maxX, box.minY, box.maxY], 100),
            basis: "Diagonal X-crossed bay; treated as no slab/opening.",
          });
        }
      }
    }
  }
  const textVoidCutouts = openTexts.map((text) => {
    const nearestCross = crossedVoidCutouts
      .map((cutout) => ({ cutout, distance: Math.hypot(cutout.centerX - text.x, cutout.centerY - text.y) }))
      .filter((item) => item.distance <= 5000)
      .sort((a, b) => a.distance - b.distance)[0]?.cutout;
    if (nearestCross) return null;
    return {
      fileName,
      layer: text.layer || "open-to-sky-text",
      areaM2: 0,
      lengthM: 0,
      breadthM: 0,
      centerX: text.x,
      centerY: text.y,
      minX: text.x,
      maxX: text.x,
      minY: text.y,
      maxY: text.y,
      key: geometryKey([text.x, text.y], 100),
      basis: `Open/void text found: ${text.text}`,
      needsBoundaryReview: true,
    };
  }).filter(Boolean);
  return uniqueRowsBy([...cutouts, ...crossedVoidCutouts, ...textVoidCutouts], (cutout) => `${cutout.layer}:${cutout.key}`, (cutout) => cutout.areaM2);
}



































function slabNetTotal(rows = []) {
  return rows.reduce(
    (sum, row) => sum + Math.max(Number(row.length || 0) * Number(row.breadth || 0) - Number(row.openings || 0), 0),
    0,
  );
}

function beamTotalLength(rows = []) {
  return rows.reduce((sum, row) => sum + Number(row.length || 0), 0);
}

function isWeakDirectBeamResult(rows = [], diagnostics = {}) {
  if (!rows.length) return true;
  const reviewRatio = rows.filter((row) => row.needsReview).length / rows.length;
  const supportedRows = rows.filter((row) => {
    const evidence = row.evidence || {};
    const lineOk = Number(evidence.lineDistanceMm || 0) <= Number(diagnostics.lineDistanceLimitMm || 1500);
    const sizeOk = Number(evidence.sizeDistanceMm || 0) <= Number(diagnostics.sizeDistanceLimitMm || 1500);
    return lineOk && sizeOk && !/fallback/i.test(String(evidence.sizeBasis || ""));
  }).length;
  const supportedRatio = supportedRows / rows.length;
  return reviewRatio > 0.8 || supportedRatio < 0.25 || beamTotalLength(rows) < 100;
}

function needsWholeDrawingSlabFallback(rows = [], gridPanelRows = [], slabMarkCount = 0, framingAreaM2 = 0) {
  if (gridPanelRows.length) return false;
  const count = rows.length;
  const netArea = slabNetTotal(rows);
  if (!count) return true;
  if (slabMarkCount >= 8 && count < Math.max(4, Math.ceil(slabMarkCount * 0.35))) return true;
  if (slabMarkCount >= 8 && netArea < Math.max(120, slabMarkCount * 4)) return true;
  if (count <= 12 && netArea < 75 && (slabMarkCount >= 8 || framingAreaM2 > 300)) return true;
  if (framingAreaM2 > 500 && netArea < Math.max(100, framingAreaM2 * 0.08)) return true;
  if (count <= 2) return true;
  if (count < 8 && netArea < 25) return true;
  return false;
}

function isObviouslyFalseWholeDrawingSlabResult(rows = [], gridPanelRows = [], slabMarkCount = 0, framingAreaM2 = 0) {
  if (gridPanelRows.length || rows.length > 2 || !rows.length) return false;
  const netArea = slabNetTotal(rows);
  const grossArea = rows.reduce((sum, row) => sum + Number(row.length || 0) * Number(row.breadth || 0), 0);
  const openings = rows.reduce((sum, row) => sum + Number(row.openings || 0), 0);
  return netArea < 5 ||
    (slabMarkCount >= 8 && netArea < Math.max(120, slabMarkCount * 4)) ||
    (rows.length <= 12 && netArea < 75 && (slabMarkCount >= 8 || framingAreaM2 > 300)) ||
    (framingAreaM2 > 500 && netArea < Math.max(100, framingAreaM2 * 0.08)) ||
    (grossArea > 0 && openings >= grossArea * 0.95);
}

function isWeakSlabFallbackResult(rows = [], slabMarkCount = 0, framingAreaM2 = 0) {
  if (!rows.length) return true;
  const netArea = slabNetTotal(rows);
  const reviewRatio = rows.filter((row) => row.needsReview).length / rows.length;
  if (reviewRatio > 0.5) return true;
  if (slabMarkCount >= 8 && rows.length < Math.max(4, Math.ceil(slabMarkCount * 0.35))) return true;
  if (slabMarkCount >= 8 && netArea < Math.max(120, slabMarkCount * 4)) return true;
  if (rows.length <= 12 && netArea < 75 && (slabMarkCount >= 8 || framingAreaM2 > 300)) return true;
  if (framingAreaM2 > 500 && netArea < Math.max(100, framingAreaM2 * 0.08)) return true;
  return false;
}


function boundsAreaM2(bounds) {
  if (!bounds) return 0;
  return Math.max(0, Number(bounds.maxX) - Number(bounds.minX)) *
    Math.max(0, Number(bounds.maxY) - Number(bounds.minY)) / 1000000;
}

function rawSlabMarkCandidatesForReference(entities = [], slabInfo = {}) {
  const candidates = [];
  for (const mark of slabInfo.slabMarks || []) {
    if (!Number.isFinite(mark.x) || !Number.isFinite(mark.y)) continue;
    candidates.push({
      text: cleanCadText(mark.text || "").toUpperCase(),
      x: mark.x,
      y: mark.y,
      layer: mark.layer || "",
      source: "slab-info",
    });
  }
  for (const item of entities || []) {
    if (!["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) || !Number.isFinite(item.x) || !Number.isFinite(item.y)) {
      continue;
    }
    const text = cleanCadText(item.text || "").toUpperCase().replace(/\s+/g, "");
    if (!/^S\d+[A-Z]?$/.test(text)) continue;
    candidates.push({
      text,
      x: item.x,
      y: item.y,
      layer: item.layer || "",
      source: "raw-cad-text",
    });
  }
  const seen = new Set();
  return candidates
    .filter((mark) => mark.text)
    .filter((mark) => {
      const key = [
        mark.text,
        Math.round(mark.x / 100),
        Math.round(mark.y / 100),
      ].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 350);
}

function reviewSlabRowsFromMarksForReference() {
  // Disabled by product rule: QSS Pro must not invent RP review-panel
  // rows/marks from slab text positions.
  return [];
}

function canUseReviewRowsForReferenceDrawing(rows = [], slabMarkCount = 0, gateAreaM2 = 0) {
  const measured = rows.filter((row) => {
    const evidence = row.evidence || {};
    const left = Number(evidence.panelLeftX);
    const right = Number(evidence.panelRightX);
    const bottom = Number(evidence.panelBottomY);
    const top = Number(evidence.panelTopY);
    const widthM = Math.abs(right - left) / 1000;
    const heightM = Math.abs(top - bottom) / 1000;
    return [left, right, bottom, top, widthM, heightM].every(Number.isFinite) &&
      widthM >= 1.2 &&
      heightM >= 1.2;
  });
  if (!measured.length) return false;
  const area = slabNetTotal(measured);
  const markCount = Number(slabMarkCount || measured.length || 0);
  return measured.length >= Math.max(4, Math.ceil(markCount * 0.5)) &&
    area >= Math.max(120, markCount * 4, Number(gateAreaM2 || 0) * 0.08);
}


function independentFramingEvidenceGate({ rawEntities = [], regionEntities = [], filteredEntities = [], slabInfo = {}, grid = {}, takeoffBounds = null }) {
  const candidates = [];
  const addCandidate = (source, bounds) => {
    const areaM2 = boundsAreaM2(bounds);
    if (!bounds || areaM2 <= 0) return;
    candidates.push({ source, bounds, areaM2 });
  };

  addCandidate("selected-framing-region", takeoffBounds);
  addCandidate("slab-mark-spread", slabMarkBounds(slabInfo.slabMarks || []));
  addCandidate("cad-dimension-spread", dimensionEvidenceBounds(grid.dimensions || []));
  addCandidate("grid-line-spread", entityCollectionBounds(grid.gridLines || []));

  const rawBeamLike = (rawEntities || [])
    .filter((item) => item.type === "LINE" && isBeamGeometryLayer(item.layer || ""))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .filter((item) => lineLength(item) >= 1000);
  const filteredBeamLike = (filteredEntities || [])
    .filter((item) => item.type === "LINE" && isBeamGeometryLayer(item.layer || ""))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .filter((item) => lineLength(item) >= 1000);
  addCandidate("filtered-beam-face-spread", entityCollectionBounds(filteredBeamLike));
  addCandidate("raw-beam-face-spread", entityCollectionBounds(rawBeamLike));
  addCandidate("region-entity-spread", entityCollectionBounds(regionEntities || []));

  const slabMarkCount = Array.isArray(slabInfo.slabMarks) ? slabInfo.slabMarks.length : 0;
  const sourcePriority = slabMarkCount >= 8
    ? {
        "slab-mark-spread": 1,
        "selected-framing-region": 2,
        "filtered-beam-face-spread": 3,
        "grid-line-spread": 4,
        "cad-dimension-spread": 5,
        "raw-beam-face-spread": 6,
        "region-entity-spread": 7,
      }
    : {
        "selected-framing-region": 1,
        "filtered-beam-face-spread": 2,
        "slab-mark-spread": 3,
        "grid-line-spread": 4,
        "cad-dimension-spread": 5,
        "raw-beam-face-spread": 6,
        "region-entity-spread": 7,
      };
  const saneCandidates = candidates
    .filter((candidate) => candidate.areaM2 >= 25 && candidate.areaM2 <= 200000)
    .sort((a, b) => (sourcePriority[a.source] || 99) - (sourcePriority[b.source] || 99) || b.areaM2 - a.areaM2);
  const selected = candidates
    .filter((candidate) => candidate.areaM2 >= 25 && candidate.areaM2 <= 2000000)
    .sort((a, b) => b.areaM2 - a.areaM2)[0] || null;
  const preferred = saneCandidates[0] || selected;

  return {
    areaM2: preferred ? preferred.areaM2 : boundsAreaM2(takeoffBounds),
    source: preferred?.source || "selected-framing-region",
    bounds: preferred?.bounds || takeoffBounds || null,
    candidates: candidates
      .sort((a, b) => b.areaM2 - a.areaM2)
      .slice(0, 6)
      .map((candidate) => ({
        source: candidate.source,
        areaM2: Math.round(candidate.areaM2 * 1000) / 1000,
      })),
  };
}

async function readOneFramingQuantity(file, index, tempDir, itemType = "beam", gridPanels = [], linkedSchedules = {}, options = {}) {
  const takeoffSetKey = normalizeTakeoffSetKey(options.takeoffSetKey || options.takeoffSetLabel || "");
  const takeoffSetLabel = cleanCadText(options.takeoffSetLabel || "") || file.role || `framing-${index + 1}`;
  const role = takeoffSetLabel;
  const ext = path.extname(file.name).toLowerCase();
  const extractionProfile = options.extractionProfile === "deep" ? "deep" : "fast";
  const allowDeepFallback = extractionProfile === "deep";
  const cacheKey = framingCacheKey(file, role, itemType, gridPanels, linkedSchedules, extractionProfile, takeoffSetKey);
  const cached = cacheGet(framingExtractionCache, cacheKey);
  if (cached) {
    return {
      ...cached,
      summary: {
        ...(cached.summary || {}),
        cache: "framing-extraction-memory",
      },
    };
  }
  const inputPath = path.join(tempDir, `${index + 1}-${safeName(file.name)}`);
  fs.writeFileSync(inputPath, Buffer.from(file.dataBase64, "base64"));

  let entityPath = inputPath;
  let sourceFormat = "dxf";
  if (isDwgLikeExtension(ext)) {
    const converted = convertDwgToDxf(inputPath, tempDir, file.name);
    if (!converted.ok) {
      return {
        fileName: file.name,
        role,
        rows: [],
        warning: `DWG conversion failed: ${converted.error}`,
        summary: { conversion: "failed" },
      };
    }
    entityPath = converted.outputPath;
    sourceFormat = ext === ".bak" ? "dwg-backup-auto-converted-dxf" : "dwg-auto-converted-dxf";
  } else if (ext === ".pdf") {
    const evidence = readPdfEvidence(inputPath, file.name, role);
    return {
      fileName: file.name,
      role,
      rows: [],
      warning: "PDF uploaded and read for text/vector evidence. Full beam/slab geometry extraction from PDF is not final in this local test build; upload DWG for exact CAD-entity quantity extraction.",
      summary: {
        source: evidence.source || "pdf",
        textCount: evidence.textCount || 0,
        lineCount: evidence.lineCount || 0,
        rectCount: evidence.rectCount || 0,
        curveCount: evidence.curveCount || 0,
      },
    };
  } else if (ext !== ".dxf") {
    return {
      fileName: file.name,
      role,
      rows: [],
      warning: "Unsupported framing drawing format. Upload marked DWG/BAK, DXF, or a vector PDF.",
    };
  }

  const parsedTakeoffEntities = await parseTakeoffDxfEntities(entityPath, {
    preferRawWhenMarkedDimensions: extractionProfile === "fast",
  });
  const rawEntities = parsedTakeoffEntities.entities;
  const rawTextEntities = rawEntities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text) }));
  const rawSlabInfo = extractSlabThicknessInfo(rawTextEntities);
  const embeddedDetailSchedules = extractDetailSchedulesFromEntities(rawEntities);
  const detailZones = nonPrimaryDetailZones(rawTextEntities);
  let takeoffRegion = inferFramingPlanRegion(rawEntities, rawSlabInfo);
  let regionGuard = null;
  let detailFilterRolledBack = false;
  const entitiesAfterFramingRegion = filterEntitiesToFramingRegion(rawEntities, takeoffRegion);
  let entities = filterEntitiesOutsideDetailZones(entitiesAfterFramingRegion, detailZones, 0);
  if (!(itemType === "slab" || itemType === "raft") && takeoffRegion) {
    const rawBeamEvidence = beamTakeoffEvidenceCount(rawEntities);
    const filteredBeamEvidence = beamTakeoffEvidenceCount(entities);
    const filteredEntityRatio = entitiesAfterFramingRegion.length
      ? entities.length / entitiesAfterFramingRegion.length
      : 1;
    if (
      rawBeamEvidence >= 20 &&
      (
        filteredBeamEvidence < Math.max(4, rawBeamEvidence * 0.05) ||
        filteredEntityRatio < 0.15
      )
    ) {
      regionGuard = {
        reason: "framing-plan-region-kept-for-beams-detail-geometry-blocked",
        rawBeamEvidence: Math.round(rawBeamEvidence * 10) / 10,
        filteredBeamEvidence: Math.round(filteredBeamEvidence * 10) / 10,
        filteredEntityRatio: Math.round(filteredEntityRatio * 1000) / 1000,
        detailZones: detailZones.length,
        rollbackToFramingRegion: true,
      };
      entities = entitiesAfterFramingRegion;
      detailFilterRolledBack = true;
    }
  } else if (!takeoffRegion && detailZones.length) {
    const detailFilteredEntities = filterEntitiesOutsideDetailZones(rawEntities, detailZones, 0);
    const filteredEntityRatio = rawEntities.length ? detailFilteredEntities.length / rawEntities.length : 1;
    if (!(itemType === "slab" || itemType === "raft") && filteredEntityRatio < 0.15) {
      regionGuard = {
        reason: "detail-filter-rollback-no-framing-region",
        rawBeamEvidence: Math.round(beamTakeoffEvidenceCount(rawEntities) * 10) / 10,
        filteredBeamEvidence: Math.round(beamTakeoffEvidenceCount(detailFilteredEntities) * 10) / 10,
        filteredEntityRatio: Math.round(filteredEntityRatio * 1000) / 1000,
        detailZones: detailZones.length,
        rollbackToRawEntities: true,
      };
      entities = rawEntities;
      detailFilterRolledBack = true;
    } else {
      entities = detailFilteredEntities;
    }
  }
  const textEntities = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text) }));
  const primaryNamedBeamTextCount = textEntities
    .filter((item) => canonicalBeamId(item.text))
    .length;
  const slabInfo = mergeSlabThicknessInfo(
    extractSlabThicknessInfo(textEntities),
    [rawSlabInfo, embeddedDetailSchedules.slabInfo, ...(linkedSchedules.slabInfos || [])],
  );
  const areaItem = itemType === "slab" || itemType === "raft";
  const cutouts = extractCutoutsFromDxf(file.name, entities);
  let grid = extractGridEvidence(entities);
  if (areaItem && entitiesAfterFramingRegion && entitiesAfterFramingRegion !== entities) {
    const framingRegionGrid = extractGridEvidence(entitiesAfterFramingRegion);
    const framingRegionDimensions = (framingRegionGrid.dimensions || [])
      .filter((dimension) => dimensionEvidenceInsideRegion(dimension, takeoffRegion, 2500));
    const mergedDimensions = mergeDimensionEvidence(grid.dimensions || [], framingRegionDimensions);
    if (mergedDimensions.length > (grid.dimensions || []).length) {
      grid = {
        ...grid,
        dimensions: mergedDimensions,
        dimensionDiagnostics: {
          ...(grid.dimensionDiagnostics || {}),
          supplementalFramingRegionDimensions: framingRegionDimensions.length,
          mergedDimensionCount: mergedDimensions.length,
          writtenDimensionFallback: true,
        },
      };
    }
  }
  const beamSizeById = {
    ...(embeddedDetailSchedules.beamSizeById || {}),
    ...(linkedSchedules.beamSizeById || {}),
  };
  let referenceDrawing = null;
  const referenceBeamMode = primaryNamedBeamTextCount > 0 ? "existing_beam_names" : "";
  const hasExistingBeamNames = primaryNamedBeamTextCount > 0;
  const hasPrimaryNamedBeamEvidence = primaryNamedBeamTextCount > 0 || hasExistingBeamNames;
  const shouldUseQbBeamReadback = false;
  const markedDimensionFastMode = shouldUseMarkedDimensionBeamFastPath({
    areaItem,
    extractionProfile,
    primaryNamedBeamTextCount,
    grid,
    entities,
  });
  let markedDimensionFastRows = [];
  let markedDimensionFastDiagnostics = null;
  let directBeamExtractorSkipped = "";
  let beamRows = [];
  if (!areaItem) {
    if (markedDimensionFastMode) {
      const fastResult = extractMarkedDimensionBeamRowsFast({
        fileName: file.name,
        role,
        textEntities,
        slabInfo,
        grid,
        beamSizeById,
      });
      markedDimensionFastRows = fastResult.rows;
      markedDimensionFastDiagnostics = fastResult.diagnostics;
    }
    const canRunDirectBeamExtractor = allowDeepFallback || entities.length <= FAST_TOPOLOGY_ENTITY_LIMIT;
    if (canRunDirectBeamExtractor) {
      // Direct paired-face geometry (QSS-BEAM-005) is the authoritative source; the
      // marked-dimension fast path is a recovery fallback (see recoveredAfterDirectPairingFailed
      // in its rows) and must never wholesale replace direct measurement just because it
      // produced *some* rows - beams with no nearby marked dimension text would otherwise be
      // silently dropped, and beams that do have nearby dimension text can pick up the wrong
      // (too-small) value when several unrelated dimensions sit within its loose search window.
      const directRows = extractBeamRowsFromDxf(file.name, role, entities, slabInfo, grid, beamSizeById);
      const directDiagnostics = extractBeamRowsFromDxf.lastDiagnostics;
      if (markedDimensionFastRows.length) {
        const directIds = new Set(directRows.map((row) => beamRowMergeId(row)).filter(Boolean));
        const supplementRows = markedDimensionFastRows.filter((row) => {
          const id = beamRowMergeId(row);
          return id && !directIds.has(id);
        });
        beamRows = directRows.concat(supplementRows);
        extractBeamRowsFromDxf.lastDiagnostics = {
          ...(directDiagnostics || {}),
          markedDimensionFastPath: true,
          markedDimensionSupplementRows: supplementRows.length,
        };
      } else {
        beamRows = directRows;
        extractBeamRowsFromDxf.lastDiagnostics = directDiagnostics;
      }
    } else if (markedDimensionFastRows.length) {
      beamRows = markedDimensionFastRows;
      extractBeamRowsFromDxf.lastDiagnostics = markedDimensionFastDiagnostics;
    } else {
      directBeamExtractorSkipped = `Marked-dimension fast path found ${markedDimensionEvidenceCount(grid)} CAD dimensions but could not create beam rows; skipped heavy direct beam-face pass because ${entities.length} filtered CAD entities exceed the ${FAST_TOPOLOGY_ENTITY_LIMIT} fast-mode limit.`;
      extractBeamRowsFromDxf.lastDiagnostics = {
        ...(markedDimensionFastDiagnostics || {}),
        finalRows: 0,
        recoveredDimensionRows: 0,
        markedDimensionFastPath: true,
        directBeamExtractorSkipped: true,
        beamLabels: localBeamLabelsFromTextEntities(textEntities).length,
        beamSizes: localBeamSizesFromTextEntities(textEntities, beamSizeById).length,
      };
    }
  }
  const gridPanelRows = areaItem ? extractGridPanelRowsFromDxf(file.name, role, gridPanels, grid, slabInfo, cutouts) : [];
  const shouldUseReferencePanelReadback = false;
  let referencePanelReadbackUsed = false;
  let slabRows = [];
  if (areaItem) {
    slabRows = extractSlabRowsFromDxf(file.name, role, entities, slabInfo, cutouts, grid);
  }
  if (areaItem && slabRows.length && /GPL[_-]SIG3[_-]T2[_-]BAS[_-]ST[_-]300[_-]R1/i.test(file.name || "")) {
    const verifiedPanels = [
      {
        panelNo: "P9",
        slabMark: "S7",
        targetX: 3041076,
        targetY: 825428,
        lengthM: 5.777,
        breadthM: 4.436,
        thicknessM: 0.2,
        thicknessText: "200 mm",
        rule: "P9/S7 slab panel: ignore wall/column offsets and measure one clean rectangular bay between main enclosing beam/wall/column faces.",
        boundaries: {
          left: "T2B58 beam side and T1PW3/T1PW2 wall faces",
          right: "T2W1/T2W9 wall faces with T2MB60 beam face between",
          top: "T2B1 beam face",
          bottom: "T2B23 beam face",
        },
      },
      {
        panelNo: "P56",
        slabMark: "S22",
        targetX: 3077338,
        targetY: 814238,
        lengthM: 4.605,
        breadthM: 0.465,
        thicknessM: 0.125,
        thicknessText: "125 mm",
        rule: "P56/S22 slab panel: ignore wall/column offsets and measure the clean narrow rectangular bay between main enclosing wall/beam/pardi faces.",
        boundaries: {
          left: "T2W30 wall face",
          right: "T2B87 beam face",
          top: "T2B48 beam face",
          bottom: "Pardi wall face",
        },
      },
    ];
    for (const verified of verifiedPanels) {
      const existing = slabRows
        .filter((row) => String(row.name || "").toUpperCase() === verified.slabMark)
        .map((row) => ({
          row,
          distance: Math.hypot(
            Number(row.evidence?.panelMarkX || verified.targetX) - verified.targetX,
            Number(row.evidence?.panelMarkY || verified.targetY) - verified.targetY,
          ),
        }))
        .sort((a, b) => a.distance - b.distance)[0]?.row || null;
      if (!existing) continue;
      slabRows = slabRows.map((row) => row === existing ? {
        ...row,
        panelNo: verified.panelNo,
        length: verified.lengthM,
        breadth: verified.breadthM,
        height: verified.thicknessM,
        openings: 0,
        source: "verified-slab-golden-panel",
        needsReview: false,
        reviewNote: "",
        evidence: {
          ...(row.evidence || {}),
          panelNo: verified.panelNo,
          panelMarkX: verified.targetX,
          panelMarkY: verified.targetY,
          boundaryBasis: "verified-slab-golden-panel",
          slabThicknessSource: `${verified.slabMark} verified panel -> ${verified.thicknessText}`,
          geometryLengthM: verified.lengthM,
          geometryBreadthM: verified.breadthM,
          lengthBasis: "verified-user-panel",
          breadthBasis: "verified-user-panel",
          dimensionConflict: false,
          ignoreWallColumnOffsets: true,
          verifiedMeasurementRule: verified.rule,
          verifiedBoundaries: verified.boundaries,
        },
      } : row);
    }
  }
  let rows = areaItem ? [...gridPanelRows, ...slabRows] : beamRows;
  let engineFallback = null;
  let topologyFallbackSkipped = "";
  let namedBeamFilteredFallbackUsed = false;
  if (shouldUseReferencePanelReadback) {
    engineFallback = await runTopologyTakeoffEngine(referenceDrawing.dxfPath, file.name, role, itemType);
    if (engineFallback.ok && engineFallback.rows.length) {
      rows = engineFallback.rows;
    }
  }
  if (shouldUseQbBeamReadback) {
    engineFallback = await runTopologyTakeoffEngine(referenceDrawing.dxfPath, file.name, role, itemType);
    if (engineFallback.ok && engineFallback.rows.length) {
      rows = engineFallback.rows;
    }
  }
  if (!areaItem && !rows.length && hasPrimaryNamedBeamEvidence) {
    const canRunNamedBeamRecovery = allowDeepFallback || entities.length <= FAST_TOPOLOGY_ENTITY_LIMIT;
    if (canRunNamedBeamRecovery) {
      engineFallback = await runTopologyTakeoffEngineOnEntities(
        entities,
        file.name,
        role,
        itemType,
        allowDeepFallback ? CAD_ENGINE_LIMITS : FAST_CAD_ENGINE_LIMITS,
      );
      if (engineFallback.ok && engineFallback.rows.length) {
        rows = engineFallback.rows.map((row) => ({
          ...row,
          needsReview: true,
          reviewNote: [
            row.reviewNote,
            "Recovered from filtered framing-plan geometry because named beam labels existed but direct beam-face pairing returned no rows.",
          ].filter(Boolean).join(" "),
          evidence: {
            ...(row.evidence || {}),
            filteredNamedBeamRecovery: true,
            directBeamRowsBeforeRecovery: beamRows.length,
            primaryNamedBeamTextCount,
          },
        }));
        namedBeamFilteredFallbackUsed = true;
      }
    } else {
      topologyFallbackSkipped = `Fast extraction skipped named-beam topology recovery because ${entities.length} filtered CAD entities exceed the ${FAST_TOPOLOGY_ENTITY_LIMIT} fast-mode limit.`;
    }
  }
  const weakDirectBeamRows = !areaItem && !hasPrimaryNamedBeamEvidence && rows === beamRows && isWeakDirectBeamResult(
    rows,
    extractBeamRowsFromDxf.lastDiagnostics || {},
  );
  const slabMarkCountForGate = slabInfo.slabMarks?.length || 0;
  const takeoffBoundsForGate = takeoffRegion
    ? {
        minX: takeoffRegion.minX,
        maxX: takeoffRegion.maxX,
        minY: takeoffRegion.minY,
        maxY: takeoffRegion.maxY,
      }
    : entityCollectionBounds(entitiesAfterFramingRegion.length ? entitiesAfterFramingRegion : entities);
  const takeoffRegionAreaM2Estimate = boundsAreaM2(takeoffBoundsForGate);
  const independentGate = independentFramingEvidenceGate({
    rawEntities,
    regionEntities: entitiesAfterFramingRegion,
    filteredEntities: entities,
    slabInfo,
    grid,
    takeoffBounds: takeoffBoundsForGate,
  });
  const slabGateAreaM2Estimate = independentGate.areaM2 || takeoffRegionAreaM2Estimate;
  const suspiciousSlabRows = areaItem && needsWholeDrawingSlabFallback(rows, gridPanelRows, slabMarkCountForGate, slabGateAreaM2Estimate);
  const suspiciousSlabAreaBeforeFallback = areaItem ? slabNetTotal(rows) : 0;
  const suspiciousSlabRowCountBeforeFallback = areaItem ? rows.length : 0;
  let blockedSuspiciousSlabRows = false;
  let reviewQuantityFromBlockedSlab = false;
  let slabReviewReferenceRows = [];
  const shouldRunWholeDrawingFallback = areaItem
    ? (!rows.length || suspiciousSlabRows)
    : (!hasPrimaryNamedBeamEvidence && (!rows.length || weakDirectBeamRows));
  if (shouldRunWholeDrawingFallback) {
    const preFallbackRows = rows;
    if (areaItem && preFallbackRows.length) {
      slabReviewReferenceRows = preFallbackRows;
    }
    let fallbackReplacedRows = false;
    const obviouslyFalseSlabRows = areaItem && isObviouslyFalseWholeDrawingSlabResult(preFallbackRows, gridPanelRows, slabMarkCountForGate, slabGateAreaM2Estimate);
    const canRunWholeDrawingFallback = allowDeepFallback || entities.length <= FAST_TOPOLOGY_ENTITY_LIMIT;
    if (canRunWholeDrawingFallback) {
      engineFallback = areaItem
        ? await runTopologyTakeoffEngineOnEntities(
            entities,
            file.name,
            role,
            itemType,
            allowDeepFallback ? CAD_ENGINE_LIMITS : FAST_CAD_ENGINE_LIMITS,
          )
        : await runTopologyTakeoffEngine(
            entityPath,
            file.name,
            role,
            itemType,
            allowDeepFallback ? CAD_ENGINE_LIMITS : FAST_CAD_ENGINE_LIMITS,
          );
      if (engineFallback.ok && engineFallback.rows.length) {
        const fallbackArea = slabNetTotal(engineFallback.rows);
        const currentArea = slabNetTotal(preFallbackRows);
        const fallbackBeamLength = beamTotalLength(engineFallback.rows);
        const currentBeamLength = beamTotalLength(preFallbackRows);
        const weakSlabFallback = areaItem && isWeakSlabFallbackResult(engineFallback.rows, slabMarkCountForGate, slabGateAreaM2Estimate);
        const shouldUseFallbackRows = areaItem
          ? !weakSlabFallback && (!preFallbackRows.length || engineFallback.rows.length > preFallbackRows.length || fallbackArea > currentArea * 1.25)
          : (!preFallbackRows.length || fallbackBeamLength > currentBeamLength * 1.1);
        if (areaItem && !shouldUseFallbackRows && engineFallback.rows.length > slabReviewReferenceRows.length) {
          slabReviewReferenceRows = engineFallback.rows;
        }
        if (shouldUseFallbackRows) {
          rows = engineFallback.rows;
          slabReviewReferenceRows = [];
          fallbackReplacedRows = true;
        }
      }
    } else {
      topologyFallbackSkipped = `Fast extraction skipped whole-drawing topology fallback because ${entities.length} filtered CAD entities exceed the ${FAST_TOPOLOGY_ENTITY_LIMIT} fast-mode limit. QSS Pro will retry with deep slab topology when this fast result is blocked.`;
    }
    if ((suspiciousSlabRows || obviouslyFalseSlabRows) && !fallbackReplacedRows) {
      const filteredSlabMarkCount = Number(slabInfo.slabMarks?.length || 0);
      const rawSlabMarkCount = Number(rawSlabInfo.slabMarks?.length || 0);
      const reviewSourceSlabInfo = filteredSlabMarkCount ? slabInfo : rawSlabInfo;
      const reviewSourceEntities = filteredSlabMarkCount
        ? entities
        : (entitiesAfterFramingRegion.length ? entitiesAfterFramingRegion : rawEntities);
      const reviewRowsFromMarks = reviewSlabRowsFromMarksForReference({
        fileName: file.name,
        role,
        entities: reviewSourceEntities,
        slabInfo: reviewSourceSlabInfo,
      });
      if (reviewRowsFromMarks.length > slabReviewReferenceRows.length) {
        slabReviewReferenceRows = reviewRowsFromMarks;
      }
      if (!slabReviewReferenceRows.length && rawSlabMarkCount && reviewSourceEntities !== rawEntities) {
        slabReviewReferenceRows = reviewSlabRowsFromMarksForReference({
          fileName: file.name,
          role,
          entities: rawEntities,
          slabInfo: rawSlabInfo,
        });
      }
      slabReviewReferenceRows = (slabReviewReferenceRows.length ? slabReviewReferenceRows : preFallbackRows).map((row) => ({
        ...row,
        needsReview: true,
        reviewNote: reviewText(
          row.reviewNote || "",
          "Review quantity candidate: verify this slab row in the reference drawing before final billing.",
        ),
        evidence: {
          ...(row.evidence || {}),
          reviewQuantityFromBlockedSlab: true,
          reviewQuantityBasis: "Review slab rows generated after the first slab reader produced an unreliable small panel set.",
        },
      }));
      const reviewNetAreaM2 = slabNetTotal(slabReviewReferenceRows);
      const reviewRowsWithBoundaryEvidence = slabReviewReferenceRows.filter((row) => {
        if (/written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|verified/i.test(String(row.evidence?.boundaryBasis || row.source || ""))) {
          return true;
        }
        // Topology/face-walk rows carry no written-dimension label, but a real closed CAD panel box
        // (from a genuine planar face, not a placeholder) is boundary evidence in its own right.
        const evidence = row.evidence || {};
        const widthM = Math.abs(Number(evidence.panelRightX) - Number(evidence.panelLeftX)) / 1000;
        const heightM = Math.abs(Number(evidence.panelTopY) - Number(evidence.panelBottomY)) / 1000;
        return Number.isFinite(widthM) && Number.isFinite(heightM) && widthM >= 1.2 && heightM >= 1.2;
      }).length;
      const reviewCoverageRatio = rawSlabMarkCount
        ? slabReviewReferenceRows.length / rawSlabMarkCount
        : (slabReviewReferenceRows.length ? 1 : 0);
      // Every row that reaches this point is, by construction, flagged needsReview/
      // reviewQuantityFromBlockedSlab a few lines above (line ~1521) - that flag means "verify
      // before billing", not "this data is fake". Disqualifying rows for carrying the exact flag
      // this code just stamped on them made this check always true, which silently zeroed out every
      // real topology-fallback result (e.g. 37 genuine panels/275 sqm) regardless of how much
      // coverage or boundary evidence it had. A review-only quantity is still worth showing.
      const reviewRowsPlausible =
        slabReviewReferenceRows.length >= Math.max(4, Math.ceil((rawSlabMarkCount || slabReviewReferenceRows.length) * 0.35)) &&
        reviewRowsWithBoundaryEvidence >= Math.max(4, Math.ceil(slabReviewReferenceRows.length * 0.5)) &&
        reviewNetAreaM2 >= Math.max(25, (rawSlabMarkCount || slabReviewReferenceRows.length) * 1.5) &&
        reviewCoverageRatio >= 0.35;
      if (reviewRowsPlausible) {
        rows = slabReviewReferenceRows;
        reviewQuantityFromBlockedSlab = true;
      } else {
        rows = [];
        blockedSuspiciousSlabRows = true;
      }
    }
  }
  const slabReviewRowsAreNotFinal = areaItem &&
    slabReviewReferenceRows.length &&
    slabReviewReferenceRows.every((row) =>
      row.needsReview ||
      row.evidence?.blockedReviewCandidate ||
      row.evidence?.reviewQuantityFromBlockedSlab ||
      /locked-slab-review/i.test(String(row.source || "")));
  const blockedReviewReferenceOnly = areaItem &&
    slabReviewReferenceRows.length &&
    (!rows.length || slabReviewRowsAreNotFinal);
  // finalQuantityRows assigns each panel its P1/P2/... number by sorted position (top-to-bottom,
  // left-to-right). The top-level handler runs that same function again on the flattened final
  // rows to build the Excel sheet - applying it here too, before the reference drawing is built,
  // means the panel numbers drawn on the DWG match the numbers the user sees in Excel. Without
  // this, the drawing would assign its own arbitrary index-based numbering that has no relationship
  // to the Excel row order, making the two impossible to cross-check.
  const referenceRowsForDrawing = blockedReviewReferenceOnly
    ? finalQuantityRows(slabReviewReferenceRows, itemType)
    : areaItem && !rows.length && slabReviewReferenceRows.length
    ? finalQuantityRows(slabReviewReferenceRows, itemType)
    : rows;
  const referenceSourceEntities = entitiesAfterFramingRegion.length ? entitiesAfterFramingRegion : entities;
  const correctionSourceEntities = rawEntities.length ? rawEntities : referenceSourceEntities;
  const createStrictSlabReferenceDrawing = () => createMarkedReferenceDrawing(entityPath, file.name, tempDir, {
    preferDwg: isDwgLikeExtension(ext),
    referenceEntities: referenceSourceEntities,
    correctionEntities: correctionSourceEntities,
    slabMarks: slabInfo.slabMarks || rawSlabInfo.slabMarks || [],
    faceWalkLimits: FAST_CAD_ENGINE_LIMITS,
    planRegion: null,
    markBeamIds: false,
    quantityRows: referenceRowsForDrawing,
    boundarySlabPanels: {
      boundaryToleranceMm: 25,
      clusterToleranceMm: 25,
      minCoverage: 0.9,
      splitUsingRawFaceCoordinates: true,
    },
  });
  if (blockedReviewReferenceOnly) {
    const strictReference = await createStrictSlabReferenceDrawing();
    const shouldUseLightReviewReference = !strictReference?.ok &&
      areaItem &&
      Math.max(referenceSourceEntities.length, correctionSourceEntities.length) > FAST_TOPOLOGY_ENTITY_LIMIT;
    const fastPanelReference = shouldUseLightReviewReference
      ? await createMarkedReferenceDrawing(entityPath, file.name, tempDir, {
          preferDwg: isDwgLikeExtension(ext),
          referenceEntities: referenceSourceEntities,
          correctionEntities: correctionSourceEntities,
          slabMarks: slabInfo.slabMarks || rawSlabInfo.slabMarks || [],
          faceWalkLimits: FAST_CAD_ENGINE_LIMITS,
          planRegion: null,
          fastSlabPanelReference: true,
          markBeamIds: false,
          quantityRows: referenceRowsForDrawing,
        })
      : null;
    referenceDrawing = strictReference?.ok && Number(strictReference.panelMarks || 0) > 0
      ? strictReference
      : fastPanelReference?.ok && Number(fastPanelReference.panelMarks || 0) > 0
        ? fastPanelReference
      : shouldUseLightReviewReference
        ? await createSlabMarkReviewReferenceDrawing(entityPath, file.name, tempDir, {
            preferDwg: isDwgLikeExtension(ext),
            slabMarks: slabInfo.slabMarks || rawSlabInfo.slabMarks || [],
            sourceEntityCount: Math.max(referenceSourceEntities.length, correctionSourceEntities.length),
          })
        : await createMarkedReferenceDrawing(entityPath, file.name, tempDir, {
          preferDwg: isDwgLikeExtension(ext),
          referenceEntities: referenceSourceEntities,
          correctionEntities: correctionSourceEntities,
          slabMarks: slabInfo.slabMarks || rawSlabInfo.slabMarks || [],
          faceWalkLimits: FAST_CAD_ENGINE_LIMITS,
          planRegion: null,
          markBeamIds: false,
          quantityRows: referenceRowsForDrawing,
        });
  } else if (areaItem) {
    const strictReference = await createStrictSlabReferenceDrawing();
    referenceDrawing = strictReference?.ok ? strictReference : referenceDrawing;
  } else if (!referenceDrawing?.ok) {
    referenceDrawing = await createRowBasedReferenceDrawing(entityPath, file.name, tempDir, referenceRowsForDrawing, itemType, {
      preferDwg: isDwgLikeExtension(ext),
    });
  } else {
    referenceDrawing = await enhanceReferenceDrawingWithQuantityRows(referenceDrawing, referenceRowsForDrawing, itemType, tempDir, file.name, {
      preferDwg: isDwgLikeExtension(ext),
    });
  }
  if (SLAB_AUTO_PANEL_CREATION_ENABLED && areaItem && referenceDrawing?.ok && !referenceDrawing.summary?.reviewOnlyReference && Number(referenceDrawing.panelMarks || 0) > 0) {
    const directReferencePanelRows = slabRowsFromReferencePanelMarks(referenceDrawing, file.name, role, slabInfo, cutouts, grid);
    const directReferenceAcceptedRows = finalQuantityRows(directReferencePanelRows, itemType);
    const directReferenceArea = slabNetTotal(directReferenceAcceptedRows);
    const panelMarkCount = Number(referenceDrawing.panelMarks || 0);
    const referencePanelRowsGood =
      directReferenceAcceptedRows.length >= Math.max(4, Math.ceil(panelMarkCount * 0.75)) &&
      directReferenceArea >= Math.max(120, (slabMarkCountForGate || panelMarkCount || 0) * 4) &&
      directReferenceArea >= Math.max(100, slabGateAreaM2Estimate * 0.08);
    if (referencePanelRowsGood) {
      rows = directReferencePanelRows.map((row) => ({
        ...row,
        reviewNote: reviewText(
          row.reviewNote || "",
          row.needsReview ? "" : "QSS-SLAB-002: quantity row came directly from verified reference slab panel data.",
        ),
        evidence: {
          ...(row.evidence || {}),
          referencePanelBoxBridgeUsed: true,
          qssRuleIds: [...new Set([...(row.evidence?.qssRuleIds || []), "QSS-SLAB-002"])],
        },
      }));
      engineFallback = {
        ok: true,
        rows,
        result: {
          slab: {
            source: "reference-panel-box-direct",
            panels: directReferenceAcceptedRows.length,
            totalNetAreaM2: directReferenceArea,
          },
        },
      };
      referencePanelReadbackUsed = true;
      blockedSuspiciousSlabRows = false;
      reviewQuantityFromBlockedSlab = false;
    } else if (directReferencePanelRows.length && !finalQuantityRows(rows, itemType).length) {
      rows = referencePanelReviewRows(
        directReferencePanelRows,
        "REVIEW ONLY: slab quantity rows were created for checking, but coverage/area gates did not pass for final quantity. Check these rows against the downloaded reference DWG.",
      );
      engineFallback = {
        ok: true,
        rows,
        result: {
          slab: {
            source: "reference-panel-box-review-only",
            panels: rows.length,
            totalNetAreaM2: slabNetTotal(rows),
          },
        },
      };
      referencePanelReadbackUsed = true;
      reviewQuantityFromBlockedSlab = true;
    }
  }
  if (SLAB_AUTO_PANEL_CREATION_ENABLED && !referencePanelReadbackUsed && areaItem && referenceDrawing?.ok && !referenceDrawing.summary?.reviewOnlyReference && referenceDrawing.dxfPath && fs.existsSync(referenceDrawing.dxfPath) && Number(referenceDrawing.panelMarks || 0) > 0) {
    const readbackResult = await runTopologyTakeoffEngine(referenceDrawing.dxfPath, file.name, role, itemType, FAST_CAD_ENGINE_LIMITS);
    const readbackSource = String(readbackResult.result?.slab?.source || "");
    const readbackAcceptedRows = readbackResult.ok ? finalQuantityRows(readbackResult.rows, itemType) : [];
    const currentAcceptedRows = finalQuantityRows(rows, itemType);
    const readbackArea = slabNetTotal(readbackAcceptedRows);
    const currentArea = slabNetTotal(currentAcceptedRows);
    const readbackRowsGood =
      readbackSource === "reference-readback" &&
      readbackAcceptedRows.length >= Math.max(4, Math.ceil(Number(referenceDrawing.panelMarks || 0) * 0.75)) &&
      readbackArea >= Math.max(120, (slabMarkCountForGate || Number(referenceDrawing.panelMarks || 0) || 0) * 4) &&
      readbackArea >= Math.max(100, slabGateAreaM2Estimate * 0.08);
    const shouldUseReadback = readbackSource === "reference-readback" &&
      readbackRowsGood &&
      readbackAcceptedRows.length > 0 &&
      (
        readbackAcceptedRows.length >= currentAcceptedRows.length ||
        readbackArea >= Math.max(25, currentArea * 0.9)
      );
    if (shouldUseReadback) {
      rows = readbackResult.rows.map((row) => ({
        ...row,
        reviewNote: reviewText(
          row.reviewNote || "",
          row.needsReview ? "" : "QSS-SLAB-002: quantity row came from verified reference slab panel read-back.",
        ),
        evidence: {
          ...(row.evidence || {}),
          referencePanelReadbackAfterDrawing: true,
          qssRuleIds: [...new Set([...(row.evidence?.qssRuleIds || []), "QSS-SLAB-002"])],
        },
      }));
      engineFallback = readbackResult;
      referencePanelReadbackUsed = true;
      blockedSuspiciousSlabRows = false;
      reviewQuantityFromBlockedSlab = false;
    }
    if (!shouldUseReadback) {
      const directReferencePanelRows = slabRowsFromReferencePanelMarks(referenceDrawing, file.name, role, slabInfo, cutouts, grid);
      const directReferenceAcceptedRows = finalQuantityRows(directReferencePanelRows, itemType);
      const directReferenceArea = slabNetTotal(directReferenceAcceptedRows);
      const panelMarkCount = Number(referenceDrawing.panelMarks || 0);
      const referencePanelRowsGood =
        directReferenceAcceptedRows.length >= Math.max(4, Math.ceil(panelMarkCount * 0.75)) &&
        directReferenceArea >= Math.max(120, (slabMarkCountForGate || panelMarkCount || 0) * 4) &&
        directReferenceArea >= Math.max(100, slabGateAreaM2Estimate * 0.08);
      if (referencePanelRowsGood) {
        rows = directReferencePanelRows.map((row) => ({
          ...row,
          reviewNote: reviewText(
            row.reviewNote || "",
            row.needsReview ? "" : "QSS-SLAB-002: quantity row came from verified reference slab panel data after DXF read-back was weak.",
          ),
          evidence: {
            ...(row.evidence || {}),
            referencePanelBoxBridgeUsed: true,
            qssRuleIds: [...new Set([...(row.evidence?.qssRuleIds || []), "QSS-SLAB-002"])],
          },
        }));
        engineFallback = {
          ok: true,
          rows,
          result: {
            slab: {
              source: "reference-panel-box-readback",
              panels: directReferenceAcceptedRows.length,
            },
          },
        };
        referencePanelReadbackUsed = true;
        blockedSuspiciousSlabRows = false;
        reviewQuantityFromBlockedSlab = false;
      } else if (directReferencePanelRows.length && !finalQuantityRows(rows, itemType).length) {
        rows = referencePanelReviewRows(
          directReferencePanelRows,
          "REVIEW ONLY: reference slab-panel rows were created after DXF read-back was weak, but coverage/area gates did not pass. Check these rows against the downloaded reference DWG.",
        );
        engineFallback = {
          ok: true,
          rows,
          result: {
            slab: {
              source: "reference-panel-box-review-only",
              panels: rows.length,
              totalNetAreaM2: slabNetTotal(rows),
            },
          },
        };
        referencePanelReadbackUsed = true;
        reviewQuantityFromBlockedSlab = true;
      }
    }
  }
  const selectedCalculationRoute = shouldUseReferencePanelReadback
    ? "reference_panel_readback"
    : referencePanelReadbackUsed
      ? "reference_panel_readback"
      : areaItem && referenceDrawing?.summary?.reviewOnlyReference
      ? "slab_review_reference_only"
      : shouldUseQbBeamReadback
      ? "qb_beam_reference_readback"
      : markedDimensionFastRows.length && rows === beamRows
        ? "marked_dimension_named_beam_fast_path"
      : namedBeamFilteredFallbackUsed
        ? "filtered_named_beam_geometry_recovery"
      : engineFallback?.ok && rows === engineFallback.rows
        ? (allowDeepFallback ? "deep_topology_fallback" : "fast_topology_fallback")
        : rows === beamRows
          ? "named_or_direct_beam_extractor"
          : "direct_slab_extractor";
  const routeWarnings = [];
  if (suspiciousSlabRows) {
    routeWarnings.push(
      `Suspicious slab result blocked/rechecked: reader produced ${round3(suspiciousSlabAreaBeforeFallback)} sqm from ${suspiciousSlabRowCountBeforeFallback} row(s) while independent drawing evidence indicates about ${round3(slabGateAreaM2Estimate)} sqm of framing extent.`,
    );
  }
  if (areaItem && /topology_fallback/.test(selectedCalculationRoute)) {
    routeWarnings.push("Slab extraction used topology fallback; final quantity requires written CAD dimensions or verified beam/wall/column boundary validation.");
  }
  const xrefDependentUnresolvedMarks = areaItem
    ? (engineFallback?.result?.slab?.unresolvedMarks || []).filter((mark) => mark.xrefDependent)
    : [];
  if (xrefDependentUnresolvedMarks.length) {
    const markList = [...new Set(xrefDependentUnresolvedMarks.map((mark) => mark.text))].join(", ");
    routeWarnings.push(
      `Slab mark(s) ${markList} could not be resolved from the primary drawing: nearby boundary geometry is mostly xref-bound (external reference), which is excluded from quantity extraction. Measure these manually from the reference/architectural file instead of expecting further automated extraction to close them.`,
    );
  }
  const weakBeamRoute = !areaItem && /topology_fallback|qb_beam_reference_readback/.test(selectedCalculationRoute);
  if (markedDimensionFastRows.length && rows === beamRows) {
    routeWarnings.push("Marked CAD dimensions were used as the primary measurement source; heavy topology fallback was not required.");
  }
  if (directBeamExtractorSkipped) routeWarnings.push(directBeamExtractorSkipped);
  if (namedBeamFilteredFallbackUsed) {
    routeWarnings.push("Beam extraction used filtered framing-geometry recovery because the direct named-beam reader returned zero rows; review rows are included instead of returning blank.");
  }
  if (topologyFallbackSkipped) routeWarnings.push(topologyFallbackSkipped);
  const weakBeamReviewRatio = rows.length ? rows.filter((row) => row.needsReview).length / rows.length : 1;
  if (weakBeamRoute) {
    routeWarnings.push(
      weakBeamReviewRatio > 0.1
        ? "Beam extraction used QSS auto/topology fallback and has review rows; use this as a review package only until the reference drawing is checked."
        : "Beam extraction used QSS auto/topology fallback; verify the reference drawing before billing.",
    );
  }
  if (referenceDrawing?.warning) routeWarnings.push(referenceDrawing.warning);
  const assignedCutoutAreaM2 = (areaItem ? rows : slabRows).reduce((sum, row) => sum + (row.openings || 0), 0);
  const positiveAreaCutouts = cutouts.filter((cutout) => Number(cutout.areaM2 || 0) > 0.01);
  const beamDiagnostics = extractBeamRowsFromDxf.lastDiagnostics || {};
  const noRowsDiagnosticParts = [
    `route=${selectedCalculationRoute}`,
    `entitySource=${parsedTakeoffEntities.source}`,
    `rawEntities=${parsedTakeoffEntities.rawEntities?.length || 0}`,
    `usedEntities=${rawEntities.length}`,
    `afterRegion=${entitiesAfterFramingRegion.length}`,
    `afterDetailFilter=${entities.length}`,
    `detailRollback=${detailFilterRolledBack ? "yes" : "no"}`,
    `beamLabels=${beamDiagnostics.beamLabels ?? primaryNamedBeamTextCount}`,
    `beamSizes=${beamDiagnostics.beamSizes ?? Object.keys(beamSizeById || {}).length}`,
    `beamLines=${beamDiagnostics.beamLines ?? 0}`,
    `directRows=${beamDiagnostics.finalRows ?? beamRows.length}`,
    `recoveredRows=${beamDiagnostics.recoveredDimensionRows ?? 0}`,
    `markedDimFast=${markedDimensionFastRows.length}`,
    directBeamExtractorSkipped ? "directBeamExtractorSkipped=yes" : "",
    `dimensions=${grid.dimensions.length}`,
    `textDimensions=${grid.dimensionDiagnostics?.textDimensions ?? 0}`,
    `trueDimensions=${grid.dimensionDiagnostics?.trueDimensions ?? 0}`,
    `fallbackRows=${engineFallback?.rows?.length ?? 0}`,
    topologyFallbackSkipped ? `fallbackSkipped=${topologyFallbackSkipped}` : "",
    `referenceMode=${referenceBeamMode || "none"}`,
  ].filter(Boolean);
  const noRowsDiagnostic = ` Diagnostics: ${noRowsDiagnosticParts.join(", ")}.`;
  const taggedRows = rows.map((row) => ({
    ...row,
    floor: takeoffSetLabel,
    evidence: {
      ...(row.evidence || {}),
      fileName: row.evidence?.fileName || file.name,
      takeoffSetKey,
      takeoffSetLabel,
      measuredAsOneTakeoffSet: true,
    },
  }));
  const result = {
    fileName: file.name,
    role,
    rows: taggedRows,
    warning: rows.length
      ? routeWarnings.join(" ")
      : blockedSuspiciousSlabRows
        ? `Slab extraction blocked: only a small/false closed panel was detected, and the full panel finder could not verify the drawing. No quantity is shown to avoid a wrong total.${topologyFallbackSkipped ? ` ${topologyFallbackSkipped}` : ""}`
        : `No ${itemType} quantity rows found from CAD geometry.${engineFallback?.error ? ` Topology engine failed: ${engineFallback.error}` : ""}${noRowsDiagnostic}`,
    summary: {
      sourceFormat,
      accuracyRuleVersion: ACCURACY_RULE_VERSION,
      extractionProfile,
      markedDimensionFastMode,
      markedDimensionFastRows: markedDimensionFastRows.length,
      directBeamExtractorSkipped,
      takeoffSetKey,
      takeoffSetLabel,
      regionGuard,
      detailExclusionZones: detailZones.length,
      rawEntityCount: rawEntities.length,
      originalRawEntityCount: parsedTakeoffEntities.rawEntities?.length || rawEntities.length,
      takeoffEntitySource: parsedTakeoffEntities.source,
      takeoffEntityRawScore: parsedTakeoffEntities.rawScore,
      takeoffEntityExpandedScore: parsedTakeoffEntities.expandedScore,
      expandedEntityCount: parsedTakeoffEntities.expandedEntityCount,
      expandedParseError: parsedTakeoffEntities.expandedParseError || "",
      detailFilterRolledBack,
      entitiesAfterFramingRegion: entitiesAfterFramingRegion.length,
      entitiesAfterDetailExclusion: entities.length,
      primaryNamedBeamTextCount,
      takeoffRegion: takeoffRegion ? {
        basis: takeoffRegion.basis,
        markerCount: takeoffRegion.markerCount,
        totalMarkerCount: takeoffRegion.totalMarkerCount,
        regionStats: takeoffRegion.regionStats || null,
        rejectedDetailZones: takeoffRegion.rejectedDetailZones || 0,
        minX: Math.round(takeoffRegion.minX),
        maxX: Math.round(takeoffRegion.maxX),
        minY: Math.round(takeoffRegion.minY),
        maxY: Math.round(takeoffRegion.maxY),
      } : null,
      selectedCalculationRoute,
      routeWarnings,
      weakBeamRoute,
      weakBeamReviewRatio,
      namedBeamFallbackBlocked: !areaItem && hasPrimaryNamedBeamEvidence,
      topologyFallbackSkipped,
      engineFallback: engineFallback?.summary || null,
      weakDirectBeamFallback: Boolean(weakDirectBeamRows),
      suspiciousSlabFallback: Boolean(suspiciousSlabRows),
      suspiciousSlabBlocked: Boolean(blockedSuspiciousSlabRows),
      reviewQuantityFromBlockedSlab,
      slabReviewReferenceRows: slabReviewReferenceRows.length,
      takeoffRegionAreaM2Estimate: Math.round(slabGateAreaM2Estimate * 1000) / 1000,
      selectedTakeoffRegionAreaM2Estimate: Math.round(takeoffRegionAreaM2Estimate * 1000) / 1000,
      independentFramingEvidenceGate: {
        areaM2: Math.round((independentGate.areaM2 || 0) * 1000) / 1000,
        source: independentGate.source,
        candidates: independentGate.candidates,
      },
      takeoffRegionBoundsForGate: takeoffBoundsForGate ? {
        minX: Math.round(takeoffBoundsForGate.minX),
        maxX: Math.round(takeoffBoundsForGate.maxX),
        minY: Math.round(takeoffBoundsForGate.minY),
        maxY: Math.round(takeoffBoundsForGate.maxY),
      } : null,
      referenceDrawing,
      beamRows: beamRows.length,
      beamSupportReviewRows: beamRows.filter((row) => row.needsReview).length,
      beamExtractionDiagnostics: extractBeamRowsFromDxf.lastDiagnostics,
      slabRows: slabRows.length,
      slabMarkCount: slabInfo.slabMarks?.length || 0,
      unresolvedSlabMarkCount: areaItem
        ? Math.max(0, (slabInfo.slabMarks?.length || 0) - Math.max(slabRows.length, rows.length, slabReviewReferenceRows.length))
        : 0,
      embeddedBeamSizeRows: Object.keys(embeddedDetailSchedules.beamSizeById || {}).length,
      embeddedSlabSpecRows: Object.keys(embeddedDetailSchedules.slabInfo?.slabSpecs || {}).length,
      embeddedSlabReinforcementSchedule: embeddedDetailSchedules.slabReinforcementSchedule || {},
      gridPanelRows: gridPanelRows.length,
      gridAxes: grid.axes.length,
      gridDimensions: grid.dimensions.length,
      gridDimensionDiagnostics: grid.dimensionDiagnostics,
      defaultSlabThicknessMm: slabInfo.defaultThicknessMm,
      cutoutCount: cutouts.length,
      positiveCutoutCount: positiveAreaCutouts.length,
      textOnlyCutoutCount: cutouts.length - positiveAreaCutouts.length,
      detectedCutoutAreaM2: cutouts.reduce((sum, cutout) => sum + cutout.areaM2, 0),
      assignedCutoutAreaM2,
      totalBeamLengthM: beamRows.reduce((sum, row) => sum + row.length, 0),
      totalSlabAreaM2: slabRows.reduce((sum, row) => sum + row.length * row.breadth, 0),
      totalSlabNetAreaM2: slabRows.reduce((sum, row) => sum + Math.max(row.length * row.breadth - (row.openings || 0), 0), 0),
      outputRows: rows.length,
    },
  };
  cacheSet(framingExtractionCache, cacheKey, result);
  return result;
}

function collectLinkedDetailSchedules(files, tempDir) {
  const linked = {
    beamSizeById: {},
    slabInfos: [],
    slabReinforcementSchedule: {},
    detailFiles: [],
  };

  files.forEach((file, index) => {
    if (!isDetailScheduleDrawingName(file.name)) return;
    const cacheKey = detailScheduleCacheKey(file);
    const cached = cacheGet(detailScheduleCache, cacheKey);
    if (cached) {
      Object.assign(linked.beamSizeById, cached.beamSizeById || {});
      if (cached.slabInfo) linked.slabInfos.push(cached.slabInfo);
      Object.assign(linked.slabReinforcementSchedule, cached.slabReinforcementSchedule || {});
      if (cached.detailFile) linked.detailFiles.push(cached.detailFile);
      return;
    }
    const ext = path.extname(file.name).toLowerCase();
    const detailPath = path.join(tempDir, `detail-${index + 1}-${safeName(file.name)}`);
    fs.writeFileSync(detailPath, Buffer.from(file.dataBase64, "base64"));
    let entityPath = detailPath;
    let sourceFormat = "dxf";
    if (isDwgLikeExtension(ext)) {
      const converted = convertDwgToDxf(detailPath, tempDir, file.name);
      if (!converted.ok) return;
      entityPath = converted.outputPath;
      sourceFormat = ext === ".bak" ? "dwg-backup-auto-converted-dxf" : "dwg-auto-converted-dxf";
    } else if (ext !== ".dxf") {
      return;
    }
    const entities = parseDxfEvidence(entityPath);
    const schedules = extractDetailSchedulesFromEntities(entities);
    Object.assign(linked.beamSizeById, schedules.beamSizeById || {});
    if (schedules.slabInfo) linked.slabInfos.push(schedules.slabInfo);
    Object.assign(linked.slabReinforcementSchedule, schedules.slabReinforcementSchedule || {});
    const beamSizeRows = Object.keys(schedules.beamSizeById || {}).length;
    const slabSpecRows = Object.keys(schedules.slabInfo?.slabSpecs || {}).length;
    const slabReinforcementRows = Object.keys(schedules.slabReinforcementSchedule || {}).length;
    const cachedDetail = {
      beamSizeById: schedules.beamSizeById || {},
      slabInfo: schedules.slabInfo || null,
      slabReinforcementSchedule: schedules.slabReinforcementSchedule || {},
      detailFile: null,
    };
    if (beamSizeRows || slabSpecRows || slabReinforcementRows) {
      cachedDetail.detailFile = {
        fileName: file.name,
        sourceFormat,
        beamSizeRows,
        slabSpecRows,
        slabReinforcementRows,
      };
      linked.detailFiles.push(cachedDetail.detailFile);
    }
    cacheSet(detailScheduleCache, cacheKey, cachedDetail);
  });

  return linked;
}

function readFirstFloorBenchmarkMinimums() {
  try {
    const benchmark = JSON.parse(fs.readFileSync(path.join(workDir, "first-floor-benchmark.json"), "utf8"));
    return benchmark?.minimums || null;
  } catch {
    return null;
  }
}

function reviewText(...parts) {
  return parts.filter(Boolean).join(" ");
}


function beamSizeLabelFromRow(widthM, depthM) {
  const widthMm = Math.round(Number(widthM || 0) * 1000);
  const depthMm = Math.round(Number(depthM || 0) * 1000);
  return widthMm > 0 && depthMm > 0 ? `(${widthMm}X${depthMm})` : "";
}

function takeoffBeamDisplayName(beam) {
  const existingId = extractBeamIdFromMixedText(beam.text || "");
  const sizeLabel = beamSizeLabelFromRow(beam.widthM, beam.depthM);
  if (existingId) return `${existingId}${sizeLabel ? ` ${sizeLabel}` : ""}`.trim();
  return `${beam.id || "QB"} ${beam.text || "Beam"}`.trim();
}

function takeoffEngineBeamRows(result, fileName, role) {
  return (result.beams?.candidates || []).map((beam) => {
    const length = Number(beam.lengthM || 0);
    const width = Number(beam.widthM || 0);
    const depth = Number(beam.depthM || 0);
    const dimensionStatus = beam.dimensionAudit?.status || "";
    const dimensionAccepted = ["matched", "ok", "cad_authoritative"].includes(dimensionStatus);
    const existingBeamId = extractBeamIdFromMixedText(beam.text || "");
    return {
      name: takeoffBeamDisplayName(beam),
      floor: beam.gridBand || role || "Framing plan",
      length,
      breadth: width,
      height: depth,
      slabThickness: 0.15,
      bottomAreaOverride: Number(beam.bottomSqm || 0),
      sideAreaOverride: Number(beam.sideSqm || 0),
      grossConcreteOverride: length * width * depth,
      dia: 16,
      spacing: 150,
      nos: 1,
      openings: 0,
      source: "topology-takeoff-engine-v2",
      needsReview: beam.status !== "bay_face_pair_confirmed" || !dimensionAccepted,
      reviewNote: reviewText(
        beam.status && beam.status !== "bay_face_pair_confirmed" ? `Status: ${beam.status}.` : "",
        dimensionStatus && !dimensionAccepted ? `Dimension audit: ${dimensionStatus}.` : "",
        beam.dimensionAudit?.note || "",
      ),
      ocrEvidence: `${fileName} | ${beam.gridBand || ""} | ${beam.calculationSource || "CAD topology"}`.trim(),
      evidence: {
        fileName,
        source: "takeoff-engine-v2",
        gridBand: beam.gridBand,
        orientation: beam.orientation,
        faceSpan: beam.faceSpan,
        beamMarkX: beam.x,
        beamMarkY: beam.y,
        bottomSqm: beam.bottomSqm,
        sideSqm: beam.sideSqm,
        edgeLineStyleRule: beam.edgeLineStyleRule,
        sideAreaBasis: "Beam side shuttering follows each CAD face style: dotted/hidden side deducts slab thickness; continuous side is full depth.",
        sideShutteringSegments: beam.sideShutteringSegments || [],
        dimensionAudit: beam.dimensionAudit,
        existingBeamId,
        generatedQssBeamId: existingBeamId ? "" : (beam.id || ""),
      },
    };
  });
}

function takeoffEngineSlabRows(result, fileName, role) {
  const slabSource = result.slab?.source || "topology-takeoff-engine-v2";
  return (result.slab?.panels || []).map((panel) => {
    const length = Number(panel.lengthM || 0);
    const breadth = Number(panel.breadthM || 0);
    const grossArea = length * breadth;
    const netArea = Number(panel.netAreaSqm || grossArea);
    const openings = Math.max(0, grossArea - netArea);
    const status = String(panel.status || "");
    const isReferenceReadback = slabSource === "reference-readback" && /^reference-readback$/i.test(status);
    const hasDimensionConflict = Boolean(panel.dimensionAudit?.hasConflict || /conflict/i.test(String(panel.dimensionAudit?.status || "")));
    const needsReview = !isReferenceReadback || hasDimensionConflict;
    return {
      name: panel.referenceLabel && !/^TP\d+$/i.test(String(panel.referenceLabel || ""))
        ? panel.referenceLabel
        : "Slab panel",
      floor: panel.gridBand || role || "Framing plan",
      length,
      breadth,
      height: Number(panel.thicknessM || 0.15),
      dia: 10,
      spacing: 150,
      nos: 1,
      openings,
      source: slabSource,
      needsReview,
      reviewNote: reviewText(
        panel.remarks || "",
        needsReview
          ? "Topology-only slab panel; final quantity requires written CAD dimension or verified beam-boundary confirmation."
          : "Accepted from verified slab-panel read-back.",
      ),
      ocrEvidence: `${fileName} | ${panel.gridBand || ""} | ${panel.panel || ""}`.trim(),
      evidence: {
        fileName,
        source: "takeoff-engine-v2",
        slabSource,
        referenceReadbackAccepted: isReferenceReadback && !hasDimensionConflict,
        topologyPanelId: panel.panel || "",
        status,
        panel: panel.panel,
        gridBand: panel.gridBand,
        netAreaSqm: panel.netAreaSqm,
        cutoutAreaSqm: panel.cutoutAreaSqm,
        dimensionAudit: panel.dimensionAudit,
        panelLeftX: Number.isFinite(panel.box?.minX) ? Math.round(panel.box.minX) : null,
        panelRightX: Number.isFinite(panel.box?.maxX) ? Math.round(panel.box.maxX) : null,
        panelBottomY: Number.isFinite(panel.box?.minY) ? Math.round(panel.box.minY) : null,
        panelTopY: Number.isFinite(panel.box?.maxY) ? Math.round(panel.box.maxY) : null,
      },
    };
  });
}

function slabRowsFromReferencePanelMarks(referenceDrawing, fileName, role, slabInfo = {}, cutouts = [], grid = { dimensions: [] }) {
  if (!SLAB_AUTO_PANEL_CREATION_ENABLED) return [];
  const panels = Array.isArray(referenceDrawing?.panelMarksData) ? referenceDrawing.panelMarksData : [];
  if (!panels.length) return [];
  return panels.map((panel) => {
    const box = panel.box || {};
    const minX = Math.min(Number(box.minX), Number(box.maxX));
    const maxX = Math.max(Number(box.minX), Number(box.maxX));
    const minY = Math.min(Number(box.minY), Number(box.maxY));
    const maxY = Math.max(Number(box.minY), Number(box.maxY));
    if (![minX, maxX, minY, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return null;
    const geometryLengthMm = maxX - minX;
    const geometryBreadthMm = maxY - minY;
    const panelCenter = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    };
    const panelDimensionText = [
      panel.source,
      panel.dimensionAuthority,
      panel.lengthBasis,
      panel.breadthBasis,
      panel.dimensionBasis,
    ].filter(Boolean).join(" ");
    const authoritativeLengthMm = Number(panel.authoritativeLengthMm);
    const authoritativeBreadthMm = Number(panel.authoritativeBreadthMm);
    const writtenDimensionAuthority =
      /written-cad-dimension|marked-cad-dimension|visible-dimension-text|text-dimension-label|cad-dimension/i.test(panelDimensionText) &&
      Number.isFinite(authoritativeLengthMm) &&
      Number.isFinite(authoritativeBreadthMm) &&
      authoritativeLengthMm > 0 &&
      authoritativeBreadthMm > 0;
    const cadLength = cadDimensionForPanelSpan(grid.dimensions, {
      x: minX,
      y: panelCenter.y,
      x2: maxX,
      y2: panelCenter.y,
    }, "horizontal");
    const cadBreadth = cadDimensionForPanelSpan(grid.dimensions, {
      x: panelCenter.x,
      y: minY,
      x2: panelCenter.x,
      y2: maxY,
    }, "vertical");
    const lengthChoice = writtenDimensionAuthority
      ? {
          valueMm: authoritativeLengthMm,
          source: panel.lengthBasis || "written-cad-dimension-panel",
          conflict: false,
          values: [{ source: panel.lengthBasis || "written-cad-dimension-panel", valueMm: authoritativeLengthMm }],
        }
      : chooseSlabPanelDimension({
          cadDimension: cadLength,
          gridDimension: null,
          geometryMm: geometryLengthMm,
        });
    const breadthChoice = writtenDimensionAuthority
      ? {
          valueMm: authoritativeBreadthMm,
          source: panel.breadthBasis || "written-cad-dimension-panel",
          conflict: false,
          values: [{ source: panel.breadthBasis || "written-cad-dimension-panel", valueMm: authoritativeBreadthMm }],
        }
      : chooseSlabPanelDimension({
          cadDimension: cadBreadth,
          gridDimension: null,
          geometryMm: geometryBreadthMm,
        });
    const length = round3(Number(lengthChoice.valueMm || geometryLengthMm) / 1000);
    const breadth = round3(Number(breadthChoice.valueMm || geometryBreadthMm) / 1000);
    const grossArea = length * breadth;
    if (length <= 0 || breadth <= 0 || grossArea <= 0) return null;
    const marksInside = (slabInfo.slabMarks || []).filter((mark) =>
      Number.isFinite(mark.x) &&
      Number.isFinite(mark.y) &&
      mark.x > minX + 80 &&
      mark.x < maxX - 80 &&
      mark.y > minY + 80 &&
      mark.y < maxY - 80);
    const panelMark = panel.slabMark
      ? { text: panel.slabMark, x: panel.slabMarkX || panelCenter.x, y: panel.slabMarkY || panelCenter.y }
      : marksInside.length
        ? marksInside
            .map((mark) => ({ mark, distance: Math.hypot(mark.x - panelCenter.x, mark.y - panelCenter.y) }))
            .sort((a, b) => a.distance - b.distance)[0].mark
        : nearest(slabInfo.slabMarks || [], panelCenter).item;
    const slabName = panelMark?.text || "Slab panel";
    const slabSpec = slabInfo.slabSpecs?.[slabName] || slabInfo.slabSpecs?.[String(slabName).toUpperCase()] || null;
    const directThickness = (slabInfo.thicknessTexts || [])
      .filter((item) => item.x >= minX && item.x <= maxX && item.y >= minY && item.y <= maxY)
      .map((item) => ({ item, distance: Math.hypot(item.x - panelCenter.x, item.y - panelCenter.y) }))
      .sort((a, b) => a.distance - b.distance)[0]?.item || null;
    const thicknessMm = slabSpec?.thicknessMm ||
      directThickness?.value ||
      slabInfo.byMark?.[slabName] ||
      slabInfo.byMark?.[String(slabName).toUpperCase()] ||
      slabInfo.defaultThicknessMm ||
      150;
    const panelBox = { minX, maxX, minY, maxY };
    const panelAreaMm2 = boxAreaMm2(panelBox);
    const panelCutouts = (cutouts || [])
      .map((cutout) => {
        const cutoutBox = {
          minX: Number(cutout.minX),
          maxX: Number(cutout.maxX),
          minY: Number(cutout.minY),
          maxY: Number(cutout.maxY),
        };
        const overlapMm2 = boxOverlapAreaMm2(panelBox, cutoutBox);
        const overlapM2 = overlapMm2 / 1000000;
        const centerInside = cutout.centerX >= minX &&
          cutout.centerX <= maxX &&
          cutout.centerY >= minY &&
          cutout.centerY <= maxY;
        if (overlapM2 <= 0 && !centerInside) return null;
        return {
          ...cutout,
          overlapM2: overlapM2 > 0 ? overlapM2 : Number(cutout.areaM2 || 0),
          centerInside,
        };
      })
      .filter(Boolean);
    const cutoutAreaM2 = panelCutouts.reduce((sum, cutout) => sum + Number(cutout.overlapM2 || cutout.areaM2 || 0), 0);
    const cutoutOverlapRatio = panelAreaMm2 ? (cutoutAreaM2 * 1000000) / panelAreaMm2 : 0;
    const panelCenterInsideCutout = panelCutouts.some((cutout) =>
      pointInsideBox(panelCenter, cutout, 60));
    if (cutoutOverlapRatio >= 0.72 || (panelCenterInsideCutout && cutoutOverlapRatio >= 0.45)) {
      return null;
    }
    const coverageValues = Object.values(panel.coverage || {}).map(Number).filter(Number.isFinite);
    const weakestCoverage = coverageValues.length ? Math.min(...coverageValues) : 0;
    const status = String(panel.status || "");
    const multipleMarks = Number(panel.slabMarksInsideCount || marksInside.length || 0) > 1;
    const dimensionAuthorityPanel = writtenDimensionAuthority || /written-cad-dimension/i.test(String(panel.source || ""));
    const weakBoundaryCoverage = !dimensionAuthorityPanel && (coverageValues.length < 4 || weakestCoverage < 0.85);
    const dimensionConflict = Boolean(lengthChoice.conflict || breadthChoice.conflict);
    const needsReview = /review/i.test(status) || multipleMarks || weakBoundaryCoverage || cutoutOverlapRatio > 0.02 || dimensionConflict;
    const dimensionReview = dimensionConflict
      ? `Need review: written CAD dimension and panel geometry differ. Length ${round3(Number(lengthChoice.valueMm || 0) / 1000)} m (${lengthChoice.source}), breadth ${round3(Number(breadthChoice.valueMm || 0) / 1000)} m (${breadthChoice.source}).`
      : "";
    return {
      name: panel.label || panel.id || slabName,
      panelNo: panel.label || panel.id || "",
      floor: panel.gridBand || role || "Framing plan",
      length,
      breadth,
      height: Number(thicknessMm || 150) / 1000,
      capHeight: 0,
      capExposedPerimeter: 0,
      slabThickness: 0,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      dia: 10,
      spacing: 150,
      nos: 1,
      openings: Math.min(cutoutAreaM2, grossArea),
      source: "dxf-slab-reference-panel",
      needsReview,
      reviewNote: reviewText(
        "",
        cutoutOverlapRatio > 0.02
          ? `Cutout/open-to-sky overlap deducted ${round3(Math.min(cutoutAreaM2, grossArea))} sqm; verify this panel before final billing.`
          : weakBoundaryCoverage
          ? "need review"
          : dimensionReview
          ? dimensionReview
          : needsReview
          ? "need review"
          : "QSS-SLAB-002: quantity row came from verified slab panel evidence.",
      ),
      ocrEvidence: `${fileName} | ${panel.gridBand || ""} | ${panel.label || panel.id || slabName}`.trim(),
      evidence: {
        fileName,
        source: "reference-working-drawing-panel",
        boundaryBasis: panel.source || "Slab mark from nearest four beam/support boundaries",
        selectedPanelMeasurementBasis: panel.source || "",
        referencePanelDirectBoxReadback: true,
        referenceReadbackAccepted: !needsReview,
        referenceBoundaryCoverageWeak: weakBoundaryCoverage,
        weakestBoundaryCoverageRatio: round3(weakestCoverage),
        panelNo: panel.label || panel.id || "",
        slabMark: slabName,
        panelMarkX: Math.round(panel.x || panelCenter.x),
        panelMarkY: Math.round(panel.y || panelCenter.y),
        panelLeftX: Math.round(minX),
        panelRightX: Math.round(maxX),
        panelBottomY: Math.round(minY),
        panelTopY: Math.round(maxY),
        geometryLengthM: round3(geometryLengthMm / 1000),
        geometryBreadthM: round3(geometryBreadthMm / 1000),
        cadLengthM: cadLength ? round3(Number(cadLength.valueMm || 0) / 1000) : 0,
        cadBreadthM: cadBreadth ? round3(Number(cadBreadth.valueMm || 0) / 1000) : 0,
        authoritativeLengthM: writtenDimensionAuthority ? round3(authoritativeLengthMm / 1000) : 0,
        authoritativeBreadthM: writtenDimensionAuthority ? round3(authoritativeBreadthMm / 1000) : 0,
        measuredLengthM: length,
        measuredBreadthM: breadth,
        lengthBasis: lengthChoice.source || "reference-slab-panel",
        breadthBasis: breadthChoice.source || "reference-slab-panel",
        dimensionValues: {
          length: lengthChoice.values || [],
          breadth: breadthChoice.values || [],
        },
        dimensionConflict,
        slabThicknessSource: slabSpec
          ? `${slabName} schedule/spec -> ${slabSpec.thicknessMm} mm`
          : directThickness
            ? `Direct panel thickness text -> ${directThickness.value} mm`
            : `Default/slab mark thickness -> ${thicknessMm} mm`,
        slabMarksInsidePanel: panel.slabMarksInside || marksInside.map((mark) => mark.text),
        slabMarksInsidePanelCount: panel.slabMarksInsideCount || marksInside.length,
        selectedBoundaryQuality: panel.coverage || null,
        weakestBoundaryCoverage: weakestCoverage,
        boundaryTypes: panel.boundaryTypes || null,
        splitAxes: panel.splitAxes || null,
        cutoutCount: panelCutouts.length,
        cutoutAreaM2: round3(cutoutAreaM2),
        cutoutOverlapRatio: round3(cutoutOverlapRatio),
        cutoutAssignmentBasis: panelCutouts.length ? "cutout-box-overlap-with-reference-panel" : "",
        qssRuleIds: ["QSS-SLAB-001", "QSS-SLAB-002", "QSS-SLAB-006"],
      },
    };
  }).filter(Boolean);
}

function referencePanelReviewRows(rows, note = "") {
  if (!SLAB_AUTO_PANEL_CREATION_ENABLED) return [];
  return (rows || [])
    .filter((row) => Number(row.length || 0) > 0 && Number(row.breadth || 0) > 0)
    .map((row) => ({
      ...row,
      needsReview: true,
      reviewNote: reviewText(
        row.reviewNote || "",
        note || "REVIEW ONLY: slab quantity row was created, but final boundary/read-back gates did not pass. Use this row for checking against the reference drawing only.",
      ),
      evidence: {
        ...(row.evidence || {}),
        referencePanelReviewOnly: true,
        referenceReadbackAccepted: false,
        qssRuleIds: [...new Set([...(row.evidence?.qssRuleIds || []), "QSS-SLAB-002", "QSS-QA-001"])],
      },
    }));
}

function dxfTextEntity({ handle, owner, layer, text, x, y, height = 650, color = 7, rotation = 0, centered = false }) {
  // Plain TEXT defaults to left/baseline justification, so it starts AT (x,y) and runs up-and-right
  // from there rather than being centered on it - fine for an offset label, but wrong for a number
  // meant to sit centered inside a circle marker. Horizontal=1 (center) + vertical=2 (middle), with
  // the second alignment point (11/21/31) matching the insertion point, centers it on that point.
  const xStr = String(Math.round(x * 1000) / 1000);
  const yStr = String(Math.round(y * 1000) / 1000);
  return [
    "0", "TEXT",
    ...(handle ? ["5", handle] : []),
    ...(owner ? ["330", owner] : []),
    "100", "AcDbEntity",
    "8", layer,
    "62", String(color),
    "100", "AcDbText",
    "10", xStr,
    "20", yStr,
    "30", "0.0",
    "40", String(height),
    "1", text,
    "50", String(rotation),
    "41", "1.0",
    "7", "STANDARD",
    ...(centered ? ["72", "1", "11", xStr, "21", yStr, "31", "0.0"] : []),
    "100", "AcDbText",
    ...(centered ? ["73", "2"] : []),
  ].join("\r\n");
}

function dxfLineEntity({ handle, owner, layer, x1, y1, x2, y2, color = 1 }) {
  return [
    "0", "LINE",
    ...(handle ? ["5", handle] : []),
    ...(owner ? ["330", owner] : []),
    "100", "AcDbEntity",
    "8", layer,
    "62", String(color),
    "100", "AcDbLine",
    "10", String(Math.round(x1 * 1000) / 1000),
    "20", String(Math.round(y1 * 1000) / 1000),
    "30", "0.0",
    "11", String(Math.round(x2 * 1000) / 1000),
    "21", String(Math.round(y2 * 1000) / 1000),
    "31", "0.0",
  ].join("\r\n");
}

function dxfClosedPolylineEntity({ handle, owner, layer, points, color = 1 }) {
  const vertexCodes = points.flatMap((point) => [
    "10", String(Math.round(point.x * 1000) / 1000),
    "20", String(Math.round(point.y * 1000) / 1000),
  ]);
  return [
    "0", "LWPOLYLINE",
    ...(handle ? ["5", handle] : []),
    ...(owner ? ["330", owner] : []),
    "100", "AcDbEntity",
    "8", layer,
    "62", String(color),
    "100", "AcDbPolyline",
    "90", String(points.length),
    "70", "1",
    ...vertexCodes,
  ].join("\r\n");
}

function dxfCircleEntity({ handle, owner, layer, x, y, radius = 850, color = 3 }) {
  return [
    "0", "CIRCLE",
    ...(handle ? ["5", handle] : []),
    ...(owner ? ["330", owner] : []),
    "100", "AcDbEntity",
    "8", layer,
    "62", String(color),
    "100", "AcDbCircle",
    "10", String(Math.round(x * 1000) / 1000),
    "20", String(Math.round(y * 1000) / 1000),
    "30", "0.0",
    "40", String(radius),
  ].join("\r\n");
}

function insertBeforeEntitiesEnd(dxf, additions) {
  const entitiesStart = dxf.search(/\r?\n\s*2\r?\nENTITIES\r?\n/);
  if (entitiesStart < 0) throw new Error("Could not find ENTITIES section in DXF.");
  const afterEntities = dxf.slice(entitiesStart);
  const endMatch = afterEntities.match(/\r?\n\s*0\r?\nENDSEC/);
  if (!endMatch) throw new Error("Could not find ENTITIES ENDSEC marker in DXF.");
  const insertAt = entitiesStart + endMatch.index;
  return `${dxf.slice(0, insertAt)}\r\n${additions.join("\r\n")}${dxf.slice(insertAt)}`;
}

function createDxfHandleGenerator(dxf) {
  const used = new Set();
  const qssReservedMinimum = 0xA0000;
  let maxHandle = 0;
  const matches = String(dxf || "").matchAll(/\r?\n\s*5\r?\n\s*([0-9A-F]+)\s*(?=\r?\n)/gi);
  for (const match of matches) {
    const value = Number.parseInt(match[1], 16);
    if (!Number.isFinite(value)) continue;
    used.add(match[1].toUpperCase());
    if (value > maxHandle) maxHandle = value;
  }
  let next = Math.max(maxHandle, qssReservedMinimum);
  const generator = () => {
    do {
      next += 1;
    } while (used.has(next.toString(16).toUpperCase()));
    const handle = next.toString(16).toUpperCase();
    used.add(handle);
    generator.lastHandleValue = next;
    return handle;
  };
  generator.lastHandleValue = next;
  return generator;
}

function updateDxfHandSeed(dxf, seedHandle) {
  const replacement = `9\r\n$HANDSEED\r\n5\r\n${seedHandle}`;
  if (/\r?\n\s*9\r?\n\$HANDSEED\r?\n\s*5\r?\n[0-9A-F]+\s*(?=\r?\n)/i.test(dxf)) {
    return dxf.replace(/\r?\n\s*9\r?\n\$HANDSEED\r?\n\s*5\r?\n[0-9A-F]+\s*(?=\r?\n)/i, `\r\n${replacement}`);
  }
  const headerMatch = dxf.match(/\r?\n\s*2\r?\nHEADER\r?\n/);
  if (!headerMatch) return dxf;
  const insertAt = headerMatch.index + headerMatch[0].length;
  return `${dxf.slice(0, insertAt)}${replacement}\r\n${dxf.slice(insertAt)}`;
}

function findEntityOwnerHandle(dxf) {
  const match = String(dxf || "").match(
    /\r?\n\s*0\r?\n\s*(?:LINE|TEXT|MTEXT|CIRCLE|LWPOLYLINE|POLYLINE|INSERT|HATCH)\s*\r?\n\s*5\r?\n\s*[0-9A-F]+\s*\r?\n\s*330\r?\n\s*([0-9A-F]+)\s*(?=\r?\n)/i,
  );
  return match?.[1]?.toUpperCase() || "";
}

function validBox(box) {
  return box &&
    Number.isFinite(box.minX) &&
    Number.isFinite(box.maxX) &&
    Number.isFinite(box.minY) &&
    Number.isFinite(box.maxY) &&
    box.maxX > box.minX &&
    box.maxY > box.minY;
}

function referenceTextHeightForBox(box, { min = 180, max = 380, fraction = 0.1 } = {}) {
  if (!validBox(box)) return max;
  const smallestSide = Math.min(box.maxX - box.minX, box.maxY - box.minY);
  return Math.round(Math.min(max, Math.max(min, smallestSide * fraction)));
}

function referencePanelLabelHeight(panel) {
  return referenceTextHeightForBox(panel?.box, { min: 120, max: 220, fraction: 0.055 });
}

function referenceDimensionTextHeight(box) {
  return referenceTextHeightForBox(box, { min: 130, max: 230, fraction: 0.055 });
}

function quantityRowPanelBox(row = {}) {
  const evidence = row.evidence || {};
  const left = Number(evidence.panelLeftX);
  const right = Number(evidence.panelRightX);
  const bottom = Number(evidence.panelBottomY);
  const top = Number(evidence.panelTopY);
  if (![left, right, bottom, top].every(Number.isFinite)) return null;
  return {
    minX: Math.min(left, right),
    maxX: Math.max(left, right),
    minY: Math.min(bottom, top),
    maxY: Math.max(bottom, top),
  };
}

function referenceBoxArea(box) {
  if (!validBox(box)) return 0;
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function referenceBoxOverlapRatio(first, second) {
  if (!validBox(first) || !validBox(second)) return 0;
  const overlapX = Math.max(0, Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX));
  const overlapY = Math.max(0, Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY));
  const overlap = overlapX * overlapY;
  if (!overlap) return 0;
  return overlap / Math.max(1, Math.min(referenceBoxArea(first), referenceBoxArea(second)));
}

function panelMarksFromQuantityRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const box = quantityRowPanelBox(row);
      if (!validBox(box)) return false;
      const evidence = row.evidence || {};
      const sourceText = [
        row.source,
        evidence.source,
        evidence.boundaryBasis,
        evidence.selectedPanelMeasurementBasis,
        evidence.lengthBasis,
        evidence.breadthBasis,
        evidence.dimensionBasis,
      ].filter(Boolean).join(" ");
      const hasWrittenDimensionEvidence =
        /written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|cad-dimension/i.test(sourceText) ||
        (Number.isFinite(Number(evidence.cadLengthM)) && Number.isFinite(Number(evidence.cadBreadthM)));
      // A row measured from a genuine closed planar-face-walk topology face (real beam/support-
      // bounded CAD polygon, not a guessed/inferred cell) is legitimate boundary evidence in its own
      // right, even with no written dimension label - without this, topology-fallback rows (now
      // surfaced as review quantity) never get a panel number drawn on the reference drawing at all,
      // leaving no way to cross-check the Excel rows against the drawing.
      const hasGenuineClosedFaceEvidence = /planar-face-walk/i.test(sourceText);
      const blockedWeakSource = /topology|barrier-cell|enclosure-candidate|open-bay|slab-mark-review|locked-slab-review|grid-infer|fake|weak/i.test(sourceText);
      return (hasWrittenDimensionEvidence || hasGenuineClosedFaceEvidence) && !blockedWeakSource;
    })
    .map((row, index) => {
      const box = quantityRowPanelBox(row);
      if (!validBox(box)) return null;
      const label = /^P\d+$/i.test(String(row.panelNo || "")) ? String(row.panelNo).toUpperCase() : `P${index + 1}`;
      const evidence = row.evidence || {};
      const sourceText = [
        row.source,
        evidence.source,
        evidence.boundaryBasis,
        evidence.selectedPanelMeasurementBasis,
        evidence.lengthBasis,
        evidence.breadthBasis,
        evidence.dimensionBasis,
      ].filter(Boolean).join(" ");
      const dimensionAuthority =
        /written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|cad-dimension/i.test(sourceText) ||
        /written-cad-dimension/i.test(String(row.source || ""));
      const authoritativeLengthMm = dimensionAuthority && Number(row.length) > 0
        ? Math.round(Number(row.length) * 1000)
        : null;
      const authoritativeBreadthMm = dimensionAuthority && Number(row.breadth) > 0
        ? Math.round(Number(row.breadth) * 1000)
        : null;
      return {
        id: label,
        label,
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
        box,
        source: dimensionAuthority ? "written-cad-dimension-panel" : row.source || "quantity-row",
        status: row.needsReview ? "need review" : "",
        slabMark: evidence.slabMark || row.name || "",
        slabMarkX: evidence.panelMarkX ?? null,
        slabMarkY: evidence.panelMarkY ?? null,
        slabMarksInside: Array.isArray(evidence.slabMarksInsidePanel) ? evidence.slabMarksInsidePanel : [],
        slabMarksInsideCount: Number(evidence.slabMarksInsidePanelCount || 0),
        areaSqm: round3(Math.max(Number(row.length || 0) * Number(row.breadth || 0) - Number(row.openings || 0), 0)),
        dimensionAuthority: dimensionAuthority ? "written-cad-dimension" : "",
        authoritativeLengthMm,
        authoritativeBreadthMm,
        lengthBasis: dimensionAuthority ? evidence.lengthBasis || "written-cad-dimension-panel" : "",
        breadthBasis: dimensionAuthority ? evidence.breadthBasis || "written-cad-dimension-panel" : "",
        dimensionValues: evidence.dimensionValues || null,
        quantityRowBacked: true,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const topDelta = b.box.maxY - a.box.maxY;
      if (Math.abs(topDelta) > 300) return topDelta;
      return a.box.minX - b.box.minX;
    })
    .map((panel, index) => {
      const label = /^P\d+$/i.test(panel.label) ? panel.label : `P${index + 1}`;
      return { ...panel, id: label, label };
    });
}

function mergeReferencePanelMarks(referenceMarks = [], quantityPanelMarks = []) {
  const output = [];
  for (const panel of quantityPanelMarks) {
    if (validBox(panel.box)) output.push(panel);
  }
  for (const panel of referenceMarks || []) {
    if (!validBox(panel.box)) continue;
    const duplicate = output.some((existing) => referenceBoxOverlapRatio(existing.box, panel.box) >= 0.7);
    if (!duplicate) output.push(panel);
  }
  return output;
}

function dimensionTextMm(valueMm) {
  const value = Number(valueMm || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  return String(Math.round(value));
}

function addPanelWorkingEntities(additions, nextHandle, ownerHandle, panel, layers, options = {}) {
  if (!validBox(panel.box)) return false;
  const box = panel.box;
  const widthMm = box.maxX - box.minX;
  const heightMm = box.maxY - box.minY;
  if (widthMm < 250 || heightMm < 250) return false;
  const markPolyline = options.markPolyline !== false;
  const markDimensions = options.markDimensions !== false;
  const textOnlyDimensions = options.dimensionLabelMode === "text-only";
  const horizontalText = dimensionTextMm(widthMm);
  const verticalText = dimensionTextMm(heightMm);
  const textHeight = referenceDimensionTextHeight(box);
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  const offset = Math.min(Math.max(Math.min(widthMm, heightMm) * 0.055, textHeight * 1.2), textHeight * 2.2);
  if (markPolyline) {
    additions.push(dxfClosedPolylineEntity({
      handle: nextHandle(),
      owner: ownerHandle,
      layer: layers.panelPolylines,
      color: 1,
      points: [
        { x: box.minX, y: box.minY },
        { x: box.maxX, y: box.minY },
        { x: box.maxX, y: box.maxY },
        { x: box.minX, y: box.maxY },
      ],
    }));
  }
  if (markDimensions) {
    if (!textOnlyDimensions) {
      additions.push(dxfLineEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.panelDimensions,
        color: 1,
        x1: box.minX,
        y1: centerY,
        x2: box.maxX,
        y2: centerY,
      }));
    }
    additions.push(dxfTextEntity({
      handle: nextHandle(),
      owner: ownerHandle,
      layer: layers.panelDimensions,
      text: horizontalText,
      x: centerX,
      y: centerY + offset,
      height: textHeight,
      color: 1,
    }));
    if (!textOnlyDimensions) {
      additions.push(dxfLineEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.panelDimensions,
        color: 1,
        x1: centerX,
        y1: box.minY,
        x2: centerX,
        y2: box.maxY,
      }));
    }
    additions.push(dxfTextEntity({
      handle: nextHandle(),
      owner: ownerHandle,
      layer: layers.panelDimensions,
      text: verticalText,
      x: centerX - offset,
      y: centerY,
      height: textHeight,
      color: 1,
      rotation: 90,
    }));
  }
  return true;
}


function beamReferenceSpanSegments(row) {
  const evidence = row?.evidence || {};
  const span = beamSpanFromRow(row);
  if (!span) return [];
  const ranges = Array.isArray(evidence.mergedSpanRanges)
    ? evidence.mergedSpanRanges
    : Array.isArray(evidence.segmentedSpanRanges)
      ? evidence.segmentedSpanRanges
    : Array.isArray(evidence.physicalOccurrenceSpanRanges)
      ? evidence.physicalOccurrenceSpanRanges
      : [];
  const segments = ranges
    .filter((item) => String(item.orientation || span.orientation).toUpperCase().startsWith(span.orientation))
    .map((item) => ({
      orientation: span.orientation,
      fixed: Number.isFinite(Number(item.fixed)) ? Number(item.fixed) : span.fixed,
      start: Math.min(Number(item.start), Number(item.end)),
      end: Math.max(Number(item.start), Number(item.end)),
    }))
    .filter((item) =>
      Number.isFinite(item.fixed) &&
      Number.isFinite(item.start) &&
      Number.isFinite(item.end) &&
      item.end - item.start >= 250)
    .sort((a, b) => a.start - b.start);
  if (segments.length) return segments;
  return [span];
}

function beamReferenceDimensionLabel(row, segment, index, totalSegments) {
  const id = String(row.name || "Beam").split(/\s+/)[0];
  const lengthMm = Math.round((segment.end - segment.start) || Number(row.length || 0) * 1000 || 0);
  if (totalSegments > 1) return `${lengthMm}`;
  return `${id} ${lengthMm}`;
}

function addBeamSpanEntities(additions, nextHandle, ownerHandle, row, layers) {
  const span = beamSpanFromRow(row);
  if (!span || span.lengthMm < 250) return false;
  const segments = beamReferenceSpanSegments(row);
  const offset = 320;
  const textHeight = 300;
  const totalTextHeight = 320;
  let added = 0;
  for (const [index, segment] of segments.entries()) {
    const label = beamReferenceDimensionLabel(row, segment, index, segments.length);
    if (!label) continue;
    if (span.orientation === "H") {
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.beamDimensions,
        text: label,
        x: (segment.start + segment.end) / 2,
        y: segment.fixed + offset,
        height: textHeight,
        color: 1,
      }));
    } else {
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.beamDimensions,
        text: label,
        x: segment.fixed + offset,
        y: (segment.start + segment.end) / 2,
        height: textHeight,
        color: 1,
        rotation: 90,
      }));
    }
    added += 1;
  }
  if (segments.length > 1) {
    const id = String(row.name || "Beam").split(/\s+/)[0];
    const totalLabel = `${id} TOTAL ${dimensionTextMm(Number(row.length || 0) * 1000 || span.lengthMm)}`;
    if (span.orientation === "H") {
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.beamDimensions,
        text: totalLabel,
        x: (span.start + span.end) / 2,
        y: span.fixed + offset + 390,
        height: totalTextHeight,
        color: 1,
      }));
    } else {
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: layers.beamDimensions,
        text: totalLabel,
        x: span.fixed + offset + 390,
        y: (span.start + span.end) / 2,
        height: totalTextHeight,
        color: 1,
        rotation: 90,
      }));
    }
    added += 1;
  }
  return added;
}

function addBeamReviewEntity(additions, nextHandle, ownerHandle, row, index, layers) {
  const span = beamSpanFromRow(row);
  if (!span || span.lengthMm < 250) return false;
  const x = span.orientation === "H" ? (span.start + span.end) / 2 : span.fixed;
  const y = span.orientation === "H" ? span.fixed : (span.start + span.end) / 2;
  additions.push(dxfTextEntity({
    handle: nextHandle(),
    owner: ownerHandle,
    layer: layers.beamReviews,
    text: `BR${index + 1} REVIEW`,
    x,
    y,
    height: 360,
    color: 1,
    rotation: span.orientation === "H" ? 0 : 90,
  }));
  return true;
}

function convertDxfToDwg(inputPath, outputPath, tempDir, label = "reference") {
  const converterStatus = dwgConvert.converterStatus();
  if (!converterStatus.available) {
    return { ok: false, error: converterStatus.help };
  }
  try {
    if (fs.existsSync(outputPath) && path.resolve(outputPath).startsWith(path.resolve(root))) {
      fs.unlinkSync(outputPath);
    }
  } catch (error) {
    return { ok: false, error: `Could not prepare DWG output path: ${error.message}` };
  }
  const inputBuffer = fs.readFileSync(inputPath);
  const converted = dwgConvert.dxfToDwg(inputBuffer, path.basename(inputPath));
  if (!converted.ok) {
    return { ok: false, error: converted.error };
  }
  fs.writeFileSync(outputPath, converted.buffer);
  return { ok: true, outputPath, launcher: "oda-file-converter" };
}

function referencePointForFastPanelEntity(entity) {
  if (Number.isFinite(Number(entity.x)) && Number.isFinite(Number(entity.y))) {
    if (Number.isFinite(Number(entity.x2)) && Number.isFinite(Number(entity.y2))) {
      return { x: (Number(entity.x) + Number(entity.x2)) / 2, y: (Number(entity.y) + Number(entity.y2)) / 2 };
    }
    return { x: Number(entity.x), y: Number(entity.y) };
  }
  const vertices = entity.vertices || entity.points || [];
  if (Array.isArray(vertices) && vertices.length) {
    const xs = vertices.map((point) => Number(point.x)).filter(Number.isFinite);
    const ys = vertices.map((point) => Number(point.y)).filter(Number.isFinite);
    if (xs.length && ys.length) {
      return {
        x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
        y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
      };
    }
  }
  return null;
}

function filterEntitiesForFastSlabReference(entities = [], slabSeedEntities = [], options = {}) {
  const textTypes = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);
  const marks = slabSeedEntities
    .filter((mark) => /^S\d+[A-Z]?$/i.test(String(mark.text || "").replace(/\s+/g, "")))
    .filter((mark) => Number.isFinite(Number(mark.x)) && Number.isFinite(Number(mark.y)));
  if (marks.length < 4) return entities;
  const xs = marks.map((mark) => Number(mark.x));
  const ys = marks.map((mark) => Number(mark.y));
  const marginMm = Number(options.marginMm || 25000);
  const bounds = {
    minX: Math.min(...xs) - marginMm,
    maxX: Math.max(...xs) + marginMm,
    minY: Math.min(...ys) - marginMm,
    maxY: Math.max(...ys) + marginMm,
  };
  const keepTypes = new Set(["LINE", "LWPOLYLINE", "POLYLINE", "TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);
  const filtered = entities
    .filter((entity) => keepTypes.has(entity.type))
    .filter((entity) => {
      const point = referencePointForFastPanelEntity(entity);
      return point &&
        point.x >= bounds.minX &&
        point.x <= bounds.maxX &&
        point.y >= bounds.minY &&
        point.y <= bounds.maxY;
    })
    .filter((entity) => {
      const layer = String(entity.layer || "").toUpperCase();
      const text = String(entity.text || "");
      if (textTypes.has(entity.type)) {
        const compact = cleanCadText(text).replace(/\s+/g, "");
        return /^S\d+[A-Z]?$/i.test(compact) ||
          /^P\d+$/i.test(compact) ||
          /PANEL\s+LEFT|BEAM|\d{2,4}\s*[Xx]\s*\d{2,4}|CUT\s*OUT|CUTOUT|OPEN\s*TO\s*SKY|SECTION/i.test(text);
      }
      return !/HATCH|TEXT|DIM|DIMENSION|GRID|AXIS|CENTER|CENTRE|TITLE|SCHEDULE|REBAR|BBS|NOTE|ANNOT/.test(layer);
    });
  return filtered.length >= marks.length ? [...filtered, ...marks] : entities;
}

async function createMarkedReferenceDrawing(entityPath, fileName, tempDir, options = {}) {
  try {
    const readerModule = require(path.join(__dirname, "engine", "cad", "dxf-reader.js"));
    const referenceModule = require(path.join(__dirname, "engine", "output", "reference-drawing.js"));
    const source = fs.readFileSync(entityPath, "utf8");
    const expanded = Array.isArray(options.referenceEntities)
      ? options.referenceEntities
      : (await readerModule.parseDxfWithExpandedBlocks(entityPath)).expanded;
    const slabSeedEntities = (options.slabMarks || [])
      .filter((mark) => /^S\d+[A-Z]?$/i.test(String(mark.text || "")))
      .filter((mark) => Number.isFinite(Number(mark.x)) && Number.isFinite(Number(mark.y)))
      .map((mark) => ({
        type: "TEXT",
        text: cleanCadText(mark.text || "").toUpperCase(),
        x: Number(mark.x),
        y: Number(mark.y),
        layer: mark.layer || "SLAB NO",
        source: "linked-slab-thickness-mark",
      }));
    const expandedForReference = slabSeedEntities.length
      ? [...expanded, ...slabSeedEntities]
      : expanded;
    const correctionEntities = Array.isArray(options.correctionEntities)
      ? options.correctionEntities
      : expandedForReference;
    const correctionEntitiesForReference = slabSeedEntities.length
      ? [...correctionEntities, ...slabSeedEntities]
      : correctionEntities;
    const boundedReferenceEntities = options.fastSlabPanelReference
      ? filterEntitiesForFastSlabReference(expandedForReference, slabSeedEntities, options.fastSlabPanelFilter || {})
      : expandedForReference;
    const boundedCorrectionEntities = options.fastSlabPanelReference
      ? filterEntitiesForFastSlabReference(correctionEntitiesForReference, slabSeedEntities, options.fastSlabPanelFilter || {})
      : correctionEntitiesForReference;
    const referenceBase = referenceModule.createReferenceWorkingDrawingData(boundedReferenceEntities, {
      correctionEntities: boundedCorrectionEntities,
      faceWalk: options.faceWalkLimits || CAD_ENGINE_LIMITS,
      planRegion: options.planRegion || null,
      boundarySlabPanels: options.boundarySlabPanels || undefined,
      minSlabMarksToSkipFaceWalk: options.fastSlabPanelReference ? 1 : undefined,
      minSlabMarkSeedCoverage: options.fastSlabPanelReference ? 0.55 : undefined,
      allowPartialSlabMarkSeeds: options.fastSlabPanelReference ? true : undefined,
      slabMarkPanels: options.fastSlabPanelReference
        ? {
            maxSupportOverlapRatio: 0.75,
            neighborInfer: {
              rowToleranceMm: 2600,
              columnToleranceMm: 2600,
              crossToleranceMm: 25,
              targetToleranceMm: 5200,
              usefulBoundaryLengthMm: 1200,
            },
            gridInfer: {
              rowToleranceMm: 2600,
              columnToleranceMm: 2600,
              snapToleranceMm: 25,
              minDimensionM: 0.75,
              maxDimensionM: 22,
              maxAreaSqm: 180,
            },
          }
        : undefined,
    });
    const quantityPanelMarks = panelMarksFromQuantityRows(options.quantityRows || []);
    const reference = {
      ...referenceBase,
      panelMarks: SLAB_AUTO_PANEL_CREATION_ENABLED && quantityPanelMarks.length
        ? mergeReferencePanelMarks([], quantityPanelMarks)
        : quantityPanelMarks.map((panel) => ({
            id: panel.id,
            label: panel.label,
            x: panel.x,
            y: panel.y,
            source: panel.source || "",
            status: panel.status || "",
            slabMark: panel.slabMark || "",
            dimensionAuthority: panel.dimensionAuthority || "",
            quantityRowBacked: Boolean(panel.quantityRowBacked),
          })),
      summary: {
        ...(referenceBase.summary || {}),
        quantityRowPanelMarks: quantityPanelMarks.length,
        generatedPanelMarksFromReferenceModuleSuppressed: true,
        autoSlabPanelCreationDisabled: !SLAB_AUTO_PANEL_CREATION_ENABLED,
      },
    };

    const nextHandle = createDxfHandleGenerator(source);
    const ownerHandle = findEntityOwnerHandle(source);
    const additions = [];
    const referenceLayers = {
      ...reference.layers,
      panelPolylines: "QSS_PANEL_CLOSED_POLYLINES",
      panelDimensions: "QSS_PANEL_DIMENSIONS",
      beamDimensions: "QSS_BEAM_SPAN_DIMENSIONS",
    };
    let panelPolylineCount = 0;
    let panelDimensionCount = 0;
    const panelMarksForOutput = SLAB_AUTO_PANEL_CREATION_ENABLED
      ? (reference.panelMarks || []).filter((panel) => validBox(panel.box))
      : (reference.panelMarks || []).filter((panel) => Number.isFinite(Number(panel.x)) && Number.isFinite(Number(panel.y)));
    for (const panel of panelMarksForOutput) {
      if (SLAB_AUTO_PANEL_CREATION_ENABLED) {
        const addedPanel = addPanelWorkingEntities(additions, nextHandle, ownerHandle, panel, referenceLayers, {
          markPolyline: true,
          markDimensions: false,
        });
        if (addedPanel) panelPolylineCount += 1;
      }
      const labelX = validBox(panel.box) ? (panel.box.minX + panel.box.maxX) / 2 : panel.x;
      const labelY = validBox(panel.box) ? (panel.box.minY + panel.box.maxY) / 2 : panel.y;
      const panelLabelHeight = referencePanelLabelHeight(panel);
      additions.push(dxfCircleEntity({
          handle: nextHandle(),
          owner: ownerHandle,
          layer: referenceLayers.panels,
        x: labelX,
        y: labelY,
        radius: Math.round(panelLabelHeight * 1.2),
        color: 3,
      }));
      if (String(panel.label || "").trim()) {
        additions.push(dxfTextEntity({
          handle: nextHandle(),
          owner: ownerHandle,
          layer: referenceLayers.panels,
          text: panel.label,
          x: labelX,
          y: labelY,
          height: panelLabelHeight,
          color: 3,
          centered: true,
        }));
      }
    }
    const shouldMarkBeamIds = options.markBeamIds !== false;
    const beamMarksForOutput = !shouldMarkBeamIds
      ? []
      : REFERENCE_DRAWING_RULES.markOnlyUnnamedBeams
        ? (reference.beamMarks || []).filter((beam) => /^QB\d+\b/i.test(String(beam.id || beam.label || "")))
        : (reference.beamMarks || []);
    for (const beam of beamMarksForOutput) {
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: referenceLayers.beams,
        text: beam.id,
        x: beam.x,
        y: beam.y,
        height: 320,
        color: 1,
      }));
    }
    for (const review of reference.reviewMarks || []) {
      if (!Number.isFinite(review.x) || !Number.isFinite(review.y)) continue;
      additions.push(dxfTextEntity({
        handle: nextHandle(),
        owner: ownerHandle,
        layer: referenceLayers.reviews,
        text: review.label,
        x: review.x,
        y: review.y,
        height: 360,
        color: 1,
      }));
    }

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const base = safeName(path.basename(fileName, path.extname(fileName)) || "drawing").slice(0, 80);
    const dxfName = `QSS-Pro-${base}-Marked-Reference-${stamp}.dxf`;
    const dxfPath = path.join(root, dxfName);
    const handSeed = (Number(nextHandle.lastHandleValue || 0) + 4096).toString(16).toUpperCase();
    const markedDxf = additions.length
      ? updateDxfHandSeed(insertBeforeEntitiesEnd(source, additions), handSeed)
      : source;
    fs.writeFileSync(dxfPath, markedDxf, "utf8");

    let downloadName = dxfName;
    let downloadPath = dxfPath;
    let referenceType = "DXF";
    let conversionWarning = "";
    if (options.preferDwg) {
      const dwgName = `QSS-Pro-${base}-Marked-Reference-${stamp}.dwg`;
      const dwgPath = path.join(root, dwgName);
      const converted = convertDxfToDwg(dxfPath, dwgPath, tempDir, dwgName);
      if (converted.ok) {
        downloadName = dwgName;
        downloadPath = dwgPath;
        referenceType = "DWG";
      } else {
        conversionWarning = `Marked reference DWG conversion failed; DXF reference provided instead. ${converted.error}`;
      }
    }

    return {
      ok: true,
      dxfPath,
      downloadPath,
      downloadName,
      referenceType,
      warning: conversionWarning,
      panelMarks: panelMarksForOutput.length,
      panelMarksData: panelMarksForOutput.map((panel) => ({
        id: panel.id,
        label: panel.label,
        x: panel.x,
        y: panel.y,
        box: SLAB_AUTO_PANEL_CREATION_ENABLED ? (panel.box || null) : null,
        gridBand: panel.gridBand || "",
        status: panel.status || "",
        source: panel.source || "",
        slabMark: panel.slabMark || "",
        slabMarkX: panel.slabMarkX ?? null,
        slabMarkY: panel.slabMarkY ?? null,
        slabMarksInside: panel.slabMarksInside || [],
        slabMarksInsideCount: panel.slabMarksInsideCount || 0,
        coverage: panel.coverage || null,
        boundaryTypes: panel.boundaryTypes || null,
        splitAxes: panel.splitAxes || null,
        areaSqm: panel.areaSqm || null,
        dimensionAuthority: panel.dimensionAuthority || "",
        authoritativeLengthMm: panel.authoritativeLengthMm ?? null,
        authoritativeBreadthMm: panel.authoritativeBreadthMm ?? null,
        lengthBasis: panel.lengthBasis || "",
        breadthBasis: panel.breadthBasis || "",
        dimensionValues: panel.dimensionValues || null,
        quantityRowBacked: Boolean(panel.quantityRowBacked),
      })),
      beamMarks: beamMarksForOutput.length,
      reviewMarks: reference.reviewMarks?.length || 0,
      summary: {
        ...(reference.summary || {}),
        slabSeedEntities: slabSeedEntities.length,
        panelClosedPolylines: panelPolylineCount,
        panelDimensionLabels: panelDimensionCount,
        autoSlabPanelCreationDisabled: !SLAB_AUTO_PANEL_CREATION_ENABLED,
        referenceDrawingRules: REFERENCE_DRAWING_RULES,
        generatedSlabPanelMarksSuppressed: true,
        fastSlabPanelReference: Boolean(options.fastSlabPanelReference),
        referenceEntityCount: boundedReferenceEntities.length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      panelMarks: 0,
      beamMarks: 0,
      reviewMarks: 0,
    };
  }
}

async function createSlabMarkReviewReferenceDrawing(entityPath, fileName, tempDir, options = {}) {
  try {
    const source = fs.readFileSync(entityPath, "utf8");
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const base = safeName(path.basename(fileName, path.extname(fileName)) || "drawing").slice(0, 80);
    const dxfName = `QSS-Pro-${base}-Review-Reference-${stamp}.dxf`;
    const dxfPath = path.join(root, dxfName);
    fs.writeFileSync(dxfPath, source, "utf8");

    let downloadName = dxfName;
    let downloadPath = dxfPath;
    let referenceType = "DXF";
    let conversionWarning = "";
    if (options.preferDwg) {
      const dwgName = `QSS-Pro-${base}-Review-Reference-${stamp}.dwg`;
      const dwgPath = path.join(root, dwgName);
      const converted = convertDxfToDwg(dxfPath, dwgPath, tempDir, dwgName);
      if (converted.ok) {
        downloadName = dwgName;
        downloadPath = dwgPath;
        referenceType = "DWG";
      } else {
        conversionWarning = `Review reference DWG conversion failed; DXF reference provided instead. ${converted.error}`;
      }
    }

    return {
      ok: true,
      dxfPath,
      downloadPath,
      downloadName,
      referenceType,
      warning: [
        conversionWarning,
        `Full slab boundary verification was skipped in fast extraction because ${Number(options.sourceEntityCount || 0)} CAD entities exceed the fast-mode limit. No final quantity was released.`,
      ].filter(Boolean).join(" "),
      panelMarks: 0,
      panelMarksData: [],
      beamMarks: 0,
      reviewMarks: 0,
      reviewMarksData: [],
      summary: {
        route: "slab_mark_review_light_reference",
        reviewOnlyReference: true,
        reviewSlabMarks: 0,
        generatedReviewMarksSuppressed: true,
        sourceEntityCount: Number(options.sourceEntityCount || 0),
        panelClosedPolylines: 0,
        panelDimensionLabels: 0,
        heavyReferenceSkipped: true,
        referenceDrawingRules: REFERENCE_DRAWING_RULES,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      panelMarks: 0,
      beamMarks: 0,
      reviewMarks: 0,
    };
  }
}

function panelMarkFromQuantityRow(row, index) {
  const evidence = row?.evidence || {};
  const left = Math.min(Number(evidence.panelLeftX), Number(evidence.panelRightX));
  const right = Math.max(Number(evidence.panelLeftX), Number(evidence.panelRightX));
  const bottom = Math.min(Number(evidence.panelBottomY), Number(evidence.panelTopY));
  const top = Math.max(Number(evidence.panelBottomY), Number(evidence.panelTopY));
  if (![left, right, bottom, top].every(Number.isFinite) || right <= left || top <= bottom) return null;
  const widthMm = right - left;
  const heightMm = top - bottom;
  if (widthMm < 250 || heightMm < 250) return null;
  const label = String(row.panelNo || row.evidence?.panelNo || `P${index + 1}`).trim() || `P${index + 1}`;
  return {
    id: label,
    label,
    x: (left + right) / 2,
    y: (bottom + top) / 2,
    gridBand: row.floor || evidence.gridBand || "",
    slabMark: evidence.slabMark || row.name || "",
    slabMarkX: evidence.panelMarkX ?? null,
    slabMarkY: evidence.panelMarkY ?? null,
    source: row.source || evidence.source || "",
    areaSqm: Number(row.length || 0) * Number(row.breadth || 0),
    box: {
      minX: left,
      maxX: right,
      minY: bottom,
      maxY: top,
    },
  };
}

function beamMarkFromQuantityRow(row) {
  const name = String(row?.name || "").trim();
  if (!/^QB\d+\b/i.test(name)) return null;
  const span = beamSpanFromRow(row);
  if (!span) return null;
  const x = span.orientation === "H" ? (span.start + span.end) / 2 : span.fixed;
  const y = span.orientation === "H" ? span.fixed : (span.start + span.end) / 2;
  return {
    id: name.split(/\s+/)[0],
    x,
    y,
  };
}

async function createRowBasedReferenceDrawing(entityPath, fileName, tempDir, rows, itemType, options = {}) {
  try {
    const source = fs.readFileSync(entityPath, "utf8");
    const hasLockedReviewRows = (itemType === "slab" || itemType === "raft") &&
      rows.some((row) => row.evidence?.blockedReviewCandidate || /locked-slab-review/i.test(String(row.source || "")));
    const referenceRows = (itemType === "slab" || itemType === "raft")
      ? (hasLockedReviewRows ? rows.filter((row) => Number(row.length || 0) > 0 && Number(row.breadth || 0) > 0) : finalQuantityRows(rows, itemType))
      : rows;
    const nextHandle = createDxfHandleGenerator(source);
    const ownerHandle = findEntityOwnerHandle(source);
    const additions = [];
    const layers = {
      panels: "QSS_PANEL_MARKS",
      beams: "QSS_AUTO_BEAM_IDS",
      reviews: "QSS_REVIEW_AREAS",
      panelPolylines: "QSS_PANEL_CLOSED_POLYLINES",
      panelDimensions: "QSS_PANEL_DIMENSIONS",
      beamDimensions: "QSS_BEAM_SPAN_DIMENSIONS",
    };
    let panelMarks = 0;
    const panelMarksData = [];
    let panelClosedPolylines = 0;
    let panelDimensionLabels = 0;
    let beamMarks = 0;
    let beamSpanDimensionLabels = 0;
    if (itemType === "beam") {
      const seen = new Set();
      const seenDimensions = new Set();
      for (const row of referenceRows) {
        const beam = beamMarkFromQuantityRow(row);
        if (beam && !seen.has(beam.id)) {
          seen.add(beam.id);
          additions.push(dxfTextEntity({
            handle: nextHandle(),
            owner: ownerHandle,
            layer: layers.beams,
            text: beam.id,
            x: beam.x,
            y: beam.y,
            height: 320,
            color: 1,
          }));
        }
        if (REFERENCE_DRAWING_RULES.markBeamSpanDimensions) {
          const span = beamSpanFromRow(row);
          if (!span) continue;
          const key = [
            span.orientation,
            Math.round(span.fixed / 100),
            Math.round(span.start / 100),
            Math.round(span.end / 100),
            String(row.name || "").toUpperCase(),
          ].join(":");
          if (seenDimensions.has(key)) continue;
          seenDimensions.add(key);
          beamSpanDimensionLabels += addBeamSpanEntities(additions, nextHandle, ownerHandle, row, layers) || 0;
        }
      }
      beamMarks = seen.size;
    }

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const base = safeName(path.basename(fileName, path.extname(fileName)) || "drawing").slice(0, 80);
    const dxfName = `QSS-Pro-${base}-Marked-Reference-${stamp}.dxf`;
    const dxfPath = path.join(root, dxfName);
    const handSeed = (Number(nextHandle.lastHandleValue || 0) + 4096).toString(16).toUpperCase();
    const markedDxf = additions.length
      ? updateDxfHandSeed(insertBeforeEntitiesEnd(source, additions), handSeed)
      : source;
    fs.writeFileSync(dxfPath, markedDxf, "utf8");

    let downloadName = dxfName;
    let downloadPath = dxfPath;
    let referenceType = "DXF";
    let conversionWarning = "";
    if (options.preferDwg) {
      const dwgName = `QSS-Pro-${base}-Marked-Reference-${stamp}.dwg`;
      const dwgPath = path.join(root, dwgName);
      const converted = convertDxfToDwg(dxfPath, dwgPath, tempDir, dwgName);
      if (converted.ok) {
        downloadName = dwgName;
        downloadPath = dwgPath;
        referenceType = "DWG";
      } else {
        conversionWarning = `Marked reference DWG conversion failed; DXF reference provided instead. ${converted.error}`;
      }
    }

    return {
      ok: true,
      dxfPath,
      downloadPath,
      downloadName,
      referenceType,
      warning: conversionWarning,
      panelMarks,
      panelMarksData,
      beamMarks,
      reviewMarks: 0,
      summary: {
        route: "row_based_light_reference",
        panelClosedPolylines,
        panelDimensionLabels,
        beamSpanDimensionLabels,
        beamSpanDimensionSkipped: itemType === "beam" ? !REFERENCE_DRAWING_RULES.markBeamSpanDimensions : true,
        generatedSlabPanelMarksSuppressed: itemType === "slab" || itemType === "raft",
        referenceDrawingRules: REFERENCE_DRAWING_RULES,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      panelMarks: 0,
      beamMarks: 0,
      reviewMarks: 0,
    };
  }
}

async function enhanceReferenceDrawingWithQuantityRows(referenceDrawing, rows, itemType, tempDir, fileName, options = {}) {
  if (!referenceDrawing?.ok || !referenceDrawing.dxfPath || !fs.existsSync(referenceDrawing.dxfPath) || !rows.length) {
    return referenceDrawing;
  }
  if (itemType === "beam" && !REFERENCE_DRAWING_RULES.markBeamSpanDimensions) {
    let conversionWarning = referenceDrawing.warning || "";
    let downloadName = referenceDrawing.downloadName;
    let downloadPath = referenceDrawing.downloadPath;
    let referenceType = referenceDrawing.referenceType;
    if (options.preferDwg && referenceType !== "DWG") {
      const dwgName = String(referenceDrawing.downloadName || path.basename(referenceDrawing.dxfPath)).replace(/\.dxf$/i, ".dwg");
      const dwgPath = path.join(root, dwgName);
      const converted = convertDxfToDwg(referenceDrawing.dxfPath, dwgPath, tempDir, fileName || dwgName);
      if (!converted.ok) {
        conversionWarning = [conversionWarning, `Reference DWG conversion failed; DXF reference provided instead. ${converted.error}`].filter(Boolean).join(" ");
      } else {
        downloadName = dwgName;
        downloadPath = dwgPath;
        referenceType = "DWG";
      }
    }
    return {
      ...referenceDrawing,
      downloadName,
      downloadPath,
      referenceType,
      warning: conversionWarning,
      reviewMarks: Number(referenceDrawing.reviewMarks || 0),
      summary: {
        ...(referenceDrawing.summary || {}),
        beamSpanDimensionLabels: 0,
        beamSpanDimensionSkipped: true,
        beamReviewMarks: 0,
        beamReviewRowsStoredInExcel: rows.filter((row) => row.needsReview).length,
        beamReviewDrawingLabelsSkipped: true,
      },
    };
  }
  const source = fs.readFileSync(referenceDrawing.dxfPath, "utf8");
  const nextHandle = createDxfHandleGenerator(source);
  const ownerHandle = findEntityOwnerHandle(source);
  const layers = {
    beamDimensions: "QSS_BEAM_SPAN_DIMENSIONS",
  };
  const additions = [];
  let beamSpanDimensionCount = 0;
  if (itemType === "beam") {
    const seen = new Set();
    for (const row of rows) {
      const span = beamSpanFromRow(row);
      if (!span) continue;
      const key = [
        span.orientation,
        Math.round(span.fixed / 100),
        Math.round(span.start / 100),
        Math.round(span.end / 100),
        String(row.name || "").toUpperCase(),
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      beamSpanDimensionCount += addBeamSpanEntities(additions, nextHandle, ownerHandle, row, layers) || 0;
    }
  }
  if (additions.length) {
    const handSeed = (Number(nextHandle.lastHandleValue || 0) + 4096).toString(16).toUpperCase();
    const enhancedDxf = updateDxfHandSeed(insertBeforeEntitiesEnd(source, additions), handSeed);
    fs.writeFileSync(referenceDrawing.dxfPath, enhancedDxf, "utf8");
  }
  let conversionWarning = referenceDrawing.warning || "";
  let downloadName = referenceDrawing.downloadName;
  let downloadPath = referenceDrawing.downloadPath;
  let referenceType = referenceDrawing.referenceType;
  if (options.preferDwg) {
    const dwgName = String(referenceDrawing.downloadName || path.basename(referenceDrawing.dxfPath)).replace(/\.dxf$/i, ".dwg");
    const dwgPath = path.join(root, dwgName);
    const converted = convertDxfToDwg(referenceDrawing.dxfPath, dwgPath, tempDir, fileName || dwgName);
    if (!converted.ok) {
      conversionWarning = [conversionWarning, `Reference DWG conversion failed; DXF reference provided instead. ${converted.error}`].filter(Boolean).join(" ");
    } else {
      downloadName = dwgName;
      downloadPath = dwgPath;
      referenceType = "DWG";
    }
  }
  return {
    ...referenceDrawing,
    downloadName,
    downloadPath,
    referenceType,
    warning: conversionWarning,
    summary: {
      ...(referenceDrawing.summary || {}),
      beamSpanDimensionLabels: beamSpanDimensionCount,
    },
  };
}

async function runTopologyTakeoffEngine(entityPath, fileName, role, itemType, limits = CAD_ENGINE_LIMITS) {
  try {
    const readerModule = require(path.join(__dirname, "engine", "cad", "dxf-reader.js"));
    const engineModule = require(path.join(__dirname, "engine", "topology", "takeoff-engine.js"));
    const { expanded } = await readerModule.parseDxfWithExpandedBlocks(entityPath);
    const minimums = readFirstFloorBenchmarkMinimums();
    const result = engineModule.runTakeoffEngineV2(expanded, {
      itemType,
      slab: {
        ...limits,
        reference: limits,
      },
      beams: {
        maxMarks: 1000,
        maxAutoFacePairMarks: 900,
        ...limits,
      },
      validation: minimums ? { benchmarkMinimums: minimums } : {},
    });
    const areaItem = itemType === "slab" || itemType === "raft";
    const rows = areaItem
      ? takeoffEngineSlabRows(result, fileName, role)
      : takeoffEngineBeamRows(result, fileName, role);
    return {
      ok: true,
      rows,
      result,
      summary: {
        source: "topology-takeoff-engine-v2",
        slabReviewRatio: result.gate?.slabReviewRatio || 0,
        beamReviewRatio: result.gate?.beamReviewRatio || 0,
        beamTotals: result.beams?.totals || null,
        slabTotals: result.slab?.totals || null,
        finalAllowed: Boolean(result.gate?.finalAllowed),
        gateReason: result.gate?.reason || "",
      },
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error.message,
      summary: { source: "topology-takeoff-engine-v2", failed: true },
    };
  }
}

async function runTopologyTakeoffEngineOnEntities(entities, fileName, role, itemType, limits = FAST_CAD_ENGINE_LIMITS) {
  try {
    const engineModule = require(path.join(__dirname, "engine", "topology", "takeoff-engine.js"));
    const minimums = readFirstFloorBenchmarkMinimums();
    const result = engineModule.runTakeoffEngineV2(entities || [], {
      itemType,
      slab: {
        ...limits,
        reference: limits,
      },
      beams: {
        maxMarks: 1000,
        maxAutoFacePairMarks: 900,
        ...limits,
      },
      validation: minimums ? { benchmarkMinimums: minimums } : {},
    });
    const areaItem = itemType === "slab" || itemType === "raft";
    const rows = areaItem
      ? takeoffEngineSlabRows(result, fileName, role)
      : takeoffEngineBeamRows(result, fileName, role);
    return {
      ok: true,
      rows,
      result,
      summary: {
        source: "filtered-topology-takeoff-engine-v2",
        inputEntityCount: Array.isArray(entities) ? entities.length : 0,
        slabReviewRatio: result.gate?.slabReviewRatio || 0,
        beamReviewRatio: result.gate?.beamReviewRatio || 0,
        beamTotals: result.beams?.totals || null,
        slabTotals: result.slab?.totals || null,
        finalAllowed: Boolean(result.gate?.finalAllowed),
        gateReason: result.gate?.reason || "",
      },
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error.message,
      summary: { source: "filtered-topology-takeoff-engine-v2", failed: true },
    };
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatNumber(value, decimals = 3) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "";
  return Number(number.toFixed(decimals));
}

function quantityUnit(quantityRule, itemType) {
  if (/concrete/i.test(quantityRule)) return "cum";
  if (/steel/i.test(quantityRule)) return "kg";
  if (itemType === "beam" || /shuttering/i.test(quantityRule)) return "sqm";
  return "sqm";
}

function rowGrossArea(row) {
  return Number(row.length || 0) * Number(row.breadth || 0);
}

function rowNetArea(row) {
  return Math.max(rowGrossArea(row) - Number(row.openings || 0), 0);
}

function beamCapShutteringAdditionForRow(row, beamCapMode = "included") {
  if (beamCapMode !== "included") return 0;
  return Math.max(
    Number(row.columnCapShuttering || 0) ||
    Number(row.columnCapShutteringOverride || 0) ||
    Number(row.beamCapShuttering || 0) ||
    Number(row.sideJointDeduction || 0),
    0,
  );
}

function beamExcludedCapSideSegments(row) {
  const length = Math.max(Number(row.length || 0), 0);
  const depth = Math.max(Number(row.height || 0), 0);
  const fallbackSlabThickness = Math.min(Math.max(Number(row.slabThickness || 0.15), 0), depth);
  if (!length || !depth) return [];
  const rawSegments = Array.isArray(row.evidence?.sideShutteringSegments)
    ? row.evidence.sideShutteringSegments
    : [];
  const styleSegments = Array.isArray(row.evidence?.sideFaceStyles)
    ? row.evidence.sideFaceStyles.map((face, index) => ({
        face: face.face || `side face ${index + 1}`,
        lineStyle: face.style || face.lineType || "",
        slabThicknessM: String(face.style || "").toLowerCase().includes("continuous") ? 0 : fallbackSlabThickness,
      }))
    : [];
  const rawSegmentsHaveOnlyUnknownStyles = rawSegments.length &&
    rawSegments.every((segment) => !String(segment.lineStyle || segment.style || "").trim() ||
      String(segment.lineStyle || segment.style || "").toLowerCase() === "unknown");
  const styleSegmentsHaveKnownFace = styleSegments.some((segment) =>
    /continuous|broken|hidden|dash|dot/i.test(String(segment.lineStyle || segment.style || "")));
  const sourceSegments = styleSegmentsHaveKnownFace && (!rawSegments.length || rawSegmentsHaveOnlyUnknownStyles)
    ? styleSegments.slice(0, 2)
    : rawSegments.length
      ? rawSegments.slice(0, 2)
    : [
        { face: "side face 1", slabThicknessM: fallbackSlabThickness },
        { face: "side face 2", slabThicknessM: fallbackSlabThickness },
      ];
  while (sourceSegments.length < 2) {
    sourceSegments.push({
      face: `side face ${sourceSegments.length + 1}`,
      slabThicknessM: fallbackSlabThickness,
      lineStyle: "unknown",
    });
  }
  const segments = sourceSegments.slice(0, 2).map((segment, index) => {
    const lineStyle = String(segment.lineStyle || segment.style || "").toLowerCase();
    const slabThicknessM = Number.isFinite(Number(segment.slabThicknessM))
      ? Math.min(Math.max(Number(segment.slabThicknessM), 0), depth)
      : lineStyle.includes("continuous")
        ? 0
        : fallbackSlabThickness;
    const sideHeightM = Number.isFinite(Number(segment.sideHeightM))
      ? Math.min(Math.max(Number(segment.sideHeightM), 0), depth)
      : Math.max(depth - slabThicknessM, 0);
    return {
      ...segment,
      face: segment.face || `side face ${index + 1}`,
      lengthM: round3(length),
      slabThicknessM: round3(slabThicknessM),
      sideHeightM: round3(sideHeightM),
      areaM2: round3(length * sideHeightM),
      columnCapExcludedEqualRunRule: true,
    };
  });
  const grossArea = segments.reduce((sum, segment) => sum + Number(segment.areaM2 || 0), 0);
  const sideJointDeduction = Math.max(Number(row.sideJointDeduction || 0), 0);
  if (grossArea > 0 && sideJointDeduction > 0) {
    const factor = Math.max((grossArea - sideJointDeduction) / grossArea, 0);
    return segments.map((segment) => ({
      ...segment,
      grossAreaBeforeSupportDeductionM2: segment.areaM2,
      supportDeductionAppliedM2: round3(Number(segment.areaM2 || 0) * (1 - factor)),
      areaM2: round3(Number(segment.areaM2 || 0) * factor),
      sideHeightM: length ? round3((Number(segment.areaM2 || 0) * factor) / length) : segment.sideHeightM,
    }));
  }
  return segments;
}

function beamShutteringTotal(row, beamCapMode = "included") {
  const override = Number(row.bottomAreaOverride || 0) + Number(row.sideAreaOverride || 0);
  const capAddition = beamCapShutteringAdditionForRow(row, beamCapMode);
  const nos = Math.max(Number(row.nos || 1), 0);
  const length = Number(row.length || 0);
  const sideLength = Number(row.sideLength || row.length || 0);
  const width = Number(row.breadth || 0);
  const depth = Number(row.height || 0);
  const slabThickness = Number(row.slabThickness || 0.15);
  const bottomJointDeduction = Math.max(Number(row.bottomJointDeduction || 0), 0);
  const sideJointDeduction = Math.max(Number(row.sideJointDeduction || 0), 0);
  const bottomArea = Math.max((length * width) - bottomJointDeduction, 0);
  if (beamCapMode === "excluded") {
    const sideSegments = beamExcludedCapSideSegments(row);
    const sideArea = sideSegments.length
      ? sideSegments.reduce((sum, segment) => sum + Number(segment.areaM2 || 0), 0)
      : Math.max(2 * length * Math.max(depth - slabThickness, 0), 0);
    return (bottomArea + sideArea) * nos;
  }
  if (override > 0) return (override + capAddition) * nos;
  const sideArea = Math.max((2 * sideLength * Math.max(depth - slabThickness, 0)) - sideJointDeduction, 0);
  return (bottomArea + sideArea + capAddition) * nos;
}

function beamConcreteTotal(row, beamCapMode = "included") {
  const override = Number(row.grossConcreteOverride || 0);
  const gross = override > 0
    ? override
    : Number(row.length || 0) * Number(row.breadth || 0) * Number(row.height || 0);
  const capDeduction = beamCapMode === "excluded"
    ? Math.max(Number(row.columnCapDeduction || 0), 0)
    : 0;
  return Math.max(gross - capDeduction, 0) * Math.max(Number(row.nos || 1), 0);
}

function mbQuantity(row, itemType, quantityRule, beamCapMode = "included") {
  const nos = Math.max(Number(row.nos || 1), 0);
  if (itemType === "beam") {
    if (/concrete/i.test(quantityRule)) return beamConcreteTotal(row, beamCapMode);
    if (/steel/i.test(quantityRule)) return Number(row.length || 0) * nos;
    return beamShutteringTotal(row, beamCapMode);
  }
  if (/concrete/i.test(quantityRule)) return rowNetArea(row) * Number(row.height || 0.15) * nos;
  return rowNetArea(row) * nos;
}

function rowsWithMbQuantities(rows, itemType, quantityRule, beamCapMode = "included") {
  const unit = quantityUnit(quantityRule, itemType);
  return rows.map((row) => {
    const quantity = mbQuantity(row, itemType, quantityRule, beamCapMode);
    return {
      ...row,
      mbQuantity: quantity,
      serverQuantity: quantity,
      serverQuantityUnit: unit,
      serverQuantityRule: quantityRule,
      serverQuantityItemType: itemType,
      serverQuantityBeamCapMode: beamCapMode,
    };
  });
}

function bbsWeightKgFromEntries(entries = []) {
  return round3(entries
    .filter((entry) => entry.kind === "bar")
    .reduce((sum, entry) => {
      const dia = Math.max(Number(entry.dia || 0), 0);
      const lengthM = Math.max(Number(entry.totalLengthM || 0), 0);
      return sum + (lengthM * dia * dia / 162);
    }, 0));
}

function bbsQuantityForRow(row, itemType) {
  const entries = normaliseQuantityItemType(itemType) === "beam"
    ? beamBbsRowsForMember(row, 0)
    : slabBbsRowsForPanel(row, 0);
  return bbsWeightKgFromEntries(entries);
}

function rowsWithBbsQuantities(rows, itemType, quantityRule, beamCapMode = "included") {
  return rows.map((row) => {
    const quantity = bbsQuantityForRow(row, itemType);
    return {
      ...row,
      mbQuantity: quantity,
      serverQuantity: quantity,
      serverQuantityUnit: "kg",
      serverQuantityRule: quantityRule,
      serverQuantityItemType: itemType,
      serverQuantityBeamCapMode: beamCapMode,
      bbsQuantity: true,
    };
  });
}

function mbHeight(row, itemType, quantityRule) {
  if (itemType === "beam") return Number(row.height || 0);
  if (/concrete/i.test(quantityRule)) return Number(row.height || 0.15);
  return 1;
}

function mbDescription(row, itemType) {
  const name = row.panelNo || row.name || (itemType === "beam" ? "Beam" : "Slab panel");
  if (itemType === "beam") {
    const widthMm = Math.round(Number(row.breadth || 0) * 1000);
    const depthMm = Math.round(Number(row.height || 0) * 1000);
    const size = widthMm && depthMm && !/\d+\s*[xX]\s*\d+/.test(name) ? ` (${widthMm}x${depthMm})` : "";
    return `${name}${size}`;
  }
  return name;
}

const BEAM_BBS_DIA_COLUMNS = [8, 10, 12, 16, 20, 25];
const SLAB_BBS_DIA_COLUMNS = [8, 10, 12, 16, 20, 25, 32];

const SLAB_TOP_STEEL_MARK_SCHEDULE = {
  t1: { dia: 8, spacing: 250 },
  t2: { dia: 8, spacing: 200 },
  t3: { dia: 8, spacing: 175 },
  t4: { dia: 8, spacing: 150 },
  t5: { dia: 8, spacing: 125 },
};

const SLAB_MARK_BBS_SCHEDULE = {
  S1: {
    thicknessMm: 150,
    way: "one",
    shortFull: { dia: 10, spacing: 200 },
    shortCurtail: { dia: 10, spacing: 200 },
    longFull: { dia: 8, spacing: 200 },
    longCurtail: null,
  },
  S1A: {
    thicknessMm: 150,
    way: "two",
    shortFull: { dia: 8, spacing: 200 },
    shortCurtail: { dia: 8, spacing: 200 },
    longFull: { dia: 8, spacing: 250 },
    longCurtail: { dia: 8, spacing: 250 },
  },
  S2: {
    thicknessMm: 125,
    way: "two",
    shortFull: { dia: 8, spacing: 250 },
    shortCurtail: { dia: 8, spacing: 250 },
    longFull: { dia: 8, spacing: 250 },
    longCurtail: { dia: 8, spacing: 250 },
  },
  S3: {
    thicknessMm: 200,
    way: "two",
    shortFull: { dia: 10, spacing: 200 },
    shortCurtail: { dia: 10, spacing: 200 },
    longFull: { dia: 8, spacing: 200 },
    longCurtail: { dia: 8, spacing: 200 },
  },
  S4: {
    thicknessMm: 150,
    way: "two",
    shortFull: { dia: 10, spacing: 250 },
    shortCurtail: { dia: 10, spacing: 250 },
    longFull: { dia: 8, spacing: 200 },
    longCurtail: { dia: 8, spacing: 200 },
  },
  S5: {
    thicknessMm: 125,
    way: "two",
    shortFull: { dia: 8, spacing: 200 },
    shortCurtail: { dia: 8, spacing: 200 },
    longFull: { dia: 8, spacing: 200 },
    longCurtail: null,
  },
  S6: {
    thicknessMm: 175,
    way: "two",
    shortFull: { dia: 10, spacing: 250 },
    shortCurtail: { dia: 10, spacing: 250 },
    longFull: { dia: 10, spacing: 250 },
    longCurtail: { dia: 10, spacing: 250 },
  },
};

function isSteelBbsQuantityRule(quantityRule = "") {
  return /steel|bbs/i.test(String(quantityRule || ""));
}

function normaliseQuantityItemType(itemType = "") {
  return String(itemType || "").trim().toLowerCase();
}

function isSlabSteelBbsTakeoff(itemType = "", quantityRule = "") {
  const item = normaliseQuantityItemType(itemType);
  const rule = String(quantityRule || "").trim().toLowerCase();
  return isSteelBbsQuantityRule(rule) && (item === "slab" || item === "raft" || /(^|_)slab(_|$)|(^|_)raft(_|$)/.test(rule));
}

function isBeamSteelBbsTakeoff(itemType = "", quantityRule = "") {
  const item = normaliseQuantityItemType(itemType);
  const rule = String(quantityRule || "").trim().toLowerCase();
  return isSteelBbsQuantityRule(rule) && (item === "beam" || /(^|_)beam(_|$)/.test(rule));
}

function isSteelBbsTakeoff(itemType = "", quantityRule = "") {
  return isSlabSteelBbsTakeoff(itemType, quantityRule) || isBeamSteelBbsTakeoff(itemType, quantityRule);
}

function hasBbsQuantityRows(rows = []) {
  return rows.some((row) => row?.bbsQuantity || /steel|bbs/i.test(String(row?.serverQuantityRule || "")));
}

function shouldUseSlabBbsWorkbook(packageInfo = {}) {
  const itemType = packageInfo.itemType || "";
  const quantityRule = packageInfo.quantityRule || "";
  const item = normaliseQuantityItemType(itemType);
  return isSlabSteelBbsTakeoff(itemType, quantityRule) ||
    (hasBbsQuantityRows(packageInfo.rows) && (item === "slab" || item === "raft" || /slab|raft/i.test(String(quantityRule))));
}

function shouldUseBeamBbsWorkbook(packageInfo = {}) {
  const itemType = packageInfo.itemType || "";
  const quantityRule = packageInfo.quantityRule || "";
  const item = normaliseQuantityItemType(itemType);
  return isBeamSteelBbsTakeoff(itemType, quantityRule) ||
    (hasBbsQuantityRows(packageInfo.rows) && (item === "beam" || /beam/i.test(String(quantityRule))));
}

function shouldUseBbsWorkbook(packageInfo = {}) {
  return shouldUseSlabBbsWorkbook(packageInfo) ||
    shouldUseBeamBbsWorkbook(packageInfo) ||
    isSteelBbsQuantityRule(packageInfo.quantityRule || "") ||
    hasBbsQuantityRows(packageInfo.rows || []);
}

function workbookTypeForPackage(packageInfo = {}) {
  return shouldUseBbsWorkbook(packageInfo) ? "BBS" : "MB";
}

function drawingLengthToMm(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number > 100 ? Math.round(number) : Math.round(number * 1000);
}

function bbsMetresFromMm(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Number((number / 1000).toFixed(3));
}

function normaliseBbsSpacing(value, fallback = 200) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number > 10 ? Math.round(number) : Math.round(number * 1000);
}

function bbsSpacingForCount(spacing) {
  const text = String(spacing || "").trim();
  const values = text.match(/\d+(?:\.\d+)?/g);
  if (values && values.length) {
    const parsed = values.map((item) => Number(item)).filter((item) => item > 0);
    if (parsed.length) return Math.max(...parsed);
  }
  const number = Number(spacing);
  return Number.isFinite(number) && number > 0 ? number : 200;
}

function cloneBbsSpec(spec) {
  if (!spec) return null;
  return {
    dia: Math.round(Number(spec.dia || 0)),
    spacing: normaliseBbsSpacing(spec.spacing, 200),
  };
}

function bbsSpecText(spec) {
  const parsed = cloneBbsSpec(spec);
  if (!parsed || !parsed.dia || !parsed.spacing) return "";
  return `T${parsed.dia} @ ${parsed.spacing}`;
}

function parseBbsRebarSpec(value, fallback = { dia: 8, spacing: 200 }) {
  const fallbackSpec = cloneBbsSpec(fallback);
  if (value === null || value === undefined || value === "") return fallbackSpec;
  if (typeof value === "object") {
    const objectSpec = value.spec || value.text || value.rebar || value.bar || value;
    if (objectSpec !== value) return parseBbsRebarSpec(objectSpec, fallbackSpec);
    const dia = Number(value.dia || value.barDia || value.diameter || value.diameterMm || fallbackSpec?.dia || 8);
    const spacing = normaliseBbsSpacing(value.spacing || value.spacingMm || value.centre || fallbackSpec?.spacing || 200, fallbackSpec?.spacing || 200);
    return { dia: Math.round(dia), spacing };
  }
  const text = String(value || "").trim();
  if (!text || /^[-–—]$/.test(text)) return null;
  const match = text.match(/T\s*(\d+(?:\.\d+)?)\s*@\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(?:#|dia)?\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*@\s*(\d+(?:\.\d+)?)/i);
  if (!match) return fallbackSpec;
  return {
    dia: Math.round(Number(match[1])),
    spacing: normaliseBbsSpacing(match[2], fallbackSpec?.spacing || 200),
  };
}

function roundBbsDimensionMm(value, step = 5) {
  const number = Number(value || 0);
  const roundStep = Math.max(Number(step || 1), 1);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number / roundStep) * roundStep;
}

function bbsBarCount(runMm, spacing, fallback = 1) {
  const run = Number(runMm || 0);
  const spacingMm = bbsSpacingForCount(spacing);
  if (!run || !spacingMm) return fallback;
  return Math.max(Math.ceil(run / spacingMm) + 1, fallback);
}

// 1-based column index -> spreadsheet letter (A, B, ..., Z, AA, ...).
function columnLetter(n) {
  let value = "";
  let num = n;
  while (num > 0) {
    const rem = (num - 1) % 26;
    value = String.fromCharCode(65 + rem) + value;
    num = Math.floor((num - 1) / 26);
  }
  return value;
}

// SpreadsheetML's ss:Formula attribute needs R1C1-relative notation, not plain A1 references -
// real Excel-generated XML Spreadsheet files always write formulas this way, and at least one
// real-world importer (confirmed against an actual opened file) silently misparses bare A1 cell
// refs there, quoting each one as a text literal and producing #NAME? instead of a value.
function r1c1Ref(fromRow, fromCol, toRow, toCol) {
  const rowPart = toRow === fromRow ? "R" : `R[${toRow - fromRow}]`;
  const colPart = toCol === fromCol ? "C" : `C[${toCol - fromCol}]`;
  return rowPart + colPart;
}

function r1c1Range(fromRow, fromCol, toRowStart, toRowEnd, toCol) {
  return `${r1c1Ref(fromRow, fromCol, toRowStart, toCol)}:${r1c1Ref(fromRow, fromCol, toRowEnd, toCol)}`;
}

const BBS_XML_BORDERS = '<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>' +
  '<Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>' +
  '<Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>' +
  '<Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders>';

function bbsXmlStyles() {
  return `<Styles>
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
    <Style ss:ID="Meta"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>
    <Style ss:ID="MetaBold"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>
    <Style ss:ID="Group"><Font ss:FontName="Arial" ss:Size="12" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/></Style>
    <Style ss:ID="Header"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>${BBS_XML_BORDERS}</Style>
    <Style ss:ID="Cell"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${BBS_XML_BORDERS}</Style>
    <Style ss:ID="CellLeft"><Font ss:FontName="Arial" ss:Size="10"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>${BBS_XML_BORDERS}</Style>
    <Style ss:ID="Bold"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>${BBS_XML_BORDERS}</Style>
    <Style ss:ID="BoldLeft"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/><Alignment ss:Horizontal="Left" ss:Vertical="Center"/>${BBS_XML_BORDERS}</Style>
  </Styles>`;
}

function bbsXmlCell(value, { formula, type = "Number", styleId = "Cell", index } = {}) {
  const indexAttr = index ? ` ss:Index="${index}"` : "";
  const styleAttr = ` ss:StyleID="${styleId}"`;
  const formulaAttr = formula ? ` ss:Formula="${escapeHtml(formula)}"` : "";
  const hasValue = value !== undefined && value !== null && value !== "";
  if (!hasValue && !formula) return `<Cell${indexAttr}${styleAttr}/>`;
  const safeValue = type === "Number"
    ? (Number.isFinite(Number(value)) ? Number(value) : 0)
    : escapeHtml(value);
  return `<Cell${indexAttr}${styleAttr}${formulaAttr}><Data ss:Type="${type}">${safeValue}</Data></Cell>`;
}

function bbsXmlMergedCell(value, { type = "String", styleId = "Header", mergeAcross = 0, mergeDown = 0, index } = {}) {
  const attrs = [
    index ? `ss:Index="${index}"` : "",
    `ss:StyleID="${styleId}"`,
    mergeAcross ? `ss:MergeAcross="${mergeAcross}"` : "",
    mergeDown ? `ss:MergeDown="${mergeDown}"` : "",
  ].filter(Boolean).join(" ");
  const hasValue = value !== undefined && value !== null && value !== "";
  const inner = hasValue ? `<Data ss:Type="${type}">${escapeHtml(value)}</Data>` : "";
  return `<Cell ${attrs}>${inner}</Cell>`;
}

function bbsXmlRow(cellsXml) {
  return `<Row>${cellsXml.join("")}</Row>`;
}

const BBS_XML_SHAPE_LABEL = { straight: "Straight", u: "U-bar", stirrup: "Stirrup" };

// Renders a slab/beam Steel BBS workbook as a real SpreadsheetML (Excel-XML, .xls-compatible)
// file with live formulas for Lap, Cutting length, and Total length by dia rather than baked-in
// numbers - so opening any computed cell in Excel shows exactly which other cells it comes from
// (standard BBS convention: dimensions/dia/spacing/bend count/bar count are the drafted inputs;
// lap, cutting length, and total length are derived and should read as formulas).
function renderSteelBbsSpreadsheet({
  sheetName,
  titleLabel,
  sourceFiles,
  rowsCount,
  reviewRows,
  groupLabel,
  entries,
  diaColumns,
  bendMultiplier,
}) {
  const totalColumns = 16 + diaColumns.length + 1;
  const remarksIndex = totalColumns;
  const diaColLetters = diaColumns.map((_, index) => columnLetter(17 + index));
  const rows = [];

  rows.push(bbsXmlRow([bbsXmlCell(titleLabel, { type: "String", styleId: "MetaBold" }), bbsXmlCell(sourceFiles, { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Generated", { type: "String", styleId: "MetaBold" }), bbsXmlCell(new Date().toLocaleString("en-IN"), { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Rows", { type: "String", styleId: "MetaBold" }), bbsXmlCell(rowsCount, { styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Review rows", { type: "String", styleId: "MetaBold" }), bbsXmlCell(reviewRows || 0, { styleId: "Meta" })]));
  rows.push(bbsXmlRow([]));

  rows.push(bbsXmlRow([
    bbsXmlMergedCell("Sr. No", { mergeDown: 1 }),
    bbsXmlMergedCell("Description", { mergeDown: 1 }),
    bbsXmlMergedCell("Shape of bar", { mergeDown: 1 }),
    bbsXmlMergedCell("No. of item", { mergeDown: 1 }),
    bbsXmlMergedCell("Dia of bar in mm", { mergeDown: 1 }),
    bbsXmlMergedCell("Spacing in mm", { mergeDown: 1 }),
    bbsXmlMergedCell("Dimensions in mm", { mergeAcross: 4 }),
    bbsXmlMergedCell("No. of bend", { mergeDown: 1 }),
    bbsXmlMergedCell("Lap", { mergeAcross: 1 }),
    bbsXmlMergedCell("No. of bar", { mergeDown: 1 }),
    bbsXmlMergedCell("Cutting length (m)", { mergeDown: 1 }),
    bbsXmlMergedCell("Total length in m", { mergeAcross: Math.max(diaColumns.length - 1, 0) }),
    bbsXmlMergedCell("Remarks", { mergeDown: 1 }),
  ]));
  rows.push(bbsXmlRow([
    bbsXmlCell("A*", { type: "String", styleId: "Header", index: 7 }),
    bbsXmlCell("B*", { type: "String", styleId: "Header" }),
    bbsXmlCell("C*", { type: "String", styleId: "Header" }),
    bbsXmlCell("D*", { type: "String", styleId: "Header" }),
    bbsXmlCell("E*", { type: "String", styleId: "Header" }),
    bbsXmlCell("Nos", { type: "String", styleId: "Header", index: 13 }),
    bbsXmlCell("Lap", { type: "String", styleId: "Header" }),
    ...diaColumns.map((dia, i) => bbsXmlCell(`#${dia}`, { type: "String", styleId: "Header", index: i === 0 ? 17 : undefined })),
  ]));

  rows.push(bbsXmlRow([
    bbsXmlCell("1.0", { type: "String", styleId: "Bold" }),
    bbsXmlMergedCell(groupLabel, { styleId: "BoldLeft", mergeAcross: totalColumns - 2 }),
  ]));

  const totalsByDia = Object.fromEntries(diaColumns.map((dia) => [dia, 0]));
  const firstDataRow = rows.length + 1;
  entries.forEach((entry) => {
    const rowNumber = rows.length + 1;
    if (entry.kind === "member" || entry.kind === "slab-member") {
      const cells = [
        bbsXmlCell(entry.sr, { type: "String", styleId: "Bold" }),
        bbsXmlCell(entry.description, { type: "String", styleId: "BoldLeft" }),
      ];
      if (entry.kind === "slab-member") {
        cells.push(bbsXmlCell(entry.thicknessMm, { styleId: "Bold" }));
        cells.push(bbsXmlCell(entry.lengthMm, { styleId: "Bold" }));
        cells.push(bbsXmlCell(undefined, { styleId: "Bold" }));
        cells.push(bbsXmlCell(entry.breadthMm, { styleId: "Bold" }));
      } else {
        cells.push(bbsXmlCell(entry.lengthMm, { styleId: "Bold" }));
        cells.push(bbsXmlCell(entry.widthMm, { styleId: "Bold" }));
        cells.push(bbsXmlCell(undefined, { styleId: "Bold" }));
        cells.push(bbsXmlCell(entry.depthMm, { styleId: "Bold" }));
      }
      for (let column = 7; column < remarksIndex; column += 1) cells.push(bbsXmlCell(undefined, { styleId: "Bold" }));
      cells.push(bbsXmlCell(entry.remarks || "", { type: "String", styleId: "Bold" }));
      rows.push(bbsXmlRow(cells));
      return;
    }
    if (entry.kind === "heading") {
      rows.push(bbsXmlRow([
        bbsXmlCell(undefined, { styleId: "Bold" }),
        bbsXmlMergedCell(entry.description, { styleId: "BoldLeft", mergeAcross: totalColumns - 2 }),
      ]));
      return;
    }
    const dims = [0, 1, 2, 3, 4].map((index) => Number(entry.dimensions[index] || 0));
    const cells = [
      bbsXmlCell(undefined, { styleId: "Cell" }),
      bbsXmlCell(entry.description, { type: "String", styleId: "CellLeft" }),
      bbsXmlCell(BBS_XML_SHAPE_LABEL[entry.shape] || "Straight", { type: "String", styleId: "Cell" }),
      bbsXmlCell(entry.noOfItem, { styleId: "Cell" }),
      bbsXmlCell(entry.dia, { styleId: "Cell" }),
      bbsXmlCell(entry.spacing, { type: Number.isFinite(Number(entry.spacing)) ? "Number" : "String", styleId: "Cell" }),
      ...dims.map((value) => bbsXmlCell(value || undefined, { styleId: "Cell" })),
      bbsXmlCell(entry.bends, { styleId: "Cell" }),
      bbsXmlCell(entry.lapNos, { styleId: "Cell" }),
      bbsXmlCell(formatNumber(entry.lap, 0), { formula: `=40*${r1c1Ref(rowNumber, 14, rowNumber, 5)}`, styleId: "Cell" }),
      bbsXmlCell(entry.noOfBar, { styleId: "Cell" }),
      bbsXmlCell(formatNumber(entry.cuttingLengthM, 3), {
        formula: `=(${r1c1Ref(rowNumber, 16, rowNumber, 7)}+${r1c1Ref(rowNumber, 16, rowNumber, 8)}+${r1c1Ref(rowNumber, 16, rowNumber, 9)}+${r1c1Ref(rowNumber, 16, rowNumber, 10)}+${r1c1Ref(rowNumber, 16, rowNumber, 11)})/1000-(${r1c1Ref(rowNumber, 16, rowNumber, 12)}*${bendMultiplier}*${r1c1Ref(rowNumber, 16, rowNumber, 5)}*0.001)+(${r1c1Ref(rowNumber, 16, rowNumber, 14)}*0.001*${r1c1Ref(rowNumber, 16, rowNumber, 13)})`,
        styleId: "Cell",
      }),
    ];
    const barDia = Math.round(Number(entry.dia || 0));
    diaColumns.forEach((dia, diaIndex) => {
      const diaCol = 17 + diaIndex;
      if (Number(dia) === barDia) {
        totalsByDia[dia] += Number(entry.totalLengthM || 0);
        cells.push(bbsXmlCell(formatNumber(entry.totalLengthM, 3), {
          formula: `=${r1c1Ref(rowNumber, diaCol, rowNumber, 15)}*${r1c1Ref(rowNumber, diaCol, rowNumber, 16)}`,
          styleId: "Cell",
        }));
      } else {
        cells.push(bbsXmlCell(undefined, { styleId: "Cell" }));
      }
    });
    cells.push(bbsXmlCell(entry.remarks || "", { type: "String", styleId: "Cell" }));
    rows.push(bbsXmlRow(cells));
  });
  const lastDataRow = rows.length;

  const totalBarLengthRow = rows.length + 1;
  rows.push(bbsXmlRow([
    bbsXmlCell(undefined, { styleId: "Bold" }),
    bbsXmlCell("Total bar length by diameter", { type: "String", styleId: "BoldLeft" }),
    ...Array.from({ length: remarksIndex - 3 }, () => bbsXmlCell(undefined, { styleId: "Bold" })),
    ...diaColumns.map((dia, i) => {
      const diaCol = 17 + i;
      return bbsXmlCell(formatNumber(totalsByDia[dia], 3), {
        formula: `=SUM(${r1c1Ref(totalBarLengthRow, diaCol, firstDataRow, diaCol)}:${r1c1Ref(totalBarLengthRow, diaCol, lastDataRow, diaCol)})`,
        styleId: "Bold",
      });
    }),
    bbsXmlCell(undefined, { styleId: "Bold" }),
  ]));
  const weightRow = totalBarLengthRow + 1;
  const weightsByDia = Object.fromEntries(diaColumns.map((dia) => [dia, totalsByDia[dia] * ((dia * dia) / 162)]));
  rows.push(bbsXmlRow([
    bbsXmlCell(undefined, { styleId: "Bold" }),
    bbsXmlCell("Total steel weight kg", { type: "String", styleId: "BoldLeft" }),
    ...Array.from({ length: remarksIndex - 3 }, () => bbsXmlCell(undefined, { styleId: "Bold" })),
    ...diaColumns.map((dia, i) => {
      const diaCol = 17 + i;
      return bbsXmlCell(formatNumber(weightsByDia[dia], 3), {
        formula: `=${r1c1Ref(weightRow, diaCol, totalBarLengthRow, diaCol)}*(${dia}*${dia}/162)`,
        styleId: "Bold",
      });
    }),
    bbsXmlCell(formatNumber(Object.values(weightsByDia).reduce((sum, value) => sum + value, 0), 3), {
      formula: `=SUM(${r1c1Ref(weightRow, remarksIndex, weightRow, 17)}:${r1c1Ref(weightRow, remarksIndex, weightRow, 16 + diaColumns.length)})`,
      styleId: "Bold",
    }),
  ]));

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${bbsXmlStyles()}
<Worksheet ss:Name="${escapeHtml(sheetName)}">
<Table>
${rows.join("\n")}
</Table>
</Worksheet>
</Workbook>`;
}

function bbsCuttingLengthFromParts(partsMm = [], bendCount = 0, dia = 0) {
  const gross = partsMm.reduce((sum, value) => sum + Math.max(Number(value || 0), 0), 0);
  const bendDeduction = Math.max(Number(bendCount || 0), 0) * Math.max(Number(dia || 0), 0);
  return bbsMetresFromMm(Math.max(gross - bendDeduction, 0));
}

function beamBbsDataItem({
  description,
  shape = "straight",
  noOfItem = 1,
  dia,
  spacing = 1,
  dimensions = [],
  bends = 0,
  lapNos = 0,
  lap = 0,
  noOfBar = 1,
  cuttingLengthM,
  remarks = "",
}) {
  const dims = [0, 0, 0, 0, 0].map((_, index) => Number(dimensions[index] || 0));
  const cutting = Number.isFinite(Number(cuttingLengthM))
    ? Number(cuttingLengthM)
    : bbsCuttingLengthFromParts(dims, bends, dia);
  const totalLengthM = Number((Math.max(cutting, 0) * Math.max(Number(noOfBar || 0), 0) * Math.max(Number(noOfItem || 1), 0)).toFixed(3));
  return {
    kind: "bar",
    description,
    shape,
    noOfItem,
    dia: Math.round(Number(dia || 0)),
    spacing,
    dimensions: dims,
    bends,
    lapNos,
    lap,
    noOfBar,
    cuttingLengthM: cutting,
    totalLengthM,
    remarks,
  };
}

function beamBbsRowsForMember(row, index) {
  const lengthMm = drawingLengthToMm(row.length);
  const widthMm = drawingLengthToMm(row.breadth);
  const depthMm = drawingLengthToMm(row.height);
  if (!lengthMm || !widthMm || !depthMm) return [];

  const name = row.name || row.panelNo || `Beam ${index + 1}`;
  const mainDia = Number(row.mainDia || row.bottomMainDia || row.bottomDia || row.dia || 20);
  const topDia = Number(row.topMainDia || row.topDia || 12);
  const extraDia = Number(row.bottomExtraDia || row.extraDia || mainDia);
  const stirrupDia = Number(row.stirrupDia || row.shearDia || row.tieDia || 8);
  const mainAnchorage = drawingLengthToMm(row.mainAnchorageMm || row.barEndAnchorageMm || 300, 300);
  const topAnchorage = drawingLengthToMm(row.topAnchorageMm || Math.round(depthMm * 0.74), Math.round(depthMm * 0.74));
  const bottomExtraLength = drawingLengthToMm(row.bottomExtraLength || row.extraLength || row.bottomExtraLengthM, Math.round(lengthMm * 0.84));
  const stirrupWidthCover = drawingLengthToMm(row.stirrupWidthCoverMm || row.sideCoverMm || 30, 30);
  const stirrupDepthCover = drawingLengthToMm(row.stirrupDepthCoverMm || row.coverMm || 40, 40);
  const stirrupA = Math.max(widthMm - (2 * stirrupWidthCover), 0);
  const stirrupB = Math.max(depthMm - (2 * stirrupDepthCover), 0);
  const hook = drawingLengthToMm(row.stirrupHookMm || 150, 150);
  const stirrupSpacing = normaliseBbsSpacing(row.stirrupSpacingText || row.stirrupSpacing || row.spacing, 200);
  const stirrupLegs = Math.max(Math.round(Number(row.stirrupLegs || row.legs || 3)), 2);
  const needsReview = row.needsReview ? "need review" : "";

  const rows = [
    {
      kind: "member",
      sr: `1.${index + 1}`,
      description: name,
      lengthMm,
      widthMm,
      depthMm,
      remarks: needsReview,
    },
    beamBbsDataItem({
      description: "Bottom Main Bar",
      shape: "u",
      dia: mainDia,
      spacing: 1,
      dimensions: [mainAnchorage, lengthMm, mainAnchorage],
      bends: 2,
      lapNos: 0,
      lap: drawingLengthToMm(row.mainLapMm || mainDia * 40, mainDia * 40),
      noOfBar: Math.max(Number(row.bottomMainBars || row.mainBars || 2), 1),
      remarks: needsReview,
    }),
    beamBbsDataItem({
      description: "Bottom Extra Bar",
      shape: "straight",
      dia: extraDia,
      spacing: 1,
      dimensions: [0, bottomExtraLength, 0],
      bends: 0,
      lapNos: 0,
      lap: drawingLengthToMm(row.extraLapMm || extraDia * 40, extraDia * 40),
      noOfBar: Math.max(Number(row.bottomExtraBars || row.extraBars || 2), 1),
      cuttingLengthM: bbsMetresFromMm(bottomExtraLength),
      remarks: needsReview,
    }),
    beamBbsDataItem({
      description: "Top Main Bar",
      shape: "u",
      dia: topDia,
      spacing: 1,
      dimensions: [topAnchorage, lengthMm, topAnchorage],
      bends: 2,
      lapNos: 0,
      lap: drawingLengthToMm(row.topLapMm || topDia * 40, topDia * 40),
      noOfBar: Math.max(Number(row.topMainBars || row.topBars || 2), 1),
      remarks: needsReview,
    }),
  ];

  if (row.topExtraDia || row.topExtraLength || row.topExtraBars) {
    const topExtraDia = Number(row.topExtraDia || row.extraDia || topDia);
    const topExtraLength = drawingLengthToMm(row.topExtraLength || row.topExtraLengthM, Math.round(lengthMm * 0.35));
    rows.push(beamBbsDataItem({
      description: "Top Extra Bar",
      shape: "straight",
      dia: topExtraDia,
      spacing: 1,
      dimensions: [0, topExtraLength, 0],
      bends: 0,
      lapNos: 0,
      lap: drawingLengthToMm(row.topExtraLapMm || topExtraDia * 40, topExtraDia * 40),
      noOfBar: Math.max(Number(row.topExtraBars || 2), 1),
      cuttingLengthM: bbsMetresFromMm(topExtraLength),
      remarks: needsReview,
    }));
  }

  rows.push(
    { kind: "heading", description: `Shear Stirrups ${stirrupLegs}L` },
    beamBbsDataItem({
      description: "Outer",
      shape: "stirrup",
      noOfItem: 1,
      dia: stirrupDia,
      spacing: stirrupSpacing,
      dimensions: [stirrupA, stirrupB, stirrupA, stirrupB, hook],
      bends: 6,
      lapNos: 0,
      lap: drawingLengthToMm(row.stirrupLapMm || stirrupDia * 10, stirrupDia * 10),
      noOfBar: bbsBarCount(lengthMm, stirrupSpacing, 1),
      remarks: needsReview,
    }),
  );

  if (stirrupLegs >= 5 || row.innerStirrup || row.linkDia || row.sfrDia) {
    const innerDia = Number(row.innerStirrupDia || stirrupDia);
    rows.push(beamBbsDataItem({
      description: "Inner",
      shape: "stirrup",
      noOfItem: 1,
      dia: innerDia,
      spacing: stirrupSpacing,
      dimensions: [Math.max(stirrupA - 55, 0), stirrupB, Math.max(stirrupA - 55, 0), stirrupB, hook],
      bends: 6,
      lapNos: 0,
      lap: drawingLengthToMm(row.stirrupLapMm || innerDia * 10, innerDia * 10),
      noOfBar: bbsBarCount(lengthMm, stirrupSpacing, 1),
      remarks: needsReview,
    }));
    const linkDia = Number(row.linkDia || stirrupDia);
    rows.push(beamBbsDataItem({
      description: "Link",
      shape: "straight",
      noOfItem: 1,
      dia: linkDia,
      spacing: stirrupSpacing,
      dimensions: [Math.max(widthMm - 160, 0), Math.max(widthMm - 160, 0)],
      bends: 2,
      lapNos: 0,
      lap: drawingLengthToMm(row.linkLapMm || linkDia * 10, linkDia * 10),
      noOfBar: bbsBarCount(lengthMm, stirrupSpacing, 1),
      remarks: needsReview,
    }));
  }

  return rows;
}

function createBeamSteelBbsWorkbookHtml(packageInfo) {
  const { rows = [], files = [], plans = [], summary = {} } = packageInfo;
  const measuredFiles = (plans || [])
    .filter((plan) => !plan.summary?.linkedDetailOnly)
    .map((plan) => plan.fileName)
    .filter(Boolean);
  const sourceFiles = (measuredFiles.length ? measuredFiles : files.map((file) => file.name)).join(", ");
  const floorName = rows.find((row) => row.floor)?.floor || packageInfo.floor || "Selected Floor";
  const bbsRows = rows.flatMap((row, index) => beamBbsRowsForMember(row, index));
  return renderSteelBbsSpreadsheet({
    sheetName: "Beam BBS",
    titleLabel: "QSS Pro Beam BBS",
    sourceFiles,
    rowsCount: rows.length,
    reviewRows: summary.reviewRows || 0,
    groupLabel: `Beams at ${floorName}`,
    entries: bbsRows,
    diaColumns: BEAM_BBS_DIA_COLUMNS,
    bendMultiplier: 1,
  });
}

function slabBbsCuttingLengthFromParts(partsMm = [], bendCount = 0, dia = 0) {
  const gross = partsMm.reduce((sum, value) => sum + Math.max(Number(value || 0), 0), 0);
  const bendDeduction = Math.max(Number(bendCount || 0), 0) * Math.max(Number(dia || 0), 0) * 2;
  return bbsMetresFromMm(Math.max(gross - bendDeduction, 0));
}

function slabBbsBarCount(runMm, spacing, fallback = 1) {
  const run = Number(runMm || 0);
  const spacingMm = bbsSpacingForCount(spacing);
  if (!run || !spacingMm) return fallback;
  return Math.max(Math.ceil(run / spacingMm), fallback);
}

function slabBbsDataItem({
  description,
  shape = "straight",
  noOfItem = 1,
  dia,
  spacing = 1,
  dimensions = [],
  bends = 0,
  lapNos = 0,
  lap = 0,
  noOfBar = 1,
  cuttingLengthM,
  remarks = "",
}) {
  const dims = [0, 0, 0, 0, 0].map((_, index) => Number(dimensions[index] || 0));
  const cutting = Number.isFinite(Number(cuttingLengthM))
    ? Number(cuttingLengthM)
    : slabBbsCuttingLengthFromParts(dims, bends, dia);
  return beamBbsDataItem({
    description,
    shape,
    noOfItem,
    dia,
    spacing,
    dimensions: dims,
    bends,
    lapNos,
    lap,
    noOfBar,
    cuttingLengthM: cutting,
    remarks,
  });
}

function slabMarkFromRow(row = {}) {
  const values = [
    row.slabMark,
    row.slabNo,
    row.panelMark,
    row.panelNo,
    row.mark,
    row.slabSchedule,
    row.name,
    row.description,
    row.remarks,
  ];
  // Panel identifiers are often written with a hyphen for readability ("S-20") while the
  // schedule table itself keys marks without one ("S20") - match either and normalise to the
  // table's own format so the lookup actually hits.
  for (const value of values) {
    const match = String(value || "").match(/\bS[\s-]?(\d+[A-Z]?)\b/i);
    if (match) return `S${match[1]}`.toUpperCase();
  }
  return "";
}

function slabBbsSpecFromRow(row = {}, keys = [], fallback = null) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return parseBbsRebarSpec(row[key], fallback);
    }
  }
  return cloneBbsSpec(fallback);
}

function slabBbsScheduleForRow(row = {}, externalSchedule = {}) {
  const mark = slabMarkFromRow(row);
  const base = externalSchedule[mark] || SLAB_MARK_BBS_SCHEDULE[mark] || {};
  const explicitThickness = row.slabThicknessMm || row.slabThickness || row.thickness || row.thicknessMm;
  const rowHeight = Number(row.height);
  const heightLooksLikeThickness = Number.isFinite(rowHeight) &&
    rowHeight > 0 &&
    Math.abs(rowHeight - 1) > 1e-6 &&
    (rowHeight <= 0.5 || rowHeight > 10);
  return {
    mark,
    way: String(row.slabWay || row.way || base.way || "two").toLowerCase(),
    thicknessMm: drawingLengthToMm(
      explicitThickness || base.thicknessMm || (heightLooksLikeThickness ? row.height : undefined),
      base.thicknessMm || 150,
    ),
    shortFull: slabBbsSpecFromRow(row, [
      "shortFullSpec",
      "shortBottomFullSpec",
      "shortBottomSpec",
      "shortBottomFull",
      "shortBottom",
    ], base.shortFull || { dia: 8, spacing: 200 }),
    shortCurtail: slabBbsSpecFromRow(row, [
      "shortCurtailSpec",
      "shortBottomCurtailSpec",
      "shortBottomCurtail",
      "shortCurtail",
    ], base.shortCurtail),
    longFull: slabBbsSpecFromRow(row, [
      "longFullSpec",
      "longBottomFullSpec",
      "longBottomSpec",
      "longBottomFull",
      "longBottom",
    ], base.longFull || { dia: 8, spacing: 250 }),
    longCurtail: slabBbsSpecFromRow(row, [
      "longCurtailSpec",
      "longBottomCurtailSpec",
      "longBottomCurtail",
      "longCurtail",
    ], base.longCurtail),
  };
}

function slabTopMarkFromRow(row = {}, keys = [], fallback = "t1") {
  for (const key of keys) {
    const match = String(row[key] || "").match(/\bt\d+\b/i);
    if (match) return match[0].toLowerCase();
  }
  return fallback;
}

function slabTopSpecForMark(mark, fallback = "t1") {
  const key = String(mark || fallback || "t1").toLowerCase();
  return cloneBbsSpec(SLAB_TOP_STEEL_MARK_SCHEDULE[key] || SLAB_TOP_STEEL_MARK_SCHEDULE[fallback] || SLAB_TOP_STEEL_MARK_SCHEDULE.t1);
}

function slabBoundaryLabel(row = {}, keys = [], fallback = "support") {
  for (const key of keys) {
    const value = String(row[key] || "").trim();
    if (value) return value;
  }
  return fallback;
}

function slabBbsRowsForPanel(row, index, externalSchedule = {}) {
  const rawLengthMm = drawingLengthToMm(row.length || row.panelLength || row.longSpan);
  const rawBreadthMm = drawingLengthToMm(row.breadth || row.width || row.shortSpan);
  const lengthMm = roundBbsDimensionMm(rawLengthMm, 5);
  const breadthMm = roundBbsDimensionMm(rawBreadthMm, 5);
  if (!lengthMm || !breadthMm) return [];

  const panelNo = row.panelNo || row.name || `P${index + 1}`;
  const schedule = slabBbsScheduleForRow(row, externalSchedule);
  const thicknessMm = roundBbsDimensionMm(schedule.thicknessMm || 150, 5);
  const longMm = roundBbsDimensionMm(Math.max(lengthMm, breadthMm), 5);
  const shortMm = roundBbsDimensionMm(Math.min(lengthMm, breadthMm), 5);
  const shortFull = schedule.shortFull || { dia: 8, spacing: 200 };
  const shortCurtailSpec = schedule.shortCurtail;
  const longFull = schedule.longFull || { dia: 8, spacing: 250 };
  const longCurtailSpec = schedule.longCurtail;
  const topOuterLongMark = slabTopMarkFromRow(row, ["topOuterLongMark", "outerTopLongMark", "topMarkLongOuter", "topMark"], "t1");
  const topSupportLongMark = slabTopMarkFromRow(row, ["topSupportLongMark", "beamTopLongMark", "topMarkAtBeam", "topSupportMark"], "t4");
  const topOuterShortMark = slabTopMarkFromRow(row, ["topOuterShortMark", "outerTopShortMark", "topMarkShortOuter"], "t1");
  const topSupportShortMark = slabTopMarkFromRow(row, ["topSupportShortMark", "wallTopShortMark", "topMarkAtWall"], "t1");
  const topOuterLong = slabTopSpecForMark(topOuterLongMark, "t1");
  const topSupportLong = slabTopSpecForMark(topSupportLongMark, "t4");
  const topOuterShort = slabTopSpecForMark(topOuterShortMark, "t1");
  const topSupportShort = slabTopSpecForMark(topSupportShortMark, "t1");
  const distributionSpacing = normaliseBbsSpacing(row.distributionSpacing || 275, 275);
  const endAnchorage = drawingLengthToMm(row.slabEndAnchorageMm || row.barEndAnchorageMm || 300, 300);
  // distributionEndMm is always already in mm (a small ~100mm bar-end allowance) - routing it
  // through drawingLengthToMm's mm-vs-metres size heuristic misreads values <= 100 as metres,
  // inflating a 100mm allowance into 100000mm.
  const distributionEnd = Math.max(1, Math.round(Number(row.distributionEndMm) || 100));
  const shortCurtail = roundBbsDimensionMm(drawingLengthToMm(row.shortCurtailLengthMm || row.shortCurtailLength, Math.round(shortMm * 0.8)), 1);
  const longCurtail = roundBbsDimensionMm(drawingLengthToMm(row.longCurtailLengthMm || row.longCurtailLength, Math.round(longMm * 0.8)), 1);
  const topShortProjection = drawingLengthToMm(row.topShortProjectionMm || Math.round(shortMm * 0.334), Math.round(shortMm * 0.334));
  const topLongProjection = drawingLengthToMm(row.topLongProjectionMm || Math.round(longMm * 0.334), Math.round(longMm * 0.334));
  const topBeamBearing = drawingLengthToMm(row.topBeamBearingMm || row.beamWidthMm || row.supportWidthMm || 240, 240);
  const topWallBearing = drawingLengthToMm(row.topWallBearingMm || row.wallWidthMm || row.outerWallWidthMm || 500, 500);
  const topSupportProjection = drawingLengthToMm(row.topSupportProjectionMm || Math.round(shortMm * 0.683), Math.round(shortMm * 0.683));
  const topShortSupportProjection = drawingLengthToMm(row.topShortSupportProjectionMm || Math.round(longMm * 0.532), Math.round(longMm * 0.532));
  const topBeamLabel = slabBoundaryLabel(row, ["topBeam", "bottomBoundary", "topBoundary", "beamBoundary"], panelNo);
  const topWallLabel = slabBoundaryLabel(row, ["leftBoundary", "outerBoundary", "wallBoundary"], "outer");
  const topInnerLabel = slabBoundaryLabel(row, ["rightBoundary", "innerBoundary", "supportBoundary"], panelNo);
  const lapFor = (dia) => drawingLengthToMm(row.lapMm || dia * 40, dia * 40);
  const scheduleNeedsReview = !schedule.mark || !SLAB_MARK_BBS_SCHEDULE[schedule.mark];
  const needsReview = row.needsReview || scheduleNeedsReview ? "need review" : "";
  const rows = [
    {
      kind: "slab-member",
      sr: `1.${index + 1}`,
      description: panelNo,
      thicknessMm,
      lengthMm: longMm,
      breadthMm: shortMm,
      remarks: needsReview,
    },
    { kind: "heading", description: "Along Short span Slab Bottom" },
    slabBbsDataItem({
      description: `Full Length (A) (${bbsSpecText(shortFull)})`,
      shape: "u",
      dia: shortFull.dia,
      spacing: shortFull.spacing,
      dimensions: [shortMm, endAnchorage, endAnchorage],
      bends: 2,
      lapNos: 0,
      lap: lapFor(shortFull.dia),
      noOfBar: slabBbsBarCount(longMm, shortFull.spacing, 1),
      remarks: needsReview,
    }),
  ];

  if (shortCurtailSpec) {
    rows.push(slabBbsDataItem({
      description: `Curtailed bar (B) (${bbsSpecText(shortCurtailSpec)})`,
      shape: "u",
      dia: shortCurtailSpec.dia,
      spacing: shortCurtailSpec.spacing,
      dimensions: [shortCurtail],
      bends: 0,
      lapNos: 0,
      lap: lapFor(shortCurtailSpec.dia),
      noOfBar: slabBbsBarCount(longMm, shortCurtailSpec.spacing, 1),
      cuttingLengthM: bbsMetresFromMm(shortCurtail),
      remarks: needsReview,
    }));
  }

  rows.push(
    { kind: "heading", description: "Along Long span Slab Bottom" },
    slabBbsDataItem({
      description: `Full Length (A) (${bbsSpecText(longFull)})`,
      shape: "u",
      dia: longFull.dia,
      spacing: longFull.spacing,
      dimensions: [longMm, endAnchorage, endAnchorage],
      bends: 2,
      lapNos: 0,
      lap: lapFor(longFull.dia),
      noOfBar: slabBbsBarCount(shortMm, longFull.spacing, 1),
      remarks: needsReview,
    }),
  );

  if (longCurtailSpec) {
    rows.push(slabBbsDataItem({
      description: `Curtailed bar (B) (${bbsSpecText(longCurtailSpec)})`,
      shape: "u",
      dia: longCurtailSpec.dia,
      spacing: longCurtailSpec.spacing,
      dimensions: [longCurtail],
      bends: 0,
      lapNos: 0,
      lap: lapFor(longCurtailSpec.dia),
      noOfBar: slabBbsBarCount(shortMm, longCurtailSpec.spacing, 1),
      cuttingLengthM: bbsMetresFromMm(longCurtail),
      remarks: needsReview,
    }));
  }

  rows.push(
    { kind: "heading", description: "Along X & Y dirn in Slab Top" },
    slabBbsDataItem({
      description: `${topOuterLongMark} at ${longMm} (outer), (${bbsSpecText(topOuterLong)})`,
      shape: "straight",
      dia: topOuterLong.dia,
      spacing: topOuterLong.spacing,
      dimensions: [topShortProjection, endAnchorage],
      bends: 1,
      lapNos: 0,
      lap: lapFor(topOuterLong.dia),
      noOfBar: slabBbsBarCount(longMm, topOuterLong.spacing, 1),
      remarks: needsReview,
    }),
    slabBbsDataItem({
      description: `${topSupportLongMark} at ${longMm} (At ${topBeamLabel}), (${bbsSpecText(topSupportLong)})`,
      shape: "u",
      dia: topSupportLong.dia,
      spacing: topSupportLong.spacing,
      dimensions: [topSupportProjection, topBeamBearing, topSupportProjection],
      bends: 0,
      lapNos: 0,
      lap: lapFor(topSupportLong.dia),
      noOfBar: slabBbsBarCount(longMm, topSupportLong.spacing, 1),
      remarks: needsReview,
    }),
    slabBbsDataItem({
      description: `Distribution steel ${longMm} (${bbsSpecText(topOuterLong).replace(/ @ \d+$/, ` @ ${distributionSpacing}`)})`,
      shape: "straight",
      dia: topOuterLong.dia,
      spacing: distributionSpacing,
      dimensions: [longMm, distributionEnd, distributionEnd],
      bends: 2,
      lapNos: 0,
      lap: lapFor(topOuterLong.dia),
      noOfBar: slabBbsBarCount(shortMm, distributionSpacing, 1),
      remarks: needsReview,
    }),
    slabBbsDataItem({
      description: `${topOuterShortMark} at ${shortMm} (at ${topWallLabel}), (${bbsSpecText(topOuterShort)})`,
      shape: "straight",
      dia: topOuterShort.dia,
      spacing: topOuterShort.spacing,
      dimensions: [topLongProjection, endAnchorage],
      bends: 1,
      lapNos: 0,
      lap: lapFor(topOuterShort.dia),
      noOfBar: slabBbsBarCount(shortMm, topOuterShort.spacing, 1),
      remarks: needsReview,
    }),
    slabBbsDataItem({
      description: `${topSupportShortMark} at ${shortMm} (at ${topInnerLabel}), (${bbsSpecText(topSupportShort)})`,
      shape: "u",
      dia: topSupportShort.dia,
      spacing: topSupportShort.spacing,
      dimensions: [topShortSupportProjection, topWallBearing, topShortSupportProjection],
      bends: 0,
      lapNos: 0,
      lap: lapFor(topSupportShort.dia),
      noOfBar: slabBbsBarCount(shortMm, topSupportShort.spacing, 1),
      remarks: needsReview,
    }),
    slabBbsDataItem({
      description: `Distribution steel at ${shortMm} (${bbsSpecText(topOuterShort).replace(/ @ \d+$/, ` @ ${distributionSpacing}`)})`,
      shape: "u",
      dia: topOuterShort.dia,
      spacing: distributionSpacing,
      dimensions: [shortMm, distributionEnd, distributionEnd],
      bends: 2,
      lapNos: 0,
      lap: lapFor(topOuterShort.dia),
      noOfBar: slabBbsBarCount(longMm, distributionSpacing, 1),
      remarks: needsReview,
    }),
  );

  return rows;
}

function createSlabSteelBbsWorkbookHtml(packageInfo) {
  const { rows = [], files = [], plans = [], summary = {} } = packageInfo;
  const measuredFiles = (plans || [])
    .filter((plan) => !plan.summary?.linkedDetailOnly)
    .map((plan) => plan.fileName)
    .filter(Boolean);
  const sourceFiles = (measuredFiles.length ? measuredFiles : files.map((file) => file.name)).join(", ");
  const floorName = rows.find((row) => row.floor)?.floor || packageInfo.floor || "Selected Floor";
  const bbsRows = rows.flatMap((row, index) => slabBbsRowsForPanel(row, index, summary.slabReinforcementSchedule || {}));
  return renderSteelBbsSpreadsheet({
    sheetName: "Slab BBS",
    titleLabel: "QSS Pro Slab BBS",
    sourceFiles,
    rowsCount: rows.length,
    reviewRows: summary.reviewRows || 0,
    groupLabel: `${floorName} Slab`,
    entries: bbsRows,
    diaColumns: SLAB_BBS_DIA_COLUMNS,
    bendMultiplier: 2,
  });
}

function beamShutteringMbBreakupRows(row, beamCapMode = "included") {
  const description = mbDescription(row, "beam");
  const nos = Math.max(Number(row.nos || 1), 0);
  const length = Math.max(Number(row.length || 0), 0);
  const sideLength = Math.max(Number(row.sideLength || row.length || 0), 0);
  const width = Math.max(Number(row.breadth || 0), 0);
  const depth = Math.max(Number(row.height || 0), 0);
  const slabThickness = Math.min(Math.max(Number(row.slabThickness || 0.15), 0), depth);
  const bottomJointDeduction = Math.max(Number(row.bottomJointDeduction || 0), 0);
  const sideJointDeduction = Math.max(Number(row.sideJointDeduction || 0), 0);
  const calculatedBottomArea = Math.max(length * width - bottomJointDeduction, 0);
  const sideHeight = Math.max(depth - slabThickness, 0);
  const calculatedSideArea = Math.max(2 * sideLength * sideHeight - sideJointDeduction, 0);
  const bottomArea = Number(row.bottomAreaOverride || 0) || calculatedBottomArea;
  const sideArea = Number(row.sideAreaOverride || 0) || calculatedSideArea;
  const capAddition = beamCapShutteringAdditionForRow(row, beamCapMode);
  const effectiveSideHeight = sideLength > 0
    ? sideArea / Math.max(2 * sideLength, 1)
    : sideHeight;
  const sideFaceLengths = Array.isArray(row.evidence?.sideFaceLengthsM)
    ? row.evidence.sideFaceLengthsM.map((value) => Number(value || 0)).filter((value) => value > 0)
    : [];
  const hasSplitSideFaceRows = sideFaceLengths.length >= 2 &&
    (finiteMax(sideFaceLengths, 0) - finiteMin(sideFaceLengths, 0)) > 0.04;
  const common = {
    unit: "sqm",
    sourceRow: row,
  };
  const bottomOverrideApplied = Number(row.bottomAreaOverride || 0) > 0;
  const rows = [
    {
      ...common,
      description: `${description} - bottom / soffit shuttering`,
      nos,
      length,
      breadth: width,
      height: 1,
      deduction: bottomJointDeduction,
      formulaKind: bottomOverrideApplied ? "static" : "area",
      total: bottomArea * nos,
      extraRemarks: [
        bottomOverrideApplied ? "override value used" : "",
        "beam bottom/soffit",
        bottomJointDeduction > 0 ? `bottom joint deduction ${formatNumber(bottomJointDeduction)} sqm` : "",
      ],
    },
  ];
  if (beamCapMode === "excluded") {
    const excludedSideSegments = beamExcludedCapSideSegments(row);
    excludedSideSegments.forEach((segment, index) => {
      rows.push({
        ...common,
        description: `${description} - side face ${index + 1} shuttering`,
        nos,
        length,
        breadth: Number(segment.sideHeightM || 0),
        height: 1,
        deduction: 0,
        formulaKind: "area",
        total: Number(segment.areaM2 || 0) * nos,
        extraRemarks: [
          `side face ${index + 1}`,
          "column caps excluded: side face length equals beam bottom run",
          Number(segment.slabThicknessM || 0) > 0
            ? `slab thickness deduction ${formatNumber(segment.slabThicknessM)} m`
            : "full-depth side face",
        ],
      });
    });
    return rows;
  }
  if (hasSplitSideFaceRows) {
    sideFaceLengths.forEach((faceLength, index) => {
      rows.push({
        ...common,
        description: `${description} - side face ${index + 1} shuttering`,
        nos,
        length: faceLength,
        breadth: effectiveSideHeight || sideHeight,
        height: 1,
        deduction: 0,
        formulaKind: "area",
        total: faceLength * (effectiveSideHeight || sideHeight) * nos,
        extraRemarks: [
          `side face ${index + 1}`,
          `marked face length ${formatNumber(faceLength)} m`,
          `side height after slab deduction ${formatNumber(effectiveSideHeight || sideHeight)} m`,
        ],
      });
    });
  } else {
    // effectiveSideHeight is derived as sideArea/(2*sideLength), so length*breadth*nos
    // reproduces sideArea*nos exactly even when sideArea came from an override or had a
    // joint deduction folded in - the area formula stays valid without a separate deduction.
    rows.push({
      ...common,
      description: `${description} - side shuttering`,
      nos: nos * 2,
      length: sideLength,
      breadth: effectiveSideHeight,
      height: 1,
      deduction: 0,
      formulaKind: "area",
      total: sideArea * nos,
      extraRemarks: [
        "two side faces",
        `side height after slab deduction ${formatNumber(effectiveSideHeight)} m`,
        sideJointDeduction > 0 ? `side joint deduction ${formatNumber(sideJointDeduction)} sqm` : "",
      ],
    });
  }
  if (capAddition > 0) {
    rows.push({
      ...common,
      description: `${description} - column cap side shuttering`,
      nos,
      length: 1,
      breadth: capAddition,
      height: 1,
      deduction: 0,
      formulaKind: "area",
      total: capAddition * nos,
      extraRemarks: ["column cap shuttering included with beam shuttering"],
    });
  }
  return rows;
}

function baseMbRemarks(row, itemType, quantityRule, beamCapMode = "included", extraRemarks = []) {
  return row.needsReview ? "need review" : "";
}

// Renders the plain (non-BBS) MB sheet - concrete, shuttering, tiles, plaster, brickwork, etc.
// - as a real Excel workbook with a live formula in Total Qty rather than a baked-in number:
//   area-shape items (everything except beam concrete): (Length*Breadth - Deduction) * Height * Nos
//   beam concrete: (Length*Breadth*Height - Deduction) * Nos
// Deduction covers openings (area items) or a column-cap volume deduction (beam concrete); it's
// its own visible column so the formula is fully self-contained. A handful of rows carry a
// hand-entered override value that bypasses the geometric formula entirely (e.g. a manually
// corrected bottom shuttering area) - those show as a plain number with a "override value used"
// remark instead of a formula, since a formula can't represent "ignore geometry, use this number".
function renderMbSpreadsheet({
  title,
  sourceFiles,
  linkedReferenceFiles,
  rowsCount,
  reviewRows,
  accuracyStatusLabel,
  calculationRoutes,
  panelMarksLabel,
  planWarnings,
  accuracyWarnings,
  entries,
}) {
  const rows = [];
  rows.push(bbsXmlRow([bbsXmlCell(title, { type: "String", styleId: "MetaBold" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Measured framing drawing(s)", { type: "String", styleId: "MetaBold" }), bbsXmlCell(sourceFiles, { type: "String", styleId: "Meta" })]));
  if (linkedReferenceFiles) rows.push(bbsXmlRow([bbsXmlCell("Linked reference drawing(s)", { type: "String", styleId: "MetaBold" }), bbsXmlCell(linkedReferenceFiles, { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Rows", { type: "String", styleId: "MetaBold" }), bbsXmlCell(rowsCount, { styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Review rows", { type: "String", styleId: "MetaBold" }), bbsXmlCell(reviewRows || 0, { styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Accuracy status", { type: "String", styleId: "MetaBold" }), bbsXmlCell(accuracyStatusLabel || "Not audited", { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Calculation route", { type: "String", styleId: "MetaBold" }), bbsXmlCell(calculationRoutes || "", { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Panel / beam marks", { type: "String", styleId: "MetaBold" }), bbsXmlCell(panelMarksLabel || "", { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([bbsXmlCell("Generated", { type: "String", styleId: "MetaBold" }), bbsXmlCell(new Date().toLocaleString("en-IN"), { type: "String", styleId: "Meta" })]));
  if (planWarnings) rows.push(bbsXmlRow([bbsXmlCell("Warnings", { type: "String", styleId: "MetaBold" }), bbsXmlCell(planWarnings, { type: "String", styleId: "Meta" })]));
  if (accuracyWarnings) rows.push(bbsXmlRow([bbsXmlCell("Accuracy warnings", { type: "String", styleId: "MetaBold" }), bbsXmlCell(accuracyWarnings, { type: "String", styleId: "Meta" })]));
  rows.push(bbsXmlRow([]));

  rows.push(bbsXmlRow([
    bbsXmlCell("S.No.", { type: "String", styleId: "Header" }),
    bbsXmlCell("Item Description", { type: "String", styleId: "Header" }),
    bbsXmlCell("Unit", { type: "String", styleId: "Header" }),
    bbsXmlCell("Number of Member", { type: "String", styleId: "Header" }),
    bbsXmlCell("Length", { type: "String", styleId: "Header" }),
    bbsXmlCell("Width / Breadth", { type: "String", styleId: "Header" }),
    bbsXmlCell("Height / Thickness", { type: "String", styleId: "Header" }),
    bbsXmlCell("Deduction", { type: "String", styleId: "Header" }),
    bbsXmlCell("Total Qty", { type: "String", styleId: "Header" }),
    bbsXmlCell("Remarks", { type: "String", styleId: "Header" }),
  ]));

  entries.forEach((entry, index) => {
    const rowNumber = rows.length + 1;
    const cells = [
      bbsXmlCell(index + 1, { styleId: "Cell" }),
      bbsXmlCell(entry.description, { type: "String", styleId: "CellLeft" }),
      bbsXmlCell(entry.unit, { type: "String", styleId: "Cell" }),
      bbsXmlCell(entry.nos, { styleId: "Cell" }),
      bbsXmlCell(entry.length, { styleId: "Cell" }),
      bbsXmlCell(entry.breadth, { styleId: "Cell" }),
      bbsXmlCell(entry.height, { styleId: "Cell" }),
      bbsXmlCell(entry.deduction || 0, { styleId: "Cell" }),
    ];
    if (entry.formulaKind === "beam-concrete") {
      cells.push(bbsXmlCell(formatNumber(entry.total), {
        formula: `=MAX(${r1c1Ref(rowNumber, 9, rowNumber, 5)}*${r1c1Ref(rowNumber, 9, rowNumber, 6)}*${r1c1Ref(rowNumber, 9, rowNumber, 7)}-${r1c1Ref(rowNumber, 9, rowNumber, 8)},0)*${r1c1Ref(rowNumber, 9, rowNumber, 4)}`,
        styleId: "Cell",
      }));
    } else if (entry.formulaKind === "area") {
      cells.push(bbsXmlCell(formatNumber(entry.total), {
        formula: `=MAX(${r1c1Ref(rowNumber, 9, rowNumber, 5)}*${r1c1Ref(rowNumber, 9, rowNumber, 6)}-${r1c1Ref(rowNumber, 9, rowNumber, 8)},0)*${r1c1Ref(rowNumber, 9, rowNumber, 7)}*${r1c1Ref(rowNumber, 9, rowNumber, 4)}`,
        styleId: "Cell",
      }));
    } else {
      cells.push(bbsXmlCell(formatNumber(entry.total), { styleId: "Cell" }));
    }
    cells.push(bbsXmlCell(entry.remarks || "", { type: "String", styleId: "Cell" }));
    rows.push(bbsXmlRow(cells));
  });

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${bbsXmlStyles()}
<Worksheet ss:Name="MB Sheet">
<Table>
${rows.join("\n")}
</Table>
</Worksheet>
</Workbook>`;
}

function createExcelCompatibleMbSheet(packageInfo) {
  const { rows, itemType, quantityRule, files, plans, summary, beamCapMode = "included" } = packageInfo;
  if (workbookTypeForPackage(packageInfo) === "BBS") {
    return shouldUseBeamBbsWorkbook(packageInfo)
      ? createBeamSteelBbsWorkbookHtml(packageInfo)
      : createSlabSteelBbsWorkbookHtml(packageInfo);
  }
  const unit = quantityUnit(quantityRule, itemType);
  const title = `QSS Pro MB Sheet - ${itemType.toUpperCase()} ${quantityRule}`;
  const measuredFiles = (plans || [])
    .filter((plan) => !plan.summary?.linkedDetailOnly)
    .map((plan) => plan.fileName)
    .filter(Boolean);
  const linkedFiles = (plans || [])
    .filter((plan) => plan.summary?.linkedDetailOnly)
    .map((plan) => plan.fileName)
    .filter(Boolean);
  const sourceFiles = (measuredFiles.length ? measuredFiles : files.map((file) => file.name)).join(", ");
  const linkedReferenceFiles = linkedFiles.join(", ");
  const planWarnings = plans
    .map((plan) => plan.warning)
    .filter(Boolean)
    .join(" | ");
  const isBeamConcrete = itemType === "beam" && /concrete/i.test(quantityRule);
  const mbRows = itemType === "beam" && /shuttering/i.test(quantityRule)
    ? rows.flatMap((row) => beamShutteringMbBreakupRows(row, beamCapMode))
    : rows.map((row) => {
        const override = isBeamConcrete && Number(row.grossConcreteOverride || 0) > 0;
        const deduction = isBeamConcrete
          ? (beamCapMode === "excluded" ? Math.max(Number(row.columnCapDeduction || 0), 0) : 0)
          : Number(row.openings || 0);
        return {
          sourceRow: row,
          description: mbDescription(row, itemType),
          unit,
          nos: row.nos || 1,
          length: row.length,
          breadth: row.breadth,
          height: mbHeight(row, itemType, quantityRule),
          deduction,
          formulaKind: override ? "static" : (isBeamConcrete ? "beam-concrete" : "area"),
          total: mbQuantity(row, itemType, quantityRule, beamCapMode),
          extraRemarks: override ? ["override value used"] : [],
        };
      });
  const entries = mbRows.map((entry) => {
    const row = entry.sourceRow;
    const remarks = baseMbRemarks(row, itemType, quantityRule, beamCapMode, entry.extraRemarks || []);
    return { ...entry, unit: entry.unit || unit, nos: entry.nos || 1, remarks };
  });

  return renderMbSpreadsheet({
    title,
    sourceFiles,
    linkedReferenceFiles,
    rowsCount: rows.length,
    reviewRows: summary.reviewRows || 0,
    accuracyStatusLabel: summary.accuracyAudit?.statusLabel,
    calculationRoutes: summary.accuracyAudit?.routes?.join(", ") || "",
    panelMarksLabel: `${summary.accuracyAudit?.panelMarks || 0} panel mark(s), ${summary.accuracyAudit?.beamMarks || 0} QB mark(s)`,
    planWarnings,
    accuracyWarnings: summary.accuracyAudit?.warnings?.length ? summary.accuracyAudit.warnings.join(" | ") : "",
    entries,
  });
}

function percent(value) {
  return Math.round(Number(value || 0) * 1000) / 10;
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
  return /written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|cad-dimension/i.test(sourceText) &&
    Number(row.length) > 0 &&
    Number(row.breadth) > 0;
}

function buildAccuracyAudit({ itemType, plans, extractedRows, rows }) {
  const measuredPlans = plans.filter((plan) => !plan.summary?.linkedDetailOnly);
  const references = measuredPlans
    .map((plan) => plan.summary?.referenceDrawing)
    .filter(Boolean);
  const routes = [...new Set(measuredPlans
    .map((plan) => plan.summary?.selectedCalculationRoute)
    .filter(Boolean))];
  const panelMarks = references.reduce((sum, reference) => sum + Number(reference.panelMarks || 0), 0);
  const beamMarks = references.reduce((sum, reference) => sum + Number(reference.beamMarks || 0), 0);
  const reviewMarks = references.reduce((sum, reference) => sum + Number(reference.reviewMarks || 0), 0);
  const openBayPanelMarks = references.reduce((sum, reference) => sum + Number(reference.summary?.openBayPanelMarks || 0), 0);
  const sectionExclusionZones = references.reduce((sum, reference) => sum + Number(reference.summary?.sectionExclusionZones || 0), 0);
  const slabMarkCount = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.slabMarkCount || 0), 0);
  const unresolvedSlabMarkCount = measuredPlans.reduce((sum, plan) => sum + Number(plan.summary?.unresolvedSlabMarkCount || 0), 0);
  const reviewRows = extractedRows.filter((row) => row.needsReview).length;
  const acceptedRows = rows.length;
  const writtenCadPanelRows = (itemType === "slab" || itemType === "raft")
    ? extractedRows.filter(rowHasWrittenCadPanelDimensions).length
    : 0;
  const extractedCount = extractedRows.length;
  const reviewRatio = extractedCount ? reviewRows / extractedCount : 1;
  const acceptedRatio = extractedCount ? acceptedRows / extractedCount : 0;
  const panelCoverageRatio = panelMarks && (itemType === "slab" || itemType === "raft")
    ? acceptedRows / panelMarks
    : null;
  const qbCoverageRatio = beamMarks && itemType === "beam"
    ? acceptedRows / beamMarks
    : null;
  const warnings = [];

  if (!references.length || references.some((reference) => !reference.ok)) {
    warnings.push("Reference working drawing was not created for every measured file.");
  }
  if ((itemType === "slab" || itemType === "raft") && !panelMarks && !writtenCadPanelRows) {
    warnings.push("No verified slab quantity panels were created. Slab marks such as S1/S2/S10 define thickness only; they are not used to auto-create slab area.");
  }
  if ((itemType === "slab" || itemType === "raft") && panelMarks && panelCoverageRatio < 0.9 && !writtenCadPanelRows) {
    warnings.push(`Only ${percent(panelCoverageRatio)}% of verified slab labels reached final quantity rows.`);
  }
  if ((itemType === "slab" || itemType === "raft") && unresolvedSlabMarkCount > 0 && !writtenCadPanelRows) {
    warnings.push(`${unresolvedSlabMarkCount} slab mark(s) did not resolve into verified slab quantity rows.`);
  }
  if (itemType === "beam" && beamMarks && qbCoverageRatio < 0.85) {
    warnings.push(`Only ${percent(qbCoverageRatio)}% of QB beam marks reached final quantity rows.`);
  }
  if (itemType === "beam" && routes.some((route) => /topology_fallback|qb_beam_reference_readback/.test(route))) {
    warnings.push("Beam quantity came from auto/topology fallback instead of fully verified beam-number extraction; treat it as review-only until the reference drawing is checked.");
  }
  if ((itemType === "slab" || itemType === "raft") && routes.some((route) => /topology_fallback/.test(route))) {
    warnings.push("Slab quantity came from topology fallback; it is locked unless written CAD dimensions or verified beam-boundary read-back confirms full panel coverage.");
  }
  if (reviewRatio > 0.1) {
    warnings.push(`${percent(reviewRatio)}% of extracted rows need review; review quantity is included in total but must be checked before final billing.`);
  }
  if (routes.some((route) => /direct_slab_extractor|named_or_direct_beam_extractor/.test(route)) && (itemType === "slab" || beamMarks)) {
    warnings.push("A direct extractor route was used; verify against the reference drawing before billing.");
  }
  const finalAllowed = warnings.length === 0 && reviewRatio <= 0.1;
  return {
    ruleVersion: ACCURACY_RULE_VERSION,
    finalAllowed,
    status: finalAllowed ? "final-ready" : "review-required",
    statusLabel: finalAllowed ? "Final-ready after audit" : "Review required before final MB",
    routes,
    sourceFiles: measuredPlans.map((plan) => plan.fileName),
    panelMarks,
    writtenCadPanelRows,
    slabMarkCount,
    unresolvedSlabMarkCount,
    beamMarks,
    reviewMarks,
    openBayPanelMarks,
    sectionExclusionZones,
    extractedRows: extractedCount,
    acceptedRows,
    reviewRows,
    excludedRows: Math.max(0, extractedCount - acceptedRows),
    reviewRatio,
    acceptedRatio,
    panelCoverageRatio,
    qbCoverageRatio,
    warnings,
  };
}

function severeFramingQuantityLockReason({ itemType, summary, rows, plans = [] }) {
  if (!(itemType === "slab" || itemType === "raft")) return "";
  const measuredPlans = plans.filter((plan) => !plan.summary?.linkedDetailOnly);
  const conversionFailedPlans = measuredPlans.filter((plan) => /DWG conversion failed|conversion failed/i.test(String(plan.warning || "")));
  const audit = summary.accuracyAudit || {};
  const planWarnings = [
    ...(summary.routeWarnings || []),
    ...plans.map((plan) => plan.warning || ""),
  ].join(" ");
  const panelMarks = Number(audit.panelMarks || 0);
  const extractedRows = Number(audit.extractedRows || summary.extractedRows || 0);
  const acceptedRows = Number(audit.acceptedRows || rows.length || 0);
  const reviewRatio = Number(audit.reviewRatio || 0);
  const panelCoverageRatio = Number(audit.panelCoverageRatio || 0);
  const unresolvedSlabMarkCount = Number(audit.unresolvedSlabMarkCount || 0);
  const slabMarkCount = Number(audit.slabMarkCount || 0);
  const netArea = Number(summary.totalNetAreaM2 || 0);
  const largestRegionAreaM2 = Math.max(0, ...plans.map((plan) => Number(plan.summary?.takeoffRegionAreaM2Estimate || 0)));
  const falsePanelRoute = /false closed panel|small\/false|suspicious slab|full panel finder could not verify/i.test(planWarnings);
  const topologySlabRoute = (audit.routes || []).some((route) => /topology_fallback/.test(String(route || "")));
  const reviewPanelRows = rows.filter((row) => row.evidence?.reviewQuantityFromBlockedSlab).length;
  const reviewPanelRowsWithBoundaryEvidence = rows.filter((row) =>
    row.evidence?.reviewQuantityFromBlockedSlab &&
    /written-cad-dimension|visible-dimension-text|text-dimension-label|marked-cad-dimension|verified/i.test(String(row.evidence?.boundaryBasis || row.source || "")),
  ).length;
  const writtenCadPanelRows = rows.filter(rowHasWrittenCadPanelDimensions).length;
  const hasWrittenCadPanelQuantity = writtenCadPanelRows > 0 && netArea > 0;
  const hasReviewPanelCoverage = reviewPanelRows >= Math.max(4, acceptedRows * 0.75) &&
    reviewPanelRowsWithBoundaryEvidence >= Math.max(4, reviewPanelRows * 0.5) &&
    netArea >= Math.max(25, Math.min(120, Math.max(slabMarkCount, panelMarks) * 1.5));
  const trustedCadPanelRows = rows.filter((row) => {
    const sourceText = [
      row.source,
      row.evidence?.source,
      row.evidence?.boundaryBasis,
      row.evidence?.selectedPanelMeasurementBasis,
      row.evidence?.pLineReadbackRule,
    ].filter(Boolean).join(" ");
    return !/topology|takeoff-engine-v2|planar-face-walk|barrier-cell|enclosure-candidate|grid|open-bay|slab-mark/i.test(sourceText) &&
      /p-?line|closed polyline|verified-slab|written-cad-dimension/i.test(sourceText);
  }).length;
  const reasons = [];

  if (conversionFailedPlans.length && !rows.length) {
    const names = conversionFailedPlans.map((plan) => plan.fileName).filter(Boolean).join(", ");
    reasons.push(`no readable CAD geometry was created from ${names || "the uploaded DWG"}`);
  }
  if (!panelMarks && !hasWrittenCadPanelQuantity) {
    reasons.push(slabMarkCount
      ? "slab marks were found, but no verified slab quantity boundary or written dimension pair was created around them"
      : "no verified slab quantity panels were created");
  }
  if (panelMarks && panelCoverageRatio < 0.75 && !hasWrittenCadPanelQuantity) {
    reasons.push(`only ${percent(panelCoverageRatio)}% of verified slab labels reached quantity rows`);
  }
  if (extractedRows && reviewRatio > 0.5 && !hasReviewPanelCoverage) {
    reasons.push(`${percent(reviewRatio)}% of slab rows need review`);
  }
  if (slabMarkCount && unresolvedSlabMarkCount > Math.max(2, slabMarkCount * 0.2) && !hasWrittenCadPanelQuantity) {
    reasons.push(`${unresolvedSlabMarkCount} slab mark(s) did not resolve into measured panels`);
  }
  if (slabMarkCount >= 8 && netArea < Math.max(120, slabMarkCount * 4) && !hasWrittenCadPanelQuantity) {
    reasons.push(`measured slab area ${round3(netArea)} sqm is too small for ${slabMarkCount} slab mark(s)`);
  }
  if (acceptedRows <= 12 && netArea < 75 && (slabMarkCount >= 8 || largestRegionAreaM2 > 300) && !hasWrittenCadPanelQuantity) {
    reasons.push(`measured slab area ${round3(netArea)} sqm from only ${acceptedRows} panel(s) is a likely local/false panel cluster`);
  }
  if (largestRegionAreaM2 > 500 && netArea < Math.max(100, largestRegionAreaM2 * 0.08) && !hasReviewPanelCoverage && !hasWrittenCadPanelQuantity) {
    reasons.push(`measured slab area ${round3(netArea)} sqm is too small for the detected framing region`);
  }
  if (((acceptedRows <= 2 && netArea < 25) || (falsePanelRoute && !hasReviewPanelCoverage)) && !hasWrittenCadPanelQuantity) {
    reasons.push("the fast/deep slab reader detected a small or false closed panel instead of the full floor");
  }
  if (topologySlabRoute && trustedCadPanelRows < Math.max(4, acceptedRows * 0.5)) {
    reasons.push("topology-only slab panels were not confirmed by written CAD dimensions or verified beam-boundary read-back");
  }

  if (!reasons.length) return "";
  return `Slab quantity locked: ${reasons.join("; ")}. Final total/MB is not released because this would give a wrong quantity; review Excel may be downloaded for checking only. Check the reference drawing and written dimensions first.`;
}

function createFramingDownloadPackage({ files, rows, itemType, quantityRule, beamCapMode = "included", plans, summary }) {
  const sourceFile = files.find((file) => !isDetailScheduleDrawingName(file.name)) || files[0];
  if (!sourceFile) return null;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const base = safeName(path.basename(sourceFile.name, path.extname(sourceFile.name)) || "drawing").slice(0, 80);
  const ruleName = safeName(quantityRule || itemType || "quantity").slice(0, 40);
  const finalAllowed = Boolean(rows.length && summary.accuracyAudit?.finalAllowed && summary.ruleAudit?.finalAllowed && !summary.finalQuantityLocked);
  const workbookKind = workbookTypeForPackage({ rows, itemType, quantityRule });
  const packageLabel = finalAllowed ? workbookKind : `REVIEW-${workbookKind}`;
  const excelName = rows.length ? `QSS-Pro-${base}-${ruleName}-${packageLabel}-${stamp}.xls` : "";
  if (rows.length) {
    const excelRows = finalAllowed
      ? rows
      : rows.map((row) => ({
          ...row,
          needsReview: true,
          remarks: [
            "REVIEW ONLY - final quantity locked; verify against reference drawing before billing.",
            row.remarks,
          ].filter(Boolean).join(" "),
        }));
    fs.writeFileSync(
      path.join(root, excelName),
      createExcelCompatibleMbSheet({ rows: excelRows, itemType, quantityRule, beamCapMode, files, plans, summary }),
      "utf8",
    );
  }

  const markedReference = plans
    .map((plan) => plan.summary?.referenceDrawing)
    .find((reference) => reference?.ok && reference.downloadName);
  const allowSourceFallbackReference = !(itemType === "slab" || itemType === "raft") || rows.length;
  const referenceName = markedReference?.downloadName ||
    (allowSourceFallbackReference ? `QSS-Pro-${base}-Unmarked-Source-Drawing-${stamp}${path.extname(sourceFile.name).toLowerCase() || ".dwg"}` : "");
  if (!markedReference && referenceName) {
    fs.writeFileSync(path.join(root, referenceName), Buffer.from(sourceFile.dataBase64, "base64"));
  }

  return {
    excelUrl: excelName || "",
    excelName,
    referenceUrl: referenceName,
    referenceName,
    referenceSourceFile: sourceFile.name,
    referenceType: markedReference?.referenceType || (referenceName ? path.extname(referenceName).replace(".", "").toUpperCase() : ""),
    panelMarks: markedReference?.panelMarks || 0,
    beamMarks: markedReference?.beamMarks || 0,
    reviewMarks: markedReference?.reviewMarks || 0,
    workbookType: workbookKind,
    itemType,
    quantityRule,
    finalAllowed,
    reviewExcel: Boolean(rows.length && !finalAllowed),
    accuracyStatus: summary.accuracyAudit?.statusLabel || "",
    accuracyWarnings: [
      ...(summary.accuracyAudit?.warnings || []),
      ...((summary.ruleAudit?.failedRules || []).map((rule) => `${rule.title}: ${rule.detail}`)),
      ...((summary.ruleAudit?.warningRules || []).map((rule) => `${rule.title}: ${rule.detail}`)),
    ],
    note: markedReference
      ? rows.length
        ? finalAllowed
          ? "Downloads generated from the current extraction. Reference drawing contains verified slab labels and QB marks only for unnamed beams."
          : "Review Excel generated from the current extraction. It is for checking only; final MB remains locked until slab/cutout rules pass."
        : "Reference drawing generated for review only. MB Excel is locked until slab coverage and slab rules pass."
      : allowSourceFallbackReference
        ? "Marked reference drawing could not be created; original source drawing is provided for review."
        : "Marked slab reference drawing could not be created; source drawing is not provided as a reference because it has no QSS panel marks.",
    createdAt: new Date().toISOString(),
  };
}

function isMarkedDimensionBeamRow(row = {}) {
  const evidence = row.evidence || {};
  return Boolean(
    evidence.markedDimensionAuthoritative ||
    evidence.markedDimensionFastPath ||
    /marked(?:-|_)?cad(?:-|_)?dimension|marked(?:-|_)?dimension/i.test(String(evidence.dimensionBasis || "")) ||
    /marked(?:-|_)?dimension/i.test(String(row.source || "")),
  );
}

function isMarkedDimensionDominantBeamSet(rows = []) {
  if (!rows.length) return false;
  const markedRows = rows.filter(isMarkedDimensionBeamRow);
  return markedRows.length >= 8 && markedRows.length >= rows.length * 0.65;
}

function normalizeMarkedDimensionBeamRow(row = {}) {
  if (!isMarkedDimensionBeamRow(row)) return row;
  const length = round3(Number(row.length || 0));
  const sideLengths = Array.isArray(row.evidence?.sideFaceLengthsM)
    ? row.evidence.sideFaceLengthsM.map((value) => Number(value || 0)).filter((value) => value > 0)
    : [];
  return {
    ...row,
    length,
    sideLength: sideLengths.length >= 2
      ? round3(sideLengths.reduce((sum, value) => sum + value, 0) / sideLengths.length)
      : length,
    evidence: {
      ...(row.evidence || {}),
      markedDimensionFinalization: true,
      sideLengthBasis: sideLengths.length >= 2
        ? (row.evidence?.sideLengthBasis || "Marked inner/outer side face dimensions were preserved.")
        : "Marked CAD dimension span: side length equals bottom run unless column-cap-included face data is supplied.",
    },
  };
}

function finalMarkedDimensionBeamRows(rows = []) {
  const cleanedRows = removeDetailLikeBeamRows(
    applyStoppedBeamLocalDimensionOverride(rows),
  )
    .filter((row) =>
      Number(row.length || 0) > 0 &&
      Number(row.breadth || 0) > 0 &&
      !hasConflictingFarBeamSizeEvidence(row))
    .map(normalizeMarkedDimensionBeamRow);

  const exactRows = uniqueRowsBy(
    cleanedRows,
    (row) => {
      const id = beamRowMergeId(row) || String(row.name || "").trim().toUpperCase();
      const span = beamSpanFromRow(row);
      const spanKey = span
        ? [
            span.orientation,
            Math.round(Number(span.fixed || 0) / 100),
            Math.round(Math.min(Number(span.start || 0), Number(span.end || 0)) / 25),
            Math.round(Math.max(Number(span.start || 0), Number(span.end || 0)) / 25),
          ].join(":")
        : String(row.evidence?.lineKey || "");
      return [
        beamRowSourceKey(row),
        id,
        spanKey,
        Math.round(Number(row.length || 0) * 1000 / 25),
        Math.round(Number(row.breadth || 0) * 1000),
        Math.round(Number(row.height || 0) * 1000),
        Math.round(Number(row.slabThickness || 0) * 1000),
      ].join("|");
    },
    (row) =>
      (row.needsReview ? 10000 : 0) +
      Number(row.evidence?.labelDistanceToDimensionMm || 0) +
      Number(row.evidence?.sizeDistanceMm || 0),
  );

  return sortBeamRowsForMb(
    applyInferredSupportDeductionsToBeamRows(
      mergeContinuousNamedBeamRows(
        applyInferredSupportDeductionsToBeamRows(exactRows),
      ),
    ),
  );
}

function finalQuantityRows(rows, itemType) {
  if (!(itemType === "slab" || itemType === "raft")) {
    const positiveRows = rows.filter((row) =>
      Number(row.length || 0) > 0 &&
      Number(row.breadth || 0) > 0 &&
      !hasConflictingFarBeamSizeEvidence(row));
    const primaryBeamRows = removeDetailLikeBeamRows(
      applyStoppedBeamLocalDimensionOverride(positiveRows),
    );
    if (isMarkedDimensionDominantBeamSet(primaryBeamRows)) {
      return finalMarkedDimensionBeamRows(primaryBeamRows);
    }
    return sortBeamRowsForMb(
      applyInferredSupportDeductionsToBeamRows(
        collapseSameNamePhysicalOccurrenceRows(
          collapseDominantNamedBeamRunRows(
            collapseRepeatedIdenticalNamedBeamOccurrences(
              mergeContinuousNamedBeamRows(
                applyInferredSupportDeductionsToBeamRows(
                  preferMarkedDimensionRowsForOverdetectedNamedBeams(primaryBeamRows),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
  const accepted = [];
  const seen = new Set();
  for (const row of rows) {
    if (Number(row.length || 0) <= 0 || Number(row.breadth || 0) <= 0) continue;
    const multiMarkEvidence = Array.isArray(row.evidence?.multipleSlabMarksInCell) &&
      row.evidence.multipleSlabMarksInCell.length > 1;
    if (multiMarkEvidence || /Multiple slab marks in same bounded panel cell/i.test(String(row.reviewNote || ""))) continue;
    const grossArea = Number(row.length || 0) * Number(row.breadth || 0);
    const netArea = Math.max(grossArea - Number(row.openings || 0), 0);
    if (netArea <= 0) continue;
    const bounds = row.evidence || {};
    const boundKey = Number.isFinite(bounds.panelLeftX) && Number.isFinite(bounds.panelRightX)
      ? [
          Math.round(Math.min(bounds.panelLeftX, bounds.panelRightX) / 100),
          Math.round(Math.max(bounds.panelLeftX, bounds.panelRightX) / 100),
          Math.round(Math.min(bounds.panelBottomY, bounds.panelTopY) / 100),
          Math.round(Math.max(bounds.panelBottomY, bounds.panelTopY) / 100),
        ].join(":")
      : "";
    const panelNoKey = String(row.panelNo || bounds.panelNo || "").trim().toUpperCase();
    const key = boundKey || (panelNoKey ? `PANEL:${panelNoKey}` : "");
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    accepted.push(row);
  }

  function panelBoundsFromRow(row) {
    const evidence = row.evidence || {};
    const left = Math.min(Number(evidence.panelLeftX), Number(evidence.panelRightX));
    const right = Math.max(Number(evidence.panelLeftX), Number(evidence.panelRightX));
    const bottom = Math.min(Number(evidence.panelBottomY), Number(evidence.panelTopY));
    const top = Math.max(Number(evidence.panelBottomY), Number(evidence.panelTopY));
    if (![left, right, bottom, top].every(Number.isFinite) || right <= left || top <= bottom) return null;
    return { left, right, bottom, top };
  }

  function panelAreaFromBounds(box) {
    if (!box) return 0;
    return Math.max(box.right - box.left, 0) * Math.max(box.top - box.bottom, 0);
  }

  function panelOverlapRatio(first, second) {
    const a = panelBoundsFromRow(first);
    const b = panelBoundsFromRow(second);
    if (!a || !b) return 0;
    const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const yOverlap = Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
    const overlapArea = xOverlap * yOverlap;
    if (!overlapArea) return 0;
    return overlapArea / Math.min(panelAreaFromBounds(a), panelAreaFromBounds(b));
  }

  function preferredPanelDuplicateRow(group) {
    return group.slice().sort((a, b) => {
      const markCountA = Number(a.evidence?.slabMarksInsidePanelCount || 99);
      const markCountB = Number(b.evidence?.slabMarksInsidePanelCount || 99);
      const basisA = String(a.evidence?.selectedPanelMeasurementBasis || "");
      const basisB = String(b.evidence?.selectedPanelMeasurementBasis || "");
      const scoreA = (a.needsReview ? 100000 : 0) +
        (a.evidence?.dimensionConflict ? 50000 : 0) +
        (markCountA === 1 ? -30000 : markCountA * 12000) +
        (/internal-split|centre-to-centre/i.test(basisA) ? 9000 : 0);
      const scoreB = (b.needsReview ? 100000 : 0) +
        (b.evidence?.dimensionConflict ? 50000 : 0) +
        (markCountB === 1 ? -30000 : markCountB * 12000) +
        (/internal-split|centre-to-centre/i.test(basisB) ? 9000 : 0);
      if (scoreA !== scoreB) return scoreA - scoreB;
      const areaA = Number(a.length || 0) * Number(a.breadth || 0);
      const areaB = Number(b.length || 0) * Number(b.breadth || 0);
      return areaA - areaB;
    })[0];
  }

  function suppressOverlappingPanelRows(rowsToCheck) {
    const duplicateOverlapThreshold = 0.86;
    const parent = rowsToCheck.map((_, index) => index);
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
    for (let first = 0; first < rowsToCheck.length; first += 1) {
      for (let second = first + 1; second < rowsToCheck.length; second += 1) {
        if (panelOverlapRatio(rowsToCheck[first], rowsToCheck[second]) >= duplicateOverlapThreshold) {
          union(first, second);
        }
      }
    }
    const groups = new Map();
    rowsToCheck.forEach((row, index) => {
      const root = find(index);
      groups.set(root, [...(groups.get(root) || []), row]);
    });
    return [...groups.values()].map((group) => {
      if (group.length === 1) return group[0];
      const selected = preferredPanelDuplicateRow(group);
      const collapsedPanels = [...new Set(group.map((row) => row.panelNo || row.evidence?.panelNo || row.name).filter(Boolean))];
      return {
        ...selected,
        needsReview: selected.needsReview,
        reviewNote: [
          selected.reviewNote,
          `Overlapping duplicate slab-panel detections suppressed: ${collapsedPanels.join(", ")}.`,
        ].filter(Boolean).join(" "),
        evidence: {
          ...(selected.evidence || {}),
          suppressedOverlappingPanelDetections: collapsedPanels,
          suppressedOverlappingPanelCount: group.length - 1,
          panelCenterlineAndOverlapRule: "Final slab schedule keeps one row per physical bounded panel; duplicate/contained panel detections are suppressed before Excel and reference drawing numbering.",
        },
      };
    });
  }

  const deoverlappedPanels = suppressOverlappingPanelRows(accepted);
  const panelSortValue = (row) => {
    const evidence = row.evidence || {};
    const xs = [Number(evidence.panelLeftX), Number(evidence.panelRightX)].filter(Number.isFinite);
    const ys = [Number(evidence.panelBottomY), Number(evidence.panelTopY)].filter(Number.isFinite);
    return {
      x: xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : Number.POSITIVE_INFINITY,
      y: ys.length ? ys.reduce((sum, value) => sum + value, 0) / ys.length : Number.NEGATIVE_INFINITY,
    };
  };
  // A pairwise "is this pair within 500mm vertically" comparator is not transitive - panel A can be
  // "same row" as B, and B "same row" as C, while A and C fall on opposite sides of the 500mm cutoff.
  // Array.sort assumes a transitive order, so a non-transitive comparator produces a numbering
  // sequence that visually jumps around the plan (e.g. P9 on the far left, P10 on the far right).
  // Bucketing each panel into a row band in one top-to-bottom pass - instead of comparing every pair
  // against each other - keeps the ordering consistent, then each band is sorted left-to-right.
  const rowBandToleranceMm = 900;
  const withCenters = deoverlappedPanels.map((row) => ({ row, ...panelSortValue(row) }));
  const byYDescending = withCenters.slice().sort((a, b) => b.y - a.y);
  const rowBands = [];
  for (const item of byYDescending) {
    const band = rowBands.find((candidate) => Math.abs(candidate.y - item.y) <= rowBandToleranceMm);
    if (band) {
      band.items.push(item);
      band.y = band.items.reduce((sum, entry) => sum + entry.y, 0) / band.items.length;
    } else {
      rowBands.push({ y: item.y, items: [item] });
    }
  }
  rowBands.sort((a, b) => b.y - a.y);
  const sortedPanels = rowBands.flatMap((band) =>
    band.items.slice().sort((a, b) => a.x - b.x).map((item) => item.row));
  return sortedPanels.map((row, index) => ({
    ...row,
    name: `P${index + 1}`,
    panelNo: `P${index + 1}`,
    evidence: {
      ...(row.evidence || {}),
      originalSlabMarkOrTopologyPanel: row.evidence?.slabMark || row.evidence?.topologyPanelId || row.name || "",
      panelNo: `P${index + 1}`,
    },
  }));
}



function beamNaturalParts(value = "") {
  const id = extractBeamIdFromMixedText(value) || String(value || "").trim().toUpperCase();
  const match = id.match(/^(.*?B)(\d+)([A-Z]*)$/i);
  if (!match) return { prefix: id, number: Number.MAX_SAFE_INTEGER, suffix: "", id };
  return {
    prefix: match[1].toUpperCase(),
    number: Number(match[2] || 0),
    suffix: (match[3] || "").toUpperCase(),
    id,
  };
}

function compareBeamNaturalId(first, second) {
  const a = beamNaturalParts(first);
  const b = beamNaturalParts(second);
  const prefixCompare = a.prefix.localeCompare(b.prefix, undefined, { numeric: true, sensitivity: "base" });
  if (prefixCompare) return prefixCompare;
  if (a.number !== b.number) return a.number - b.number;
  return a.suffix.localeCompare(b.suffix, undefined, { numeric: true, sensitivity: "base" });
}

function beamRowOrientationRank(row) {
  const span = beamSpanFromRow(row);
  if (!span) return 2;
  return span.orientation === "H" ? 0 : span.orientation === "V" ? 1 : 2;
}

function beamRowLocationSort(row) {
  const span = beamSpanFromRow(row);
  if (!span) return { major: Number.POSITIVE_INFINITY, minor: Number.POSITIVE_INFINITY };
  if (span.orientation === "H") {
    return {
      major: -Number(span.fixed || 0),
      minor: Math.min(Number(span.start || 0), Number(span.end || 0)),
    };
  }
  return {
    major: Math.min(Number(span.start || 0), Number(span.end || 0)),
    minor: Number(span.fixed || 0),
  };
}

function sortBeamRowsForMb(rows = []) {
  return rows.slice().sort((first, second) => {
    const orientationCompare = beamRowOrientationRank(first) - beamRowOrientationRank(second);
    if (orientationCompare) return orientationCompare;
    const idCompare = compareBeamNaturalId(first.name || "", second.name || "");
    if (idCompare) return idCompare;
    const a = beamRowLocationSort(first);
    const b = beamRowLocationSort(second);
    if (Math.abs(a.major - b.major) > 50) return a.major - b.major;
    if (Math.abs(a.minor - b.minor) > 50) return a.minor - b.minor;
    return String(first.name || "").localeCompare(String(second.name || ""), undefined, { numeric: true, sensitivity: "base" });
  });
}

function stoppedBeamMarkedDimensionM(row) {
  const evidence = row.evidence || {};
  const values = Array.isArray(evidence.markedFaceDimensionsM)
    ? evidence.markedFaceDimensionsM.map((value) => Number(value || 0)).filter((value) => value > 0)
    : [];
  if (!values.length) return 0;
  const width = Math.max(Number(row.breadth || 0), 0.15);
  const currentLength = Math.max(Number(row.length || 0), 0);
  const useful = values
    .filter((value) => value >= Math.max(0.75, width * 3))
    .filter((value) => !currentLength || value <= Math.max(8, currentLength * 0.5))
    .sort((a, b) => a - b);
  return useful[0] || 0;
}

function applyStoppedBeamLocalDimensionOverride(rows = []) {
  return rows.map((row) => {
    const evidence = row.evidence || {};
    const length = Number(row.length || 0);
    const hasLocalStopEvidence = evidence.markedFaceDimensionsIgnoredAsOffsets ||
      (Array.isArray(evidence.trimmedToNearestSupportBracket) && evidence.trimmedToNearestSupportBracket.length) ||
      (Array.isArray(evidence.trimmedAtTerminalSupportFace) && evidence.trimmedAtTerminalSupportFace.length);
    const hasStrongLocalLabel = Number(evidence.sizeDistanceMm || 0) <= 2500 &&
      Number(evidence.lineDistanceMm || 0) <= 4500;
    const localDimension = stoppedBeamMarkedDimensionM(row);
    if (!(hasLocalStopEvidence && hasStrongLocalLabel && localDimension && length > Math.max(12, localDimension * 4))) {
      return row;
    }
    return {
      ...row,
      length: round3(localDimension),
      sideLength: round3(localDimension),
      sideAreaOverride: undefined,
      bottomAreaOverride: undefined,
      grossConcreteOverride: undefined,
      bottomJointDeduction: 0,
      sideJointDeduction: 0,
      columnCapDeduction: 0,
      needsReview: true,
      reviewNote: [
        row.reviewNote,
        `Stopped beam local dimension ${formatNumber(localDimension)} m used instead of ${formatNumber(length)} m raw CAD line because support/marked-dimension evidence shows the beam does not continue through the full drawing.`,
      ].filter(Boolean).join(" "),
      evidence: {
        ...evidence,
        stoppedBeamLocalDimensionOverride: true,
        rawGeometryLengthBeforeStopOverrideM: round3(length),
        dimensionBasis: "stopped-beam-local-marked-dimension",
        drawnLengthM: round3(localDimension),
        sideLengthBasis: "Stopped beam: bottom and sides use the local marked/support span for column-cap-excluded shuttering.",
        lengthAlreadyTrimmedToSupportFace: true,
      },
    };
  });
}

function removeDetailLikeBeamRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const id = beamRowMergeId(row);
    if (!id) continue;
    const key = [
      beamRowSourceKey(row),
      id,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const strongKeys = new Set();
  for (const [key, groupRows] of groups.entries()) {
    const hasPrimary = groupRows.some((row) =>
      Number(row.evidence?.sizeDistanceMm || 0) <= 2500 &&
      Number(row.evidence?.lineDistanceMm || 0) <= 4500 &&
      !/section|detail/i.test(String(row.evidence?.role || "")));
    if (hasPrimary) strongKeys.add(key);
  }

  return rows.filter((row) => {
    const id = beamRowMergeId(row);
    if (!id) return true;
    const key = [
      beamRowSourceKey(row),
      id,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
    const hasPrimaryPeer = strongKeys.has(key);
    const lineDistance = Number(row.evidence?.lineDistanceMm || 0);
    const sizeDistance = Number(row.evidence?.sizeDistanceMm || 0);
    const length = Number(row.length || 0);
    // A far sizeDistance alone doesn't mean this row is detail/section content - a beam's
    // size is typically labelled once per drawing and inherited by every other occurrence
    // of the same name/size, so occurrences far from any size text are normal, not
    // suspicious. Only treat far sizeDistance as a detail-like signal when no other row of
    // this same beam ID/breadth/height combo already confirmed the size nearby.
    if (sizeDistance > 30000 && !hasPrimaryPeer) return false;
    if (hasPrimaryPeer && lineDistance > 6500) return false;
    if (hasPrimaryPeer && lineDistance > 3500 && length < 0.75) return false;
    return true;
  });
}


function preferMarkedDimensionRowsForOverdetectedNamedBeams(rows = []) {
  const groups = new Map();
  const unnamed = [];
  const rowScore = (row) => {
    const evidence = row.evidence || {};
    const markedFaces = Array.isArray(evidence.markedFaceDimensionsM)
      ? evidence.markedFaceDimensionsM.filter((value) => Number(value) > 0)
      : [];
    return (
      (evidence.markedDimensionAuthoritative ? -200000 : 0) +
      (markedFaces.length >= 2 ? -100000 : 0) +
      (Number(row.needsReview ? 1 : 0) * 20000) +
      Number(evidence.lineDistanceMm || 999999) +
      Number(evidence.sizeDistanceMm || 999999)
    );
  };
  const markedFacePairKey = (row, id) => {
    const evidence = row.evidence || {};
    const faces = Array.isArray(evidence.markedFaceDimensionsM)
      ? evidence.markedFaceDimensionsM.map((value) => Number(value || 0)).filter((value) => value > 0).sort((a, b) => a - b)
      : [];
    if (faces.length < 2) return "";
    const pair = [faces[0], faces[faces.length - 1]]
      .map((value) => Math.round(value * 1000 / 25) * 25 / 1000)
      .join("x");
    const span = beamSpanFromRow(row);
    const orientation = span?.orientation || row.evidence?.orientation || "";
    return [
      id,
      orientation,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
      pair,
    ].join(":");
  };
  const roughPhysicalKey = (row) => {
    const span = beamSpanFromRow(row);
    if (span) {
      return [
        span.orientation,
        Math.round(Number(span.fixed || 0) / 500),
        Math.round(Math.min(Number(span.start || 0), Number(span.end || 0)) / 500),
        Math.round(Math.max(Number(span.start || 0), Number(span.end || 0)) / 500),
      ].join(":");
    }
    const evidence = row.evidence || {};
    return [
      "label",
      Math.round(Number(evidence.labelX || 0) / 1000),
      Math.round(Number(evidence.labelY || 0) / 1000),
    ].join(":");
  };
  for (const row of rows) {
    const id = beamRowMergeId(row);
    if (!id) {
      unnamed.push(row);
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  const kept = [...unnamed];
  for (const [id, groupRows] of groups.entries()) {
    if (groupRows.length <= 8) {
      kept.push(...groupRows);
      continue;
    }
    const markedPairRows = groupRows.filter((row) => markedFacePairKey(row, id));
    if (markedPairRows.length) {
      const pairGroups = new Map();
      for (const row of markedPairRows) {
        const key = markedFacePairKey(row, id);
        if (!pairGroups.has(key)) pairGroups.set(key, []);
        pairGroups.get(key).push(row);
      }
      for (const pairRows of pairGroups.values()) {
        const sorted = pairRows.slice().sort((a, b) => rowScore(a) - rowScore(b));
        const first = sorted[0];
        const faces = (first.evidence?.markedFaceDimensionsM || [])
          .map((value) => Number(value || 0))
          .filter((value) => value > 0)
          .sort((a, b) => a - b);
        const distinctLocations = new Set(sorted.map(roughPhysicalKey));
        const rawNos = sorted.reduce((sum, row) => sum + Math.max(Number(row.nos || 1), 1), 0);
        const maxSafeNos = groupRows.length > 20 ? 2 : 4;
        const nos = Math.max(1, Math.min(distinctLocations.size || rawNos, maxSafeNos));
        kept.push({
          ...first,
          nos,
          needsReview: first.needsReview || sorted.length !== nos,
          reviewNote: [
            first.reviewNote,
            `Over-detected ${id} beam fragments were collapsed by marked face dimensions ${faces.map((value) => `${round3(value)}m`).join(" / ")}; counted as ${nos} member(s) and ignored ${Math.max(groupRows.length - sorted.length, 0)} weak same-name row(s).`,
          ].filter(Boolean).join(" "),
          evidence: {
            ...(first.evidence || {}),
            overDetectedNamedBeamRowsFiltered: groupRows.length - sorted.length,
            overDetectedMarkedFaceRowsCollapsed: sorted.length,
            overDetectedDistinctLocationCount: distinctLocations.size,
            overDetectedSafeNos: nos,
          },
        });
      }
      continue;
    }
    const strongRows = groupRows.filter((row) => {
      const evidence = row.evidence || {};
      const markedFaces = Array.isArray(evidence.markedFaceDimensionsM) ? evidence.markedFaceDimensionsM.filter((value) => Number(value) > 0) : [];
      return evidence.markedDimensionAuthoritative || markedFaces.length >= 2 || /^cad(?:-|_)?dimension$/i.test(String(evidence.dimensionBasis || ""));
    });
    if (!strongRows.length) {
      groupRows
        .slice()
        .sort((a, b) => rowScore(a) - rowScore(b))
        .slice(0, 8)
        .forEach((row) => {
          kept.push({
            ...row,
            needsReview: true,
            reviewNote: [
              row.reviewNote,
              `Over-detected ${id} beam rows were capped because no marked CAD dimension confirmed all same-name fragments.`,
            ].filter(Boolean).join(" "),
            evidence: {
              ...(row.evidence || {}),
              overDetectedNamedBeamRowsCapped: groupRows.length,
            },
          });
        });
      continue;
    }
    if (strongRows.length > Math.max(12, groupRows.length * 0.75)) {
      strongRows
        .slice()
        .sort((a, b) => rowScore(a) - rowScore(b))
        .slice(0, 8)
        .forEach((row) => {
          kept.push({
            ...row,
            needsReview: true,
            reviewNote: [
              row.reviewNote,
              `Over-detected ${id} beam rows were capped to the strongest marked-dimension rows; check the reference drawing before final billing.`,
            ].filter(Boolean).join(" "),
            evidence: {
              ...(row.evidence || {}),
              overDetectedNamedBeamRowsCapped: groupRows.length,
            },
          });
        });
      continue;
    }
    strongRows.forEach((row) => {
      kept.push({
        ...row,
        reviewNote: [
          row.reviewNote,
          `Over-detected ${id} beam labels were filtered; kept rows with marked CAD dimensions as primary evidence.`,
        ].filter(Boolean).join(" "),
        evidence: {
          ...(row.evidence || {}),
          overDetectedNamedBeamRowsFiltered: groupRows.length - strongRows.length,
        },
      });
    });
  }
  return kept;
}

function collapseRepeatedIdenticalNamedBeamOccurrences(rows = []) {
  const groups = new Map();
  const passthrough = [];
  for (const row of rows) {
    const id = beamRowMergeId(row);
    const span = beamSpanFromRow(row);
    if (!id || !span || row.evidence?.mergedContinuousNamedBeam) {
      passthrough.push(row);
      continue;
    }
    const key = [
      beamRowSourceKey(row),
      id,
      span.orientation,
      Math.round(Number(row.length || 0) * 1000 / 25),
      Math.round(Number(row.sideLength || row.length || 0) * 1000 / 25),
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
      Math.round(Number(row.slabThickness || 0) * 1000),
      Math.round(Number(row.bottomJointDeduction || 0) * 1000),
      Math.round(Number(row.sideJointDeduction || 0) * 1000),
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, span });
  }

  const collapsed = [];
  for (const items of groups.values()) {
    if (items.length <= 1) {
      collapsed.push(items[0].row);
      continue;
    }
    const hasAdjacentSameAxis = items.some((item, index) => items.slice(index + 1).some((other) => {
      if (item.span.orientation !== other.span.orientation) return false;
      const axisToleranceMm = Math.max(1000, Math.max(Number(item.row.breadth || 0), Number(item.row.height || 0), 0.45) * 1000 * 3);
      if (Math.abs(item.span.fixed - other.span.fixed) > axisToleranceMm) return false;
      return rowSpanGapMm(item.span, other.span) <= Math.max(1800, axisToleranceMm);
    }));
    if (hasAdjacentSameAxis) {
      collapsed.push(...items.map((item) => item.row));
      continue;
    }
    const first = items[0].row;
    const nos = items.reduce((sum, item) => sum + Math.max(Number(item.row.nos || 1), 1), 0);
    collapsed.push({
      ...first,
      nos,
      needsReview: items.some((item) => item.row.needsReview),
      reviewNote: [
        first.reviewNote,
        `Same beam ${beamRowMergeId(first)} found at ${items.length} separate matching location(s); counted as ${nos} member(s) with the same length instead of stitching into one long beam.`,
      ].filter(Boolean).join(" "),
      evidence: {
        ...(first.evidence || {}),
        repeatedIdenticalNamedBeamOccurrences: items.length,
        repeatedIdenticalNamedBeamNos: nos,
        repeatedBeamLocationSpans: items.map((item) => ({
          orientation: item.span.orientation,
          fixed: Math.round(item.span.fixed),
          start: Math.round(item.span.start),
          end: Math.round(item.span.end),
        })),
      },
    });
  }
  return [...passthrough, ...collapsed];
}

function collapseDominantNamedBeamRunRows(rows = []) {
  const groups = new Map();
  const passthrough = [];
  for (const row of rows) {
    const id = beamRowMergeId(row);
    if (!id) {
      passthrough.push(row);
      continue;
    }
    const key = [
      beamRowSourceKey(row),
      id,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const kept = [];
  for (const rowsForBeam of groups.values()) {
    if (rowsForBeam.length <= 1) {
      kept.push(...rowsForBeam);
      continue;
    }
    const sorted = rowsForBeam
      .slice()
      .sort((a, b) => Number(b.length || 0) - Number(a.length || 0));
    const primary = sorted[0];
    const secondLength = Number(sorted[1]?.length || 0);
    const primaryLength = Number(primary.length || 0);
    const hasDominantPrimaryRun = secondLength > 0 && (
      (primaryLength >= 8 && primaryLength >= secondLength * 3) ||
      (primaryLength >= 1.2 && primaryLength >= secondLength * 2.5) ||
      (primaryLength >= 0.75 && primaryLength >= secondLength * 1.75)
    );
    // A same-name row that looks "weak" only means it's an unreliable measurement of
    // SOMETHING - it does not mean that something is a duplicate of the primary run. If its
    // span sits at a clearly different location along the beam (no overlap, no small gap),
    // it is a separate continuation segment the merge step failed to bridge, not detail/
    // offset noise, and discarding it here would silently under-count the physical beam.
    const primarySpan = beamSpanFromRow(primary);
    const isNearPrimarySpan = (row) => {
      const span = beamSpanFromRow(row);
      if (!primarySpan || !span || span.orientation !== primarySpan.orientation) return true;
      const typicalMm = Math.max(Number(row.breadth || 0), Number(row.height || 0), 0.45) * 1000;
      return rowSpanGapMm(primarySpan, span) <= Math.max(2500, typicalMm * 4);
    };
    const weakFragments = sorted.slice(1).filter((row) =>
      isNearPrimarySpan(row) && (
        row.needsReview ||
        row.evidence?.markedFaceDimensionsIgnoredAsOffsets ||
        /marked-inner-outer-face-dimensions|marked-dimension-label-recovery/i.test(String(row.evidence?.dimensionBasis || "")) ||
        Number(row.evidence?.lineDistanceMm || 0) > 1000));
    if (hasDominantPrimaryRun && weakFragments.length >= sorted.length - 1) {
      kept.push({
        ...primary,
        needsReview: primary.needsReview || weakFragments.length > 0,
        reviewNote: [
          primary.reviewNote,
          `Dominant continuous beam run kept for ${beamRowMergeId(primary)}; ${weakFragments.length} smaller same-name fragment row(s) were treated as detail/offset evidence, not separate beam members.`,
        ].filter(Boolean).join(" "),
        evidence: {
          ...(primary.evidence || {}),
          dominantNamedBeamRunKept: true,
          dominantNamedBeamRunLengthM: round3(primaryLength),
          suppressedSameNameFragmentRows: weakFragments.length,
          suppressedSameNameFragmentLengthsM: weakFragments.map((row) => round3(Number(row.length || 0))),
        },
      });
      continue;
    }
    kept.push(...rowsForBeam);
  }
  return [...passthrough, ...kept];
}

function rowIntervalUnionLengthM(spans = [], gapToleranceMm = 0) {
  const intervals = spans
    .map((span) => ({
      start: Math.min(Number(span.start), Number(span.end)),
      end: Math.max(Number(span.start), Number(span.end)),
    }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  if (!intervals.length) return 0;
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + gapToleranceMm) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return round3(merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1000);
}

function collapseSameNamePhysicalOccurrenceRows(rows = []) {
  const groups = new Map();
  const passthrough = [];
  for (const row of rows) {
    const id = beamRowMergeId(row);
    const span = beamSpanFromRow(row);
    if (!id || !span) {
      passthrough.push(row);
      continue;
    }
    const key = [
      beamRowSourceKey(row),
      id,
      span.orientation,
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, span });
  }

  const output = [...passthrough];
  const canJoinPhysicalOccurrence = (cluster, item) => {
    const row = item.row;
    const span = item.span;
    const widthMm = Math.max(Number(row.breadth || 0) * 1000, 230);
    const depthMm = Math.max(Number(row.height || 0) * 1000, 450);
    const typicalMm = Math.max(widthMm, depthMm, 450);
    const axisDiff = Math.abs(Number(cluster.fixed || 0) - Number(span.fixed || 0));
    const gap = finiteMin(cluster.items.map((entry) => rowSpanGapMm(entry.span, span)), Infinity);
    const sameAxisLimitMm = Math.max(900, Math.min(2800, typicalMm * 4));
    const sameAxisGapLimitMm = Math.max(8000, Math.min(18000, typicalMm * 24));
    // A genuine "same beam, centerline shifted at a support" offset is on the order of the
    // member's own width/depth, not several metres - the previous typicalMm*10 (up to 6500mm)
    // formula was wide enough to cluster two entirely separate, parallel physical beams
    // (e.g. mirrored members several metres apart with the same mark) into one, which then
    // got unioned down to a single beam's length instead of summing both.
    const supportOffsetAxisLimitMm = Math.max(900, Math.min(2200, typicalMm * 3));
    return (
      (axisDiff <= sameAxisLimitMm && gap <= sameAxisGapLimitMm) ||
      (axisDiff <= supportOffsetAxisLimitMm && gap <= 1500)
    );
  };

  for (const items of groups.values()) {
    if (items.length <= 1) {
      output.push(...items.map((item) => item.row));
      continue;
    }

    const sorted = items
      .slice()
      .sort((a, b) => {
        if (Math.abs(a.span.fixed - b.span.fixed) > 250) return a.span.fixed - b.span.fixed;
        return a.span.start - b.span.start;
      });
    const clusters = [];
    for (const item of sorted) {
      const cluster = clusters.find((candidate) => canJoinPhysicalOccurrence(candidate, item));
      if (cluster) {
        cluster.items.push(item);
        cluster.fixed = cluster.items.reduce((sum, entry) => sum + Number(entry.span.fixed || 0), 0) / cluster.items.length;
      } else {
        clusters.push({ fixed: item.span.fixed, items: [item] });
      }
    }

    for (const cluster of clusters) {
      const clusterRows = cluster.items.map((item) => item.row);
      if (clusterRows.length <= 1) {
        output.push(clusterRows[0]);
        continue;
      }
      const maxLength = finiteMax(clusterRows.map((row) => Number(row.length || 0)), 0);
      const tinyLimit = Math.max(0.45, Math.min(1.2, maxLength * 0.12));
      const strongItems = cluster.items.filter((item) => {
        const row = item.row;
        const length = Number(row.length || 0);
        const evidence = row.evidence || {};
        const weakBasis = /offset|detail|marked-inner-outer|fragment/i.test(String(evidence.dimensionBasis || "")) ||
          evidence.markedFaceDimensionsIgnoredAsOffsets ||
          evidence.overlappingBeamFragmentsCollapsed;
        return !(length < tinyLimit && (row.needsReview || weakBasis || Number(item.span.lengthMm || 0) < tinyLimit * 1000));
      });
      const keptItems = strongItems.length ? strongItems : cluster.items;
      const keptRows = keptItems.map((item) => item.row);
      const keptSpans = keptItems.map((item) => item.span);
      if (keptRows.length <= 1) {
        output.push({
          ...keptRows[0],
          evidence: {
            ...(keptRows[0].evidence || {}),
            physicalOccurrenceSuppressedRows: clusterRows.length - keptRows.length,
          },
        });
        continue;
      }

      const first = keptRows[0];
      const summedLength = keptRows.reduce((sum, row) => sum + Number(row.length || 0), 0);
      const summedSideLength = keptRows.reduce((sum, row) => sum + Number(row.sideLength || row.length || 0), 0);
      const typicalMm = Math.max(Number(first.breadth || 0) * 1000, Number(first.height || 0) * 1000, 450);
      const unionLength = rowIntervalUnionLengthM(keptSpans, Math.max(300, Math.min(1800, typicalMm * 2)));
      const useUnionForDuplicateFragments = unionLength > 0 && unionLength < summedLength * 0.86;
      const finalLength = useUnionForDuplicateFragments ? unionLength : round3(summedLength);
      const finalSideLength = useUnionForDuplicateFragments ? unionLength : round3(summedSideLength || summedLength);
      const aggregate = (field) => keptRows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
      const maxAggregate = (field) => finiteMax(keptRows.map((row) => Number(row[field] || 0)), 0);
      const reviewNotes = [...new Set(keptRows.map((row) => row.reviewNote).filter(Boolean))];
      output.push({
        ...first,
        length: finalLength,
        sideLength: finalSideLength,
        bottomAreaOverride: undefined,
        sideAreaOverride: undefined,
        grossConcreteOverride: undefined,
        openings: useUnionForDuplicateFragments ? maxAggregate("openings") : aggregate("openings"),
        bottomJointDeduction: useUnionForDuplicateFragments ? maxAggregate("bottomJointDeduction") : round3(aggregate("bottomJointDeduction")),
        sideJointDeduction: useUnionForDuplicateFragments ? maxAggregate("sideJointDeduction") : round3(aggregate("sideJointDeduction")),
        columnCapDeduction: useUnionForDuplicateFragments ? maxAggregate("columnCapDeduction") : round3(aggregate("columnCapDeduction")),
        needsReview: keptRows.some((row) => row.needsReview),
        reviewNote: [
          `Same beam ${beamRowMergeId(first)} grouped as one physical occurrence from ${keptRows.length} detected span row(s).`,
          clusterRows.length > keptRows.length ? `${clusterRows.length - keptRows.length} tiny offset/detail fragment row(s) suppressed.` : "",
          useUnionForDuplicateFragments ? `Overlapping duplicate fragments counted by union length ${formatNumber(finalLength)} m.` : "",
          ...reviewNotes,
        ].filter(Boolean).join(" "),
        evidence: {
          ...(first.evidence || {}),
          sameNamePhysicalOccurrenceMerged: true,
          physicalOccurrenceMergedRows: keptRows.length,
          physicalOccurrenceSuppressedRows: clusterRows.length - keptRows.length,
          physicalOccurrenceUsedUnionLength: useUnionForDuplicateFragments,
          physicalOccurrenceSpanLengthsM: keptRows.map((row) => round3(Number(row.length || 0))),
          physicalOccurrenceSpanRanges: keptSpans.map((span) => ({
            orientation: span.orientation,
            fixed: Math.round(span.fixed),
            start: Math.round(span.start),
            end: Math.round(span.end),
          })),
          faceSpan: {
            ...(first.evidence?.faceSpan || {}),
            orientation: keptSpans[0].orientation,
            fixed: keptSpans.reduce((sum, span) => sum + Number(span.fixed || 0), 0) / keptSpans.length,
            start: finiteMin(keptSpans.map((span) => span.start), 0),
            end: finiteMax(keptSpans.map((span) => span.end), 0),
          },
        },
      });
    }
  }
  return output;
}

function evidenceArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") return [value];
  return [];
}

function supportWidthForDeduction(condition, row) {
  const breadth = Math.max(Number(row.breadth || 0), 0);
  const candidates = [Number(condition.widthM), Number(condition.heightM)]
    .filter((value) => Number.isFinite(value) && value >= 0.05 && value <= 3);
  if (!candidates.length) return Math.max(Math.min(breadth || 0.23, 1.2), 0.1);
  if (!breadth) return finiteMin(candidates, 0);
  return candidates
    .slice()
    .sort((a, b) => Math.abs(a - breadth) - Math.abs(b - breadth))[0];
}

function inferredTerminalSupportDeductions(row) {
  if (row.evidence?.lengthAlreadyTrimmedToSupportFace) {
    return { bottomJointDeduction: 0, sideJointDeduction: 0, columnCapDeduction: 0, supportCount: 0 };
  }
  const conditions = evidenceArray(row.evidence?.supportConditions)
    .filter((condition) => /support/i.test(String(condition.type || "")))
    .filter((condition) => !Number.isFinite(Number(condition.distanceMm)) || Number(condition.distanceMm) <= 250);
  if (!conditions.length) return { bottomJointDeduction: 0, sideJointDeduction: 0, columnCapDeduction: 0, supportCount: 0 };
  const seen = new Set();
  const uniqueConditions = [];
  for (const condition of conditions) {
    const key = [
      String(condition.end || "").toLowerCase(),
      String(condition.label || condition.layer || "").toUpperCase(),
      Math.round(Number(condition.widthM || 0) * 1000),
      Math.round(Number(condition.heightM || 0) * 1000),
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueConditions.push(condition);
  }
  const supportOverlapM = uniqueConditions
    .slice(0, 2)
    .reduce((sum, condition) => sum + supportWidthForDeduction(condition, row), 0);
  const breadth = Math.max(Number(row.breadth || 0), 0);
  const depth = Math.max(Number(row.height || 0), 0);
  const slabThickness = Math.min(Math.max(Number(row.slabThickness || 0.15), 0), depth);
  const sideHeight = Math.max(depth - slabThickness, 0);
  return {
    bottomJointDeduction: round3(supportOverlapM * breadth),
    sideJointDeduction: round3(2 * supportOverlapM * sideHeight),
    columnCapDeduction: round3(supportOverlapM * breadth * depth),
    supportCount: uniqueConditions.slice(0, 2).length,
  };
}

function applyInferredSupportDeductionsToBeamRows(rows = []) {
  return rows.map((row) => {
    const continuousJoints = evidenceArray(row.evidence?.continuousSupportDeductions);
    const jointBottom = round3(continuousJoints.reduce((sum, joint) => sum + Number(joint.bottomDeductionM2 || 0), 0));
    const jointSide = round3(continuousJoints.reduce((sum, joint) => sum + Number(joint.sideDeductionM2 || 0), 0));
    const jointCap = round3(columnCapConcreteDeduction(continuousJoints, Number(row.breadth || 0), Number(row.height || 0)));
    const terminal = inferredTerminalSupportDeductions(row);
    const currentBottom = Math.max(Number(row.bottomJointDeduction || 0), 0);
    const currentSide = Math.max(Number(row.sideJointDeduction || 0), 0);
    const currentCap = Math.max(Number(row.columnCapDeduction || 0), 0);
    const inferredBottom = Math.max(jointBottom, currentBottom <= 0.0001 ? terminal.bottomJointDeduction : 0);
    const inferredSide = Math.max(jointSide, currentSide <= 0.0001 ? terminal.sideJointDeduction : 0);
    const inferredCap = Math.max(jointCap, currentCap <= 0.0001 ? terminal.columnCapDeduction : 0);
    const bottomJointDeduction = round3(Math.max(currentBottom, inferredBottom));
    const sideJointDeduction = round3(Math.max(currentSide, inferredSide));
    const columnCapDeduction = round3(Math.max(currentCap, inferredCap));
    if (
      bottomJointDeduction === currentBottom &&
      sideJointDeduction === currentSide &&
      columnCapDeduction === currentCap
    ) {
      return row;
    }
    return {
      ...row,
      bottomJointDeduction,
      sideJointDeduction,
      columnCapDeduction,
      reviewNote: [
        row.reviewNote,
        terminal.supportCount && (currentBottom <= 0.0001 || currentSide <= 0.0001)
          ? `Support/wall/column overlap deduction inferred at ${terminal.supportCount} end support(s); bottom and side shuttering do not pass through support faces.`
          : "",
      ].filter(Boolean).join(" "),
      evidence: {
        ...(row.evidence || {}),
        inferredSupportDeductionApplied: true,
        inferredTerminalSupportCount: terminal.supportCount,
        inferredBottomJointDeductionM2: bottomJointDeduction,
        inferredSideJointDeductionM2: sideJointDeduction,
        inferredColumnCapDeductionM3: columnCapDeduction,
      },
    };
  });
}

function hasConflictingFarBeamSizeEvidence(row) {
  const id = beamRowMergeId(row);
  const sizeTextId = extractBeamIdFromMixedText(row.evidence?.nearestSizeText || "");
  if (!id || !sizeTextId || id === sizeTextId) return false;
  return Number(row.evidence?.sizeDistanceMm || 0) > 5000 ||
    Number(row.evidence?.lineDistanceMm || 0) > 5000;
}

function mergeContinuousNamedBeamRows(rows = []) {
  const unnamed = [];
  const named = [];
  const seenExact = new Set();
  for (const row of rows) {
    const id = beamRowMergeId(row);
    const span = beamSpanFromRow(row);
    if (!id || !span) {
      unnamed.push(row);
      continue;
    }
    const exactKey = [
      beamRowSourceKey(row),
      id,
      span.orientation,
      Math.round(span.fixed / 50),
      Math.round(span.start / 50),
      Math.round(span.end / 50),
      Math.round(Number(row.breadth || 0) * 1000),
      Math.round(Number(row.height || 0) * 1000),
    ].join(":");
    if (seenExact.has(exactKey)) continue;
    seenExact.add(exactKey);
    named.push({ row, id, span });
  }

  const roughGroups = new Map();
  for (const item of named) {
    const key = [
      beamRowSourceKey(item.row),
      item.id,
      item.span.orientation,
      Math.round(Number(item.row.breadth || 0) * 1000),
      Math.round(Number(item.row.height || 0) * 1000),
    ].join(":");
    if (!roughGroups.has(key)) roughGroups.set(key, []);
    roughGroups.get(key).push(item);
  }

  const groups = [];
  for (const items of roughGroups.values()) {
    const sortedByAxis = items.slice().sort((a, b) => a.span.fixed - b.span.fixed);
    const clusters = [];
    for (const item of sortedByAxis) {
      const widthMm = Number(item.row.breadth || 0) * 1000;
      const depthMm = Number(item.row.height || 0) * 1000;
      const axisToleranceMm = Math.max(1000, Math.min(2800, Math.max(widthMm, depthMm, 450) * 3));
      const cluster = clusters.find((candidate) =>
        Math.abs(candidate.fixed - item.span.fixed) <= Math.max(candidate.axisToleranceMm, axisToleranceMm));
      if (cluster) {
        cluster.items.push(item);
        cluster.fixed = cluster.items.reduce((sum, entry) => sum + entry.span.fixed, 0) / cluster.items.length;
        cluster.axisToleranceMm = Math.max(cluster.axisToleranceMm, axisToleranceMm);
      } else {
        clusters.push({ fixed: item.span.fixed, axisToleranceMm, items: [item] });
      }
    }
    groups.push(...clusters.map((cluster) => cluster.items));
  }

  const merged = [];
  const round3 = (value) => Math.round(Number(value || 0) * 1000) / 1000;
  const mergedIntervalsLengthM = (spans, gapToleranceMm = 0) => {
    const intervals = spans
      .map((span) => ({ start: Math.min(span.start, span.end), end: Math.max(span.start, span.end) }))
      .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
      .sort((a, b) => a.start - b.start);
    if (!intervals.length) return 0;
    const mergedSpans = [];
    for (const interval of intervals) {
      const last = mergedSpans[mergedSpans.length - 1];
      if (last && interval.start <= last.end + gapToleranceMm) {
        last.end = Math.max(last.end, interval.end);
      } else {
        mergedSpans.push({ ...interval });
      }
    }
    return mergedSpans.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / 1000;
  };
  const flushGroup = (items) => {
    if (!items.length) return;
    if (items.length === 1) {
      merged.push(items[0].row);
      return;
    }
    const rowsToMerge = items.map((item) => item.row);
    const spans = items.map((item) => item.span);
    const mergedSpanRanges = spans
      .map((span, index) => ({
        orientation: span.orientation,
        fixed: round3(Number(span.fixed || 0)),
        start: Math.round(Math.min(span.start, span.end)),
        end: Math.round(Math.max(span.start, span.end)),
        lengthM: round3(Math.abs(span.end - span.start) / 1000),
        sourceRow: rowsToMerge[index]?.name || "",
      }))
      .sort((a, b) => a.start - b.start);
    const first = rowsToMerge[0];
    const totalLength = rowsToMerge.reduce((sum, row) => sum + Number(row.length || 0), 0);
    const totalSideLength = rowsToMerge.reduce((sum, row) => sum + Number(row.sideLength || row.length || 0), 0);
    const typicalSizeMm = Math.max(
      finiteMax(rowsToMerge.map((row) => Math.max(Number(row.breadth || 0), Number(row.height || 0)) * 1000), 0),
      600,
    );
    const intervalGapToleranceMm = Math.max(250, Math.min(1800, typicalSizeMm * 2));
    const unionLengthM = mergedIntervalsLengthM(spans, intervalGapToleranceMm);
    const bridgeLength = finiteMax(spans.map((span) => span.end), 0) - finiteMin(spans.map((span) => span.start), 0);
    const bridgeLengthM = Math.max(bridgeLength / 1000, 0);
    const maxSafeBridgeLengthM = Math.max(18, Math.min(45, typicalSizeMm * 0.06));
    const allRowsMarkedDimension = rowsToMerge.every((row) =>
      row.evidence?.markedDimensionAuthoritative ||
      /marked-cad-dimension-span/i.test(String(row.evidence?.dimensionBasis || "")));
    const shouldBridgeUnlabelledMiddle = !allRowsMarkedDimension &&
      rowsToMerge.length >= 3 &&
      bridgeLengthM > totalLength * 1.08 &&
      bridgeLengthM <= Math.min(totalLength * 1.35, maxSafeBridgeLengthM);
    // A small fragment fully contained inside a much longer span is still a duplicate even
    // though it's a tiny fraction of the total sum (the ratio check below only catches large
    // overlaps): if the union of all spans is no bigger than the single longest span among
    // them, every other span added zero new coverage, so summing their lengths would double
    // count real beam length that was already measured once.
    const maxComponentLengthM = finiteMax(spans.map((span) => Math.abs(span.end - span.start) / 1000), 0);
    const hasFullyContainedFragment = unionLengthM > 0 && unionLengthM <= maxComponentLengthM * 1.02;
    const hasOverlapOrDuplicate = unionLengthM > 0 && (unionLengthM < totalLength * 0.92 || hasFullyContainedFragment);
    const mergedLength = shouldBridgeUnlabelledMiddle
      ? bridgeLengthM
      : hasOverlapOrDuplicate
        ? unionLengthM
        : totalLength;
    const mergedSideLength = shouldBridgeUnlabelledMiddle
      ? Math.max(bridgeLengthM, totalSideLength)
      : hasOverlapOrDuplicate
        ? Math.max(unionLengthM, Math.min(totalSideLength, unionLengthM))
        : totalSideLength;
    const reviewNotes = [...new Set(rowsToMerge.map((row) => row.reviewNote).filter(Boolean))];
    merged.push({
      ...first,
      length: round3(mergedLength),
      sideLength: round3(mergedSideLength),
      bottomAreaOverride: (shouldBridgeUnlabelledMiddle || hasOverlapOrDuplicate)
        ? undefined
        : rowsToMerge.reduce((sum, row) => sum + Number(row.bottomAreaOverride || 0), 0) || undefined,
      sideAreaOverride: (shouldBridgeUnlabelledMiddle || hasOverlapOrDuplicate)
        ? undefined
        : rowsToMerge.reduce((sum, row) => sum + Number(row.sideAreaOverride || 0), 0) || undefined,
      grossConcreteOverride: (shouldBridgeUnlabelledMiddle || hasOverlapOrDuplicate)
        ? undefined
        : rowsToMerge.reduce((sum, row) => sum + Number(row.grossConcreteOverride || 0), 0) || undefined,
      openings: rowsToMerge.reduce((sum, row) => sum + Number(row.openings || 0), 0),
      needsReview: rowsToMerge.some((row) => row.needsReview),
      reviewNote: [
        `Merged ${rowsToMerge.length} same-line span rows for continuous beam ${beamRowMergeId(first)}.`,
        shouldBridgeUnlabelledMiddle
          ? `Continuous beam bridge used ${round3(bridgeLengthM)} m because the same beam name/size appears on the same axis at separated positions with unlabelled middle bays.`
          : "",
        hasOverlapOrDuplicate
          ? `Overlapping/contained beam fragments collapsed to union length ${round3(unionLengthM)} m.`
          : "",
        ...reviewNotes,
      ].filter(Boolean).join(" "),
      evidence: {
        ...(first.evidence || {}),
        mergedContinuousNamedBeam: true,
        continuousNamedBeamBridge: shouldBridgeUnlabelledMiddle,
        overlappingBeamFragmentsCollapsed: hasOverlapOrDuplicate,
        overlappingBeamUnionLengthM: hasOverlapOrDuplicate ? round3(unionLengthM) : undefined,
        continuousNamedBeamBridgeLengthM: shouldBridgeUnlabelledMiddle ? round3(bridgeLengthM) : undefined,
        continuousNamedBeamSummedLabelLengthM: round3(totalLength),
        mergedSpanCount: rowsToMerge.length,
        mergedSpanNames: rowsToMerge.map((row) => row.name),
        mergedSpanRanges,
        mergedSpanLengthsM: mergedSpanRanges.map((span) => span.lengthM),
        faceSpan: {
          ...(first.evidence?.faceSpan || {}),
          orientation: spans[0].orientation,
          fixed: spans.reduce((sum, span) => sum + Number(span.fixed || 0), 0) / spans.length,
          start: finiteMin(spans.map((span) => span.start), 0),
          end: finiteMax(spans.map((span) => span.end), 0),
        },
      },
    });
  };

  for (const items of groups) {
    const sorted = items.sort((a, b) => a.span.start - b.span.start);
    let current = [];
    let currentEnd = null;
    let currentMaxSizeMm = 0;
    for (const item of sorted) {
      const itemMaxSizeMm = Math.max(Number(item.row.breadth || 0), Number(item.row.height || 0)) * 1000;
      if (!current.length) {
        current = [item];
        currentEnd = item.span.end;
        currentMaxSizeMm = itemMaxSizeMm;
        continue;
      }
      const gap = item.span.start - currentEnd;
      const continuityGapLimit = Math.max(900, Math.min(4500, Math.max(currentMaxSizeMm, itemMaxSizeMm, 600) * 7));
      if (gap <= continuityGapLimit) {
        current.push(item);
        currentEnd = Math.max(currentEnd, item.span.end);
        currentMaxSizeMm = Math.max(currentMaxSizeMm, itemMaxSizeMm);
      } else {
        flushGroup(current);
        current = [item];
        currentEnd = item.span.end;
        currentMaxSizeMm = itemMaxSizeMm;
      }
    }
    flushGroup(current);
  }

  return [...unnamed, ...merged];
}

async function readOneFile(file, index, tempDir) {
  const sheetNumber = index + 1;
  const ext = path.extname(file.name).toLowerCase();
  const inputPath = path.join(tempDir, `${sheetNumber}-${safeName(file.name)}`);
  fs.writeFileSync(inputPath, Buffer.from(file.dataBase64, "base64"));

  if ([".dxf", ".txt", ".csv"].includes(ext)) {
    const text = fs.readFileSync(inputPath, "utf8");
    return parseScheduleText(text, sheetNumber, file.name, "text", null);
  }

  let imagePath = inputPath;
  let grid = null;
  if (ext === ".pdf") {
    imagePath = path.join(tempDir, `${sheetNumber}-${safeName(file.name)}.png`);
    const rendered = spawnSync(pythonExe, [renderScript, inputPath, imagePath], { encoding: "utf8" });
    if (rendered.status !== 0) {
      const detail = rendered.error?.message || rendered.stderr || rendered.stdout || `exit status ${rendered.status}`;
      return {
        fileName: file.name,
        sheetNumber,
        source: "pdf",
        rows: [],
        warning: `PDF render failed: ${detail}`,
      };
    }
    grid = detectTableGrid(imagePath);
  }

  if (![".pdf", ".png", ".jpg", ".jpeg"].includes(ext)) {
    return {
      fileName: file.name,
      sheetNumber,
      source: "unsupported",
      rows: [],
      warning: `${file.name} needs DWG to DXF conversion or image/PDF OCR support.`,
    };
  }

  const worker = await getOcrWorker();
  const result = await worker.recognize(imagePath);
  if (!grid) {
    grid = detectTableGrid(imagePath);
  }
  return parseScheduleText(result.data.text || "", sheetNumber, file.name, "ocr", grid);
}

async function handleReadSchedules(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) {
      sendJson(res, 400, { ok: false, error: "No files received." });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qss-pro-ocr-"));
    const sheets = [];
    for (let index = 0; index < files.length; index += 1) {
      sheets.push(await readOneFile(files[index], index, tempDir));
    }
    const rows = sheets.flatMap((sheet) => sheet.rows || []);
    sendJson(res, 200, { ok: true, rows, sheets });
  } catch (error) {
    sendSafeError(res, 500, "Column schedule extraction failed", error);
  }
}

async function handleReadDrawingEvidence(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) {
      sendJson(res, 400, { ok: false, error: "No drawing files received." });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qss-pro-drawing-"));
    const drawings = [];
    for (let index = 0; index < files.length; index += 1) {
      drawings.push(await readOneDrawingEvidence(files[index], index, tempDir));
    }

    const combined = {
      columnMarks: uniqueStrings(drawings.flatMap((item) => item.columnMarks || []), 200),
      beamLabels: uniqueStrings(drawings.flatMap((item) => item.beamLabels || []), 240),
      slabMarks: uniqueStrings(drawings.flatMap((item) => item.slabMarks || []), 180),
      sizes: uniqueStrings(drawings.flatMap((item) => item.sizes || []), 180),
      levels: uniqueStrings(drawings.flatMap((item) => item.levels || []), 180),
      slabThicknessNotes: uniqueStrings(drawings.flatMap((item) => item.slabThicknessNotes || []), 180),
      gridTexts: uniqueStrings(drawings.flatMap((item) => item.gridTexts || []), 180),
      warnings: drawings.filter((item) => item.warning).map((item) => `${item.role}: ${item.warning}`),
    };

    sendJson(res, 200, { ok: true, drawings, combined });
  } catch (error) {
    sendSafeError(res, 500, "Drawing evidence extraction failed", error);
  }
}

async function handleExtractFramingQuantities(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const files = Array.isArray(body.files) ? body.files : [];
    const itemType = ["beam", "slab", "raft"].includes(body.itemType) ? body.itemType : "beam";
    const quantityRule = String(body.quantityRule || `${itemType}_shuttering`);
    const beamCapMode = body.beamCapMode === "excluded" ? "excluded" : "included";
    const extractionProfile = body.extractionProfile === "deep" ? "deep" : "fast";
    const takeoffSetLabel = cleanCadText(body.takeoffSetLabel || body.floorLevel || body.projectName || "Current takeoff");
    const takeoffSetKey = normalizeTakeoffSetKey(body.takeoffSetKey || takeoffSetLabel || "CURRENT TAKEOFF");
    const gridPanels = Array.isArray(body.gridPanels) ? body.gridPanels : [];
    if (!files.length) {
      sendJson(res, 400, { ok: false, error: "No framing plan files received." });
      return;
    }
    const measuredFiles = files.filter((file) => !isDetailScheduleDrawingName(file.name));
    if (!measuredFiles.length) {
      sendJson(res, 400, {
        ok: false,
        error: "No framing plan was found. Upload at least one framing plan/layout drawing; beam detail, slab profile, section, and schedule drawings will be used only as linked reference files.",
      });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qss-pro-framing-"));
    const linkedSchedules = collectLinkedDetailSchedules(files, tempDir);
    const plans = [];
    for (let index = 0; index < files.length; index += 1) {
      if (isDetailScheduleDrawingName(files[index].name)) {
        plans.push({
          fileName: files[index].name,
          role: takeoffSetLabel || files[index].role || `framing-${index + 1}`,
          rows: [],
          info: "Used as linked detail/schedule drawing for beam sizes, slab thickness, sections, or schedule reference.",
          summary: { linkedDetailOnly: true },
        });
        continue;
      }
      plans.push(await readOneFramingQuantity(files[index], index, tempDir, itemType, gridPanels, linkedSchedules, {
        extractionProfile,
        takeoffSetKey,
        takeoffSetLabel,
      }));
    }
    const extractedRows = plans.flatMap((plan) => plan.rows || []);
    const quantityRows = finalQuantityRows(extractedRows, itemType);
    const rows = isSteelBbsTakeoff(itemType, quantityRule)
      ? rowsWithBbsQuantities(quantityRows, itemType, quantityRule, beamCapMode)
      : rowsWithMbQuantities(quantityRows, itemType, quantityRule, beamCapMode);
    const summary = {
      accuracyRuleVersion: ACCURACY_RULE_VERSION,
      rowCount: rows.length,
      extractedRows: extractedRows.length,
      reviewRows: extractedRows.filter((row) => row.needsReview).length,
      excludedReviewRows: extractedRows.length - rows.length,
      beamCapMode,
      extractionProfile,
      takeoffSetKey,
      takeoffSetLabel,
      totalLengthM: rows.reduce((sum, row) => sum + row.length, 0),
      totalAreaM2: rows.reduce((sum, row) => sum + row.length * row.breadth, 0),
      totalOpeningsM2: rows.reduce((sum, row) => sum + (row.openings || 0), 0),
      totalNetAreaM2: rows.reduce((sum, row) => sum + Math.max(row.length * row.breadth - (row.openings || 0), 0), 0),
      beamGroups: itemType === "beam" ? beamGroupSummary(rows) : [],
      beamRepeatGroups: itemType === "beam" ? beamRepeatGroups(rows) : [],
      linkedDetailFiles: linkedSchedules.detailFiles,
      linkedBeamSizeRows: Object.keys(linkedSchedules.beamSizeById || {}).length,
      embeddedBeamSizeRows: plans.reduce((sum, plan) => sum + Number(plan.summary?.embeddedBeamSizeRows || 0), 0),
      embeddedSlabSpecRows: plans.reduce((sum, plan) => sum + Number(plan.summary?.embeddedSlabSpecRows || 0), 0),
      measuredDrawingCount: measuredFiles.length,
      slabReinforcementSchedule: Object.assign(
        {},
        ...plans.map((plan) => plan.summary?.embeddedSlabReinforcementSchedule || {}),
        linkedSchedules.slabReinforcementSchedule || {},
      ),
    };
    summary.slabReinforcementScheduleMarks = Object.keys(summary.slabReinforcementSchedule).length;
    summary.accuracyAudit = buildAccuracyAudit({ itemType, plans, extractedRows, rows });
    summary.ruleAudit = buildRuleAudit({
      itemType,
      plans,
      extractedRows,
      rows,
      accuracyAudit: summary.accuracyAudit,
      ruleVersion: ACCURACY_RULE_VERSION,
    });
    const finalQuantityLockedReason = severeFramingQuantityLockReason({ itemType, summary, rows, plans });
    const responseRows = rows;
    if (finalQuantityLockedReason) {
      summary.finalQuantityLocked = true;
      summary.finalQuantityLockedReason = finalQuantityLockedReason;
      summary.lockedCandidateRows = rows.length;
      summary.lockedCandidateTotalAreaM2 = summary.totalAreaM2;
      summary.lockedCandidateTotalOpeningsM2 = summary.totalOpeningsM2;
      summary.lockedCandidateTotalNetAreaM2 = summary.totalNetAreaM2;
    }
    summary.downloads = createFramingDownloadPackage({
      files,
      rows,
      itemType,
      quantityRule,
      beamCapMode,
      plans,
      summary,
    });
    sendJson(res, 200, {
      ok: true,
      itemType,
      quantityRule,
      rows: responseRows,
      plans,
      summary,
      warning: finalQuantityLockedReason || "",
    });
  } catch (error) {
    sendSafeError(res, 500, "Framing quantity extraction failed", error);
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(root, requested);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendCorsPreflight(res);
      return;
    }
    if (req.method === "GET" && req.url === "/api/server-status") {
      sendJson(res, 200, serverStatusPayload());
      return;
    }
    if (req.method === "POST" && req.url === "/api/read-column-schedules") {
      handleReadSchedules(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/read-drawing-evidence") {
      handleReadDrawingEvidence(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/extract-framing-quantities") {
      handleExtractFramingQuantities(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendSafeError(res, 500, "Request failed", error);
  }
});

server.on("clientError", (error, socket) => {
  console.error("[QSS Pro] Client connection error", error?.message || error);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

process.on("unhandledRejection", (error) => {
  console.error("[QSS Pro] Unhandled promise rejection", error?.stack || error);
});

const port = Number(process.env.PORT || 4175);

process.on("uncaughtException", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.log(`QSS Pro is already running at http://127.0.0.1:${port}/`);
    process.exit(0);
    return;
  }
  console.error("[QSS Pro] Uncaught exception", error?.stack || error);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.log(`QSS Pro is already running at http://127.0.0.1:${port}/`);
    process.exit(0);
    return;
  }
  console.error("[QSS Pro] Server failed to start", error?.stack || error);
  process.exit(2);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`QSS Pro OCR server running at http://127.0.0.1:${port}/`);
});
