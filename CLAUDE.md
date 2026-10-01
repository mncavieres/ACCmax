# ACCmax: real human limb artery cases

Use this file as the starting point when developing or checking automatic maximal systolic acceleration (ACCmax) extraction in this repository. The included examples are **arterial Doppler measurements from human limbs**. Keep the full video, derived values, and published figure crops distinct when evaluating an algorithm.

| Case | Where to find it | Useful for | Important limit |
| --- | --- | --- | --- |
| **Finger PW video:** left forefinger proper volar digital artery, one healthy volunteer | [Original MP4 in the `datasets-v1` release](https://github.com/mncavieres/ACCmax/releases/download/datasets-v1/BMode_PW_Doppler.mp4); [`data/finger/finger_envelope.csv`](data/finger/finger_envelope.csv); [`plots/finger/`](plots/finger/) | Continuous spectral-display segmentation, beat selection, systolic-upstroke detection | The CSV is an approximate digitization of a compressed screen recording. No expert ACCmax annotation or PAD diagnosis. |
| **Anterior tibial spectra:** baseline and three enhanced external counterpulsation settings | [Spectral crops](figures/crops/) and [overview](figures/plots/human_limb_spectral_overview.png) | Testing envelope and beat detection on real lower-limb spectral images; start with [`anterior_tibial_baseline.png`](figures/crops/anterior_tibial_baseline.png) | Four panels from a published figure, not four independent recordings. Pixel-to-time calibration is unverified; pulsed-wave mode is not explicitly identified in the source figure. |
| **Brachial PW spectra:** right brachial artery before and during counterpulsation | [Spectral crops](figures/crops/) and [overview](figures/plots/human_limb_spectral_overview.png) | Testing baseline detection and an inverted spectral display | Two static panels from one published figure. The pictured person's CAD/control group is not identified; pixel-to-time calibration is unverified. |

## Before calculating ACCmax

1. Read [`data/README.md`](data/README.md) and [`figures/README.md`](figures/README.md) for source citations, CC BY attribution, checksums, panel mapping, and known limitations.
2. For the continuous recording, download the release MP4 to `data/raw/BMode_PW_Doppler.mp4` (the `raw/` directory is ignored by Git). Its SHA-256 must be `eec1bb7a676802c2705d656738707151e677b14e0c3c1fe4e91aaa35264362b6`. The tracked source checksums are in [`data/SHA256SUMS`](data/SHA256SUMS).
3. Use [`scripts/plot_finger_doppler.py`](scripts/plot_finger_doppler.py) and [`scripts/README.md`](scripts/README.md) to inspect or regenerate the finger envelope and plots. Use [`figures/crop_frontiers_figures.py`](figures/crop_frontiers_figures.py) to regenerate the six static crops from the two original journal figures.
4. Treat ACCmax as the steepest systolic upstroke slope of a velocity-time envelope, in m/s² only after velocity and time scales, flow direction, and Doppler angle correction have been verified. The existing CSV, plots, and figure crops are **not** numerical ACCmax ground truth. Report image or pixel-level results separately from clinically calibrated ACCmax values.

Use only real human limb arterial measurements as data cases in this repository. Preserve each source's attribution and avoid treating repeated frames or figure panels as independent subjects. These examples support algorithm prototyping; they do not establish PAD diagnostic performance or clinical thresholds.
