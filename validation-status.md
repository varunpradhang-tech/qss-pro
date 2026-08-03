# QSS Pro Validation Status

Last updated: 2026-07-10

## Why The Same Problems Kept Returning

The app had rules spread across multiple paths:

- direct beam extractor,
- topology fallback,
- slab boundary graph,
- reference drawing marker,
- reference drawing read-back,
- UI/download packaging.

Because these paths were not all checked by one mandatory gate, a rule could work in one test path and still be skipped in the app path used by the uploaded drawing.

## New Rule

Do not call a quantity-reader change fixed unless this command passes:

```powershell
powershell -ExecutionPolicy Bypass -File .\validate-qss-product.ps1
```

For full golden drawing extraction:

```powershell
powershell -ExecutionPolicy Bypass -File .\validate-qss-product.ps1 -Golden
```

## Current Result

Fast validation now stops correctly at the first real failing gate.

Current blocker:

- `work\reference-readback.test.mjs`
- P-panel marks found in reference drawing: `157`
- P-panel marks mapped back to closed CAD faces: `141`
- Unmapped P-panel marks: `16`

This means slab panel marking/read-back is still not production-ready. The app must not present slab quantity as final when reference P marks cannot be read back into closed slab cells.

## Immediate Engineering Priority

Fix reference read-back and slab cell closure before adding more UI/features:

1. Every P-panel mark must map to exactly one closed CAD face.
2. No P-panel mark may sit on a beam, wall, column, section/detail sketch, or outside a slab bay.
3. Closed panel polyline must be the calculation boundary, not only a visual mark.
4. Panel sequence must be left-to-right and top-to-bottom.
5. The app must block final quantity if mapped panel count is less than marked panel count.

## Beam Rule Gate

Beam rules must also be validated through the same command:

- existing B1/B2 names must be preserved,
- QB/BR labels must not be added to named-beam drawings,
- continuous same-name beams must be one member with internal span details,
- paired beam faces must match written beam width,
- dotted/hidden side deducts slab thickness,
- continuous/elevation side is full height,
- column cap inclusion/exclusion must work for both concrete and shuttering.
