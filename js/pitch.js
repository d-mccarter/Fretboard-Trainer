/**
 * Microphone pitch detection via autocorrelation (Safari / iOS friendly).
 */

const DEFAULT_OPTIONS = {
  bufferSize: 2048,
  minHz: 70,
  maxHz: 1200,
  clarityThreshold: 0.88,
  rmsThreshold: 0.01,
};

class PitchDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.audioContext = null;
    this.analyser = null;
    this.mediaStream = null;
    this.source = null;
    this.buffer = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null;
  }

  async start(onPitch) {
    if (this.running) return;
    this.onPitch = onPitch;

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

    const analyser = ctx.createAnalyser();
    analyser.fftSize = this.options.bufferSize * 2;
    analyser.smoothingTimeConstant = 0;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    this.audioContext = ctx;
    this.analyser = analyser;
    this.mediaStream = stream;
    this.source = source;
    this.buffer = new Float32Array(analyser.fftSize);
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
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
  }

  loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this.loop());

    const result = this.detect();
    if (typeof this.onPitch === 'function') {
      this.onPitch(result);
    }
  }

  detect() {
    const analyser = this.analyser;
    const buffer = this.buffer;
    const ctx = this.audioContext;
    if (!analyser || !buffer || !ctx) {
      return { frequency: null, clarity: 0, rms: 0 };
    }

    analyser.getFloatTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    if (rms < this.options.rmsThreshold) {
      return { frequency: null, clarity: 0, rms };
    }

    const sampleRate = ctx.sampleRate;
    const minLag = Math.floor(sampleRate / this.options.maxHz);
    const maxLag = Math.min(
      Math.floor(sampleRate / this.options.minHz),
      buffer.length - 1
    );

    // Autocorrelation with normalized clarity score
    let bestLag = -1;
    let bestCorr = 0;
    let r0 = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      r0 += buffer[i] * buffer[i];
    }
    if (r0 <= 0) {
      return { frequency: null, clarity: 0, rms };
    }

    // Skip zero-lag peak: find first valley, then first strong peak
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

    if (bestLag < 0 || bestCorr < this.options.clarityThreshold) {
      return { frequency: null, clarity: bestCorr, rms };
    }

    // Parabolic interpolation around the peak for sub-sample period
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
      return { frequency: null, clarity: bestCorr, rms };
    }

    return { frequency, clarity: bestCorr, rms };
  }
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
