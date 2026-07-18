/**
 * Standard-tuned guitar fretboard model.
 * String numbers follow guitar convention: 1 = high E, 6 = low E.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NATURAL_NOTES = new Set(['C', 'D', 'E', 'F', 'G', 'A', 'B']);

/** Open-string MIDI notes for strings 1–6 (index 0 unused). */
const OPEN_MIDI = [null, 64, 59, 55, 50, 45, 40];

const STRING_LABELS = {
  1: { short: '1', name: 'high E', full: '1st string (high E)' },
  2: { short: '2', name: 'B', full: '2nd string (B)' },
  3: { short: '3', name: 'G', full: '3rd string (G)' },
  4: { short: '4', name: 'D', full: '4th string (D)' },
  5: { short: '5', name: 'A', full: '5th string (A)' },
  6: { short: '6', name: 'low E', full: '6th string (low E)' },
};

const A4_MIDI = 69;
const A4_HZ = 440;

function midiToNoteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

function midiToFrequency(midi) {
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

function frequencyToMidi(hz) {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

function positionMidi(stringNum, fret) {
  return OPEN_MIDI[stringNum] + fret;
}

function isNaturalNoteName(name) {
  return NATURAL_NOTES.has(name);
}

/**
 * Build the pool of playable positions from training config.
 * @returns {{ string: number, fret: number, midi: number, note: string, frequency: number }[]}
 */
function buildPositionPool(config) {
  const {
    strings = [1, 2, 3, 4, 5, 6],
    fretMin = 0,
    fretMax = 12,
    naturalsOnly = false,
  } = config;

  const min = Math.max(0, Math.min(fretMin, fretMax));
  const max = Math.min(24, Math.max(fretMin, fretMax));
  const pool = [];

  for (const stringNum of strings) {
    if (!OPEN_MIDI[stringNum]) continue;
    for (let fret = min; fret <= max; fret += 1) {
      const midi = positionMidi(stringNum, fret);
      const note = midiToNoteName(midi);
      if (naturalsOnly && !isNaturalNoteName(note)) continue;
      pool.push({
        string: stringNum,
        fret,
        midi,
        note,
        frequency: midiToFrequency(midi),
      });
    }
  }

  return pool;
}

function describeLocation(position, config) {
  const label = STRING_LABELS[position.string];
  const fretMin = Math.min(config.fretMin, config.fretMax);
  const fretMax = Math.max(config.fretMin, config.fretMax);
  const fretPhrase =
    fretMin === fretMax
      ? `fret ${fretMin}`
      : fretMin === 0
        ? `open–${fretMax}`
        : `frets ${fretMin}–${fretMax}`;

  return {
    stringLine: label.full,
    rangeLine: fretPhrase,
    summary: `${label.full} · ${fretPhrase}`,
  };
}

function formatCents(cents) {
  const rounded = Math.round(cents);
  if (rounded === 0) return 'in tune';
  return rounded > 0 ? `+${rounded}¢` : `${rounded}¢`;
}

window.Fretboard = {
  NOTE_NAMES,
  STRING_LABELS,
  OPEN_MIDI,
  midiToNoteName,
  midiToFrequency,
  frequencyToMidi,
  positionMidi,
  isNaturalNoteName,
  buildPositionPool,
  describeLocation,
  formatCents,
};
