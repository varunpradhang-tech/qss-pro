# QSS Pro First Floor Accuracy Diagnostic

## Current Result

- Verified slab shuttering: 338.998 sqm
- Slab review area: 1684.770 sqm
- Verified beam shuttering: 642.899 sqm
- Beam marks reviewed: 382 of 408

These results are not acceptable as final billable quantity.

## Slab Failure Pattern

Review cells: 38

Missing side counts:

- Top side weak/missing: 10
- Bottom side weak/missing: 10
- Left side weak/missing: 8
- Right side weak/missing: 10

This means the issue is not one bad threshold. The reader is not building a full slab topology graph. It is seeing many boundary lines, but it is not yet converting them into complete slab cells like a human quantity surveyor would.

## Beam Failure Pattern

Source beam/size marks: 408

- Verified runs: 9
- Review marks: 382
- Main review reason: no paired stitched beam faces found.

The 9 accepted runs are also unsafe because several runs are 24 m to 51 m long. That means the app is over-stitching long collinear beam faces instead of splitting them bay by bay at grid lines, supports, wall faces, and intersections.

## Required Engine Changes

1. Build a CAD topology graph.
   - Nodes: grid intersections, supports, beam endpoints, wall endpoints, line intersections, cutout corners.
   - Edges: beam faces, wall/support faces, cutout boundaries.
   - Cells: actual slab panels.

2. Add weak-side boundary inference.
   - If a slab has three strong boundaries and one missing side, infer the missing side only when two evidence types agree.
   - Evidence types: adjacent cell boundary, nearby parallel beam/wall face, grid bay dimension, CAD dimension text.

3. Replace long stitched beam pairing with bay-wise beam run building.
   - Start at each beam size text.
   - Extend one bay at a time.
   - Split at grid lines, columns/walls, intersections, cutouts, and size changes.
   - Merge only when both parallel faces continue and size remains same.

4. Use the reference working drawing as a calculation source.
   - Mark P panels and QB beams.
   - Read those marks back.
   - Calculate only verified marked items.

5. Add failure gate.
   - If more than 10% remains review, show verified quantity plus review quantity only.
   - Do not call it final MB quantity.

