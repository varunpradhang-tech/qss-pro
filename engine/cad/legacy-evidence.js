"use strict";

const fs = require("fs");

function cleanCadText(value) {
  return String(value || "")
    .replace(/\\P/g, " ")
    .replace(/%%U/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\[A-Za-z0-9.;,+-]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasPositiveBeamNumber(text = "") {
  const match = String(text || "").toUpperCase().match(/B(\d+)/);
  return Boolean(match && Number(match[1]) > 0);
}

function canonicalBeamId(value) {
  const text = cleanCadText(value).replace(/\s+/g, "").toUpperCase();
  if (/^B\d+[A-Z]?$/.test(text) && hasPositiveBeamNumber(text)) return text;
  if (/^T\d+[A-Z]*B\d+[A-Z]?$/.test(text) && hasPositiveBeamNumber(text)) return text;
  if (/^[A-Z]{1,3}B\d+[A-Z]?$/.test(text) && hasPositiveBeamNumber(text)) return text;
  if (/^M?B\d+[A-Z]?$/.test(text) && hasPositiveBeamNumber(text)) return text;
  return extractBeamIdFromMixedText(value);
}

function uniqueStrings(items, limit = 80) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = cleanCadText(item);
    if (!text || seen.has(text.toUpperCase())) continue;
    seen.add(text.toUpperCase());
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function extractMarks(texts, prefix, limit) {
  const pattern = new RegExp(`\\b${prefix}\\s*\\d+[A-Z]?\\b`, "gi");
  return uniqueStrings(texts.flatMap((text) => text.match(pattern) || []), limit)
    .map((text) => text.replace(/\s+/g, "").toUpperCase())
    .filter((text) => {
      const number = Number.parseInt(text.replace(/^[A-Z]+/, "").replace(/[A-Z]$/, ""), 10);
      return Number.isFinite(number) && number > 0;
    });
}

function parseDxfEvidence(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const entities = [];
  let inEntities = false;
  let entity = null;

  function finishEntity() {
    if (entity) entities.push(entity);
    entity = null;
  }

  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = lines[i]?.trim();
    const value = lines[i + 1] ?? "";
    const trimmed = value.trim();

    if (code === "0" && trimmed === "SECTION" && lines[i + 3]?.trim() === "ENTITIES") {
      inEntities = true;
      i += 2;
      continue;
    }
    if (inEntities && code === "0" && trimmed === "ENDSEC") {
      finishEntity();
      inEntities = false;
      continue;
    }
    if (!inEntities) continue;

    if (code === "0") {
      finishEntity();
      entity = { type: trimmed, layer: "0", text: "", vertices: [] };
      continue;
    }
    if (!entity) continue;

    if (code === "8") entity.layer = trimmed;
    if (code === "6") entity.linetype = trimmed;
    if (code === "2") entity.pattern = trimmed;
    if (code === "1" || code === "3") entity.text += trimmed;
    if (code === "10") {
      const x = Number.parseFloat(trimmed);
      if (["LWPOLYLINE", "HATCH"].includes(entity.type)) entity.vertices.push({ x, y: null });
      else entity.x = x;
    }
    if (code === "20") {
      const y = Number.parseFloat(trimmed);
      if (["LWPOLYLINE", "HATCH"].includes(entity.type) && entity.vertices.length) entity.vertices[entity.vertices.length - 1].y = y;
      else entity.y = y;
    }
    if (code === "11") entity.x2 = Number.parseFloat(trimmed);
    if (code === "21") entity.y2 = Number.parseFloat(trimmed);
    if (code === "13") entity.x13 = Number.parseFloat(trimmed);
    if (code === "23") entity.y13 = Number.parseFloat(trimmed);
    if (code === "14") entity.x14 = Number.parseFloat(trimmed);
    if (code === "24") entity.y14 = Number.parseFloat(trimmed);
    if (code === "42") entity.actualMeasurement = Number.parseFloat(trimmed);
    if (code === "40") entity.height = Number.parseFloat(trimmed);
    if (code === "50") entity.angle = Number.parseFloat(trimmed);
    if (code === "70") entity.flags = Number.parseInt(trimmed, 10);
  }
  finishEntity();
  return entities;
}

function finiteOr(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function normalizeTakeoffEntity(entity = {}) {
  const normalized = { ...entity };
  if (normalized.lineType && !normalized.linetype) normalized.linetype = normalized.lineType;
  if (normalized.rotation !== undefined && normalized.angle === undefined) normalized.angle = normalized.rotation;
  if (normalized.ext1X !== undefined && normalized.x13 === undefined) normalized.x13 = normalized.ext1X;
  if (normalized.ext1Y !== undefined && normalized.y13 === undefined) normalized.y13 = normalized.ext1Y;
  if (normalized.ext2X !== undefined && normalized.x14 === undefined) normalized.x14 = normalized.ext2X;
  if (normalized.ext2Y !== undefined && normalized.y14 === undefined) normalized.y14 = normalized.ext2Y;
  if (normalized.dimLineX !== undefined && normalized.x === undefined) normalized.x = normalized.dimLineX;
  if (normalized.dimLineY !== undefined && normalized.y === undefined) normalized.y = normalized.dimLineY;
  normalized.x = finiteOr(normalized.x);
  normalized.y = finiteOr(normalized.y);
  normalized.x2 = finiteOr(normalized.x2);
  normalized.y2 = finiteOr(normalized.y2);
  normalized.x13 = finiteOr(normalized.x13);
  normalized.y13 = finiteOr(normalized.y13);
  normalized.x14 = finiteOr(normalized.x14);
  normalized.y14 = finiteOr(normalized.y14);
  normalized.actualMeasurement = finiteOr(normalized.actualMeasurement);
  return normalized;
}

function cadEntityEvidenceScore(entities = []) {
  let score = 0;
  for (const entity of entities) {
    if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text) {
      if (canonicalBeamId(entity.text)) score += 10;
      if (parseSizeText(entity.text)) score += 6;
      if (textDimensionValueMm(entity)) score += 2;
    }
    if (entity.type === "LINE" && isBeamGeometryLayer(entity.layer || "")) score += 1;
    if (entity.type === "DIMENSION" && Number.isFinite(entity.actualMeasurement)) score += 2;
  }
  return score;
}

function markedDimensionEntityEvidenceCount(entities = []) {
  let count = 0;
  for (const entity of entities) {
    if (entity.type === "DIMENSION" && Number.isFinite(entity.actualMeasurement)) {
      const actualValue = entity.actualMeasurement > 100 && entity.actualMeasurement < 100000 ? entity.actualMeasurement : 0;
      const visibleValue = visibleDimensionValueMm(entity, actualValue);
      if (visibleValue || actualValue) count += 1;
    } else if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text && textDimensionValueMm(entity)) {
      count += 1;
    }
  }
  return count;
}

function beamSizeEntityEvidenceCount(entities = []) {
  let count = 0;
  for (const entity of entities) {
    if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text && parseSizeText(entity.text)) {
      count += 1;
    }
  }
  return count;
}

function beamLabelEntityEvidenceCount(entities = []) {
  let count = 0;
  for (const entity of entities) {
    if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text && canonicalBeamId(entity.text)) {
      count += 1;
    }
  }
  return count;
}

function summarizeEvidence({ fileName, role, source, textItems = [], entities = [], geometry = {} }) {
  const textRecords = textItems
    .map((item) => ({
      text: cleanCadText(item.text),
      layer: item.layer || "",
      page: item.page || null,
      x: Number.isFinite(item.x) ? Math.round(item.x * 1000) / 1000 : null,
      y: Number.isFinite(item.y) ? Math.round(item.y * 1000) / 1000 : null,
    }))
    .filter((item) => item.text);

  const texts = textRecords.map((item) => item.text);
  const layerCounts = entities.reduce((map, item) => {
    map.set(item.layer || "0", (map.get(item.layer || "0") || 0) + 1);
    return map;
  }, new Map());

  const lineEntities = entities.filter((item) => item.type === "LINE");
  const horizontalLines = lineEntities.filter((item) => Number.isFinite(item.y) && Number.isFinite(item.y2) && Math.abs(item.y - item.y2) < 1).length;
  const verticalLines = lineEntities.filter((item) => Number.isFinite(item.x) && Number.isFinite(item.x2) && Math.abs(item.x - item.x2) < 1).length;

  const evidence = {
    fileName,
    role,
    source,
    textCount: textRecords.length,
    entityCount: entities.length,
    lineCount: geometry.lineCount ?? lineEntities.length,
    rectCount: geometry.rectCount ?? 0,
    curveCount: geometry.curveCount ?? 0,
    horizontalLineCount: horizontalLines,
    verticalLineCount: verticalLines,
    topLayers: [...layerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([layer, count]) => ({ layer, count })),
    columnMarks: extractMarks(texts, "C", 120),
    beamLabels: extractMarks(texts, "B", 160),
    slabMarks: extractMarks(texts, "S", 120),
    sizes: uniqueStrings(texts.flatMap((text) => text.match(/\b\d{2,4}\s*[xX]\s*\d{2,4}\b/g) || []), 120),
    levels: uniqueStrings(texts.filter((text) => /\b(TOS|TOP|SSL|FFL|FGL|LEVEL|LVL|EL\.?|RL)\b|[+-]\s*\d{1,3}\.\d{2,3}/i.test(text)), 120),
    slabThicknessNotes: uniqueStrings(texts.filter((text) => /\bS\d+[A-Z]?\b|THK|THICK|SLAB/i.test(text)), 120),
    gridTexts: uniqueStrings(texts.filter((text) => /\bGRID\b|^[A-Z]$|^\d{1,2}$|\b\d{3,5}\b/.test(text)), 120),
    sampleText: textRecords.slice(0, 120),
  };

  return evidence;
}

function distance(a, b) {
  return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
}

function lineLength(entity) {
  if (entity.type === "LINE") {
    return Math.hypot((entity.x2 || 0) - (entity.x || 0), (entity.y2 || 0) - (entity.y || 0));
  }
  if (entity.type === "LWPOLYLINE") {
    const points = entity.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    if ((entity.flags & 1) && points.length > 2) total += distance(points[points.length - 1], points[0]);
    return total;
  }
  return 0;
}

function entityLineSegments(entity) {
  if (entity?.type === "LINE") {
    if (![entity.x, entity.y, entity.x2, entity.y2].every(Number.isFinite)) return [];
    return [{ ...entity, sourceEntityType: "LINE" }];
  }
  if (entity?.type !== "LWPOLYLINE") return [];
  const points = (entity.vertices || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length < 2) return [];
  const segments = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    segments.push({
      type: "LINE",
      sourceEntityType: "LWPOLYLINE",
      layer: entity.layer,
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
    });
  }
  const closed = Boolean(entity.flags & 1) || distance(points[0], points[points.length - 1]) <= 80;
  if (closed && points.length > 2) {
    const start = points[points.length - 1];
    const end = points[0];
    if (distance(start, end) > 80) {
      segments.push({
        type: "LINE",
        sourceEntityType: "LWPOLYLINE",
        layer: entity.layer,
        x: start.x,
        y: start.y,
        x2: end.x,
        y2: end.y,
      });
    }
  }
  return segments;
}

