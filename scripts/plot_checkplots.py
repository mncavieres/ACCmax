"""Draw one checkplot per fitted case.

Reads results/cases/*.json written by `node scripts/fit-cases.mjs` and writes
results/checkplots/<case>.png. Each checkplot shows:

  A  the data: the spectral image with the traced envelope, or the velocity
     trace, with the detected upstrokes marked
  B  the stacked beats with the smoothed template and the automatic calipers
     (valley, onset, ACCmax points 1 and 2 with the tangent, peak, AT bracket)
  C  the measured values, calibration status and quality notes
  D  the periodogram, beat timing (O - C) and single-beat values

Usage:  python3 scripts/plot_checkplots.py [case_id ...]
"""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "results" / "cases"
OUT = ROOT / "results" / "checkplots"

BEAT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
EXCLUDED = "#b7c2c8"
INK = "#0f1a20"
INK2 = "#44535c"
MUTED = "#6c7b84"
CALIPER = "#c27400"
ACCENT = "#0b6b7e"
GRID = "#e3e8eb"

plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 9.5,
        "axes.edgecolor": "#aab7bd",
        "axes.labelcolor": INK2,
        "axes.titlesize": 10.5,
        "axes.titleweight": "bold",
        "axes.titlecolor": INK,
        "axes.titlelocation": "left",
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
    }
)


def beat_color(beat: dict, n_included: int) -> str:
    if not beat["included"]:
        return EXCLUDED
    return BEAT_COLORS[beat["index"] % 8] if n_included <= 8 else "#6f8792"


def fmt(x, d=2):
    if x is None:
        return "–"
    out = f"{x:.{d}f}"
    return out[1:] if out.startswith("-") and float(out) == 0 else out


def panel_data(ax, case: dict) -> None:
    res = case["result"]
    beats = res.get("beats", []) if res["ok"] else []
    n_in = sum(b["included"] for b in beats)
    if case["kind"] == "image":
        im = case["image"]
        img = np.asarray(Image.open(ROOT / im["file"]).convert("RGB"))
        ax.imshow(img, interpolation="nearest", aspect="auto")
        ax.grid(False)
        reg = im["region"]
        ax.add_patch(plt.Rectangle((reg["x0"], reg["y0"]), reg["x1"] - reg["x0"], reg["y1"] - reg["y0"], fill=False, ec=ACCENT, lw=1.2, ls="--"))
        xs = reg["x0"] + np.arange(len(case["trace"]["edgeY"]))
        fwd = np.array([np.nan if y is None else y for y in case["trace"]["edgeY"]], float)
        rev = np.array([np.nan if y is None else y for y in case["trace"]["edgeReverseY"]], float)
        ax.plot(xs, rev, color="#43b8cc", lw=0.9, alpha=0.9, label="reverse-flow edge")
        ax.plot(xs, fwd, color="#ffb000", lw=1.3, label="forward envelope (measured)")
        ax.axhline(im["baselineY"], color=ACCENT, lw=0.8, alpha=0.8)
        for b in beats:
            x = reg["x0"] + b["upstroke_s"] / im["secPerPx"]
            ax.plot([x], [reg["y0"] + 4], marker="v", ms=8, color=beat_color(b, n_in), mec="white", mew=1)
        if res["ok"]:
            w0, w1 = res["window_s"]
            ax.axvspan(reg["x0"] + w0 / im["secPerPx"], reg["x0"] + w1 / im["secPerPx"], color=ACCENT, alpha=0.06)
        ax.set_xlim(0, img.shape[1])
        ax.set_ylim(img.shape[0], 0)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.legend(loc="lower right", fontsize=8, framealpha=0.85)
        ax.set_title("A  Spectral display with the traced envelope and detected upstrokes (▼)")
    else:
        t = np.array(case["trace"]["t_s"], float)
        v = np.array(case["trace"]["v_m_s"], float) * 100
        ax.plot(t, v, color=INK, lw=0.7)
        for b in beats:
            ax.plot([b["upstroke_s"]], [np.nanmax(v) * 1.04], marker="v", ms=8, color=beat_color(b, n_in), mec="white", mew=1, clip_on=False)
        if res["ok"]:
            ax.axvspan(*res["window_s"], color=ACCENT, alpha=0.05)
        ax.set_xlim(t.min(), t.max())
        ax.set_xlabel("time (s)")
        ax.set_ylabel("velocity (cm/s)")
        ax.set_title("A  Velocity envelope with the detected upstrokes (▼)")


