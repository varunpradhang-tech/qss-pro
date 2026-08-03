# QSS Pro Accuracy Loophole Audit

Source drawing: `00.1st Floor Cadd.dwg`

## Why This Audit Was Needed

The previous review gate passed, but the quantity still had more than acceptable variation. That means the main issue was not only failed review rows. The hidden issue was accepted rows that were still unsafe.

## Loopholes Found And Corrected

### 1. Unsafe CAD Dimension Override

Problem:

- The app accepted CAD dimensions as authoritative even when the visible text was not a real measurement, for example `SCALE 100`.
- Some dimensions overrode geometry by several hundred millimetres.

Correction:

- CAD dimension can override geometry only when extension points, visible text, and measured value agree.
- `SCALE`, `NTS`, `DETAIL`, `SECTION`, etc. cannot override geometry.
- If visible text does not match CAD measurement, the dimension is not authoritative.

### 2. Wrong Beam Face Pair Accepted

Problem:

- Beam faces were accepted even when face-to-face distance differed from beam width by 150 mm to 370 mm.
- This means the app could pair the wrong two lines and still calculate quantity.

Correction:

- Beam face distance must match beam width/range within strict tolerance.
- Variable width text like `700/400X600` is treated as a width range.
- Width mismatch beams now go to review instead of final quantity.

### 3. Tiny Beam Fragment Accepted

Problem:

- Very short pieces like 62 mm, 128 mm, 219 mm, etc. were accepted as beams.
- Many are likely split fragments caused by grid/support/intersection splitting.

Correction:

- Very short beam spans need CAD dimension confirmation.
- Without confirmation they are marked review.

### 4. Overlapping Slab Panels Counted

Problem:

- 3 accepted slab panels overlapped other slab panels.
- Overlap creates double-counted shuttering/concrete.

Correction:

- Accepted slab panels cannot materially overlap.
- Larger suspected merged/duplicate panels now move to review.

## Current Result After Corrections

- Final allowed: `false`
- Slab accepted panels: `87`
- Slab review cells: `3`
- Slab accepted shuttering: `2452.614 sqm`
- Slab review area: `162.771 sqm`
- Beam accepted rows: `213`
- Beam review rows: `92`
- Beam accepted shuttering: `959.214 sqm`
- Slab review ratio: `6.224%`
- Beam review ratio: `30.164%`

## Meaning

The app is now safer because it no longer hides wrong accepted rows inside final quantity.

Next work must focus on reducing beam review rows by improving beam face pairing, not by loosening tolerance.