function pointToSegmentDistance(point, line) {
  const ax = line.x;
  const ay = line.y;
  const bx = line.x2;
  const by = line.y2;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return distance(point, { x: ax, y: ay });
  const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / len2));
  return distance(point, { x: ax + t * dx, y: ay + t * dy });
}

function parseSizeText(text) {
  const match = cleanCadText(text).match(/(\d{2,4})\s*[xX]\s*(\d{2,4})/);
  if (!match) return null;
  return { widthMm: Number(match[1]), depthMm: Number(match[2]) };
}

function isPlanDrawingName(name = "") {
  const text = cleanCadText(name).replace(/[_-]+/g, " ").toUpperCase();
  return /\b(?:FRAMING|FRAME|FLOOR\s+PLAN|FRAMING\s+PLAN|LAYOUT|COLUMN\s+LAYOUT|PLAN)\b/.test(text);
}

function isDetailScheduleDrawingName(name = "") {
  const text = cleanCadText(name).replace(/[_-]+/g, " ").toUpperCase();
  const isLinkedScheduleNumber = /(?:^|\s)ST\s*(?:6\d\d|7\d\d)(?:\s|\.|$)/.test(text);
  const isPureSchedule = /\b(?:SCHEDULE|PROFILE|SECTION|DETAIL)\b/.test(text);
  if (isLinkedScheduleNumber) return true;
  if (isPlanDrawingName(name)) return false;
  return isPureSchedule;
}

function nearest(items, point, distanceFn = distance) {
  let item = null;
  let bestDistance = Infinity;
  for (const candidate of items) {
    const candidateDistance = distanceFn(point, candidate);
    if (candidateDistance < bestDistance) {
      item = candidate;
      bestDistance = candidateDistance;
    }
  }
  return { item, distance: bestDistance };
}

function modeNumber(values, fallback = 0) {
  const counts = new Map();
  for (const value of values.filter((item) => Number.isFinite(item) && item > 0)) {
    const rounded = Math.round(value);
    counts.set(rounded, (counts.get(rounded) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}

function textPoint(item) {
  return { x: item.x || 0, y: item.y || 0 };
}

function extractSlabThicknessInfo(textEntities) {
  const nonXrefTextEntities = textEntities.filter((item) => !isXrefSourcedEntity(item));
  const slabMarks = nonXrefTextEntities
    .filter((item) => /^S\d+[A-Z]?$/.test(item.text) && Number.isFinite(item.x) && Number.isFinite(item.y));
  const defaultNoteSpecs = nonXrefTextEntities
    .map((item) => {
      const text = String(item.text || "").toUpperCase();
      const unoPattern = "(?:U\\.?N\\.?O\\.?|UNO|U\\/N|UNLESS\\s+NOTED\\s+OTHERWISE)";
      const match = text.match(new RegExp(`\\b(\\d{2,3})\\s*(?:MM|THK|THICK|SLAB|SLAB\\s*THK|SLAB\\s*THICKNESS)?\\b.*${unoPattern}`)) ||
        text.match(new RegExp(`${unoPattern}.*\\b(\\d{2,3})\\s*(?:MM|THK|THICK|SLAB)?\\b`));
      const thicknessMm = Number(match?.[1] || 0);
      if (thicknessMm < 75 || thicknessMm > 300) return null;
      return {
        thicknessMm,
        sourceText: item.text,
        sourceX: item.x,
        sourceY: item.y,
        basis: "default-uno-note",
      };
    })
    .filter(Boolean);
  const defaultNote = defaultNoteSpecs[0] || null;
  const noteSpecs = {};
  for (const item of nonXrefTextEntities) {
    const text = String(item.text || "").toUpperCase();
    const matches = [...text.matchAll(/\b(S\d+[A-Z]?)\b\s*(?:=|:|-|\/|\\s)?\s*(\d{2,3})\s*(?:MM|THK|THICK|SLAB)?/g)];
    for (const match of matches) {
      const mark = match[1];
      const thicknessMm = Number(match[2]);
      if (thicknessMm < 75 || thicknessMm > 300) continue;
      noteSpecs[mark] = {
        thicknessMm,
        sourceText: item.text,
        sourceX: item.x,
        sourceY: item.y,
        distanceMm: null,
        basis: "slab-note-or-table",
      };
    }
  }
  const tableMarkTexts = nonXrefTextEntities.filter((item) => /^S\d+[A-Z]?$/.test(item.text));
  const tableThicknessTexts = nonXrefTextEntities
    .map((item) => {
      const value = Number(item.text.match(/^(\d{2,3})$/)?.[1] || 0);
      return { ...item, value };
    })
    .filter((item) => item.value >= 75 && item.value <= 300);
  for (const mark of tableMarkTexts) {
    if (noteSpecs[mark.text]) continue;
    const rowThickness = tableThicknessTexts
      .map((item) => ({
        item,
        yDistance: Math.abs((item.y || 0) - (mark.y || 0)),
        xDistance: Math.abs((item.x || 0) - (mark.x || 0)),
        distance: distance(mark, item),
      }))
      .filter((found) => found.yDistance <= 450 && found.xDistance <= 12000)
      .sort((a, b) => (a.yDistance === b.yDistance ? a.xDistance - b.xDistance : a.yDistance - b.yDistance))[0];
    if (rowThickness) {
      noteSpecs[mark.text] = {
        thicknessMm: rowThickness.item.value,
        sourceText: `${mark.text} ${rowThickness.item.text}`,
        sourceX: rowThickness.item.x,
        sourceY: rowThickness.item.y,
        distanceMm: Math.round(rowThickness.distance),
        basis: "slab-side-table-row",
      };
    }
  }
  const thicknessTexts = nonXrefTextEntities
    .map((item) => {
      const exact = item.text.match(/^(\d{2,3})$/);
      const thk = item.text.match(/\b(\d{2,3})\s*(?:mm)?\s*(?:THK|THICK|SLAB)\b/i);
      const value = Number(exact?.[1] || thk?.[1] || 0);
      return { ...item, value };
    })
    .filter((item) => item.value >= 75 && item.value <= 300 && Number.isFinite(item.x) && Number.isFinite(item.y));

  const defaultThicknessMm = defaultNote?.thicknessMm || modeNumber(thicknessTexts.map((item) => item.value), 0);
  const byMark = {};
  const slabSpecs = { ...noteSpecs };

  for (const mark of slabMarks) {
    const nearbySpecs = thicknessTexts
      .map((item) => ({ item, distance: distance(mark, item), axisDistance: Math.min(Math.abs((item.x || 0) - mark.x), Math.abs((item.y || 0) - mark.y)) }))
      .filter((found) => found.distance < 16000)
      .sort((a, b) => (a.axisDistance === b.axisDistance ? a.distance - b.distance : a.axisDistance - b.axisDistance));
    if (!slabSpecs[mark.text] && nearbySpecs[0]) {
      slabSpecs[mark.text] = {
        thicknessMm: nearbySpecs[0].item.value,
        sourceText: nearbySpecs[0].item.text,
        sourceX: nearbySpecs[0].item.x,
        sourceY: nearbySpecs[0].item.y,
        distanceMm: Math.round(nearbySpecs[0].distance),
        basis: "nearest-thickness-text",
      };
    }
  }

  for (const mark of slabMarks) {
    if (slabSpecs[mark.text]?.thicknessMm) {
      byMark[mark.text] = slabSpecs[mark.text].thicknessMm;
    } else if (defaultThicknessMm) {
      byMark[mark.text] = defaultThicknessMm;
    }
  }

  return { slabMarks, thicknessTexts, byMark, slabSpecs, defaultThicknessMm, defaultNote };
}

function parseSlabScheduleBarSpec(text) {
  const match = String(text || "").match(/T\s*(\d+)\s*@\s*(\d+)/i);
  if (!match) return null;
  const dia = Number(match[1]);
  const spacing = Number(match[2]);
  if (!dia || !spacing) return null;
  return { dia, spacing };
}

// Reads the drawing's own per-mark slab reinforcement schedule table (title matching
// "SLAB(S) SCHEDULE...", columns: SLAB NO. | THICKNESS | ALONG SHORT SPAN BOTTOM REINF.
// (FULL LENGTH, CURTAILED) | ALONG LONG SPAN BOTTOM REINF. (FULL LENGTH, CURTAILED) | REMARK
// (ONE WAY/TWO WAY)) by locating column headers and matching each mark row by Y-proximity.
// This is the drawing's actual per-mark specification - the only reliable source once a
// project has more marks than any small hand-transcribed table could cover.
function extractSlabReinforcementSchedule(textEntities) {
  const nonXrefTextEntities = textEntities.filter((item) => !isXrefSourcedEntity(item));
  const title = nonXrefTextEntities.find((item) => /SLABS?\s*SCHEDULE/i.test(String(item.text || "")));
  if (!title) return {};

  const headerCandidates = nonXrefTextEntities.filter((item) =>
    Math.abs((item.y || 0) - title.y) <= 6000 && (item.y || 0) <= title.y);
  const findHeader = (pattern) => headerCandidates.find((item) => pattern.test(String(item.text || "").trim()));
  const markHeader = findHeader(/^SLAB\s*NO\.?$/i);
  const thicknessHeader = findHeader(/^THICKNESS$/i);
  const shortHeader = findHeader(/SHORT\s*SPAN.*BOTTOM/i);
  const longHeader = findHeader(/LONG\s*SPAN.*BOTTOM/i);
  const remarkHeader = findHeader(/^REMARK$/i);
  if (!markHeader || !thicknessHeader || !shortHeader || !longHeader) return {};

  const subHeaders = headerCandidates.filter((item) => /^(FULL\s*LENGTH|CURTAILED)$/i.test(String(item.text || "").trim()));
  const nearestSubHeader = (parentX, labelPattern) => subHeaders
    .filter((item) => labelPattern.test(String(item.text || "").trim()))
    .sort((a, b) => Math.abs((a.x || 0) - parentX) - Math.abs((b.x || 0) - parentX))[0];
  const shortFullHeader = nearestSubHeader(shortHeader.x, /^FULL\s*LENGTH$/i);
  const shortCurtailHeader = nearestSubHeader(shortHeader.x, /^CURTAILED$/i);
  const longFullHeader = nearestSubHeader(longHeader.x, /^FULL\s*LENGTH$/i);
  const longCurtailHeader = nearestSubHeader(longHeader.x, /^CURTAILED$/i);
  if (!shortFullHeader || !longFullHeader) return {};

  const columns = {
    thickness: thicknessHeader.x,
    shortFull: shortFullHeader.x,
    shortCurtail: shortCurtailHeader?.x,
    longFull: longFullHeader.x,
    longCurtail: longCurtailHeader?.x,
    remark: remarkHeader?.x,
  };

  const headerCells = [markHeader, thicknessHeader, shortHeader, longHeader, remarkHeader,
    shortFullHeader, shortCurtailHeader, longFullHeader, longCurtailHeader].filter(Boolean);
  const headerRowBottomY = Math.min(...headerCells.map((item) => item.y || 0));

  const markRows = nonXrefTextEntities.filter((item) =>
    /^S\d+[A-Z]?$/i.test(String(item.text || "").trim()) &&
    Math.abs((item.x || 0) - markHeader.x) <= 1200 &&
    (item.y || 0) < headerRowBottomY - 100);

  const rowToleranceMm = 250;
  const schedule = {};
  for (const markCell of markRows) {
    const mark = String(markCell.text).trim().toUpperCase();
    const rowCandidates = nonXrefTextEntities.filter((item) => Math.abs((item.y || 0) - markCell.y) <= rowToleranceMm);
    const cellAt = (targetX) => {
      if (targetX == null) return null;
      return rowCandidates.slice().sort((a, b) => Math.abs((a.x || 0) - targetX) - Math.abs((b.x || 0) - targetX))[0];
    };
    const thicknessCell = cellAt(columns.thickness);
    const thicknessMm = Number(String(thicknessCell?.text || "").match(/^(\d{2,3})$/)?.[1] || 0);
    if (!thicknessMm) continue;
    const remarkCell = cellAt(columns.remark);
    const way = /ONE\s*WAY/i.test(String(remarkCell?.text || "")) ? "one" : "two";
    const specAt = (targetX) => {
      const cell = cellAt(targetX);
      if (!cell || /^-$/.test(String(cell.text || "").trim())) return null;
      return parseSlabScheduleBarSpec(cell.text);
    };
    schedule[mark] = {
      thicknessMm,
      way,
      shortFull: specAt(columns.shortFull),
      shortCurtail: specAt(columns.shortCurtail),
      longFull: specAt(columns.longFull),
      longCurtail: specAt(columns.longCurtail),
      sourceBasis: "slab-reinforcement-schedule-table",
    };
  }
  return schedule;
}

function extractDetailSchedulesFromEntities(entities) {
  const textEntities = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text) }))
    .filter((item) => item.text && Number.isFinite(item.x) && Number.isFinite(item.y));

  const beamSizeById = {};
  const tableTexts = textEntities.filter((item) => item.layer === "TABLE-TEXT" || item.layer === "BEAM SIZE");
  const beamTexts = tableTexts.filter((item) => canonicalBeamId(item.text));
  const numericTexts = tableTexts
    .map((item) => ({ ...item, value: Number(item.text.match(/^(\d{2,4})$/)?.[1] || 0) }))
    .filter((item) => item.value >= 100 && item.value <= 2000);

  for (const beam of beamTexts) {
    const sameRow = numericTexts
      .map((item) => ({
        item,
        yDistance: Math.abs((item.y || 0) - (beam.y || 0)),
        xDistance: Math.abs((item.x || 0) - (beam.x || 0)),
      }))
      .filter((found) => found.yDistance <= 420)
      .filter((found) => found.item.x > (beam.x || 0) - 7000 && found.item.x < (beam.x || 0) + 18000)
      .sort((a, b) => a.item.x - b.item.x);

    for (let index = 0; index < sameRow.length - 1; index += 1) {
      const widthMm = sameRow[index].item.value;
      const depthMm = sameRow[index + 1].item.value;
      if (widthMm >= 200 && widthMm <= 900 && depthMm >= 300 && depthMm <= 1600) {
        const id = canonicalBeamId(beam.text);
        beamSizeById[id] = {
          text: `${widthMm}X${depthMm}`,
          beamId: id,
          x: beam.x,
          y: beam.y,
          layer: "DETAIL-SCHEDULE",
          size: { widthMm, depthMm },
          basis: "beam-detail-schedule",
        };
        break;
      }
    }
  }

  return {
    beamSizeById,
    slabInfo: extractSlabThicknessInfo(textEntities),
    slabReinforcementSchedule: extractSlabReinforcementSchedule(textEntities),
  };
}