def panel_stack(ax, case: dict) -> None:
    res = case["result"]
    if not res["ok"]:
        ax.text(0.5, 0.5, "No fit:\n" + textwrap.fill(res["error"], 50), ha="center", va="center", transform=ax.transAxes, color=INK2)
        ax.set_title("B  Stacked beats")
        return
    st = res["stack"]
    tau = np.array(st["tau_s"]) * 1000
    v = np.array(st["v_m_s"]) * 100
    beat = np.array(st["beat"])
    beats = res["beats"]
    n_in = sum(b["included"] for b in beats)
    lm = res["landmarks"]
    tp = res["template"]
    tx_all = (tp["x0"] + tp["dx"] * np.arange(len(tp["v_m_s"]))) * 1000
    lo, hi = tx_all[0], tx_all[-1]  # full cardiac cycle
    for b in sorted(beats, key=lambda q: q["included"]):
        m = (beat == b["index"]) & (tau >= lo) & (tau <= hi)
        if m.any():
            ax.scatter(tau[m], v[m], s=5 if b["included"] else 3, color=beat_color(b, n_in), alpha=0.55 if b["included"] else 0.35, lw=0, zorder=2)
    tp = res["template"]
    tx = (tp["x0"] + tp["dx"] * np.arange(len(tp["v_m_s"]))) * 1000
    tv = np.array([np.nan if q is None else q for q in tp["v_m_s"]], float) * 100
    ax.plot(tx, tv, color="white", lw=4.5, zorder=3)
    ax.plot(tx, tv, color=INK, lw=2.0, zorder=4, label="stacked template")
    if case.get("truthTemplate"):
        tt = case["truthTemplate"]
        ttx = (tt["x0"] + tt["dx"] * np.arange(len(tt["v_m_s"]))) * 1000
        ax.plot(ttx, np.array(tt["v_m_s"]) * 100, color=ACCENT, lw=1.2, ls=(0, (4, 2)), zorder=4, label="true waveform (simulation)")
    acc = lm["acc"]
    slope = res["accmax_m_s2"]  # m/s^2 == (cm/s) per (10 ms)
    # Tangent through the two ACCmax points, from the valley level to the peak level.
    t_a = acc["t1"] + (lm["valley"]["v"] - acc["v1"]) / slope
    t_b = acc["t1"] + (lm["peak"]["v"] - acc["v1"]) / slope
    ax.plot([t_a * 1000 - 8, t_b * 1000 + 8], [(lm["valley"]["v"] - slope * 0.008) * 100, (lm["peak"]["v"] + slope * 0.008) * 100], color=CALIPER, lw=1.4, ls="--", zorder=5, label="ACCmax tangent")
    ax.plot([lm["valley"]["t"] * 1000 - 60, lm["onset"]["t"] * 1000 + 25], [lm["valley"]["v"] * 100] * 2, color=CALIPER, lw=0.8, ls=":", zorder=5)
    ax.plot([lm["valley"]["t"] * 1000], [lm["valley"]["v"] * 100], marker="D", ms=6, mfc="white", mec=INK2, zorder=6)
    pts = [("onset", lm["onset"]["t"], lm["onset"]["v"]), ("1", acc["t1"], acc["v1"]), ("2", acc["t2"], acc["v2"]), ("peak", lm["peak"]["t"], lm["peak"]["v"])]
    for label, t, vv in pts:
        ax.plot([t * 1000], [vv * 100], marker="+", ms=13, mew=2.4, color=CALIPER, zorder=7)
        off = {"onset": (-8, 6, "right"), "1": (8, -12, "left"), "2": (8, -12, "left"), "peak": (8, 6, "left")}[label]
        ax.annotate(label, (t * 1000, vv * 100), xytext=off[:2], textcoords="offset points", ha=off[2], fontsize=9, fontweight="bold", color=INK2, zorder=8)
    ymin, ymax = np.nanmin(tv[(tx >= lo) & (tx <= hi)]), np.nanmax(tv[(tx >= lo) & (tx <= hi)])
    span = ymax - ymin
    yb = ymin - 0.1 * span  # AT bracket below the whole curve
    ax.annotate("", xy=(lm["peak"]["t"] * 1000, yb), xytext=(lm["onset"]["t"] * 1000, yb), arrowprops=dict(arrowstyle="|-|", color=CALIPER, lw=1.4, shrinkA=0, shrinkB=0))
    ax.text(lm["peak"]["t"] * 1000 + 6, yb, f"{case['atLabel']} {res['at_ms']:.0f} ms", va="center", fontsize=10, fontweight="bold", color=INK)
    mid_t = (acc["t1"] + acc["t2"]) / 2 * 1000
    mid_v = (acc["v1"] + acc["v2"]) / 2 * 100
    ax.annotate(f"ACCmax {res['accmax_m_s2']:.2f} m/s²", (mid_t, mid_v), xytext=(-14, 4), textcoords="offset points", ha="right", fontsize=10, fontweight="bold", color=INK)
    ax.set_xlim(lo, hi)
    ax.set_ylim(yb - 0.08 * span, ymax + 0.12 * span)
    ax.set_xlabel("time from the steepest point of the upstroke (ms)")
    ax.set_ylabel("velocity (cm/s)")
    ax.legend(loc="upper right", fontsize=8, framealpha=0.9)
    ax.set_title(f"B  {n_in} beats aligned and stacked over the full cycle, with the automatic calipers")


