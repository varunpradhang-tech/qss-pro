import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(appDir, "server.js");
let serverCode = fs.readFileSync(serverFile, "utf8");
serverCode = serverCode.replace(
  /server\.listen\(port, "127\.0\.0\.1", \(\) => \{[\s\S]*?\n\}\);\s*$/,
  "module.exports = { panelMarksFromQuantityRows, slabRowsFromReferencePanelMarks };",
);

const testModule = new Module(serverFile);
testModule.filename = serverFile;
testModule.paths = Module._nodeModulePaths(appDir);
testModule._compile(serverCode, serverFile);

const {
  panelMarksFromQuantityRows,
  slabRowsFromReferencePanelMarks,
} = testModule.exports;

assert.equal(typeof panelMarksFromQuantityRows, "function");
assert.equal(typeof slabRowsFromReferencePanelMarks, "function");

const dimensionBackedRows = [
  {
    name: "S3",
    panelNo: "P4",
    length: 5.1,
    breadth: 4.09,
    height: 0.15,
    openings: 0,
    source: "written-cad-dimension-panel",
    needsReview: false,
    evidence: {
      source: "written-cad-dimension-panel",
      selectedPanelMeasurementBasis: "written-cad-dimension-panel",
      lengthBasis: "visible-dimension-text",
      breadthBasis: "visible-dimension-text",
      slabMark: "S3",
      panelMarkX: 5000,
      panelMarkY: 5000,
      panelLeftX: 0,
      panelRightX: 7455,
      panelBottomY: 0,
      panelTopY: 2010,
    },
  },
];

const panelMarks = panelMarksFromQuantityRows(dimensionBackedRows);
assert.equal(panelMarks.length, 1);
assert.equal(panelMarks[0].label, "P4");
assert.equal(panelMarks[0].authoritativeLengthMm, 5100);
assert.equal(panelMarks[0].authoritativeBreadthMm, 4090);

const readbackRows = slabRowsFromReferencePanelMarks(
  { panelMarksData: panelMarks },
  "dimension-authority.dxf",
  "test",
  {
    slabMarks: [{ text: "S3", x: 5000, y: 5000 }],
    slabSpecs: {},
    byMark: {},
    defaultThicknessMm: 150,
    thicknessTexts: [],
  },
  [],
  { dimensions: [] },
);

assert.equal(readbackRows.length, 1);
assert.equal(readbackRows[0].panelNo, "P4");
assert.equal(readbackRows[0].length, 5.1);
assert.equal(readbackRows[0].breadth, 4.09);
assert.equal(readbackRows[0].evidence.geometryLengthM, 7.455);
assert.equal(readbackRows[0].evidence.geometryBreadthM, 2.01);
assert.equal(readbackRows[0].evidence.authoritativeLengthM, 5.1);
assert.equal(readbackRows[0].evidence.authoritativeBreadthM, 4.09);
assert.equal(readbackRows[0].evidence.dimensionConflict, false);

console.log("Reference dimension authority tests passed.");
