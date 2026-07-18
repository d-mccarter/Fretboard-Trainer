# Fretboard Trainer

A mobile-friendly web app for learning the notes on the guitar fretboard. Open it in Safari, allow the microphone, and practice finding notes by ear and location.

Works on iPhone: open in Safari, tap **Share → Add to Home Screen** for a full-screen app experience.

## Features

- **Configure** — Limit training to selected strings, a fret range, and optionally natural notes only (no sharps/flats)
- **Train** — A note name is shown with a location hint (which string, and the configured fret range)
- **Microphone pitch detection** — Autocorrelation-based detector listens for the correct pitch
- **Guitar simulator** — Optional pitch slider that plays a phone tone for testing without a guitar; choose **Digital** (reads the tone directly) or **Microphone** (listens via the speaker)
- **Mic calibration** — Measures room noise, then blinks twice per second while you pluck so the app can auto-set microphone gain
- **Local storage** — Settings and streak stats stay on your device

## Quick start

```bash
npx --yes serve .
```

Open `http://localhost:3000` in a browser.

### iPhone (same Wi‑Fi)

Safari only allows microphone access over **HTTPS** (or `localhost`). For phone testing, serve over HTTPS — for example GitHub Pages, or a tunnel:

```bash
npx --yes serve . -l 3000
# then expose with a TLS tunnel, or deploy the folder to any static HTTPS host
```

On the phone: open the HTTPS URL → **Share** → **Add to Home Screen**.

## How to use

1. **Configure** — Pick strings, fret range, and whether to include only natural notes
2. **Start training** — Grant microphone access when prompted
3. Read the note name and location hint, then pluck that note
4. Hold the note briefly when it matches; the app advances automatically

The exact fret is not revealed — only the string and the fret range you configured — so you still have to find the note.

## Tech

Vanilla HTML, CSS, and JavaScript — no build step. Pitch detection uses the Web Audio API with autocorrelation (better than FFT for low guitar notes).