function mergeSlabThicknessInfo(baseInfo, detailInfos = []) {
  const merged = {
    ...baseInfo,
    slabMarks: [...(baseInfo.slabMarks || [])],
    thicknessTexts: [...(baseInfo.thicknessTexts || [])],
    byMark: { ...(baseInfo.byMark || {}) },
    slabSpecs: { ...(baseInfo.slabSpecs || {}) },
    defaultThicknessMm: baseInfo.defaultThicknessMm || 0,
    defaultNote: baseInfo.defaultNote || null,
  };
  // A linked detail/schedule drawing (beam size, slab thickness table, section, etc.) exists purely
  // to supply thickness VALUES for marks the plan itself already found - it must never introduce new
  // slab marks of its own. A slab-thickness schedule table legitimately has rows like "S1", "S2" that
  // match the plan-mark text pattern; counting those as additional physical rooms needing panel
  // closure silently inflates slabMarkCount/unresolvedSlabMarkCount by however many rows the schedule
  // table has, which locks the quantity release even when the actual plan's own marks resolve fine.
  for (const detail of detailInfos) {
    if (!detail) continue;
    merged.thicknessTexts.push(...(detail.thicknessTexts || []));
    for (const [mark, spec] of Object.entries(detail.slabSpecs || {})) {
      if (!spec?.thicknessMm) continue;
      merged.slabSpecs[mark] = {
        ...spec,
        basis: spec.basis || "linked-slab-detail-schedule",
      };
      merged.byMark[mark] = spec.thicknessMm;
    }
    if (!merged.defaultThicknessMm && detail.defaultThicknessMm) {
      merged.defaultThicknessMm = detail.defaultThicknessMm;
      merged.defaultNote = detail.defaultNote || merged.defaultNote;
    }
  }

  for (const mark of merged.slabMarks || []) {
    if (merged.slabSpecs?.[mark.text]?.thicknessMm) {
      merged.byMark[mark.text] = merged.slabSpecs[mark.text].thicknessMm;
    }
  }

  return merged;
}

function isHorizontal(line) {
  return Math.abs((line.y2 || 0) - (line.y || 0)) <= Math.abs((line.x2 || 0) - (line.x || 0)) * 0.15;
}

function isVertical(line) {
  return Math.abs((line.x2 || 0) - (line.x || 0)) <= Math.abs((line.y2 || 0) - (line.y || 0)) * 0.15;
}

function lineMinMax(line) {
  return {
    minX: Math.min(line.x, line.x2),
    maxX: Math.max(line.x, line.x2),
    minY: Math.min(line.y, line.y2),
    maxY: Math.max(line.y, line.y2),
  };
}

function lineMidpoint(line) {
  return {
    x: (Number(line.x) + Number(line.x2)) / 2,
    y: (Number(line.y) + Number(line.y2)) / 2,
  };
}

function lineIntersectionPoint(first, second) {
  const x1 = Number(first.x);
  const y1 = Number(first.y);
  const x2 = Number(first.x2);
  const y2 = Number(first.y2);
  const x3 = Number(second.x);
  const y3 = Number(second.y);
  const x4 = Number(second.x2);
  const y4 = Number(second.y2);
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return null;
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator;
  if (![px, py].every(Number.isFinite)) return null;
  return { x: px, y: py };
}

function isLikelyVoidXPair(first, second, box) {
  const layerText = `${first.layer || ""} ${second.layer || ""}`;
  if (/HATCH|FILL|PATTERN|REBAR|BBS|BAR/i.test(layerText)) return false;
  const width = Math.max(0, box.maxX - box.minX);
  const height = Math.max(0, box.maxY - box.minY);
  const diagonal = Math.hypot(width, height);
  if (width < 600 || height < 600 || diagonal < 900) return false;
  const firstRatio = Number(first.lengthMm || lineLength(first)) / diagonal;
  const secondRatio = Number(second.lengthMm || lineLength(second)) / diagonal;
  if (firstRatio < 0.72 || firstRatio > 1.28 || secondRatio < 0.72 || secondRatio > 1.28) return false;

  const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const centerTolerance = Math.max(450, Math.min(width, height) * 0.2);
  const firstMid = lineMidpoint(first);
  const secondMid = lineMidpoint(second);
  if (Math.hypot(firstMid.x - center.x, firstMid.y - center.y) > centerTolerance) return false;
  if (Math.hypot(secondMid.x - center.x, secondMid.y - center.y) > centerTolerance) return false;
  const intersection = lineIntersectionPoint(first, second);
  if (!intersection || Math.hypot(intersection.x - center.x, intersection.y - center.y) > centerTolerance) return false;

  const cornerTolerance = Math.max(350, Math.min(width, height) * 0.14);
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  const endpoints = [
    { x: first.x, y: first.y },
    { x: first.x2, y: first.y2 },
    { x: second.x, y: second.y },
    { x: second.x2, y: second.y2 },
  ];
  const matchedCorners = corners.filter((corner) =>
    endpoints.some((point) => Math.hypot(point.x - corner.x, point.y - corner.y) <= cornerTolerance));
  if (matchedCorners.length < 4) return false;
  const endpointHits = (line) => [
    { x: line.x, y: line.y },
    { x: line.x2, y: line.y2 },
  ].filter((point) => corners.some((corner) => Math.hypot(point.x - corner.x, point.y - corner.y) <= cornerTolerance)).length;
  return endpointHits(first) >= 2 && endpointHits(second) >= 2;
}

function isBeamGeometryLayer(layer = "") {
  return /BEAM/i.test(layer) && !/BEAM\s*(NO|SIZE)|BRAM/i.test(layer);
}

function lineOrientation(line) {
  if (isHorizontal(line)) return "horizontal";
  if (isVertical(line)) return "vertical";
  return "sloped";
}

function cadLineTypeText(line = {}) {
  return [
    line.linetype,
    line.lineType,
    line.lineTypeName,
    line.layer,
  ].filter(Boolean).join(" ").toUpperCase();
}

function beamFaceLineStyle(line = {}) {
  const text = cadLineTypeText(line);
  if (/\b(CONTINUOUS|SOLID)\b/.test(text) && !/(HIDDEN|DASH|DOT|CENTER|CHAIN)/.test(text)) return "continuous";
  if (/(HIDDEN|DASH|DOT|CENTER|CHAIN)/.test(text)) return "broken";
  return "unknown";
}

function beamSideFaceEvidence(line, beamLines, widthMm = 0) {
  if (!line || !widthMm) return [];
  const orientation = lineOrientation(line);
  if (!["horizontal", "vertical"].includes(orientation)) return [];
  const axis = orientation === "horizontal" ? (line.y + line.y2) / 2 : (line.x + line.x2) / 2;
  const start = orientation === "horizontal" ? Math.min(line.x, line.x2) : Math.min(line.y, line.y2);
  const end = orientation === "horizontal" ? Math.max(line.x, line.x2) : Math.max(line.y, line.y2);
  const edgeMin = Math.max(90, widthMm * 0.35);
  const edgeMax = Math.max(300, widthMm * 1.7);
  const companions = beamLines
    .filter((item) => item !== line && lineOrientation(item) === orientation)
    .map((item) => {
      const itemAxis = orientation === "horizontal" ? item.y : item.x;
      const itemStart = orientation === "horizontal" ? Math.min(item.x, item.x2) : Math.min(item.y, item.y2);
      const itemEnd = orientation === "horizontal" ? Math.max(item.x, item.x2) : Math.max(item.y, item.y2);
      const overlap = Math.max(0, Math.min(end, itemEnd) - Math.max(start, itemStart));
      return {
        line: item,
        axis: itemAxis,
        axisDistance: Math.abs(itemAxis - axis),
        overlap,
        start: itemStart,
        end: itemEnd,
      };
    })
    .filter((item) => item.axisDistance >= edgeMin && item.axisDistance <= edgeMax)
    .filter((item) => item.overlap >= Math.max(300, Math.min(end - start, item.end - item.start) * 0.35))
    .sort((a, b) => b.overlap - a.overlap || Math.abs(a.axisDistance - widthMm) - Math.abs(b.axisDistance - widthMm));
  const companion = companions[0]?.line || null;
  return [
    {
      face: "face-1",
      style: beamFaceLineStyle(line),
      lineType: line.linetype || line.lineType || "",
      layer: line.layer || "",
    },
    companion ? {
      face: "face-2",
      style: beamFaceLineStyle(companion),
      lineType: companion.linetype || companion.lineType || "",
      layer: companion.layer || "",
    } : null,
  ].filter(Boolean);
}

