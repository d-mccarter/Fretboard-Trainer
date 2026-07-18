(() => {
  const {
    buildPositionPool,
    describeLocation,
    frequencyToMidi,
    midiToNoteName,
    formatCents,
    STRING_LABELS,
  } = window.Fretboard;
  const { loadState, saveState, DEFAULT_CONFIG } = window.TrainerStorage;
  const PitchDetector = window.PitchDetector;

  const CENTS_TOLERANCE = 35;
  const HOLD_MS = 280;
  const NEXT_DELAY_MS = 700;

  const state = loadState();
  let currentView = 'configure';
  let detector = null;
  let session = null;

  const els = {
    pageTitle: document.getElementById('page-title'),
    buildLabel: document.getElementById('build-label'),
    navButtons: [...document.querySelectorAll('.nav-btn')],
    views: {
      configure: document.getElementById('view-configure'),
      train: document.getElementById('view-train'),
    },
    stringToggles: [...document.querySelectorAll('[data-string]')],
    fretMin: document.getElementById('fret-min'),
    fretMax: document.getElementById('fret-max'),
    naturalsOnly: document.getElementById('naturals-only'),
    poolCount: document.getElementById('pool-count'),
    startTrainBtn: document.getElementById('start-train-btn'),
    noteName: document.getElementById('note-name'),
    locationHint: document.getElementById('location-hint'),
    locationRange: document.getElementById('location-range'),
    listenStatus: document.getElementById('listen-status'),
    heardPitch: document.getElementById('heard-pitch'),
    sessionStreak: document.getElementById('session-streak'),
    sessionCorrect: document.getElementById('session-correct'),
    trainStartBtn: document.getElementById('train-start-btn'),
    trainSkipBtn: document.getElementById('train-skip-btn'),
    trainStopBtn: document.getElementById('train-stop-btn'),
    trainIdle: document.getElementById('train-idle'),
    trainActive: document.getElementById('train-active'),
    micError: document.getElementById('mic-error'),
    statsCorrect: document.getElementById('stat-notes-correct'),
    statsBest: document.getElementById('stat-best-streak'),
    promptCard: document.getElementById('prompt-card'),
  };

  function init() {
    loadBuildLabel();
    bindNav();
    bindConfigure();
    bindTrain();
    renderConfigure();
    renderStats();
    showView('configure');
  }

  async function loadBuildLabel() {
    try {
      const res = await fetch(`build.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      els.buildLabel.textContent = `Build ${data.build}`;
    } catch {
      els.buildLabel.textContent = 'Build …';
    }
  }

  function bindNav() {
    els.navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        if (view === 'train' && session?.active) {
          showView('train');
          return;
        }
        showView(view);
      });
    });
  }

  function showView(view) {
    currentView = view;
    Object.entries(els.views).forEach(([name, el]) => {
      el.classList.toggle('active', name === view);
    });
    els.navButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    els.pageTitle.textContent = view === 'configure' ? 'Configure' : 'Train';
  }

  function bindConfigure() {
    els.stringToggles.forEach((btn) => {
      btn.addEventListener('click', () => {
        const num = Number(btn.dataset.string);
        const set = new Set(state.config.strings);
        if (set.has(num)) {
          if (set.size === 1) return;
          set.delete(num);
        } else {
          set.add(num);
        }
        state.config.strings = [...set].sort((a, b) => b - a);
        persist();
        renderConfigure();
      });
    });

    const onFretChange = () => {
      state.config.fretMin = Number(els.fretMin.value);
      state.config.fretMax = Number(els.fretMax.value);
      persist();
      renderConfigure();
    };
    els.fretMin.addEventListener('change', onFretChange);
    els.fretMax.addEventListener('change', onFretChange);
    els.fretMin.addEventListener('input', onFretChange);
    els.fretMax.addEventListener('input', onFretChange);

    els.naturalsOnly.addEventListener('click', () => {
      state.config.naturalsOnly = !state.config.naturalsOnly;
      persist();
      renderConfigure();
    });

    els.startTrainBtn.addEventListener('click', () => {
      showView('train');
      startSession();
    });
  }

  function bindTrain() {
    els.trainStartBtn.addEventListener('click', () => startSession());
    els.trainSkipBtn.addEventListener('click', () => skipTarget());
    els.trainStopBtn.addEventListener('click', () => stopSession());
  }

  function persist() {
    saveState(state);
  }

  function renderConfigure() {
    const cfg = state.config;
    els.stringToggles.forEach((btn) => {
      const num = Number(btn.dataset.string);
      btn.classList.toggle('active', cfg.strings.includes(num));
      btn.setAttribute('aria-pressed', cfg.strings.includes(num) ? 'true' : 'false');
    });
    els.fretMin.value = cfg.fretMin;
    els.fretMax.value = cfg.fretMax;
    els.naturalsOnly.classList.toggle('on', cfg.naturalsOnly);
    els.naturalsOnly.setAttribute('aria-pressed', cfg.naturalsOnly ? 'true' : 'false');
    els.naturalsOnly.textContent = cfg.naturalsOnly ? 'On' : 'Off';

    const pool = buildPositionPool(cfg);
    els.poolCount.textContent = String(pool.length);
    els.startTrainBtn.disabled = pool.length === 0;
  }

  function renderStats() {
    els.statsCorrect.textContent = String(state.stats.notesCorrect || 0);
    els.statsBest.textContent = String(state.stats.bestStreak || 0);
  }

  function setTrainMode(active) {
    els.trainIdle.hidden = active;
    els.trainActive.hidden = !active;
  }

  async function startSession() {
    const pool = buildPositionPool(state.config);
    if (!pool.length) {
      showMicError('No notes match this configuration. Adjust strings or frets.');
      return;
    }

    els.micError.hidden = true;
    els.micError.textContent = '';

    try {
      if (!detector) detector = new PitchDetector();
      if (!session?.listening) {
        await detector.start((result) => onPitch(result));
      }
    } catch (err) {
      console.error(err);
      showMicError(micErrorMessage(err));
      setTrainMode(false);
      return;
    }

    state.stats.sessionsStarted = (state.stats.sessionsStarted || 0) + 1;
    persist();

    session = {
      active: true,
      listening: true,
      pool,
      target: null,
      lastTargetKey: null,
      streak: 0,
      correct: 0,
      matchStartedAt: null,
      advancing: false,
    };

    setTrainMode(true);
    els.sessionStreak.textContent = '0';
    els.sessionCorrect.textContent = '0';
    nextTarget();
  }

  function stopSession() {
    if (detector) {
      detector.stop();
      detector = null;
    }
    session = null;
    setTrainMode(false);
    els.promptCard.classList.remove('correct', 'listening');
    els.noteName.textContent = '—';
    els.locationHint.textContent = 'Location';
    els.locationRange.textContent = '';
    els.listenStatus.textContent = 'Ready';
    els.heardPitch.textContent = 'Listening…';
    renderStats();
  }

  function skipTarget() {
    if (!session?.active || session.advancing) return;
    session.matchStartedAt = null;
    session.streak = 0;
    els.sessionStreak.textContent = '0';
    nextTarget();
  }

  function nextTarget() {
    if (!session) return;
    const pool = session.pool;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1) {
      let guard = 0;
      while (`${pick.string}-${pick.fret}` === session.lastTargetKey && guard < 8) {
        pick = pool[Math.floor(Math.random() * pool.length)];
        guard += 1;
      }
    }

    session.target = pick;
    session.lastTargetKey = `${pick.string}-${pick.fret}`;
    session.matchStartedAt = null;
    session.advancing = false;

    const loc = describeLocation(pick, state.config);
    els.noteName.textContent = pick.note;
    els.locationHint.textContent = loc.stringLine;
    els.locationRange.textContent = `Find it in ${loc.rangeLine}`;
    els.listenStatus.textContent = 'Listening';
    els.heardPitch.textContent = 'Play the note…';
    els.promptCard.classList.remove('correct');
    els.promptCard.classList.add('listening');
  }

  function onPitch(result) {
    if (!session?.active || session.advancing || !session.target) return;

    if (!result.frequency) {
      session.matchStartedAt = null;
      if (els.listenStatus.textContent !== 'Listening') {
        els.listenStatus.textContent = 'Listening';
      }
      return;
    }

    const heardMidi = frequencyToMidi(result.frequency);
    const nearestMidi = Math.round(heardMidi);
    const cents = (heardMidi - session.target.midi) * 100;
    const heardName = midiToNoteName(nearestMidi);

    els.heardPitch.textContent = `${heardName} · ${formatCents(cents)}`;

    if (Math.abs(cents) <= CENTS_TOLERANCE) {
      els.listenStatus.textContent = 'Hold…';
      if (!session.matchStartedAt) {
        session.matchStartedAt = performance.now();
      } else if (performance.now() - session.matchStartedAt >= HOLD_MS) {
        registerCorrect();
      }
    } else {
      session.matchStartedAt = null;
      els.listenStatus.textContent = 'Listening';
    }
  }

  function registerCorrect() {
    if (!session || session.advancing) return;
    session.advancing = true;
    session.correct += 1;
    session.streak += 1;
    state.stats.notesCorrect = (state.stats.notesCorrect || 0) + 1;
    state.stats.bestStreak = Math.max(state.stats.bestStreak || 0, session.streak);
    persist();

    els.sessionCorrect.textContent = String(session.correct);
    els.sessionStreak.textContent = String(session.streak);
    els.listenStatus.textContent = 'Correct!';
    els.heardPitch.textContent = 'Nice — next note…';
    els.promptCard.classList.remove('listening');
    els.promptCard.classList.add('correct');

    window.setTimeout(() => {
      if (session?.active) nextTarget();
    }, NEXT_DELAY_MS);
  }

  function showMicError(message) {
    els.micError.hidden = false;
    els.micError.textContent = message;
  }

  function micErrorMessage(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone access was denied. Allow the mic for this site in Safari Settings, then try again.';
    }
    if (name === 'NotFoundError') {
      return 'No microphone found on this device.';
    }
    if (!window.isSecureContext) {
      return 'Safari only allows the microphone on HTTPS (or localhost). Serve this app over HTTPS.';
    }
    return 'Could not start the microphone. Check permissions and try again.';
  }

  // Expose for debugging
  window.__trainer = {
    getState: () => state,
    getSession: () => session,
    DEFAULT_CONFIG,
    STRING_LABELS,
  };

  init();
})();
