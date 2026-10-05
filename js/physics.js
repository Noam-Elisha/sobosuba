'use strict';

// Soft-body physics for sobosuba.
// Each blob is a closed ring of small circular "beads". Neighbouring beads are
// held together by a floppy skin, a weak bending constraint keeps the outline
// smooth, and a pressure (area) constraint keeps the blob full like a water
// balloon. Beads of different blobs collide almost frictionlessly, which lets
// blobs squash into each other like foam, and touching blobs soak up the speed
// that would bounce them apart. Solved with position-based dynamics (XPBD for the
// skin) using many substeps.

// ---------- world constants (world units ~= CSS px at scale 1) ----------
// Proportions measured from the real game: the board is ~1.07x taller than wide,
// and a blob's area grows as value^0.385 (a "1" covers 0.6% of width^2, a 4096 15%).
const WORLD_W = 380;
const WORLD_H = 408;
const CHAMFER = 30;

const RB = 4.5;            // radius of each skin bead
const SPACING = 7.2;       // rest distance between neighbouring beads
const OUTLINE = RB - 1.3;  // drawn edge sits this far outside the bead ring
const R1 = 16.8;           // visual radius of a "1" blob
const SIZE_EXP = 0.1925;   // visual radius grows as value^SIZE_EXP

const GRAVITY = 300;       // low, like the real game: shots fly nearly straight and wobbles are slow
const TUBE_TOP = 26;
const TUBE_BOT = 66;
const TUBE_MID = (TUBE_TOP + TUBE_BOT) / 2;
const TUBE_L = 6;
const TUBE_R = WORLD_W - 6;

const STEP = 1 / 120;      // real seconds per update
const TIME_SCALE = 0.5;    // the simulation runs at half speed, matching the real game's slow, heavy motion
const SUBSTEPS = 3;
// Water balloons: a floppy skin whose stiffness is a real compliance (XPBD), so
// heavy blobs sag into domes and slosh slowly while small ones stay roundish, plus
// a stiff area constraint so the "water" inside never compresses.
const SKIN_COMPLIANCE = 9e-5;
const BEND_COMPLIANCE = 2e-3;
const MAX_STRETCH = 1.9;   // skin edges never stretch past this, so beads can't open gaps
const K_AREA = 0.6;
const K_SHAPE = 0;         // no general pull toward round: the skin alone sets the shape...
const K_SHAPE_OUT = 0.03;  // ...except beads stretched very far out get pulled back (stops skins snagging into tentacles)
const SHAPE_FAR = 2.2;     // how far (in radii) a bead can stretch before that pull starts
const MU_S = 0.02;         // blobs slide over each other almost freely
const MU_K = 0.01;
const MU_WALL = 0.02;
const DAMP_INT = 0.5;      // low: sloshing carries on for a few seconds
const DAMP_AIR = 0.12;
const DAMP_BOUNCE = 40;    // how fast touching blobs lose the speed that would bounce them apart
const STICK_MARGIN = 2.5;  // contacts this close (but not overlapping) still count as touching
const SKIN_VISCOSITY = 0.16; // smooths bead velocities with their neighbours: kills small ripples, keeps the big wobble
const VMAX = 2400;

const LAYER_TUBE = 0;
const LAYER_PLAY = 1;

const TAU = Math.PI * 2;

// Container walls as planes: [nx, ny, c, friction]; a bead is inside when dot(n, p) >= c.
const WALLS = [
  [1, 0, RB, MU_WALL],                                                         // left
  [-1, 0, RB - WORLD_W, MU_WALL],                                              // right
  [0, 1, RB, 0.1],                                                             // ceiling
  [0, -1, RB - WORLD_H, MU_WALL],                                              // floor
  [Math.SQRT1_2, -Math.SQRT1_2, -(WORLD_H - CHAMFER) * Math.SQRT1_2 + RB, MU_WALL],             // bottom-left chamfer
  [-Math.SQRT1_2, -Math.SQRT1_2, (-WORLD_W - (WORLD_H - CHAMFER)) * Math.SQRT1_2 + RB, MU_WALL], // bottom-right chamfer
];
const CEILING = 2;

// The ammo tube at the top: a frictionless channel that squeezes blobs into pills.
const TUBE_WALLS = [
  [0, 1, TUBE_TOP + RB],
  [0, -1, RB - TUBE_BOT],
  [1, 0, TUBE_L + RB],
  [-1, 0, RB - TUBE_R],
];

function blobRadius(v) { return R1 * Math.pow(v, SIZE_EXP); }
function ringRadius(v) { return blobRadius(v) - OUTLINE; }
function beadCount(v) {
  return Math.max(12, Math.min(144, Math.round(TAU * ringRadius(v) / SPACING)));
}

const unitCircles = new Map();
function unitCircle(n) {
  let c = unitCircles.get(n);
  if (!c) {
    c = { cos: new Float64Array(n), sin: new Float64Array(n) };
    for (let k = 0; k < n; k++) {
      c.cos[k] = Math.cos(TAU * k / n);
      c.sin[k] = Math.sin(TAU * k / n);
    }
    unitCircles.set(n, c);
  }
  return c;
}