function textOrientation(item) {
  const rawAngle = Number.isFinite(Number(item.angle)) ? item.angle : (Number.isFinite(Number(item.rotation)) ? item.rotation : 0);
  const angle = Math.abs(((rawAngle || 0) % 180 + 180) % 180);
  if (angle <= 25 || angle >= 155) return "horizontal";
  if (angle >= 65 && angle <= 115) return "vertical";
  return "sloped";
}

function normalizeGridName(value) {
  return cleanCadText(value).toUpperCase().replace(/\s+/g, "");
}

function isGridLabelText(text) {
  const normalized = normalizeGridName(text);
  return /^([A-Z]{1,3}|\d{1,3})(\/[A-Z]{1,4})?$/.test(normalized);
}

function isGridLineLayer(layer = "") {
  return /(^|[^A-Z])GRID([^A-Z]|$)|A-GRID/i.test(layer);
}

function axisKindFromGridName(name) {
  return /^\d/.test(name) ? "y" : "x";
}

function visibleDimensionValueMm(item, actualValue = 0) {
  const text = cleanCadText(item.text || "");
  if (!text || text === "<>") return 0;
  const match = text.match(/^(\d{2,6})(?:\.\d+)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!(value > 100 && value < 100000)) return 0;
  if (actualValue && (value < actualValue * 0.5 || value > actualValue * 1.5)) return 0;
  return value;
}

function textDimensionValueMm(item) {
  const text = cleanCadText(item.text || "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");
  if (!text || /[A-Z]/i.test(text) || /[xX*]/.test(text)) return 0;
  const match = text.match(/^(\d{2,6})(?:\.\d{1,3})?$/);
  if (!match) return 0;
  const value = Number(text);
  if (!(value >= 250 && value <= 60000)) return 0;
  return value;
}

function dimensionEvidenceFromNumericText(item) {
  const valueMm = textDimensionValueMm(item);
  if (!valueMm || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return null;
  const orientation = textOrientation(item);
  if (!["horizontal", "vertical"].includes(orientation)) return null;
  const half = valueMm / 2;
  return {
    layer: item.layer || "",
    valueMm,
    visibleValueMm: valueMm,
    actualMeasurementMm: null,
    valueSource: "text-dimension-label",
    text: cleanCadText(item.text || ""),
    x1: orientation === "horizontal" ? item.x - half : item.x,
    y1: orientation === "horizontal" ? item.y : item.y - half,
    x2: orientation === "horizontal" ? item.x + half : item.x,
    y2: orientation === "horizontal" ? item.y : item.y + half,
    angle: item.angle || item.rotation || 0,
    orientation,
  };
}

function dimensionEvidenceKey(dimension = {}) {
  return [
    dimension.orientation || "",
    Math.round(Number(dimension.x1 || 0) / 25),
    Math.round(Number(dimension.y1 || 0) / 25),
    Math.round(Number(dimension.x2 || 0) / 25),
    Math.round(Number(dimension.y2 || 0) / 25),
    Math.round(Number(dimension.valueMm || 0) / 25),
  ].join(":");
}

function dimensionEvidenceRank(dimension = {}) {
  const source = String(dimension.valueSource || "");
  if (/visible-dimension-text/i.test(source)) return 0;
  if (/text-dimension-label/i.test(source)) return 1;
  if (/actual-measurement/i.test(source)) return 2;
  return 3;
}

function textDimensionEvidenceFromEntities(entities = []) {
  return entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text || "") }))
    .map(dimensionEvidenceFromNumericText)
    .filter(Boolean);
}

function mergeDimensionEvidence(...dimensionLists) {
  return uniqueRowsBy(
    dimensionLists.flat().filter(Boolean),
    dimensionEvidenceKey,
    dimensionEvidenceRank,
  );
}

function dimensionOrientationFromEndpoints(item, fallbackAngle = 0) {
  const dx = Math.abs(Number(item.x14 ?? item.x2 ?? 0) - Number(item.x13 ?? item.x ?? 0));
  const dy = Math.abs(Number(item.y14 ?? item.y2 ?? 0) - Number(item.y13 ?? item.y ?? 0));
  if (dx > dy * 1.25) return "horizontal";
  if (dy > dx * 1.25) return "vertical";
  return Math.abs(((fallbackAngle || 0) % 180 + 180) % 180 - 90) < 20 ? "vertical" : "horizontal";
}

function extractGridEvidence(entities) {
  const allTextEntities = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .map((item) => ({ ...item, text: cleanCadText(item.text), gridName: normalizeGridName(item.text) }));

  const textEntities = allTextEntities
    .filter((item) => isGridLabelText(item.gridName) && Number.isFinite(item.x) && Number.isFinite(item.y));

  const gridLines = entities
    .filter((item) => item.type === "LINE" && isGridLineLayer(item.layer || ""))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2))
    .map((item) => ({ ...item, lengthMm: lineLength(item), ...lineMinMax(item), orientation: lineOrientation(item) }))
    .filter((item) => item.lengthMm > 1000 && ["horizontal", "vertical"].includes(item.orientation));

  const verticalLines = gridLines.filter((item) => item.orientation === "vertical");
  const horizontalLines = gridLines.filter((item) => item.orientation === "horizontal");
  const axes = [];

  for (const label of textEntities) {
    const kind = axisKindFromGridName(label.gridName);
    const candidates = kind === "x" ? verticalLines : horizontalLines;
    const axis = candidates
      .map((line) => ({
        line,
        distance: kind === "x" ? Math.abs((line.x + line.x2) / 2 - label.x) : Math.abs((line.y + line.y2) / 2 - label.y),
      }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!axis || axis.distance > 2500) continue;
    axes.push({
      name: label.gridName,
      kind,
      coordinate: kind === "x" ? (axis.line.x + axis.line.x2) / 2 : (axis.line.y + axis.line.y2) / 2,
      labelX: label.x,
      labelY: label.y,
      layer: axis.line.layer,
      distanceMm: Math.round(axis.distance),
    });
  }

  const uniqueAxes = uniqueRowsBy(
    axes,
    (axis) => `${axis.kind}:${axis.name}`,
    (axis) => axis.distanceMm,
  );

  const trueDimensions = entities
    .filter((item) => item.type === "DIMENSION" && Number.isFinite(item.actualMeasurement))
    .map((item) => {
      const actualValue = item.actualMeasurement > 100 && item.actualMeasurement < 100000 ? item.actualMeasurement : 0;
      const visibleValue = visibleDimensionValueMm(item, actualValue);
      const valueMm = visibleValue || actualValue;
      if (!valueMm) return null;
      return {
        layer: item.layer || "",
        valueMm,
        visibleValueMm: visibleValue || null,
        actualMeasurementMm: actualValue || null,
        valueSource: visibleValue ? "visible-dimension-text" : "actual-measurement",
        text: cleanCadText(item.text || ""),
        x1: item.x13,
        y1: item.y13,
        x2: item.x14,
        y2: item.y14,
        angle: item.angle || 0,
        orientation: dimensionOrientationFromEndpoints(item, item.angle || 0),
      };
    })
    .filter(Boolean);
  const textDimensions = allTextEntities
    .map(dimensionEvidenceFromNumericText)
    .filter(Boolean);
  const dimensions = mergeDimensionEvidence(trueDimensions, textDimensions);

  return {
    axes: uniqueAxes,
    dimensions,
    gridLines,
    dimensionDiagnostics: {
      trueDimensions: trueDimensions.length,
      textDimensions: textDimensions.length,
      totalDimensions: dimensions.length,
      textDimensionSamples: textDimensions.slice(0, 8).map((item) => item.text).filter(Boolean),
    },
  };
}

function findGridAxis(grid, name, kind) {
  const normalized = normalizeGridName(name);
  return grid.axes.find((axis) => axis.kind === kind && axis.name === normalized) || null;
}

function gridDimensionBetween(grid, fromAxis, toAxis, kind) {
  if (!fromAxis || !toAxis) return null;
  const expected = Math.abs(toAxis.coordinate - fromAxis.coordinate);
  const orientation = kind === "x" ? "horizontal" : "vertical";
  const betweenMin = Math.min(fromAxis.coordinate, toAxis.coordinate);
  const betweenMax = Math.max(fromAxis.coordinate, toAxis.coordinate);
  const candidates = grid.dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .map((dimension) => {
      const measured = dimension.valueMm;
      const diff = Math.abs(measured - expected);
      const endpoint1 = kind === "x" ? dimension.x1 : dimension.y1;
      const endpoint2 = kind === "x" ? dimension.x2 : dimension.y2;
      const endpointAligned = Number.isFinite(endpoint1) && Number.isFinite(endpoint2) &&
        Math.abs(Math.min(endpoint1, endpoint2) - betweenMin) < 750 &&
        Math.abs(Math.max(endpoint1, endpoint2) - betweenMax) < 750;
      return { dimension, diff, endpointAligned };
    })
    .filter((item) => item.diff < 1500 || item.endpointAligned)
    .sort((a, b) => (a.endpointAligned === b.endpointAligned ? a.diff - b.diff : a.endpointAligned ? -1 : 1));
  return candidates[0]?.dimension || null;
}

