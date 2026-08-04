const QSS_APP_RULE_VERSION = "qss-pro-accuracy-2026-07-29-strict-boundary-panels-v115";
const CAD_EXTRACTION_TIMEOUT_MS = 900000;

const state = {
  rows: [],
  selectedRowId: null,
  uploadedFile: null,
  history: [],
  drawingEvidence: null,
  framingBeamGroups: [],
  framingPlanWarnings: [],
  framingQuantityCache: {
    key: "",
    data: null,
  },
  currentDownloads: null,
  accuracyAudit: null,
  ruleAudit: null,
  framingQuantityLockReason: "",
  serverStatus: null,
  isExtracting: false,
  activePage: "quantity",
  loginOtp: "",
  account: {
    name: "",
    email: "",
    userId: "",
    loggedIn: false,
  },
  settings: {
    language: "english",
    theme: "system",
    areaUnit: "sqm",
    lengthUnit: "rmt",
    volumeUnit: "cum",
    weightUnit: "kg",
    saveData: "7days",
  },
  detectedGrid: {
    x: [],
    y: [],
  },
};

const localApiOrigin = "http://127.0.0.1:4175";
const apiBaseUrl = window.location.protocol === "file:"
  ? localApiOrigin
  : "";

let extractionProgressTimer = null;
let extractionProgressPercent = 0;

function apiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

function hasDwgFiles(files = []) {
  return files.some((file) => /\.(?:dwg|bak)$/i.test(file.name || ""));
}

async function readServerStatus({ force = false } = {}) {
  if (state.serverStatus && !force) return state.serverStatus;
  const response = await fetch(apiUrl("/api/server-status"), { cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `Server returned ${response.status}.`);
  }
  if (data.rulebook && data.rulebook.ok === false) {
    throw new Error("Rulebook validation failed. Start QSS Pro from the leakproof launcher so rules, audit checks, and golden tests are validated before extraction.");
  }
  state.serverStatus = data;
  return data;
}

async function assertDwgConversionReady(files = []) {
  if (!hasDwgFiles(files)) return;
  const status = await readServerStatus({ force: true });
  if (!status.accoreConsoleAvailable) {
    throw new Error(status.dwgHelp || "AutoCAD Core Console is not available for DWG/BAK conversion. Upload DXF/PDF instead.");
  }
  if (!status.dwgConversionReady) {
    throw new Error(status.dwgHelp || "DWG/BAK conversion is blocked in this local server session. Start QSS Pro with the Windows launcher, or upload DXF.");
  }
}

const quantityRules = {
  column_concrete: {
    label: "Column concrete",
    unit: "m3",
    calculate: (row) => columnMainConcrete(row) + columnCapConcrete(row),
  },
  column_shuttering: {
    label: "Column shuttering",
    unit: "m2",
    calculate: (row) => columnMainShuttering(row) + columnCapShuttering(row),
  },
  column_steel: {
    label: "Column steel BBS",
    unit: "kg",
    calculate: (row) => row.length * row.nos * steelUnitWeight(row.dia),
  },
  beam_concrete: {
    label: "Beam concrete",
    unit: "m3",
    calculate: (row) => beamConcreteBreakdown(row).net,
  },
  beam_shuttering: {
    label: "Beam shuttering",
    unit: "m2",
    calculate: (row) => beamShutteringBreakdown(row).total,
  },
  beam_steel: {
    label: "Beam steel BBS",
    unit: "kg",
    calculate: (row) => row.length * row.nos * steelUnitWeight(row.dia),
  },
  slab_concrete: {
    label: "Slab concrete",
    unit: "m3",
    calculate: (row) => Math.max(row.length * row.breadth - row.openings, 0) * row.height * row.nos,
  },
  slab_shuttering: {
    label: "Slab shuttering",
    unit: "m2",
    calculate: (row) => Math.max(row.length * row.breadth - row.openings, 0) * row.nos,
  },
  slab_steel: {
    label: "Slab steel",
    unit: "kg",
    calculate: (row) => {
      const spacing = row.spacing > 0 ? row.spacing / 1000 : 0.15;
      const xBars = Math.floor(row.breadth / spacing) + 1;
      const yBars = Math.floor(row.length / spacing) + 1;
      const totalLength = (xBars * row.length + yBars * row.breadth) * row.nos;
      return totalLength * steelUnitWeight(row.dia);
    },
  },
  steel_bbs: {
    label: "Steel BBS",
    unit: "kg",
    calculate: (row) => row.length * row.nos * steelUnitWeight(row.dia),
  },
  raft_concrete: {
    label: "Raft concrete",
    unit: "m3",
    calculate: (row) => row.length * row.breadth * row.height * row.nos,
  },
  raft_shuttering: {
    label: "Raft shuttering",
    unit: "m2",
    calculate: (row) => 2 * (row.length + row.breadth) * row.height * row.nos,
  },
  raft_steel: {
    label: "Raft steel",
    unit: "kg",
    calculate: (row) => {
      const spacing = row.spacing > 0 ? row.spacing / 1000 : 0.15;
      const xBars = Math.floor(row.breadth / spacing) + 1;
      const yBars = Math.floor(row.length / spacing) + 1;
      const totalLength = (xBars * row.length + yBars * row.breadth) * row.nos;
      return totalLength * steelUnitWeight(row.dia);
    },
  },
  brickwork: {
    label: "Brickwork / blockwork",
    unit: "m3",
    calculate: (row) => Math.max(row.length * row.height - row.openings, 0) * row.breadth * row.nos,
  },
  plaster: {
    label: "Plaster",
    unit: "m2",
    calculate: (row) => Math.max(row.length * row.height - row.openings, 0) * row.nos,
  },
  paint: {
    label: "Paint",
    unit: "m2",
    calculate: (row) => Math.max(row.length * row.height - row.openings, 0) * row.nos,
  },
  flooring: {
    label: "Flooring",
    unit: "m2",
    calculate: (row) => row.length * row.breadth * row.nos,
  },
};

const quantityMenu = {
  structural: {
    raft: {
      label: "Raft",
      rules: [
        ["raft_concrete", "Concrete"],
        ["raft_shuttering", "Shuttering"],
        ["raft_steel", "Steel"],
      ],
    },
    column: {
      label: "Column",
      rules: [
        ["column_concrete", "Concrete"],
        ["column_shuttering", "Shuttering"],
        ["column_steel", "Steel"],
      ],
    },
    beam: {
      label: "Beam",
      rules: [
        ["beam_concrete", "Concrete"],
        ["beam_shuttering", "Shuttering"],
        ["beam_steel", "Steel"],
      ],
    },
    slab: {
      label: "Slab",
      rules: [
        ["slab_concrete", "Concrete"],
        ["slab_shuttering", "Shuttering"],
        ["slab_steel", "Steel"],
      ],
    },
  },
  architectural: {
    wall: {
      label: "Wall work",
      rules: [
        ["brickwork", "Brickwork / blockwork"],
        ["plaster", "Plaster"],
        ["paint", "Paint"],
      ],
    },
    finish: {
      label: "Surface finish",
      rules: [
        ["plaster", "Plaster"],
        ["paint", "Paint"],
      ],
    },
    floor: {
      label: "Floor work",
      rules: [["flooring", "Flooring"]],
    },
  },
};

const elements = {
  pageTitle: document.querySelector("#page-title"),
  navButtons: document.querySelectorAll(".nav-button"),
  appSections: document.querySelectorAll(".app-section"),
  gridLinesConfirm: document.querySelector("#grid-lines-confirm"),
  xGridConfirm: document.querySelector("#x-grid-confirm"),
  yGridConfirm: document.querySelector("#y-grid-confirm"),
  drawingType: document.querySelector("#drawing-type"),
  drawingFile: document.querySelector("#drawing-file"),
  fileName: document.querySelector("#file-name"),
  preview: document.querySelector("#drawing-preview"),
  measureOverlay: document.querySelector("#measure-overlay"),
  viewerStatus: document.querySelector("#viewer-status"),
  readGrid: document.querySelector("#read-grid"),
  readerStatus: document.querySelector("#reader-status"),
  clearPreview: document.querySelector("#clear-preview"),
  scaleOutput: document.querySelector("#scale-output"),
  scaleYOutput: document.querySelector("#scale-y-output"),
  measureOutput: document.querySelector("#measure-output"),
  workGroup: document.querySelector("#work-group"),
  quantityRule: document.querySelector("#quantity-rule"),
  beamCapModeLabel: document.querySelector("#beam-cap-mode-label"),
  beamCapMode: document.querySelector("#beam-cap-mode"),
  calculationAreaLabel: document.querySelector("#calculation-area-label"),
  calculationAreaMode: document.querySelector("#calculation-area-mode"),
  memberFilterLabel: document.querySelector("#member-filter-label"),
  memberFilter: document.querySelector("#member-filter"),
  memberOccurrenceLabel: document.querySelector("#member-occurrence-label"),
  memberOccurrence: document.querySelector("#member-occurrence"),
  gridAreaPanel: document.querySelector("#grid-area-panel"),
  gridXFrom: document.querySelector("#grid-x-from"),
  gridXTo: document.querySelector("#grid-x-to"),
  gridYFrom: document.querySelector("#grid-y-from"),
  gridYTo: document.querySelector("#grid-y-to"),
  quantityItemLabel: document.querySelector("#quantity-item-label"),
  userPlan: document.querySelector("#user-plan"),
  outputType: document.querySelector("#output-type"),
  defaultFloor: document.querySelector("#default-floor"),
  deductionMode: document.querySelector("#deduction-mode"),
  columnHeightPanel: document.querySelector("#column-height-panel"),
  columnDrawingSetPanel: document.querySelector("#column-drawing-set-panel"),
  columnLayoutMethod: document.querySelector("#column-layout-method"),
  columnHeightSource: document.querySelector("#column-height-source"),
  manualColumnHeight: document.querySelector("#manual-column-height"),
  manualColumnHeightUnit: document.querySelector("#manual-column-height-unit"),
  columnHeightNote: document.querySelector("#column-height-note"),
  foundationColumnLayoutFile: document.querySelector("#foundation-column-layout-file"),
  foundationColumnLayoutName: document.querySelector("#foundation-column-layout-name"),
  columnScheduleFiles: document.querySelector("#column-schedule-files"),
  columnScheduleFileCount: document.querySelector("#column-schedule-file-count"),
  columnBatchPanel: document.querySelector("#column-batch-panel"),
  columnScheduleList: document.querySelector("#column-schedule-list"),
  readColumnSchedules: document.querySelector("#read-column-schedules"),
  columnReaderStatus: document.querySelector("#column-reader-status"),
  readinessSummary: document.querySelector("#readiness-summary"),
  readinessList: document.querySelector("#readiness-list"),
  reviewList: document.querySelector("#review-list"),
  extractQuantity: document.querySelector("#extract-quantity"),
  extractStatus: document.querySelector("#extract-status"),
  quickReferenceDownload: document.querySelector("#quick-reference-download"),
  lowerFramingFile: document.querySelector("#lower-framing-file"),
  lowerFramingName: document.querySelector("#lower-framing-name"),
  upperFramingFile: document.querySelector("#upper-framing-file"),
  upperFramingName: document.querySelector("#upper-framing-name"),
  framingDrawingPanel: document.querySelector("#framing-drawing-panel"),
  framingPlanFiles: document.querySelector("#framing-plan-files"),
  framingPlanFileCount: document.querySelector("#framing-plan-file-count"),
  tableActions: document.querySelector("#table-actions"),
  memberTableWrap: document.querySelector("#member-table-wrap"),
  detailUpgradeMessage: document.querySelector("#detail-upgrade-message"),
  memberBody: document.querySelector("#member-body"),
  addRow: document.querySelector("#add-row"),
  duplicateRow: document.querySelector("#duplicate-row"),
  deleteRow: document.querySelector("#delete-row"),
  loadSample: document.querySelector("#load-sample"),
  exportCsv: document.querySelector("#export-csv"),
  resultItem: document.querySelector("#result-item"),
  resultTotal: document.querySelector("#result-total"),
  resultCount: document.querySelector("#result-count"),
  accuracyAudit: document.querySelector("#accuracy-audit"),
  standardNote: document.querySelector("#standard-note"),
  premiumMessage: document.querySelector("#premium-message"),
  premiumDownloadPanel: document.querySelector("#premium-download-panel"),
  premiumDownloadStatus: document.querySelector("#premium-download-status"),
  downloadExcel: document.querySelector("#download-excel"),
  downloadReferenceDwg: document.querySelector("#download-reference-dwg"),
  summaryOutput: document.querySelector("#summary-output"),
  saveCurrentProject: document.querySelector("#save-current-project"),
  historyStatus: document.querySelector("#history-status"),
  historyList: document.querySelector("#history-list"),
  userName: document.querySelector("#user-name"),
  loginEmail: document.querySelector("#login-email"),
  loginOtp: document.querySelector("#login-otp"),
  sendOtp: document.querySelector("#send-otp"),
  verifyOtp: document.querySelector("#verify-otp"),
  otpStatus: document.querySelector("#otp-status"),
  profileUserName: document.querySelector("#profile-user-name"),
  profileUserEmail: document.querySelector("#profile-user-email"),
  profileUserId: document.querySelector("#profile-user-id"),
  profilePlanName: document.querySelector("#profile-plan-name"),
  buyPremium: document.querySelector("#buy-premium"),
  settingLanguage: document.querySelector("#setting-language"),
  settingTheme: document.querySelector("#setting-theme"),
  settingAreaUnit: document.querySelector("#setting-area-unit"),
  settingLengthUnit: document.querySelector("#setting-length-unit"),
  settingVolumeUnit: document.querySelector("#setting-volume-unit"),
  settingWeightUnit: document.querySelector("#setting-weight-unit"),
  settingSaveData: document.querySelector("#setting-save-data"),
  saveDataPremiumMessage: document.querySelector("#save-data-premium-message"),
};

