import sys
from pathlib import Path

import pypdfium2 as pdfium


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: render_pdf_page.py <input.pdf> <output.png>")

    pdf_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pdf = pdfium.PdfDocument(str(pdf_path))
    page = pdf[0]
    bitmap = page.render(scale=3.0, rotation=0)
    image = bitmap.to_pil()
    image.save(out_path)


if __name__ == "__main__":
    main()