function cadDimensionForSpan(dimensions, span, orientation) {
  if (!span || !Array.isArray(dimensions)) return null;
  const expected = orientation === "horizontal"
    ? Math.abs(span.x2 - span.x)
    : Math.abs(span.y2 - span.y);
  const start = orientation === "horizontal" ? Math.min(span.x, span.x2) : Math.min(span.y, span.y2);
  const end = orientation === "horizontal" ? Math.max(span.x, span.x2) : Math.max(span.y, span.y2);
  const axis = orientation === "horizontal" ? (span.y + span.y2) / 2 : (span.x + span.x2) / 2;
  const candidates = dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .map((dimension) => {
      const dStart = orientation === "horizontal" ? Math.min(dimension.x1 || 0, dimension.x2 || 0) : Math.min(dimension.y1 || 0, dimension.y2 || 0);
      const dEnd = orientation === "horizontal" ? Math.max(dimension.x1 || 0, dimension.x2 || 0) : Math.max(dimension.y1 || 0, dimension.y2 || 0);
      const dAxis = orientation === "horizontal" ? (dimension.y1 + dimension.y2) / 2 : (dimension.x1 + dimension.x2) / 2;
      const endpointDiff = Math.abs(dStart - start) + Math.abs(dEnd - end);
      const axisDiff = Number.isFinite(dAxis) ? Math.abs(dAxis - axis) : Infinity;
      const valueDiff = Math.abs(dimension.valueMm - expected);
      const markedCadDimension = /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(dimension.valueSource || ""));
      const dimensionSpanMm = Number.isFinite(dStart) && Number.isFinite(dEnd) ? Math.abs(dEnd - dStart) : 0;
      const dimensionSelfConsistent = !dimensionSpanMm || Math.abs(dimensionSpanMm - Number(dimension.valueMm || 0)) <= Math.max(75, Number(dimension.valueMm || 0) * 0.03);
      const textNearSpan = Number.isFinite(dimension.x1) && Number.isFinite(dimension.y1) &&
        (orientation === "horizontal"
          ? dimension.x1 >= start - 3000 && dimension.x1 <= end + 3000 && Math.abs(dimension.y1 - axis) <= 8000
          : dimension.y1 >= start - 3000 && dimension.y1 <= end + 3000 && Math.abs(dimension.x1 - axis) <= 8000);
      const authoritativeAlignment = markedCadDimension && (
        endpointDiff < 3500 ||
        (axisDiff < 6500 && dimensionSelfConsistent) ||
        textNearSpan
      );
      return { dimension, endpointDiff, axisDiff, valueDiff, markedCadDimension, dimensionSelfConsistent, authoritativeAlignment };
    })
    .filter((item) =>
      item.authoritativeAlignment ||
      (item.endpointDiff < 2500 && item.valueDiff < Math.max(1000, expected * 0.18)) ||
      (item.valueDiff < 1500 && item.axisDiff < 8000))
    .sort((a, b) => {
      if (a.authoritativeAlignment !== b.authoritativeAlignment) return a.authoritativeAlignment ? -1 : 1;
      const aVisible = /visible-dimension-text|text-dimension-label/i.test(String(a.dimension.valueSource || ""));
      const bVisible = /visible-dimension-text|text-dimension-label/i.test(String(b.dimension.valueSource || ""));
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      return (a.endpointDiff + a.valueDiff * 0.15 + a.axisDiff * 0.05) - (b.endpointDiff + b.valueDiff * 0.15 + b.axisDiff * 0.05);
    });
  return candidates[0]?.dimension || null;
}

function dimensionPointNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dimensionTextPoint(dimension = {}) {
  const x = dimensionPointNumber(dimension.textX ?? dimension.xText ?? dimension.x);
  const y = dimensionPointNumber(dimension.textY ?? dimension.yText ?? dimension.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function singleDimensionEvidenceBounds(dimension = {}) {
  const points = [
    { x: dimensionPointNumber(dimension.x1), y: dimensionPointNumber(dimension.y1) },
    { x: dimensionPointNumber(dimension.x2), y: dimensionPointNumber(dimension.y2) },
    dimensionTextPoint(dimension),
  ].filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
  return boundsFromPoints(points);
}

function dimensionEvidenceBounds(dimensions = []) {
  const points = [];
  for (const dimension of dimensions || []) {
    if (Number.isFinite(dimension.x1) && Number.isFinite(dimension.y1)) {
      points.push({ x: dimension.x1, y: dimension.y1 });
    }
    if (Number.isFinite(dimension.x2) && Number.isFinite(dimension.y2)) {
      points.push({ x: dimension.x2, y: dimension.y2 });
    }
  }
  return entityCollectionBounds(points);
}

function dimensionEvidenceInsideRegion(dimension = {}, region = null, marginMm = 2500) {
  if (!region) return true;
  const bounds = singleDimensionEvidenceBounds(dimension);
  if (!bounds) return false;
  return boxesOverlap(bounds, region, marginMm);
}

function dimensionSpanRange(dimension = {}, orientation) {
  const first = orientation === "horizontal"
    ? dimensionPointNumber(dimension.x1)
    : dimensionPointNumber(dimension.y1);
  const second = orientation === "horizontal"
    ? dimensionPointNumber(dimension.x2)
    : dimensionPointNumber(dimension.y2);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
  };
}

function dimensionSpanAxis(dimension = {}, orientation) {
  const first = orientation === "horizontal"
    ? dimensionPointNumber(dimension.y1)
    : dimensionPointNumber(dimension.x1);
  const second = orientation === "horizontal"
    ? dimensionPointNumber(dimension.y2)
    : dimensionPointNumber(dimension.x2);
  if (Number.isFinite(first) && Number.isFinite(second)) return (first + second) / 2;
  const textPoint = dimensionTextPoint(dimension);
  if (!textPoint) return null;
  return orientation === "horizontal" ? textPoint.y : textPoint.x;
}

function rangeOverlapLength(firstStart, firstEnd, secondStart, secondEnd) {
  return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}

function distanceToRange(value, start, end) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Infinity;
  if (number < start) return start - number;
  if (number > end) return number - end;
  return 0;
}

function cadDimensionForPanelSpan(dimensions, span, orientation) {
  if (!span || !Array.isArray(dimensions) || !dimensions.length) return null;
  const expected = orientation === "horizontal"
    ? Math.abs(Number(span.x2) - Number(span.x))
    : Math.abs(Number(span.y2) - Number(span.y));
  if (!Number.isFinite(expected) || expected <= 0) return null;
  const start = orientation === "horizontal"
    ? Math.min(Number(span.x), Number(span.x2))
    : Math.min(Number(span.y), Number(span.y2));
  const end = orientation === "horizontal"
    ? Math.max(Number(span.x), Number(span.x2))
    : Math.max(Number(span.y), Number(span.y2));
  const axis = orientation === "horizontal"
    ? (Number(span.y) + Number(span.y2)) / 2
    : (Number(span.x) + Number(span.x2)) / 2;
  if (![start, end, axis].every(Number.isFinite)) return null;
  const panelLength = Math.max(1, end - start);
  const axisTolerance = Math.max(90, Math.min(450, panelLength * 0.08));
  const endpointTolerance = Math.max(60, Math.min(260, panelLength * 0.035));
  const centerTolerance = Math.max(80, Math.min(420, panelLength * 0.08));
  const candidates = dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .filter((dimension) => Number(dimension.valueMm || 0) >= 250 && Number(dimension.valueMm || 0) <= 60000)
    .map((dimension) => {
      const range = dimensionSpanRange(dimension, orientation);
      const dAxis = dimensionSpanAxis(dimension, orientation);
      const textPoint = dimensionTextPoint(dimension);
      const dStart = range?.start;
      const dEnd = range?.end;
      const dMid = Number.isFinite(dStart) && Number.isFinite(dEnd) ? (dStart + dEnd) / 2 : null;
      const dSpan = Number.isFinite(dStart) && Number.isFinite(dEnd) ? dEnd - dStart : 0;
      const overlap = Number.isFinite(dStart) && Number.isFinite(dEnd)
        ? rangeOverlapLength(start, end, dStart, dEnd)
        : 0;
      const overlapRatio = overlap / Math.min(panelLength, Math.max(1, dSpan || panelLength));
      const endpointDiff = Number.isFinite(dStart) && Number.isFinite(dEnd)
        ? Math.abs(dStart - start) + Math.abs(dEnd - end)
        : Infinity;
      const axisDiff = Number.isFinite(dAxis) ? Math.abs(dAxis - axis) : Infinity;
      const centerDiff = Number.isFinite(dMid) ? Math.abs(dMid - (start + end) / 2) : Infinity;
      const textAlong = textPoint ? (orientation === "horizontal" ? textPoint.x : textPoint.y) : null;
      const textAxis = textPoint ? (orientation === "horizontal" ? textPoint.y : textPoint.x) : null;
      const textInsideSpan = Number.isFinite(textAlong) && textAlong >= start - endpointTolerance && textAlong <= end + endpointTolerance;
      const textAxisDiff = Number.isFinite(textAxis) ? Math.abs(textAxis - axis) : Infinity;
      const valueDiff = Math.abs(Number(dimension.valueMm || 0) - expected);
      const markedCadDimension = /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(dimension.valueSource || ""));
      const endpointAligned = endpointDiff <= endpointTolerance * 2.2;
      const spanAligned = overlapRatio >= 0.86 && centerDiff <= centerTolerance;
      const textAligned = textInsideSpan && textAxisDiff <= axisTolerance;
      const valueAgrees = valueDiff <= Math.max(40, expected * 0.012);
      const accepted = markedCadDimension && (
        (endpointAligned && axisDiff <= axisTolerance * 1.6) ||
        (spanAligned && axisDiff <= axisTolerance * 1.6) ||
        (textAligned && valueAgrees) ||
        (valueAgrees && axisDiff <= axisTolerance && centerDiff <= centerTolerance)
      );
      return {
        dimension,
        accepted,
        endpointAligned,
        spanAligned,
        textAligned,
        valueAgrees,
        endpointDiff,
        axisDiff,
        textAxisDiff,
        centerDiff,
        valueDiff,
        overlapRatio,
        markedCadDimension,
      };
    })
    .filter((item) => item.accepted)
    .sort((a, b) => {
      const aVisible = /visible-dimension-text|text-dimension-label/i.test(String(a.dimension.valueSource || ""));
      const bVisible = /visible-dimension-text|text-dimension-label/i.test(String(b.dimension.valueSource || ""));
      if (aVisible !== bVisible) return aVisible ? -1 : 1;
      const aEndpoint = a.endpointAligned ? 0 : 1;
      const bEndpoint = b.endpointAligned ? 0 : 1;
      if (aEndpoint !== bEndpoint) return aEndpoint - bEndpoint;
      return (a.axisDiff + a.centerDiff * 0.8 + a.endpointDiff * 0.4 + a.valueDiff * 0.25)
        - (b.axisDiff + b.centerDiff * 0.8 + b.endpointDiff * 0.4 + b.valueDiff * 0.25);
    });
  return candidates[0]?.dimension || null;
}

function markedFaceDimensionsForBeam(dimensions, label, span, orientation, widthMm = 0) {
  if (!label || !span || !Array.isArray(dimensions) || !dimensions.length) return [];
  const axis = orientation === "horizontal" ? (span.y + span.y2) / 2 : (span.x + span.x2) / 2;
  const spanStart = orientation === "horizontal" ? Math.min(span.x, span.x2) : Math.min(span.y, span.y2);
  const spanEnd = orientation === "horizontal" ? Math.max(span.x, span.x2) : Math.max(span.y, span.y2);
  const labelAlong = orientation === "horizontal" ? label.x : label.y;
  const labelCross = orientation === "horizontal" ? label.y : label.x;
  const axisLimit = Math.max(2500, Math.min(9000, Math.max(widthMm, 450) * 12));
  const alongLimit = Math.max(2500, Math.min(12000, Math.max(spanEnd - spanStart, widthMm * 6, 2500)));
  const candidates = dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .map((dimension) => {
      const dStart = orientation === "horizontal" ? Math.min(dimension.x1 || 0, dimension.x2 || 0) : Math.min(dimension.y1 || 0, dimension.y2 || 0);
      const dEnd = orientation === "horizontal" ? Math.max(dimension.x1 || 0, dimension.x2 || 0) : Math.max(dimension.y1 || 0, dimension.y2 || 0);
      const dAxis = orientation === "horizontal" ? (dimension.y1 + dimension.y2) / 2 : (dimension.x1 + dimension.x2) / 2;
      const dMid = (dStart + dEnd) / 2;
      const axisDiff = Number.isFinite(dAxis) ? Math.min(Math.abs(dAxis - axis), Math.abs(dAxis - labelCross)) : Infinity;
      const labelDistance = Math.abs(dMid - labelAlong);
      const overlap = Math.max(0, Math.min(spanEnd, dEnd) - Math.max(spanStart, dStart));
      const nearLabelSpan = labelAlong >= dStart - alongLimit && labelAlong <= dEnd + alongLimit;
      return { dimension, dStart, dEnd, dMid, axisDiff, labelDistance, overlap, nearLabelSpan };
    })
    .filter((item) => item.dimension.valueMm >= 250 && item.dimension.valueMm <= 60000)
    .filter((item) => item.axisDiff <= axisLimit)
    .filter((item) => item.nearLabelSpan || item.labelDistance <= alongLimit || item.overlap > 250)
    // alongLimit can reach several metres, wide enough to also catch a neighbouring beam's own
    // dimension when beams sit only a couple of metres apart (confirmed against the real
    // drawing: T2B1's and T2B2's labels each pulled in the other's dimension text this way).
    // A dimension that actually describes THIS beam's own span should overlap the beam's own
    // measured line geometry (spanStart..spanEnd), not just sit somewhere along the same axis -
    // require that whenever the beam's own span is known, falling back to the looser proximity
    // filters above only when it isn't (span degenerate/unavailable).
    .filter((item) => !(spanEnd > spanStart) || item.overlap > 0)
    .sort((a, b) => (a.axisDiff + a.labelDistance * 0.1 - a.overlap * 0.02) - (b.axisDiff + b.labelDistance * 0.1 - b.overlap * 0.02));
  const unique = [];
  for (const item of candidates) {
    if (unique.some((existing) => Math.abs(existing.valueMm - item.dimension.valueMm) <= 25)) continue;
    unique.push(item.dimension);
    if (unique.length >= 4) break;
  }
  return unique;
}