function numberValue(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function displayQuantity(value, unit) {
  if (unit === "m2") {
    return state.settings.areaUnit === "sqft"
      ? { value: value * 10.7639, unit: "sqft" }
      : { value, unit: "sqm" };
  }
  if (unit === "m3") {
    return state.settings.volumeUnit === "cft"
      ? { value: value * 35.3147, unit: "cft" }
      : { value, unit: "cum" };
  }
  if (unit === "kg") {
    return state.settings.weightUnit === "mt"
      ? { value: value / 1000, unit: "mt" }
      : { value, unit: "kg" };
  }
  if (unit === "m") {
    return state.settings.lengthUnit === "rft"
      ? { value: value * 3.28084, unit: "rft" }
      : { value, unit: "rmt" };
  }
  return { value, unit };
}

function formatQuantity(value, unit) {
  const display = displayQuantity(value, unit);
  return `${display.value.toFixed(3)} ${display.unit}`;
}

function steelUnitWeight(diaMm) {
  return (diaMm * diaMm) / 162;
}

function columnCapHeight(row) {
  return Math.max(row.capHeight || 0, 0);
}

function columnMainHeight(row) {
  return Math.max(row.height - columnCapHeight(row), 0);
}

function columnMainConcrete(row) {
  return row.length * row.breadth * columnMainHeight(row) * row.nos;
}

function columnCapConcrete(row) {
  return row.length * row.breadth * columnCapHeight(row) * row.nos;
}

function columnMainShuttering(row) {
  return 2 * (row.length + row.breadth) * columnMainHeight(row) * row.nos;
}

function columnCapShuttering(row) {
  return Math.max(row.capExposedPerimeter || 0, 0) * columnCapHeight(row) * row.nos;
}

function beamShutteringBreakdown(row) {
  const length = Math.max(row.length || 0, 0);
  const sideLength = Math.max(row.sideLength || length, 0);
  const breadth = Math.max(row.breadth || 0, 0);
  const depth = Math.max(row.height || 0, 0);
  const nos = Math.max(row.nos || 0, 0);
  const slabThickness = Math.min(Math.max(row.slabThickness || 0, 0), depth);
  const bottomJointDeduction = Math.max(row.bottomJointDeduction || 0, 0);
  const sideJointDeduction = Math.max(row.sideJointDeduction || 0, 0);
  const calculatedBottomArea = Math.max(length * breadth - bottomJointDeduction, 0);
  const calculatedSideArea = Math.max(2 * sideLength * Math.max(depth - slabThickness, 0) - sideJointDeduction, 0);
  const bottomArea = Number(row.bottomAreaOverride || 0) || calculatedBottomArea;
  const sideArea = Number(row.sideAreaOverride || 0) || calculatedSideArea;
  const capShutteringAddition = elements.beamCapMode?.value === "included"
    ? Math.max(
        Number(row.columnCapShuttering || 0) ||
        Number(row.columnCapShutteringOverride || 0) ||
        Number(row.beamCapShuttering || 0) ||
        Number(row.sideJointDeduction || 0),
        0,
      )
    : 0;
  return {
    bottomArea,
    sideArea,
    capShutteringAddition,
    sideLength,
    slabThickness,
    bottomJointDeduction,
    sideJointDeduction,
    total: (bottomArea + sideArea + capShutteringAddition) * nos,
  };
}

function isBeamCapModeSelection() {
  return elements.drawingType.value === "structural" &&
    elements.workGroup.value === "beam" &&
    ["beam_concrete", "beam_shuttering"].includes(getSelectedQuantityKey());
}

function isBeamConcreteSelection() {
  return elements.drawingType.value === "structural" &&
    elements.workGroup.value === "beam" &&
    getSelectedQuantityKey() === "beam_concrete";
}

function beamConcreteBreakdown(row) {
  const singleGross = Number(row.grossConcreteOverride || 0) ||
    (Math.max(row.length || 0, 0) *
      Math.max(row.breadth || 0, 0) *
      Math.max(row.height || 0, 0));
  const gross = singleGross * Math.max(row.nos || 0, 0);
  const deduction = elements.beamCapMode?.value === "excluded"
    ? Math.max(row.columnCapDeduction || 0, 0) * Math.max(row.nos || 0, 0)
    : 0;
  return {
    gross,
    capDeduction: deduction,
    net: Math.max(gross - deduction, 0),
  };
}

function getComponentBreakdown(row, key = getSelectedQuantityKey()) {
  if (key === "column_concrete") {
    return { main: columnMainConcrete(row), cap: columnCapConcrete(row), capLabel: "Column cap concrete" };
  }
  if (key === "column_shuttering") {
    return { main: columnMainShuttering(row), cap: columnCapShuttering(row), capLabel: "Column cap shuttering" };
  }
  if (key === "beam_shuttering") {
    const breakdown = beamShutteringBreakdown(row);
    return {
      main: breakdown.total,
      cap: 0,
      capLabel: "",
      bottomArea: breakdown.bottomArea * Math.max(row.nos || 0, 0),
      sideArea: breakdown.sideArea * Math.max(row.nos || 0, 0),
      columnCapShuttering: breakdown.capShutteringAddition * Math.max(row.nos || 0, 0),
    };
  }
  if (key === "beam_concrete") {
    const breakdown = beamConcreteBreakdown(row);
    return {
      main: breakdown.net,
      cap: 0,
      capLabel: "",
      grossBeamConcrete: breakdown.gross,
      columnCapDeduction: breakdown.capDeduction,
    };
  }
  return { main: quantityRules[key].calculate(row), cap: 0, capLabel: "" };
}

function getStandardNote(item) {
  const notes = {
    column_concrete: "Column concrete must show main column quantity up to beam bottom and column cap quantity from beam bottom to slab top separately.",
    column_shuttering: "Column shuttering must show main column shuttering up to beam bottom and only exposed column cap shuttering from beam bottom to slab top. Faces covered by beam sides are not measured again.",
    column_steel: "Column reinforcement BBS to be measured by bar mark, diameter, cutting length, number of bars, and unit weight d^2/162 kg/m.",
    beam_concrete: "Beam concrete is measured in cubic metre. If column concrete is already measured up to slab top, use column caps excluded so support/cap overlap is deducted from beam concrete.",
    beam_shuttering: "Beam shuttering is measured as soffit/bottom area plus exposed side area. Dotted/hidden slab-side beam faces deduct slab thickness; continuous/elevation faces are full height. Use column caps included/excluded to control cap-side shuttering at supports.",
    beam_steel: "Beam reinforcement BBS to be measured by bar mark, diameter, cutting length, number of bars, and unit weight d^2/162 kg/m.",
    slab_concrete: "Slab concrete to be measured in cubic metre using net slab area after applicable cutout/opening deductions multiplied by thickness as per IS 1200 measurement basis.",
    slab_shuttering: "Slab soffit shuttering to be measured in square metre using net slab soffit area after applicable cutout/opening deductions as per IS 1200 formwork measurement basis.",
    slab_steel: "Slab reinforcement to be measured in kg using bar diameter, spacing, layers, cutting lengths, and unit weight d^2/162 kg/m.",
    steel_bbs: "Reinforcement BBS to be measured by bar mark, diameter, cutting length, number of bars, and unit weight d^2/162 kg/m. Detailing basis should follow IS 2502/SP 34 with RCC design references from IS 456.",
    raft_concrete: "Raft concrete to be measured in cubic metre using raft plan area multiplied by thickness as per IS 1200 measurement basis.",
    raft_shuttering: "Raft shuttering to be measured for exposed edge/perimeter formwork in square metre as per IS 1200 formwork measurement basis.",
    raft_steel: "Raft reinforcement to be measured as BBS/mesh steel in kg using bar diameter, spacing, layers, cutting lengths, and unit weight d^2/162 kg/m.",
    brickwork: "Brickwork/blockwork to be measured in cubic metre with deductions for openings as per IS 1200 masonry measurement basis.",
    plaster: "Plaster to be measured in square metre with opening deductions as per IS 1200 finishing measurement basis.",
    paint: "Painting to be measured in square metre as per IS 1200 painting/finishing measurement basis.",
    flooring: "Flooring to be measured in square metre as per IS 1200 flooring measurement basis.",
  };
  return notes[item] || "Quantities will follow applicable IS 1200 mode of measurement.";
}

function getRule() {
  return quantityRules[getSelectedQuantityKey()];
}

function getSelectedQuantityKey() {
  return elements.quantityRule.value || "column_concrete";
}

function isPremiumUser() {
  return elements.userPlan.value === "premium";
}

function referenceMarkCount(downloads = state.currentDownloads) {
  return Number(downloads?.panelMarks || 0) || Number(downloads?.reviewMarks || 0) || 0;
}

function lockedReviewReferenceHasMarks(downloads = state.currentDownloads) {
  return Boolean(
    state.framingQuantityLockReason &&
    downloads?.referenceUrl &&
    referenceMarkCount(downloads) > 0
  );
}

function compactQuantityLockMessage(message = state.framingQuantityLockReason) {
  const text = String(message || "").trim();
  if (!text) return "No verified quantity rows found.";
  const coverage = text.match(/only\s+([\d.]+)%\s+of\s+verified slab panel/i)?.[1];
  const area = text.match(/measured slab area\s+([\d.]+)\s*sqm/i)?.[1];
  const review = text.match(/([\d.]+)%\s+of\s+slab rows need review/i)?.[1];
  if (/Slab quantity locked|verified slab panel|false closed panel|full floor|written dimensions/i.test(text)) {
    return [
      "Final slab quantity not released.",
      coverage ? `Panel coverage: ${coverage}%.` : "",
      review ? `Review rows: ${review}%.` : "",
      area ? `Measured review area: ${area} sqm.` : "",
      "Check the reference drawing and written panel dimensions before using this quantity."
    ].filter(Boolean).join(" ");
  }
  return text.length > 360 ? `${text.slice(0, 360)}...` : text;
}

function syncQuickReferenceDownload() {
  const link = elements.quickReferenceDownload;
  if (!link) return;
  const downloads = state.currentDownloads;
  const ready = lockedReviewReferenceHasMarks(downloads);
  link.hidden = !ready;
  link.classList.toggle("is-disabled", !ready);
  link.toggleAttribute("aria-disabled", !ready);
  if (ready) {
    const markCount = referenceMarkCount(downloads);
    link.href = downloads.referenceUrl;
    link.download = downloads.referenceName || "";
    link.textContent = `Download review reference drawing (${markCount} mark${markCount === 1 ? "" : "s"})`;
  } else {
    link.removeAttribute("href");
    link.removeAttribute("download");
    link.textContent = "Download review reference drawing";
  }
}

function syncPremiumDownloads() {
  syncQuickReferenceDownload();
  if (!elements.premiumDownloadPanel) return;
  const premium = isPremiumUser();
  const downloads = state.currentDownloads;
  const lockedReviewReferenceReady = lockedReviewReferenceHasMarks(downloads);
  elements.premiumDownloadPanel.hidden = !premium && !lockedReviewReferenceReady;
  const excelReady = premium && downloads?.excelUrl;
  const referenceReady = (premium || lockedReviewReferenceReady) && downloads?.referenceUrl;
  const ready = excelReady && referenceReady;
  if (elements.downloadExcel) {
    elements.downloadExcel.classList.toggle("is-disabled", !excelReady);
    elements.downloadExcel.toggleAttribute("aria-disabled", !excelReady);
    if (excelReady) {
      elements.downloadExcel.href = downloads.excelUrl;
      elements.downloadExcel.download = downloads.excelName || "";
      elements.downloadExcel.textContent = downloads.reviewExcel ? "Download review Excel" : "Download Excel MB sheet";
    } else {
      elements.downloadExcel.removeAttribute("href");
      elements.downloadExcel.removeAttribute("download");
      elements.downloadExcel.textContent = "Download Excel MB sheet";
    }
  }
  if (elements.downloadReferenceDwg) {
    elements.downloadReferenceDwg.classList.toggle("is-disabled", !referenceReady);
    elements.downloadReferenceDwg.toggleAttribute("aria-disabled", !referenceReady);
    if (referenceReady) {
      elements.downloadReferenceDwg.href = downloads.referenceUrl;
      elements.downloadReferenceDwg.download = downloads.referenceName || "";
      elements.downloadReferenceDwg.textContent = `Download reference ${downloads.referenceType || "drawing"}`;
    } else {
      elements.downloadReferenceDwg.removeAttribute("href");
      elements.downloadReferenceDwg.removeAttribute("download");
      elements.downloadReferenceDwg.textContent = "Download reference drawing";
    }
  }
  if (elements.premiumDownloadStatus) {
    const markCount = referenceMarkCount(downloads);
    elements.premiumDownloadStatus.textContent = lockedReviewReferenceReady && !excelReady
      ? `Review reference drawing ready from ${downloads.referenceSourceFile || "uploaded drawing"} with ${markCount} review label(s). Excel is locked until quantity rules pass.`
      : !premium
      ? "Premium required to download Excel and reference drawing."
      : ready
        ? `${downloads.finalAllowed ? "Final package" : "Review package"} ready from ${downloads.referenceSourceFile || "uploaded drawing"} with ${downloads.panelMarks || 0} slab panel label(s).${downloads.reviewExcel ? " Excel is for checking only; final MB is still locked." : ""}`
        : referenceReady
          ? Number(downloads.panelMarks || 0) > 0
            ? `Reference drawing ready from ${downloads.referenceSourceFile || "uploaded drawing"} with ${downloads.panelMarks || 0} slab panel label(s). Excel is locked until quantity rules pass.`
            : `Reference drawing created but no verified slab quantity rows were created. Excel is locked.`
        : "Extract quantity to generate current Excel and reference drawing.";
  }
}

function clearCurrentDownloads() {
  state.currentDownloads = null;
  state.accuracyAudit = null;
  state.ruleAudit = null;
  state.framingQuantityLockReason = "";
  state.framingPlanWarnings = [];
  syncPremiumDownloads();
}

function saveSettings() {
  localStorage.setItem("qss-pro-settings", JSON.stringify(state.settings));
}

function saveAccount() {
  localStorage.setItem("qss-pro-account", JSON.stringify(state.account));
}

function loadAccount() {
  try {
    state.account = { ...state.account, ...JSON.parse(localStorage.getItem("qss-pro-account") || "{}") };
  } catch {
    saveAccount();
  }
}

function makeUserId(email) {
  const base = (email || "user").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "user";
  const existing = state.account.userId;
  return existing || `QSS-${base}-${Math.floor(100000 + Math.random() * 900000)}`.toUpperCase();
}

function renderAccount() {
  const name = state.account.name || "Guest user";
  const email = state.account.email || "Not logged in";
  elements.userName.value = state.account.name || "";
  elements.loginEmail.value = state.account.email || elements.loginEmail.value;
  elements.profileUserName.textContent = name;
  elements.profileUserEmail.textContent = email;
  elements.profileUserId.textContent = state.account.userId || "Not generated";
  elements.otpStatus.textContent = state.account.loggedIn ? "Logged in" : "Not logged in";
}

function saveHistory() {
  localStorage.setItem("qss-pro-history", JSON.stringify(state.history));
}

function loadHistory() {
  try {
    state.history = JSON.parse(localStorage.getItem("qss-pro-history") || "[]");
  } catch {
    state.history = [];
  }
  pruneHistory();
}

function pruneHistory() {
  if (isPremiumUser()) return;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const nextHistory = state.history.filter((item) => now - item.savedAt <= sevenDays);
  if (nextHistory.length !== state.history.length) {
    state.history = nextHistory;
    saveHistory();
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("qss-pro-settings") || "{}");
    state.settings = { ...state.settings, ...saved };
  } catch {
    saveSettings();
  }
}

