# QSS Pro Failure Classification

Source drawing: `00.1st Floor Cadd.dwg`

## Gate

- Final allowed: false
- Slab review ratio: 0.546%
- Beam review ratio: 8.525%
- Reason: Review ratio exceeds 5%; output must be verified/review-only, not final MB quantity.
- Slab benchmark minimum passed: false
- Beam benchmark minimum passed: false

## Benchmark Check

- Slab calculated: 2569.797 sqm
- Slab minimum benchmark: 3900 sqm
- Slab shortage against minimum: 1330.203 sqm
- Beam calculated: 1225.909 sqm
- Beam minimum benchmark: 1400 sqm
- Beam shortage against minimum: 174.091 sqm

## Marked Review Items

- Slab review marks: 2
- Beam review marks: 26
- Total review rows: 28

## Failure Types

| Failure type | Count |
|---|---:|
| long stitched beam run unverified | 16 |
| short beam fragment unconfirmed | 4 |
| beam face width mismatch | 3 |
| missing nearby beam face | 3 |
| slab cell review | 2 |

## Detector Fix Priority

| Detector to fix | Count |
|---|---:|
| Bay-wise beam run builder | 20 |
| Beam face pairing | 3 |
| Beam face/support detection | 3 |
| Slab closed-cell boundary detection | 2 |

## Required Rule

The app must not unlock final MB quantities until both slab and beam review ratios are below 5% and the golden tests pass within 40 mm tolerance.
