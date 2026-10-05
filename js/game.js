'use strict';

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);

  const FONT = "Fredoka, 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif";
  const FRAME = 18;          // container wall thickness (world units)
  const SIDE = 175;          // space for the side labels in landscape
  const HEADER = 84;         // space for the header in portrait
  const DANGER_Y = TUBE_BOT + 8;
  const DANGER_TIME = 3;     // seconds above the line before game over
  const MAX_DRAG = 320;      // arrow length for a full-power shot
  const TUBE_SIZE = 4;       // ammo at the start of a game
  const MIN_AMMO = 3;        // the row is topped back up to this after merges
  const MAX_AMMO = 6;        // the row never gets more crowded than this
  const MIN_DRAG = 16;

  const PALETTES = {
    // sampled from the real game
    neon: ['#ff3537', '#ffe23b', '#62f636', '#32ffc3', '#2a80e2', '#9b30f0', '#fe33af', '#fe7232',
      '#d7ff34', '#33fd45', '#31fffe', '#3a3af2', '#d434ff', '#ffb020', '#ff4f7a', '#ececec'],
    pastel: ['#ff8f8f', '#fff19c', '#a8f5a2', '#93efd6', '#a0bfff', '#cba3ff', '#ffa3d4', '#ffc193',
      '#ebff9e', '#ffffff', '#a3fdfd', '#a8a8ff', '#e9a8ff', '#ffdb8f', '#ffb1c6', '#cbffd6'],
    sunset: ['#ffd25e', '#ff9f43', '#ff6b6b', '#ee5a8f', '#c44daa', '#8e5bd6', '#5c6cf0', '#3d9df2',
      '#2ec4d6', '#3fdcae', '#8be36a', '#e8f06a', '#ffe9a8', '#ffb3a1', '#d9a3ff', '#ffffff'],
  };
  const PALETTE_ORDER = ['neon', 'pastel', 'sunset'];
  const PALETTE_UNLOCK = { pastel: 'v1024', sunset: 'v2048' };

  const ACHIEVEMENTS = [
    { id: 'first', name: 'first squish', desc: 'merge two blobs' },
    { id: 'v64', name: '64', desc: 'make a 64' },
    { id: 'v256', name: '256', desc: 'make a 256' },
    { id: 'v1024', name: '1024', desc: 'make a 1024' },
    { id: 'v2048', name: '2048', desc: 'make a 2048' },
    { id: 'v4096', name: '4096', desc: 'make a 4096' },
    { id: 'x3_1024', name: '3x 1024', desc: 'have three 1024s at once' },
    { id: 'chain3', name: 'combo x3', desc: '3 merges from a single shot' },
    { id: 'chain5', name: 'combo x5', desc: '5 merges from a single shot' },
    { id: 'cannon', name: 'cannonball', desc: 'shoot at full power' },
    { id: 'feather', name: 'featherweight', desc: '10 gentle drops in a row' },
    { id: '1212', name: '1212121212', desc: 'line the floor with ten 1s and 2s, nothing else' },
    { id: 'crowd', name: 'crowded', desc: 'have 40 blobs in play at once' },
    { id: 's10k', name: '10000', desc: 'score 10000 points' },
  ];
  const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('sobosuba.' + k);
        return v == null ? d : JSON.parse(v);
      } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('sobosuba.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ }
    },
  };

  const G = {
    state: 'title',        // title | play | pause | over
    world: null,
    score: 0,
    dispScore: 0,
    best: store.get('best', 0),
    maxValue: 2,
    chain: 0,
    softStreak: 0,
    shots: 0,
    dangerT: 0,
    topY: WORLD_H,
    refillT: 0,
    ammoDue: 0,
    refillWait: 0,
    achTimer: 0,
    time: 0,
    aim: null,             // pointer aim: { blob, x, y, id }
    kb: null,              // keyboard charge: { blob, t, ang }
    kbMode: false,
    kbSel: 0,
    hover: null,
    popups: [],
    parts: [],
    shake: 0,
    ach: new Set(store.get('ach', [])),
    palette: store.get('palette', 'neon'),
  };
  if (!PALETTES[G.palette]) G.palette = 'neon';
  Sfx.setMuted(store.get('muted', false));

  // ---------------------------------------------------------------- layout
  const L = { w: 0, h: 0, dpr: 1, s: 1, ox: 0, oy: 0, landscape: true };

  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const lw = WORLD_W + 2 * FRAME + 2 * SIDE, lh = WORLD_H + 2 * FRAME + 30;
    const pw = WORLD_W + 2 * FRAME + 16, ph = HEADER + WORLD_H + 2 * FRAME + 16;
    const sl = Math.min(w / lw, h / lh), sp = Math.min(w / pw, h / ph);
    const landscape = sl >= sp;
    const s = landscape ? sl : sp;
    const ox = (w - WORLD_W * s) / 2;
    const oy = landscape ? (h - WORLD_H * s) / 2 : (h - ph * s) / 2 + (HEADER + FRAME + 4) * s;
    Object.assign(L, { w, h, dpr, s, ox, oy, landscape });

    const mb = $('menuBtn');
    const mx = landscape ? -FRAME - 150 : -FRAME + 14;
    const my = landscape ? WORLD_H / 2 : -FRAME - 44;
    mb.style.left = (ox + mx * s) + 'px';
    mb.style.top = (oy + my * s) + 'px';
    mb.classList.toggle('vertical', landscape);
  }

  // ---------------------------------------------------------------- colours
  const inkCache = new Map();

  function blobColor(v) {
    const pal = PALETTES[G.palette];
    const i = Math.round(Math.log2(v));
    return pal[Math.min(i, pal.length - 1)];
  }

  function towardWhite(col, t) {
    const r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
    return `rgb(${r + (255 - r) * t | 0},${g + (255 - g) * t | 0},${b + (255 - b) * t | 0})`;
  }

  function inkColor(v) {
    const col = blobColor(v);
    let ink = inkCache.get(col);
    if (!ink) {
      const r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
      ink = `rgb(${r * 0.28 | 0},${g * 0.28 | 0},${b * 0.28 | 0})`;
      inkCache.set(col, ink);
    }
    return ink;
  }

  // ---------------------------------------------------------------- game flow
  function newGame() {
    G.world = new World();
    Object.assign(G, {
      score: 0, dispScore: 0, maxValue: 2, chain: 0, softStreak: 0, shots: 0,
      dangerT: 0, topY: WORLD_H, refillT: 0, refillWait: 0, ammoDue: 0, achTimer: 0,
      aim: null, kb: null, hover: null, shake: 0,
    });
    G.popups.length = 0;
    G.parts.length = 0;
    for (const k of [-1.5, -0.5, 0.5, 1.5]) G.world.spawnTube(spawnValue(), WORLD_W / 2 + k * 52);
  }

  function startGame() {
    if (G.state !== 'title') newGame();
    G.state = 'play';
    showScreen(null);
  }

  function gameOver() {
    G.state = 'over';
    G.aim = null;
    G.kb = null;
    const isBest = G.score > G.best;
    if (isBest) {
      G.best = G.score;
      store.set('best', G.best);
    }
    Sfx.over();
    $('overScore').textContent = G.score;
    $('overBest').textContent = 'best ' + G.best;
    $('newBest').hidden = !isBest || G.score === 0;
    setTimeout(() => { if (G.state === 'over') showScreen('screen-over'); }, 900);
  }

  function pauseGame() {
    if (G.state !== 'play') return;
    G.state = 'pause';
    G.aim = null;
    G.kb = null;
    buildPauseMenu();
    showScreen('screen-pause');
  }

  function resumeGame() {
    if (G.state !== 'pause') return;
    G.state = 'play';
    showScreen(null);
  }

  function showScreen(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('show', el.id === id);
  }

  // ---------------------------------------------------------------- spawning
  function spawnValue() {
    // Bigger blobs start showing up in the tube as the board grows (up to 64).
    const maxExp = Math.max(2, Math.min(6, Math.floor(Math.log2(G.maxValue)) - 5));
    let total = 0;
    const w = [];
    for (let k = 0; k <= maxExp; k++) {
      w.push(Math.pow(0.55, k));
      total += w[k];
    }
    let r = Math.random() * total;
    for (let k = 0; k <= maxExp; k++) {
      r -= w[k];
      if (r <= 0) return 1 << k;
    }
    return 1;
  }

  function tubeBlobs() {
    return G.world.blobs.filter(b => b.layer === LAYER_TUBE).sort((a, b) => a.cx - b.cx);
  }

  // Like the real game, every launch brings in one new ammo blob, so merging ammo
  // together in the row leaves you with fewer (but bigger) shots.
  function refill(dt) {
    const tube = tubeBlobs();
    let flying = 0;
    for (const b of G.world.blobs) if (b.layer === LAYER_PLAY && !b.inPlay) flying++;
    // ...but merging never leaves the row thinner than MIN_AMMO
    const short = MIN_AMMO - tube.length - flying;
    if (short > G.ammoDue) G.ammoDue = short;
    if (G.ammoDue <= 0) return;
    if (tube.length >= MAX_AMMO) { G.ammoDue = 0; return; }
    G.refillT -= dt;
    if (G.refillT > 0) return;
    // New ammo slides in through whichever side wall has more room next to it.
    let side = Math.random() < 0.5 ? 1 : -1;
    if (tube.length) {
      const roomR = TUBE_R - tube[tube.length - 1].maxX, roomL = tube[0].minX - TUBE_L;
      if (Math.max(roomR, roomL) < 30 && G.refillWait < 1.2) {
        G.refillWait += dt;
        return;
      }
      side = roomR >= roomL ? 1 : -1;
    }
    G.refillWait = 0;
    G.world.spawnTube(spawnValue(), 0, side);
    G.ammoDue--;
    G.refillT = 0.35;
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    const W = G.world;
    W.step(dt * TIME_SCALE);

    if (W.mergePairs.length) {
      const mp = W.mergePairs, list = [];
      for (let i = 0; i < mp.length; i += 2) list.push(W.blobs[mp[i]], W.blobs[mp[i + 1]]);
      mp.length = 0;
      for (let i = 0; i < list.length; i += 2) {
        const a = list[i], b = list[i + 1];
        if (a.dead || b.dead) continue;
        onMerge(W.merge(a, b), a, b);
      }
    }
    for (const e of W.events) if (e.type === 'impact') Sfx.impact(e.speed);
    W.events.length = 0;

    if (G.state === 'play' || G.state === 'title') refill(dt);
    if (G.state === 'play') {
      checkDanger(dt);
      G.achTimer -= dt;
      if (G.achTimer <= 0) {
        G.achTimer = 0.5;
        periodicAchievements();
      }
    }
    updateFx(dt);
  }

  function onMerge(nb, a, b) {
    const col = blobColor(nb.value);
    burst((a.cx + b.cx) / 2, (a.cy + b.cy) / 2, col, 6 + Math.log2(nb.value) * 1.5);
    if (G.state !== 'play') return;
    G.chain++;
    G.score += nb.value;
    G.maxValue = Math.max(G.maxValue, nb.value);
    G.popups.push({ x: nb.cx, y: nb.cy, text: '+' + nb.value, col, t: 0 });
    if (G.chain >= 2) G.popups.push({ x: nb.cx, y: nb.cy + 18, text: 'combo x' + G.chain, col: '#fff', t: 0, small: true });
    Sfx.merge(nb.value, G.chain);
    if (nb.value >= 256) G.shake = Math.min(1, G.shake + Math.log2(nb.value) / 22);

    unlock('first');
    for (const [id, v] of [['v64', 64], ['v256', 256], ['v1024', 1024], ['v2048', 2048], ['v4096', 4096]]) {
      if (nb.value >= v) unlock(id);
    }
    if (nb.value === 1024) {
      let n = 0;
      for (const o of G.world.blobs) if (o.value === 1024) n++;
      if (n >= 3) unlock('x3_1024');
    }
    if (G.chain >= 3) unlock('chain3');
    if (G.chain >= 5) unlock('chain5');
    if (G.score >= 10000) unlock('s10k');
  }

  function checkDanger(dt) {
    let top = WORLD_H;
    for (const b of G.world.blobs) {
      if (!b.inPlay) continue;   // ammo and blobs still flying above the board don't count
      if (b.morph || (b.shotAge >= 0 && b.shotAge < 1.0)) continue;
      if (b.minY < top) top = b.minY;
    }
    G.topY = top;
    if (top < DANGER_Y) G.dangerT += dt;
    else G.dangerT = Math.max(0, G.dangerT - dt * 1.5);
    if (G.dangerT >= DANGER_TIME) gameOver();
  }

  function periodicAchievements() {
    const play = G.world.blobs.filter(b => b.inPlay);
    if (play.length >= 40) unlock('crowd');
    if (play.length >= 10 && play.every(b => b.value <= 2 && b.cy > WORLD_H - 48 && !b.morph && b.speed < 40)) {
      unlock('1212');
    }
  }

  function unlock(id) {
    if (G.ach.has(id)) return;
    G.ach.add(id);
    store.set('ach', [...G.ach]);
    toast('achievement!', ACH_BY_ID[id].name);
    Sfx.achieve();
    for (const [pal, need] of Object.entries(PALETTE_UNLOCK)) {
      if (need === id) setTimeout(() => toast('new color style', pal + ' — pick it in the menu'), 900);
    }
  }

  function toast(title, sub) {
    const el = document.createElement('div');
    el.className = 'toast';
    const t1 = document.createElement('div');
    t1.className = 't1';
    t1.textContent = title;
    const t2 = document.createElement('div');
    t2.className = 't2';
    t2.textContent = sub;
    el.append(t1, t2);
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  // ---------------------------------------------------------------- effects
  function burst(x, y, col, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, sp = 80 + Math.random() * 220;
      G.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        r: 1.5 + Math.random() * 2.5, col, t: 0, life: 0.4 + Math.random() * 0.3,
      });
    }
  }

  function updateFx(dt) {
    const P = G.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.t += dt;
      if (p.t >= p.life) { P.splice(i, 1); continue; }
      p.vy += 700 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    const U = G.popups;
    for (let i = U.length - 1; i >= 0; i--) {
      U[i].t += dt;
      if (U[i].t >= 0.9) U.splice(i, 1);
    }
    G.shake = Math.max(0, G.shake - dt * 3);
    G.dispScore += (G.score - G.dispScore) * Math.min(1, dt * 10);
    if (Math.abs(G.score - G.dispScore) < 0.5) G.dispScore = G.score;
  }

  // ---------------------------------------------------------------- aiming & shooting
  // In simulation units/s. At TIME_SCALE 0.5 a medium shot crosses ~1.3 board
  // widths per real second, about what the real game does.
  function shotSpeed(power) { return 266 + 1710 * Math.pow(power, 1.3); }

  function aimFromPointer(aim) {
    const b = aim.blob;
    const dx = aim.x - b.cx, dy = aim.y - b.cy;
    const len = Math.hypot(dx, dy);
    if (len < MIN_DRAG) return { blob: b, dx: 0, dy: 1, power: 0 };
    // any direction: up or sideways launches a blob over the row to land on other ammo
    return { blob: b, dx: dx / len, dy: dy / len, power: Math.min(1, (len - MIN_DRAG) / (MAX_DRAG - MIN_DRAG)) };
  }

  function kbPower(t) { return Math.min(1, t / 1.1); }

  function currentAim() {
    if (G.aim) {
      if (G.aim.blob.dead || G.aim.blob.layer !== LAYER_TUBE) { G.aim = null; return null; }
      return aimFromPointer(G.aim);
    }
    if (G.kb) {
      if (G.kb.blob.dead || G.kb.blob.layer !== LAYER_TUBE) { G.kb = null; return null; }
      return { blob: G.kb.blob, dx: Math.sin(G.kb.ang), dy: Math.cos(G.kb.ang), power: kbPower(G.kb.t) };
    }
    return null;
  }

  function shootBlob(a) {
    const speed = shotSpeed(a.power);
    G.world.shoot(a.blob, a.dx * speed, a.dy * speed);
    G.chain = 0;
    G.shots++;
    G.refillT = Math.max(G.refillT, 0.25);
    G.ammoDue++;
    Sfx.shoot(a.power);
    if (a.power >= 0.98) unlock('cannon');
    if (a.power < 0.12) {
      if (++G.softStreak >= 10) unlock('feather');
    } else G.softStreak = 0;
    if (G.hover === a.blob) G.hover = null;
  }

  function toWorld(e) {
    return { x: (e.clientX - L.ox) / L.s, y: (e.clientY - L.oy) / L.s };
  }

  function pickTube(p) {
    if (p.x < -FRAME - 40 || p.x > WORLD_W + FRAME + 40 || p.y < -FRAME - 80 || p.y > WORLD_H + FRAME + 40) return null;
    let best = null, bd = Infinity;
    // Below the tube, horizontal distance matters most: tap under the blob you want.
    const wy = p.y < TUBE_BOT + 20 ? 1 : 0.15;
    for (const b of G.world.blobs) {
      if (b.layer !== LAYER_TUBE || b.entering) continue;
      const d = Math.hypot(p.x - b.cx, (p.y - b.cy) * wy);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  function kbBlob() {
    const tube = tubeBlobs().filter(b => !b.entering);
    if (!tube.length) return null;
    G.kbSel = Math.max(0, Math.min(tube.length - 1, G.kbSel));
    return tube[G.kbSel];
  }

  canvas.addEventListener('pointerdown', e => {
    Sfx.init();
    if (G.state !== 'play') return;
    if (e.button === 2) { G.aim = null; return; }
    if (e.button !== 0) return;
    const p = toWorld(e);
    const b = pickTube(p);
    if (!b) return;
    G.kbMode = false;
    G.kb = null;
    G.aim = { blob: b, x: p.x, y: p.y, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', e => {
    const p = toWorld(e);
    if (G.aim && e.pointerId === G.aim.id) {
      G.aim.x = p.x;
      G.aim.y = p.y;
    } else if (e.pointerType === 'mouse' && G.state === 'play') {
      G.kbMode = false;
      G.hover = pickTube(p);
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (!G.aim || e.pointerId !== G.aim.id) return;
    const a = currentAim();
    G.aim = null;
    if (a && G.state === 'play') shootBlob(a);
  });

  canvas.addEventListener('pointercancel', () => { G.aim = null; });
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') G.hover = null; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', () => { G.aim = null; G.kb = null; });

  window.addEventListener('keydown', e => {
    const k = e.key;
    if (k === 'Escape') {
      if (G.aim || G.kb) { G.aim = null; G.kb = null; }
      else if (G.state === 'play') pauseGame();
      else if (G.state === 'pause') resumeGame();
      return;
    }
    if (k === 'm' || k === 'M') { toggleMute(); return; }
    if (G.state === 'title' && (k === 'Enter' || k === ' ')) { e.preventDefault(); Sfx.init(); startGame(); return; }
    if (G.state === 'over' && (k === 'Enter' || k === 'r' || k === 'R')) { startGame(); return; }
    if (G.state !== 'play') return;
    const left = k === 'ArrowLeft' || k === 'a' || k === 'A';
    const right = k === 'ArrowRight' || k === 'd' || k === 'D';
    if (left || right) {
      e.preventDefault();
      if (G.kb) {
        // rotate the aim all the way round (0 = straight down, ±π = straight up)
        G.kb.ang += left ? -0.15 : 0.15;
        if (G.kb.ang > Math.PI) G.kb.ang -= TAU;
        if (G.kb.ang < -Math.PI) G.kb.ang += TAU;
      } else {
        if (G.kbMode) G.kbSel += left ? -1 : 1;
        G.kbMode = true;
        kbBlob();
      }
    } else if ((k === ' ' || k === 'ArrowDown' || k === 's' || k === 'S') && !e.repeat) {
      e.preventDefault();
      Sfx.init();
      G.kbMode = true;
      const b = kbBlob();
      if (b && !G.aim) G.kb = { blob: b, t: 0, ang: 0 };
    }
  });

  window.addEventListener('keyup', e => {
    const k = e.key;
    if ((k === ' ' || k === 'ArrowDown' || k === 's' || k === 'S') && G.kb) {
      const a = currentAim();
      G.kb = null;
      if (a && G.state === 'play') shootBlob(a);
    }
  });

  function toggleMute() {
    Sfx.init();
    Sfx.setMuted(!Sfx.muted);
    store.set('muted', Sfx.muted);
    if (G.state === 'pause') buildPauseMenu();
  }

  // ---------------------------------------------------------------- menus
  function buildPauseMenu() {
    $('soundBtn').textContent = 'sound: ' + (Sfx.muted ? 'off' : 'on');

    const pals = $('palettes');
    pals.replaceChildren();
    for (const id of PALETTE_ORDER) {
      const need = PALETTE_UNLOCK[id];
      const open = !need || G.ach.has(need);
      const btn = document.createElement('button');
      btn.className = 'pal' + (G.palette === id ? ' active' : '');
      btn.disabled = !open;
      btn.title = open ? id : 'unlock: ' + ACH_BY_ID[need].desc;
      const sw = document.createElement('span');
      sw.className = 'swatches';
      for (let i = 0; i < 5; i++) {
        const dot = document.createElement('i');
        dot.style.background = open ? PALETTES[id][i * 2] : '#3a3a3a';
        sw.appendChild(dot);
      }
      const label = document.createElement('span');
      label.textContent = open ? id : 'locked';
      btn.append(sw, label);
      btn.addEventListener('click', () => {
        G.palette = id;
        store.set('palette', id);
        Sfx.click();
        buildPauseMenu();
      });
      pals.appendChild(btn);
    }

    const list = $('achList');
    list.replaceChildren();
    for (const a of ACHIEVEMENTS) {
      const li = document.createElement('li');
      const got = G.ach.has(a.id);
      li.className = got ? 'got' : '';
      const name = document.createElement('b');
      name.textContent = (got ? '✓ ' : '') + a.name;
      const desc = document.createElement('span');
      desc.textContent = a.desc;
      li.append(name, desc);
      list.appendChild(li);
    }
    $('achCount').textContent = `${G.ach.size}/${ACHIEVEMENTS.length}`;
  }

  $('playBtn').addEventListener('click', () => { Sfx.init(); Sfx.click(); startGame(); });
  $('againBtn').addEventListener('click', () => { Sfx.init(); Sfx.click(); startGame(); });
  $('menuBtn').addEventListener('click', () => {
    Sfx.init();
    if (G.state === 'play') pauseGame();
    else if (G.state === 'pause') resumeGame();
  });
  $('resumeBtn').addEventListener('click', () => { Sfx.click(); resumeGame(); });
  $('restartBtn').addEventListener('click', () => {
    Sfx.click();
    G.state = 'over';
    startGame();
  });
  $('soundBtn').addEventListener('click', toggleMute);

  // ---------------------------------------------------------------- rendering
  function interiorPath() {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(WORLD_W, 0);
    ctx.lineTo(WORLD_W, WORLD_H - CHAMFER);
    ctx.lineTo(WORLD_W - CHAMFER, WORLD_H);
    ctx.lineTo(CHAMFER, WORLD_H);
    ctx.lineTo(0, WORLD_H - CHAMFER);
    ctx.closePath();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
  }

  function drawFrame(power) {
    const ky = WORLD_H * 0.33;
    ctx.fillStyle = '#464646';
    for (const kx of [-FRAME - 1, WORLD_W + FRAME + 1]) {
      ctx.beginPath();
      ctx.arc(kx, ky, 21, 0, TAU);
      ctx.fill();
    }
    ctx.lineJoin = 'round';
    interiorPath();
    ctx.lineWidth = FRAME * 2 + 5;
    ctx.strokeStyle = '#2f2f2f';
    ctx.stroke();
    ctx.lineWidth = FRAME * 2;
    ctx.strokeStyle = '#3c3c3c';
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#1d1d1d';
    ctx.stroke();

    // knob details
    for (const kx of [-FRAME / 2, WORLD_W + FRAME / 2]) {
      ctx.fillStyle = '#2a2a2a';
      roundRect(kx - 1.6, ky - 26, 3.2, 52, 1.6);
      ctx.fill();
      ctx.fillStyle = '#6a6a6a';
      ctx.beginPath();
      ctx.arc(kx, ky, 2.6, 0, TAU);
      ctx.fill();
    }

    // top rails double as a power meter while aiming
    const rw = 140, ry = -FRAME / 2 - 2.5;
    const fill = 0.12 + 0.88 * power;
    ctx.fillStyle = '#2b2b2b';
    roundRect(10, ry, rw, 5, 2.5); ctx.fill();
    roundRect(WORLD_W - 10 - rw, ry, rw, 5, 2.5); ctx.fill();
    ctx.fillStyle = power > 0.97 ? '#ffd166' : '#8d8d8d';
    roundRect(10, ry, rw * fill, 5, 2.5); ctx.fill();
    roundRect(WORLD_W - 10 - rw * fill, ry, rw * fill, 5, 2.5); ctx.fill();
  }

  function drawTubeDots() {
    ctx.fillStyle = '#a5a5a5';
    for (const b of G.world.blobs) {
      if (b.layer !== LAYER_TUBE || b.cx < 0 || b.cx > WORLD_W) continue;
      ctx.beginPath();
      ctx.arc(b.cx, -3, 2.3, 0, TAU);
      ctx.fill();
    }
  }

  function fitFont(text, weight, size, maxW) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const w = ctx.measureText(text).width;
    if (w > maxW) {
      size *= maxW / w;
      ctx.font = `${weight} ${size}px ${FONT}`;
    }
  }

  function drawLabels() {
    const score = String(Math.round(G.dispScore));
    const best = 'best ' + Math.max(G.best, G.state === 'play' ? G.score : 0);
    ctx.textBaseline = 'middle';
    if (L.landscape) {
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(-FRAME - 80, WORLD_H / 2);
      ctx.rotate(-Math.PI / 2);
      fitFont('sobosuba', 700, 68, WORLD_H);
      ctx.fillStyle = '#474747';
      ctx.fillText('sobosuba', 0, 0);
      ctx.restore();

      ctx.save();
      ctx.translate(WORLD_W + FRAME + 76, WORLD_H / 2);
      ctx.rotate(Math.PI / 2);
      fitFont(score, 600, 108, WORLD_H - 10);
      ctx.fillStyle = '#7e7e7e';
      ctx.fillText(score, 0, 0);
      ctx.restore();

      ctx.save();
      ctx.translate(WORLD_W + FRAME + 148, WORLD_H / 2);
      ctx.rotate(Math.PI / 2);
      ctx.font = `600 17px ${FONT}`;
      ctx.fillStyle = '#585858';
      ctx.fillText(best, 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = 'left';
      fitFont('sobosuba', 700, 42, 190);
      ctx.fillStyle = '#4c4c4c';
      ctx.fillText('sobosuba', -FRAME + 36, -FRAME - 44);
      ctx.textAlign = 'right';
      fitFont(score, 600, 58, 180);
      ctx.fillStyle = '#7e7e7e';
      ctx.fillText(score, WORLD_W + FRAME, -FRAME - 48);
      ctx.font = `600 14px ${FONT}`;
      ctx.fillStyle = '#585858';
      ctx.fillText(best, WORLD_W + FRAME, -FRAME - 12);
    }
  }

  function blobPath(b, x, y) {
    const s = b.start, n = b.n;
    ctx.beginPath();
    ctx.moveTo((x[s + n - 1] + x[s]) / 2, (y[s + n - 1] + y[s]) / 2);
    for (let k = 0; k < n; k++) {
      const i = s + k, j = s + (k + 1 === n ? 0 : k + 1);
      ctx.quadraticCurveTo(x[i], y[i], (x[i] + x[j]) / 2, (y[i] + y[j]) / 2);
    }
    ctx.closePath();
  }

  function drawBlobs(layer, sel, aimed) {
    const W = G.world, x = W.x, y = W.y;
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 13px ${FONT}`;
    for (const b of W.blobs) {
      if (b.layer !== layer) continue;
      const col = b.flash > 0 ? towardWhite(blobColor(b.value), b.flash * 0.75) : blobColor(b.value);
      blobPath(b, x, y);
      if (b === sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = OUTLINE * 2 + 5;
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = OUTLINE * 2;
      ctx.stroke();
      if (b === aimed) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, 11, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#3a3a3a';
      } else {
        ctx.fillStyle = inkColor(b.value);
      }
      ctx.fillText(String(b.value), b.cx, b.cy + 0.5);
    }
  }

  function drawPreview(a) {
    const b = a.blob, W = G.world;
    const speed = shotSpeed(a.power);
    const x0 = b.cx, y0 = b.cy;
    let x = x0, y = y0, vx = a.dx * speed, vy = a.dy * speed;
    const r = blobRadius(b.value) * 0.85;
    const dt = 1 / 120;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (let i = 0; i < 360; i++) {
      vy += GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (x < r || x > WORLD_W - r || y > WORLD_H - r || y < r) break;
      // once clear of its neighbours in the row, stop at the first blob it would hit
      const away = Math.hypot(x - x0, y - y0) > r * 1.3;
      if (away && (i & 1) === 0 && W.circleHits(x, y, r + RB, b)) break;
      if (away && i % 6 === 3) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, TAU);
        ctx.fill();
      }
    }
    x = Math.max(r, Math.min(WORLD_W - r, x));
    y = Math.max(r, Math.min(WORLD_H - r, y));
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = blobColor(b.value);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, blobRadius(b.value), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawArrow(a) {
    const b = a.blob;
    const len = MIN_DRAG + 8 + a.power * (MAX_DRAG - MIN_DRAG);
    const x0 = b.cx + a.dx * 13, y0 = b.cy + a.dy * 13;
    const x1 = b.cx + a.dx * len, y1 = b.cy + a.dy * len;
    ctx.strokeStyle = a.power > 0.97 ? '#ffd166' : '#fff';
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    const hx = -a.dx, hy = -a.dy, c = Math.cos(0.55), s = Math.sin(0.55), hl = 15;
    ctx.moveTo(x1 + (hx * c - hy * s) * hl, y1 + (hx * s + hy * c) * hl);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 + (hx * c + hy * s) * hl, y1 + (-hx * s + hy * c) * hl);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function drawDanger() {
    if (G.state !== 'play' && G.state !== 'over' && G.state !== 'pause') return;
    const near = Math.max(0, Math.min(1, (DANGER_Y + 70 - G.topY) / 70));
    if (near <= 0 && G.dangerT <= 0) return;
    const pulse = G.dangerT > 0 ? 0.5 + 0.5 * Math.sin(G.time * 14) : 0;
    ctx.strokeStyle = `rgba(255,70,70,${0.2 + 0.45 * near + 0.3 * pulse})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(0, DANGER_Y);
    ctx.lineTo(WORLD_W, DANGER_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (G.dangerT > 0) {
      const f = Math.min(1, G.dangerT / DANGER_TIME);
      ctx.fillStyle = 'rgba(255,70,70,0.9)';
      ctx.fillRect(WORLD_W / 2 * (1 - f), DANGER_Y - 2, WORLD_W * f, 4);
    }
  }

  function drawParticles() {
    for (const p of G.parts) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPopups() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const p of G.popups) {
      const k = p.t / 0.9;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = p.small ? `600 12px ${FONT}` : `700 17px ${FONT}`;
      const y = p.y - 34 * Math.sqrt(k) - 6;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.col;
      ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    const { dpr, s, ox, oy, w, h } = L;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#262626';
    ctx.fillRect(0, 0, w, h);

    let shx = 0, shy = 0;
    if (G.shake > 0) {
      shx = (Math.random() - 0.5) * G.shake * 9;
      shy = (Math.random() - 0.5) * G.shake * 9;
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox + shx * s), dpr * (oy + shy * s));

    const aim = G.state === 'play' ? currentAim() : null;
    const sel = aim ? aim.blob : G.state === 'play' ? (G.kbMode ? kbBlob() : G.hover) : null;

    drawLabels();
    drawFrame(aim ? aim.power : 0);
    ctx.save();
    interiorPath();
    ctx.clip();
    drawDanger();
    drawBlobs(LAYER_TUBE, sel, aim && aim.blob);
    if (aim) drawPreview(aim);
    drawBlobs(LAYER_PLAY, sel, null);
    drawParticles();
    if (aim) drawArrow(aim);
    drawPopups();
    ctx.restore();
    drawTubeDots();

    if (DEBUG) drawDebug();
  }

  // ---------------------------------------------------------------- debug
  const DEBUG = /[?&]debug\b/.test(location.search);
  let fpsAcc = 0, fpsFrames = 0, fps = 0;
  function drawDebug() {
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#0f0';
    ctx.fillText(`fps ${fps}  blobs ${G.world.blobs.length}  beads ${G.world.n}`, 8, 8);
  }

  // ---------------------------------------------------------------- main loop
  let last = performance.now(), acc = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;
    G.time += dt;
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

    if (G.state !== 'pause') {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 4) {
        update(STEP);
        acc -= STEP;
        steps++;
      }
      if (steps >= 4) acc = 0;
      if (G.kb) G.kb.t += dt;
    }
    render();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', layout);
  layout();
  newGame();
  showScreen('screen-title');
  if (document.fonts && document.fonts.load) document.fonts.load(`700 20px Fredoka`).catch(() => {});
  requestAnimationFrame(frame);

  // handy for poking at the game from the console
  window.sobosuba = { G, update, newGame, startGame };
})();
