/**
 * Microphone pitch detection via autocorrelation (Safari / iOS friendly).
 * Supports ambient noise calibration (RMS gate + spectral residual check).
 */

const DEFAULT_OPTIONS = {
  bufferSize: 2048,
  minHz: 70,
  maxHz: 1200,
  clarityThreshold: 0.88,
  rmsThreshold: 0.01,
  highpassHz: 75,
  noiseMargin: 2.4,
  spectralOverSubtract: 1.6,
  residualRatio: 0.45,
};

class PitchDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.audioContext = null;
    this.analyser = null;
    this.highpass = null;
    this.mediaStream = null;
    this.source = null;
    this.buffer = null;
    this.freqDb = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null;
    this.calibrating = false;

    /** @type {{ rms: number, clarity: number, spectrum: Float32Array|null, sampleRate: number, at: number } | null} */
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

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
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
    highpass.Q.value = 0.707;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.options.bufferSize * 2;
    analyser.smoothingTimeConstant = 0;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(highpass);
    highpass.connect(analyser);

    this.audioContext = ctx;
    this.analyser = analyser;
    this.highpass = highpass;
    this.mediaStream = stream;
    this.source = source;
    this.buffer = new Float32Array(analyser.fftSize);
    this.freqDb = new Float32Array(analyser.frequencyBinCount);
  }

  /**
   * Sample ambient audio and build a noise profile used to gate / cancel background.
   * Stay quiet (no guitar) while this runs — fans/AC are fine.
   */
  async calibrateNoise(durationMs = 1800, onProgress) {
    await this.ensureMic();

    const wasRunning = this.running;
    const previousOnPitch = this.onPitch;
    this.calibrating = true;
    this.onPitch = null;

    if (!wasRunning) {
      this.running = true;
      this.loop();
    }

    const rmsSamples = [];
    const claritySamples = [];
    const spectrumSum = new Float32Array(this.analyser.frequencyBinCount);
    let frames = 0;
    const started = performance.now();

    await new Promise((resolve) => {
      const collect = () => {
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
      frames > 0
        ? Float32Array.from(spectrumSum, (v) => v / frames)
        : null;

    this.noiseProfile = {
      rms: Math.max(p90, 0.0008),
      clarity: maxClarity,
      spectrum,
      sampleRate: this.audioContext.sampleRate,
      at: Date.now(),
    };

    this.calibrating = false;
    this.onPitch = previousOnPitch;

    if (!wasRunning) {
      // Keep mic open so training can start immediately; caller may stop.
    }

    return {
      rms: this.noiseProfile.rms,
      clarity: this.noiseProfile.clarity,
      durationMs,
    };
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
    this.freqDb = null;
    // Keep noiseProfile so recalibration isn't required every session restart
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
      return { frequency: null, clarity: 0, rms: 0, gated: true };
    }

    analyser.getFloatTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);

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
      return { frequency: null, clarity: 0, rms, gated: true };
    }

    if (!forCalibration && this.noiseProfile?.spectrum && spectrumPower) {
      const residualOk = this.hasGuitarResidual(spectrumPower, ctx.sampleRate);
      if (!residualOk) {
        return { frequency: null, clarity: 0, rms, gated: true, reason: 'noise' };
      }
    }

    const sampleRate = ctx.sampleRate;
    const minLag = Math.floor(sampleRate / this.options.maxHz);
    const maxLag = Math.min(
      Math.floor(sampleRate / this.options.minHz),
      buffer.length - 1
    );

    let r0 = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      r0 += buffer[i] * buffer[i];
    }
    if (r0 <= 0) {
      return { frequency: null, clarity: 0, rms, spectrumPower };
    }

    let bestLag = -1;
    let bestCorr = 0;
    let foundValley = false;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      for (let i = 0; i < buffer.length - lag; i += 1) {
        corr += buffer[i] * buffer[i + lag];
      }
      corr /= r0;

      if (!foundValley) {
        if (corr < 0.2) foundValley = true;
        continue;
      }

      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    const clarityThreshold = forCalibration
      ? 0.5
      : this.effectiveClarityThreshold();

    if (bestLag < 0 || bestCorr < clarityThreshold) {
      return {
        frequency: null,
        clarity: bestCorr,
        rms,
        spectrumPower,
        gated: !forCalibration,
      };
    }

    const lag = bestLag;
    const y0 = autocorrAt(buffer, lag - 1, r0);
    const y1 = bestCorr;
    const y2 = autocorrAt(buffer, lag + 1, r0);
    const denom = 2 * (2 * y1 - y0 - y2);
    let refinedLag = lag;
    if (denom !== 0) {
      const delta = (y0 - y2) / denom;
      if (Math.abs(delta) < 1) {
        refinedLag = lag + delta;
      }
    }

    const frequency = sampleRate / refinedLag;
    if (frequency < this.options.minHz || frequency > this.options.maxHz) {
      return {
        frequency: null,
        clarity: bestCorr,
        rms,
        spectrumPower,
      };
    }

    return {
      frequency,
      clarity: bestCorr,
      rms,
      spectrumPower,
      gated: false,
    };
  }

  effectiveRmsThreshold() {
    const base = this.options.rmsThreshold;
    if (!this.noiseProfile) return base;
    return Math.max(base, this.noiseProfile.rms * this.options.noiseMargin);
  }

  effectiveClarityThreshold() {
    const base = this.options.clarityThreshold;
    if (!this.noiseProfile) return base;
    // Ambient may look weakly periodic (fan blades); require clearer peaks than that.
    return Math.min(0.97, Math.max(base, this.noiseProfile.clarity + 0.06));
  }

  hasGuitarResidual(spectrumPower, sampleRate) {
    const noise = this.noiseProfile?.spectrum;
    if (!noise || noise.length !== spectrumPower.length) return true;

    const binHz = sampleRate / (this.analyser.fftSize);
    let residual = 0;
    let noiseEnergy = 0;
    const over = this.options.spectralOverSubtract;

    for (let i = 0; i < spectrumPower.length; i += 1) {
      const hz = i * binHz;
      if (hz < this.options.minHz || hz > this.options.maxHz) continue;
      const n = noise[i] * over;
      noiseEnergy += noise[i];
      residual += Math.max(0, spectrumPower[i] - n);
    }

    if (noiseEnergy <= 0) return true;
    return residual / noiseEnergy >= this.options.residualRatio;
  }
}

function dbToPower(db) {
  // Analyser dB values are typically negative; clamp extremes.
  const clamped = Math.max(-100, Math.min(0, db));
  return 10 ** (clamped / 10);
}

function autocorrAt(buffer, lag, r0) {
  if (lag < 1 || lag >= buffer.length) return 0;
  let corr = 0;
  for (let i = 0; i < buffer.length - lag; i += 1) {
    corr += buffer[i] * buffer[i + lag];
  }
  return corr / r0;
}

window.PitchDetector = PitchDetector;