def panel_numbers(ax, case: dict) -> None:
    ax.axis("off")
    res = case["result"]
    lines = []
    if res["ok"]:
        ci = res.get("ci")
        lines.append(("ACCmax", f"{res['accmax_m_s2']:.2f} m/s²", f"68% {fmt(ci['accmax68'][0])}–{fmt(ci['accmax68'][1])}" if ci else "interval needs ≥ 3 beats"))
        lines.append((case["atLabel"], f"{res['at_ms']:.0f} ms", f"68% {ci['at68_ms'][0]:.0f}–{ci['at68_ms'][1]:.0f} ms" if ci else ""))
        hr_note = f"scanner shows {case['displayedHr_bpm']} bpm" if case.get("displayedHr_bpm") else f"RR variation {100 * (res['rrVariation'] or 0):.0f}%"
        lines.append(("Heart rate", f"{res['hr_bpm']:.0f} bpm", hr_note))
        lines.append(("Peak systolic", f"{fmt(res['psv_cm_s'], 0)} cm/s", f"end-diastolic {fmt(res['edv_cm_s'], 0)} cm/s"))
        lines.append(("Beats used", f"{res['nBeats']} of {len(res['beats'])}", f"smoothing {res['smoothing_ms']:.0f} ms"))
        if res.get("forwardOnly"):
            fo = res["forwardOnly"]
            lines.append(("Forward flow only", f"{fo['accmax_m_s2']:.2f} m/s²", f"{fo['at_ms']:.0f} ms · reverse flow set to zero"))
        if res.get("accmax_display_px_per_px") is not None:
            lines.append(("Display slope", f"{res['accmax_display_px_per_px']:.2f} px/px", "calibration-free"))
        if case.get("truth"):
            tr = case["truth"]
            err = 100 * (res["accmax_m_s2"] - tr["accmax_m_s2"]) / tr["accmax_m_s2"]
            lines.append(("True values", f"{tr['accmax_m_s2']:.2f} m/s²", f"{tr['at_ms']:.0f} ms · ACCmax error {err:+.1f}%, AT error {res['at_ms'] - tr['at_ms']:+.0f} ms"))
    y = 0.98
    ax.text(0, y, "C  Result", fontsize=10.5, fontweight="bold", color=INK, va="top", transform=ax.transAxes)
    y -= 0.1
    for name, value, note in lines:
        big = name in ("ACCmax", case["atLabel"])
        ax.text(0, y, name, fontsize=9, color=INK2, va="top", transform=ax.transAxes)
        ax.text(0.36, y + (0.012 if big else 0), value, fontsize=15 if big else 11, fontweight="bold", color=INK, va="top", transform=ax.transAxes)
        if note:
            ax.text(0.36, y - (0.065 if big else 0.05), note, fontsize=8, color=MUTED, va="top", transform=ax.transAxes)
        y -= 0.15 if big else 0.115
    y -= 0.01
    ax.text(0, y, "Calibration", fontsize=9, color=INK2, va="top", transform=ax.transAxes)
    ax.text(0.36, y, textwrap.fill(case["calibration"], 40), fontsize=8, color=INK, va="top", transform=ax.transAxes)
    y -= 0.04 * (1 + len(textwrap.wrap(case["calibration"], 40))) + 0.02
    notes = [q["message"] for q in res.get("qc") or []] if res["ok"] else [res["error"]]
    if notes:
        ax.text(0, y, "Notes", fontsize=9, color=INK2, va="top", transform=ax.transAxes)
        text = "\n".join("• " + textwrap.fill(n, 64, subsequent_indent="  ") for n in notes[:4])
        ax.text(0.0, y - 0.045, text, fontsize=7.6, color=INK, va="top", transform=ax.transAxes, linespacing=1.25)


