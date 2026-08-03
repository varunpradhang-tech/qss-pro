# QSS Pro CAD Reading Rules

These rules are mandatory gates for drawing reading. QSS Pro must classify drawing evidence before calculating quantities. If the evidence is not strong enough, the app must block the calculation instead of guessing.

## Grid Lines Versus Beam Dotted Lines

### Grid Reference Pattern

A dotted/grid reference line may be horizontal or vertical. It is identified by a repeating unequal dash pattern:

- Long dash, short dash, long dash, short dash.
- Grid bubbles or labels such as `E1`, `E2`, `E3`, `H1`, `H2`, etc. near the same alignment.
- Grid dimension text between grid labels strengthens the classification.
- Grid junctions occur where horizontal and vertical grid references cross.

This line is a setting-out/reference line only. It must not be measured as a beam side, slab boundary, wall, or cutout.

### Beam Dotted/Hidden Pattern

A beam dotted/hidden line is identified by repeated dashes of approximately equal length and equal spacing along the beam edge.

- Equal dash length pattern.
- Runs parallel to another beam edge or continuous beam edge.
- Has nearby beam label/size evidence, such as `B1`, `B2`, `BEAM(300X600)`, `(450X650)`, etc.
- Is bounded by supports, walls, columns, or confirmed continuation rules.

This can be used as beam evidence only when other beam gates also pass.

### Hard Rule

If a dashed line has an unequal long-short-long-short pattern and grid labels/dimensions are nearby, classify it as `grid_reference` and exclude it from beam/slab boundary detection.

If a dashed line has equal dash segments but no beam label, size, boundary, or support evidence, classify it as `unverified_hidden_line` and block billable beam quantity.

## Beam-Enclosed Slab Panel Main Rule

For drawings where slab bays are formed by dotted/hidden beam faces, QSS Pro must treat this as the primary slab panel detection method.

### Candidate Rule

Create a slab panel candidate when a closed bay is surrounded by verified beam faces and/or support faces.

The strongest evidence is:

- equal-dash beam hidden-line pattern,
- two parallel beam faces,
- nearby beam size/name text,
- support/column/wall interruptions bridged logically,
- a reasonable slab bay size,
- no grid/dimension/cutout classification on the same boundary.

### Validation Gates

A beam-enclosed slab panel can become a quantity row only when all gates pass:

1. `beam_enclosure_gate`: at least one boundary is a verified beam face, unless a verified slab mark is inside the bay.
2. `structural_body_gate`: the closed face is not a beam body, wall body, column body, dense hatch, or support rectangle.
3. `dimension_gate`: CAD dimension/grid/geometry evidence has no endpoint-aligned conflict beyond tolerance.
4. `cutout_gate`: all internal cutout/open-to-sky/shaft evidence is deducted or marked review.
5. `slab_mark_gate`: slab thickness is read from the slab mark/table/note; if absent, use drawing default only when notes allow it.

### Hard Rule

Do not accept support-only closed rectangles as slab panels.

Do not accept narrow structural strips as slab panels unless a real slab mark is inside them.

Broken beam dotted lines at columns/walls must be bridged when the gap is caused only by the support body.

The app must still mark review when the closed bay fails any validation gate.

## Beam Face Pairing And Support-Gap Bridge

Every beam quantity must start from a verified pair of beam faces.

### Pairing Rule

QSS Pro must pair two beam faces when all are true:

1. The faces are parallel and in the same beam direction.
2. The face-to-face distance matches the beam width from the beam size text within tolerance.
3. The paired faces overlap along the beam run, or can be logically stitched across a support/intersection gap.
4. The beam label/size text sits on or near the paired run.

### Support-Gap Rule

If a beam face breaks at a wall/column/support, QSS Pro must not fail the beam immediately.

It must first stitch the broken face across the support only when:

- the same face line continues after the support,
- the gap is caused by a verified support/intersection,
- the opposite parallel beam face also supports the same run,
- no different beam size or different beam number starts at that support.

### Orientation Fallback

Beam text rotation can be unreliable in some CAD blocks. If the text direction fails to produce a valid face pair, QSS Pro must test the opposite direction before marking review.

