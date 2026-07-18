/**
 * Microphone pitch detection (Safari / iOS friendly).
 * Uses YIN for guitar fundamentals + optional ambient noise gating.
 */

const DEFAULT_OPTIONS = {
  bufferSize: 2048,
  minHz: 70,
  maxHz: 1400,
  // Guitar notes are often less "pure" than sine tones — keep this modest.
  clarityThreshold: 0.78,
  // Threshold is measured after mic gain — keep low for unamplified electrics.
  rmsThreshold: 0.0007,
  highpassHz: 65,
  noiseMargin: 1.45,
  spectralOverSubtract: 1.25,
  residualRatio: 0.1,
  yinThreshold: 0.15,
  // Extra digital gain for quiet sources (unamplified electric, distant mic).
  micGain: 12,
  maxMicGain: 100,
};

class PitchDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.audioContext = null;
    this.analyser = null;
    this.highpass = null;
    this.inputGain = null;
    this.mediaStream = null;
    this.source = null;
    this.buffer = null;
    this.yinBuffer = null;
    this.freqDb = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null;
    this.calibrating = false;
    this.micGain = Math.max(1, Number(this.options.micGain) || DEFAULT_OPTIONS.micGain);

    /** @type {{ rms: number, clarity: number, spectrum: Float32Array|null, sampleRate: number, at: number, gain: number } | null} */
    this.noiseProfile = null;
  }

  get hasNoiseProfile() {
    return Boolean(this.noiseProfile);
  }

  async start(onPitch) {
    if (this.running) {
      this.onPitch = onPitch;
      return;
    }
    this.onPitch = onPitch;
    await this.ensureMic();
    this.running = true;
    this.loop();
  }

  async ensureMic() {
    if (this.audioContext && this.analyser) {
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      return;
    }

    // Prefer raw mic, but allow the browser to use AGC if needed for quiet guitars.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = this.options.highpassHz;
    highpass.Q.value = 0.7;

    const inputGain = ctx.createGain();
    inputGain.gain.value = this.micGain;

    const analyser = ctx.createAnalyser();
    // Larger FFT → longer time window → better low-E resolution
    analyser.fftSize = this.options.bufferSize * 2;
    analyser.smoothingTimeConstant = 0;

    const source = ctx.createMediaStreamSource(stream);
    // mic → highpass → gain → analyser (gain boosts quiet unamplified electrics)
    source.connect(highpass);
    highpass.connect(inputGain);
    inputGain.connect(analyser);

    this.audioContext = ctx;
    this.analyser = analyser;
    this.highpass = highpass;
    this.inputGain = inputGain;
    this.mediaStream = stream;
    this.source = source;
    this.buffer = new Float32Array(analyser.fftSize);
    this.yinBuffer = new Float32Array(Math.floor(analyser.fftSize / 2));
    this.freqDb = new Float32Array(analyser.frequencyBinCount);
  }

  /** Live mic preamp gain. Applies immediately if the graph is open. */
  setMicGain(gain) {
    const maxGain = this.options.maxMicGain || 100;
    const next = Math.max(1, Math.min(maxGain, Number(gain) || 1));
    this.micGain = next;
    this.options.micGain = next;
    if (this.inputGain && this.audioContext) {
      const now = this.audioContext.currentTime;
      this.inputGain.gain.cancelScheduledValues(now);
      this.inputGain.gain.setTargetAtTime(next, now, 0.02);
    }
  }

  getMicGain() {
    return this.micGain;
  }

  async beginCalibration() {
    await this.ensureMic();
    this._calibrationPrevOnPitch = this.onPitch;
    this._calibrationWasRunning = this.running;
    this.calibrating = true;
    this.onPitch = null;
    if (!this.running) {
      this.running = true;
      this.loop();
    }
  }

  endCalibration() {
    this.calibrating = false;
    this.onPitch = this._calibrationPrevOnPitch || null;
    this._calibrationPrevOnPitch = null;
    this._calibrationWasRunning = false;
  }

  /**
   * Sample ambient audio at the current mic gain.
   * Stay quiet (no guitar) while this runs — fans/AC are fine.
   */
  async sampleAmbient(durationMs = 1800, onProgress, shouldAbort) {
    if (!this.calibrating) await this.beginCalibration();

    const rmsSamples = [];
    const claritySamples = [];
    const spectrumSum = new Float32Array(this.analyser.frequencyBinCount);
    let frames = 0;
    const started = performance.now();

    await new Promise((resolve, reject) => {
      const collect = () => {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
          reject(new Error('CALIBRATION_CANCELLED'));
          return;
        }
        const elapsed = performance.now() - started;
        if (typeof onProgress === 'function') {
          onProgress(Math.min(1, elapsed / durationMs));
        }

        const frame = this.measureFrame({ forCalibration: true });
        rmsSamples.push(frame.rms);
        if (frame.clarity > 0) claritySamples.push(frame.clarity);
        if (frame.spectrumPower) {
          for (let i = 0; i < spectrumSum.length; i += 1) {
            spectrumSum[i] += frame.spectrumPower[i];
          }
          frames += 1;
        }

        if (elapsed >= durationMs) {
          resolve();
          return;
        }
        requestAnimationFrame(collect);
      };
      requestAnimationFrame(collect);
    });

    rmsSamples.sort((a, b) => a - b);
    const p90 = rmsSamples[Math.min(rmsSamples.length - 1, Math.floor(rmsSamples.length * 0.9))];
    const maxClarity = claritySamples.length
      ? claritySamples.reduce((m, v) => Math.max(m, v), 0)
      : 0;
    const spectrum =
      frames > 0 ? Float32Array.from(spectrumSum, (v) => v / frames) : null;

    return {
      rms: Math.max(p90, 0.0005),
      clarity: maxClarity,
      spectrum,
      sampleRate: this.audioContext.sampleRate,
      gain: this.micGain,
      durationMs,
    };
  }

  /**
   * Cue the player on each beat and capture peak RMS / peak absolute level
   * of notes played above the noise floor.
   */
  async samplePlayPeaks({
    durationMs = 7000,
    beatMs = 1000,
    noiseRms = 0.001,
    onBeat,
    onProgress,
    shouldAbort,
  } = {}) {
    if (!this.calibrating) await this.beginCalibration();

    const gate = Math.max(noiseRms * 2.5, 0.0012);
    const beatPeaks = [];
    let beatIndex = -1;
    let beatPeakRms = 0;
    let beatPeakAbs = 0;
    let beatHadSignal = false;
    const started = performance.now();
    let nextBeatAt = started;

    await new Promise((resolve, reject) => {
      const collect = () => {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
          reject(new Error('CALIBRATION_CANCELLED'));
          return;
        }
        const now = performance.now();
        const elapsed = now - started;

        while (now >= nextBeatAt && elapsed < durationMs) {
          if (beatIndex >= 0 && beatHadSignal) {
            beatPeaks.push({ rms: beatPeakRms, peak: beatPeakAbs, beat: beatIndex });
          }
          beatIndex += 1;
          beatPeakRms = 0;
          beatPeakAbs = 0;
          beatHadSignal = false;
          if (typeof onBeat === 'function') {
            onBeat({
              beat: beatIndex,
              totalBeats: Math.ceil(durationMs / beatMs),
              elapsed,
            });
          }
          nextBeatAt += beatMs;
        }

        if (typeof onProgress === 'function') {
          onProgress(Math.min(1, elapsed / durationMs));
        }

        const frame = this.measureFrame({ forCalibration: true });
        // peak from analyser buffer
        let peakAbs = 0;
        if (this.buffer) {
          for (let i = 0; i < this.buffer.length; i += 1) {
            const a = Math.abs(this.buffer[i]);
            if (a > peakAbs) peakAbs = a;
          }
        }

        if (frame.rms >= gate) {
          beatHadSignal = true;
          if (frame.rms > beatPeakRms) beatPeakRms = frame.rms;
          if (peakAbs > beatPeakAbs) beatPeakAbs = peakAbs;
        }

        if (elapsed >= durationMs) {
          if (beatIndex >= 0 && beatHadSignal) {
            beatPeaks.push({ rms: beatPeakRms, peak: beatPeakAbs, beat: beatIndex });
          }
          resolve();
          return;
        }
        requestAnimationFrame(collect);
      };
      requestAnimationFrame(collect);
    });

    const rmsValues = beatPeaks.map((p) => p.rms).sort((a, b) => a - b);
    const peakValues = beatPeaks.map((p) => p.peak).sort((a, b) => a - b);
    const median = (arr) => {
      if (!arr.length) return 0;
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };

    return {
      beatsHeard: beatPeaks.length,
      beatPeaks,
      signalRms: median(rmsValues),
      signalPeak: median(peakValues),
      maxSignalRms: rmsValues.length ? rmsValues[rmsValues.length - 1] : 0,
      maxSignalPeak: peakValues.length ? peakValues[peakValues.length - 1] : 0,
      gate,
      gain: this.micGain,
      durationMs,
    };
  }

  /**
   * Choose a mic gain so typical plucks land near targetRms without clipping.
   */
  computeAutoGain({
    signalRms,
    signalPeak,
    noiseRms,
    targetRms = 0.16,
    maxPeak = 0.9,
    minGain = 1,
    maxGain = this.options.maxMicGain || 100,
  }) {
    const usableSignal = Math.max(signalRms, 0.00025);
    let gain = targetRms / usableSignal;

    // Prefer RMS target; only peak-limit when peaks are extreme relative to RMS
    // (avoids under-gaining quiet electrics with a sharp attack spike).
    if (signalPeak > 0 && signalPeak > usableSignal * 8) {
      const peakLimited = maxPeak / signalPeak;
      gain = Math.min(gain, peakLimited);
    }

    // Keep guitar clearly above noise after gain.
    const minOverNoise = (noiseRms * 10) / usableSignal;
    if (Number.isFinite(minOverNoise)) {
      gain = Math.max(gain, minOverNoise);
    }

    gain = Math.max(minGain, Math.min(maxGain, gain));
    // Round to slider steps (0.5×)
    return Math.round(gain * 2) / 2;
  }

  applyNoiseProfile(ambient, { gain = this.micGain } = {}) {
    const measureGain = ambient.gain || 1;
    const scale = gain / measureGain;
    const spectrum = ambient.spectrum
      ? Float32Array.from(ambient.spectrum, (v) => v * scale * scale)
      : null;

    this.noiseProfile = {
      rms: Math.max(ambient.rms * scale, 0.0005),
      clarity: ambient.clarity || 0,
      spectrum,
      sampleRate: ambient.sampleRate || this.audioContext?.sampleRate || 0,
      gain,
      at: Date.now(),
    };
    return this.noiseProfile;
  }

  /**
   * Back-compat: ambient-only calibration at the current gain.
   */
  async calibrateNoise(durationMs = 1800, onProgress) {
    await this.beginCalibration();
    try {
      const ambient = await this.sampleAmbient(durationMs, onProgress);
      this.applyNoiseProfile(ambient, { gain: this.micGain });
      return {
        rms: this.noiseProfile.rms,
        clarity: this.noiseProfile.clarity,
        durationMs,
      };
    } finally {
      this.endCalibration();
    }
  }

  clearNoiseProfile() {
    this.noiseProfile = null;
  }

  stop() {
    this.running = false;
    this.calibrating = false;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.highpass) {
      try {
        this.highpass.disconnect();
      } catch {
        /* ignore */
      }
      this.highpass = null;
    }
    if (this.inputGain) {
      try {
        this.inputGain.disconnect();
      } catch {
        /* ignore */
      }
      this.inputGain = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.analyser = null;
    this.buffer = null;
    this.yinBuffer = null;
    this.freqDb = null;
  }

  loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this.loop());
    if (this.calibrating || typeof this.onPitch !== 'function') return;

    const result = this.detect();
    this.onPitch(result);
  }

  detect() {
    return this.measureFrame({ forCalibration: false });
  }

  measureFrame({ forCalibration }) {
    const analyser = this.analyser;
    const buffer = this.buffer;
    const ctx = this.audioContext;
    if (!analyser || !buffer || !ctx) {
      return { frequency: null, clarity: 0, rms: 0, level: 0, gated: true };
    }

    analyser.getFloatTimeDomainData(buffer);

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const v = buffer[i];
      sumSquares += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    // UI level 0–1: blend peak + rms so quiet plucks still move the meter
    const level = Math.min(1, Math.max(rms * 14, peak * 2.2));

    let spectrumPower = null;
    if (this.freqDb) {
      analyser.getFloatFrequencyData(this.freqDb);
      spectrumPower = new Float32Array(this.freqDb.length);
      for (let i = 0; i < this.freqDb.length; i += 1) {
        spectrumPower[i] = dbToPower(this.freqDb[i]);
      }
    }

    const rmsThreshold = this.effectiveRmsThreshold();
    if (!forCalibration && rms < rmsThreshold) {
      return {
        frequency: null,
        clarity: 0,
        rms,
        level,
        gated: true,
        reason: 'quiet',
      };
    }

    if (!forCalibration && this.noiseProfile?.spectrum && spectrumPower) {
      const residualOk = this.hasGuitarResidual(spectrumPower, ctx.sampleRate);
      if (!residualOk) {
        return {
          frequency: null,
          clarity: 0,
          rms,
          level,
          gated: true,
          reason: 'noise',
        };
      }
    }

    const pitch = detectPitchYin(buffer, ctx.sampleRate, this.yinBuffer, this.options);
    if (!pitch) {
      return {
        frequency: null,
        clarity: 0,
        rms,
        level,
        spectrumPower,
        gated: !forCalibration,
        reason: 'unclear',
      };
    }

    const clarityThreshold = forCalibration ? 0.45 : this.effectiveClarityThreshold();
    if (pitch.clarity < clarityThreshold) {
      return {
        frequency: null,
        clarity: pitch.clarity,
        rms,
        level,
        spectrumPower,
        gated: !forCalibration,
        reason: 'unclear',
      };
    }

    return {
      frequency: pitch.frequency,
      clarity: pitch.clarity,
      rms,
      level,
      spectrumPower,
      gated: false,
    };
  }

  effectiveRmsThreshold() {
    const base = this.options.rmsThreshold;
    if (!this.noiseProfile) return base;
    // Scale noise floor if mic gain changed since calibration.
    const calGain = this.noiseProfile.gain || 1;
    const gainScale = this.micGain / calGain;
    const fromNoise = this.noiseProfile.rms * gainScale * this.options.noiseMargin;
    // Cap so a loud fan calibration cannot mute the guitar entirely.
    return Math.min(0.03, Math.max(base, fromNoise));
  }

  effectiveClarityThreshold() {
    const base = this.options.clarityThreshold;
    if (!this.noiseProfile) return base;
    return Math.min(0.88, Math.max(base, this.noiseProfile.clarity + 0.03));
  }

  hasGuitarResidual(spectrumPower, sampleRate) {
    const noise = this.noiseProfile?.spectrum;
    if (!noise || noise.length !== spectrumPower.length) return true;

    const binHz = sampleRate / this.analyser.fftSize;
    let residual = 0;
    let noiseEnergy = 0;
    const over = this.options.spectralOverSubtract;

    for (let i = 0; i < spectrumPower.length; i += 1) {
      const hz = i * binHz;
      if (hz < this.options.minHz || hz > this.options.maxHz) continue;
      noiseEnergy += noise[i];
      residual += Math.max(0, spectrumPower[i] - noise[i] * over);
    }

    if (noiseEnergy <= 0) return true;
    return residual / noiseEnergy >= this.options.residualRatio;
  }
}

