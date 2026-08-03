import json
import sys

from PIL import Image
import numpy as np


def grouped(indices, gap=3):
    groups = []
    start = None
    prev = None
    for raw in indices:
        value = int(raw)
        if start is None:
            start = value
            prev = value
        elif value <= prev + gap:
            prev = value
        else:
            groups.append((start, prev, (start + prev) // 2))
            start = value
            prev = value
    if start is not None:
        groups.append((start, prev, (start + prev) // 2))
    return groups


def filter_close(values, min_gap=18):
    kept = []
    for value in sorted(values):
        if not kept or value - kept[-1] >= min_gap:
            kept.append(value)
        else:
            kept[-1] = int(round((kept[-1] + value) / 2))
    return kept


def detect_grid(image_path):
    image = Image.open(image_path).convert("L")
    pixels = np.array(image)
    height, width = pixels.shape

    # Consultant PDFs often use grey table strokes, so keep the threshold generous.
    dark = pixels < 175
    row_dark = dark.sum(axis=1)
    col_dark = dark.sum(axis=0)

    horizontal_groups = grouped(np.where(row_dark > width * 0.35)[0])
    horizontal_candidates = []
    for group in horizontal_groups:
        y = group[2]
        best = 0
        current = 0
        start = 0
        best_start = 0
        best_end = 0
        for x, is_dark in enumerate(dark[y, :]):
            if is_dark:
                if current == 0:
                    start = x
                current += 1
                if current > best:
                    best = current
                    best_start = start
                    best_end = x
            else:
                current = 0
        if best > width * 0.35:
            horizontal_candidates.append({"y": y, "start": best_start, "end": best_end, "length": best})

    # Pick the repeated horizontal span. This removes page borders and title-block lines.
    clusters = []
    for candidate in horizontal_candidates:
        matched = None
        for cluster in clusters:
            if abs(candidate["start"] - cluster["start"]) <= 12 and abs(candidate["end"] - cluster["end"]) <= 12:
                matched = cluster
                break
        if matched is None:
            clusters.append(
                {
                    "start": candidate["start"],
                    "end": candidate["end"],
                    "items": [candidate],
                }
            )
        else:
            matched["items"].append(candidate)
            matched["start"] = int(round(sum(item["start"] for item in matched["items"]) / len(matched["items"])))
            matched["end"] = int(round(sum(item["end"] for item in matched["items"]) / len(matched["items"])))

    clusters.sort(key=lambda item: (len(item["items"]), item["end"] - item["start"]), reverse=True)
    main_cluster = clusters[0] if clusters else None
    horizontal = filter_close([item["y"] for item in main_cluster["items"]], min_gap=18) if main_cluster else []

    left = main_cluster["start"] if main_cluster else 0
    right = main_cluster["end"] if main_cluster else width
    top = min(horizontal) if horizontal else 0
    bottom = max(horizontal) if horizontal else height

    vertical_candidates = []
    for x in range(max(0, left - 8), min(width, right + 9)):
        best = 0
        current = 0
        for is_dark in dark[:, x]:
            if is_dark:
                current += 1
                best = max(best, current)
            else:
                current = 0
        if best > max(260, (bottom - top) * 0.70):
            vertical_candidates.append(x)

    vertical = filter_close([group[2] for group in grouped(vertical_candidates)])

    if len(horizontal) >= 2 and len(vertical) >= 2:
        table = {
            "left": vertical[0],
            "top": horizontal[0],
            "right": vertical[-1],
            "bottom": horizontal[-1],
        }
        cells = max(0, len(horizontal) - 1) * max(0, len(vertical) - 1)
    else:
        table = None
        cells = 0

    return {
        "imageWidth": width,
        "imageHeight": height,
        "horizontalLines": horizontal,
        "verticalLines": vertical,
        "table": table,
        "rows": max(0, len(horizontal) - 1),
        "columns": max(0, len(vertical) - 1),
        "cells": cells,
        "confidence": "high" if cells >= 20 else "needs-review",
    }


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: detect_table_grid.py image.png"}))
        return 2
    print(json.dumps(detect_grid(sys.argv[1])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
