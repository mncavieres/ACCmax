# ACCmax waveform test data

Public Doppler recordings, plots, and reproducible plotting scripts for exploring automatic maximal systolic acceleration (ACCmax) measurement.

The source recordings are distributed as assets of the repository's [`datasets-v1` release](https://github.com/mncavieres/ACCmax/releases/tag/datasets-v1), while plots, scripts, checksums, and provenance are tracked here. This keeps large binary files out of Git history. The datasets cover a finger artery, an aortic flow phantom, and fetal pulsed-wave Doppler. They support algorithm development, but none is a clinical tibial or pedal PAD validation cohort with expert ACCmax labels.

| Source | Recordings | Licence |
| --- | --- | --- |
| [Proper volar digital artery](https://data.mendeley.com/datasets/7g2p7t9tzt/1) | 10-second pulsed-wave Doppler MP4 from one healthy volunteer | CC BY 4.0 |
| [Aortic flow phantom](https://figshare.com/articles/dataset/Datasets_for_Blood_speckle_imaging_compared_with_conventional_Doppler_ultrasound_for_transvalvular_pressure_drop_estimation_in_an_aortic_flow_phantom/20237469) | Pulsatile and constant-flow Doppler DICOM recordings, with related measurements | CC BY 4.0 |
| [NInFEA](https://physionet.org/content/ninfea/1.0.0/) | 60 fetal pulsed-wave Doppler bitmap traces with related electrophysiological data and processing code | Open Data Commons Attribution License v1.0 |

ACCmax is the steepest systolic velocity rise divided by elapsed time. A physically meaningful result in m/s² requires both velocity and time calibration, and care with Doppler sign and angle correction. The plots here are exploratory views of the source data; they are not reference ACCmax measurements.

See `data/README.md` for file manifests, checksums, and source attribution, and `scripts/README.md` for plot reproduction instructions.
