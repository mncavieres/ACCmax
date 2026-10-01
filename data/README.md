# Data sources and provenance

This folder documents one **real pulsed-wave Doppler video of a human limb artery**. The original video is attached to the [`datasets-v1` release](https://github.com/mncavieres/ACCmax/releases/tag/datasets-v1); its derived envelope and plots are tracked in Git. Separately, [`figures/`](../figures/README.md) contains six static spectral-image crops from published human tibial and brachial artery figures.

## Finger artery recording

- **Source:** Christophe Noel (2021), *B-mode cineloop and Pulsed Wave Doppler of the proper volar digital artery*, Mendeley Data, version 1, [DOI 10.17632/7g2p7t9tzt.1](https://doi.org/10.17632/7g2p7t9tzt.1).
- **License:** [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The original recording is redistributed with source credit; this repository's plots and digitized values are modifications of that recording.
- **Measurement:** Left forefinger proper volar digital artery of a healthy 25-year-old volunteer. The source reports a probe on the medial forefinger near the distal interphalangeal joint, with a 50 MHz ultra-high-frequency transducer on a Vevo MD system.
- **Original download:** `BMode_PW_Doppler.mp4`, 24,826,889 bytes, SHA-256 `eec1bb7a676802c2705d656738707151e677b14e0c3c1fe4e91aaa35264362b6`. This matches the checksum published by Mendeley Data. The video is 1920 × 1080, 622 frames, about 10.38 seconds.
- **Derived files:** [`finger_envelope.csv`](finger/finger_envelope.csv), [`finger_metadata.json`](finger/finger_metadata.json), [whole-recording plot](../plots/finger/finger_recording_envelope.png), and [one-frame plot](../plots/finger/finger_example_beat.png).

Machine-readable source checksums are in [`SHA256SUMS`](SHA256SUMS). If the release MP4 is saved in the repository root, run `shasum -a 256 -c data/SHA256SUMS` from that root to check it and the two tracked source figures.

The CSV is an **approximate screen digitization**, not exported scanner velocity samples. The script traces the green spectral envelope. It estimates velocity using the visible 0 and −286 mm/s scale marks and time using 0.1-second ticks. It samples 42 frames from a scrolling display; overlapping frame histories are merged, rather than counted as independent beats. The horizontal and vertical calibration, beat identification, and slope estimates require independent checking before ACCmax is reported in m/s².

This is a healthy finger example, not a tibial or pedal artery recording, PAD cohort, or expert-annotated ACCmax reference set. It can support early work on spectral image segmentation, scale reading, and systolic-upstroke detection. It cannot validate diagnostic thresholds for limb ischemia.
