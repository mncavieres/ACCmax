#!/usr/bin/env python3
"""Digitize and plot the green spectral envelope in Noel's finger PW Doppler MP4.

This is a screen-digitization demonstration, not a validated ACCmax algorithm.
It uses the visible scale marks in this specific video.  Recalibrate for other
exports, display sizes, or zoom settings.  Requires ffmpeg, numpy, and matplotlib.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "accmax-mpl-cache"))
os.environ.setdefault("XDG_CACHE_HOME", str(Path(tempfile.gettempdir()) / "accmax-xdg-cache"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


EXPECTED_SHA256 = "eec1bb7a676802c2705d656738707151e677b14e0c3c1fe4e91aaa35264362b6"

# Screen coordinates at 1920 x 1080, read from the video's printed axes.
# The 0-mm/s baseline is y=982; -286 mm/s is y=726 (flow is plotted upward).
X0, X1 = 319, 1500
Y0, Y1 = 726, 982
PIXELS_PER_SECOND = 1380.0  # 0.1-s tick marks are ~138 pixels apart.
MM_PER_SECOND_PER_PIXEL = 286.0 / (Y1 - Y0)

# The MP4's playback clock is not the ultrasound time axis.  Across the video,
# the printed left-hand time changes from 0.0 s at playback t=0 to about 8.53 s
# at playback t=10.0 s.  This mapping is approximate (~one display pixel).
ACQUISITION_SECONDS_PER_VIDEO_SECOND = 0.8534
SAMPLE_VIDEO_FPS = 4


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    command = [
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]
    return json.loads(subprocess.check_output(command, text=True))


def decode_crops(path: Path) -> np.ndarray:
    width, height = X1 - X0, Y1 - Y0 + 1
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
        "-vf", f"fps={SAMPLE_VIDEO_FPS},format=rgb24,crop={width}:{height}:{X0}:{Y0}",
        "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]
    raw = subprocess.check_output(command)
    pixels_per_frame = width * height * 3
    if len(raw) % pixels_per_frame:
        raise RuntimeError("Unexpected decoded frame size")
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3)


def trace_envelope(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return velocity (mm/s) and green-signal strength for every x pixel."""
    rgb = frame.astype(np.int16)
    green_excess = rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    # Mask printed horizontal baseline, which is yellow rather than green.
    green_excess[-2:, :] = 0
    y_local = green_excess.argmax(axis=0)
    strength = green_excess[y_local, np.arange(frame.shape[1])]
    y_screen = Y0 + y_local.astype(float)
    velocity_mm_s = (Y1 - y_screen) * MM_PER_SECOND_PER_PIXEL
    velocity_mm_s[strength < 12] = np.nan
    return velocity_mm_s, strength


def digitize(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.arange(X0, X1)
    all_times, all_velocities = [], []
    for frame_number, frame in enumerate(frames):
        velocity, _ = trace_envelope(frame)
        video_time = frame_number / SAMPLE_VIDEO_FPS
        time = (
            ACQUISITION_SECONDS_PER_VIDEO_SECOND * video_time
            + (x - X0) / PIXELS_PER_SECOND
        )
        good = np.isfinite(velocity)
        all_times.append(time[good])
        all_velocities.append(velocity[good])

    times = np.concatenate(all_times)
    velocities = np.concatenate(all_velocities)
    bins = np.rint(times * 1000).astype(np.int32)
    order = np.argsort(bins, kind="stable")
    bins, velocities = bins[order], velocities[order]
    unique_bins, start, count = np.unique(bins, return_index=True, return_counts=True)
    median_velocity = np.array([
        np.median(velocities[i:i + n]) for i, n in zip(start, count, strict=True)
    ])
    # Keep gaps visible rather than interpolating through missing measurements.
    time_grid = np.arange(0, unique_bins[-1] + 1) / 1000
    velocity_grid = np.full(time_grid.shape, np.nan)
    coverage = np.zeros(time_grid.shape, dtype=int)
    velocity_grid[unique_bins] = median_velocity
    coverage[unique_bins] = count
    return time_grid, velocity_grid, coverage


def smooth_nan(values: np.ndarray, window: int = 15) -> np.ndarray:
    finite = np.isfinite(values)
    kernel = np.ones(window)
    numerator = np.convolve(np.where(finite, values, 0), kernel, mode="same")
    denominator = np.convolve(finite.astype(float), kernel, mode="same")
    return np.divide(
        numerator, denominator, out=np.full(values.shape, np.nan), where=denominator > 0
    )


def sample_systolic_peaks(times: np.ndarray, velocity: np.ndarray) -> np.ndarray:
    """Mark prominent peaks only for orientation; no diagnostic classification."""
    smoothed = smooth_nan(velocity, window=21)
    candidates = np.flatnonzero(
        (smoothed[1:-1] >= smoothed[:-2])
        & (smoothed[1:-1] > smoothed[2:])
        & (smoothed[1:-1] > 150)
    ) + 1
    selected = []
    for index in candidates[np.argsort(smoothed[candidates])[::-1]]:
        if all(abs(times[index] - times[other]) >= 0.55 for other in selected):
            selected.append(int(index))
    # Place the display markers at the true pixel-derived crest near each
    # smoothed candidate so they sit on the plotted raw envelope.
    crests = []
    for index in selected:
        lo, hi = max(0, index - 35), min(len(velocity), index + 36)
        window = velocity[lo:hi]
        if np.any(np.isfinite(window)):
            crests.append(lo + int(np.nanargmax(window)))
    return np.array(sorted(crests), dtype=int)


def write_csv(path: Path, times: np.ndarray, velocity: np.ndarray, coverage: np.ndarray) -> None:
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["time_s_approx", "envelope_velocity_mm_s", "contributing_pixels"])
        for t, v, n in zip(times, velocity, coverage, strict=True):
            if np.isfinite(v):
                writer.writerow([f"{t:.3f}", f"{v:.3f}", int(n)])


