# QSS Pro MVP

This is the first working step for QSS Pro, a rule-based quantity surveying software app.

## Current Workflow

1. Select drawing format: PDF, DXF, DWG, or image.
2. Upload only drawings that already have:
   - Grid lines marked.
   - Grid-to-grid dimensions marked in the X axis.
   - Grid-to-grid dimensions marked in the Y axis.
3. Click **Read grid dimensions**.
4. Select quantity using dependent dropdowns:
   - Structural drawing: `Raft`, `Column`, `Beam`, `Slab`, then `Concrete`, `Shuttering`, or `Steel`.
   - Architectural drawing: `Wall work`, `Surface finish`, `Floor work`, then `Brickwork`, `Plaster`, `Paint`, or `Flooring`.
5. Select the report type: total, member-wise, floor-wise, or room-wise.
6. Export an Excel-compatible CSV.

The intended production workflow has no manual scale marking after upload. Drawing preparation happens before upload, and the app reads the marked grid dimensions.

## Access Levels

- Free users can read total quantity only.
- Premium users can view member-wise, floor-wise, and room-wise quantities.
- Premium users can export Excel-compatible CSV with length, breadth, height, diameter, spacing, number, and calculated quantity.

## Store Preparation

- Store listing draft: `store-listing.md`
- Play Store and Apple App Store publishing steps: `publishing-guide.md`
- Basic web app manifest: `manifest.json`
- Draft app icon: `icon.svg`

## Quantity Rules Included

- Column concrete
- Column shuttering
- Column steel BBS
- Beam concrete
- Beam shuttering
- Beam steel BBS
- Slab concrete
- Slab shuttering
- Slab steel
- Steel BBS
- Raft concrete
- Raft shuttering
- Raft steel
- Brickwork / blockwork
- Plaster
- Paint
- Flooring

## Measurement Basis

- Civil quantities should follow applicable IS 1200 mode of measurement.
- CAD reader classification rules are documented in `cad-reading-rules.md`. Grid reference dash patterns must be separated from beam hidden/dotted edge patterns before any beam or slab quantity is calculated.
- Reinforcement BBS should use bar mark, diameter, cutting length, number of bars, and unit weight `d^2/162 kg/m`.
- Reinforcement detailing/BBS basis should account for IS 2502/SP 34 practices and RCC references from IS 456.
- Raft concrete is measured in cubic metre.
- Raft shuttering is measured as exposed edge/perimeter formwork in square metre.
- Raft steel is measured in kg from bar diameter, spacing, layers, and cutting length.
- Beam shuttering must be split into bottom area and side area, with column/joint deductions and slab thickness deduction for exposed side depth.
- Slab thickness must be read from slab marks such as `S1`, `S2`, `S3`, `S4` and their index/schedule table in the framing drawing.
- Framing plan and beam details may be in the same drawing or separate drawings; QSS Pro must read them separately.
- Column height can be automatic from drawings or manually entered. Automatic mode supports either floor-wise column layouts or one foundation column layout plus floor-wise column detail sheets. It requires column location/mark, lower and upper TOS levels, beam depth resting on the column, and column reduction/size information from detail sheets.
- Column schedule sheets can be uploaded as multiple files. QSS Pro must read them one by one and merge them into one column schedule database.
- Column concrete and shuttering must separately show main column quantity up to beam bottom and column cap quantity from beam bottom to slab top. Column cap shuttering is measured only on exposed cap faces/perimeter not already covered by beam side shuttering. Free totals and Premium Excel output both include the column cap quantity separately.

## Next Build Steps

1. Build the PDF vector/text parser for AutoCAD-exported PDFs.
2. Build the DXF entity parser for grid lines, dimension text, columns, beams, walls, openings, and labels.
3. Add reinforcement extraction for bar marks, dia, spacing, cutting length, laps, bends, hooks, and layers.
4. Convert detected drawing entities directly into quantity rows and steel BBS rows.
5. Add full Excel BOQ export with formulas and separate summary/detail sheets.