function applyTheme() {
  document.body.classList.toggle("theme-dark", state.settings.theme === "dark");
  document.body.classList.toggle("theme-light", state.settings.theme === "light");
}

function syncSettingsControls() {
  elements.settingLanguage.value = state.settings.language;
  elements.settingTheme.value = state.settings.theme;
  elements.settingAreaUnit.value = state.settings.areaUnit;
  elements.settingLengthUnit.value = state.settings.lengthUnit;
  elements.settingVolumeUnit.value = state.settings.volumeUnit;
  elements.settingWeightUnit.value = state.settings.weightUnit;
  elements.settingSaveData.value = state.settings.saveData;
  elements.saveDataPremiumMessage.hidden = state.settings.saveData !== "premium" || isPremiumUser();
}

function updateSetting(key, value) {
  if (key === "saveData" && value === "premium" && !isPremiumUser()) {
    state.settings.saveData = "7days";
    elements.saveDataPremiumMessage.hidden = false;
  } else {
    state.settings[key] = value;
    elements.saveDataPremiumMessage.hidden = true;
  }
  saveSettings();
  applyTheme();
  syncSettingsControls();
  renderRows();
  renderResults();
}

function getProjectName() {
  const input = document.querySelector("#project-name");
  return input?.value?.trim() || "Untitled project";
}

function saveCurrentTakeoff() {
  if (!state.rows.length) {
    elements.historyStatus.textContent = "Extract quantity before saving history.";
    showPage("quantity");
    return;
  }
  const rule = getRule();
  const total = getRowsWithQuantities().reduce((sum, row) => sum + row.quantity, 0);
  const item = {
    id: `history-${Date.now()}`,
    savedAt: Date.now(),
    projectName: getProjectName(),
    itemLabel: rule.label,
    total,
    unit: rule.unit,
    rows: state.rows,
    drawingEvidence: state.drawingEvidence,
    drawingType: elements.drawingType.value,
    workGroup: elements.workGroup.value,
    quantityRule: elements.quantityRule.value,
  };
  state.history.unshift(item);
  pruneHistory();
  saveHistory();
  renderHistory();
  elements.historyStatus.textContent = "Takeoff saved.";
  showPage("history");
}

function openHistoryItem(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item) return;
  elements.drawingType.value = item.drawingType || "structural";
  populateWorkGroups();
  elements.workGroup.value = item.workGroup || elements.workGroup.value;
  populateQuantityRules();
  elements.quantityRule.value = item.quantityRule || elements.quantityRule.value;
  syncQuantitySelection();
  state.rows = item.rows.map((row) => createRow(row));
  state.drawingEvidence = item.drawingEvidence || null;
  state.selectedRowId = state.rows[0]?.id || null;
  renderRows();
  renderReadiness();
  renderResults();
  showPage("quantity");
}

function deleteHistoryItem(id) {
  state.history = state.history.filter((entry) => entry.id !== id);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (!elements.historyList || !elements.historyStatus) return;
  pruneHistory();
  elements.historyStatus.textContent = state.history.length
    ? `${state.history.length} saved takeoff${state.history.length === 1 ? "" : "s"}`
    : "No saved takeoffs yet.";
  elements.historyList.innerHTML = state.history.length
    ? state.history
        .map((item) => {
          const savedDate = new Date(item.savedAt).toLocaleString();
          return `
            <div class="history-card">
              <div>
                <strong>${escapeHtml(item.projectName)}</strong>
                <span>${escapeHtml(item.itemLabel)} - ${formatQuantity(item.total, item.unit)}</span>
                <em>${escapeHtml(savedDate)}</em>
              </div>
              <div class="inline-actions">
                <button class="ghost-button" type="button" data-open-history="${item.id}">Open</button>
                <button class="danger-button" type="button" data-delete-history="${item.id}">Delete</button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="empty-history">Saved takeoffs will appear here for 7 days.</div>`;
}

function updateProfilePlan() {
  const premium = isPremiumUser();
  elements.profilePlanName.textContent = premium ? "Premium" : "Free";
  elements.buyPremium.hidden = premium;
  renderHistory();
}

function showPage(page) {
  state.activePage = page;
  elements.appSections.forEach((section) => {
    section.classList.toggle("is-visible", section.id === page);
  });
  elements.navButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.page === page);
  });
  const titles = {
    quantity: "Extract quantities",
    profile: "Profile",
    history: "History",
    settings: "Settings",
    terms: "Terms",
  };
  elements.pageTitle.textContent = titles[page] || "QSS Pro";
}

function syncPlanAccess() {
  const premium = isPremiumUser();
  [...elements.outputType.options].forEach((option) => {
    if (option.dataset.premium === "true") {
      option.disabled = !premium;
    }
  });

  if (!premium && elements.outputType.value !== "total") {
    elements.outputType.value = "total";
  }

  elements.exportCsv.disabled = !premium;
  elements.exportCsv.classList.toggle("is-disabled", !premium);
  elements.exportCsv.textContent = premium ? "Export current table CSV" : "Export current table CSV - Premium";
  elements.tableActions.hidden = !premium;
  elements.memberTableWrap.hidden = !premium;
  elements.detailUpgradeMessage.hidden = premium;
  elements.premiumMessage.hidden = premium || elements.outputType.value === "total";
  syncPremiumDownloads();
  syncSpecificMemberFilter();
  updateProfilePlan();
  syncSettingsControls();
  syncExtractButton();
  renderReadiness();
  renderResults();
}

function populateWorkGroups() {
  const menu = quantityMenu[elements.drawingType.value] || quantityMenu.structural;
  const current = elements.workGroup.value;
  elements.workGroup.innerHTML = Object.entries(menu)
    .map(([key, group]) => `<option value="${key}">${group.label}</option>`)
    .join("");

  if (current && menu[current]) {
    elements.workGroup.value = current;
  } else if (elements.drawingType.value === "structural" && menu.column) {
    elements.workGroup.value = "column";
  }
  populateQuantityRules();
}

function populateQuantityRules() {
  const menu = quantityMenu[elements.drawingType.value] || quantityMenu.structural;
  const group = menu[elements.workGroup.value] || Object.values(menu)[0];
  const current = elements.quantityRule.value;
  elements.quantityRule.innerHTML = group.rules
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join("");

  if (current && group.rules.some(([key]) => key === current)) {
    elements.quantityRule.value = current;
  }
  syncQuantitySelection();
}

function syncQuantitySelection() {
  const rule = getRule();
  if (elements.quantityItemLabel) elements.quantityItemLabel.value = rule.label;
  syncDeductionMode();
  syncBeamCapMode();
  syncColumnHeightPanel();
  renderRows();
  renderReadiness();
  renderResults();
}

function isColumnSelection() {
  return elements.drawingType.value === "structural" && elements.workGroup.value === "column";
}

function isSpecificMemberFilterApplicable() {
  return elements.drawingType.value === "structural" &&
    ["column", "beam"].includes(elements.workGroup.value) &&
    ["column_concrete", "beam_concrete"].includes(getSelectedQuantityKey());
}

function canUseSpecificMemberFilter() {
  return isPremiumUser() && isSpecificMemberFilterApplicable();
}

function isFramingSelection() {
  return elements.drawingType.value === "structural" && ["beam", "slab", "raft"].includes(elements.workGroup.value);
}

function isGridAreaMode() {
  return isFramingSelection() && elements.calculationAreaMode?.value === "grid";
}

function syncCalculationAreaPanel() {
  const showAreaMode = isFramingSelection();
  if (elements.calculationAreaLabel) elements.calculationAreaLabel.hidden = !showAreaMode;
  if (!showAreaMode && elements.calculationAreaMode) elements.calculationAreaMode.value = "drawing";
  if (elements.gridAreaPanel) elements.gridAreaPanel.hidden = !isGridAreaMode();
  syncSpecificMemberFilter();
  syncExtractButton();
}