def plot_recording(path: Path, times: np.ndarray, velocity: np.ndarray, peaks: np.ndarray) -> None:
    fig, ax = plt.subplots(figsize=(13, 4.8))
    fig.subplots_adjust(left=0.07, right=0.99, top=0.9, bottom=0.22)
    ax.plot(times, velocity, color="#116f78", lw=1.15, label="Digitized green envelope")
    ax.scatter(times[peaks], velocity[peaks], s=28, color="#bb5418", zorder=3,
               label="Prominent systolic peaks")
    ax.set(xlim=(0, 9.6), ylim=(0, 300), xlabel="Approximate ultrasound display time (s)",
           ylabel="Envelope speed (mm/s)",
           title="Proper volar digital artery: spectral Doppler envelope")
    ax.grid(alpha=0.25)
    ax.legend(loc="upper right", frameon=False)
    fig.text(0.07, 0.025,
             "Screen-digitized from Noel (2021), Mendeley Data, DOI 10.17632/7g2p7t9tzt.1. "
             "Time/velocity calibration is approximate; peaks are illustrative.",
             fontsize=8, color="#444")
    fig.savefig(path, dpi=180)
    plt.close(fig)


def plot_example_frame(path: Path, frames: np.ndarray) -> None:
    index = min(40, len(frames) - 1)  # ~10.0 s playback, one visible full systolic beat
    frame = frames[index]
    velocity, _ = trace_envelope(frame)
    x = np.arange(X0, X1)
    video_time = index / SAMPLE_VIDEO_FPS
    time = ACQUISITION_SECONDS_PER_VIDEO_SECOND * video_time + (x - X0) / PIXELS_PER_SECOND

    fig, axes = plt.subplots(2, 1, figsize=(12, 7.5), sharex=True,
                             gridspec_kw={"height_ratios": [1.15, 1]})
    fig.subplots_adjust(left=0.08, right=0.99, top=0.92, bottom=0.18, hspace=0.14)
    # The native display has negative velocity upward.  We show its positive
    # magnitude so the digitized trace and plot use one consistent convention.
    axes[0].imshow(frame, extent=[time[0], time[-1], 0, 286], origin="upper",
                   interpolation="nearest", aspect="auto")
    axes[0].plot(time, velocity, color="#f26c4f", lw=1.0, label="Digitized envelope")
    axes[0].set(ylabel="Speed (mm/s)", title="Representative source frame and extracted contour")
    axes[0].legend(loc="upper right", frameon=True, fontsize=8)
    axes[1].plot(time, velocity, color="#116f78", lw=1.3)
    axes[1].set(xlabel="Approximate ultrasound display time (s)",
                ylabel="Envelope speed (mm/s)", ylim=(0, 300))
    axes[1].grid(alpha=0.25)
    fig.text(0.08, 0.025,
             "Single MP4 frame at playback ~10 s. Axes calibrated from printed 0/-286 mm/s "
             "and 0.1-s ticks; this is not a clinical ACCmax measurement.",
             fontsize=8, color="#444")
    fig.savefig(path, dpi=180)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, default=Path("plots"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    checksum = sha256(args.video)
    if checksum != EXPECTED_SHA256:
        raise SystemExit(f"Unexpected SHA-256: {checksum}")
    info = probe(args.video)
    frames = decode_crops(args.video)
    times, velocity, coverage = digitize(frames)
    peaks = sample_systolic_peaks(times, velocity)
    write_csv(args.output / "finger_envelope.csv", times, velocity, coverage)
    plot_recording(args.output / "finger_recording_envelope.png", times, velocity, peaks)
    plot_example_frame(args.output / "finger_example_beat.png", frames)

    metadata = {
        "source_doi": "10.17632/7g2p7t9tzt.1",
        "source_url": "https://data.mendeley.com/datasets/7g2p7t9tzt/1",
        "license": "CC BY 4.0",
        "sha256": checksum,
        "video_bytes": args.video.stat().st_size,
        "video_duration_s": float(info["format"]["duration"]),
        "video_frame_rate": info["streams"][0]["avg_frame_rate"],
        "video_frame_count": int(info["streams"][0]["nb_frames"]),
        "sampled_frames": len(frames),
        "approximate_calibration": {
            "zero_velocity_y_pixel": Y1,
            "minus_286_mm_s_y_pixel": Y0,
            "time_pixels_per_second": PIXELS_PER_SECOND,
            "ultrasound_seconds_per_video_second": ACQUISITION_SECONDS_PER_VIDEO_SECOND,
        },
        "sample_peak_times_s": [round(float(t), 3) for t in times[peaks]],
    }
    (args.output / "finger_metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
