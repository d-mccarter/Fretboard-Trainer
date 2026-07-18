/**
 * Lightweight checks for fretboard pool logic (no browser required).
 * Run: node scripts/smoke-test.mjs
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(new URL('../js/fretboard.js', import.meta.url), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(src, sandbox);
const F = sandbox.window.Fretboard;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const all = F.buildPositionPool({
  strings: [1, 2, 3, 4, 5, 6],
  fretMin: 0,
  fretMax: 12,
  naturalsOnly: false,
});
assert(all.length === 6 * 13, `expected 78 chromatic positions, got ${all.length}`);

const naturals = F.buildPositionPool({
  strings: [6],
  fretMin: 0,
  fretMax: 12,
  naturalsOnly: true,
});
assert(
  naturals.every((p) => F.isNaturalNoteName(p.note)),
  'naturals-only pool leaked accidentals'
);
assert(naturals.length === 8, `low E 0–12 naturals should be 8, got ${naturals.length}`);

const openE = all.find((p) => p.string === 6 && p.fret === 0);
assert(openE.note === 'E', `open low E should be E, got ${openE.note}`);
assert(Math.abs(openE.frequency - 82.41) < 0.1, `open E freq off: ${openE.frequency}`);

const fifthFretE = all.find((p) => p.string === 6 && p.fret === 5);
assert(fifthFretE.note === 'A', `6th string fret 5 should be A, got ${fifthFretE.note}`);

const loc = F.describeLocation(fifthFretE, { fretMin: 0, fretMax: 12 });
assert(loc.stringLine.includes('low E'), `location missing string: ${loc.stringLine}`);
assert(loc.rangeLine.includes('12'), `location missing range: ${loc.rangeLine}`);

console.log('smoke-test: ok');
console.log('file:// tip:', pathToFileURL(new URL('../index.html', import.meta.url).pathname).href);
