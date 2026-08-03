# QSS Pro Golden Tests

Golden tests are fixed drawing checks. They stop the app from silently returning a wrong quantity after parser changes.

## Run

From the workspace root:

```powershell
& 'C:\Users\RICPL\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' outputs\quantity-survey-app\golden-test-runner.js
```

The runner starts the local QSS Pro server on `http://127.0.0.1:4175` if it is not already running, extracts quantities from the drawing, then compares the result with `golden-tests.json`.

The runner also reads the app's rule audit. A test fails when the app reports failed rule checks, even if the numeric value is close. This prevents hidden failures such as wrong beam face pairing, missed slab panel closure, or missing cutout deduction.

## Product Rule

Do not call a drawing reader change fixed until this command passes. If it fails, the output is a defect list, not a final quantity.

## Permanent Rule IDs

The permanent rulebook is `qss-rulebook.json`. Every rule has a stable ID such as `QSS-BEAM-003` or `QSS-SLAB-002`.

When a rule is added or corrected, update all three places in the same change:

1. Add or edit the rule in `qss-rulebook.json`.
2. Add the code/audit implementation.
3. Add or update a golden test and include its `ruleIds`.

Run this before accepting the change:

```powershell
.\validate-qss-product.ps1
```

For full drawing extraction checks, run:

```powershell
.\validate-qss-product.ps1 -Golden
```

If a golden test has no `ruleIds`, the rulebook check fails. This prevents a rule from staying only in chat or notes.

## Add A Member

Add one object in `golden-tests.json`:

```json
{
  "id": "trevoc-b6c-final",
  "ruleIds": ["QSS-BEAM-003", "QSS-BEAM-008", "QSS-BEAM-009", "QSS-CAD-004"],
  "drawing": "../../work/trevoc-b1-framing.dxf",
  "itemType": "beam",
  "member": "B6C",
  "mode": "all",
  "expected": {
    "count": 1,
    "widthM": 0.45,
    "depthM": 0.6,
    "slabThicknessM": 0.175,
    "bottomLengthM": 0,
    "sideLengthM": 0,
    "bottomAreaM2": 0,
    "sideAreaM2": 0,
    "totalShutteringM2": 0,
    "grossConcreteM3": 0,
    "mustHaveCadOrGridDimension": true,
    "mustNotNeedReview": true
  }
}
```

Replace the `0` values with manually verified CAD quantities. After that, the app must match those values within tolerance before the test passes.

## Current Status

- `B64` is locked as a passing beam quantity test.
- `B6C` is locked for paired-edge continuation, local slab-panel thickness, and column/support cap deduction.
- `B15` is locked for segmented CAD span reading: `7.000 + 7.350 + 1.500 = 15.850 m`.

For repeated members, prefer `mode: "nearestLabel"` with CAD label coordinates instead of occurrence number. This keeps the test stable even if detector row order changes.