function isDeductionApplicable() {
  return elements.drawingType.value === "architectural" && ["brickwork", "plaster", "paint"].includes(getSelectedQuantityKey());
}

function syncDeductionMode() {
  const applicable = isDeductionApplicable();
  if (!applicable) {
    elements.deductionMode.value = "none";
  }
  elements.deductionMode.disabled = !applicable;
  elements.deductionMode.closest("label")?.classList.toggle("is-disabled", !applicable);
}

function syncBeamCapMode() {
  const show = isBeamCapModeSelection();
  if (elements.beamCapModeLabel) elements.beamCapModeLabel.hidden = !show;
  if (!show && elements.beamCapMode) elements.beamCapMode.value = "included";
}

function normalizeMemberName(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function getSpecificMemberMatches() {
  const filter = normalizeMemberName(elements.memberFilter?.value || "");
  if (!filter) return state.rows;
  return state.rows.filter((row) => normalizeMemberName(row.name) === filter);
}

function syncSpecificMemberFilter() {
  const show = isSpecificMemberFilterApplicable();
  const usable = canUseSpecificMemberFilter();
  if (elements.memberFilterLabel) elements.memberFilterLabel.hidden = !show;
  if ((!show || !usable) && elements.memberFilter) elements.memberFilter.value = "";
  if (elements.memberFilter) {
    elements.memberFilter.disabled = !usable;
    elements.memberFilter.placeholder = usable ? "Example: B64 or C1" : "Premium required";
    elements.memberFilterLabel?.classList.toggle("is-disabled", !usable);
  }
  syncMemberOccurrenceOptions();
}

function syncMemberOccurrenceOptions() {
  if (!elements.memberOccurrence || !elements.memberOccurrenceLabel) return;
  const show = isSpecificMemberFilterApplicable();
  const usable = canUseSpecificMemberFilter();
  const matches = show && usable ? getSpecificMemberMatches() : [];
  const filter = normalizeMemberName(elements.memberFilter?.value || "");
  const current = elements.memberOccurrence.value;
  const allLabel = usable
    ? filter
      ? `All matching members${matches.length ? ` (${matches.length})` : ""}`
      : "All members"
    : "Premium required for specific member quantity";
  const options = [`<option value="all">${allLabel}</option>`]
    .concat(usable ? matches.map((row, index) => `<option value="${index}">${escapeHtml(row.name)} #${index + 1} - ${escapeHtml(row.floor)}</option>`) : []);
  elements.memberOccurrence.innerHTML = options.join("");
  elements.memberOccurrence.value = [...elements.memberOccurrence.options].some((option) => option.value === current) ? current : "all";
  elements.memberOccurrence.disabled = !show;
  elements.memberOccurrenceLabel.hidden = !show;
  elements.memberOccurrenceLabel.classList.toggle("is-disabled", !usable);
}

function getRowsForCurrentMemberSelection() {
  if (!canUseSpecificMemberFilter()) return state.rows;
  const filter = normalizeMemberName(elements.memberFilter?.value || "");
  if (!filter) return state.rows;
  const matches = getSpecificMemberMatches();
  const occurrence = elements.memberOccurrence?.value || "all";
  if (occurrence === "all") return matches;
  const index = Number.parseInt(occurrence, 10);
  return Number.isInteger(index) && matches[index] ? [matches[index]] : matches;
}

function syncColumnHeightPanel() {
  elements.columnHeightPanel.hidden = !isColumnSelection();
  elements.columnDrawingSetPanel.hidden = !isColumnSelection();
  elements.columnBatchPanel.hidden = !isColumnSelection() || !elements.columnScheduleFiles.files.length;
  elements.framingDrawingPanel.hidden = !isFramingSelection();
  syncCalculationAreaPanel();
  syncColumnLayoutNote();
  syncColumnHeightInputs();
  applyManualColumnHeight();
}

function syncColumnLayoutNote() {
  if (!elements.columnLayoutMethod || !elements.columnHeightNote) return;
  elements.columnHeightNote.value =
    elements.columnLayoutMethod.value === "floor_wise_layout"
      ? "Lower floor column layout + upper floor column/framing layout"
      : "Foundation column layout + lower/upper framing plans + all column schedule sheets";
}

function renderColumnScheduleBatch(files) {
  const scheduleFiles = [...files];
  const count = scheduleFiles.length;
  elements.columnScheduleFileCount.textContent = count ? `${count} schedule sheet${count === 1 ? "" : "s"} selected` : "No files selected";
  elements.columnBatchPanel.hidden = !isColumnSelection() || count === 0;
  elements.columnReaderStatus.hidden = count === 0;
  elements.columnReaderStatus.className = "reader-status column-reader-status";
  elements.columnReaderStatus.innerHTML = `
    <strong>${count ? "Schedule sheets selected" : "Waiting for extraction"}</strong>
    <span>${count ? "Click Extract Quantity after uploading all required drawings." : "Select schedule sheets first."}</span>
  `;
  elements.columnScheduleList.innerHTML = scheduleFiles
    .map(
      (file, index) => `
        <li>
          <span>Sheet ${index + 1}</span>
          <strong>${escapeHtml(file.name)}</strong>
        </li>
      `,
    )
    .join("");
  syncExtractButton();
  renderReadiness();
}

function getFileExtension(file) {
  return file.name.split(".").pop().toLowerCase();
}

function showColumnReaderStatus(title, message, tone = "") {
  elements.columnReaderStatus.hidden = false;
  elements.columnReaderStatus.className = `reader-status column-reader-status ${tone}`.trim();
  elements.columnReaderStatus.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(message)}</span>
  `;
}

async function readColumnSchedules() {
  const files = [...elements.columnScheduleFiles.files];
  if (!files.length) {
    showColumnReaderStatus("No schedule sheets selected", "Upload Sheet 1, Sheet 2, or more column schedule sheets first.", "is-warning");
    return;
  }

  showColumnReaderStatus("Reading column schedules", "Scanning uploaded sheets one by one.");
  try {
    const payload = {
      files: await Promise.all(files.map(async (file) => ({ name: file.name, dataBase64: await fileToBase64(file) }))),
    };
    const response = await fetch(apiUrl("/api/read-column-schedules"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Column schedule reader failed.");
    }

    if (!data.rows.length) {
      const warnings = data.sheets.map((sheet) => `${sheet.fileName}: ${sheet.warning}`).join(" ");
      showColumnReaderStatus("No column rows detected", warnings || "OCR completed but no usable column rows were found.", "is-warning");
      renderReadiness();
      return;
    }

    state.rows = data.rows.map((row) => createRow(row));
    state.selectedRowId = state.rows[0]?.id || null;
    renderRows();
    renderReadiness();
    renderResults();
    showColumnReaderStatus(
      "Schedule read",
      `${data.rows.length} member${data.rows.length === 1 ? "" : "s"} found. Check/edit dimensions only if required.`,
      "is-success",
    );
    syncExtractButton();
    return;
  } catch (error) {
    showColumnReaderStatus("Reader not available", `${error.message} Restart QSS Pro, then click Extract Quantity again.`, "is-warning");
  }
  renderReadiness();
}

async function readDrawingEvidence() {
  const files = [];
  const addFile = (role, input) => {
    const file = input?.files?.[0];
    if (file) files.push({ role, file });
  };
  addFile("foundation-column-layout", elements.foundationColumnLayoutFile);
  addFile("lower-framing-plan", elements.lowerFramingFile);
  addFile("upper-framing-plan", elements.upperFramingFile);
  [...(elements.framingPlanFiles?.files || [])].forEach((file, index) => files.push({ role: `framing-plan-${index + 1}`, file }));

  if (!files.length) {
    state.drawingEvidence = null;
    return null;
  }

  updateExtractionProgress(14, "Checking drawing reader and DWG/PDF input.");
  await assertDwgConversionReady(files.map((item) => item.file));

  updateExtractionProgress(24, "Preparing uploaded drawing files.");
  const payload = {
    files: await Promise.all(
      files.map(async ({ role, file }) => ({
        role,
        name: file.name,
        dataBase64: await fileToBase64(file),
      })),
    ),
  };

  updateExtractionProgress(42, "Reading drawing evidence from uploaded files.");
  const data = await postJson(
    "/api/read-drawing-evidence",
    payload,
    CAD_EXTRACTION_TIMEOUT_MS,
    "Drawing reader is taking too long. Try one drawing at a time or restart QSS Pro.",
  );
  updateExtractionProgress(74, "Drawing evidence read. Preparing quantity rows.");
  state.drawingEvidence = data;
  return data;
}

function setExtractionProgress(percent, message = "") {
  extractionProgressPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  if (!elements.extractQuantity) return;
  elements.extractQuantity.style.setProperty("--extract-progress", `${extractionProgressPercent}%`);
  elements.extractQuantity.classList.toggle("is-progressing", state.isExtracting);
  elements.extractQuantity.setAttribute("role", "progressbar");
  elements.extractQuantity.setAttribute("aria-valuemin", "0");
  elements.extractQuantity.setAttribute("aria-valuemax", "100");
  elements.extractQuantity.setAttribute("aria-valuenow", String(Math.round(extractionProgressPercent)));
  elements.extractQuantity.textContent = extractionProgressPercent >= 100
    ? "Complete 100%"
    : `Extracting... ${Math.round(extractionProgressPercent)}%`;
  if (message && elements.extractStatus) {
    elements.extractStatus.textContent = message;
  }
}

function startExtractionProgress(message) {
  window.clearInterval(extractionProgressTimer);
  extractionProgressTimer = null;
  extractionProgressPercent = 0;
  setExtractionProgress(4, message);
  extractionProgressTimer = window.setInterval(() => {
    if (!state.isExtracting) return;
    const increment = extractionProgressPercent < 30
      ? 3
      : extractionProgressPercent < 65
        ? 1.6
        : extractionProgressPercent < 88
          ? 0.8
          : 0.25;
    const nextProgress = Math.min(88, extractionProgressPercent + increment);
    setExtractionProgress(nextProgress, nextProgress >= 88 ? "Waiting for CAD reader result; final quantity is not confirmed yet." : "");
  }, 900);
}

function updateExtractionProgress(percent, message = "") {
  if (!state.isExtracting) return;
  setExtractionProgress(Math.max(extractionProgressPercent, percent), message);
}

async function stopExtractionProgress({ complete = false } = {}) {
  window.clearInterval(extractionProgressTimer);
  extractionProgressTimer = null;
  if (complete) {
    setExtractionProgress(100);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
  extractionProgressPercent = 0;
  if (!elements.extractQuantity) return;
  elements.extractQuantity.classList.remove("is-progressing");
  elements.extractQuantity.style.setProperty("--extract-progress", "0%");
  elements.extractQuantity.removeAttribute("role");
  elements.extractQuantity.removeAttribute("aria-valuemin");
  elements.extractQuantity.removeAttribute("aria-valuemax");
  elements.extractQuantity.removeAttribute("aria-valuenow");
  elements.extractQuantity.textContent = "Extract Quantity";
}

async function extractFramingQuantities() {
  const files = [...(elements.framingPlanFiles?.files || [])];
  if (!files.length) return null;
  updateExtractionProgress(8, "Checking drawing reader and uploaded CAD/PDF files.");
  await assertDwgConversionReady(files);
  updateExtractionProgress(14, "Drawing reader ready. Preparing takeoff settings.");
  const itemType = elements.workGroup.value;
  const quantityRule = getSelectedQuantityKey();
  const beamCapMode = elements.beamCapMode?.value || "included";
  const gridPanels = isGridAreaMode()
    ? [{
        name: `${elements.gridXFrom.value.trim()}-${elements.gridXTo.value.trim()} / ${elements.gridYFrom.value.trim()}-${elements.gridYTo.value.trim()}`,
        xFrom: elements.gridXFrom.value.trim(),
        xTo: elements.gridXTo.value.trim(),
        yFrom: elements.gridYFrom.value.trim(),
        yTo: elements.gridYTo.value.trim(),
      }]
    : [];
  const takeoffSetLabel = `${getProjectName()} / ${elements.defaultFloor.value?.trim() || "Current level"}`;
  const takeoffSetKey = takeoffSetLabel.replace(/\s+/g, " ").trim().toUpperCase();
  updateExtractionProgress(20, "Loading uploaded framing drawing files.");
  const uploadedFiles = await Promise.all(
    files.map(async (file, index) => {
      const dataBase64 = await fileToBase64(file);
      return {
        role: `framing-plan-${index + 1}`,
        name: file.name,
        dataBase64,
        fingerprint: [
          file.name,
          file.size,
          file.lastModified,
          dataBase64.length,
          dataBase64.slice(0, 96),
          dataBase64.slice(-96),
        ].join(":"),
      };
    }),
  );
  updateExtractionProgress(30, "Uploaded drawings loaded. Checking saved extraction cache.");
  const cacheKey = JSON.stringify({
    ruleVersion: QSS_APP_RULE_VERSION,
    extractionProfile: "auto-fast-then-deep-for-blocked-slab",
    itemType,
    quantityRule,
    beamCapMode,
    takeoffSetKey,
    areaMode: elements.calculationAreaMode?.value || "drawing",
    gridPanels,
    files: uploadedFiles.map((file) => ({
      name: file.name,
      fingerprint: file.fingerprint,
    })),
  });
  if (state.framingQuantityCache.key === cacheKey && state.framingQuantityCache.data) {
    updateExtractionProgress(76, "Using current cached quantity result for this drawing set.");
    const cached = state.framingQuantityCache.data;
    state.rows = cached.rows.map((row) => createRow(row));
    state.framingBeamGroups = cached.summary?.beamGroups || [];
    state.currentDownloads = cached.summary?.downloads || null;
    state.accuracyAudit = cached.summary?.accuracyAudit || null;
    state.ruleAudit = cached.summary?.ruleAudit || null;
    state.framingQuantityLockReason = cached.summary?.finalQuantityLockedReason || cached.warning || "";
    state.framingPlanWarnings = [
      state.framingQuantityLockReason,
      ...((cached.plans || [])
        .filter((plan) => !plan.summary?.linkedDetailOnly)
        .map((plan) => plan.warning)
        .filter(Boolean)),
    ].filter(Boolean);
    state.selectedRowId = state.rows[0]?.id || null;
    renderRows();
    renderReadiness();
    renderResults();
    return cached;
  }
  const basePayload = {
    itemType,
    quantityRule,
    beamCapMode,
    takeoffSetKey,
    takeoffSetLabel,
    projectName: getProjectName(),
    floorLevel: elements.defaultFloor.value?.trim() || "Current level",
    gridPanels,
    files: uploadedFiles,
  };
  updateExtractionProgress(42, "Reading CAD geometry and calculating quantity.");
  let data = await postJson(
    "/api/extract-framing-quantities",
    { ...basePayload, extractionProfile: "fast" },
    CAD_EXTRACTION_TIMEOUT_MS,
    "CAD geometry reading stopped after 15 minutes. Keep each upload set to the required framing/detail drawings only, then try again.",
  );
  const fastWarnings = [
    data.warning || "",
    data.summary?.finalQuantityLockedReason || "",
    ...(data.plans || []).map((plan) => plan.warning || ""),
    ...(data.summary?.routeWarnings || []),
  ].join(" ");
  const shouldRetryDeepSlab = false && ["slab", "raft"].includes(itemType) &&
    !(data.rows || []).length &&
    /Slab extraction blocked|false closed panel|Fast extraction skipped whole-drawing topology fallback/i.test(fastWarnings);
  if (shouldRetryDeepSlab) {
    updateExtractionProgress(62, "Fast slab read could not verify slab quantity rows. Trying deep slab topology once.");
    const deepData = await postJson(
      "/api/extract-framing-quantities",
      { ...basePayload, extractionProfile: "deep" },
      CAD_EXTRACTION_TIMEOUT_MS,
      "Deep CAD geometry reading stopped after 15 minutes. Keep only the framing plan and linked detail/profile drawings required for this floor, then try again.",
    );
    data = deepData;
  }
  updateExtractionProgress(82, "Building quantity rows, MB sheet, and reference drawing links.");
  state.rows = data.rows.map((row) => createRow(row));
  state.framingBeamGroups = data.summary?.beamGroups || [];
  state.currentDownloads = data.summary?.downloads || null;
  state.accuracyAudit = data.summary?.accuracyAudit || null;
  state.ruleAudit = data.summary?.ruleAudit || null;
  state.framingQuantityLockReason = data.summary?.finalQuantityLockedReason || data.warning || "";
  state.framingPlanWarnings = [
    state.framingQuantityLockReason,
    ...((data.plans || [])
      .filter((plan) => !plan.summary?.linkedDetailOnly)
      .map((plan) => plan.warning)
      .filter(Boolean)),
  ].filter(Boolean);
  state.selectedRowId = state.rows[0]?.id || null;
  state.framingQuantityCache = { key: cacheKey, data };
  renderRows();
  renderReadiness();
  renderResults();
  return data;
}

async function extractQuantity() {
  const blockers = getExtractionBlockers();
  if (blockers.length) {
    syncExtractButton();
    return;
  }

  state.isExtracting = true;
  elements.extractQuantity.disabled = true;
  startExtractionProgress(isFramingSelection()
    ? "Reading CAD geometry and calculating quantity."
    : "Reading drawings and calculating quantity.");
  let completedExtraction = false;
  if (isFramingSelection()) {
    state.rows = [];
    state.selectedRowId = null;
    state.currentDownloads = null;
    state.accuracyAudit = null;
    state.ruleAudit = null;
    state.framingQuantityLockReason = "";
    state.framingPlanWarnings = [];
    renderRows();
    renderResults();
  }

  try {
    if (isFramingSelection()) {
      await extractFramingQuantities();
    } else {
      await readDrawingEvidence();
      if (isColumnSelection() && !state.rows.length) {
        await readColumnSchedules();
      }
    }
    renderResults();
    const evidenceCount = isFramingSelection()
      ? (elements.framingPlanFiles?.files?.length || 0)
      : (state.drawingEvidence?.drawings?.length || 0);
    if (state.rows.length) {
      elements.extractStatus.textContent = `${(state.accuracyAudit && !state.accuracyAudit.finalAllowed) || (state.ruleAudit && !state.ruleAudit.finalAllowed) ? "Quantity extracted for review." : "Quantity extracted."} ${evidenceCount ? `${evidenceCount} drawing${evidenceCount === 1 ? "" : "s"} read.` : ""}`;
    } else {
      const referenceReady = Boolean(state.currentDownloads?.referenceUrl);
      const markedReviewReferenceReady = lockedReviewReferenceHasMarks();
      const lockMessage = compactQuantityLockMessage(state.framingPlanWarnings[0]);
      elements.extractStatus.textContent = referenceReady
        ? markedReviewReferenceReady
          ? `${lockMessage} Download the review reference drawing beside this message.`
          : `${lockMessage} Reference drawing was not marked, so final quantity remains locked.`
        : lockMessage || "No verified quantity rows found in uploaded drawings.";
    }
    completedExtraction = true;
  } catch (error) {
    console.error(error);
    elements.extractStatus.textContent = friendlyExtractionError(error);
  } finally {
    await stopExtractionProgress({ complete: completedExtraction });
    state.isExtracting = false;
    syncExtractButton({ preserveStatus: true });
  }
}

async function postJson(url, payload, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `Server returned ${response.status}.`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function friendlyExtractionError(error) {
  const message = error?.message || "Unknown error.";
  const currentLink = window.location?.origin || "http://127.0.0.1:4175";
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return `QSS Pro is not connected. Start the QSS Pro local server, then reload ${currentLink}/.`;
  }
  if (/EPERM|access is denied|operation not permitted|permission denied|accoreconsole/i.test(message)) {
    return `DWG reading needs the QSS Pro Desktop Launcher for AutoCAD conversion. Open QSS-Pro-Desktop-Launcher.vbs from the app folder once, then use ${currentLink}/. DXF/PDF can still be checked without DWG conversion.`;
  }
  if (/Maximum call stack size exceeded|call stack/i.test(message)) {
    return "Quantity locked for safety: the CAD topology reader hit a loop in this drawing. No final quantity was released. The case must be added to golden tests before billing.";
  }
  if (/is not defined|Cannot read properties|TypeError|ReferenceError|SyntaxError/i.test(message)) {
    return "Quantity locked for safety: an internal rule check failed before final quantity. The rulebook validation gate must be corrected before this result can be used.";
  }
  if (/timed out|timeout|stopped after|taking too long/i.test(message)) {
    return "Quantity locked for safety: CAD reading took too long. Keep only the required framing plan and linked detail/profile drawings for this floor, then extract again.";
  }
  return message;
}

window.addEventListener("error", (event) => {
  console.error(event.error || event.message);
  if (elements?.extractStatus) {
    elements.extractStatus.textContent = "QSS Pro blocked an internal screen error. Refresh once; if it repeats, validation must be run before quantity is released.";
  }
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  if (elements?.extractStatus) {
    elements.extractStatus.textContent = friendlyExtractionError(event.reason);
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function parseColumnScheduleText(text, fileName, sheetNumber) {
  const clean = text.replace(/\\P/g, " ").replace(/\s+/g, " ");
  const columnMarks = [...new Set(clean.match(/\bC\d+[A-Z]?\b/gi) || [])].map((mark) => mark.toUpperCase());
  const sizeMatches = [...clean.matchAll(/\(?\b(\d{2,4})\s*[Xx]\s*(\d{2,4})\b\)?/g)].map((match) => ({
    length: Number(match[1]) / 1000,
    breadth: Number(match[2]) / 1000,
  }));
  const defaultSize = sizeMatches[0] || { length: 0.3, breadth: 0.6 };
  const height = elements.columnHeightSource.value === "manual" ? getManualColumnHeightM() : 3.2;
  const floor = elements.defaultFloor.value || `Schedule sheet ${sheetNumber}`;

  return {
    fileName,
    sheetNumber,
    rows: columnMarks.slice(0, 80).map((mark, index) => {
      const size = sizeMatches[index] || defaultSize;
      return {
        name: mark,
        floor,
        length: size.length,
        breadth: size.breadth,
        height,
        dia: 16,
        spacing: 150,
        nos: 1,
      };
    }),
  };
}

function getManualColumnHeightM() {
  const value = numberValue(elements.manualColumnHeight.value, 0);
  return elements.manualColumnHeightUnit.value === "mm" ? value / 1000 : value;
}

function syncColumnHeightInputs() {
  const manualMode = isColumnSelection() && elements.columnHeightSource.value === "manual";
  elements.manualColumnHeight.disabled = !manualMode;
  elements.manualColumnHeightUnit.disabled = !manualMode;
  elements.manualColumnHeight.closest("label")?.classList.toggle("is-disabled", !manualMode);
  elements.manualColumnHeightUnit.closest("label")?.classList.toggle("is-disabled", !manualMode);
}

function applyManualColumnHeight() {
  if (!isColumnSelection() || elements.columnHeightSource.value !== "manual") return;
  const heightM = getManualColumnHeightM();
  if (heightM <= 0) return;
  state.rows = state.rows.map((row) => ({ ...row, height: heightM }));
}

function hasFile(input) {
  return Boolean(input?.files?.length);
}

function getUploadedFileNames(input) {
  return [...(input?.files || [])].map((file) => file.name);
}

function hasPdfSchedule() {
  return getUploadedFileNames(elements.columnScheduleFiles).some((name) => name.toLowerCase().endsWith(".pdf"));
}

function getExtractionBlockers() {
  const blockers = [];

  if (isColumnSelection()) {
    if (!hasFile(elements.foundationColumnLayoutFile)) blockers.push("column layout");
    if (!hasFile(elements.columnScheduleFiles)) blockers.push("column schedule");
    if (!hasFile(elements.lowerFramingFile)) blockers.push("lower framing plan");
    if (!hasFile(elements.upperFramingFile)) blockers.push("upper framing plan");
    if (elements.columnHeightSource.value === "manual" && getManualColumnHeightM() <= 0) blockers.push("column height");
    return blockers;
  }

  if (isFramingSelection()) {
    if (!hasFile(elements.framingPlanFiles)) blockers.push("framing plan");
    if (isGridAreaMode()) {
      if (!elements.gridXFrom.value.trim() || !elements.gridXTo.value.trim()) blockers.push("X grid range");
      if (!elements.gridYFrom.value.trim() || !elements.gridYTo.value.trim()) blockers.push("Y grid range");
    }
    return blockers;
  }

  if (!state.rows.length) blockers.push("readable drawing");
  return blockers;
}

function syncExtractButton(options = {}) {
  if (!elements.extractQuantity || !elements.extractStatus) return;
  const preserveStatus = Boolean(options.preserveStatus);
  if (state.isExtracting) {
    elements.extractQuantity.disabled = true;
    elements.extractQuantity.classList.add("is-disabled");
    elements.extractQuantity.classList.add("is-progressing");
    return;
  }
  const blockers = getExtractionBlockers();
  const locked = blockers.length > 0;
  elements.extractQuantity.classList.remove("is-progressing");
  elements.extractQuantity.style.setProperty("--extract-progress", "0%");
  elements.extractQuantity.removeAttribute("role");
  elements.extractQuantity.removeAttribute("aria-valuemin");
  elements.extractQuantity.removeAttribute("aria-valuemax");
  elements.extractQuantity.removeAttribute("aria-valuenow");
  elements.extractQuantity.textContent = "Extract Quantity";
  elements.extractQuantity.disabled = locked;
  elements.extractQuantity.classList.toggle("is-disabled", locked);
  if (!preserveStatus) {
    elements.extractStatus.textContent = locked
      ? `Upload ${blockers[0]}${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""} to unlock.`
      : state.rows.length
        ? "Ready. Click to refresh quantity."
        : "Ready. Click to extract quantity.";
  }
}

function statusItem(label, status, detail = "") {
  return { label, status, detail };
}

function getReadinessItems() {
  const items = [];
  const gridReady = elements.gridLinesConfirm.checked && elements.xGridConfirm.checked && elements.yGridConfirm.checked;
  items.push(statusItem("Drawing dimensions", gridReady ? "ready" : "warning", gridReady ? "OK" : "App will still extract; accuracy improves when CAD dimensions/grids are marked"));

  if (isFramingSelection()) {
    items.push(statusItem("Selected item", "ready", `${elements.workGroup.options[elements.workGroup.selectedIndex]?.text || "Work group"}`));
    items.push(statusItem("Framing plan", hasFile(elements.framingPlanFiles) ? "ready" : "missing", hasFile(elements.framingPlanFiles) ? `${elements.framingPlanFiles.files.length} file(s)` : "Upload marked DWG/BAK/PDF/CAD framing plan"));
    items.push(statusItem("Calculation area", "ready", isGridAreaMode() ? `${elements.gridXFrom.value || "X1"}-${elements.gridXTo.value || "X2"} / ${elements.gridYFrom.value || "Y1"}-${elements.gridYTo.value || "Y2"}` : "As per uploaded drawing"));
    return items;
  }

  if (!isColumnSelection()) {
    items.push(statusItem("Selected item", "ready", `${elements.workGroup.options[elements.workGroup.selectedIndex]?.text || "Work group"}`));
    items.push(statusItem("Members", state.rows.length ? "ready" : "missing", state.rows.length ? `${state.rows.length} ready` : "Read drawing or add manually"));
    return items;
  }

  items.push(statusItem("Column layout", hasFile(elements.foundationColumnLayoutFile) ? "ready" : "missing", hasFile(elements.foundationColumnLayoutFile) ? "Uploaded" : "Upload required"));
  items.push(statusItem("Column schedules", state.rows.length ? "ready" : hasFile(elements.columnScheduleFiles) ? "warning" : "missing", state.rows.length ? `${state.rows.length} members read` : hasFile(elements.columnScheduleFiles) ? "Click Extract Quantity" : "Upload required"));
  items.push(statusItem("Lower framing plan", hasFile(elements.lowerFramingFile) ? "ready" : "missing", hasFile(elements.lowerFramingFile) ? "Uploaded" : "Upload required"));
  items.push(statusItem("Upper framing plan", hasFile(elements.upperFramingFile) ? "ready" : "missing", hasFile(elements.upperFramingFile) ? "Uploaded" : "Upload required"));

  if (elements.columnHeightSource.value === "manual") {
    const manualHeight = getManualColumnHeightM();
    items.push(statusItem("Column height", manualHeight > 0 ? "ready" : "missing", manualHeight > 0 ? `${manualHeight.toFixed(3)} m` : "Enter height"));
  } else {
    const autoReady = hasFile(elements.lowerFramingFile) && hasFile(elements.upperFramingFile);
    items.push(statusItem("Column height", autoReady ? "ready" : "missing", autoReady ? "Auto selected" : "Upload framing plans"));
  }

  items.push(statusItem("Quantity members", state.rows.length ? "ready" : "missing", state.rows.length ? `${state.rows.length} ready` : "Read schedules first"));
  return items;
}

function renderStatusItems(container, items) {
  container.innerHTML = items
    .map(
      (item) => `
        <div class="status-row ${item.status}">
          <span>${item.status === "ready" ? "Ready" : item.status === "warning" ? "Needs review" : "Missing"}</span>
          <strong>${escapeHtml(item.label)}</strong>
          <em>${escapeHtml(item.detail)}</em>
        </div>
      `,
    )
    .join("");
}

function renderReadiness() {
  if (!elements.readinessList || !elements.reviewList) return;
  const items = getReadinessItems();
  const missing = items.filter((item) => item.status === "missing").length;
  const warning = items.filter((item) => item.status === "warning").length;
  const ready = missing === 0 && warning === 0;
  elements.readinessSummary.textContent = ready ? "Ready to calculate." : `${missing + warning} step${missing + warning === 1 ? "" : "s"} left.`;
  renderStatusItems(elements.readinessList, items);
  renderStatusItems(elements.reviewList, items);
  syncExtractButton();
}

function createRow(overrides = {}) {
  const id = `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ...overrides,
    id: overrides.id || id,
    name: overrides.name || `Member ${state.rows.length + 1}`,
    floor: overrides.floor || elements.defaultFloor.value || "Ground floor",
    length: overrides.length ?? 1,
    breadth: overrides.breadth ?? 0.23,
    height: overrides.height ?? 3,
    capHeight: overrides.capHeight ?? 0,
    capExposedPerimeter: overrides.capExposedPerimeter ?? 0,
    slabThickness: overrides.slabThickness ?? 0,
    bottomJointDeduction: overrides.bottomJointDeduction ?? 0,
    sideJointDeduction: overrides.sideJointDeduction ?? 0,
    columnCapDeduction: overrides.columnCapDeduction ?? 0,
    bottomAreaOverride: overrides.bottomAreaOverride ?? 0,
    sideAreaOverride: overrides.sideAreaOverride ?? 0,
    grossConcreteOverride: overrides.grossConcreteOverride ?? 0,
    sideShutteringSegments: overrides.sideShutteringSegments || overrides.evidence?.sideShutteringSegments || [],
    dia: overrides.dia ?? 12,
    spacing: overrides.spacing ?? 150,
    nos: overrides.nos ?? 1,
    openings: overrides.openings ?? 0,
    source: overrides.source || "manual",
    needsReview: Boolean(overrides.needsReview),
    reviewNote: overrides.reviewNote || "",
    ocrEvidence: overrides.ocrEvidence || "",
  };
}