function polyArea(xs, ys, n) {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += xs[j] * ys[i] - xs[i] * ys[j];
  return a * 0.5;
}

let nextBlobId = 1;

class SoftBlob {
  constructor(value, layer) {
    this.id = nextBlobId++;
    this.value = value;
    this.layer = layer;
    const n = this.n = beadCount(value);
    const R = ringRadius(value);
    this.restFull = 2 * R * Math.sin(Math.PI / n);
    this.rest2Full = 2 * R * Math.sin(TAU / n);
    this.areaFull = 0.5 * n * R * R * Math.sin(TAU / n);
    this.rest = new Float64Array(n).fill(this.restFull);
    this.rest2 = new Float64Array(n).fill(this.rest2Full);
    this.area0 = this.areaFull;
    this.invMass = 1 / Math.max(0.2, this.areaFull / n / 70);
    this.morph = null;     // { t, dur, restFrom, rest2From, areaFrom }
    this.entering = 0;     // +1/-1 while sliding into the tube through the right/left wall
    this.start = 0;
    this.index = 0;
    this.init = null;      // initial bead state, consumed by World.rebuild()
    this.dead = false;
    this.age = 0;
    this.shotAge = -1;     // seconds since this blob was shot (-1: never shot)
    this.mergeLock = 0;
    this.flash = 0;
    this.pendingImpact = false;
    this.lastArea = this.areaFull;
    this.badT = 0;
    this.cx = WORLD_W / 2; this.cy = WORLD_H / 2;
    this.goodX = this.cx; this.goodY = this.cy;
    this.vx = 0; this.vy = 0;
    this.speed = 0; this.speedPrev = 0;
    this.minX = 0; this.maxX = 0; this.minY = 0; this.maxY = 0;
  }

}

class World {
  constructor() {
    this.blobs = [];
    this.n = 0;
    this.cell = 2 * RB + STICK_MARGIN;
    this.gx = Math.ceil(WORLD_W / this.cell) + 3;
    this.gy = Math.ceil(WORLD_H / this.cell) + 3;
    this.cellStart = new Int32Array(this.gx * this.gy + 1);
    this.cellFill = new Int32Array(this.gx * this.gy);
    this.gradX = new Float64Array(160);
    this.gradY = new Float64Array(160);
    this.h = STEP * TIME_SCALE / SUBSTEPS;
    this.mergePairs = [];   // flat list of blob index pairs found touching this step
    this.stickPairs = new Int32Array(4096);  // bead pairs in contact this substep
    this.nStick = 0;
    this.bouncePairs = new Map();
    this.events = [];
    this.rebuild();
  }

  // Re-pack all bead state into contiguous typed arrays after blobs are added/removed.
  rebuild() {
    const live = this.blobs.filter(b => !b.dead);
    let total = 0;
    for (const b of live) total += b.n;
    const cap = Math.max(1, total);
    const x = new Float64Array(cap), y = new Float64Array(cap);
    const px = new Float64Array(cap), py = new Float64Array(cap);
    const vx = new Float64Array(cap), vy = new Float64Array(cap);
    const pw = new Float64Array(cap);
    const po = new Int32Array(cap);
    const pk = new Int32Array(cap);
    const pl = new Uint8Array(cap);
    const bN = new Int32Array(Math.max(1, live.length));
    let off = 0;
    for (let bi = 0; bi < live.length; bi++) {
      const b = live[bi];
      const n = b.n;
      if (b.init) {
        const I = b.init;
        for (let k = 0; k < n; k++) {
          x[off + k] = px[off + k] = I.xs[k];
          y[off + k] = py[off + k] = I.ys[k];
          vx[off + k] = I.vx;
          vy[off + k] = I.vy;
        }
        b.init = null;
      } else {
        const s = b.start;
        for (let k = 0; k < n; k++) {
          x[off + k] = this.x[s + k]; y[off + k] = this.y[s + k];
          px[off + k] = this.px[s + k]; py[off + k] = this.py[s + k];
          vx[off + k] = this.vx[s + k]; vy[off + k] = this.vy[s + k];
        }
      }
      for (let k = 0; k < n; k++) {
        po[off + k] = bi;
        pk[off + k] = k;
        pl[off + k] = b.layer;
        pw[off + k] = b.invMass;
      }
      bN[bi] = n;
      b.start = off;
      b.index = bi;
      off += n;
    }
    Object.assign(this, { x, y, px, py, vx, vy, pw, po, pk, pl, bN });
    this.n = total;
    this.blobs = live;
    this.pcell = new Int32Array(cap);
    this.sorted = new Int32Array(cap);
    this.bEnter = new Int8Array(live.length);
    this.bVelX = new Float64Array(live.length);
    this.bVelY = new Float64Array(live.length);
    this.bValue = new Float64Array(live.length);
    this.bCanMerge = new Uint8Array(live.length);
    this.bTouch = new Uint8Array(live.length);
    for (const b of live) this.updateCache(b);
  }

  addBlob(b, xs, ys, vx = 0, vy = 0) {
    b.init = { xs, ys, vx, vy };
    this.blobs.push(b);
    this.rebuild();
    return b;
  }