function markedFaceDimensionsNearLabel(dimensions, label, orientation, widthMm = 0) {
  if (!label || !Array.isArray(dimensions) || !dimensions.length) return [];
  if (!["horizontal", "vertical"].includes(orientation)) return [];
  const labelAlong = orientation === "horizontal" ? Number(label.x || 0) : Number(label.y || 0);
  const labelCross = orientation === "horizontal" ? Number(label.y || 0) : Number(label.x || 0);
  const axisLimit = Math.max(3500, Math.min(12000, Math.max(widthMm, 450) * 16));
  const alongLimit = 18000;
  const candidates = dimensions
    .filter((dimension) => dimension.orientation === orientation)
    .filter((dimension) => Number(dimension.valueMm || 0) >= 250 && Number(dimension.valueMm || 0) <= 60000)
    .map((dimension) => {
      const dStart = orientation === "horizontal" ? Math.min(dimension.x1 || 0, dimension.x2 || 0) : Math.min(dimension.y1 || 0, dimension.y2 || 0);
      const dEnd = orientation === "horizontal" ? Math.max(dimension.x1 || 0, dimension.x2 || 0) : Math.max(dimension.y1 || 0, dimension.y2 || 0);
      const dAxis = orientation === "horizontal" ? (Number(dimension.y1 || 0) + Number(dimension.y2 || 0)) / 2 : (Number(dimension.x1 || 0) + Number(dimension.x2 || 0)) / 2;
      const dMid = (dStart + dEnd) / 2;
      const axisDiff = Number.isFinite(dAxis) ? Math.abs(dAxis - labelCross) : Infinity;
      const labelDistance = Math.abs(dMid - labelAlong);
      const labelWithin = labelAlong >= dStart - alongLimit && labelAlong <= dEnd + alongLimit;
      const visibleBonus = /visible-dimension-text|text-dimension-label/i.test(String(dimension.valueSource || "")) ? -5000 : 0;
      return { dimension, dStart, dEnd, dAxis, dMid, axisDiff, labelDistance, labelWithin, visibleBonus };
    })
    .filter((item) => item.axisDiff <= axisLimit)
    .filter((item) => item.labelWithin || item.labelDistance <= alongLimit)
    .sort((a, b) => (a.visibleBonus + a.axisDiff + a.labelDistance * 0.08) - (b.visibleBonus + b.axisDiff + b.labelDistance * 0.08));
  const unique = [];
  for (const item of candidates) {
    if (unique.some((existing) => Math.abs(existing.valueMm - item.dimension.valueMm) <= 25)) continue;
    unique.push(item.dimension);
    if (unique.length >= 4) break;
  }
  return unique;
}

function chooseMeasuredDimension({ cadDimension, gridDimension, geometryMm, preferGeometryWhenCadExceeds = false }) {
  const cadMm = cadDimension?.valueMm || 0;
  const gridMm = gridDimension?.valueMm || 0;
  const geometry = geometryMm || 0;
  const values = [
    cadMm ? { source: "cad-dimension", valueMm: cadMm } : null,
    gridMm ? { source: "grid-dimension", valueMm: gridMm } : null,
    geometry ? { source: "geometry", valueMm: geometry } : null,
  ].filter(Boolean);
  if (!values.length) return { valueMm: 0, source: "missing", conflict: false, values };

  const cadGridAgree = cadMm && gridMm && Math.abs(cadMm - gridMm) <= Math.max(25, Math.max(cadMm, gridMm) * 0.01);
  const cadGeometryAgree = cadMm && geometry && Math.abs(cadMm - geometry) <= Math.max(50, Math.max(cadMm, geometry) * 0.02);
  const gridGeometryAgree = gridMm && geometry && Math.abs(gridMm - geometry) <= Math.max(50, Math.max(gridMm, geometry) * 0.02);
  const geometryLooksLikeDrawnDimension = geometry && Math.abs(geometry - Math.round(geometry / 25) * 25) <= 2;
  const snappedGeometryMm = geometry && Math.abs(geometry - Math.round((geometry + 0.5) / 50) * 50) <= 26
    ? Math.round((geometry + 0.5) / 50) * 50
    : geometry;
  const cadIsMarkedDimension = cadMm && /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(cadDimension?.valueSource || ""));
  const gridIsMarkedDimension = gridMm && /visible-dimension-text|text-dimension-label|actual-measurement/i.test(String(gridDimension?.valueSource || ""));
  // A "marked"/"visible" dimension tag only means some CAD dimension entity's text was
  // legible - it says nothing about whether that entity actually belongs to this span.
  // Dimension-matching functions (cadDimensionForSpan, markedFaceDimensionsNearLabel, etc.)
  // search a generous radius around a label/line and can attach an unrelated nearby
  // dimension (a support/column width, an offset annotation) to this span. When the
  // measured geometry disagrees with a "marked" value by more than 2x, that is a much
  // stronger signal of a mismatched dimension than of a wrong geometry measurement, so it
  // should not be trusted blindly ahead of geometry.
  const cadWildlyDisagreesWithGeometry = cadMm > 0 && geometry > 0 && (cadMm < geometry * 0.5 || cadMm > geometry * 2);
  const gridWildlyDisagreesWithGeometry = gridMm > 0 && geometry > 0 && (gridMm < geometry * 0.5 || gridMm > geometry * 2);

  let selected = values[0];
  if (cadGridAgree) selected = { source: "cad-grid-agree", valueMm: cadMm };
  else if (cadGeometryAgree) selected = { source: "cad-geometry-agree", valueMm: cadMm };
  else if (gridGeometryAgree) selected = { source: "grid-geometry-agree", valueMm: gridMm };
  else if (cadIsMarkedDimension && !cadWildlyDisagreesWithGeometry) selected = { source: "cad-dimension", valueMm: cadMm };
  else if (gridIsMarkedDimension && !gridWildlyDisagreesWithGeometry) selected = { source: "grid-dimension", valueMm: gridMm };
  else if (preferGeometryWhenCadExceeds && geometry && cadMm && cadMm > geometry && !cadIsMarkedDimension) selected = { source: "support-stopped-geometry", valueMm: geometry };
  else if (geometryLooksLikeDrawnDimension && cadMm && Math.abs(cadMm - geometry) > Math.max(150, geometry * 0.025)) selected = { source: "drawn-geometry-over-conflicting-cad-dimension", valueMm: snappedGeometryMm };
  else if (geometry && (cadWildlyDisagreesWithGeometry || gridWildlyDisagreesWithGeometry)) selected = { source: "geometry-over-implausible-marked-dimension", valueMm: geometry };
  else if (cadMm) selected = { source: "cad-dimension", valueMm: cadMm };
  else if (gridMm) selected = { source: "grid-dimension", valueMm: gridMm };
  else selected = { source: "geometry", valueMm: geometry };

  const selectedValue = selected.valueMm;
  const disagreement = values.some((item) => Math.abs(item.valueMm - selectedValue) > Math.max(75, selectedValue * 0.025));
  const authoritative = /cad|grid/.test(selected.source) && !/drawn-geometry|support-stopped-geometry/.test(selected.source);
  const conflict = disagreement && !authoritative;
  return { ...selected, conflict, disagreement, authoritative, values };
}

function finiteMin(values, fallback = Infinity) {
  let result = fallback;
  let found = false;
  for (const value of values || []) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    if (!found || number < result) result = number;
    found = true;
  }
  return found ? result : fallback;
}

function finiteMax(values, fallback = -Infinity) {
  let result = fallback;
  let found = false;
  for (const value of values || []) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    if (!found || number > result) result = number;
    found = true;
  }
  return found ? result : fallback;
}

function minAbsDistance(values, target, fallback = Infinity) {
  let result = fallback;
  let found = false;
  for (const value of values || []) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    const distance = Math.abs(number - target);
    if (!found || distance < result) result = distance;
    found = true;
  }
  return found ? result : fallback;
}

function robustNumericRange(values, rawMin, rawMax) {
  const numeric = (values || []).map(Number).filter(Number.isFinite);
  if (numeric.length < 40) return { min: rawMin, max: rawMax, robust: false };
  numeric.sort((a, b) => a - b);
  const trimRatio = numeric.length > 1000 ? 0.005 : 0.025;
  const lowIndex = Math.min(numeric.length - 1, Math.max(0, Math.floor(numeric.length * trimRatio)));
  const highIndex = Math.min(numeric.length - 1, Math.max(lowIndex, Math.ceil(numeric.length * (1 - trimRatio)) - 1));
  const robustMin = numeric[lowIndex];
  const robustMax = numeric[highIndex];
  const rawSpan = Math.max(rawMax - rawMin, 0);
  const robustSpan = Math.max(robustMax - robustMin, 0);
  const useRobust = robustSpan > 1000 && rawSpan > robustSpan * 8;
  return useRobust
    ? { min: robustMin, max: robustMax, robust: true }
    : { min: rawMin, max: rawMax, robust: false };
}

function boundsFromPoints(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const point of points || []) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
    count += 1;
  }
  if (!count) return null;
  return {
    minX,
    maxX,
    minY,
    maxY,
  };
}

function geometryKey(points, toleranceMm = 100) {
  return points.map((value) => Math.round(value / toleranceMm)).join(":");
}

function uniqueRowsBy(rows, keyFn, scoreFn = () => 0) {
  const best = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const current = best.get(key);
    if (!current || scoreFn(row) < scoreFn(current)) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

function clusterValues(values, tolerance = 300) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const clusters = [];
  for (const value of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current || Math.abs(value - current.sum / current.count) > tolerance) {
      clusters.push({ sum: value, count: 1 });
    } else {
      current.sum += value;
      current.count += 1;
    }
  }
  return clusters.map((cluster) => cluster.sum / cluster.count);
}

function medianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mergedCoverageLength(intervals, start, end, joinTolerance = 50) {
  const clipped = intervals
    .map((item) => ({ start: Math.max(Math.min(item.start, item.end), start), end: Math.min(Math.max(item.start, item.end), end) }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cursorStart = null;
  let cursorEnd = null;
  for (const interval of clipped) {
    if (cursorStart === null) {
      cursorStart = interval.start;
      cursorEnd = interval.end;
    } else if (interval.start <= cursorEnd + joinTolerance) {
      cursorEnd = Math.max(cursorEnd, interval.end);
    } else {
      total += cursorEnd - cursorStart;
      cursorStart = interval.start;
      cursorEnd = interval.end;
    }
  }
  if (cursorStart !== null) total += cursorEnd - cursorStart;
  return total;
}

function mergedCoverageIntervals(intervals, start, end, joinTolerance = 50) {
  const clipped = intervals
    .map((item) => ({ start: Math.max(Math.min(item.start, item.end), start), end: Math.min(Math.max(item.start, item.end), end) }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of clipped) {
    const current = merged[merged.length - 1];
    if (!current || interval.start > current.end + joinTolerance) {
      merged.push({ ...interval });
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  return merged;
}

function quantizeCadSpanMm(lengthMm) {
  const nearest100 = Math.round(lengthMm / 100) * 100;
  if (Math.abs(lengthMm - nearest100) <= 30) return nearest100;
  return Math.round(lengthMm / 50) * 50;
}

function hasHorizontalCoverage(horizontal, y, x1, x2, tolerance = 350) {
  const intervals = horizontal
    .filter((line) => Math.abs(line.y - y) <= tolerance)
    .map((line) => ({ start: line.minX, end: line.maxX }));
  return mergedCoverageLength(intervals, x1, x2, Math.max(650, tolerance * 2.5)) >= (x2 - x1) * 0.7;
}

function hasVerticalCoverage(vertical, x, y1, y2, tolerance = 350) {
  const intervals = vertical
    .filter((line) => Math.abs(line.x - x) <= tolerance)
    .map((line) => ({ start: line.minY, end: line.maxY }));
  return mergedCoverageLength(intervals, y1, y2, Math.max(650, tolerance * 2.5)) >= (y2 - y1) * 0.7;
}

function slabMarkBounds(slabMarks) {
  if (!slabMarks.length) return null;
  const bounds = boundsFromPoints(slabMarks);
  if (!bounds) return null;
  return {
    minX: bounds.minX - 2000,
    maxX: bounds.maxX + 2000,
    minY: bounds.minY - 2000,
    maxY: bounds.maxY + 2000,
  };
}

function entityBounds(entity) {
  const points = [];
  if (Number.isFinite(entity.x) && Number.isFinite(entity.y)) points.push({ x: entity.x, y: entity.y });
  if (Number.isFinite(entity.x2) && Number.isFinite(entity.y2)) points.push({ x: entity.x2, y: entity.y2 });
  if (Number.isFinite(entity.x13) && Number.isFinite(entity.y13)) points.push({ x: entity.x13, y: entity.y13 });
  if (Number.isFinite(entity.x14) && Number.isFinite(entity.y14)) points.push({ x: entity.x14, y: entity.y14 });
  for (const point of entity.vertices || []) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) points.push(point);
  }
  if (!points.length) return null;
  return boundsFromPoints(points);
}

function boxesOverlap(first, second, margin = 0) {
  if (!first || !second) return false;
  return first.maxX >= second.minX - margin &&
    first.minX <= second.maxX + margin &&
    first.maxY >= second.minY - margin &&
    first.minY <= second.maxY + margin;
}

function pointInsideBox(point, box, margin = 0) {
  if (!point || !box) return false;
  return point.x >= box.minX - margin &&
    point.x <= box.maxX + margin &&
    point.y >= box.minY - margin &&
    point.y <= box.maxY + margin;
}

function isXrefSourcedEntity(entity) {
  const looksXrefBound = (value) => {
    const text = String(value || "");
    return /\$\d+\$/.test(text) || /^X[A-Za-z]/.test(text);
  };
  return looksXrefBound(entity?.sourceBlock) || looksXrefBound(entity?.layer);
}

// Repeated-floor drawings commonly xref a tower's OWN typical column/grid layout onto every
// level (e.g. "XR_T2_Column_Typ-Fl") rather than redrawing it, alongside genuinely foreign
// geometry from an adjacent tower sharing the same basement grid (e.g. "XR_T5_Column_Typ-Fl").
// isXrefSourcedEntity can't tell those apart; this can, by checking whether the reference names
// this tower specifically and no other.
function isOwnTowerXrefReference(entity, towerToken) {
  if (!towerToken) return false;
  const source = `${entity?.layer || ""} ${entity?.sourceBlock || ""}`;
  const escaped = String(towerToken).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownPattern = new RegExp(`(?:^|[^A-Za-z0-9])(?:tower\\s*)?${escaped}(?:[^A-Za-z0-9]|$)`, "i");
  const otherTowerPattern = /(?:^|[^A-Za-z0-9])(?:tower\s*(\d+)|T(\d+))(?:[^A-Za-z0-9]|$)/gi;
  if (!ownPattern.test(source)) return false;
  const ownNumber = String(towerToken).match(/\d+/)?.[0];
  let match;
  while ((match = otherTowerPattern.exec(source))) {
    const foundNumber = match[1] || match[2];
    if (ownNumber && foundNumber && foundNumber !== ownNumber) return false;
  }
  return true;
}

// Non-xref layer names in this drawing carry the tower token directly (e.g. "BEAM NO T2",
// "SLABS NO T2"), so the primary tower can be read straight off whichever layers the trusted
// (non-xref) geometry actually uses, without hardcoding a specific project's tower number.
function detectPrimaryTowerToken(entities) {
  const counts = {};
  for (const entity of entities) {
    if (isXrefSourcedEntity(entity)) continue;
    const match = String(entity?.layer || "").match(/\bT(\d+)\b/i);
    if (match) counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [num, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = num;
      bestCount = count;
    }
  }
  return best ? `T${best}` : null;
}

function nonPrimaryDetailZones(textEntities = []) {
  const detailTitlePattern = /\b(?:SLAB\s+PROFILE|PROFILE|BEAM\s+DETAIL|BEAM\s+SCHEDULE|SECTION|DETAIL|BBS|BAR\s+BENDING|REINFORCEMENT|STEEL\s+DETAIL|COLUMN\s+SCHEDULE)\b/i;
  return textEntities
    .filter((item) => !isXrefSourcedEntity(item))
    .filter((item) => detailTitlePattern.test(item.text || "") && !/\bFRAMING\s+PLAN\b/i.test(item.text || ""))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item) => ({
      label: item.text,
      minX: item.x - 65000,
      maxX: item.x + 65000,
      minY: item.y - 42000,
      maxY: item.y + 42000,
    }));
}

function textRegionStats(textEntities = [], region) {
  const texts = textEntities.filter((item) => pointInsideBox(item, region, 2500));
  const planTitleCount = texts.filter((item) => /\b(?:FRAMING\s+PLAN|FLOOR\s+PLAN|LAYOUT\s+PLAN|PLAN\s+AT|TOC\.?\s*LVL)\b/i.test(item.text || "")).length;
  const detailTitleCount = texts.filter((item) => /\b(?:SLAB\s+PROFILE|PROFILE|BEAM\s+DETAIL|BEAM\s+SCHEDULE|SECTION|DETAIL|BBS|BAR\s+BENDING|REINFORCEMENT|STEEL\s+DETAIL|COLUMN\s+SCHEDULE)\b/i.test(item.text || "")).length;
  const beamLabelCount = texts.filter((item) => Boolean(canonicalBeamId(item.text))).length;
  const beamSizeCount = texts.filter((item) => Boolean(parseSizeText(item.text))).length;
  const slabMarkCount = texts.filter((item) => /^S\d+[A-Z]?$/.test(item.text || "")).length;
  const cutoutCount = texts.filter((item) => /\b(?:CUT\s*OUT|CUTOUT|OPEN\s+TO\s+SKY|SHAFT|LIFT)\b/i.test(item.text || "")).length;
  return {
    texts: texts.length,
    planTitleCount,
    detailTitleCount,
    beamLabelCount,
    beamSizeCount,
    slabMarkCount,
    cutoutCount,
  };
}

function inferFramingPlanRegion(entities, slabInfo) {
  const allText = entities
    .filter((item) => ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(item.type) && item.text)
    .filter((item) => !isXrefSourcedEntity(item))
    .map((item) => ({ ...item, text: cleanCadText(item.text) }))
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
  const detailZones = nonPrimaryDetailZones(allText);
  const textMarkers = allText
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) =>
      /^S\d+[A-Z]?$/.test(item.text) ||
      Boolean(canonicalBeamId(item.text)) ||
      /\bBEAM\b|\d{2,4}\s*[xX]\s*\d{2,4}/i.test(item.text));
  const slabMarks = (slabInfo.slabMarks || [])
    .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y))
    .filter((item) => !detailZones.some((zone) => pointInsideBox(item, zone, 0)));
  const seedMap = new Map();
  for (const item of [...textMarkers, ...slabMarks]) {
    if (detailZones.some((zone) => pointInsideBox(item, zone, 0)) && !/\bFRAMING\s+PLAN\b/i.test(item.text || "")) continue;
    const key = `${Math.round(item.x / 100)}:${Math.round(item.y / 100)}:${item.text || ""}`;
    seedMap.set(key, item);
  }
  const seeds = [...seedMap.values()];
  if (seeds.length < 8) return null;

  const parent = seeds.map((_, index) => index);
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

  for (let first = 0; first < seeds.length; first += 1) {
    for (let second = first + 1; second < seeds.length; second += 1) {
      if (Math.abs(seeds[first].x - seeds[second].x) <= 45000 &&
        Math.abs(seeds[first].y - seeds[second].y) <= 32000) {
        union(first, second);
      }
    }
  }

  const groups = new Map();
  seeds.forEach((seed, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), seed]);
  });
  const candidates = [...groups.values()]
    .map((items) => {
      const bounds = boundsFromPoints(items);
      if (!bounds) return null;
      const { minX, maxX, minY, maxY } = bounds;
      const area = Math.max(1, (maxX - minX) * (maxY - minY));
      const region = {
        minX: minX - 9000,
        maxX: maxX + 9000,
        minY: minY - 7000,
        maxY: maxY + 7000,
      };
      const stats = textRegionStats(allText, region);
      const score = items.length +
        stats.beamLabelCount * 4 +
        stats.beamSizeCount * 1.5 +
        stats.slabMarkCount * 1.25 +
        stats.planTitleCount * 80 -
        stats.detailTitleCount * 140;
      return { items, minX, maxX, minY, maxY, area, region, stats, score };
    })
    .sort((a, b) => b.score - a.score || b.items.length - a.items.length || b.area - a.area);
  const best = candidates[0];
  if (!best || best.items.length < Math.max(6, seeds.length * 0.2) || best.score <= 0) return null;

  return {
    minX: best.region.minX,
    maxX: best.region.maxX,
    minY: best.region.minY,
    maxY: best.region.maxY,
    markerCount: best.items.length,
    totalMarkerCount: seeds.length,
    basis: best.stats.planTitleCount
      ? "primary-framing-plan-title-and-evidence"
      : "primary-framing-plan-scored-evidence-cluster",
    regionStats: best.stats,
    rejectedDetailZones: detailZones.length,
  };
}

