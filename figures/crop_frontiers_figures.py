"""Crop six human limb-artery spectral displays from two Frontiers figures.

The source images are published figure composites, not raw DICOM or cine loops.
All crops preserve the original pixels and on-screen velocity/sweep annotations.
No time or velocity axis is inferred or redrawn.

Usage: python3 crop_frontiers_figures.py
"""

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ORIGINALS = HERE / "originals"
CROPS = HERE / "crops"
PLOTS = HERE / "plots"

SOURCES = {
    "anterior_tibial": {
        "file": "anterior_tibial_eecp_figure2.webp",
        "url": "https://www.frontiersin.org/files/Articles/795697/xml-images/fcvm-08-795697-g0002.webp",
        "article": "https://doi.org/10.3389/fcvm.2021.795697",
        "citation": "Zhang et al., Frontiers in Cardiovascular Medicine 8:795697 (2021), Figure 2",
        "artery": "Human anterior tibial artery",
        "expected_size": [1535, 1749],
        "expected_sha256": "ea06302d7cd0da330766d473794dbd39bca390fc1d6b28e70de990bb02f889dc",
        "panels": [
            ("baseline", [0, 0, 1535, 378]),
            ("eecp_3", [0, 378, 1535, 867]),
            ("eecp_1", [0, 867, 1535, 1292]),
            ("eecp_2", [0, 1292, 1535, 1749]),
        ],
    },
    "brachial": {
        "file": "brachial_eecp_figure2.webp",
        "url": "https://www.frontiersin.org/files/Articles/721140/xml-images/fcvm-08-721140-g0002.webp",
        "article": "https://doi.org/10.3389/fcvm.2021.721140",
        "citation": "Zhang et al., Frontiers in Cardiovascular Medicine 8:721140 (2021), Figure 2",
        "artery": "Human right brachial artery",
        "expected_size": [945, 1321],
        "expected_sha256": "5c9acc7c2e9cc0372cedac3416c2311b369568e5e817c3dc2b1cd3aca0deb3b9",
        "panels": [
            ("before_eecp", [5, 378, 945, 658]),
            ("during_eecp", [5, 1024, 945, 1321]),
        ],
    },
}


def fnt(size):
    for name in ("DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main():
    CROPS.mkdir(exist_ok=True)
    PLOTS.mkdir(exist_ok=True)
    manifest = {"license": "CC BY 4.0", "type": "published-figure-crops", "sources": {}}
    card_w, card_h = 790, 365
    overview = Image.new("RGB", (2 * card_w + 60, 3 * card_h + 175), "#10151d")
    draw = ImageDraw.Draw(overview)
    draw.text((30, 22), "Human limb artery Doppler: published figure crops", font=fnt(28), fill="white")
    draw.text((30, 60), "Visible spectra only · no inferred ACCmax or pixel-to-time calibration", font=fnt(18), fill="#b9c7d8")
    idx = 0
    for key, info in SOURCES.items():
        path = ORIGINALS / info["file"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != info["expected_sha256"]:
            raise ValueError(f"Unexpected source image hash: {path}")
        im = Image.open(path).convert("RGB")
        if list(im.size) != info["expected_size"]:
            raise ValueError(f"Unexpected source image dimensions: {path}")
        source = {k: v for k, v in info.items() if k != "panels"}
        source["crops"] = []
        for label, box in info["panels"]:
            name = f"{key}_{label}.png"
            crop = im.crop(tuple(box))
            crop.save(CROPS / name, optimize=True)
            source["crops"].append({"file": name, "source_box_xyxy": box, "dimensions": list(crop.size)})
            x = 30 + (idx % 2) * card_w
            y = 112 + (idx // 2) * card_h
            display_label = label.replace("_", " ").replace("eecp", "EECP")
            draw.text((x, y), f"{info['artery']} · {display_label}", font=fnt(20), fill="white")
            view = crop.copy()
            view.thumbnail((card_w - 26, card_h - 56), Image.Resampling.LANCZOS)
            overview.paste(view, (x, y + 34))
            draw.rectangle((x, y + 34, x + view.width - 1, y + 33 + view.height), outline="#7a8796")
            idx += 1
        manifest["sources"][key] = source
    draw.text((30, overview.height - 63), "Source: Zhang et al., Frontiers in Cardiovascular Medicine (2021), Figures 2; CC BY 4.0", font=fnt(16), fill="#b9c7d8")
    draw.text((30, overview.height - 37), "DOI: 10.3389/fcvm.2021.795697 (tibial) · 10.3389/fcvm.2021.721140 (brachial)", font=fnt(16), fill="#b9c7d8")
    overview.save(PLOTS / "human_limb_spectral_overview.png", optimize=True)
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Made {idx} source-pixel crops and one overview.")


if __name__ == "__main__":
    main()