def panel_periodogram(ax, case: dict) -> None:
    res = case["result"]
    pg = res.get("periodogram")
    ax.set_title("D1  Periodogram (multi-harmonic Lomb–Scargle)")
    if not pg:
        return
    ax.fill_between(pg["bpm"], pg["power"], color=ACCENT, alpha=0.12, lw=0)
    ax.plot(pg["bpm"], pg["power"], color=ACCENT, lw=1.2)
    if res["ok"]:
        ax.axvline(res["hr_bpm"], color=INK, lw=1)
        ax.text(res["hr_bpm"], max(pg["power"]) * 1.02, f" {res['hr_bpm']:.0f} bpm", fontsize=8.5, fontweight="bold", color=INK, va="bottom")
    if case.get("displayedHr_bpm"):
        ax.axvline(case["displayedHr_bpm"], color=CALIPER, lw=1, ls="--")
    ax.set_xlabel("heart rate (bpm)")
    ax.set_ylabel("power")
    ax.set_ylim(0, max(pg["power"]) * 1.18)


def panel_oc(ax, case: dict) -> None:
    res = case["result"]
    ax.set_title("D2  Beat timing: observed − periodic (O − C)")
    if not res["ok"]:
        return
    beats = [b for b in res["beats"] if b["covered"]]
    n_in = sum(b["included"] for b in res["beats"])
    ax.axhline(0, color="#aab7bd", lw=1)
    ax.plot([b["upstroke_s"] for b in beats], [b["oc_ms"] for b in beats], color=MUTED, lw=0.8, ls=":")
    for b in beats:
        ax.plot([b["upstroke_s"]], [b["oc_ms"]], "o", ms=7, color=beat_color(b, n_in), mec="white", mew=1.2)
    lim = max([10] + [abs(b["oc_ms"]) for b in beats if b["oc_ms"] is not None]) * 1.3
    ax.set_ylim(-lim, lim)
    ax.set_xlabel("upstroke time (s)")
    ax.set_ylabel("O − C (ms)")


