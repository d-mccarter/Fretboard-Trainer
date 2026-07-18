const STORAGE_KEY = 'fretboard-trainer';

const DEFAULT_CONFIG = {
  strings: [1, 2, 3, 4, 5, 6],
  fretMin: 0,
  fretMax: 12,
  naturalsOnly: true,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { config: { ...DEFAULT_CONFIG }, stats: defaultStats() };
    const parsed = JSON.parse(raw);
    return {
      config: normalizeConfig(parsed.config),
      stats: { ...defaultStats(), ...(parsed.stats || {}) },
    };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, stats: defaultStats() };
  }
}

function saveState(state) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      config: normalizeConfig(state.config),
      stats: state.stats || defaultStats(),
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

  return {
    strings: strings.length ? strings : [...DEFAULT_CONFIG.strings],
    fretMin,
    fretMax,
    naturalsOnly: Boolean(config.naturalsOnly),
  };
}

window.TrainerStorage = {
  STORAGE_KEY,
  DEFAULT_CONFIG,
  loadState,
  saveState,
  normalizeConfig,
  defaultStats,
};