function filterEntitiesToFramingRegion(entities, region) {
  if (!region) return entities;
  return entities.filter((entity) => boxesOverlap(entityBounds(entity), region, 2500));
}

function filterEntitiesOutsideDetailZones(entities, zones = [], margin = 0) {
  if (!Array.isArray(zones) || !zones.length) return entities;
  return entities.filter((entity) => {
    const bounds = entityBounds(entity);
    if (!bounds) return true;
    const center = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    return !zones.some((zone) => boxesOverlap(bounds, zone, margin) || pointInsideBox(center, zone, margin));
  });
}

function beamTakeoffEvidenceCount(entities = []) {
  let count = 0;
  for (const entity of entities) {
    if (["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(entity.type) && entity.text) {
      const text = cleanCadText(entity.text);
      if (canonicalBeamId(text) || parseSizeText(text)) count += 1;
    } else if (entity.type === "LINE" && isBeamGeometryLayer(entity.layer || "")) {
      count += 0.25;
    }
  }
  return count;
}

function supportOutlinesFromDxf(entities) {
  const supportLayerPattern = /(^|[^A-Z])(COL|COLUMN|WALL)([^A-Z]|$)|RET\.?\s*WALL|RC\s*PARDI|A-Plan-Wall|S-WALL|WT\s*WALL|VIN_COLUMN/i;
  const fillEvidence = supportFillEvidenceFromDxf(entities);
  const towerToken = detectPrimaryTowerToken(entities);
  return entities
    // A support outline used to trim a beam's own span to a real column/wall face has to
    // actually belong to this tower - an adjacent tower's xref'd column/grid layout can share
    // this drawing's basement grid and coincidentally sit right where a beam's label is, which
    // otherwise silently trims a real beam down to a fraction of its true length (confirmed
    // against the real drawing: a beam near the T2/T5 boundary got trimmed from 4.23m to 0.67m
    // by a "XR_T5_Column_Typ-Fl" grid line).
    .filter((item) => !isXrefSourcedEntity(item) || isOwnTowerXrefReference(item, towerToken))
    .filter((item) => ["LWPOLYLINE", "LINE"].includes(item.type) && supportLayerPattern.test(item.layer || "") && !/CUT|SHAFT|VOID|OPEN|BEAM\s*(NO|SIZE)/i.test(item.layer || ""))
    .map((item) => {
      let bounds = null;
      if (item.type === "LWPOLYLINE") {
        const points = item.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        if (points.length < 2) return null;
        bounds = boundsFromPoints(points);
      } else if (Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.x2) && Number.isFinite(item.y2)) {
        bounds = lineMinMax(item);
      }
      if (!bounds) return null;
      const widthM = (bounds.maxX - bounds.minX) / 1000;
      const heightM = (bounds.maxY - bounds.minY) / 1000;
      if (Math.max(widthM, heightM) < 0.05) return null;
      const fill = nearestSupportFillEvidence(bounds, fillEvidence);
      return {
        layer: item.layer,
        ...bounds,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        widthM,
        heightM,
        continuationStatus: fill?.continuationStatus || "unknown",
        fillPattern: fill?.pattern || "",
        fillLayer: fill?.layer || "",
        fillEvidence: fill?.basis || "No solid/hatch fill evidence found inside support outline.",
      };
    })
    .filter(Boolean);
}

function supportFillEvidenceFromDxf(entities) {
  const fillLayerPattern = /COL|COLUMN|WALL|PARDI|S-WALL|WT\s*WALL|VIN_COLUMN/i;
  return entities
    .filter((item) => ["HATCH", "SOLID", "TRACE"].includes(item.type))
    .filter((item) => fillLayerPattern.test(item.layer || ""))
    .map((item) => {
      let points = [];
      if (Array.isArray(item.vertices)) {
        points = item.vertices.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      }
      if (Number.isFinite(item.x) && Number.isFinite(item.y)) points.push({ x: item.x, y: item.y });
      if (Number.isFinite(item.x2) && Number.isFinite(item.y2)) points.push({ x: item.x2, y: item.y2 });
      if (Number.isFinite(item.x13) && Number.isFinite(item.y13)) points.push({ x: item.x13, y: item.y13 });
      if (Number.isFinite(item.x14) && Number.isFinite(item.y14)) points.push({ x: item.x14, y: item.y14 });
      if (points.length < 1) return null;
      const bounds = points.length === 1
        ? { minX: points[0].x, maxX: points[0].x, minY: points[0].y, maxY: points[0].y }
        : boundsFromPoints(points);
      const pattern = String(item.pattern || item.type || "").toUpperCase();
      const continuationStatus = pattern === "SOLID" || item.type === "SOLID"
        ? "continues-above"
        : "terminates-at-this-floor";
      return {
        layer: item.layer || "",
        pattern,
        continuationStatus,
        basis: continuationStatus === "continues-above"
          ? "Solid-filled column/wall; carry this support to next floor."
          : "Hatched column/wall; terminate at this floor for above-floor column/wall quantities.",
        ...bounds,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
      };
    })
    .filter(Boolean);
}

function nearestSupportFillEvidence(bounds, fillEvidence) {
  const supportCenterX = (bounds.minX + bounds.maxX) / 2;
  const supportCenterY = (bounds.minY + bounds.maxY) / 2;
  return fillEvidence
    .map((fill) => {
      const overlapX = Math.max(0, Math.min(bounds.maxX, fill.maxX) - Math.max(bounds.minX, fill.minX));
      const overlapY = Math.max(0, Math.min(bounds.maxY, fill.maxY) - Math.max(bounds.minY, fill.minY));
      const containsCenter = fill.centerX >= bounds.minX - 50 &&
        fill.centerX <= bounds.maxX + 50 &&
        fill.centerY >= bounds.minY - 50 &&
        fill.centerY <= bounds.maxY + 50;
      return {
        ...fill,
        overlapArea: overlapX * overlapY,
        centerDistance: Math.hypot(fill.centerX - supportCenterX, fill.centerY - supportCenterY),
        containsCenter,
      };
    })
    .filter((fill) => fill.overlapArea > 0 || fill.containsCenter || fill.centerDistance <= 150)
    .sort((a, b) => {
      if (a.overlapArea !== b.overlapArea) return b.overlapArea - a.overlapArea;
      if (a.containsCenter !== b.containsCenter) return a.containsCenter ? -1 : 1;
      return a.centerDistance - b.centerDistance;
    })[0] || null;
}

function round3(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;
}

function entityCollectionBounds(items = []) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let hasX = false;
  let hasY = false;
  const xs = [];
  const ys = [];
  function addPoint(x, y) {
    if (Number.isFinite(x)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      hasX = true;
      xs.push(x);
    }
    if (Number.isFinite(y)) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hasY = true;
      ys.push(y);
    }
  }
  for (const item of items) {
    addPoint(item.x, item.y);
    addPoint(item.x2, item.y2);
    for (const point of item.vertices || []) {
      addPoint(point.x, point.y);
    }
  }
  if (!hasX || !hasY) return null;
  const rawWidth = Math.max(maxX - minX, 0);
  const rawHeight = Math.max(maxY - minY, 0);
  if (rawWidth > 5000000 || rawHeight > 5000000) {
    const xRange = robustNumericRange(xs, minX, maxX);
    const yRange = robustNumericRange(ys, minY, maxY);
    if (xRange.robust || yRange.robust) {
      return {
        minX: xRange.min,
        maxX: xRange.max,
        minY: yRange.min,
        maxY: yRange.max,
        robustOutlierTrimmed: true,
        rawMinX: minX,
        rawMaxX: maxX,
        rawMinY: minY,
        rawMaxY: maxY,
      };
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
  };
}

function extractBeamIdFromMixedText(value = "") {
  const normalized = cleanCadText(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ");
  const matches = normalized.match(/\b(?:T\d+[A-Z]*B\d+[A-Z]?|[A-Z]{1,3}B\d+[A-Z]?|M?B\d+[A-Z]?|B\d+[A-Z]?)\b/g) || [];
  return matches.find((item) => !/^(?:QB|BQ|BR)\d+[A-Z]?$/.test(item) && hasPositiveBeamNumber(item)) || "";
}

module.exports = {
  cleanCadText,
  hasPositiveBeamNumber,
  canonicalBeamId,
  uniqueStrings,
  extractMarks,
  parseDxfEvidence,
  finiteOr,
  normalizeTakeoffEntity,
  cadEntityEvidenceScore,
  markedDimensionEntityEvidenceCount,
  beamSizeEntityEvidenceCount,
  beamLabelEntityEvidenceCount,
  summarizeEvidence,
  distance,
  lineLength,
  entityLineSegments,
  pointToSegmentDistance,
  parseSizeText,
  isPlanDrawingName,
  isDetailScheduleDrawingName,
  nearest,
  modeNumber,
  textPoint,
  extractSlabThicknessInfo,
  extractDetailSchedulesFromEntities,
  extractSlabReinforcementSchedule,
  mergeSlabThicknessInfo,
  isHorizontal,
  isVertical,
  lineMinMax,
  lineMidpoint,
  lineIntersectionPoint,
  isLikelyVoidXPair,
  isBeamGeometryLayer,
  lineOrientation,
  cadLineTypeText,
  beamFaceLineStyle,
  beamSideFaceEvidence,
  textOrientation,
  normalizeGridName,
  isGridLabelText,
  isGridLineLayer,
  axisKindFromGridName,
  visibleDimensionValueMm,
  textDimensionValueMm,
  dimensionEvidenceFromNumericText,
  dimensionEvidenceKey,
  dimensionEvidenceRank,
  textDimensionEvidenceFromEntities,
  mergeDimensionEvidence,
  dimensionOrientationFromEndpoints,
  extractGridEvidence,
  findGridAxis,
  gridDimensionBetween,
  cadDimensionForSpan,
  dimensionPointNumber,
  dimensionTextPoint,
  dimensionEvidenceBounds,
  dimensionEvidenceInsideRegion,
  dimensionSpanRange,
  dimensionSpanAxis,
  rangeOverlapLength,
  distanceToRange,
  cadDimensionForPanelSpan,
  markedFaceDimensionsForBeam,
  markedFaceDimensionsNearLabel,
  chooseMeasuredDimension,
  finiteMin,
  finiteMax,
  minAbsDistance,
  robustNumericRange,
  boundsFromPoints,
  geometryKey,
  uniqueRowsBy,
  clusterValues,
  medianNumber,
  mergedCoverageLength,
  mergedCoverageIntervals,
  quantizeCadSpanMm,
  hasHorizontalCoverage,
  hasVerticalCoverage,
  slabMarkBounds,
  entityBounds,
  boxesOverlap,
  pointInsideBox,
  nonPrimaryDetailZones,
  textRegionStats,
  inferFramingPlanRegion,
  filterEntitiesToFramingRegion,
  filterEntitiesOutsideDetailZones,
  beamTakeoffEvidenceCount,
  supportOutlinesFromDxf,
  supportFillEvidenceFromDxf,
  nearestSupportFillEvidence,
  round3,
  entityCollectionBounds,
  extractBeamIdFromMixedText,
};