### Hard Rule

Do not calculate a beam from one face alone.

If no verified face pair is found after support-gap stitching and orientation fallback, mark `beam face not paired`.

Text from beam detail/schedule areas outside the plan grid must be ignored, not counted as a failed quantity item.

## CAD Dimension Authority Rule

When CAD geometry and CAD dimension text disagree, QSS Pro must decide by evidence strength instead of guessing.

### Evidence Priority

Use CAD dimension as authoritative when all are true:

1. It is a real CAD dimension entity with extension points.
2. Its own extension-point span matches its measured value.
3. Its endpoints align near the detected beam/panel span.
4. The difference looks like a support/beam-face offset, not a random mismatch.
5. The override difference is within the allowed CAD-dimension override limit.
6. The visible dimension text is reliable measurement text, not a scale/detail note.

Use geometry as authoritative when:

- no nearby endpoint-aligned CAD dimension exists, or
- the nearby dimension is unrelated text/detail information, or
- the dimension endpoints do not align with the measured bay/span.

Mark review when:

- the dimension is endpoint-aligned but internally inconsistent,
- CAD dimension and geometry contradict each other beyond tolerance without support-offset explanation,
- multiple dimensions disagree for the same span.

### Hard Rule

If a CAD dimension is selected as authoritative, the quantity must be calculated from that CAD dimension, not only noted in remarks.

Do not use dimension text such as `SCALE 100`, `NTS`, `DETAIL`, `SECTION`, or other drawing notes to override CAD geometry.

If visible dimension text does not match the CAD dimension measurement, it cannot override geometry. It may only match geometry as a cross-check.

## Accepted-Row Loophole Gates

Passing a review ratio gate is not enough. QSS Pro must audit accepted rows also, because accepted-but-wrong rows create silent quantity variation.

### Beam Width Pairing Gate

For every accepted beam:

1. Read beam width from beam size text.
2. Measure distance between paired beam faces.
3. Face distance must match the written beam width within strict tolerance.
4. Variable-width text such as `700/400X600` must be treated as a width range, not as permission to pair any two distant lines.

Hard rule:

If paired face distance differs from written beam width/range beyond tolerance, the beam must be review, not quantity.

### Short Beam Fragment Gate

Very short spans can be real, but they can also be false split fragments caused by grid/support/intersection splitting.

If beam length is below the short-span threshold, QSS Pro may accept it only when a CAD dimension or other strong evidence confirms it.

Hard rule:

Do not accept tiny beam fragments only because two short face segments are paired. Mark review unless dimension evidence confirms the member.

### Slab Overlap Gate

Accepted slab panels must not overlap each other.

If two accepted slab panels materially overlap:

1. Keep the stronger/smaller closed cell only when it is clearly the actual bay.
2. Move the suspected larger merged/duplicate panel to review.
3. Show the overlap area in the review reason.

Hard rule:

Never count overlapping slab panels in final shuttering/concrete totals.

## Slab Cutout / Open-To-Sky Pattern

A large `X` shape inside a slab bay is a cutout/void/open-to-sky signal.

### Cutout Evidence

Classify an area as `slab_cutout_void` when one or more of these are true:

- Two diagonal lines cross inside a bounded slab panel and form a large X.
- The X is inside a lift, shaft, duct, stair, open-to-sky, or cutout zone.
- Nearby text says `CUTOUT`, `CUT OUT`, `OPEN TO SKY`, `OTS`, `SHAFT`, `LIFT`, or similar.
- A closed rectangle/polygon surrounds the X or cutout text.

### Hard Rule

An X-marked cutout is not a slab panel.

For slab shuttering and slab concrete:

1. Read the outer slab panel area.
2. Read all X/open-to-sky/cutout voids inside that panel.
3. Deduct those cutout areas from slab shuttering and slab concrete.
4. Do not create separate billable slab rows for the X/cutout zone.

If the X is visible but the cutout boundary is not closed or dimension evidence is incomplete, mark the slab row as `review needed`; do not ignore the X.

