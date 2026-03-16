class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions || {};

    this.threshold   = p.threshold   ?? 0.025;
    this.ratio       = p.ratio       ?? 12;
    this.attackTime  = p.attackTime  ?? 0.003;
    this.releaseTime = p.releaseTime ?? 0.15;
    this.holdTime    = p.holdTime    ?? 0.08;
    this.bypass      = p.bypass      ?? false;

    // Per-channel state (lazily sized on first process() call)
    this.envelope    = [];
    this.gateGain    = [];
    this.holdCounter = [];

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'threshold':  this.threshold   = data.value; break;
        case 'ratio':      this.ratio       = data.value; break;
        case 'attack':     this.attackTime  = data.value; break;
        case 'release':    this.releaseTime = data.value; break;
        case 'hold':       this.holdTime    = data.value; break;
        case 'bypass':     this.bypass      = data.value; break;
        case 'settings': {
          const s = data.value;
          if (s.threshold !== undefined) this.threshold   = s.threshold;
          if (s.ratio     !== undefined) this.ratio       = s.ratio;
          if (s.attack    !== undefined) this.attackTime  = s.attack;
          if (s.release   !== undefined) this.releaseTime = s.release;
          if (s.hold      !== undefined) this.holdTime    = s.hold;
          if (s.enabled   !== undefined) this.bypass      = !s.enabled;
          break;
        }
      }
    };
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const numChannels = input.length;

    // Lazily init per-channel state
    if (this.envelope.length !== numChannels) {
      this.envelope    = new Float32Array(numChannels).fill(0);
      this.gateGain    = new Float32Array(numChannels).fill(1);
      this.holdCounter = new Int32Array(numChannels).fill(0);
    }

    // Use actual sampleRate global (correct for 44100/48000/etc.)
    const SR           = sampleRate;
    const attackCoeff  = Math.exp(-1 / (SR * Math.max(0.0001, this.attackTime)));
    const releaseCoeff = Math.exp(-1 / (SR * Math.max(0.0001, this.releaseTime)));
    const holdSamples  = Math.floor(SR * this.holdTime);
    const floorGain    = 1.0 / Math.max(1, this.ratio);

    for (let c = 0; c < numChannels; c++) {
      const inp = input[c];
      const out = output[c];
      if (!inp || !out) continue;

      let env  = this.envelope[c];
      let gain = this.gateGain[c];
      let hold = this.holdCounter[c];

      for (let i = 0; i < inp.length; i++) {
        const sample = inp[i];

        if (this.bypass) {
          // Smooth ramp back to unity gain on bypass
          gain = Math.min(1.0, gain + 0.005);
          out[i] = sample * gain;
          continue;
        }

        const level = Math.abs(sample);

        // Envelope follower
        if (level > env) {
          env = attackCoeff * env + (1 - attackCoeff) * level;
        } else {
          env = releaseCoeff * env + (1 - releaseCoeff) * level;
        }

        // Gate state machine
        if (env > this.threshold) {
          hold = holdSamples;
          gain = Math.min(1.0, gain + (1 - attackCoeff) * 4);
        } else if (hold > 0) {
          hold--;
          gain = Math.min(1.0, gain + (1 - attackCoeff));
        } else {
          gain = Math.max(floorGain, gain * releaseCoeff + floorGain * (1 - releaseCoeff));
        }

        out[i] = sample * gain;
      }

      this.envelope[c]    = env;
      this.gateGain[c]    = gain;
      this.holdCounter[c] = hold;
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
