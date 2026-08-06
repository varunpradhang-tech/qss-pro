"use strict";

// DWG <-> DXF conversion via the free ODA File Converter (opendesign.com),
// replacing the old AutoCAD accoreconsole.exe dependency entirely. This app is
// commercial, so a licensed-AutoCAD shell-out and any GPL library (LibreDWG)
// are both off the table; ODA File Converter is redistributable and requires
// no per-machine license.
//
// ODA File Converter is a folder-to-folder batch tool, not a single-file CLI:
// it converts every matching file in an input folder into an output folder.
// Each conversion here therefore stages the one file into a scratch input
// folder, runs the converter against that folder pair, and reads back
// whatever landed in the output folder.
//
// Implements: QSS-CAD-001 (dwg_pdf_dxf_route) input-route reporting depends on
// knowing whether conversion is available/what happened; this module supplies
// that status.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENV_PATH_OVERRIDE = "QSS_ODA_CONVERTER_PATH";
const ENV_OUTPUT_VERSION = "QSS_ODA_OUTPUT_VERSION";
const DEFAULT_OUTPUT_VERSION = "ACAD2018";
const CONVERT_TIMEOUT_MS = Number(process.env.QSS_ODA_TIMEOUT_MS || 60000);

const CANDIDATE_ROOTS = [
  process.env["ProgramFiles"],
  process.env["ProgramFiles(x86)"],
  process.env["ProgramW6432"],
  process.env["LOCALAPPDATA"],
].filter(Boolean);

const CANDIDATE_DIR_PATTERNS = [/^ODA\s*File\s*Converter/i, /^ODA$/i];

let cachedExecutablePath;
let cachedExecutableChecked = false;

function findUnderRoot(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CANDIDATE_DIR_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    const dir = path.join(root, entry.name);
    // ODA's own top-level folder ("ODA") holds a version subfolder; the
    // "ODA File Converter <version>" folder holds the exe directly.
    for (const sub of safeReadDir(dir)) {
      matches.push(path.join(dir, sub, "ODAFileConverter.exe"));
    }
    matches.push(path.join(dir, "ODAFileConverter.exe"));
  }
  return matches;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findOnPath() {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["ODAFileConverter.exe"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const line = String(result.stdout || "").split(/\r?\n/).find(Boolean);
  return line ? line.trim() : null;
}

function locateConverterExecutable() {
  const override = process.env[ENV_PATH_OVERRIDE];
  if (override && fs.existsSync(override)) return override;

  for (const root of CANDIDATE_ROOTS) {
    for (const candidate of findUnderRoot(root)) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const onPath = findOnPath();
  if (onPath && fs.existsSync(onPath)) return onPath;

  return null;
}

function converterExecutablePath() {
  if (!cachedExecutableChecked) {
    cachedExecutablePath = locateConverterExecutable();
    cachedExecutableChecked = true;
  }
  return cachedExecutablePath;
}

// Tests (and a manual re-check from the UI) need to force a fresh lookup
// after the user installs the converter without restarting the server.
function resetConverterCache() {
  cachedExecutableChecked = false;
  cachedExecutablePath = undefined;
}

function converterHelpMessage() {
  return (
    "DWG/DWF drawings need ODA File Converter to read. Install the free ODA " +
    "File Converter from opendesign.com (Downloads > ODA File Converter), then " +
    "restart QSS Pro. If it's installed somewhere unusual, set the " +
    `${ENV_PATH_OVERRIDE} environment variable to the full path of ODAFileConverter.exe.`
  );
}

function converterStatus() {
  const executablePath = converterExecutablePath();
  return {
    available: Boolean(executablePath),
    executablePath: executablePath || "",
    help: executablePath ? "" : converterHelpMessage(),
  };
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function firstFileWithExt(dir, ext) {
  const lowerExt = ext.toLowerCase();
  const entries = safeReadDir(dir).filter((name) => name.toLowerCase().endsWith(lowerExt));
  return entries.length ? path.join(dir, entries[0]) : null;
}

// Converts one file's bytes to `targetExt` ("dxf" or "dwg") using ODA File
// Converter. `inputBuffer`/`inputFileName` describe the source file;
// `outputVersion` controls the ACAD version ODA writes (only meaningful for
// DWG output, harmless for DXF).
function convertBuffer({ inputBuffer, inputFileName, targetExt, outputVersion = process.env[ENV_OUTPUT_VERSION] || DEFAULT_OUTPUT_VERSION }) {
  const executablePath = converterExecutablePath();
  if (!executablePath) {
    return { ok: false, error: converterHelpMessage() };
  }

  const inputDir = mkTempDir("qss-pro-oda-in-");
  const outputDir = mkTempDir("qss-pro-oda-out-");
  try {
    const sourceExt = path.extname(inputFileName || "") || ".dwg";
    const stagedInputPath = path.join(inputDir, `source${sourceExt}`);
    fs.writeFileSync(stagedInputPath, inputBuffer);

    const outputType = targetExt.toUpperCase() === "DWG" ? "DWG" : "DXF";
    const filter = `*${sourceExt}`;
    const args = [inputDir, outputDir, outputVersion, outputType, "0", "1", filter];

    const result = spawnSync(executablePath, args, {
      timeout: CONVERT_TIMEOUT_MS,
      windowsHide: true,
    });

    if (result.error) {
      return { ok: false, error: `ODA File Converter failed to start: ${result.error.message}` };
    }

    const outputPath = firstFileWithExt(outputDir, `.${targetExt.toLowerCase()}`);
    if (!outputPath) {
      const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
      return {
        ok: false,
        error: stderr || `ODA File Converter did not produce a .${targetExt} output file (exit code ${result.status}).`,
      };
    }

    return { ok: true, buffer: fs.readFileSync(outputPath) };
  } finally {
    fs.rmSync(inputDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function dwgToDxf(inputBuffer, inputFileName) {
  return convertBuffer({ inputBuffer, inputFileName, targetExt: "dxf" });
}

function dxfToDwg(inputBuffer, inputFileName) {
  return convertBuffer({ inputBuffer, inputFileName, targetExt: "dwg" });
}

module.exports = {
  converterStatus,
  converterHelpMessage,
  resetConverterCache,
  dwgToDxf,
  dxfToDwg,
};