function addRow(overrides) {
  const row = createRow(overrides);
  state.rows.push(row);
  state.selectedRowId = row.id;
  renderRows();
  renderReadiness();
  renderResults();
}

function updateRow(id, key, value) {
  const row = state.rows.find((item) => item.id === id);
  if (!row) return;
  row[key] = ["name", "floor"].includes(key) ? value : numberValue(value, 0);
  renderResults();
}

function selectRow(id) {
  state.selectedRowId = id;
  renderRows();
}

function deleteSelectedRow() {
  if (!state.selectedRowId) return;
  state.rows = state.rows.filter((row) => row.id !== state.selectedRowId);
  state.selectedRowId = state.rows[0]?.id || null;
  renderRows();
  renderReadiness();
  renderResults();
}

function duplicateSelectedRow() {
  const selected = state.rows.find((row) => row.id === state.selectedRowId);
  if (!selected) return;
  addRow({
    ...selected,
    name: `${selected.name} copy`,
  });
}

function renderRows() {
  const rule = getRule();
  const deductionDisabled = elements.deductionMode.value === "none";
  if (!state.rows.length) {
    elements.memberBody.innerHTML = `
      <tr>
        <td colspan="16" class="empty-table-cell">No quantity rows yet. Upload readable drawings and use the reader, or add a member manually.</td>
      </tr>
    `;
    return;
  }

  elements.memberBody.innerHTML = state.rows
    .map((row) => {
      const quantity = rule.calculate({
        ...row,
        openings: deductionDisabled ? 0 : row.openings,
      });
      return `
        <tr>
          <td>
            <input class="row-select" type="radio" name="selected-row" ${row.id === state.selectedRowId ? "checked" : ""} data-select="${row.id}" />
          </td>
          <td><input value="${escapeHtml(row.name)}" data-row="${row.id}" data-key="name" /></td>
          <td><input value="${escapeHtml(row.floor)}" data-row="${row.id}" data-key="floor" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.length}" data-row="${row.id}" data-key="length" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.breadth}" data-row="${row.id}" data-key="breadth" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.height}" data-row="${row.id}" data-key="height" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.capHeight}" data-row="${row.id}" data-key="capHeight" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.capExposedPerimeter}" data-row="${row.id}" data-key="capExposedPerimeter" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.slabThickness}" data-row="${row.id}" data-key="slabThickness" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.bottomJointDeduction}" data-row="${row.id}" data-key="bottomJointDeduction" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.sideJointDeduction}" data-row="${row.id}" data-key="sideJointDeduction" /></td>
          <td><input type="number" min="0" step="1" value="${row.dia}" data-row="${row.id}" data-key="dia" /></td>
          <td><input type="number" min="0" step="1" value="${row.spacing}" data-row="${row.id}" data-key="spacing" /></td>
          <td><input type="number" min="0" step="1" value="${row.nos}" data-row="${row.id}" data-key="nos" /></td>
          <td><input type="number" min="0" step="0.001" value="${row.openings}" data-row="${row.id}" data-key="openings" ${deductionDisabled ? "disabled" : ""} /></td>
          <td class="quantity-cell">${formatQuantity(quantity, rule.unit)}</td>
        </tr>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getRowsWithQuantities() {
  const deductionDisabled = elements.deductionMode.value === "none";
  return getRowsForCurrentMemberSelection().map((row) => {
    const measuredRow = {
      ...row,
      openings: deductionDisabled ? 0 : row.openings,
    };
    const components = getComponentBreakdown(measuredRow);
    const serverQuantity = Number(measuredRow.serverQuantity ?? measuredRow.mbQuantity);
    const serverRuleMatches = measuredRow.serverQuantityRule === getSelectedQuantityKey();
    const serverCapModeMatches = !isBeamCapModeSelection() ||
      !measuredRow.serverQuantityBeamCapMode ||
      measuredRow.serverQuantityBeamCapMode === elements.beamCapMode?.value;
    const useServerQuantity = !deductionDisabled &&
      Number.isFinite(serverQuantity) &&
      serverRuleMatches &&
      serverCapModeMatches;
    return {
      ...measuredRow,
      mainQuantity: useServerQuantity ? serverQuantity : components.main,
      capQuantity: useServerQuantity ? 0 : components.cap,
      capLabel: components.capLabel,
      bottomArea: components.bottomArea ?? 0,
      sideArea: components.sideArea ?? 0,
      grossBeamConcrete: components.grossBeamConcrete ?? 0,
      columnCapDeduction: components.columnCapDeduction ?? 0,
      quantity: useServerQuantity ? serverQuantity : components.main + components.cap,
    };
  });
}

function groupRows(rows, key) {
  return rows.reduce((groups, row) => {
    const groupKey = row[key] || "Unassigned";
    groups[groupKey] = (groups[groupKey] || 0) + row.quantity;
    return groups;
  }, {});
}

function auditPercent(value) {
  if (!Number.isFinite(Number(value))) return "0.0%";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function renderAccuracyAudit() {
  if (!elements.accuracyAudit) return;
  const audit = state.accuracyAudit;
  const ruleAudit = state.ruleAudit;
  if (!audit && !ruleAudit) {
    elements.accuracyAudit.hidden = true;
    elements.accuracyAudit.innerHTML = "";
    return;
  }
  const tone = audit?.finalAllowed && ruleAudit?.finalAllowed !== false ? "ready" : "warning";
  const warnings = [
    ...(Array.isArray(audit?.warnings) ? audit.warnings : []),
    ...(Array.isArray(ruleAudit?.failedRules) ? ruleAudit.failedRules.map((rule) => `${rule.ruleId || rule.id || "QSS-RULE"} ${rule.title}: ${rule.detail}`) : []),
    ...(Array.isArray(ruleAudit?.warningRules) ? ruleAudit.warningRules.map((rule) => `${rule.ruleId || rule.id || "QSS-RULE"} ${rule.title}: ${rule.detail}`) : []),
  ];
  const ruleChecks = [
    ...(Array.isArray(ruleAudit?.failedRules) ? ruleAudit.failedRules : []),
    ...(Array.isArray(ruleAudit?.warningRules) ? ruleAudit.warningRules : []),
    ...(Array.isArray(ruleAudit?.passedRules) ? ruleAudit.passedRules.slice(0, 6) : []),
  ];
  elements.accuracyAudit.hidden = false;
  elements.accuracyAudit.className = `accuracy-audit ${tone}`;
  elements.accuracyAudit.innerHTML = `
    <div>
      <strong>${escapeHtml(ruleAudit?.statusLabel || audit?.statusLabel || "Accuracy audit")}</strong>
      <span>${escapeHtml((ruleAudit?.routes || audit?.routes || []).join(", ") || "route not reported")}</span>
    </div>
    <div class="audit-grid">
      <span><b>${Number(audit?.panelMarks || 0)}</b> slab panels${Number(audit?.reviewMarks || 0) ? ` / ${Number(audit.reviewMarks)} items need review` : ""}</span>
      <span><b>${Number(audit?.beamMarks || 0)}</b> QB marks</span>
      <span><b>${Number(audit?.acceptedRows || 0)}</b> accepted rows</span>
      <span><b>${Number(audit?.excludedRows || 0)}</b> excluded/review</span>
      <span><b>${auditPercent(audit?.reviewRatio)}</b> review ratio</span>
      <span><b>${audit?.panelCoverageRatio == null ? "-" : auditPercent(audit.panelCoverageRatio)}</b> panel coverage</span>
      <span><b>${Number(ruleAudit?.passedCount || 0)}</b> rules passed</span>
      <span><b>${Number(ruleAudit?.failedCount || 0)}</b> rules failed</span>
    </div>
    ${ruleChecks.length ? `<div class="rule-checks">${ruleChecks.map((rule) => `
      <div class="rule-check ${escapeHtml(rule.status || "")}">
        <strong>${escapeHtml(rule.status || "")}</strong>
        <span>${escapeHtml(`${rule.ruleId || rule.id || ""}${rule.ruleId || rule.id ? " - " : ""}${rule.title || ""}`)}</span>
        <small>${escapeHtml(rule.detail || "")}</small>
      </div>
    `).join("")}</div>` : ""}
    ${warnings.length ? `<ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
  `;
}

function renderResults() {
  const rule = getRule();
  syncMemberOccurrenceOptions();
  const rows = getRowsWithQuantities();
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  const reviewTotal = rows
    .filter((row) => row.needsReview)
    .reduce((sum, row) => sum + row.quantity, 0);
  const verifiedTotal = Math.max(total - reviewTotal, 0);
  const outputType = isPremiumUser() ? elements.outputType.value : "total";
  const resultLabel = ["beam_shuttering", "slab_shuttering", "slab_concrete"].includes(getSelectedQuantityKey()) ||
    (getSelectedQuantityKey() === "beam_concrete" && elements.beamCapMode?.value === "excluded")
    ? `Net ${rule.label}`
    : `Total ${rule.label}`;

  elements.resultItem.textContent = rule.label;
  elements.resultTotal.textContent = formatQuantity(total, rule.unit);
  elements.resultCount.textContent = rows.length;
  elements.standardNote.textContent = getStandardNote(getSelectedQuantityKey());
  syncPremiumDownloads();
  renderAccuracyAudit();
  renderHistory();

  renderReadiness();

  if (!rows.length) {
    elements.resultTotal.textContent = `0.000 ${rule.unit}`;
    const memberFilter = normalizeMemberName(elements.memberFilter?.value || "");
    const warningHtml = state.framingPlanWarnings.length
      ? `<div class="summary-line warning-summary"><span>${escapeHtml(state.framingPlanWarnings.join(" | "))}</span><strong>Check DWG reader</strong></div>`
      : "";
    elements.summaryOutput.innerHTML = `
      ${warningHtml}
      <div class="summary-line">
        <span>${memberFilter ? `No matching member found for ${escapeHtml(memberFilter)}` : "No verified quantity rows"}</span>
        <strong>Pending</strong>
      </div>
    `;
    elements.premiumMessage.hidden = true;
    return;
  }

  if (outputType === "total") {
    const capTotal = rows.reduce((sum, row) => sum + (row.capQuantity || 0), 0);
    const beamCapDeductionTotal = getSelectedQuantityKey() === "beam_concrete"
      ? rows.reduce((sum, row) => sum + (row.columnCapDeduction || 0), 0)
      : 0;
    const beamCapShutteringTotal = getSelectedQuantityKey() === "beam_shuttering"
      ? rows.reduce((sum, row) => sum + (row.columnCapShuttering || 0), 0)
      : 0;
    const grossBeamConcreteTotal = getSelectedQuantityKey() === "beam_concrete"
      ? rows.reduce((sum, row) => sum + (row.grossBeamConcrete || 0), 0)
      : 0;
    const mainTotal = total - capTotal;
    const capLabel = rows.find((row) => row.capLabel)?.capLabel || "Column cap quantity";
    elements.summaryOutput.innerHTML = `
      ${
        capTotal > 0
          ? `<div class="summary-line"><span>Main ${rule.label}</span><strong>${formatQuantity(mainTotal, rule.unit)}</strong></div>
             <div class="summary-line"><span>${escapeHtml(capLabel)}</span><strong>${formatQuantity(capTotal, rule.unit)}</strong></div>`
          : ""
      }
      ${
        beamCapDeductionTotal > 0
          ? `<div class="summary-line"><span>Gross beam concrete</span><strong>${formatQuantity(grossBeamConcreteTotal, rule.unit)}</strong></div>
             <div class="summary-line deduction-line"><span>Less column cap deduction</span><strong>${formatQuantity(beamCapDeductionTotal, rule.unit)}</strong></div>`
          : ""
      }
      ${
        beamCapShutteringTotal > 0
          ? `<div class="summary-line"><span>Column cap shuttering included in beam</span><strong>${formatQuantity(beamCapShutteringTotal, rule.unit)}</strong></div>`
          : ""
      }
      ${
        reviewTotal > 0
          ? `<div class="summary-line"><span>Verified quantity</span><strong>${formatQuantity(verifiedTotal, rule.unit)}</strong></div>
             <div class="summary-line warning-summary"><span>Review quantity included in total</span><strong>${formatQuantity(reviewTotal, rule.unit)}</strong></div>`
          : ""
      }
      <div class="summary-line">
        <span>${escapeHtml(resultLabel)}</span>
        <strong>${formatQuantity(total, rule.unit)}</strong>
      </div>
      ${renderBeamEvidenceSummary(false)}
    `;
    elements.premiumMessage.hidden = true;
    return;
  }

  elements.premiumMessage.hidden = true;

  if (outputType === "floor") {
    renderGroupedSummary(groupRows(rows, "floor"), rule.unit);
    return;
  }

  if (outputType === "room") {
    renderGroupedSummary(groupRows(rows, "name"), rule.unit);
    return;
  }

  elements.summaryOutput.innerHTML = rows
    .map(
      (row) => `
        <div class="summary-line">
          <span>${escapeHtml(row.name)} - ${escapeHtml(row.floor)}</span>
          <strong>${formatQuantity(row.quantity, rule.unit)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderGroupedSummary(groups, unit) {
  const lines = Object.entries(groups);
  elements.summaryOutput.innerHTML = lines.length
    ? lines
        .map(
          ([label, quantity]) => `
            <div class="summary-line">
              <span>${escapeHtml(label)}</span>
              <strong>${formatQuantity(quantity, unit)}</strong>
            </div>
          `,
        )
        .join("")
    : `<div class="summary-line"><span>No rows entered</span><strong>0.000 ${unit}</strong></div>`;
}

function renderBeamEvidenceSummary(showDetails = true) {
  if (!isFramingSelection() || elements.workGroup.value !== "beam" || !state.framingBeamGroups.length) return "";
  if (!isPremiumUser()) {
    return `
      <div class="summary-line">
        <span>Beam evidence</span>
        <strong>Premium review</strong>
      </div>
    `;
  }
  const groups = state.framingBeamGroups.slice(0, showDetails ? 40 : 8);
  return groups
    .map((group) => `
      <div class="summary-line">
        <span>${escapeHtml(group.name)} - ${group.locations} location${group.locations === 1 ? "" : "s"}${group.reviewRows ? " / review" : ""}</span>
        <strong>${formatQuantity(group.totalShutteringM2 || 0, "m2")}</strong>
      </div>
    `)
    .join("");
}

function handleFileUpload(file) {
  elements.fileName.textContent = file ? file.name : "No file selected";
  if (!file) return;
  state.uploadedFile = file;

  const hasGridRequirements = elements.gridLinesConfirm.checked && elements.xGridConfirm.checked && elements.yGridConfirm.checked;
  elements.viewerStatus.textContent = hasGridRequirements
    ? `${file.name} uploaded. Ready to read marked grid dimensions.`
    : `${file.name} uploaded, but grid requirements are not fully confirmed.`;

  elements.readerStatus.innerHTML = `
    <strong>Drawing uploaded</strong>
    <span>Grid reader is ready. The drawing must contain marked X and Y grid dimensions before upload.</span>
  `;
  elements.measureOutput.textContent = "Ready to read";
  renderReadiness();

  if (file.type.startsWith("image/")) {
    const imageUrl = URL.createObjectURL(file);
    elements.preview.innerHTML = `<svg class="measure-overlay" id="measure-overlay" aria-hidden="true"></svg><img alt="Uploaded drawing preview" src="${imageUrl}" />`;
    elements.measureOverlay = document.querySelector("#measure-overlay");
    return;
  }

  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const pdfUrl = URL.createObjectURL(file);
    elements.preview.innerHTML = `<svg class="measure-overlay" id="measure-overlay" aria-hidden="true"></svg><iframe title="Uploaded PDF drawing" src="${pdfUrl}"></iframe>`;
    elements.measureOverlay = document.querySelector("#measure-overlay");
    return;
  }

  elements.preview.innerHTML = `
    <svg class="measure-overlay" id="measure-overlay" aria-hidden="true"></svg>
    <div class="preview-empty">
      <strong>${escapeHtml(file.name)}</strong>
      <span>This CAD file is attached. Grid dimensions will be read from drawing text/entities.</span>
    </div>
  `;
  elements.measureOverlay = document.querySelector("#measure-overlay");
}

function clearPreview() {
  state.uploadedFile = null;
  state.detectedGrid = { x: [], y: [] };
  elements.drawingFile.value = "";
  elements.fileName.textContent = "No file selected";
  elements.viewerStatus.textContent = "Upload a drawing to attach it to this takeoff.";
  elements.readerStatus.innerHTML = `
    <strong>Waiting for drawing upload</strong>
    <span>After upload, click Read grid dimensions to extract marked X and Y grid distances.</span>
  `;
  elements.scaleOutput.textContent = "Not read";
  elements.scaleYOutput.textContent = "Not read";
  elements.measureOutput.textContent = "Pending upload";
  elements.preview.innerHTML = `
    <svg class="measure-overlay" id="measure-overlay" aria-hidden="true"></svg>
    <div class="preview-empty">
      <strong>Drawing preview</strong>
      <span>The app will read marked grid dimensions from uploaded CAD/PDF drawings.</span>
    </div>
  `;
  elements.measureOverlay = document.querySelector("#measure-overlay");
  renderReadiness();
}

async function readGridDimensions() {
  const file = state.uploadedFile;
  if (!file) {
    elements.readerStatus.innerHTML = `
      <strong>No drawing uploaded</strong>
      <span>Upload a properly dimensioned drawing first.</span>
    `;
    return;
  }

  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "dxf") {
    const text = await file.text();
    const dimensions = extractDimensionCandidates(text);
    state.detectedGrid = splitDimensionCandidates(dimensions);
    renderDetectedGrid("DXF text/entities scanned for grid dimensions.");
    return;
  }

  if (extension === "pdf") {
    state.detectedGrid = { x: [], y: [] };
    renderParserPending("PDF will be read by the server-side PDF vector/text parser during extraction.");
    return;
  }

  if (extension === "dwg" || extension === "bak") {
    state.detectedGrid = { x: [], y: [] };
    renderParserPending(`${extension.toUpperCase()} will be converted automatically on the server during extraction.`);
    return;
  }

  state.detectedGrid = { x: [], y: [] };
  renderParserPending("Image/scanned drawings need OCR before grid dimensions can be read.");
}

function extractDimensionCandidates(text) {
  const matches = text.match(/\b\d+(?:\.\d+)?\s*(?:mm|m|meter|metre|ft)?\b/gi) || [];
  return [...new Set(matches)]
    .map((item) => normalizeDimension(item))
    .filter((value) => value > 0.05 && value < 1000)
    .slice(0, 20);
}

function normalizeDimension(value) {
  const number = numberValue(value, 0);
  if (/mm/i.test(value)) return number / 1000;
  if (/ft/i.test(value)) return number * 0.3048;
  return number;
}

function splitDimensionCandidates(dimensions) {
  const half = Math.ceil(dimensions.length / 2);
  return {
    x: dimensions.slice(0, half),
    y: dimensions.slice(half),
  };
}

function renderDetectedGrid(message) {
  const xText = state.detectedGrid.x.length ? state.detectedGrid.x.map((value) => `${value} m`).join(", ") : "No X grid dimensions detected";
  const yText = state.detectedGrid.y.length ? state.detectedGrid.y.map((value) => `${value} m`).join(", ") : "No Y grid dimensions detected";
  elements.scaleOutput.textContent = xText;
  elements.scaleYOutput.textContent = yText;
  elements.measureOutput.textContent = state.detectedGrid.x.length || state.detectedGrid.y.length ? "Review required" : "Not detected";
  elements.readerStatus.innerHTML = `
    <strong>${escapeHtml(message)}</strong>
    <span>${escapeHtml(xText)} | ${escapeHtml(yText)}</span>
  `;
  renderReadiness();
}

function renderParserPending(message) {
  elements.scaleOutput.textContent = "Parser pending";
  elements.scaleYOutput.textContent = "Parser pending";
  elements.measureOutput.textContent = "Parser module required";
  elements.readerStatus.innerHTML = `
    <strong>Automatic reading rule confirmed</strong>
    <span>${escapeHtml(message)}</span>
  `;
  renderReadiness();
}

function loadSample() {
  state.rows = [
    createRow({ name: "C1", floor: "Ground floor", length: 0.3, breadth: 0.6, height: 3.2, capHeight: 0.45, capExposedPerimeter: 0.9, dia: 16, spacing: 150, nos: 12, openings: 0 }),
    createRow({ name: "Raft R1", floor: "Foundation", length: 18, breadth: 12, height: 0.45, dia: 16, spacing: 150, nos: 2, openings: 0 }),
    createRow({ name: "BBS B1-T1", floor: "Foundation", length: 5.8, breadth: 0, height: 0, dia: 12, spacing: 150, nos: 24, openings: 0 }),
  ];
  state.selectedRowId = state.rows[0].id;
  renderRows();
  renderReadiness();
  renderResults();
}

function exportCsv() {
  if (!isPremiumUser()) {
    elements.premiumMessage.hidden = false;
    return;
  }

  const rule = getRule();
  const rows = getRowsWithQuantities();
  const displayUnit = displayQuantity(0, rule.unit).unit;
  const headers = ["Item", "Member/Room", "Floor", "Length", "Breadth/Thickness", "Height/Depth", "Column cap height", "Column cap exposed perimeter", "Slab thickness", "Bottom joint deduction", "Side joint deduction", "Beam bottom area", "Beam side area", "Gross beam concrete", "Beam column cap deduction", "Main quantity", "Column cap quantity", "Dia mm", "Spacing mm", "Nos", "Openings", `Quantity (${displayUnit})`, "Measurement basis"];
  const csvRows = [
    headers,
    ...rows.map((row) => {
      const main = displayQuantity(row.mainQuantity, rule.unit);
      const cap = displayQuantity(row.capQuantity, rule.unit);
      const quantity = displayQuantity(row.quantity, rule.unit);
      return [
        rule.label,
        row.name,
        row.floor,
        row.length,
        row.breadth,
        row.height,
        row.capHeight,
        row.capExposedPerimeter,
        row.slabThickness,
        row.bottomJointDeduction,
        row.sideJointDeduction,
        row.bottomArea ? displayQuantity(row.bottomArea, rule.unit).value.toFixed(3) : "",
        row.sideArea ? displayQuantity(row.sideArea, rule.unit).value.toFixed(3) : "",
        row.grossBeamConcrete ? displayQuantity(row.grossBeamConcrete, rule.unit).value.toFixed(3) : "",
        row.columnCapDeduction ? displayQuantity(row.columnCapDeduction, rule.unit).value.toFixed(3) : "",
        main.value.toFixed(3),
        cap.value.toFixed(3),
        row.dia,
        row.spacing,
        row.nos,
        row.openings,
        quantity.value.toFixed(3),
        getStandardNote(getSelectedQuantityKey()),
      ];
    }),
  ];
  const csv = csvRows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${rule.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-quantity.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

elements.navButtons.forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
elements.sendOtp.addEventListener("click", () => {
  if (!elements.loginEmail.value.includes("@")) {
    elements.otpStatus.textContent = "Enter valid email ID";
    return;
  }
  state.loginOtp = String(Math.floor(100000 + Math.random() * 900000));
  elements.otpStatus.textContent = `Demo OTP for ${elements.loginEmail.value}: ${state.loginOtp}`;
});
elements.verifyOtp.addEventListener("click", () => {
  if (state.loginOtp && elements.loginOtp.value.trim() === state.loginOtp) {
    state.account = {
      name: elements.userName.value.trim() || "QSS Pro User",
      email: elements.loginEmail.value.trim(),
      userId: makeUserId(elements.loginEmail.value.trim()),
      loggedIn: true,
    };
    saveAccount();
    renderAccount();
    elements.otpStatus.textContent = "Logged in";
    return;
  }
  elements.otpStatus.textContent = "Invalid OTP";
});
elements.userName.addEventListener("input", () => {
  state.account.name = elements.userName.value.trim();
  saveAccount();
  renderAccount();
});
elements.buyPremium.addEventListener("click", () => {
  elements.userPlan.value = "premium";
  syncPlanAccess();
});
elements.saveCurrentProject.addEventListener("click", saveCurrentTakeoff);
elements.historyList.addEventListener("click", (event) => {
  const openId = event.target.dataset.openHistory;
  const deleteId = event.target.dataset.deleteHistory;
  if (openId) openHistoryItem(openId);
  if (deleteId) deleteHistoryItem(deleteId);
});
elements.settingLanguage.addEventListener("change", (event) => updateSetting("language", event.target.value));
elements.settingTheme.addEventListener("change", (event) => updateSetting("theme", event.target.value));
elements.settingAreaUnit.addEventListener("change", (event) => updateSetting("areaUnit", event.target.value));
elements.settingLengthUnit.addEventListener("change", (event) => updateSetting("lengthUnit", event.target.value));
elements.settingVolumeUnit.addEventListener("change", (event) => updateSetting("volumeUnit", event.target.value));
elements.settingWeightUnit.addEventListener("change", (event) => updateSetting("weightUnit", event.target.value));
elements.settingSaveData.addEventListener("change", (event) => updateSetting("saveData", event.target.value));

elements.drawingFile.addEventListener("change", (event) => handleFileUpload(event.target.files[0]));
elements.readGrid.addEventListener("click", readGridDimensions);
elements.clearPreview.addEventListener("click", clearPreview);
elements.gridLinesConfirm.addEventListener("change", renderReadiness);
elements.xGridConfirm.addEventListener("change", renderReadiness);
elements.yGridConfirm.addEventListener("change", renderReadiness);
elements.drawingType.addEventListener("change", () => {
  clearCurrentDownloads();
  populateWorkGroups();
});
elements.workGroup.addEventListener("change", () => {
  clearCurrentDownloads();
  state.framingQuantityCache = { key: "", data: null };
  populateQuantityRules();
});
elements.quantityRule.addEventListener("change", () => {
  clearCurrentDownloads();
  state.framingQuantityCache = { key: "", data: null };
  syncQuantitySelection();
});
elements.beamCapMode?.addEventListener("change", () => {
  renderRows();
  renderResults();
});
elements.memberFilter?.addEventListener("input", () => {
  syncMemberOccurrenceOptions();
  renderResults();
});
elements.memberOccurrence?.addEventListener("change", renderResults);
elements.calculationAreaMode?.addEventListener("change", () => {
  clearCurrentDownloads();
  state.framingQuantityCache = { key: "", data: null };
  syncCalculationAreaPanel();
  renderReadiness();
});
[elements.gridXFrom, elements.gridXTo, elements.gridYFrom, elements.gridYTo].forEach((input) => {
  input?.addEventListener("input", () => {
    clearCurrentDownloads();
    state.framingQuantityCache = { key: "", data: null };
    syncExtractButton();
  });
});
elements.columnLayoutMethod.addEventListener("change", () => {
  syncColumnLayoutNote();
  renderReadiness();
});
elements.foundationColumnLayoutFile.addEventListener("change", (event) => {
  elements.foundationColumnLayoutName.textContent = event.target.files[0]?.name || "No file selected";
  renderReadiness();
});
elements.columnScheduleFiles.addEventListener("change", (event) => {
  renderColumnScheduleBatch(event.target.files);
});
elements.framingPlanFiles.addEventListener("change", (event) => {
  const count = event.target.files.length;
  elements.framingPlanFileCount.textContent = count ? `${count} framing plan${count === 1 ? "" : "s"} selected` : "No files selected";
  state.framingQuantityCache = { key: "", data: null };
  clearCurrentDownloads();
  renderReadiness();
  syncExtractButton();
});
elements.readColumnSchedules.addEventListener("click", readColumnSchedules);
elements.extractQuantity.addEventListener("click", extractQuantity);
elements.lowerFramingFile.addEventListener("change", (event) => {
  elements.lowerFramingName.textContent = event.target.files[0]?.name || "No file selected";
  renderReadiness();
});
elements.upperFramingFile.addEventListener("change", (event) => {
  elements.upperFramingName.textContent = event.target.files[0]?.name || "No file selected";
  renderReadiness();
});
elements.columnHeightSource.addEventListener("change", () => {
  syncColumnHeightInputs();
  applyManualColumnHeight();
  renderRows();
  renderReadiness();
  renderResults();
});
elements.manualColumnHeight.addEventListener("input", () => {
  applyManualColumnHeight();
  renderRows();
  renderReadiness();
  renderResults();
});
elements.manualColumnHeightUnit.addEventListener("change", () => {
  applyManualColumnHeight();
  renderRows();
  renderReadiness();
  renderResults();
});
elements.userPlan.addEventListener("change", syncPlanAccess);
elements.outputType.addEventListener("change", () => {
  syncPlanAccess();
  renderResults();
});
elements.deductionMode.addEventListener("change", () => {
  renderRows();
  renderResults();
});
elements.addRow.addEventListener("click", () => addRow());
elements.duplicateRow.addEventListener("click", duplicateSelectedRow);
elements.deleteRow.addEventListener("click", deleteSelectedRow);
elements.loadSample.addEventListener("click", loadSample);
elements.exportCsv.addEventListener("click", exportCsv);

elements.memberBody.addEventListener("input", (event) => {
  const input = event.target;
  const rowId = input.dataset.row;
  const key = input.dataset.key;
  if (rowId && key) {
    updateRow(rowId, key, input.value);
    const row = state.rows.find((item) => item.id === rowId);
    const cell = input.closest("tr")?.querySelector(".quantity-cell");
    if (row && cell) {
      const rule = getRule();
      const openings = elements.deductionMode.value === "none" ? 0 : row.openings;
      cell.textContent = formatQuantity(rule.calculate({ ...row, openings }), rule.unit);
    }
    renderReadiness();
  }
});

elements.memberBody.addEventListener("change", (event) => {
  const selectedId = event.target.dataset.select;
  if (selectedId) selectRow(selectedId);
});

loadSettings();
loadAccount();
loadHistory();
applyTheme();
syncSettingsControls();
renderAccount();
showPage("quantity");
populateWorkGroups();
syncDeductionMode();
syncPlanAccess();
renderRows();
renderReadiness();
renderResults();