  // Add an ammo blob to the tube, already squeezed into a pill. With `side` set
  // (+1 right, -1 left) it starts outside that wall and slides in through it.
  spawnTube(value, x, side = 0) {
    const b = new SoftBlob(value, LAYER_TUBE);
    const R = ringRadius(value);
    const ry = Math.min(R, (TUBE_BOT - TUBE_TOP) / 2 - RB - 0.5);
    const rx = R * R / ry;
    if (side) {
      x = side > 0 ? TUBE_R + rx * 0.8 : TUBE_L - rx * 0.8;
      b.entering = side;
    }
    const xs = new Float64Array(b.n), ys = new Float64Array(b.n);
    for (let k = 0; k < b.n; k++) {
      const a = TAU * k / b.n;
      xs[k] = x + Math.cos(a) * rx;
      ys[k] = TUBE_MID + Math.sin(a) * ry;
    }
    return this.addBlob(b, xs, ys, side ? -side * 500 : 0, 0);
  }

  shoot(b, vx, vy) {
    b.layer = LAYER_PLAY;
    for (let k = 0; k < b.n; k++) {
      const i = b.start + k;
      this.pl[i] = LAYER_PLAY;
      this.vx[i] = vx;
      this.vy[i] = vy;
    }
    b.shotAge = 0;
    b.pendingImpact = true;
    b.mergeLock = 0;
  }

