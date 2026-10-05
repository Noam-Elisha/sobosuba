'use strict';

// All sounds are synthesized with WebAudio, so the game has no asset files.
const Sfx = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function ready() { return ctx && !muted; }

  function tone({ type = 'sine', f0, f1 = 0, glide = 0.1, dur = 0.3, vol = 0.3, delay = 0 }) {
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Water-droplet sound: a sine whose pitch sweeps quickly upward as it fades.
  function drop(f, vol, delay = 0, dur = 0.16, rise = 2.3) {
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rise, t + dur * 0.45);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise({ f0, f1 = 0, q = 1, dur = 0.12, vol = 0.2, type = 'bandpass', delay = 0 }) {
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.05);
  }

  return {
    init,
    get muted() { return muted; },
    setMuted(m) {
      muted = m;
      if (master) master.gain.setTargetAtTime(m ? 0 : 0.6, ctx.currentTime, 0.02);
    },
    shoot(power) {
      if (!ready()) return;
      noise({ f0: 1800, f1: 400, q: 0.8, dur: 0.12, vol: 0.03 + 0.1 * power });
      tone({ f0: 420, f1: 170, glide: 0.11, dur: 0.15, vol: 0.08 + 0.1 * power });
    },
    merge(value, chain) {
      if (!ready()) return;
      const steps = Math.log2(value);
      const base = 520 * Math.pow(2, -steps * 1.1 / 12) * Math.pow(2, Math.min(chain - 1, 12) * 2 / 12);
      // a water-drop "bloop", a smaller bubble right after, and a low gloopy body
      drop(base, 0.34, 0, 0.2);
      drop(base * 1.6, 0.13, 0.05, 0.14);
      tone({ f0: base * 0.45, f1: base * 0.7, glide: 0.12, dur: 0.22, vol: 0.12 });
    },
    impact(speed) {
      if (!ready()) return;
      const v = Math.min(1, speed / 1400);
      if (v < 0.06) return;
      // wet "plop": a low drop plus a short squelch
      drop(150 + 60 * v, 0.3 * v, 0, 0.13, 1.9);
      noise({ f0: 900, f1: 220, q: 1.3, dur: 0.09, vol: 0.12 * v });
    },
    over() {
      if (!ready()) return;
      [523, 392, 330, 247].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.4, vol: 0.16, delay: i * 0.15 }));
    },
    achieve() {
      if (!ready()) return;
      tone({ f0: 880, dur: 0.22, vol: 0.14 });
      tone({ f0: 1320, dur: 0.35, vol: 0.14, delay: 0.1 });
    },
    click() {
      if (!ready()) return;
      tone({ f0: 520, f1: 700, glide: 0.04, dur: 0.08, vol: 0.08 });
    },
  };
})();
