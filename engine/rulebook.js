"use strict";

// Single source of truth for QSS-* rules. Every other module (accuracy-audit,
// rulebook-check.js, golden tests) reads rules from here instead of keeping a
// second hand-typed copy in sync with qss-rulebook.json.

const fs = require("fs");
const path = require("path");

const RULEBOOK_PATH = path.join(__dirname, "..", "qss-rulebook.json");

let cached = null;

function load() {
  const raw = JSON.parse(fs.readFileSync(RULEBOOK_PATH, "utf8"));
  return {
    version: raw.rulebookVersion || "",
    appRuleVersion: raw.appRuleVersion || "",
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
}

function rulebook() {
  if (!cached) cached = load();
  return cached;
}

function reload() {
  cached = null;
  return rulebook();
}

function ruleById(id) {
  return rulebook().rules.find((rule) => rule.id === id);
}

function ruleByCodeId(codeId) {
  return rulebook().rules.find((rule) => {
    if (rule.codeId === codeId) return true;
    return Array.isArray(rule.aliases) && rule.aliases.includes(codeId);
  });
}

// Rules the engine can actually gather evidence for at runtime. Process-only
// entries (QSS-PROC-001, QSS-QA-003) have no codeId and are excluded here.
function codedRules() {
  return rulebook().rules.filter((rule) => rule.codeId);
}

function appliesTo(rule, itemType) {
  if (rule.appliesTo === "all") return true;
  if (rule.appliesTo === "slab") return itemType === "slab" || itemType === "raft";
  return rule.appliesTo === itemType;
}

module.exports = {
  RULEBOOK_PATH,
  rulebook,
  reload,
  ruleById,
  ruleByCodeId,
  codedRules,
  appliesTo,
};