## Repeated Slab Bay Dimension Between Parallel Beams

When two verified beam/support lines are parallel to each other, the clear distance between their inner faces is one repeated slab bay dimension.

This rule works in both directions:

- Two vertical parallel beams/supports define a constant horizontal slab width for every slab panel between them.
- Two horizontal parallel beams/supports define a constant vertical slab length/breadth for every slab panel between them.

### Evidence Required

Use this repeated dimension only when all are true:

1. Both boundaries are verified beams/walls/support faces, not grid reference lines.
2. The two boundaries are parallel within drawing tolerance.
3. The clear face-to-face distance between them is known from CAD geometry or dimension text.
4. The panels between them are in the same bay strip and no intermediate beam/wall/support splits the bay.

### Hard Rule

If the app confirms a repeated bay distance, every slab panel between the same two parallel boundaries must use that same dimension. Do not measure each panel independently with nearby text if that creates inconsistent widths/lengths.

If another beam/wall/support appears between the two boundaries, the bay is split and this rule must restart for each new pair.

## Unnumbered Beam Runs With Size Text Only

Some drawings do not give beam member numbers such as `B1`, `B2`, etc. They may write only `BEAM (300X600)`, `Beam (450X600)`, or similar size text directly on the beam.

QSS Pro may calculate these beams only when the unnumbered beam run is still proven by geometry and size evidence.

### Same Beam Rule

If a beam has no member number, treat it as one continuous beam when all are true:

1. The beam edges continue in the same line from support to support.
2. The beam size text is the same along the run.
3. No different size text appears before the next support/column/wall split.
4. The run is bounded by verified column/wall/support faces.
5. The beam is not a grid reference, dimension line, cutout line, or architectural line.

The app should assign an automatic temporary name such as `AUTO-BEAM-001 (300X600)` for MB/excel output.

For user-facing output, unnumbered beams must be named by grid location so they can be found easily in the drawing.

Example format:

`Beam on H1 B(300X600) / E1 to E5`

Meaning:

- `on H1` = horizontal grid/band location
- `B(300X600)` = beam size
- `E1 to E5` = start and end grid references

If the beam is between grids, use:

`Beam between H1-H2 B(450X600) / E2 to E6`

For vertical beams:

`Beam on E3 B(230X600) / H1 to H5`

### Size Change Rule

If beam size changes midway along the same line, the split must occur at the nearest verified column/wall/support face, not randomly at the text location.

Example:

- Beam starts as `450X600` for the first four panels.
- At column `C5`, the next bay between `C5` and `C6` is marked `600X600`.
- QSS Pro must close the `450X600` beam at column `C5`.
- QSS Pro must start a new beam `AUTO-BEAM-002 (600X600)` from column `C5`.

### Hard Rule

Do not merge two unnumbered beam segments if their size changes.

Do not split an unnumbered beam merely because the size text is repeated. Repeated same-size text on a continuous run confirms the same beam.

## Soil-Filling Hatch Below Beam Bottom

Some drawings show hatched strips around/below beams after slab casting to indicate soil filling below beam bottom. These hatches are often shown inside or beside the beam run and may look like non-structural patterns.

QSS Pro must not reject a beam only because this hatch is present.

### Soil-Fill Beam Evidence

Classify hatch/pattern evidence as `beam_soil_fill_evidence` when all are true:

1. The hatch is long and narrow along the same direction as a beam run.
2. It sits inside or immediately below/around parallel beam faces.
3. Nearby text confirms beam size or identity, such as `B(450X600)`, `BEAM(450X600)`, `B1`, etc.
4. The hatch is not inside an X/open-to-sky/cutout zone.

### Hard Rule

Soil-fill hatch is beam-supporting evidence, not a cutout and not a slab panel.

It may strengthen an unnumbered beam run, but it cannot alone create a billable beam. Beam calculation still needs verified beam faces, size, and support start/end faces.

## Support Face Detection: Columns, Walls, Lift Walls

Support detection must be based on geometry and beam behavior first. Colour can support the decision, but colour is not mandatory.

### Support Types

