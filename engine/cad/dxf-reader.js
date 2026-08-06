"use strict";
const fs = require("node:fs/promises");

function cleanCadText(value) {
  return String(value || "")
    .replace(/\\P/g, " ")
    .replace(/%%U/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\[A-Za-z][^;{}\\]*(?:;|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function transformPoint(point, transform) {
  const sx = transform.sx ?? 1;
  const sy = transform.sy ?? sx;
  const angle = ((transform.rotation || 0) * Math.PI) / 180;
  const x = point.x * sx;
  const y = point.y * sy;
  return {
    x: transform.x + (x * Math.cos(angle)) - (y * Math.sin(angle)),
    y: transform.y + (x * Math.sin(angle)) + (y * Math.cos(angle)),
  };
}

function composeTransform(parent, insert) {
  const placed = transformPoint({ x: insert.x || 0, y: insert.y || 0 }, parent);
  return {
    x: placed.x,
    y: placed.y,
    sx: (parent.sx ?? 1) * (insert.sx ?? 1),
    sy: (parent.sy ?? parent.sx ?? 1) * (insert.sy ?? insert.sx ?? 1),
    rotation: (parent.rotation || 0) + (insert.rotation || 0),
  };
}

function finishEntity(list, entity) {
  if (!entity) return;
  entity.vertices = (entity.vertices || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  list.push(entity);
}

function readEntityPair(entity, code, trimmed) {
  if (code === "8") entity.layer = trimmed;
  if (code === "6") entity.lineType = trimmed;
  if (code === "62") entity.color = Number.parseInt(trimmed, 10);
  if (code === "2") entity.name = trimmed;
  if (code === "1" || code === "3") entity.text = `${entity.text || ""}${trimmed}`;
  if (code === "10") {
    const x = Number.parseFloat(trimmed);
    if (["LWPOLYLINE", "HATCH"].includes(entity.type)) entity.vertices.push({ x, y: null });
    else if (entity.x === undefined) entity.x = x;
  }
  if (code === "20") {
    const y = Number.parseFloat(trimmed);
    if (["LWPOLYLINE", "HATCH"].includes(entity.type) && entity.vertices.length) entity.vertices[entity.vertices.length - 1].y = y;
    else if (entity.y === undefined) entity.y = y;
  }
  if (code === "11") entity.x2 = Number.parseFloat(trimmed);
  if (code === "21") entity.y2 = Number.parseFloat(trimmed);
  if (entity.type === "DIMENSION") {
    if (code === "13") entity.ext1X = Number.parseFloat(trimmed);
    if (code === "23") entity.ext1Y = Number.parseFloat(trimmed);
    if (code === "14") entity.ext2X = Number.parseFloat(trimmed);
    if (code === "24") entity.ext2Y = Number.parseFloat(trimmed);
    if (code === "15") entity.dimLineX = Number.parseFloat(trimmed);
    if (code === "25") entity.dimLineY = Number.parseFloat(trimmed);
    if (code === "42") entity.actualMeasurement = Number.parseFloat(trimmed);
  }
  if (code === "41") entity.sx = Number.parseFloat(trimmed);
  if (code === "42" && entity.type !== "DIMENSION") entity.sy = Number.parseFloat(trimmed);
  if (code === "50") entity.rotation = Number.parseFloat(trimmed);
  if (code === "70") entity.flags = Number.parseInt(trimmed, 10);
}

async function parseDxfWithExpandedBlocks(filePath, { maxDepth = 8 } = {}) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const topEntities = [];
  const blocks = new Map();
  let section = "";
  let block = null;
  let entity = null;

  function finishCurrentEntity() {
    if (!entity) return;
    if (section === "ENTITIES") finishEntity(topEntities, entity);
    if (section === "BLOCKS" && block) finishEntity(block.entities, entity);
    entity = null;
  }

  function finishBlock() {
    finishCurrentEntity();
    if (block?.name) blocks.set(block.name, block);
    block = null;
  }

  for (let i = 0; i < lines.length - 1; i += 2) {
    const code = lines[i]?.trim();
    const trimmed = (lines[i + 1] || "").trim();

    if (code === "0" && trimmed === "SECTION") {
      section = lines[i + 3]?.trim() || "";
      i += 2;
      continue;
    }
    if (code === "0" && trimmed === "ENDSEC") {
      if (section === "BLOCKS") finishBlock();
      else finishCurrentEntity();
      section = "";
      continue;
    }

    if (section === "BLOCKS") {
      if (code === "0" && trimmed === "BLOCK") {
        finishBlock();
        block = { name: "", layer: "0", baseX: 0, baseY: 0, entities: [] };
        continue;
      }
      if (code === "0" && trimmed === "ENDBLK") {
        finishBlock();
        continue;
      }
      if (!block) continue;
      if (!entity && code === "2") block.name = trimmed;
      if (!entity && code === "8") block.layer = trimmed;
      if (!entity && code === "10") block.baseX = Number.parseFloat(trimmed);
      if (!entity && code === "20") block.baseY = Number.parseFloat(trimmed);
      if (code === "0") {
        finishCurrentEntity();
        entity = { type: trimmed, layer: block.layer, text: "", vertices: [] };
        continue;
      }
      if (entity) readEntityPair(entity, code, trimmed);
      continue;
    }

    if (section === "ENTITIES") {
      if (code === "0") {
        finishCurrentEntity();
        entity = { type: trimmed, layer: "0", text: "", vertices: [] };
        continue;
      }
      if (entity) readEntityPair(entity, code, trimmed);
    }
  }

  const expanded = [];
  function emit(entity, transform, sourceBlock = "", depth = 0) {
    if (entity.type === "INSERT" && entity.name && blocks.has(entity.name) && depth < maxDepth) {
      const nested = blocks.get(entity.name);
      const nestedTransform = composeTransform(transform, {
        x: (entity.x || 0) - (nested.baseX || 0),
        y: (entity.y || 0) - (nested.baseY || 0),
        sx: entity.sx || 1,
        sy: entity.sy || entity.sx || 1,
        rotation: entity.rotation || 0,
      });
      for (const child of nested.entities) emit(child, nestedTransform, entity.name, depth + 1);
      return;
    }

    const copy = { ...entity, sourceBlock };
    if (Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
      const point = transformPoint({ x: entity.x, y: entity.y }, transform);
      copy.x = point.x;
      copy.y = point.y;
    }
    if (Number.isFinite(entity.x2) && Number.isFinite(entity.y2)) {
      const point = transformPoint({ x: entity.x2, y: entity.y2 }, transform);
      copy.x2 = point.x;
      copy.y2 = point.y;
    }
    if (Number.isFinite(entity.ext1X) && Number.isFinite(entity.ext1Y)) {
      const point = transformPoint({ x: entity.ext1X, y: entity.ext1Y }, transform);
      copy.ext1X = point.x;
      copy.ext1Y = point.y;
    }
    if (Number.isFinite(entity.ext2X) && Number.isFinite(entity.ext2Y)) {
      const point = transformPoint({ x: entity.ext2X, y: entity.ext2Y }, transform);
      copy.ext2X = point.x;
      copy.ext2Y = point.y;
    }
    if (Number.isFinite(entity.dimLineX) && Number.isFinite(entity.dimLineY)) {
      const point = transformPoint({ x: entity.dimLineX, y: entity.dimLineY }, transform);
      copy.dimLineX = point.x;
      copy.dimLineY = point.y;
    }
    if (entity.vertices?.length) copy.vertices = entity.vertices.map((point) => transformPoint(point, transform));
    expanded.push(copy);
  }

  for (const item of topEntities) emit(item, { x: 0, y: 0, sx: 1, sy: 1, rotation: 0 });
  return { entities: topEntities, blocks, expanded };
}

module.exports = { cleanCadText, parseDxfWithExpandedBlocks };