def panel_single(ax, case: dict) -> None:
    res = case["result"]
    ax.set_title("D3  Single beats versus the stack")
    if not res["ok"]:
        return
    beats = [b for b in res["beats"] if b["accmax_m_s2"] is not None]
    n_in = sum(b["included"] for b in res["beats"])
    for b in beats:
        ax.plot([b["at_ms"]], [b["accmax_m_s2"]], "o", ms=7, color=beat_color(b, n_in), mec="white", mew=1.2, alpha=1 if b["included"] else 0.6)
    ax.plot([res["at_ms"]], [res["accmax_m_s2"]], marker="*", ms=16, color=INK, mec="white", mew=1, label="stacked")
    if case.get("truth"):
        ax.plot([case["truth"]["at_ms"]], [case["truth"]["accmax_m_s2"]], marker="X", ms=10, color=ACCENT, mec="white", mew=1, label="true value")
    ax.set_xlabel(f"{case['atLabel']} (ms)")
    ax.set_ylabel("ACCmax (m/s²)")
    ax.legend(loc="best", fontsize=8, framealpha=0.9)


def checkplot(path: Path) -> Path:
    case = json.loads(path.read_text())
    case["atLabel"] = case.get("atLabel", "AT")
    W = 15.0  # inches
    left, right = 0.75, 0.25
    inner = W - left - right
    if case["kind"] == "image":
        with Image.open(ROOT / case["image"]["file"]) as im:
            aspect = im.width / im.height
        a_h = min(max(inner / aspect, 1.8), 4.4)
    else:
        a_h = 2.7
    top, gap1, b_h, gap2, d_h, bottom = 1.05, 0.75, 4.5, 0.85, 2.8, 0.95
    H = top + a_h + gap1 + b_h + gap2 + d_h + bottom
    fig = plt.figure(figsize=(W, H), dpi=110)

    def box(x, y_top, w, h):  # inches from the top-left corner -> figure fraction
        return [x / W, 1 - (y_top + h) / H, w / W, h / H]

    y = top
    panel_data(fig.add_axes(box(left, y, inner, a_h)), case)
    y += a_h + gap1
    b_w = inner * 0.64
    panel_stack(fig.add_axes(box(left, y, b_w, b_h)), case)
    panel_numbers(fig.add_axes(box(left + b_w + 0.55, y, inner - b_w - 0.55, b_h)), case)
    y += b_h + gap2
    d_w = (inner - 2 * 0.75) / 3
    panel_periodogram(fig.add_axes(box(left, y, d_w, d_h)), case)
    panel_oc(fig.add_axes(box(left + d_w + 0.75, y, d_w, d_h)), case)
    panel_single(fig.add_axes(box(left + 2 * (d_w + 0.75), y, d_w, d_h)), case)

    tag = {"real": "REAL HUMAN DATA", "simulated": "SIMULATION, TRUE VALUES KNOWN"}[case["group"]]
    fig.text(left / W, 1 - 0.3 / H, case["title"], fontsize=16, fontweight="bold", color=INK, va="top")
    fig.text(left / W, 1 - 0.68 / H, f"{case['subtitle']}   ·   {tag}", fontsize=10, color=INK2, va="top")
    fig.text(1 - right / W, 1 - 0.32 / H, "ACCmax Workbench · automatic fit, no manual input", fontsize=9, color=MUTED, ha="right", va="top")
    foot = f"Source: {case['source'].rstrip('.')}.  Research prototype, not a medical device."
    if case["group"] == "real":
        foot += "  No expert ACCmax reference exists for this case; values are not clinical measurements."
    fig.text(left / W, 0.18 / H, textwrap.fill(foot, 190), fontsize=7.8, color=MUTED, va="bottom")
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{case['id']}.png"
    fig.savefig(out, dpi=110, facecolor="white")
    plt.close(fig)
    return out


ORDER = [
    "finger",
    "anterior_tibial_baseline",
    "anterior_tibial_eecp_1",
    "anterior_tibial_eecp_2",
    "anterior_tibial_eecp_3",
    "brachial_before_eecp",
    "brachial_during_eecp",
    "sim_triphasic",
    "sim_monophasic",
    "sim_irregular",
    "sim_screen",
]


