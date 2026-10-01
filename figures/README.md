# Human limb arterial spectral Doppler figure crops

These files are **crops of published figures**, not raw scanner data or a clinical dataset. They are suitable for checking whether an image algorithm can find the spectral display, separate cardiac cycles, and follow a visible envelope. Panels from one figure should not be counted as independent subjects. They are not a calibrated reference set for ACCmax.

## Sources and attribution

1. **Anterior tibial artery:** Yahui Zhang et al., “Effects of Enhanced External Counterpulsation With Different Sequential Levels on Lower Extremity Hemodynamics,” *Frontiers in Cardiovascular Medicine* 8:795697 (2021), [doi:10.3389/fcvm.2021.795697](https://doi.org/10.3389/fcvm.2021.795697), Figure 2. [Original figure file](https://www.frontiersin.org/files/Articles/795697/xml-images/fcvm-08-795697-g0002.webp). The study enrolled 20 healthy young men. Figure 2 displays anterior tibial artery spectra at baseline and during three enhanced external counterpulsation (EECP) configurations. The on-screen sweep indication is 66 mm/s and the velocity scale is marked cm/s. The published article is [CC BY](https://creativecommons.org/licenses/by/4.0/); its copyright notice permits redistribution and reproduction with credit. The caption gives the top-to-bottom order baseline, EECP-3, EECP-1, EECP-2; one sentence in the results lists EECP-2 and EECP-1 in the opposite order. The crop filenames follow the caption.
2. **Right brachial artery:** Yahui Zhang et al., “Acute Hemodynamic Responses to Enhanced External Counterpulsation in Patients With Coronary Artery Disease,” *Frontiers in Cardiovascular Medicine* 8:721140 (2021), [doi:10.3389/fcvm.2021.721140](https://doi.org/10.3389/fcvm.2021.721140), Figure 2. [Original figure file](https://www.frontiersin.org/files/Articles/721140/xml-images/fcvm-08-721140-g0002.webp). The study enrolled 42 people with coronary artery disease and 21 controls; the figure does not identify which group the pictured subject belongs to. Figure 2 displays the right brachial artery before (A) and during (B) EECP. The scanner overlay explicitly labels “PW” and shows an inverted spectrum (“Inv”), a cm/s velocity scale, and 50 mm/s sweep. The [article copyright notice](https://www.frontiersin.org/journals/cardiovascular-medicine/articles/10.3389/fcvm.2021.721140/full) is CC BY and permits credited redistribution.

`originals/` contains the journal-supplied full figures. `crops/` contains six unscaled source-pixel spectral crops. `plots/human_limb_spectral_overview.png` is a contact sheet. `manifest.json` records exact crop coordinates, original URLs, dimensions, and SHA-256 hashes. Run `python3 crop_frontiers_figures.py` with Pillow installed to regenerate the crops and overview.

Original SHA-256 checksums:

| Original file | SHA-256 |
| --- | --- |
| `anterior_tibial_eecp_figure2.webp` | `ea06302d7cd0da330766d473794dbd39bca390fc1d6b28e70de990bb02f889dc` |
| `brachial_eecp_figure2.webp` | `5c9acc7c2e9cc0372cedac3416c2311b369568e5e817c3dc2b1cd3aca0deb3b9` |

The six source-pixel crops are `anterior_tibial_baseline.png`, `anterior_tibial_eecp_3.png`, `anterior_tibial_eecp_1.png`, `anterior_tibial_eecp_2.png`, `brachial_before_eecp.png`, and `brachial_during_eecp.png`. The tibial panel labels follow Figure 2's caption.

## Practical limits

- The original figures have visible waveform envelopes and several cardiac cycles. The source images are 1535 × 1749 pixels (tibial) and 945 × 1321 pixels (brachial); individual spectral crops retain their source resolution.
- The figures have velocity tick marks and a scanner sweep speed, but no DICOM ultrasound region calibration or independently verifiable pixel-to-time mapping after publication resizing. Do not calculate physical ACCmax in m/s² from these crops without an external calibration check.
- Text, ECG traces, measurement overlays, and image compression complicate automatic envelope tracing. The brachial display is inverted, so an algorithm must identify the baseline and flow direction.
- EECP creates additional diastolic flow changes. For an initial normal-upstroke test, the anterior tibial **baseline** crop is the most relevant of these examples. None of the images are pedal or PAD reference measurements with expert ACCmax labels.
