/* Merge-Jar physics engine — deterministic, pre-simulated */
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
  const maxDur = SPEC.maxSeconds || 45;
  const maxSim = maxDur + 20;

  const GRAV = ({ low: 550, normal: 850, high: 1150 })[SPEC.physics?.gravity] || 850;
  const REST = Math.min(SPEC.physics?.bounciness || 0.6, 0.7);

  const SAFE = { l: 20, r: W - 20, t: 65, b: H - 145 };
  const CL = SAFE.l + 15, CR = SAFE.r - 15, CB = SAFE.b - 10, CT = SAFE.t + 70;
  const CW = CR - CL;

  const baseR = Math.min(CW / (N + 8), 12);
  const GR = 1.22;
  const R = [];
  for (let i = 0; i < N; i++) R.push(baseR * Math.pow(GR, i));
  if (R[N - 1] > CW * 0.15) {
    const s = (CW * 0.15) / R[N - 1];
    for (let i = 0; i < N; i++) R[i] *= s;
  }

  const segs = [];
  const shape = SPEC.container?.shape || 'box';
  const cr = shape === 'bowl' ? CW * 0.18 : shape === 'jar' ? CW * 0.06 : 0;
  if (cr > 0) {
    const st = 5;
    for (let i = 0; i < st; i++) {
      const a0 = Math.PI / 2 + (Math.PI / 2) * i / st;
      const a1 = Math.PI / 2 + (Math.PI / 2) * (i + 1) / st;
      segs.push({ x1: CL + cr + cr * Math.cos(a0), y1: CB - cr + cr * Math.sin(a0), x2: CL + cr + cr * Math.cos(a1), y2: CB - cr + cr * Math.sin(a1) });
    }
    segs.push({ x1: CL + cr, y1: CB, x2: CR - cr, y2: CB });
    for (let i = 0; i < st; i++) {
      const a0 = (Math.PI / 2) * i / st;
      const a1 = (Math.PI / 2) * (i + 1) / st;
      segs.push({ x1: CR - cr + cr * Math.cos(a0), y1: CB - cr + cr * Math.sin(a0), x2: CR - cr + cr * Math.cos(a1), y2: CB - cr + cr * Math.sin(a1) });
    }
  } else {
    segs.push({ x1: CL, y1: CB, x2: CR, y2: CB });
  }
  segs.push({ x1: CL, y1: CT, x2: CL, y2: CB });
  segs.push({ x1: CR, y1: CT, x2: CR, y2: CB });
  const nSegs = segs.length;

  const rng = mulberry32(SPEC.seed);
  let bods = [], nid = 0, spawned = 0, merges = 0, done = false, doneT = -1;
  const evts = [], unlocked = new Set([0]);
  let lastMerge = 0;
  const sndT = {};

  function mkBody(tier, x, y, vx, vy, prot) {
    return { id: nid++, t: tier, x: x, y: y, vx: vx || 0, vy: vy || 0, r: R[tier], pr: prot || 0, st: 0, sc: prot > 0 ? 0.3 : 0, dead: false };
  }

  const spawnDur = maxDur * 0.48;
  const spawnInt = spawnDur / TOTAL;
  let spawnAcc = 0;

  /* Compact frame storage */
  const frames = [];
  function captureFrame(time) {
    const live = [];
    for (let i = 0; i < bods.length; i++) {
      if (!bods[i].dead) live.push(bods[i]);
    }
    const n = live.length;
    const d = new Float32Array(n * 6);
    const tr = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const b = live[i], o = i * 6;
      d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.r;
      d[o + 3] = b.st > 0 ? 1 + 0.18 * Math.max(0, b.st / 0.1) : 1;
      d[o + 4] = b.st > 0 ? 1 - 0.12 * Math.max(0, b.st / 0.1) : 1;
      d[o + 5] = Math.min(1, b.sc);
      tr[i] = b.t;
    }
    frames.push({ d: d, tr: tr, n: n, sp: spawned, mg: merges, dn: done, t: time, ul: Array.from(unlocked) });
  }

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
    }

    for (let i = 0; i < nb; i++) {
      const b = bods[i];
      if (b.dead) continue;
      for (let s = 0; s < nSegs; s++) {
        const seg = segs[s];
        const ex = seg.x2 - seg.x1, ey = seg.y2 - seg.y1;
        const l2 = ex * ex + ey * ey;
        if (l2 < 0.001) continue;
        let tp = ((b.x - seg.x1) * ex + (b.y - seg.y1) * ey) / l2;
        if (tp < 0) tp = 0; else if (tp > 1) tp = 1;
        const dx = b.x - (seg.x1 + tp * ex), dy = b.y - (seg.y1 + tp * ey);
        const d2 = dx * dx + dy * dy;
        if (d2 < b.r * b.r && d2 > 0.001) {
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          b.x += nx * (b.r - d) * 1.01; b.y += ny * (b.r - d) * 1.01;
          const vn = b.vx * nx + b.vy * ny;
          if (vn < 0) { b.vx -= (1 + REST) * vn * nx; b.vy -= (1 + REST) * vn * ny; b.st = 0.08; }
        }
      }
      if (b.x - b.r < CL) { b.x = CL + b.r; if (b.vx < 0) b.vx = -b.vx * REST; }
      if (b.x + b.r > CR) { b.x = CR - b.r; if (b.vx > 0) b.vx = -b.vx * REST; }
      if (b.y + b.r > CB) { b.y = CB - b.r; if (b.vy > 0) b.vy = -b.vy * REST; }
    }

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
          toAdd.push(mkBody(nt, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.vx + b.vx) * 0.3, Math.min((a.vy + b.vy) * 0.3 - 25, -8), 0.05));
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

  /* Main pre-simulation loop */
  let sim = 0, nextFrame = 0;
  let compactCounter = 0;

  while (sim < maxSim) {
    if (!done && spawned < TOTAL) {
      spawnAcc += DT;
      while (spawnAcc >= spawnInt && spawned < TOTAL) {
        spawnAcc -= spawnInt;
        const sx = CL + R[0] + 2 + rng() * (CW - R[0] * 2 - 4);
        bods.push(mkBody(0, sx, CT - R[0] - 3, (rng() - 0.5) * 30, 20 + rng() * 35));
        spawned++;
      }
    }

    for (let s = 0; s < SUBSTEPS; s++) substep(SUB_DT);
    sim += DT;

    /* Anti-stall: attract nearest same-tier pair (runs once per DT, not per substep) */
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
        /* Hard teleport if stalled too long */
        if (stallT > 3.0 && d > a.r + b.r + 5) {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          a.x = mx - a.r * 0.5; b.x = mx + b.r * 0.5;
          a.y = my; b.y = my;
          a.vx = 0; a.vy = 0; b.vx = 0; b.vy = 0;
        }
      }
    }

    /* Compact dead bodies periodically */
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

  /* Final compact */
  bods = bods.filter(function (b) { return !b.dead; });

  if (!done) {
    window.SIM = { duration: 0, totalFrames: 0, events: [], seek: function () { }, failed: true };
    document.dispatchEvent(new Event('sim-ready'));
    return;
  }

  /* Build mapped frame indices with slow-mo + hold */
  const slomoStart = Math.max(0, Math.floor((doneT - 0.8) * FPS));
  const doneFrame = Math.min(Math.floor(doneT * FPS), frames.length - 1);
  const mapped = [];
  for (let i = 0; i < Math.min(slomoStart, frames.length); i++) mapped.push(i);
  for (let i = slomoStart; i <= doneFrame; i++) { mapped.push(i); mapped.push(i); mapped.push(i); }
  const holdIdx = Math.min(doneFrame + 1, frames.length - 1);
  for (let h = 0; h < Math.round(1.5 * FPS); h++) mapped.push(holdIdx);

  const duration = mapped.length / FPS;

  /* Canvas */
  const canvas = document.getElementById('sim-canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const icos = {};
  if (window.ICON_DATA) {
    for (var _k in window.ICON_DATA) {
      var img = new Image(); img.src = window.ICON_DATA[_k]; icos[_k] = img;
    }
  }

  function draw(frameIdx) {
    var mi = mapped[frameIdx];
    if (mi === undefined) return;
    var f = frames[mi];
    if (!f) return;
    var p = SPEC.palette || { bg: '#1a1a2e', text: '#fff', accent: '#e94560' };

    ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);

    /* Container */
    ctx.strokeStyle = SPEC.container?.color || '#888';
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(CL, CT);
    for (var si = 0; si < nSegs; si++) { ctx.lineTo(segs[si].x1, segs[si].y1); ctx.lineTo(segs[si].x2, segs[si].y2); }
    ctx.lineTo(CR, CT); ctx.stroke();
    if (SPEC.container?.label) {
      ctx.fillStyle = SPEC.container.color || '#888';
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(SPEC.container.label, (CL + CR) / 2, CB + 14);
    }

    /* Progress bar */
    var barY = SAFE.t + 4, isz = 18, gp = (CW - N * isz) / (N + 1);
    for (var i = 0; i < N; i++) {
      var x = CL + gp * (i + 1) + isz * i + isz / 2;
      var ti = SPEC.tiers[i], ul = f.ul.indexOf(i) >= 0, fin = i === N - 1;
      if (fin && !f.dn) {
        ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(x, barY + 12, isz / 2 + 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#666'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('???', x, barY + 12);
      } else {
        ctx.globalAlpha = ul ? 1 : 0.3;
        var ic = icos[ti.icon];
        if (ic && ic.complete && ic.naturalWidth > 0) ctx.drawImage(ic, x - isz / 2, barY + 3, isz, isz);
        else { ctx.font = (isz - 2) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ti.icon, x, barY + 12); }
        ctx.globalAlpha = 1;
      }
    }

    /* Counter */
    ctx.fillStyle = p.text; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(SPEC.tiers[0].icon + ' × ' + f.sp, CL, SAFE.t + 52);

    /* Hook */
    var vt = frameIdx / FPS;
    if (SPEC.hook && vt < 2.5) {
      ctx.globalAlpha = vt < 2 ? 1 : Math.max(0, 1 - (vt - 2) / 0.5);
      ctx.fillStyle = p.accent; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
      wrapText(ctx, SPEC.hook, W / 2, SAFE.t + 20, W - 40, 22);
      ctx.globalAlpha = 1;
    }

    /* Bodies */
    for (var bi = 0; bi < f.n; bi++) {
      var o = bi * 6;
      var bx = f.d[o], by = f.d[o + 1], br = f.d[o + 2];
      var bsx = f.d[o + 3], bsy = f.d[o + 4], bsc = f.d[o + 5];
      var tier = f.tr[bi], bti = SPEC.tiers[tier];

      ctx.save(); ctx.translate(bx, by);
      var scl = bsc < 1 ? 0.5 + 0.5 * easeBack(bsc) : 1;
      ctx.scale(bsx * scl, bsy * scl);
      var sz = br * 2;
      var bimg = icos[bti.icon];
      if (bimg && bimg.complete && bimg.naturalWidth > 0) ctx.drawImage(bimg, -sz / 2, -sz / 2, sz, sz);
      else { ctx.font = Math.round(sz * 0.8) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = p.text; ctx.fillText(bti.icon, 0, 0); }
      if (bti.accessory) {
        var ai = icos[bti.accessory], as = sz * 0.4;
        if (ai && ai.complete && ai.naturalWidth > 0) ctx.drawImage(ai, sz * 0.15, -sz * 0.45, as, as);
        else { ctx.font = Math.round(as * 0.8) + 'px sans-serif'; ctx.fillText(bti.accessory, sz * 0.25, -sz * 0.3); }
      }
      ctx.restore();

      if (bsc < 0.8 && bsc > 0.05) {
        ctx.fillStyle = p.accent; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(bti.name + ' unlocked!', bx, by - br - 8);
      }
    }

    /* Final reveal */
    if (f.dn && SPEC.finalText) {
      ctx.fillStyle = p.accent; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
      var fy = H / 2;
      for (var fi = 0; fi < f.n; fi++) { if (f.tr[fi] === N - 1) { fy = f.d[fi * 6 + 1] - f.d[fi * 6 + 2] - 30; break; } }
      wrapText(ctx, SPEC.finalText, W / 2, Math.min(fy, H - 160), W - 60, 26);
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