def mini_stack(ax, case: dict) -> None:
    res = case["result"]
    ax.set_title(case["title"], fontsize=9.5, loc="left")
    if not res["ok"]:
        ax.text(0.5, 0.5, "no fit", ha="center", va="center", transform=ax.transAxes)
        return
    lm = res["landmarks"]
    st = res["stack"]
    tau = np.array(st["tau_s"]) * 1000
    v = np.array(st["v_m_s"]) * 100
    inc = {b["index"] for b in res["beats"] if b["included"]}
    m = np.array([b in inc for b in st["beat"]])
    tp0 = res["template"]
    lo = tp0["x0"] * 1000
    hi = (tp0["x0"] + tp0["dx"] * (len(tp0["v_m_s"]) - 1)) * 1000
    sel = m & (tau >= lo) & (tau <= hi)
    ax.scatter(tau[sel], v[sel], s=2, color="#8aa0aa", alpha=0.5, lw=0)
    tp = res["template"]
    tx = (tp["x0"] + tp["dx"] * np.arange(len(tp["v_m_s"]))) * 1000
    tv = np.array([np.nan if q is None else q for q in tp["v_m_s"]], float) * 100
    ax.plot(tx, tv, color=INK, lw=1.6)
    if case.get("truthTemplate"):
        tt = case["truthTemplate"]
        ax.plot((tt["x0"] + tt["dx"] * np.arange(len(tt["v_m_s"]))) * 1000, np.array(tt["v_m_s"]) * 100, color=ACCENT, lw=1.1, ls=(0, (3, 2)))
    acc = lm["acc"]
    slope = res["accmax_m_s2"]
    t_a = acc["t1"] + (lm["valley"]["v"] - acc["v1"]) / slope
    t_b = acc["t1"] + (lm["peak"]["v"] - acc["v1"]) / slope
    ax.plot([t_a * 1000, t_b * 1000], [lm["valley"]["v"] * 100, lm["peak"]["v"] * 100], color=CALIPER, lw=1.1, ls="--")
    for t, vv in [(lm["onset"]["t"], lm["onset"]["v"]), (acc["t1"], acc["v1"]), (acc["t2"], acc["v2"]), (lm["peak"]["t"], lm["peak"]["v"])]:
        ax.plot([t * 1000], [vv * 100], marker="+", ms=9, mew=1.8, color=CALIPER)
    sel_t = (tx >= lo) & (tx <= hi)
    ymin, ymax = np.nanmin(tv[sel_t]), np.nanmax(tv[sel_t])
    span = ymax - ymin
    ax.set_xlim(lo, hi)
    ax.set_ylim(ymin - 0.12 * span, ymax + 0.45 * span)
    text = f"ACCmax {res['accmax_m_s2']:.2f} m/s²\n{case['atLabel']} {res['at_ms']:.0f} ms · {res['hr_bpm']:.0f} bpm · {res['nBeats']} beats"
    if case.get("truth"):
        text += f"\ntrue {case['truth']['accmax_m_s2']:.2f} m/s², {case['truth']['at_ms']:.0f} ms"
    elif case.get("displayedHr_bpm"):
        text += f"\nscanner HR {case['displayedHr_bpm']} bpm"
    ax.text(0.02, 0.97, text, transform=ax.transAxes, va="top", fontsize=8.2, color=INK, linespacing=1.3, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none", alpha=0.85))
    ax.tick_params(labelsize=7.5)
    tag = "real" if case["group"] == "real" else "simulated"
    ax.text(0.98, 0.97, tag, transform=ax.transAxes, ha="right", va="top", fontsize=7.5, color="white", fontweight="bold", bbox=dict(boxstyle="round,pad=0.25", fc=ACCENT if tag == "real" else "#7d6aa8", ec="none"))


def overview(paths: list[Path]) -> Path:
    cases = {p.stem: json.loads(p.read_text()) for p in paths}
    ids = [i for i in ORDER if i in cases] + [i for i in cases if i not in ORDER]
    for c in cases.values():
        c["atLabel"] = c.get("atLabel", "AT")
    cols = 4
    rows = -(-len(ids) // cols)
    fig, axes = plt.subplots(rows, cols, figsize=(16, 3.3 * rows + 1.5), dpi=110)
    fig.subplots_adjust(left=0.04, right=0.99, top=1 - 1.2 / (3.3 * rows + 1.5), bottom=0.55 / (3.3 * rows + 1.5), hspace=0.42, wspace=0.18)
    for ax in axes.flat[len(ids):]:
        ax.axis("off")
    for ax, i in zip(axes.flat, ids):
        mini_stack(ax, cases[i])
    fig.text(0.04, 1 - 0.25 / (3.3 * rows + 1.5), "ACCmax Workbench: automatic fits on every available case", fontsize=15, fontweight="bold", color=INK, va="top")
    fig.text(0.04, 1 - 0.62 / (3.3 * rows + 1.5), textwrap.fill("Full cardiac cycle: stacked beats (grey), smoothed template (black), ACCmax tangent and calipers (amber); dashed blue is the true waveform for simulations. x: ms from the steepest point of the upstroke; y: cm/s, reverse flow negative.", 170), fontsize=9.5, color=INK2, va="top")
    fig.text(0.04, 0.12 / (3.3 * rows + 1.5), "Real cases have no expert ACCmax reference and use approximate or provisional calibrations; their values are not clinical measurements. Research prototype, not a medical device.", fontsize=8.5, color=MUTED, va="bottom")
    out = OUT / "overview.png"
    fig.savefig(out, dpi=110, facecolor="white")
    plt.close(fig)
    return out


def update_readme_table(paths: list[Path]) -> None:
    """Rewrite the results table in results/README.md between its markers."""
    readme = ROOT / "results" / "README.md"
    if not readme.exists():
        return
    cases = {p.stem: json.loads(p.read_text()) for p in paths}
    ids = [i for i in ORDER if i in cases] + [i for i in cases if i not in ORDER]
    rows = [
        "| Case | Data | Heart rate (scanner) | Beats used | ACCmax, m/s² (68% interval) | AT, ms (68% interval) | PSV, cm/s | Checkplot |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for i in ids:
        c = cases[i]
        r = c["result"]
        kind = "real" if c["group"] == "real" else "simulated"
        if not r["ok"]:
            rows.append(f"| {c['title']} | {kind} | – | – | no fit: {r['error']} | | | [png](checkplots/{i}.png) |")
            continue
        ci = r.get("ci")
        acc = f"{r['accmax_m_s2']:.2f}" + (f" ({ci['accmax68'][0]:.2f}–{ci['accmax68'][1]:.2f})" if ci else "")
        at = f"{r['at_ms']:.0f}" + (f" ({ci['at68_ms'][0]:.0f}–{ci['at68_ms'][1]:.0f})" if ci else "")
        if c.get("truth"):
            acc += f"; true {c['truth']['accmax_m_s2']:.2f}"
            at += f"; true {c['truth']['at_ms']:.0f}"
        hr = f"{r['hr_bpm']:.0f}" + (f" ({c['displayedHr_bpm']})" if c.get("displayedHr_bpm") else "")
        beats = f"{r['nBeats']} of {len(r['beats'])}"
        rows.append(f"| {c['title']} | {kind} | {hr} | {beats} | {acc} | {at} | {r['psv_cm_s']:.0f} | [png](checkplots/{i}.png) |")
    text = readme.read_text()
    start, end = "<!-- table:start -->", "<!-- table:end -->"
    if start in text and end in text:
        head, rest = text.split(start, 1)
        _, tail = rest.split(end, 1)
        readme.write_text(head + start + "\n" + "\n".join(rows) + "\n" + end + tail)


def main(argv: list[str]) -> None:
    paths = sorted(CASES.glob("*.json"))
    selected = [p for p in paths if p.stem in argv] if argv else paths
    for p in selected:
        print(checkplot(p).relative_to(ROOT))
    if not argv:
        print(overview(paths).relative_to(ROOT))
        update_readme_table(paths)


if __name__ == "__main__":
    main(sys.argv[1:])