/**
 * YIN pitch detection (de Cheveigné & Kawahara).
 * More reliable on guitar than plain autocorrelation.
 */
function detectPitchYin(buffer, sampleRate, yinBuffer, options) {
  const half = Math.min(yinBuffer.length, Math.floor(buffer.length / 2));
  if (half < 32) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / options.maxHz));
  const maxTau = Math.min(half - 1, Math.floor(sampleRate / options.minHz));
  if (maxTau <= minTau) return null;

  // Difference function
  yinBuffer[0] = 0;
  for (let tau = 1; tau < half; tau += 1) {
    let sum = 0;
    for (let i = 0; i < half; i += 1) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // Cumulative mean normalized difference
  let runningSum = 0;
  yinBuffer[0] = 1;
  for (let tau = 1; tau < half; tau += 1) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = runningSum > 0 ? (yinBuffer[tau] * tau) / runningSum : 1;
  }

  const threshold = options.yinThreshold;
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    if (yinBuffer[tau] < threshold) {
      while (tau + 1 <= maxTau && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau += 1;
      }
      tauEstimate = tau;
      break;
    }
  }

  // Fallback: absolute minimum in range if nothing crossed threshold
  if (tauEstimate < 0) {
    let best = minTau;
    for (let tau = minTau + 1; tau <= maxTau; tau += 1) {
      if (yinBuffer[tau] < yinBuffer[best]) best = tau;
    }
    if (yinBuffer[best] < 0.35) tauEstimate = best;
  }

  if (tauEstimate < 0) return null;

  const betterTau = parabolicInterpolate(yinBuffer, tauEstimate);
  const frequency = sampleRate / betterTau;
  if (frequency < options.minHz || frequency > options.maxHz) return null;

  const yinValue = yinBuffer[tauEstimate];
  const clarity = Math.max(0, Math.min(1, 1 - yinValue));
  return { frequency, clarity };
}

function parabolicInterpolate(array, tau) {
  const x0 = tau < 1 ? tau : tau - 1;
  const x2 = tau + 1 < array.length ? tau + 1 : tau;
  if (x0 === tau) return tau;
  if (x2 === tau) return tau;
  const s0 = array[x0];
  const s1 = array[tau];
  const s2 = array[x2];
  const denom = 2 * s1 - s2 - s0;
  if (denom === 0) return tau;
  return tau + (s2 - s0) / (2 * denom);
}

function dbToPower(db) {
  const clamped = Math.max(-100, Math.min(0, db));
  return 10 ** (clamped / 10);
}

window.PitchDetector = PitchDetector;
