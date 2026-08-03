const fs = require("fs");
const path = require("path");

const root = __dirname;
const workspaceRoot = path.resolve(root, "..", "..");
const rulebookPath = path.join(root, "qss-rulebook.json");
const goldenTestsPath = path.join(root, "golden-tests.json");
const auditRulesPath = path.join(workspaceRoot, "work", "qss-takeoff-rules.cjs");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasDuplicate(values) {
  return values.some((value, index) => values.indexOf(value) !== index);
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function main() {
  const failures = [];
  const warnings = [];
  const rulebook = readJson(rulebookPath);
  const goldenTests = readJson(goldenTestsPath);
  const rules = Array.isArray(rulebook.rules) ? rulebook.rules : [];
  const ruleIds = rules.map((rule) => rule.id).filter(Boolean);
  const codeRuleIds = rules.map((rule) => rule.codeId).filter(Boolean);

  if (!rulebook.rulebookVersion) failures.push("qss-rulebook.json is missing rulebookVersion.");
  if (!rules.length) failures.push("qss-rulebook.json has no rules.");
  if (hasDuplicate(ruleIds)) failures.push(`Duplicate QSS rule ID(s): ${duplicateValues(ruleIds).join(", ")}.`);
  if (hasDuplicate(codeRuleIds)) failures.push(`Duplicate code rule ID(s): ${duplicateValues(codeRuleIds).join(", ")}.`);

  rules.forEach((rule) => {
    if (!/^QSS-[A-Z]+-\d{3}$/.test(String(rule.id || ""))) {
      failures.push(`Invalid QSS rule ID: ${rule.id || "(blank)"}. Use QSS-GROUP-001 format.`);
    }
    if (!rule.title) failures.push(`${rule.id} is missing title.`);
    if (!rule.summary) failures.push(`${rule.id} is missing summary.`);
    if (!Array.isArray(rule.acceptance) || !rule.acceptance.length) {
      failures.push(`${rule.id} is missing acceptance checks.`);
    }
    if (!["all", "beam", "slab", "column", "raft"].includes(rule.appliesTo)) {
      failures.push(`${rule.id} has invalid appliesTo: ${rule.appliesTo}.`);
    }
  });

  const { QSS_TAKEOFF_RULES = [] } = require(auditRulesPath);
  const auditRuleIds = QSS_TAKEOFF_RULES.map((rule) => rule.id);
  const unmappedAuditRules = auditRuleIds.filter((id) => !codeRuleIds.includes(id));
  if (unmappedAuditRules.length) {
    failures.push(`Audit rule(s) missing canonical QSS rule IDs: ${unmappedAuditRules.join(", ")}.`);
  }

  const tests = Array.isArray(goldenTests.tests) ? goldenTests.tests : [];
  tests.forEach((test) => {
    const testRuleIds = Array.isArray(test.ruleIds) ? test.ruleIds : [];
    if (!testRuleIds.length) {
      failures.push(`Golden test ${test.id} has no ruleIds.`);
      return;
    }
    const unknown = testRuleIds.filter((id) => !ruleIds.includes(id));
    if (unknown.length) {
      failures.push(`Golden test ${test.id} references unknown ruleIds: ${unknown.join(", ")}.`);
    }
  });

  const codedRulesWithoutTests = rules
    .filter((rule) => /coded/.test(String(rule.status || "")))
    .filter((rule) => !tests.some((test) => Array.isArray(test.ruleIds) && test.ruleIds.includes(rule.id)));
  codedRulesWithoutTests.forEach((rule) => {
    warnings.push(`${rule.id} ${rule.title} has no direct golden-test reference yet.`);
  });

  const documentedRulesNotFullyCoded = rules
    .filter((rule) => !/^coded/.test(String(rule.status || "")))
    .filter((rule) => !["process"].includes(String(rule.status || "")));
  documentedRulesNotFullyCoded.forEach((rule) => {
    warnings.push(`${rule.id} ${rule.title} is in the rulebook but not marked fully coded.`);
  });

  const rulesWithoutDirectTests = rules
    .filter((rule) => !tests.some((test) => Array.isArray(test.ruleIds) && test.ruleIds.includes(rule.id)))
    .filter((rule) => !["process"].includes(String(rule.status || "")));
  rulesWithoutDirectTests.forEach((rule) => {
    if (!codedRulesWithoutTests.includes(rule)) {
      warnings.push(`${rule.id} ${rule.title} has no direct golden-test reference.`);
    }
  });

  warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAIL ${failure}`));
    console.error(`\nRulebook check failed: ${failures.length} failure(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }

  console.log(`Rulebook check passed: ${rules.length} rules, ${tests.length} golden tests, ${auditRuleIds.length} audit rules.`);
  if (warnings.length) console.log(`Rulebook warnings: ${warnings.length}.`);
}

main();
