# Reproduce the finger-artery plots

Install Python 3.10 or newer, `ffmpeg`/`ffprobe`, and the packages in [`requirements.txt`](requirements.txt). Download `BMode_PW_Doppler.mp4` from the repository's [`datasets-v1` release](https://github.com/mncavieres/ACCmax/releases/tag/datasets-v1) and save it anywhere convenient.

From the repository root, run:

```sh
python3 -m pip install -r scripts/requirements.txt
python3 scripts/plot_finger_doppler.py /path/to/BMode_PW_Doppler.mp4 --output plots/finger
```

The script checks the source video's SHA-256 before extracting a velocity envelope. It then writes two PNG plots, a CSV of approximate time and envelope speed, and a JSON file recording calibration assumptions. The tracked CSV and JSON are in `data/finger/`; the reproduction command writes all four files to `plots/finger/` so the tracked data are not overwritten.

The plot is intended to help develop and inspect ACCmax extraction code. It is not an independently validated ACCmax measurement. For a different spectral export, recalibrate the script to that export's axes and Doppler sign.

To regenerate the six [published figure crops](../figures/README.md) and their overview plot, run `python3 figures/crop_frontiers_figures.py` from the repository root after installing the same Python requirements. The script verifies both original figure checksums and dimensions before cropping. It does not estimate velocity, time, or ACCmax from the published figures.
