# Automated ACCmax, AT and PAT from duplex ultrasound: plan

Status: phase 1 prototype built (algorithm, tests, synthetic validation, browser workbench published with GitHub Pages) and run on every real human case in this repository (`data/`, `figures/`; see CLAUDE.md and [results/README.md](../results/README.md)). No expert-labelled data yet.

## 1. Goal

Measure ACCmax, AT and PAT from a spectral Doppler recording with as little operator input as possible:

- The operator chooses a window of trace (and the artery).
- Software finds the beats, averages them coherently, and places the same landmarks a sonographer would: two points on the steepest part of the upstroke (ACCmax), the foot of the upstroke and the first systolic peak (AT, or PAT in a pedal artery).
- The result is shown on the data with the fitted points. The operator can drag any point to make their own measurement, or re-run the fit. Both the automatic and the edited values are kept.

Definitions follow the LUMC poster description (see the uploaded method summary): ACCmax is the slope of the steepest tangent to the systolic upstroke in m/s², AT is the time from the systolic foot to the first systolic peak in ms, and PAT is AT measured in a pedal artery.

## 2. The pulsating-star idea, and where it needs changing

Folding many cycles on a known period to beat down noise is the right instinct. Several of its assumptions do not hold for a heartbeat, though, and each one changes the design.

| Variable-star practice | Heartbeat reality | Consequence for the design |
| --- | --- | --- |
| Period stable to many digits | RR varies 2–5% at rest with breathing, 10–30% in atrial fibrillation. AF and ectopy are common in PAD and diabetes. | A fixed-period fold smears the upstroke, which biases ACCmax down and AT up. Each beat must be re-aligned (an O − C correction per cycle). |
| Hundreds of cycles | 3–4 cycles on a frozen screen, maybe 10–15 in a cine clip | The Lomb–Scargle peak is broad (Δf ≈ 1/T ≈ 0.25 Hz for 4 s). Use it to get the period roughly and to segment beats, not as the final timing. |
| Light curves are near-sinusoidal | The systolic peak is sharp, so most power sits in harmonics | A single-sinusoid periodogram often peaks at 2× the heart rate. Use a multi-harmonic (Fourier series) Lomb–Scargle and check P/2 and 2P against the tracked upstrokes. |
| Fold in phase units | The systolic upstroke lasts about the same number of milliseconds whatever the RR interval | Stack in milliseconds from the upstroke, not in phase. Phase units would stretch or squeeze the upstroke with each RR. |
| Gaps from day/night and weather | Gaps from the erase bar and rejected columns | This is a real reason to use Lomb–Scargle rather than an FFT. |

The prototype quantifies the first row. On synthetic triphasic waveforms with AF-like RR variation (15%), the best possible fixed-period fold gives ACCmax −21% ± 34% and AT −17 ± 18 ms. Beat-aligned stacking of the same data gives −0.4% ± 2.7% and +1 ± 2 ms (section 8).

What carries over well: phase folding gives effective sub-pixel time resolution, because different beats sample the upstroke at different offsets from the pixel grid (like dithered photometry). The O − C diagram is also a useful display of heart-rate variability.

## 3. Inputs

In order of preference:

1. **DICOM spectral capture** from the scanner. The Sequence of Ultrasound Regions (0018,6011) gives, for the spectral region, seconds per pixel (`PhysicalDeltaX`, units 4 = s), cm/s per pixel (`PhysicalDeltaY`, units 7 = cm/s) and the baseline (`ReferencePixelY0`, `ReferencePixelPhysicalValueY`). No manual calibration is needed, and the Doppler angle (0018,6034) is available for QC. *Implemented: implicit/explicit VR little endian, uncompressed and JPEG baseline/extended. To check on real vendor files: reference-pixel convention, multi-frame cine, JPEG-LS / JPEG 2000 / RLE.*
2. **Screenshot or photo export** (PNG/JPG). Same envelope tracing, calibrated automatically from the scanner overlay on the image (below); the operator only corrects marks that were not found or are wrong. *Implemented.*
3. **Numeric export** (CSV of time and velocity, for example a scanner's auto-trace export or a research interface). *Implemented. Handles European `;`/decimal-comma files.*
4. **Later: raw Doppler IQ or audio** (WAV). This would allow computing the spectrogram and the true maximum-frequency envelope ourselves (for example with the modified-threshold or percentile method), without screen quantisation. It depends on scanner access.

**Automatic calibration of images** (`web/js/io/autocal.js`). The tool finds what a person would use to calibrate the image by hand, checks each reading, and draws and lists what it took for what:

- *Velocity scale:* short horizontal bars, aligned on one edge and evenly spaced down the image (fitted as a lattice, so ticks touching the spectrum or the baseline are still found); long and short ticks differ in reach. The labels beside the long ticks are segmented (touching characters split, a leading minus separated) and read by template matching against digits and "cm/s" in common sans-serif fonts, with a shape rule for "1". The labels must lie on one straight line against tick position (one misread label may be dropped); fewer than three usable labels means no automatic velocity scale. The unit comes from "cm/s"/"m/s" at zero; labels increasing downwards mean an inverted display.
- *Baseline:* the longest coloured horizontal line, accepted if it sits on the scale's zero (within 2 px); otherwise the scale's zero.
- *Time:* rows outside the display with many narrow marks on a lattice (a timeline); the period of the tallest marks gives the step, assuming the tallest marks are 1 s apart (every 10th mark here, so 0.1 s per mark, consistent with the heart rate printed on the tibial panels). Without a timeline, dotted vertical grid lines with a common dot pitch, assumed 1 s apart.
- *Region:* the scale's extent, shrunk to keep clear of the ECG trace (a long thin curve, found even when compression has washed out its colour), on-screen text lines, horizontal rules, the timeline and image borders.
- *Known displays:* a 48 × 16 thumbnail recognises the published example images (also resized or re-saved), which supplies their source, artery and printed heart rate, and a reference calibration to compare with. Reading the heart rate off the screen was tried and dropped: digits in that corner were misread too often.

On the six crops the automatic calibration is within 0.3% of the reference calibration for velocity and time, and 0.5 px for the baseline; on 30 altered copies (resized to 75% and 130%, JPEG quality 70, padded, cropped) all calibrations stay within 0.3%. The fitted ACCmax changes by under 1% for most copies; the exception is EECP-2 at 75% size (16 against 34 m/s²), where the signed upstroke through the flow reversal is resolution-sensitive (see section 11).

**Envelope extraction from images.** In every pixel column both outer edges are traced, above and below the baseline: from the scale limit towards the baseline, the edge is the first run of three or more pixels above an intensity threshold (a run rejects isolated speckle), interpolated to sub-pixel precision. The default threshold is the background level plus 55% of the way to the Otsu split, with a slider override.

- The analysed trace is **signed**: forward flow positive, reverse flow negative, so the full cycle (including the reverse-flow phase of a triphasic waveform) enters the fit. The direction in each column is decided by the share of bright pixels on each side: below 30% on the reverse side the column is forward flow (stray speckle ignored), above 70% it is reverse flow, and in between the two edges are blended smoothly. A hard switch from one edge to the other would jump across the baseline in one column and fake a near-vertical upstroke.
- Columns without signal are **zero flow**, not gaps: in a clean display diastole with no detectable flow is black.
- Overlays are not spectrum: strongly saturated pixels (ECG, calipers, coloured baseline) are always ignored, and on a grey-scale spectrum so are mildly coloured ones (dotted time lines, text).
- The forward envelope reaching the edge of the scale suggests aliasing and is flagged. The forward-only and reverse-only edges are also kept, for the overlay and for comparison.

## 4. Algorithm

| Step | What it does | Default |
| --- | --- | --- |
| 1. Window | Keep the operator-selected stretch, and drop isolated one-sample dropouts (a sample far below both neighbours: a missed edge, or an undrawn frame in a merged digitisation) | whole trace |
| 2. Period | Multi-harmonic generalized Lomb–Scargle over 30–200 bpm, 10× oversampled grid, local refinement of the peak | 3 harmonics |
| 3. Track beats | Smooth the trace (bandwidth ≈ 3% of the period), take the strongest upstroke (max dv/dt) as anchor, then predict each next/previous upstroke at ±P and search ±0.3 P. Drift never accumulates. Candidate periods P/2, P and 2P are tried, and the smallest whose tracked upstrokes are ≥ 80% "strong" (≥ ½ the strongest slope) wins. Halving the periodogram period is allowed only when the periodogram has ≥ 70% of its peak power at twice the rate and alternate upstrokes look alike, so a second forward wave in every cycle (counterpulsation, a strong late-diastolic wave) is never counted as a heartbeat. | |
| 4. Segment | Split samples between consecutive upstrokes at 60% of the RR interval. A beat is complete if its core (−0.25 P … +0.35 P around the upstroke) is covered without gaps. | |
| 5. Align | For each beat, build a template from the *other* beats (leave-one-out, so a beat cannot align to its own noise), cross-correlate over the core region (Pearson r, 0.5 ms steps, parabolic refinement), shift, and iterate to convergence (Woody's method). Beats with r below the threshold, or whose shift hits the ±60 ms limit, drop out of the stack but stay visible. | r ≥ 0.85 |
| 6. Stack | All complete, accepted beats are put on one axis, τ = t − upstroke time (ms). They are smoothed with robust local quadratic regression (Gaussian kernel, two bisquare iterations, outlier scale floored at 5% of the signal so that ordinary beat-to-beat amplitude differences are averaged rather than rejected), which gives value, slope and curvature on a 0.5 ms grid. | bandwidth max(5 ms, 0.15 × AT) |
| 7. Landmarks | See section 5 | span 20 ms, tangent onset |
| 8. Uncertainty | Single-beat measurements (same definitions), and a bootstrap over beats (resample beats with replacement and re-measure). Intervals are widened by the Student-t factor for the small number of beats. | 200 resamples |

**Why the bandwidth scales with AT.** The maximum of a noisy slope is biased upwards: the steepest chord tends to land where the noise happens to tilt the curve up. Monophasic upstrokes are long and shallow, so in early tests with fixed 5 ms smoothing ACCmax came out 10–20% high. Scaling the bandwidth to 15% of the acceleration time removes this bias (section 8). It costs little on sharp triphasic upstrokes, which have a short AT and so stay lightly smoothed.

## 5. Landmarks and the "correct valley"

All landmarks are found on the stacked template. The same function also runs on single beats, which is how the per-beat column is produced.

- **ACCmax.** The chord of fixed span *w* (default 20 ms) with the largest slope. Its two ends are the two caliper points the sonographer would place ("1" and "2" in the tool), and ACCmax = (v₂ − v₁)/(t₂ − t₁). A chord of stated span, rather than the instantaneous peak derivative, mirrors the manual method and makes the noise filtering explicit. *w* is a setting, and the right default should come from comparison with expert placements (section 8).
- **Valley (end-diastolic).** Walking backwards from the start of the ACCmax chord, keep going while the slope is still more than 3% of ACCmax; then take the lowest point in the next 12 ms. Starting from the steepest upstroke and walking back means the early-diastolic **reverse-flow trough of a triphasic waveform is never chosen**: it lies beyond the late-diastolic plateau and the walk stops before reaching it. In a monophasic waveform the walk stops at the true minimum before the rise.
- **Onset (foot).** Selectable. The prototype offers four definitions because they differ by tens of milliseconds on gradual monophasic feet, and the poster does not fix one:
  - *tangent intersection* (default): the ACCmax tangent meets the valley level. This is the standard foot definition in pulse-wave analysis and is robust to noise.
  - *maximum curvature*: the point of greatest upward bend between valley and upstroke.
  - *valley*: the minimum itself.
  - *10% rise*: the first point 10% of the way from valley to peak.
- **Peak.** The first maximum after the chord that the curve then falls away from by at least 5% of the systolic rise (a prominence test). This gives the *first* systolic peak of a bisferious waveform and ignores noise ripples on a rounded monophasic top.
- **AT / PAT.** Peak time minus onset time. The label switches to PAT when the selected site is a pedal artery.

Manual edits: each caliper can be dragged along the template (it stays on the curve; only its time changes) or moved with the arrow keys. ACCmax and AT are recomputed from the edited points. The auto values stay alongside, marked "edited · fit …", and both go into the export.

## 6. Quality control shown to the operator

- Fewer than 3 beats stacked: no interval is reported.
- Irregular rhythm (RR variation > 10%): possible AF or ectopy.
- Weak periodicity (Lomb–Scargle power < 0.2).
- Noisy envelope (scatter about the template > 12% of the systolic rise).
- Beats left out, and why (incomplete, low similarity, alignment failed, excluded by the operator).
- AT outside 20–400 ms.
- Images: envelope at the scale limit (aliasing); DICOM Doppler angle > 60°.
- The periodogram's chosen peak, which the operator can override by clicking another peak (forced heart rate).

## 7. Web tool

Implemented as a static page (no server, no upload). This matters for patient data: files are read and processed in the browser, and the page makes no third-party requests (fonts are served with it). It is published with GitHub Pages (`.github/workflows/pages.yml`, https://mncavieres.github.io/ACCmax/ once Pages is enabled), and can also run on an intranet or as one offline HTML file (`npm run build`).

The page is one column of numbered steps:

1. **Load a recording**: open DICOM, image or CSV (drag and drop), or one of the examples: the real published cases from this repository or simulated waveforms with known truth; pick the measurement site (set automatically for a recognised example). Images are calibrated automatically on opening; the calibration view draws on the image what was taken for the scale (with the label values read), the baseline, the time marks, the display region and the ignored ECG and text, lists each with its numbers, and overlays both traced edges so tracing errors are visible. Hand tools correct any mark. Pressing Run automatic fit on an image that could not be calibrated says what is missing.
2. **Automatic fit**: one button. The readout (ACCmax and AT/PAT with 68%/95% intervals, single-beat range, heart rate, PSV/EDV, beats used, QC messages; copy or download as JSON/CSV) sits above the stacked beats over the full cardiac cycle, with the smoothed template, the ACCmax tangent, valley, onset, peak and the AT bracket. Calipers can be dragged or moved by keyboard; the automatic values stay alongside the edited ones. A *fixed-period fold* view shows what plain phase folding would have given.
3. **Optional refinement**: the analysis window (drag across the trace), the periodogram (click to force a heart rate), beat timing (O − C), the beats table (untick a beat to leave it out) and the fit settings. The fit runs again after each change.

A results page (`results/` on the site) shows the automatic fits on every real and simulated case.

## 8. Validation

### Done: synthetic Monte Carlo (`npm run validate`)

Synthetic envelopes are sums of physiological pulse shapes per beat (gamma-variate systolic wave, reverse-flow dip, late forward wave, diastolic run-off). They are tuned so the noise-free values sit near the poster's examples (triphasic ≈ 8.1 m/s², 94 ms; monophasic ≈ 1.2 m/s², 138 ms; the poster shows 7.8 m/s², 93 ms and 1.0 m/s², 144 ms). They include respiratory and random RR and amplitude variation, additive noise, speckle spikes, 4 ms sampling (about one screen pixel) and velocity quantisation. Truth is measured on the noise-free waveform with the same definitions.

Errors below are median ± robust SD over 40 runs per scenario; ACCmax in % of truth, AT in ms.

| Scenario | Quantity (truth) | Beat-aligned stack | Fixed-period fold | One beat | Mean of single beats |
| --- | --- | --- | --- | --- | --- |
| triphasic, regular, 4 s | ACCmax (8.09 m/s²) | **-0.9 ± 3.0** | +6.8 ± 11.1 | +0.8 ± 6.3 | +1.1 ± 2.8 |
|  | AT (94 ms) | **+1 ± 2** | -5 ± 9 | +1 ± 6 | +1 ± 2 |
| triphasic, regular, 8 s | ACCmax (8.09 m/s²) | **+0.3 ± 1.9** | +5.5 ± 7.7 | +2.3 ± 9.4 | +2.2 ± 1.8 |
|  | AT (94 ms) | **+0 ± 2** | -3 ± 14 | +0 ± 5 | -0 ± 2 |
| triphasic, noisy, 8 s | ACCmax (8.09 m/s²) | **+2.0 ± 3.8** | +9.8 ± 9.3 | +11.2 ± 14.8 | +8.6 ± 6.2 |
|  | AT (94 ms) | **-1 ± 4** | -3 ± 12 | +1 ± 10 | -2 ± 3 |
| triphasic, AF-like RR, 8 s | ACCmax (8.09 m/s²) | **-0.4 ± 2.7** | -21.0 ± 34.3 | +1.0 ± 7.8 | +1.9 ± 2.6 |
|  | AT (94 ms) | **+1 ± 2** | -17 ± 18 | -0 ± 5 | +1 ± 2 |
| biphasic, regular, 6 s | ACCmax (4.46 m/s²) | **+1.1 ± 4.3** | +8.5 ± 12.8 | +2.0 ± 8.9 | +4.6 ± 3.8 |
|  | AT (104 ms) | **+1 ± 3** | -2 ± 8 | +0 ± 6 | +1 ± 3 |
| monophasic, regular, 6 s | ACCmax (1.19 m/s²) | **+0.5 ± 3.3** | +4.8 ± 8.8 | +1.7 ± 6.8 | +1.8 ± 2.9 |
|  | AT (138 ms) | **+1 ± 4** | -3 ± 9 | +0 ± 9 | +1 ± 4 |
| monophasic, noisy, 8 s | ACCmax (1.19 m/s²) | **+0.8 ± 5.2** | +5.5 ± 10.1 | +5.2 ± 15.2 | +7.0 ± 5.3 |
|  | AT (138 ms) | **+0 ± 6** | -2 ± 10 | -0 ± 18 | +2 ± 4 |
| monophasic, AF-like RR, 8 s | ACCmax (1.18 m/s²) | **-0.5 ± 2.0** | -22.0 ± 41.1 | +1.4 ± 7.7 | +1.6 ± 2.6 |
|  | AT (137 ms) | **-1 ± 3** | +8 ± 50 | -3 ± 8 | -1 ± 3 |

Reading the table:

- **Beat-aligned stacking has the lowest combined error (bias and spread) in every scenario.** Its median error is within ±2% for ACCmax and ±1 ms for AT.
- **A single beat** (what one manual measurement uses) has 2–4× the spread of the stack. With noise it is also biased high, because the steepest chord tends to land on noise.
- **Averaging single-beat values** has a low spread but keeps that upward bias (+4% to +8% on noisy or damped waveforms).
- **A plain fixed-period fold** is worse than a single beat once the rhythm is irregular, and noticeably noisier even for a regular rhythm.
- **Interval calibration:** across the eight scenarios the 68% intervals contained the true value in 60–87% of runs for ACCmax (median 70%) and 53–80% for AT (median 65%), from 30 runs each (sampling error about ±9%). That is close to nominal, slightly narrow for AT. Treat the intervals as a lower bound on total uncertainty: they describe beat-to-beat variation, not angle, calibration or envelope-threshold error.

The image path is tested end to end too: a synthetic spectral display is written as a DICOM file with ultrasound-region calibration, parsed, traced, and measured. The envelope is within 3 px RMS, and ACCmax and AT are within 12% and 12 ms of truth. See `tests/io.test.mjs`.

### Done: the real cases in this repository

Every real human case was fitted automatically with the default settings: the finger recording (digitised envelope), four anterior tibial panels and two brachial panels from published figures. Full results and checkplots are in [results/README.md](../results/README.md); `npm run fit-cases` and `python3 scripts/plot_checkplots.py` reproduce them.

- The published panels carry no machine calibration. They are calibrated automatically from the scanner overlay printed in each panel, as in the workbench, and checked against the reference calibration from `scripts/calibrate-figure-crops.mjs` (labels typed in by eye): velocity from the labelled cm/s ticks, time from the timeline marks (tibial, cross-checked against the heart rate printed on screen) or the dotted 1 s lines (brachial, no printed heart rate to confirm). Both agree within 0.3%; the calibration is still provisional because the figures were resized for publication.
- Resting anterior tibial artery: heart rate 57 bpm against 58 on the scanner, three beats in close agreement, ACCmax about 6 m/s², AT about 116 ms.
- Running the method on real data exposed four problems that synthetic data had not, all now fixed and covered by tests (`tests/realdata.test.mjs`): diastolic black columns treated as gaps; counterpulsation waves counted as heartbeats (period halving); one-sample dropouts in a merged digitisation; and the robust smoother switching between beats of different amplitude, which added false steepness.
- During counterpulsation (EECP) flow reverses just before systole, so the signed ACCmax includes the reversal through zero and is about twice the forward-only value; both are reported.

### Next: expert-labelled real data

1. **Collect** 30–50 anonymised recordings per site type (ankle PTA/ATA, P3, DFA, pedal arteries), triphasic through monophasic, as DICOM where possible, with the scanner model noted.
2. **Reference standard**: two or three experienced sonographers measure ACCmax and AT on the same recordings, blinded to each other and to the software, using their usual practice (one representative beat, scanner calipers).
3. **Agreement**: Bland–Altman (bias and limits of agreement) and ICC for software vs each observer and between observers. The target is that software-vs-observer agreement is no worse than observer-vs-observer.
4. **Repeatability**: the same patient and site recorded twice; compare the coefficient of variation for manual and automated measurement. This is where stacking should help most.
5. **Defaults**: pick the tangent span *w* and the onset definition that best match expert placements, then freeze them before any diagnostic analysis.
6. **Diagnostic check**: with frozen settings, apply the poster's ACCmax cut-offs (ankle 5.5, P3 6.5, DFA 7.5 m/s²) against CTA/DSA where available, and compare sensitivity and specificity with manual ACCmax.
7. **Robustness**: AF patients, low-flow monophasic signals, aliasing, overlays and text on the image, different scanners and colour maps.

## 9. Roadmap

| Phase | Content | Status |
| --- | --- | --- |
| 1. Prototype | Core algorithm, DICOM/image/CSV input, browser workbench with editable calipers, synthetic validation, tests | **done** (this repo) |
| 2. Real-data pilot | Done for the public cases in this repository (batch fitting and checkplots). Next: 10–20 real DICOMs from each scanner in use, to fix DICOM quirks (reference-pixel convention, cine frames, compressed syntaxes); measure the finger case directly from the video frames instead of the merged digitisation; use the ECG printed on the display to confirm which upstroke is systolic. | in progress |
| 3. Validation study | Observer study and repeatability as in section 8. Tune and freeze defaults. | |
| 4. Refinements | Parametric upstroke fit (for example a Richards curve) as an alternative ACCmax estimator; uncertainty that includes alignment (re-align inside the bootstrap); a Web Worker so long cine loops do not block the page; spectral-domain envelope from raw IQ/audio if the scanner allows it; optional PACS/DICOMweb loading; audit log of edits. | |
| 5. Clinical path | If it is to inform diagnosis, it becomes medical-device software under EU MDR (likely class IIa): quality system (ISO 13485), software lifecycle (IEC 62304), risk management (ISO 14971), clinical evaluation. A research-use label and a local governance route are needed before then. | |

## 10. Decisions I need from you

1. **Data format.** Which scanner(s), and can you get DICOM exports with the ultrasound region intact? A screenshot workflow now calibrates itself from the scanner overlay, but loses resolution, and its time scale rests on a display convention (tallest timeline marks 1 s apart) that should be confirmed for each scanner model.
2. **Recording length.** Can the protocol add a 6–10 s cine clip per site instead of a single frozen screen? Synthetic tests show 4 s already beats a single beat, but more beats tighten the intervals and make irregular rhythms manageable.
3. **Onset definition for AT/PAT.** The poster says "where the envelope begins its rise", which is not operational on gradual feet. Do you want to keep tangent intersection as the default, or choose after the observer study?
4. **Tangent span for ACCmax.** 20 ms now. Do your sonographers use the scanner's acceleration tool (and if so, which span does it use) or free calipers?
5. **Where the tool runs.** GitHub Pages is set up (enable it once under Settings → Pages → Source: GitHub Actions). An intranet copy or the offline single file are also possible; the choice affects the governance paperwork.
6. **Python.** If you want to run large batches or notebooks, I can mirror the core in Python (numpy/astropy) with a shared test suite. Otherwise the JavaScript core already runs in Node for batch jobs.

## 11. Known limitations

- Accuracy is validated on synthetic data only. The real cases show that the method runs end to end on real screen captures, but they have no expert ACCmax labels, and their calibrations are approximate or provisional. Real spectra have envelope noise that is skewed and correlated, which the synthetic model does not include.
- The spectral display already smooths in time (the FFT window is roughly 5–20 ms), so the envelope is not the instantaneous velocity. ACCmax measured on any display, manual or automatic, inherits this. It is a property of the machine settings and should be held constant in a study.
- Automatic image calibration is built and tested on one family of scanner displays (the published panels). Other layouts (scale on the left, labels in m/s, kHz scales, colour-mapped spectra) follow the same rules but are untested; the panel shows what was found so a wrong reading is visible, and a timeline convention other than "tallest marks 1 s apart" needs the time marks set by hand.
- Where flow reverses just before systole (counterpulsation), the steepest part of the signed upstroke is the reversal through zero, whose steepness depends on how the two edges are blended. It changes with image resolution (EECP-2: 34 m/s² at full size, 16 m/s² at 75%), so the forward-only value is reported alongside.
- Angle correction errors scale velocity, and therefore ACCmax, directly. The software cannot fix them; it only flags angles above 60°.
- With 3–4 beats the bootstrap interval is crude; a cine clip helps.
