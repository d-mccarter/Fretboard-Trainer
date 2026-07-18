const STORAGE_KEY = 'fretboard-trainer';

const DEFAULT_CONFIG = {
  strings: [1, 2, 3, 4, 5, 6],
  fretMin: 0,
  fretMax: 12,
  naturalsOnly: true,
  simulatorEnabled: false,
  /** @type {'mic' | 'digital'} */
  simulatorInput: 'digital',
  /** Digital mic preamp for quiet sources (unamplified electric). */
  micGain: 12,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        config: { ...DEFAULT_CONFIG },
        stats: defaultStats(),
        noiseProfile: null,
      };
    }
    const parsed = JSON.parse(raw);
    return {
      config: normalizeConfig(parsed.config),
      stats: { ...defaultStats(), ...(parsed.stats || {}) },
      noiseProfile: normalizeNoiseProfile(parsed.noiseProfile),
    };
  } catch {
    return {
      config: { ...DEFAULT_CONFIG },
      stats: defaultStats(),
      noiseProfile: null,
    };
  }
}

function saveState(state) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      config: normalizeConfig(state.config),
      stats: state.stats || defaultStats(),
      noiseProfile: normalizeNoiseProfile(state.noiseProfile),
    })
  );
}

function defaultStats() {
  return {
    sessionsStarted: 0,
    notesCorrect: 0,
    bestStreak: 0,
  };
}

function normalizeConfig(config = {}) {
  const strings = Array.isArray(config.strings)
    ? [...new Set(config.strings.map(Number).filter((n) => n >= 1 && n <= 6))].sort(
        (a, b) => b - a
      )
    : [...DEFAULT_CONFIG.strings];

  let fretMin = Number.isFinite(config.fretMin) ? Number(config.fretMin) : DEFAULT_CONFIG.fretMin;
  let fretMax = Number.isFinite(config.fretMax) ? Number(config.fretMax) : DEFAULT_CONFIG.fretMax;
  fretMin = Math.max(0, Math.min(24, Math.round(fretMin)));
  fretMax = Math.max(0, Math.min(24, Math.round(fretMax)));
  if (fretMin > fretMax) {
    const tmp = fretMin;
    fretMin = fretMax;
    fretMax = tmp;
  }

  const simulatorInput =
    config.simulatorInput === 'mic' || config.simulatorInput === 'digital'
      ? config.simulatorInput
      : DEFAULT_CONFIG.simulatorInput;

  let micGain = Number(config.micGain);
  if (!Number.isFinite(micGain)) micGain = DEFAULT_CONFIG.micGain;
  micGain = Math.max(1, Math.min(64, Math.round(micGain * 10) / 10));

  return {
    strings: strings.length ? strings : [...DEFAULT_CONFIG.strings],
    fretMin,
    fretMax,
    naturalsOnly: Boolean(config.naturalsOnly),
    simulatorEnabled: Boolean(config.simulatorEnabled),
    simulatorInput,
    micGain,
  };
}

const NOISE_PROFILE_VERSION = 2;

function normalizeNoiseProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  // Drop profiles from the earlier, overly aggressive gate.
  if (Number(profile.version) !== NOISE_PROFILE_VERSION) return null;

  const rms = Number(profile.rms);
  const clarity = Number(profile.clarity);
  if (!Number.isFinite(rms) || rms <= 0) return null;

  let spectrum = null;
  if (Array.isArray(profile.spectrum) && profile.spectrum.length > 16) {
    spectrum = profile.spectrum.map((v) => Number(v) || 0);
  }

  const gain = Number(profile.gain);
  return {
    version: NOISE_PROFILE_VERSION,
    rms,
    clarity: Number.isFinite(clarity) ? clarity : 0,
    spectrum,
    sampleRate: Number(profile.sampleRate) || 0,
    gain: Number.isFinite(gain) && gain > 0 ? gain : 1,
    at: Number(profile.at) || Date.now(),
  };
}

window.TrainerStorage = {
  STORAGE_KEY,
  DEFAULT_CONFIG,
  NOISE_PROFILE_VERSION,
  loadState,
  saveState,
  normalizeConfig,
  normalizeNoiseProfile,
  defaultStats,
};
