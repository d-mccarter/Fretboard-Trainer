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

  const CENTS_TOLERANCE = 25;
  const MAX_MIC_GAIN = 100;
  const MATCH_MS = 50;
  const NEXT_DELAY_MS = 550;
  const CALIBRATE_NOISE_MS = 2000;
  const CALIBRATE_PLAY_MS = 7000;
  const CALIBRATE_BEAT_MS = 500;
  const CALIBRATE_REF_GAIN = 1;

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
    micMeter: document.getElementById('mic-meter'),
    micMeterBar: document.getElementById('mic-meter-bar'),
    micMeterLabel: document.getElementById('mic-meter-label'),
    simWarningIdle: document.getElementById('sim-warning-idle'),
    micGainSlider: document.getElementById('mic-gain-slider'),
    micGainValue: document.getElementById('mic-gain-value'),
    liveGainRow: document.getElementById('live-gain-row'),
    liveMicGainSlider: document.getElementById('live-mic-gain-slider'),
    liveMicGainValue: document.getElementById('live-mic-gain-value'),
    calibrateModal: document.getElementById('calibrate-modal'),
    calibratePhaseText: document.getElementById('calibrate-phase-text'),
    calibrateLight: document.getElementById('calibrate-light'),
    calibrateBeatLabel: document.getElementById('calibrate-beat-label'),
    calibrateProgressBar: document.getElementById('calibrate-progress-bar'),
    calibrateCancelBtn: document.getElementById('calibrate-cancel-btn'),
  };

  let calibrationCancel = null;

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
    if (view === 'train') renderIdleHints();
  }

  function renderIdleHints() {
    if (!els.simWarningIdle) return;
    els.simWarningIdle.hidden = !state.config.simulatorEnabled;
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

    els.calibrateBtn.addEventListener('click', () => startMicCalibration());
    els.clearNoiseBtn.addEventListener('click', () => clearNoiseProfile());
    els.calibrateCancelBtn.addEventListener('click', () => {
      if (typeof calibrationCancel === 'function') calibrationCancel();
    });

    const onMicGain = () => {
      setMicGain(Number(els.micGainSlider.value));
    };
    els.micGainSlider.addEventListener('input', onMicGain);
    els.micGainSlider.addEventListener('change', onMicGain);
  }

  function bindTrain() {
    els.trainStartBtn.addEventListener('click', () => startSession());
    els.trainSkipBtn.addEventListener('click', () => skipTarget());
    els.trainStopBtn.addEventListener('click', () => stopSession());
    els.calibrateTrainBtn.addEventListener('click', () => startMicCalibration());

    const onSlider = () => {
      if (!session?.active || !state.config.simulatorEnabled) return;
      const midi = Number(els.simPitchSlider.value);
      const hz = midiToFrequency(midi);
      updateSimReadout(midi, hz);
      if (simulator) simulator.setFrequency(hz);
    };
    els.simPitchSlider.addEventListener('input', onSlider);
    els.simPitchSlider.addEventListener('change', onSlider);

    const onLiveGain = () => {
      setMicGain(Number(els.liveMicGainSlider.value));
    };
    els.liveMicGainSlider.addEventListener('input', onLiveGain);
    els.liveMicGainSlider.addEventListener('change', onLiveGain);
  }

  function setMicGain(gain) {
    const next = Math.max(1, Math.min(MAX_MIC_GAIN, Number(gain) || 1));
    state.config.micGain = next;
    persist();
    renderMicGain();
    if (detector) detector.setMicGain(next);
  }

  function renderMicGain() {
    const g = state.config.micGain;
    const label = `${Number(g).toFixed(g % 1 === 0 ? 0 : 1)}×`;
    if (els.micGainSlider) els.micGainSlider.value = String(g);
    if (els.micGainValue) els.micGainValue.textContent = label;
    if (els.liveMicGainSlider) els.liveMicGainSlider.value = String(g);
    if (els.liveMicGainValue) els.liveMicGainValue.textContent = label;
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
      detector = new PitchDetector({ micGain: state.config.micGain });
      applyStoredNoiseProfile(detector);
    }
    detector.setMicGain(state.config.micGain);
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
      gain: state.noiseProfile.gain || state.config.micGain || 1,
      at: state.noiseProfile.at,
    };
  }

  function serializeNoiseProfile(profile) {
    if (!profile) return null;
    return {
      version: 2,
      rms: profile.rms,
      clarity: profile.clarity,
      spectrum: profile.spectrum ? Array.from(profile.spectrum) : null,
      sampleRate: profile.sampleRate,
      gain: profile.gain || state.config.micGain || 1,
      at: profile.at,
    };
  }

  function renderNoiseStatus() {
    const profile = state.noiseProfile;
    if (!profile) {
      els.noiseStatus.textContent = 'Not calibrated yet. Run Calibrate mic before training with a quiet guitar.';
      els.clearNoiseBtn.hidden = true;
      return;
    }
    const ageMin = Math.max(0, Math.round((Date.now() - profile.at) / 60000));
    const ageText = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
    const gainLabel = `${Number(state.config.micGain).toFixed(state.config.micGain % 1 === 0 ? 0 : 1)}×`;
    els.noiseStatus.textContent = `Calibrated · gain ${gainLabel} · floor ${profile.rms.toFixed(4)} · ${ageText}`;
    els.clearNoiseBtn.hidden = false;
  }

  function showCalibrateModal(visible) {
    els.calibrateModal.hidden = !visible;
    if (!visible) {
      els.calibrateLight.classList.remove('pulse', 'quiet');
      els.calibrateBeatLabel.textContent = '';
      els.calibrateProgressBar.style.width = '0%';
    }
  }

  function setCalibrateProgress(progress) {
    els.calibrateProgressBar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }

  function flashCalibrateLight() {
    els.calibrateLight.classList.remove('pulse');
    // Force reflow so repeated pulses animate
    void els.calibrateLight.offsetWidth;
    els.calibrateLight.classList.add('pulse');
    window.setTimeout(() => {
      els.calibrateLight.classList.remove('pulse');
    }, 220);
  }

  async function startMicCalibration() {
    if (session?.active) {
      showMicError('Stop the training session before calibrating the mic.');
      return;
    }

    els.micError.hidden = true;
    els.micError.textContent = '';
    els.calibrateBtn.disabled = true;
    els.calibrateTrainBtn.disabled = true;
    els.clearNoiseBtn.disabled = true;

    let cancelled = false;
    calibrationCancel = () => {
      cancelled = true;
    };

    showCalibrateModal(true);
    els.calibratePhaseText.textContent = 'Phase 1 · Stay quiet while we measure room noise.';
    els.calibrateBeatLabel.textContent = 'Silence please…';
    els.calibrateLight.classList.add('quiet');
    setCalibrateProgress(0);

    const det = getDetector();

    try {
      await det.beginCalibration();
      // Measure noise/signal at unity gain so auto-gain math is stable.
      det.setMicGain(CALIBRATE_REF_GAIN);

      const ambient = await det.sampleAmbient(
        CALIBRATE_NOISE_MS,
        (progress) => {
          setCalibrateProgress(progress * 0.35);
          els.calibrateBeatLabel.textContent = `Measuring noise… ${Math.round(progress * 100)}%`;
        },
        () => cancelled
      );

      els.calibrateLight.classList.remove('quiet');
      els.calibratePhaseText.textContent =
        'Phase 2 · When the light blinks, pluck any note. Keep plucking once per blink.';
      els.calibrateBeatLabel.textContent = 'Get ready…';

      // Brief pause so the user can pick up the guitar
      await waitMs(900, () => cancelled);

      const play = await det.samplePlayPeaks({
        durationMs: CALIBRATE_PLAY_MS,
        beatMs: CALIBRATE_BEAT_MS,
        noiseRms: ambient.rms,
        shouldAbort: () => cancelled,
        onBeat: ({ beat, totalBeats }) => {
          flashCalibrateLight();
          els.calibrateBeatLabel.textContent = `Pluck now · beat ${beat + 1} of ${totalBeats}`;
        },
        onProgress: (progress) => {
          setCalibrateProgress(0.35 + progress * 0.55);
        },
      });

      if (!play.beatsHeard || play.signalRms <= 0) {
        throw new Error('CALIBRATION_NO_SIGNAL');
      }

      els.calibratePhaseText.textContent = 'Setting gain…';
      els.calibrateBeatLabel.textContent = `Heard ${play.beatsHeard} pluck${play.beatsHeard === 1 ? '' : 's'}`;
      setCalibrateProgress(0.95);

      const autoGain = det.computeAutoGain({
        signalRms: play.signalRms,
        signalPeak: play.signalPeak || play.maxSignalPeak,
        noiseRms: ambient.rms,
      });

      det.setMicGain(autoGain);
      state.config.micGain = autoGain;
      const profile = det.applyNoiseProfile(ambient, { gain: autoGain });
      state.noiseProfile = serializeNoiseProfile(profile);
      persist();
      renderMicGain();
      renderNoiseStatus();

      setCalibrateProgress(1);
      els.calibratePhaseText.textContent = 'Calibration complete';
      els.calibrateBeatLabel.textContent = `Gain set to ${autoGain}×`;
      await waitMs(900, () => false);

      els.noiseStatus.textContent = `Calibrated · gain ${autoGain}× · heard ${play.beatsHeard} plucks. Ready to train.`;
    } catch (err) {
      console.error(err);
      if (err?.message === 'CALIBRATION_CANCELLED') {
        els.noiseStatus.textContent = 'Calibration cancelled.';
      } else if (err?.message === 'CALIBRATION_NO_SIGNAL') {
        showMicError('No guitar plucks heard. Hold the phone closer and try again — pluck when the light blinks.');
        els.noiseStatus.textContent = 'Calibration failed — no notes detected.';
      } else {
        showMicError(micErrorMessage(err));
        els.noiseStatus.textContent = 'Calibration failed. Check microphone permission and try again.';
      }
    } finally {
      try {
        det.endCalibration();
      } catch {
        /* ignore */
      }
      if (!session?.active) {
        det.stop();
        applyStoredNoiseProfile(det);
        det.setMicGain(state.config.micGain);
      }
      showCalibrateModal(false);
      calibrationCancel = null;
      els.calibrateBtn.disabled = false;
      els.calibrateTrainBtn.disabled = false;
      els.clearNoiseBtn.disabled = false;
    }
  }

  function waitMs(ms, isCancelled) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        if (isCancelled()) {
          reject(new Error('CALIBRATION_CANCELLED'));
          return;
        }
        if (performance.now() - started >= ms) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
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
    renderMicGain();
    renderIdleHints();
  }

  function renderStats() {
    els.statsCorrect.textContent = String(state.stats.notesCorrect || 0);
    els.statsBest.textContent = String(state.stats.bestStreak || 0);
  }

  function setTrainMode(active) {
    els.trainIdle.hidden = active;
    els.trainActive.hidden = !active;
    const showMeter = active && usesMic();
    if (els.micMeter) els.micMeter.hidden = !showMeter;
    if (els.micMeterLabel) {
      els.micMeterLabel.hidden = !showMeter;
      els.micMeterLabel.textContent = showMeter ? 'Mic level' : '';
    }
    if (els.liveGainRow) els.liveGainRow.hidden = !showMeter;
    if (!showMeter && els.micMeterBar) {
      els.micMeterBar.style.width = '0%';
      els.micMeterBar.classList.remove('hot');
    }
    if (showMeter) renderMicGain();
  }

  function updateMicMeter(level = 0) {
    if (!els.micMeterBar || els.micMeter?.hidden) return;
    const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
    els.micMeterBar.style.width = `${pct}%`;
    els.micMeterBar.classList.toggle('hot', pct > 35);
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
      matchStartedAt: null,
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
    els.heardPitch.textContent = state.config.simulatorEnabled
      ? 'Slide to the note…'
      : 'Play the note…';
    els.promptCard.classList.remove('correct');
    els.promptCard.classList.add('listening');
  }

  function onPitch(result) {
    if (!session?.active || session.advancing || !session.target) return;

    if (usesMic()) {
      updateMicMeter(result.level || 0);
    }

    if (!result.frequency) {
      session.matchStartedAt = null;
      if (result.reason === 'noise') {
        els.listenStatus.textContent = 'Noise gated';
        els.heardPitch.textContent = 'Background is masking the note — recalibrate or play louder';
      } else if (result.reason === 'quiet') {
        els.listenStatus.textContent = 'Listening';
        els.heardPitch.textContent = 'Play closer / louder…';
      } else if (result.reason === 'unclear') {
        els.listenStatus.textContent = 'Listening';
        els.heardPitch.textContent = 'Hearing sound — hold a single note…';
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
      if (!session.matchStartedAt) {
        session.matchStartedAt = performance.now();
        els.listenStatus.textContent = 'Locked…';
      } else if (performance.now() - session.matchStartedAt >= MATCH_MS) {
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