  // Fuse two equal blobs. The new ring starts on the outline of the pair and then
  // contracts to its (smaller) round size, so it never spawns inside a neighbour.
  merge(a, b) {
    const nb = new SoftBlob(a.value * 2, LAYER_PLAY);
    const wa = a.areaFull, wb = b.areaFull, ws = wa + wb;
    const cx = (a.cx * wa + b.cx * wb) / ws;
    const cy = (a.cy * wa + b.cy * wb) / ws;
    const mvx = (a.vx * wa + b.vx * wb) / ws;
    const mvy = (a.vy * wa + b.vy * wb) / ws;
    const n = nb.n;
    const far = new Float64Array(n).fill(-1);
    const { x, y } = this;
    for (const o of [a, b]) {
      for (let k = 0; k < o.n; k++) {
        const dx = x[o.start + k] - cx, dy = y[o.start + k] - cy;
        let bin = Math.round(Math.atan2(dy, dx) / TAU * n) % n;
        if (bin < 0) bin += n;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > far[bin]) far[bin] = d;
      }
    }
    fillGaps(far, ringRadius(nb.value) * 0.6);
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const ang = TAU * k / n, r = Math.max(far[k], RB);
      xs[k] = Math.min(WORLD_W - RB, Math.max(RB, cx + Math.cos(ang) * r));
      ys[k] = Math.min(WORLD_H - RB, Math.max(RB, cy + Math.sin(ang) * r));
    }
    const restFrom = new Float64Array(n), rest2From = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n, j2 = (k + 2) % n;
      restFrom[k] = Math.hypot(xs[j] - xs[k], ys[j] - ys[k]);
      rest2From[k] = Math.hypot(xs[j2] - xs[k], ys[j2] - ys[k]);
    }
    const areaFrom = Math.max(polyArea(xs, ys, n), nb.areaFull * 0.5);
    nb.rest.set(restFrom);
    nb.rest2.set(rest2From);
    nb.area0 = areaFrom;
    nb.morph = { t: 0, dur: 0.24, restFrom, rest2From, areaFrom };
    nb.flash = 1;
    nb.mergeLock = 0.08;
    a.dead = b.dead = true;
    nb.init = { xs, ys, vx: mvx, vy: mvy };
    this.blobs.push(nb);
    this.rebuild();
    return nb;
  }

  step(dt) {
    if (this.n === 0) return;
    const h = this.h = dt / SUBSTEPS;
    this.updateMorphs(dt);
    this.applyTubeForces(dt);
    this.bTouch.fill(0);
    for (const b of this.blobs) {
      this.bEnter[b.index] = b.entering;
      this.bValue[b.index] = b.value;
      this.bCanMerge[b.index] = b.layer === LAYER_PLAY && b.mergeLock <= 0 ? 1 : 0;
    }
    for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
    this.postStep(dt);
  }

  updateMorphs(dt) {
    for (const b of this.blobs) {
      const m = b.morph;
      if (!m) continue;
      m.t += dt;
      const u = Math.min(1, m.t / m.dur);
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      for (let k = 0; k < b.n; k++) {
        b.rest[k] = m.restFrom[k] + (b.restFull - m.restFrom[k]) * e;
        b.rest2[k] = m.rest2From[k] + (b.rest2Full - m.rest2From[k]) * e;
      }
      b.area0 = m.areaFrom + (b.areaFull - m.areaFrom) * e;
      if (u >= 1) b.morph = null;
    }
  }

  // Ammo blobs float in the tube and drift toward the middle.
  applyTubeForces(dt) {
    const { vx, vy } = this;
    for (const b of this.blobs) {
      if (b.layer !== LAYER_TUBE) continue;
      let ax = (WORLD_W / 2 - b.cx) * 14;
      ax = Math.max(-900, Math.min(900, ax));
      const ay = (TUBE_MID - b.cy) * 30;
      for (let k = 0; k < b.n; k++) {
        vx[b.start + k] += ax * dt;
        vy[b.start + k] += ay * dt;
      }
    }
  }

  substep(h) {
    const { x, y, px, py, vx, vy, pl, n } = this;
    const g = GRAVITY * h;
    for (let i = 0; i < n; i++) {
      if (pl[i] === LAYER_PLAY) vy[i] += g;
      px[i] = x[i]; py[i] = y[i];
      x[i] += vx[i] * h;
      y[i] += vy[i] * h;
    }
    for (const b of this.blobs) {
      this.solveSkin(b);
      this.solveShape(b);
      this.solveArea(b);
    }
    this.buildGrid();
    this.solveContacts();
    this.solveWalls();
    const inv = 1 / h, vmax2 = VMAX * VMAX;
    for (let i = 0; i < n; i++) {
      let nvx = (x[i] - px[i]) * inv, nvy = (y[i] - py[i]) * inv;
      const sp2 = nvx * nvx + nvy * nvy;
      if (sp2 > vmax2) {
        const k = VMAX / Math.sqrt(sp2);
        nvx *= k; nvy *= k;
      }
      vx[i] = nvx; vy[i] = nvy;
    }
  }

  solveSkin(b) {
    const { x, y } = this;
    const s = b.start, n = b.n, rest = b.rest, rest2 = b.rest2;
    // XPBD: each end moves by C * w / (2w + compliance/h^2), so heavier beads give more.
    const w = b.invMass, h = this.h;
    const ks = w / (2 * w + SKIN_COMPLIANCE / (h * h));
    const kb = w / (2 * w + BEND_COMPLIANCE / (h * h));
    for (let k = 0; k < n; k++) {
      const i = s + k, j = k + 1 === n ? s : i + 1;
      const dx = x[j] - x[i], dy = y[j] - y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-18) continue;
      const d = Math.sqrt(d2);
      let corr = (d - rest[k]) * ks;
      const over = d - rest[k] * MAX_STRETCH;
      if (over > 0) corr += over * 0.5;
      const c = corr / d;
      x[i] += dx * c; y[i] += dy * c;
      x[j] -= dx * c; y[j] -= dy * c;
    }
    for (let k = 0; k < n; k++) {
      const i = s + k, j = k + 2 < n ? i + 2 : i + 2 - n;
      const dx = x[j] - x[i], dy = y[j] - y[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-18) continue;
      const c = kb - kb * rest2[k] / Math.sqrt(d2);
      x[i] += dx * c; y[i] += dy * c;
      x[j] -= dx * c; y[j] -= dy * c;
    }
  }

  // Shape matching against a circle: find the best-fit rotation of the rest ring
  // and nudge every bead a little toward its spot on it.
  solveShape(b) {
    const { x, y } = this;
    const s = b.start, n = b.n;
    const U = unitCircle(n);
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) { cx += x[s + k]; cy += y[s + k]; }
    cx /= n; cy /= n;
    let sc = 0, ss = 0;
    for (let k = 0; k < n; k++) {
      const dx = x[s + k] - cx, dy = y[s + k] - cy;
      sc += U.cos[k] * dx + U.sin[k] * dy;
      ss += U.cos[k] * dy - U.sin[k] * dx;
    }
    const th = Math.atan2(ss, sc), ct = Math.cos(th), st = Math.sin(th);
    const R = Math.sqrt(b.area0 / (0.5 * n * Math.sin(TAU / n)));
    const far2 = SHAPE_FAR * SHAPE_FAR * R * R;
    for (let k = 0; k < n; k++) {
      const i = s + k;
      const ux = U.cos[k] * ct - U.sin[k] * st, uy = U.cos[k] * st + U.sin[k] * ct;
      const dx = x[i] - cx, dy = y[i] - cy, d2 = dx * dx + dy * dy;
      let kk = K_SHAPE;
      if (d2 > far2) kk += Math.min(K_SHAPE_OUT, K_SHAPE_OUT * (Math.sqrt(d2 / far2) - 1) * 3);
      x[i] += (cx + R * ux - x[i]) * kk;
      y[i] += (cy + R * uy - y[i]) * kk;
    }
  }

  solveArea(b) {
    const { x, y, gradX, gradY } = this;
    const s = b.start, n = b.n;
    let area = 0;
    for (let k = 0, j = n - 1; k < n; j = k++) {
      area += x[s + j] * y[s + k] - x[s + k] * y[s + j];
    }
    area *= 0.5;
    b.lastArea = area;
    const C = area - b.area0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const prev = s + (k === 0 ? n - 1 : k - 1), next = s + (k + 1 === n ? 0 : k + 1);
      const gxk = 0.5 * (y[next] - y[prev]);
      const gyk = 0.5 * (x[prev] - x[next]);
      gradX[k] = gxk; gradY[k] = gyk;
      sum += gxk * gxk + gyk * gyk;
    }
    if (sum < 1e-9) return;
    const lambda = -C / sum * K_AREA;
    for (let k = 0; k < n; k++) {
      x[s + k] += lambda * gradX[k];
      y[s + k] += lambda * gradY[k];
    }
  }

  buildGrid() {
    const { x, y, n, cell, gx, gy, cellStart: cs, cellFill: cf, pcell, sorted } = this;
    cs.fill(0);
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      let cx = ((x[i] * inv) | 0) + 1, cy = ((y[i] * inv) | 0) + 1;
      if (cx < 1) cx = 1; else if (cx > gx - 2) cx = gx - 2;
      if (cy < 1) cy = 1; else if (cy > gy - 2) cy = gy - 2;
      const c = cy * gx + cx;
      pcell[i] = c;
      cs[c + 1]++;
    }
    const cells = gx * gy;
    for (let c = 1; c <= cells; c++) cs[c] += cs[c - 1];
    for (let c = 0; c < cells; c++) cf[c] = cs[c];
    for (let i = 0; i < n; i++) sorted[cf[pcell[i]]++] = i;
  }

  solveContacts() {
    const { x, y, px, py, pw, po, pk, pl, bN, n, gx, cellStart: cs, sorted, pcell } = this;
    const D = 2 * RB, DM = D + STICK_MARGIN, DM2 = DM * DM;
    const bv = this.bValue, cm = this.bCanMerge, bt = this.bTouch, mp = this.mergePairs;
    let cp = this.stickPairs, ncp = 0;
    for (let i = 0; i < n; i++) {
      const c = pcell[i], oi = po[i], li = pl[i];
      for (let oy = -gx; oy <= gx; oy += gx) {
        for (let ox = -1; ox <= 1; ox++) {
          const cc = c + oy + ox;
          const end = cs[cc + 1];
          for (let k = cs[cc]; k < end; k++) {
            const j = sorted[k];
            if (j <= i) continue;
            const oj = po[j];
            if (pl[j] !== li) continue;
            let dx = x[j] - x[i], dy = y[j] - y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= DM2) continue;
            // touching (or nearly) beads of different blobs in play get the sticky damper
            if (oj !== oi && li === LAYER_PLAY) {
              if (ncp + 2 > cp.length) {
                const grown = new Int32Array(cp.length * 2);
                grown.set(cp);
                cp = this.stickPairs = grown;
              }
              cp[ncp++] = i; cp[ncp++] = j;
            }
            if (oj === oi) {
              // Self-collision between non-neighbouring beads keeps a skin from
              // folding onto itself into thin tentacles or twisted loops.
              if (d2 >= D * D) continue;
              let gap = pk[j] - pk[i];
              if (gap < 0) gap = -gap;
              if (gap <= 2 || bN[oi] - gap <= 2) continue;
              let d = Math.sqrt(d2);
              if (d < 1e-6) { dx = 1e-3; dy = 0; d = 1e-3; }
              const h = (D - d) * 0.5 / d;
              x[i] -= dx * h; y[i] -= dy * h;
              x[j] += dx * h; y[j] += dy * h;
              continue;
            }
            // Different blobs: each bead is pushed off the other blob's skin
            // *segments*, not its beads, so surfaces are smooth and slide freely
            // instead of meshing together like gear teeth.
            const hit = this.pointEdge(i, j) | this.pointEdge(j, i);
            if (hit && li === LAYER_PLAY) {
              bt[oi] = 1; bt[oj] = 1;
              if (cm[oi] && cm[oj] && bv[oi] === bv[oj]) {
                cm[oi] = 0; cm[oj] = 0;
                mp.push(oi, oj);
              }
            }
          }
        }
      }
    }
    this.nStick = ncp;
  }

  // Push bead p out of the two skin segments on either side of bead v (another
  // blob). Returns 1 if they were touching.
  pointEdge(p, v) {
    const { x, y, px, py, pw, po, pk, bN } = this;
    const n = bN[po[v]], k = pk[v], s = v - k;
    const X = x[p], Y = y[p];
    let A = 0, B = 0, T = 0, best = Infinity, qx = 0, qy = 0;
    for (let e = 0; e < 2; e++) {
      const a = e === 0 ? (k === 0 ? s + n - 1 : v - 1) : v;
      const b = e === 0 ? v : (k + 1 === n ? s : v + 1);
      const ex = x[b] - x[a], ey = y[b] - y[a], l2 = ex * ex + ey * ey;
      let t = l2 > 1e-12 ? ((X - x[a]) * ex + (Y - y[a]) * ey) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = x[a] + ex * t, cy = y[a] + ey * t;
      const d2 = (X - cx) * (X - cx) + (Y - cy) * (Y - cy);
      if (d2 < best) { best = d2; A = a; B = b; T = t; qx = cx; qy = cy; }
    }
    const D = 2 * RB;
    if (best >= D * D) return 0;
    let d = Math.sqrt(best), nx, ny;
    if (d > 1e-6) {
      nx = (X - qx) / d; ny = (Y - qy) / d;
    } else {
      const ex = x[B] - x[A], ey = y[B] - y[A], l = Math.sqrt(ex * ex + ey * ey) || 1;
      nx = ey / l; ny = -ex / l; d = 0;
    }
    const pen = D - d;
    const wp = pw[p], ws = pw[A], ga = 1 - T, gb = T;
    const denom = wp + ws * (ga * ga + gb * gb);
    const c = pen / denom;
    x[p] += nx * c * wp; y[p] += ny * c * wp;
    x[A] -= nx * c * ws * ga; y[A] -= ny * c * ws * ga;
    x[B] -= nx * c * ws * gb; y[B] -= ny * c * ws * gb;
    // a touch of Coulomb friction on the relative sliding this substep
    const rx = (x[p] - px[p]) - (ga * (x[A] - px[A]) + gb * (x[B] - px[B]));
    const ry = (y[p] - py[p]) - (ga * (y[A] - py[A]) + gb * (y[B] - py[B]));
    const rn = rx * nx + ry * ny;
    const tx = rx - rn * nx, ty = ry - rn * ny;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > 1e-9) {
      const f = (tl < MU_S * pen ? 1 : Math.min(1, MU_K * pen / tl)) / denom;
      x[p] -= tx * f * wp; y[p] -= ty * f * wp;
      x[A] += tx * f * ws * ga; y[A] += ty * f * ws * ga;
      x[B] += tx * f * ws * gb; y[B] += ty * f * ws * gb;
    }
    return 1;
  }

  // Water balloons don't bounce. For every pair of touching blobs (and every blob
  // touching a wall) soak up the part of their overall motion that is carrying
  // them apart. Momentum still transfers, sliding past each other stays free, and
  // each blob's own wobble is untouched.
  dampBounce(dt) {
    const { x, y, vx, vy, po } = this;
    const f = 1 - Math.exp(-DAMP_BOUNCE * dt);
    const cp = this.stickPairs, ncp = this.nStick;
    const pairs = this.bouncePairs;
    pairs.clear();
    for (let c = 0; c < ncp; c += 2) {
      const i = cp[c], j = cp[c + 1];
      let a = po[i], b = po[j], sx = x[j] - x[i], sy = y[j] - y[i];
      if (a > b) { const t = a; a = b; b = t; sx = -sx; sy = -sy; }
      const key = a * 65536 + b;
      const p = pairs.get(key);
      if (p) { p.nx += sx; p.ny += sy; } else pairs.set(key, { a, b, nx: sx, ny: sy });
    }
    const B = this.blobs, cvx = this.bVelX, cvy = this.bVelY;
    for (const o of B) {
      let sx = 0, sy = 0;
      for (let k = 0; k < o.n; k++) { sx += vx[o.start + k]; sy += vy[o.start + k]; }
      cvx[o.index] = sx / o.n; cvy[o.index] = sy / o.n;
    }
    const shift = (o, dvx, dvy) => {
      for (let k = 0; k < o.n; k++) { vx[o.start + k] += dvx; vy[o.start + k] += dvy; }
      cvx[o.index] += dvx; cvy[o.index] += dvy;
    };
    for (const p of pairs.values()) {
      const A = B[p.a], C = B[p.b];
      const d = Math.hypot(p.nx, p.ny);
      if (d < 1e-9) continue;
      const nx = p.nx / d, ny = p.ny / d;
      const vn = (cvx[p.b] - cvx[p.a]) * nx + (cvy[p.b] - cvy[p.a]) * ny;
      if (vn <= 0) continue;
      const ma = A.n / A.invMass, mc = C.n / C.invMass, dv = vn * f / (ma + mc);
      shift(A, nx * dv * mc, ny * dv * mc);
      shift(C, -nx * dv * ma, -ny * dv * ma);
    }
    for (const o of B) {
      if (o.layer !== LAYER_PLAY) continue;
      for (let w = 0; w < WALLS.length; w++) {
        if (w === CEILING) continue;
        const P = WALLS[w];
        let touching = false;
        for (let k = 0; k < o.n; k++) {
          if (P[0] * x[o.start + k] + P[1] * y[o.start + k] - P[2] <= STICK_MARGIN) { touching = true; break; }
        }
        if (!touching) continue;
        const vn = cvx[o.index] * P[0] + cvy[o.index] * P[1];
        if (vn > 0) shift(o, -P[0] * vn * f, -P[1] * vn * f);
      }
    }
  }

  solveWalls() {
    const { x, y, px, py, pl, po, n } = this;
    const bt = this.bTouch, be = this.bEnter;
    for (let i = 0; i < n; i++) {
      const tube = pl[i] === LAYER_TUBE;
      // a blob sliding into the tube passes through the wall it is coming from
      const skipL = tube && be[po[i]] < 0, skipR = tube && be[po[i]] > 0;
      for (let w = 0; w < WALLS.length; w++) {
        if ((w === 0 && skipL) || (w === 1 && skipR)) continue;
        const P = WALLS[w];
        const nx = P[0], ny = P[1];
        const pen = P[2] - (nx * x[i] + ny * y[i]);
        if (pen <= 0) continue;
        x[i] += nx * pen; y[i] += ny * pen;
        const mu = P[3];
        const dx = x[i] - px[i], dy = y[i] - py[i];
        const dn = dx * nx + dy * ny;
        const tx = dx - dn * nx, ty = dy - dn * ny;
        const tl = Math.sqrt(tx * tx + ty * ty);
        if (tl > 1e-9) {
          const f = tl < mu * pen ? 1 : Math.min(1, mu * pen / tl);
          x[i] -= tx * f; y[i] -= ty * f;
        }
        if (w !== CEILING && !tube) bt[po[i]] = 1;
      }
      if (tube) {
        for (let w = 0; w < TUBE_WALLS.length; w++) {
          if ((w === 2 && skipL) || (w === 3 && skipR)) continue;
          const P = TUBE_WALLS[w];
          const pen = P[2] - (P[0] * x[i] + P[1] * y[i]);
          if (pen > 0) { x[i] += P[0] * pen; y[i] += P[1] * pen; }
        }
      }
    }
  }

  updateCache(b) {
    const { x, y, vx, vy } = this;
    const s = b.start, n = b.n;
    let sx = 0, sy = 0, svx = 0, svy = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = s + k;
      const xi = x[i], yi = y[i];
      sx += xi; sy += yi; svx += vx[i]; svy += vy[i];
      if (xi < minX) minX = xi; if (xi > maxX) maxX = xi;
      if (yi < minY) minY = yi; if (yi > maxY) maxY = yi;
    }
    b.cx = sx / n; b.cy = sy / n;
    b.vx = svx / n; b.vy = svy / n;
    b.minX = minX - RB; b.maxX = maxX + RB;
    b.minY = minY - RB; b.maxY = maxY + RB;
    b.speedPrev = b.speed;
    b.speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  }

  postStep(dt) {
    const { vx, vy } = this;
    const fiP = Math.exp(-DAMP_INT * dt), faP = Math.exp(-DAMP_AIR * dt);
    const fiT = Math.exp(-14 * dt), faT = Math.exp(-3.5 * dt);
    this.dampBounce(dt);
    for (const b of this.blobs) {
      this.updateCache(b);
      if (!Number.isFinite(b.cx) || !Number.isFinite(b.cy)) {
        this.resetShape(b, b.goodX, b.goodY);
        continue;
      }
      b.goodX = b.cx; b.goodY = b.cy;
      // A blob that got turned inside-out by a violent hit gets re-inflated.
      if (b.lastArea < 0.3 * b.area0) {
        b.badT += dt;
        if (b.badT > 0.15) { this.resetShape(b, b.cx, b.cy); continue; }
      } else b.badT = 0;

      const play = b.layer === LAYER_PLAY;
      const fi = play ? fiP : fiT, fa = play ? faP : faT;
      const mvx = b.vx, mvy = b.vy;
      const s = b.start, n = b.n, tx = this.gradX, ty = this.gradY;
      for (let k = 0; k < n; k++) {
        const i = s + k;
        const p = s + (k === 0 ? n - 1 : k - 1), q = s + (k + 1 === n ? 0 : k + 1);
        tx[k] = vx[i] + ((vx[p] + vx[q]) * 0.5 - vx[i]) * SKIN_VISCOSITY;
        ty[k] = vy[i] + ((vy[p] + vy[q]) * 0.5 - vy[i]) * SKIN_VISCOSITY;
      }
      for (let k = 0; k < n; k++) {
        const i = s + k;
        vx[i] = (mvx + (tx[k] - mvx) * fi) * fa;
        vy[i] = (mvy + (ty[k] - mvy) * fi) * fa;
      }
      b.age += dt;
      if (b.shotAge >= 0) b.shotAge += dt;
      if (b.mergeLock > 0) b.mergeLock -= dt;
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 6);
      if (b.entering > 0 && b.maxX <= TUBE_R + 0.5) b.entering = 0;
      else if (b.entering < 0 && b.minX >= TUBE_L - 0.5) b.entering = 0;
      if (b.pendingImpact && this.bTouch[b.index]) {
        b.pendingImpact = false;
        this.events.push({ type: 'impact', blob: b, speed: b.speedPrev });
      }
    }
    this.tick = (this.tick || 0) + 1;
    for (const b of this.blobs) if ((b.index + this.tick) % 8 === 0) this.untwist(b);
    this.antiTunnel();
  }

  resetShape(b, cx, cy) {
    const R = Math.sqrt(b.area0 / (0.5 * b.n * Math.sin(TAU / b.n)));
    cx = Math.min(WORLD_W - R - RB, Math.max(R + RB, Number.isFinite(cx) ? cx : WORLD_W / 2));
    cy = Math.min(WORLD_H - R - RB, Math.max(R + RB, Number.isFinite(cy) ? cy : WORLD_H / 2));
    for (let k = 0; k < b.n; k++) {
      const i = b.start + k, a = TAU * k / b.n;
      this.x[i] = this.px[i] = cx + Math.cos(a) * R;
      this.y[i] = this.py[i] = cy + Math.sin(a) * R;
      this.vx[i] = this.vy[i] = 0;
    }
    b.badT = 0;
    this.updateCache(b);
  }

  // Safety net: if a violent squeeze ever twists a skin into a figure-8, undo the
  // twist by reversing the bead order between the two crossing segments (the
  // beads stay where they are, only the loop is re-threaded).
  untwist(b) {
    const { x, y, px, py, vx, vy } = this;
    const s = b.start, n = b.n;
    for (let pass = 0; pass < 4; pass++) {
      let fi = -1, fj = -1;
      for (let i = 0; i < n && fi < 0; i++) {
        const a0 = s + i, a1 = s + (i + 1) % n;
        const ax0 = Math.min(x[a0], x[a1]), ax1 = Math.max(x[a0], x[a1]);
        const ay0 = Math.min(y[a0], y[a1]), ay1 = Math.max(y[a0], y[a1]);
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue;
          const b0 = s + j, b1 = s + (j + 1) % n;
          if (Math.max(x[b0], x[b1]) < ax0 || Math.min(x[b0], x[b1]) > ax1 ||
              Math.max(y[b0], y[b1]) < ay0 || Math.min(y[b0], y[b1]) > ay1) continue;
          const d1x = x[a1] - x[a0], d1y = y[a1] - y[a0], d2x = x[b1] - x[b0], d2y = y[b1] - y[b0];
          const den = d1x * d2y - d1y * d2x;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((x[b0] - x[a0]) * d2y - (y[b0] - y[a0]) * d2x) / den;
          const u = ((x[b0] - x[a0]) * d1y - (y[b0] - y[a0]) * d1x) / den;
          if (t > 0 && t < 1 && u > 0 && u < 1) { fi = i; fj = j; break; }
        }
      }
      if (fi < 0) return;
      for (let lo = s + fi + 1, hi = s + fj; lo < hi; lo++, hi--) {
        let t;
        t = x[lo]; x[lo] = x[hi]; x[hi] = t;
        t = y[lo]; y[lo] = y[hi]; y[hi] = t;
        t = px[lo]; px[lo] = px[hi]; px[hi] = t;
        t = py[lo]; py[lo] = py[hi]; py[hi] = t;
        t = vx[lo]; vx[lo] = vx[hi]; vx[hi] = t;
        t = vy[lo]; vy[lo] = vy[hi]; vy[hi] = t;
      }
    }
  }

  // Safety net: if a bead ever slips inside another blob, pop it back out.
  antiTunnel() {
    const B = this.blobs, { x, y } = this;
    for (let ai = 0; ai < B.length; ai++) {
      const a = B[ai];
      for (let bi = 0; bi < B.length; bi++) {
        if (ai === bi) continue;
        const b = B[bi];
        if (a.layer !== b.layer) continue;
        if (a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY) continue;
        for (let k = 0; k < a.n; k++) {
          const i = a.start + k;
          const xi = x[i], yi = y[i];
          if (xi < b.minX || xi > b.maxX || yi < b.minY || yi > b.maxY) continue;
          if (this.pointInBlob(xi, yi, b)) this.pushOut(i, b);
        }
      }
    }
  }

  pointInBlob(px, py, b) {
    const { x, y } = this;
    const s = b.start, n = b.n;
    let inside = false;
    for (let k = 0, j = n - 1; k < n; j = k++) {
      const xi = x[s + k], yi = y[s + k], xj = x[s + j], yj = y[s + j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  pushOut(i, b) {
    const { x, y, px, py, vx, vy } = this;
    const s = b.start, n = b.n;
    let best = Infinity, qx = 0, qy = 0, nx = 0, ny = 0;
    for (let k = 0; k < n; k++) {
      const a = s + k, c = s + (k + 1) % n;
      const ex = x[c] - x[a], ey = y[c] - y[a];
      const l2 = ex * ex + ey * ey || 1e-9;
      let t = ((x[i] - x[a]) * ex + (y[i] - y[a]) * ey) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = x[a] + ex * t, cy = y[a] + ey * t;
      const d2 = (x[i] - cx) ** 2 + (y[i] - cy) ** 2;
      if (d2 < best) {
        best = d2; qx = cx; qy = cy;
        const l = Math.sqrt(l2);
        nx = ey / l; ny = -ex / l;
      }
    }
    x[i] = px[i] = qx + nx * RB * 1.2;
    y[i] = py[i] = qy + ny * RB * 1.2;
    vx[i] = b.vx; vy[i] = b.vy;
  }

  // Is a circle of radius r at (cx, cy) touching any blob in play?
  circleHitsPlay(cx, cy, r) {
    const { x, y } = this;
    const r2 = r * r;
    for (const b of this.blobs) {
      if (b.layer !== LAYER_PLAY) continue;
      if (cx + r < b.minX || cx - r > b.maxX || cy + r < b.minY || cy - r > b.maxY) continue;
      for (let k = 0; k < b.n; k++) {
        const dx = x[b.start + k] - cx, dy = y[b.start + k] - cy;
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
  }
}

// Fill unset (-1) entries of a circular array by interpolating between set neighbours.
function fillGaps(arr, fallback) {
  const n = arr.length;
  const set = [];
  for (let k = 0; k < n; k++) if (arr[k] >= 0) set.push(k);
  if (!set.length) { arr.fill(fallback); return; }
  for (let s = 0; s < set.length; s++) {
    const a = set[s], b = set[(s + 1) % set.length];
    const gap = ((b - a + n) % n) || n;
    for (let g = 1; g < gap; g++) {
      const t = g / gap;
      arr[(a + g) % n] = arr[a] + (arr[b] - arr[a]) * t;
    }
  }
}