- Large solid rectangular enclosures around lift/shaft zones are lift walls or shear walls.
- Smaller solid squares or rectangles are columns.
- Long narrow solid rectangles are walls.
- L-shaped solid filled members are walls/columns depending on proportions and location.
- If a beam runs straight, reaches a member, offsets around it, and then continues as the same beam or another beam, that member is a support. Classify it as a column or wall depending on its proportions and length.

### Geometry / Behaviour Evidence

Classify a member as support when one or more of these are true:

- Two parallel dotted beam lines approach the member and stop, break, or change around it.
- Dotted beam lines become solid continuous rectangle/square edges at the member.
- A solid filled rectangle, square, long rectangle, or L-shape lies in the beam path.
- The beam makes an offset around the member and then continues.
- A beam size changes at or immediately after the member.

### Beam Edge Versus Support

Dotted beam lines changing into continuous solid lines can mean the outer side of a beam, but only when the area is not a solid filled member.

If the continuous rectangle/square/L-shape is solid filled, classify it as wall/column/support, not beam edge.

### Face Extraction

For every verified support, QSS Pro must extract:

- left face
- right face
- top face
- bottom face
- centre
- support type: `column`, `wall`, or `lift_wall`

These faces are valid beam start/end points and valid size-change split points.

### Hard Rule

Beam length must snap to support faces, not to text insertion points and not to hatch ends.

If a beam changes size near a support, the size change starts from the support face.

If a beam offsets at a rectangular/square/L-shaped member, the app must treat that member as support evidence, even when the member is not labelled as column/wall and regardless of colour.

## Beam Reading Order

QSS Pro must choose the reading order from the drawing evidence before extracting quantities.

### Numbered Beam Drawings

If beam numbers are present, such as `B1`, `B2`, `B3`, `T2B1`, `B31A`, etc., beam number sequence is the primary reading order.

1. Read horizontal beams first.
2. For horizontal beams, process from top left to top right, then next lower row left to right.
3. Then read vertical beams.
4. For vertical beams, process from top to bottom within each left-to-right grid/column strip.
5. Beam number and physical location must agree; if the same number appears multiple times, group/count repeated members only after matching size and dimensions.
6. Sub-beams such as `B1A`, `B1B`, etc. are separate beams from `B1`.

Grid bands may still be used as evidence, but they must not override beam-number sequence.

### Unnumbered Beam Drawings

If beam numbers are not present and beams are identified only by size text such as `BEAM(300X600)`, `B(450X600)`, etc., QSS Pro must use grid-first reading order.

For drawings with visible grid axes, QSS Pro must read grids before reading unnumbered beams.

### Horizontal Beam Scan

When calculating unnumbered horizontal beams:

1. Read all horizontal grid references such as `H1`, `H2`, `H3`, etc.
2. Sort the grid references by drawing position from top to bottom.
3. Start at `H1`.
4. Read beams above `H1`, left to right.
5. Read beams on/near `H1`, left to right.
6. Read beams between `H1` and `H2`, left to right.
7. Read beams on/near `H2`, left to right.
8. Continue the same pattern until the last H grid.

### Vertical Beam Scan

When calculating unnumbered vertical beams, apply the same rule with vertical grid references such as `E1`, `E2`, `E3`, etc.:

1. Sort E grids left to right.
2. Read beams left of `E1`, top to bottom.
3. Read beams on/near `E1`, top to bottom.
4. Read beams between `E1` and `E2`, top to bottom.
5. Continue until the last E grid.

### Hard Rule

Beam detection must not be random.

If beam numbers exist, every beam candidate must carry beam-number evidence.

If beam numbers do not exist, every beam candidate should carry a grid band reference such as `above H1`, `on H2`, `between H2-H3`, `left of E1`, or `between E3-E4`.

If an unnumbered drawing has grids but a beam candidate cannot be assigned to a grid band, mark it `review needed`.

## Reader Gate

Before beam quantity is calculated, all must be true:

1. Beam member identity is known or a verified beam schedule/zone gives identity.
2. Width and depth are known from same-line text, linked schedule, or inherited same-run rule.
3. Start and end faces are known from supports/walls/columns/beam continuation logic.
4. Dotted/continuous edges are classified as beam edges, not grid references.
5. CAD dimension/grid dimension/geometry evidence agree within tolerance.

If any gate fails, QSS Pro must show `review needed` and return no billable quantity.

## CAD Block And MTEXT Grid Reading

Grid bubbles and grid labels may be nested inside AutoCAD block references instead of appearing as normal top-level text.

QSS Pro must recursively expand INSERT/BLOCK references before grid extraction.

AutoCAD MTEXT formatting must be stripped without deleting the real label. Example: `\pxql;{\W1;E1}` must become `E1`, not blank.

Grid registry must be built from expanded E/H labels and matching grid lines before any unnumbered beam or slab panel calculation.

If the expanded grid registry is incomplete, beam and slab quantities must be blocked/reviewed instead of calculated from fallback pairing.

## Slab Panel Extraction

Closed rectangles alone are not sufficient for slab shuttering because many drawings do not contain closed slab panel rectangles.

Slab panels must be generated from the boundary graph: beam faces, wall/column/support faces, and cutout/open-to-sky boundaries.

A valid slab panel is an enclosed bay between verified boundaries. It should not be created from a beam length line alone.

Cutouts marked by large X shapes, `CUT OUT`, `OPEN TO SKY`, `SHAFT`, or similar notes must be deducted automatically.

If slab panels are generated from grid/beam/wall boundaries, the app must audit panel dimensions against nearby CAD dimension text wherever available.

## Missing Rules Found From First Floor Diagnostic

The first-floor unnumbered-beam drawing still fails after grid reading, block expansion, boundary stitching, and internal panel splitting. The failure pattern is structural, not a single tolerance issue.

### CAD Topology Graph Is Required

QSS Pro must build a topology graph from CAD entities before quantity extraction:

- Nodes: grid intersections, support faces, beam face endpoints, wall face endpoints, cutout corners, and line intersections.
- Edges: beam faces, wall/support faces, slab panel boundaries, and cutout boundaries.
- Cells: closed spaces produced by the topology graph.

Quantity must be calculated from topology cells, not from independent line pairs or stitched lines alone.

### Boundary Inference For Weak Side Panels

When a slab candidate has three strong boundaries and one weak/missing side, QSS Pro must try boundary inference before review:

- Infer the missing side from nearby parallel beam/wall/support faces in the same grid bay.
- Infer from repeated bay dimensions between parallel beams.
- Infer from adjacent slab cells that share the same missing boundary.
- Infer from dimension text crossing the slab bay.
- Accept the inferred boundary only when at least two evidence types agree.

If only one evidence type exists, keep the cell as `review needed`.

### Beam Run Segmentation For Unnumbered Drawings

Unnumbered beams must not be created by pairing two long stitched lines across many grid bays.

For every beam size text such as `BEAM(450X600)`:

1. Find nearest two beam faces on the same local axis.
2. Create a local beam candidate only around the text's grid bay.
3. Extend the beam one bay at a time until:
   - support face stops it,
   - beam size changes,
   - beam face continuity breaks,
   - a cutout/opening interrupts the run,
   - another beam crosses and creates a joint.
4. Split the run at every grid line, column/wall/support face, beam intersection, and size-change point.
5. Merge adjacent spans only when size, alignment, and both parallel faces continue through the joint.

Hard rule: a single unnumbered beam run must not pass through many grid bays just because stitched faces are collinear.

### Marked Drawing Verification Loop

Before final MB quantity, QSS Pro must create a reference working drawing and require the extractor to use its own marks:

- `P1`, `P2`, etc. for slab cells.
- `QB1`, `QB2`, etc. for auto beam runs.
- `REVIEW` labels for incomplete cells/runs.

The calculation engine must read back these marks and calculate only from marked cells/runs that have verified topology.

### Failure Gate

If more than 5% of slab area or beam marks remain in review, QSS Pro must not present the result as final billable quantity. It may present:

- verified quantity,
- review quantity,
- drawing health report,
- reference working drawing.
