/**
 * Phone-based guitar tone simulator for training without a physical guitar.
 */

class ToneSimulator {
  constructor() {
    this.audioContext = null;
    this.oscillator = null;
    this.gain = null;
    this.playing = false;
    this.frequency = 110;
    this._digitalRaf = null;
    this._onDigitalPitch = null;
  }

  get isPlaying() {
    return this.playing;
  }

  async ensureContext() {
    if (this.audioContext) {
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      return this.audioContext;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  async start(frequencyHz) {
    await this.ensureContext();
    if (this.playing) {
      this.setFrequency(frequencyHz);
      return;
    }

    const ctx = this.audioContext;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequencyHz;

    const gain = ctx.createGain();
    // Soft enough for phone speaker loopback without blasting
    gain.gain.value = 0.12;

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    this.oscillator = osc;
    this.gain = gain;
    this.frequency = frequencyHz;
    this.playing = true;
  }

  setFrequency(frequencyHz) {
    const hz = Math.max(40, Math.min(2000, Number(frequencyHz) || 110));
    this.frequency = hz;
    if (this.oscillator && this.audioContext) {
      const now = this.audioContext.currentTime;
      this.oscillator.frequency.cancelScheduledValues(now);
      this.oscillator.frequency.setTargetAtTime(hz, now, 0.01);
    }
  }

  getFrequency() {
    if (this.oscillator) {
      return this.oscillator.frequency.value;
    }
    return this.frequency;
  }

  /**
   * Digital path: report the generated tone frequency directly (no microphone).
   */
  startDigitalFeed(onPitch) {
    this._onDigitalPitch = onPitch;
    if (this._digitalRaf != null) return;

    const tick = () => {
      this._digitalRaf = requestAnimationFrame(tick);
      if (typeof this._onDigitalPitch !== 'function') return;
      if (!this.playing) {
        this._onDigitalPitch({ frequency: null, clarity: 0, rms: 0, source: 'digital' });
        return;
      }
      this._onDigitalPitch({
        frequency: this.getFrequency(),
        clarity: 1,
        rms: 1,
        source: 'digital',
      });
    };
    this._digitalRaf = requestAnimationFrame(tick);
  }

  stopDigitalFeed() {
    this._onDigitalPitch = null;
    if (this._digitalRaf != null) {
      cancelAnimationFrame(this._digitalRaf);
      this._digitalRaf = null;
    }
  }

  stop() {
    this.stopDigitalFeed();
    if (this.oscillator) {
      try {
        this.oscillator.stop();
        this.oscillator.disconnect();
      } catch {
        /* ignore */
      }
      this.oscillator = null;
    }
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.gain = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.playing = false;
  }
}

window.ToneSimulator = ToneSimulator;
