import json
import re
import sys


def clean_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "Usage: extract_pdf_evidence.py file.pdf"}))
        return 2

    pdf_path = sys.argv[1]
    try:
        import pdfplumber
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"pdfplumber unavailable: {exc}"}))
        return 1

    pages = []
    text_items = []
    line_count = 0
    rect_count = 0
    curve_count = 0

    with pdfplumber.open(pdf_path) as pdf:
        for page_index, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(x_tolerance=2, y_tolerance=2, keep_blank_chars=False) or []
            page_text_items = []
            for word in words:
                text = clean_text(word.get("text", ""))
                if not text:
                    continue
                item = {
                    "page": page_index,
                    "text": text,
                    "x": round(float(word.get("x0", 0)), 3),
                    "y": round(float(word.get("top", 0)), 3),
                    "x2": round(float(word.get("x1", 0)), 3),
                    "y2": round(float(word.get("bottom", 0)), 3),
                }
                page_text_items.append(item)
                if len(text_items) < 2000:
                    text_items.append(item)

            page_lines = page.lines or []
            page_rects = page.rects or []
            page_curves = page.curves or []
            line_count += len(page_lines)
            rect_count += len(page_rects)
            curve_count += len(page_curves)
            pages.append(
                {
                    "page": page_index,
                    "width": round(float(page.width), 3),
                    "height": round(float(page.height), 3),
                    "wordCount": len(page_text_items),
                    "lineCount": len(page_lines),
                    "rectCount": len(page_rects),
                    "curveCount": len(page_curves),
                }
            )

    print(
        json.dumps(
            {
                "ok": True,
                "pages": pages,
                "textItems": text_items,
                "lineCount": line_count,
                "rectCount": rect_count,
                "curveCount": curve_count,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
