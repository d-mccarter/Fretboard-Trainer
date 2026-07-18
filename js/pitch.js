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
  // Phone mics see quiet acoustic plucks well below 0.01 with AGC off.
  rmsThreshold: 0.0015,
  highpassHz: 65,
  noiseMargin: 1.55,
  spectralOverSubtract: 1.25,
  residualRatio: 0.12,
  yinThreshold: 0.15,
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
    this.yinBuffer = null;
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

    const analyser = ctx.createAnalyser();
    // Larger FFT → longer time window → better low-E resolution
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
    this.yinBuffer = new Float32Array(Math.floor(analyser.fftSize / 2));
    this.freqDb = new Float32Array(analyser.frequencyBinCount);
  }

  /**
   * Sample ambient audio and build a noise profile used to gate background.
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
      frames > 0 ? Float32Array.from(spectrumSum, (v) => v / frames) : null;

    this.noiseProfile = {
      rms: Math.max(p90, 0.0005),
      clarity: maxClarity,
      spectrum,
      sampleRate: this.audioContext.sampleRate,
      at: Date.now(),
    };

    this.calibrating = false;
    this.onPitch = previousOnPitch;

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
    // Cap so a loud fan calibration cannot mute the guitar entirely.
    const fromNoise = this.noiseProfile.rms * this.options.noiseMargin;
    return Math.min(0.02, Math.max(base, fromNoise));
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
