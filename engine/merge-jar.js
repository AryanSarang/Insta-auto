/* Merge-Jar physics engine — circular flask, rainbow border */
(function () {
  'use strict';

  function mulberry32(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SPEC = window.SPEC;
  if (!SPEC) return;

  const W = 360, H = 640, FPS = 30;
  const DT = 1 / 60;
  const SUBSTEPS = 2;
  const SUB_DT = DT / SUBSTEPS;

  const N = SPEC.tiers.length;
  const TOTAL = 1 << (N - 1);
  const maxDur = SPEC.maxSeconds || 90;
  const maxSim = maxDur + 20;

  const GRAV = ({ low: 550, normal: 850, high: 1150 })[SPEC.physics?.gravity] || 850;
  const REST = Math.min(SPEC.physics?.bounciness || 0.6, 0.7);

  /* ── Circular flask layout ── */
  const CX = W / 2;
  const CY = 310;
  const CRAD = 148;
  const TUBE_HW = 17;
  const TUBE_TOP = 15;
  const TUBE_BOT = CY - Math.sqrt(CRAD * CRAD - TUBE_HW * TUBE_HW);
  const TUBE_ANGLE = Math.asin(TUBE_HW / CRAD);

  /* ── Tier radii — dramatic size growth ── */
  const GR = 1.42;
  const targetMaxR = CRAD * 0.34;
  const computedBase = targetMaxR / Math.pow(GR, N - 1);
  const baseR = Math.max(4, computedBase);
  const R = [];
  for (let i = 0; i < N; i++) R.push(baseR * Math.pow(GR, i));
  if (R[N - 1] > targetMaxR) {
    const s = targetMaxR / R[N - 1];
    for (let i = 0; i < N; i++) R[i] *= s;
  }

  const rng = mulberry32(SPEC.seed);
  let bods = [], nid = 0, spawned = 0, merges = 0, done = false, doneT = -1;
  const evts = [], unlocked = new Set([0]);
  let lastMerge = 0;
  const sndT = {};

  function mkBody(tier, x, y, vx, vy, prot) {
    return { id: nid++, t: tier, x, y, vx: vx || 0, vy: vy || 0, r: R[tier], pr: prot || 0, st: 0, sc: prot > 0 ? 0.3 : 0, dead: false, mt: 0 };
  }

  const spawnDur = maxDur * 0.45;
  const spawnInt = spawnDur / TOTAL;
  let spawnAcc = 0;

  /* ── Frame storage ── */
  const frames = [];
  function captureFrame(time) {
    const live = [];
    for (let i = 0; i < bods.length; i++) {
      if (!bods[i].dead) live.push(bods[i]);
    }
    const n = live.length;
    const d = new Float32Array(n * 7);
    const tr = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = live[i], o = i * 7;
      d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.r;
      d[o + 3] = b.st > 0 ? 1 + 0.18 * Math.max(0, b.st / 0.1) : 1;
      d[o + 4] = b.st > 0 ? 1 - 0.12 * Math.max(0, b.st / 0.1) : 1;
      d[o + 5] = Math.min(1, b.sc);
      d[o + 6] = Math.max(0, b.mt);
      tr[i] = b.t;
    }
    frames.push({ d, tr, n, sp: spawned, mg: merges, dn: done, t: time, ul: Array.from(unlocked) });
  }

  /* ── Physics substep ── */
  function substep(dt) {
    const nb = bods.length;
    for (let i = 0; i < nb; i++) {
      const b = bods[i];
      if (b.dead) continue;
      b.vy += GRAV * dt;
      b.vx *= 0.996; b.vy *= 0.996;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.pr > 0) b.pr -= dt;
      if (b.st > 0) b.st -= dt;
      if (b.sc < 1) b.sc += dt * 6;
      if (b.mt > 0) b.mt -= dt;
    }

    /* Circle + tube boundary */
    for (let i = 0; i < nb; i++) {
      const b = bods[i];
      if (b.dead) continue;

      const dx = b.x - CX;
      const dy = b.y - CY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;

      const inOpening = Math.abs(dx) < TUBE_HW + b.r * 0.5 && dy < -CRAD * 0.5;

      if (dist + b.r > CRAD && !inOpening) {
        const nx = dx / dist, ny = dy / dist;
        b.x = CX + nx * (CRAD - b.r);
        b.y = CY + ny * (CRAD - b.r);
        const vn = b.vx * nx + b.vy * ny;
        if (vn > 0) {
          b.vx -= (1 + REST) * vn * nx;
          b.vy -= (1 + REST) * vn * ny;
          b.st = 0.06;
        }
      }

      if (b.y < TUBE_BOT + b.r * 2) {
        if (b.x - b.r < CX - TUBE_HW) {
          b.x = CX - TUBE_HW + b.r;
          if (b.vx < 0) { b.vx = -b.vx * REST; b.st = 0.04; }
        }
        if (b.x + b.r > CX + TUBE_HW) {
          b.x = CX + TUBE_HW - b.r;
          if (b.vx > 0) { b.vx = -b.vx * REST; b.st = 0.04; }
        }
      }
    }

    /* Body–body collision + merge */
    const toAdd = [];
    for (let i = 0; i < nb; i++) {
      const a = bods[i];
      if (a.dead) continue;
      for (let j = i + 1; j < nb; j++) {
        const b = bods[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const mr = a.r + b.r;
        if (dx > mr || dx < -mr || dy > mr || dy < -mr) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 >= mr * mr || d2 < 0.0001) continue;
        const d = Math.sqrt(d2);

        if (a.t === b.t && a.pr <= 0 && b.pr <= 0 && a.t < N - 1) {
          a.dead = true; b.dead = true;
          const nt = a.t + 1;
          const nb2 = mkBody(nt, (a.x + b.x) / 2, (a.y + b.y) / 2,
            (a.vx + b.vx) * 0.3, Math.min((a.vy + b.vy) * 0.3 - 25, -8), 0.05);
          nb2.mt = 0.3;
          toAdd.push(nb2);
          merges++; lastMerge = sim;
          if (!unlocked.has(nt)) unlocked.add(nt);
          const sk = nt === N - 1 ? 'final' : 'merge_' + a.t;
          if (sim - (sndT[sk] || 0) >= 0.06) { evts.push({ t: sim, sfx: sk, rate: 1 + (rng() - 0.5) * 0.24 }); sndT[sk] = sim; }
          if (nt === N - 1) { done = true; doneT = sim; }
          break;
        } else {
          const ov = mr - d, p = ov * 0.52;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * p; a.y -= ny * p; b.x += nx * p; b.y += ny * p;
          const dvn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (dvn > 0) {
            const imp = dvn * REST;
            a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny;
            a.st = 0.05; b.st = 0.05;
          }
        }
      }
    }
    for (let i = 0; i < toAdd.length; i++) bods.push(toAdd[i]);
  }

  /* ── Main pre-simulation ── */
  let sim = 0, nextFrame = 0, compactCounter = 0;

  while (sim < maxSim) {
    if (!done && spawned < TOTAL) {
      spawnAcc += DT;
      while (spawnAcc >= spawnInt && spawned < TOTAL) {
        spawnAcc -= spawnInt;
        const sx = CX + (rng() - 0.5) * (TUBE_HW * 2 - R[0] * 3);
        bods.push(mkBody(0, sx, TUBE_TOP + R[0], (rng() - 0.5) * 12, 8 + rng() * 20));
        spawned++;
      }
    }

    for (let s = 0; s < SUBSTEPS; s++) substep(SUB_DT);
    sim += DT;

    /* Anti-stall: attract nearest same-tier pair */
    if (!done && sim - lastMerge > 0.6 && bods.length > 1) {
      let bestD2 = 1e9, bi = -1, bj = -1;
      for (let i = 0; i < bods.length; i++) {
        if (bods[i].dead) continue;
        for (let j = i + 1; j < bods.length; j++) {
          if (bods[j].dead) continue;
          if (bods[i].t !== bods[j].t || bods[i].t >= N - 1) continue;
          const dx = bods[j].x - bods[i].x, dy = bods[j].y - bods[i].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; bi = i; bj = j; }
        }
      }
      if (bi >= 0) {
        const a = bods[bi], b = bods[bj];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const stallT = sim - lastMerge;
        const tierBoost = 1 + a.t * 0.5;
        const force = (250 + stallT * 400) * tierBoost * DT;
        a.vx += dx / d * force; a.vy += dy / d * force;
        b.vx -= dx / d * force; b.vy -= dy / d * force;
        if (stallT > 3.0 && d > a.r + b.r + 5) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          a.x = mx - a.r * 0.5; b.x = mx + b.r * 0.5;
          a.y = my; b.y = my;
          a.vx = 0; a.vy = 0; b.vx = 0; b.vy = 0;
        }
      }
    }

    if (++compactCounter >= 30) {
      compactCounter = 0;
      let w = 0;
      for (let r = 0; r < bods.length; r++) {
        if (!bods[r].dead && bods[r].y - bods[r].r < H + 80) { bods[w++] = bods[r]; }
      }
      bods.length = w;
    }

    if (sim >= nextFrame) { captureFrame(sim); nextFrame += 1 / FPS; }
    if (done && sim > doneT + 2.0) break;
  }

  bods = bods.filter(function (b) { return !b.dead; });

  if (!done) {
    window.SIM = { duration: 0, totalFrames: 0, events: [], seek: function () {}, failed: true };
    document.dispatchEvent(new Event('sim-ready'));
    return;
  }

  /* ── Slow-mo + hold ── */
  const slomoStart = Math.max(0, Math.floor((doneT - 0.8) * FPS));
  const doneFrame = Math.min(Math.floor(doneT * FPS), frames.length - 1);
  const mapped = [];
  for (let i = 0; i < Math.min(slomoStart, frames.length); i++) mapped.push(i);
  for (let i = slomoStart; i <= doneFrame; i++) { mapped.push(i); mapped.push(i); mapped.push(i); }
  const holdIdx = Math.min(doneFrame + 1, frames.length - 1);
  for (let h = 0; h < Math.round(1.5 * FPS); h++) mapped.push(holdIdx);

  const duration = mapped.length / FPS;

  /* ── Canvas — high-DPI ── */
  const canvas = document.getElementById('sim-canvas');
  const PX = window.devicePixelRatio || 3;
  canvas.width = W * PX;
  canvas.height = H * PX;
  const ctx = canvas.getContext('2d');
  ctx.scale(PX, PX);

  /* ── Load icons ── */
  const icos = {};
  if (window.ICON_DATA) {
    for (var _k in window.ICON_DATA) {
      var img = new Image(); img.src = window.ICON_DATA[_k]; icos[_k] = img;
    }
  }

  /* ── Pre-build rainbow HSL table ── */
  const rainbow = [];
  for (let i = 0; i < 360; i++) rainbow.push('hsl(' + i + ',100%,55%)');

  /* ── Draw ── */
  function draw(frameIdx) {
    var mi = mapped[frameIdx];
    if (mi === undefined) return;
    var f = frames[mi];
    if (!f) return;
    var hueOff = frameIdx * 1.8;

    /* Black background */
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    /* Rainbow circle border with glow — two passes */
    var arcStart = -Math.PI / 2 + TUBE_ANGLE;
    var arcTotal = 2 * Math.PI - 2 * TUBE_ANGLE;
    var numSegs = 72;
    var passes = [
      { w: 10, a: 0.14 },
      { w: 2.8, a: 1.0 },
    ];
    for (var pi = 0; pi < passes.length; pi++) {
      ctx.lineWidth = passes[pi].w;
      ctx.lineCap = 'round';
      for (var si = 0; si < numSegs; si++) {
        var a0 = arcStart + (si / numSegs) * arcTotal;
        var a1 = arcStart + ((si + 1.2) / numSegs) * arcTotal;
        var hue = Math.floor((hueOff + (si / numSegs) * 360) % 360);
        ctx.globalAlpha = passes[pi].a;
        ctx.strokeStyle = rainbow[hue];
        ctx.beginPath();
        ctx.arc(CX, CY, CRAD, a0, a1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    /* White tube lines */
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(CX - TUBE_HW, TUBE_TOP);
    ctx.lineTo(CX - TUBE_HW, TUBE_BOT + 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(CX + TUBE_HW, TUBE_TOP);
    ctx.lineTo(CX + TUBE_HW, TUBE_BOT + 2);
    ctx.stroke();

    /* Bodies */
    for (var bi = 0; bi < f.n; bi++) {
      var o = bi * 7;
      var bx = f.d[o], by = f.d[o + 1], br = f.d[o + 2];
      var bsx = f.d[o + 3], bsy = f.d[o + 4], bsc = f.d[o + 5];
      var mergeFlash = f.d[o + 6];
      var tier = f.tr[bi], bti = SPEC.tiers[tier];

      ctx.save();
      ctx.translate(bx, by);
      var scl = bsc < 1 ? 0.5 + 0.5 * easeBack(bsc) : 1;
      ctx.scale(bsx * scl, bsy * scl);

      var sz = br * 2;

      /* Merge flash glow ring */
      if (mergeFlash > 0.01) {
        var flashAlpha = (mergeFlash / 0.3) * 0.45;
        var flashR = br + 3 + (0.3 - mergeFlash) * 20;
        ctx.globalAlpha = flashAlpha;
        ctx.strokeStyle = '#ffe066';
        ctx.lineWidth = 2 + (0.3 - mergeFlash) * 6;
        ctx.beginPath();
        ctx.arc(0, 0, flashR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      /* Draw icon */
      var bimg = icos[bti.icon];
      if (bimg && bimg.complete && bimg.naturalWidth > 0) {
        ctx.drawImage(bimg, -sz / 2, -sz / 2, sz, sz);
      } else {
        ctx.font = Math.round(sz * 0.75) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(bti.icon, 0, 0);
      }

      /* Accessory */
      if (bti.accessory) {
        var ai = icos[bti.accessory], as = sz * 0.4;
        if (ai && ai.complete && ai.naturalWidth > 0) {
          ctx.drawImage(ai, sz * 0.15, -sz * 0.45, as, as);
        } else {
          ctx.font = Math.round(as * 0.7) + 'px sans-serif';
          ctx.fillStyle = '#fff';
          ctx.fillText(bti.accessory, sz * 0.25, -sz * 0.3);
        }
      }

      ctx.restore();
    }

    /* Hook text — always visible at bottom */
    if (SPEC.hook) {
      ctx.fillStyle = '#fff';
      ctx.font = 'italic bold 17px sans-serif';
      ctx.textAlign = 'center';
      wrapText(ctx, SPEC.hook, W / 2, H - 70, W - 50, 22);
    }

    /* Final reveal text */
    if (f.dn && SPEC.finalText) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      wrapText(ctx, SPEC.finalText, CX, CY - CRAD + 30, CRAD * 1.6, 22);
    }
  }

  function wrapText(c, t, x, y, mw, lh) {
    var ws = t.split(' '), l = '', ty = y;
    for (var i = 0; i < ws.length; i++) {
      var ts = l + ws[i] + ' ';
      if (c.measureText(ts).width > mw && l) { c.fillText(l.trim(), x, ty); l = ws[i] + ' '; ty += lh; }
      else l = ts;
    }
    c.fillText(l.trim(), x, ty);
  }

  function easeBack(t) { var c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  window.SIM = {
    duration: duration,
    totalFrames: mapped.length,
    events: evts,
    seek: function (t) { draw(Math.min(Math.floor(t * FPS), mapped.length - 1)); }
  };
  document.dispatchEvent(new Event('sim-ready'));
})();
