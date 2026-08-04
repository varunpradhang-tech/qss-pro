# QSS Pro Rule Recovery Backlog

Purpose: recover rules finalized in chat/CAD diagnostics but not yet fully enforced by the app.

Rule is not considered complete until all four are true:

1. Rule exists in `qss-rulebook.json` with a stable `QSS-...` ID.
2. Production code references/enforces the same rule ID.
3. `golden-tests.json` has at least one direct test for that rule ID.
4. `validate-qss-product.ps1` and the golden extraction test pass.

## Immediate Missing / Weak Rules

| Priority | Rule ID | Finalized rule | Current status | What must be updated now |
| --- | --- | --- | --- | --- |
| P0 | QSS-CAD-003 | If one CAD file contains framing plan, slab profile, beam details, and sections, only the framing plan region is measured for beam/slab shuttering and concrete. Other regions are linked references only. | Rulebook says documented-pending-full-code. | Add framing-region classifier, reject section/profile geometry from measured rows, add golden test with combined drawing. |
| P0 | QSS-BEAM-003 | Same beam name and same size continuing through slabs/columns/walls is one physical beam, not one row per panel/span. | Coded-audited but field behavior still fails on B1/B2/B11 cases. | Add accepted-row audit that forbids duplicate same-name same-line rows unless physical beam instances differ by location and dimensions. |
| P0 | QSS-BEAM-009 | Wall/column/support faces stop a beam only when beam does not continue. If cap excluded, wall/column/support width is deducted from bottom and side lengths. | Coded-audited but field behavior still fails. | Add final quantity audit: no beam bottom/sides may pass through solid support faces when caps are excluded. |
| P0 | QSS-SLAB-001 | Slab panels are closed structural cells bounded by beam/wall/column/support/cutout faces, not random closed rectangles or small local cells. | Coded-audited but panel coverage still failing. | Replace quantity acceptance with topology/read-back cell closure; no final slab total if P marks do not map to real closed faces. |
| P0 | QSS-SLAB-002 | Reference drawing must contain real verified slab panel evidence per accepted slab panel, label inside the panel, and quantity must read back from that evidence. | Coded-audited but field behavior still misses slab labels. | Make verified slab read-back mandatory before MB rows; every row must link to written CAD dimensions or a verified boundary handle/id. |
| P0 | QSS-SLAB-006 | Panels between the same two verified parallel beam/support faces share the same width/breadth in that direction unless another boundary splits the bay. | Rulebook says documented-pending-full-code. | Implement repeated bay dimension registry in both X and Y; add tests from P2/P3/P4 and P27/P28/P29 examples. |
| P0 | QSS-SLAB-007 | Slab panel dimensions and reference dimension lines are taken through the panel center, not along beam edge or support offset. | Rulebook says documented-pending-full-code. | Add centerline measurement pass and compare against boundary-face measurement; font/dimension labels placed inside panel without overlapping beams. |
| P1 | QSS-BEAM-008 | Beam side shuttering uses adjacent slab thickness panel by panel. If two sides/segments have different slab thickness, split side rows or state average deduction in remarks. | Coded-audited but field behavior still weak. | Add per-side segment rows in Excel for mixed slab thickness; remarks must show slab marks used. |
| P1 | QSS-BEAM-010 | Column cap included/excluded option applies to beam shuttering and beam concrete. | Rulebook says documented-pending-full-code. | UI and calculation must expose cap mode for shuttering too; excluded mode deducts support/cap portions. |
| P1 | QSS-BEAM-011 | Beam MB rows must be ordered horizontal beams first in beam number sequence, then vertical beams; not random extraction order. | Rulebook says documented-pending-full-code; no direct golden test. | Sort/group final MB rows by member identity, orientation, and location after de-duplication. |
| P1 | QSS-SLAB-005 | Slab panel numbering is left-to-right, top-to-bottom and never random. | Rulebook says documented-pending-full-code; no direct golden test. | Sort verified slab cells by top-to-bottom rows, then left-to-right inside each row before assigning P numbers. |
| P1 | QSS-SLAB-008 | Minor wall/column offsets are handled intentionally: either ignored for rectangular gross panel where rule says so, or deducted when closed offset/cutout evidence says so. | Rulebook says documented-pending-full-code. | Add offset classification: gross-rectangle mode vs deduction mode; require remarks. |

## Rules Present In `cad-reading-rules.md` But Needing Stronger Rulebook/Test Coverage

| Priority | Proposed ID | Finalized rule | Current gap | What must happen |
| --- | --- | --- | --- | --- |
| P0 | QSS-CAD-005 | Grid dotted lines and beam dotted lines are different: grid lines have unequal long-short dash pattern and grid labels; beam hidden lines have equal dashes and paired beam evidence. | Present in `cad-reading-rules.md`; not a direct rulebook ID. | Add rulebook entry and golden tests for grid-vs-beam false positives. |
| P0 | QSS-QA-004 | Accepted rows must also be audited. Passing review ratio is not enough if accepted rows have impossible beam widths, overlap, tiny fragments, or duplicate same-name beams. | Present in `cad-reading-rules.md`; scattered in code. | Add final accepted-row loophole gate before totals/Excel. |
| P0 | QSS-SLAB-009 | CAD topology graph must create nodes, edges, and closed faces before slab quantity. | Present in `cad-reading-rules.md`; not explicit rulebook ID. | Promote to rulebook and make topology cell count/coverage a blocking gate. |
| P0 | QSS-SLAB-010 | Weak-side slab boundary may be inferred only when at least two evidence types agree. | Present in `cad-reading-rules.md`; not explicit rulebook ID. | Add inference confidence score and golden tests for missing-side panels. |
| P1 | QSS-BEAM-012 | Soil-filling hatch below beam bottom is beam-supporting evidence, not slab/cutout evidence. | Present in `cad-reading-rules.md`; not explicit rulebook ID. | Add rulebook entry and test using soil-fill hatch drawing. |
| P1 | QSS-BEAM-013 | Unnumbered beam run must be local bay-wise, not one long stitched beam through many grid bays. | Partly covered by QSS-BEAM-006, but no direct golden test. | Add direct golden test and accepted-row audit. |

## How To Recover More Old Chat Rules

1. Search old notes/screenshots for phrases like `must`, `should`, `rule`, `actual`, `incorrect`, `deduct`, `same beam`, `panel`, `cutout`, and `column cap`.
2. For every found rule, add one row here first.
3. If it already exists in `qss-rulebook.json`, link the existing ID.
4. If it does not exist, create a new `QSS-...` rule ID.
5. Add one golden test from the exact drawing/member where the rule was proven.
6. Only then update code.

## Audit Commands

Run normal product validation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\validate-qss-product.ps1
```

Find rulebook rules that are not fully coded:

```powershell
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('outputs/quantity-survey-app/qss-rulebook.json','utf8')); for (const x of r.rules||[]) if(!/^coded/.test(x.status||'')) console.log(x.id+' | '+x.status+' | '+x.title)"
```

Find rulebook rules without direct golden-test coverage:

```powershell
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('outputs/quantity-survey-app/qss-rulebook.json','utf8')); const tests=JSON.parse(fs.readFileSync('outputs/quantity-survey-app/golden-tests.json','utf8')); const covered=new Set(); for (const t of tests.tests||tests||[]) for (const id of t.ruleIds||[]) covered.add(id); for (const x of r.rules||[]) if(!covered.has(x.id)) console.log(x.id+' | '+x.title+' | '+x.status)"
```
