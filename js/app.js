(() => {
  const {
    buildPositionPool,
    describeLocation,
    frequencyToMidi,
    midiToFrequency,
    midiToNoteName,
    formatCents,
    STRING_LABELS,
  } = window.Fretboard;
  const { loadState, saveState, DEFAULT_CONFIG } = window.TrainerStorage;
  const PitchDetector = window.PitchDetector;
  const ToneSimulator = window.ToneSimulator;

  const CENTS_TOLERANCE = 10;
  const MATCH_FRAMES = 2;
  const NEXT_DELAY_MS = 550;
  const CALIBRATE_MS = 1800;

  const state = loadState();
  let currentView = 'configure';
  let detector = null;
  let simulator = null;
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
    simulatorEnabled: document.getElementById('simulator-enabled'),
    simulatorOptions: document.getElementById('simulator-options'),
    simulatorInputBtns: [...document.querySelectorAll('[data-sim-input]')],
    simulatorInputHint: document.getElementById('simulator-input-hint'),
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
    calibrateBtn: document.getElementById('calibrate-noise-btn'),
    clearNoiseBtn: document.getElementById('clear-noise-btn'),
    noiseStatus: document.getElementById('noise-status'),
    calibrateTrainBtn: document.getElementById('calibrate-noise-train-btn'),
    simulatorCard: document.getElementById('simulator-card'),
    simulatorModeLabel: document.getElementById('simulator-mode-label'),
    simPitchSlider: document.getElementById('sim-pitch-slider'),
    simNoteLabel: document.getElementById('sim-note-label'),
    simFreqLabel: document.getElementById('sim-freq-label'),
    simRangeLow: document.getElementById('sim-range-low'),
    simRangeHigh: document.getElementById('sim-range-high'),
  };

  function init() {
    loadBuildLabel();
    bindNav();
    bindConfigure();
    bindTrain();
    renderConfigure();
    renderStats();
    renderNoiseStatus();
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

    els.simulatorEnabled.addEventListener('click', () => {
      state.config.simulatorEnabled = !state.config.simulatorEnabled;
      persist();
      renderConfigure();
    });

    els.simulatorInputBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.config.simulatorInput = btn.dataset.simInput;
        persist();
        renderConfigure();
      });
    });

    els.startTrainBtn.addEventListener('click', () => {
      showView('train');
      startSession();
    });

    els.calibrateBtn.addEventListener('click', () => calibrateNoise());
    els.clearNoiseBtn.addEventListener('click', () => clearNoiseProfile());
  }

  function bindTrain() {
    els.trainStartBtn.addEventListener('click', () => startSession());
    els.trainSkipBtn.addEventListener('click', () => skipTarget());
    els.trainStopBtn.addEventListener('click', () => stopSession());
    els.calibrateTrainBtn.addEventListener('click', () => calibrateNoise());

    const onSlider = () => {
      if (!session?.active || !state.config.simulatorEnabled) return;
      const midi = Number(els.simPitchSlider.value);
      const hz = midiToFrequency(midi);
      updateSimReadout(midi, hz);
      if (simulator) simulator.setFrequency(hz);
    };
    els.simPitchSlider.addEventListener('input', onSlider);
    els.simPitchSlider.addEventListener('change', onSlider);
  }

  function persist() {
    saveState(state);
  }

  function usesMic() {
    if (!state.config.simulatorEnabled) return true;
    return state.config.simulatorInput === 'mic';
  }

  function getDetector() {
    if (!detector) {
      detector = new PitchDetector();
      applyStoredNoiseProfile(detector);
    }
    return detector;
  }

  function getSimulator() {
    if (!simulator) simulator = new ToneSimulator();
    return simulator;
  }

  function applyStoredNoiseProfile(det) {
    if (!state.noiseProfile) {
      det.clearNoiseProfile();
      return;
    }
    const liveRate = det.audioContext?.sampleRate || state.noiseProfile.sampleRate;
    const spectrumOk =
      state.noiseProfile.spectrum &&
      (!liveRate ||
        !state.noiseProfile.sampleRate ||
        Math.abs(liveRate - state.noiseProfile.sampleRate) < 1);

    det.noiseProfile = {
      rms: state.noiseProfile.rms,
      clarity: state.noiseProfile.clarity,
      spectrum: spectrumOk ? Float32Array.from(state.noiseProfile.spectrum) : null,
      sampleRate: state.noiseProfile.sampleRate,
      at: state.noiseProfile.at,
    };
  }

  function serializeNoiseProfile(profile) {
    if (!profile) return null;
    return {
      rms: profile.rms,
      clarity: profile.clarity,
      spectrum: profile.spectrum ? Array.from(profile.spectrum) : null,
      sampleRate: profile.sampleRate,
      at: profile.at,
    };
  }

  function renderNoiseStatus() {
    const profile = state.noiseProfile;
    if (!profile) {
      els.noiseStatus.textContent = 'No noise profile yet. Calibrate with your fan/room noise running and the guitar silent.';
      els.clearNoiseBtn.hidden = true;
      return;
    }
    const ageMin = Math.max(0, Math.round((Date.now() - profile.at) / 60000));
    const ageText = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
    els.noiseStatus.textContent = `Noise profile active · floor ${profile.rms.toFixed(4)} · set ${ageText}`;
    els.clearNoiseBtn.hidden = false;
  }

  async function calibrateNoise() {
    els.micError.hidden = true;
    els.micError.textContent = '';
    els.noiseStatus.textContent = 'Calibrating… stay quiet (fan is fine).';
    els.calibrateBtn.disabled = true;
    els.calibrateTrainBtn.disabled = true;
    els.clearNoiseBtn.disabled = true;

    try {
      const det = getDetector();
      const result = await det.calibrateNoise(CALIBRATE_MS, (progress) => {
        const pct = Math.round(progress * 100);
        els.noiseStatus.textContent = `Calibrating… ${pct}% — stay quiet`;
      });

      state.noiseProfile = serializeNoiseProfile(det.noiseProfile);
      persist();
      renderNoiseStatus();
      els.noiseStatus.textContent = `Noise profile saved · floor ${result.rms.toFixed(4)}. Ready to train.`;

      if (!session?.active) {
        det.stop();
        applyStoredNoiseProfile(det);
      }
    } catch (err) {
      console.error(err);
      showMicError(micErrorMessage(err));
      els.noiseStatus.textContent = 'Calibration failed. Check microphone permission and try again.';
    } finally {
      els.calibrateBtn.disabled = false;
      els.calibrateTrainBtn.disabled = false;
      els.clearNoiseBtn.disabled = false;
    }
  }

  function clearNoiseProfile() {
    state.noiseProfile = null;
    if (detector) detector.clearNoiseProfile();
    persist();
    renderNoiseStatus();
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

    els.simulatorEnabled.classList.toggle('on', cfg.simulatorEnabled);
    els.simulatorEnabled.setAttribute('aria-pressed', cfg.simulatorEnabled ? 'true' : 'false');
    els.simulatorEnabled.textContent = cfg.simulatorEnabled ? 'On' : 'Off';
    els.simulatorOptions.hidden = !cfg.simulatorEnabled;

    els.simulatorInputBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.simInput === cfg.simulatorInput);
    });
    els.simulatorInputHint.textContent =
      cfg.simulatorInput === 'mic'
        ? 'Microphone listens to the phone speaker playing the simulated tone.'
        : 'Digital reads the generated tone directly — no mic needed.';

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

  function sliderRangeForPool(pool) {
    const midis = pool.map((p) => p.midi);
    const minMidi = Math.max(28, Math.min(...midis) - 2);
    const maxMidi = Math.min(88, Math.max(...midis) + 2);
    return { minMidi, maxMidi };
  }

  function updateSimReadout(midi, hz) {
    els.simNoteLabel.textContent = midiToNoteName(Math.round(midi));
    els.simFreqLabel.textContent = `${hz.toFixed(1)} Hz`;
  }

  function setupSimulatorUi(pool) {
    const enabled = state.config.simulatorEnabled;
    els.simulatorCard.hidden = !enabled;
    if (!enabled) return;

    const { minMidi, maxMidi } = sliderRangeForPool(pool);
    els.simPitchSlider.min = String(minMidi);
    els.simPitchSlider.max = String(maxMidi);
    els.simRangeLow.textContent = midiToNoteName(Math.round(minMidi));
    els.simRangeHigh.textContent = midiToNoteName(Math.round(maxMidi));

    const mid = (minMidi + maxMidi) / 2;
    els.simPitchSlider.value = String(mid);
    updateSimReadout(mid, midiToFrequency(mid));

    els.simulatorModeLabel.textContent =
      state.config.simulatorInput === 'mic'
        ? 'Mic loopback · drag to match the target (turn volume up)'
        : 'Digital tone · drag to match the target';
  }

  async function startSimulatorTone(pool) {
    const sim = getSimulator();
    const { minMidi, maxMidi } = sliderRangeForPool(pool);
    const midi = Number(els.simPitchSlider.value) || (minMidi + maxMidi) / 2;
    const hz = midiToFrequency(midi);
    await sim.start(hz);
    updateSimReadout(midi, hz);
  }

  async function startSession() {
    const pool = buildPositionPool(state.config);
    if (!pool.length) {
      showMicError('No notes match this configuration. Adjust strings or frets.');
      return;
    }

    els.micError.hidden = true;
    els.micError.textContent = '';

    const needMic = usesMic();

    try {
      if (state.config.simulatorEnabled) {
        setupSimulatorUi(pool);
        await startSimulatorTone(pool);
      } else {
        els.simulatorCard.hidden = true;
        if (simulator) {
          simulator.stop();
          simulator = null;
        }
      }

      if (needMic) {
        const det = getDetector();
        applyStoredNoiseProfile(det);
        if (!session?.listening) {
          await det.start((result) => onPitch(result));
        }
      } else if (detector) {
        detector.stop();
        applyStoredNoiseProfile(detector);
      }

      if (state.config.simulatorEnabled && state.config.simulatorInput === 'digital') {
        getSimulator().startDigitalFeed((result) => onPitch(result));
      } else if (simulator) {
        simulator.stopDigitalFeed();
      }
    } catch (err) {
      console.error(err);
      showMicError(micErrorMessage(err));
      stopSimulatorOnly();
      setTrainMode(false);
      return;
    }

    state.stats.sessionsStarted = (state.stats.sessionsStarted || 0) + 1;
    persist();

    session = {
      active: true,
      listening: needMic,
      pool,
      target: null,
      lastTargetKey: null,
      streak: 0,
      correct: 0,
      matchFrames: 0,
      advancing: false,
    };

    setTrainMode(true);
    els.sessionStreak.textContent = '0';
    els.sessionCorrect.textContent = '0';
    nextTarget();
  }

  function stopSimulatorOnly() {
    if (simulator) {
      simulator.stop();
      simulator = null;
    }
  }

  function stopSession() {
    if (detector) {
      detector.stop();
      applyStoredNoiseProfile(detector);
    }
    stopSimulatorOnly();
    session = null;
    setTrainMode(false);
    els.simulatorCard.hidden = true;
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
    session.matchFrames = 0;
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
    session.matchFrames = 0;
    session.advancing = false;

    const loc = describeLocation(pick, state.config);
    els.noteName.textContent = pick.note;
    els.locationHint.textContent = loc.stringLine;
    els.locationRange.textContent = `Find it in ${loc.rangeLine}`;
    els.listenStatus.textContent = 'Listening';
    els.heardPitch.textContent = state.config.simulatorEnabled
      ? 'Slide to the note…'
      : 'Play the note…';
    els.promptCard.classList.remove('correct');
    els.promptCard.classList.add('listening');
  }

  function onPitch(result) {
    if (!session?.active || session.advancing || !session.target) return;

    if (!result.frequency) {
      session.matchFrames = 0;
      if (result.reason === 'noise') {
        els.listenStatus.textContent = 'Noise gated';
      } else if (els.listenStatus.textContent !== 'Listening') {
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
      session.matchFrames += 1;
      els.listenStatus.textContent =
        session.matchFrames >= MATCH_FRAMES ? 'Correct!' : 'Locked…';
      if (session.matchFrames >= MATCH_FRAMES) {
        registerCorrect();
      }
    } else {
      session.matchFrames = 0;
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

  window.__trainer = {
    getState: () => state,
    getSession: () => session,
    getDetector: () => detector,
    getSimulator: () => simulator,
    DEFAULT_CONFIG,
    STRING_LABELS,
    CENTS_TOLERANCE,
  };

  init();
})();
