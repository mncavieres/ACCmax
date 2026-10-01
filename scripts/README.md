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

## Workbench scripts (Node.js)

These support the browser tool in [`web/`](../web/) and need Node 20 or newer:

- `npm run validate` runs [`validate-synthetic.mjs`](validate-synthetic.mjs), a Monte Carlo comparison of the automated measurement against synthetic waveforms with known ACCmax and AT.
- `npm run samples` runs [`make-samples.mjs`](make-samples.mjs), which writes synthetic CSV, PNG and DICOM examples to a git-ignored `samples/` folder for trying the tool. They are synthetic and not data cases.
- `npm run build` runs [`build-single-file.mjs`](build-single-file.mjs), which bundles the tool into `dist/accmax-workbench.html`.
- [`lib/dicom-writer.mjs`](lib/dicom-writer.mjs) writes minimal DICOM files with ultrasound-region calibration, for tests and samples.
