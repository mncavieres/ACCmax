# Human limb artery Doppler examples for ACCmax algorithms

Public arterial Doppler material from human limbs, with plots and reproducible processing scripts for exploring automatic maximal systolic acceleration (ACCmax) measurement.

The full source video is attached to the repository's [`datasets-v1` release](https://github.com/mncavieres/ACCmax/releases/tag/datasets-v1). Smaller published figures, their spectral crops, plots, checksums, and provenance are tracked in Git.

| Source | Included material | Best use |
| --- | --- | --- |
| [Human finger artery, Mendeley Data](https://doi.org/10.17632/7g2p7t9tzt.1) | One ~10-second pulsed-wave Doppler video, an approximate digitized envelope, and two plots | Development on a continuous recording |
| [Human anterior tibial artery, Zhang et al.](https://doi.org/10.3389/fcvm.2021.795697) | Four spectral-image crops: baseline and three counterpulsation settings | Visual envelope and beat-detection checks |
| [Human brachial artery, Zhang et al.](https://doi.org/10.3389/fcvm.2021.721140) | Two pulsed-wave spectral-image crops: before and during counterpulsation | Visual checks with an inverted display |

ACCmax is the steepest slope of the systolic velocity upstroke. A physically meaningful result in m/s² requires verified velocity and time calibration, with attention to Doppler sign and angle correction. The published figure crops lack independently verified pixel-to-time calibration, and none of these sources provide expert ACCmax labels or a clinical peripheral arterial disease validation cohort.

The original materials are credited under their [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) licenses. See the [video provenance and checksum](data/README.md), [figure provenance and panel map](figures/README.md), and [video plot reproduction instructions](scripts/README.md).

For Claude working on ACCmax extraction, start with the [real data case guide](CLAUDE.md).

![Digitized spectral envelope of a human finger artery](plots/finger/finger_recording_envelope.png)

![Published human tibial and brachial artery spectral displays](figures/plots/human_limb_spectral_overview.png)

## ACCmax Workbench (automated measurement)

The [`web/`](web/) folder holds a browser tool that measures **ACCmax**, **acceleration time (AT)** and **pedal acceleration time (PAT)** from a spectral Doppler recording. You load a recording, press **Run automatic fit**, and check the result. The software:

1. traces the maximum-velocity envelope (from a DICOM capture, a screenshot, or a CSV), forward and reverse flow both,
2. finds the heart rate with a multi-harmonic Lomb–Scargle periodogram,
3. finds every systolic upstroke and aligns the beats to each other (per-beat O − C correction),
4. stacks the aligned beats over the full cardiac cycle to beat down noise, and smooths the stack,
5. measures ACCmax (steepest tangent), the end-diastolic valley, the onset and the first systolic peak, and reports AT or PAT,
6. gives bootstrap intervals, single-beat values and quality warnings. The fitted points can be dragged to make a manual measurement; both values are kept.

- **Website:** https://mncavieres.github.io/ACCmax/ (published from `main` by [`.github/workflows/pages.yml`](.github/workflows/pages.yml); enable it once under Settings → Pages → Source: GitHub Actions). The examples menu includes the real cases in this repository.
- **Results on every available case:** [results/README.md](results/README.md), with a checkplot per case and an overview.
- **Design, validation and roadmap:** [docs/PLAN.md](docs/PLAN.md).

> Research prototype, not a medical device. Accuracy has been checked on synthetic waveforms with known ground truth; the real cases above run end to end but have no expert ACCmax labels, and their calibrations are approximate or provisional.

### Run it

```bash
npm install           # fonts and esbuild for the builds
npm run serve         # builds _site/ and serves it at http://localhost:8080
npm run build         # dist/accmax-workbench.html: one file, opens from disk, works offline
```

All processing runs in the browser; files are never uploaded, and the page makes no third-party requests.

| Input | Calibration | Notes |
| --- | --- | --- |
| DICOM (`.dcm`) | Automatic, from the Sequence of Ultrasound Regions (0018,6011) | Uncompressed or JPEG baseline. Multi-frame: pick the frame. Doppler angle is read for QC. |
| Screenshot (PNG/JPG) | Manual: draw the display region, click the baseline, one velocity mark and two time marks | Envelope threshold is automatic with a slider override. Coloured overlays are ignored. |
| CSV / TSV / TXT | Columns and units are detected, then editable | Handles `;` separators with decimal commas. A single column needs a sample rate. |

### Reproduce the results

```bash
npm run fit-cases                    # calibrate the figure crops, fit every case (results/summary.json)
pip install -r scripts/requirements.txt
python3 scripts/plot_checkplots.py   # results/checkplots/*.png and the table in results/README.md
npm run validate                     # Monte Carlo accuracy check against synthetic ground truth
npm test                             # unit, end-to-end and real-data regression tests
```

```
web/
  index.html, styles.css, js/app.js
  js/core/   lombscargle.js  smooth.js  landmarks.js  pipeline.js  synthetic.js  stats.js
  js/io/     dicom.js  envelope.js  csv.js
  js/ui/     plot.js  calibrate.js
scripts/     fit-cases.mjs  calibrate-figure-crops.mjs  plot_checkplots.py  validate-synthetic.mjs
             build-site.mjs  build-single-file.mjs  make-samples.mjs  lib/
tests/       core, pipeline, io and real-data tests
figures/calibration.json   provisional calibration of the figure crops
results/                   checkplots and summary
docs/PLAN.md
```

The core (`web/js/core`, `web/js/io`) is plain ES modules with no dependencies, so the same code runs in the browser, in Node tests and in batch scripts.
