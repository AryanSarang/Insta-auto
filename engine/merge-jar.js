/* Merge-Jar physics engine — realistic collisions, mass-based impulses, bounce sounds */
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

  const W = 360, H = 640, FPS = 60;
  const DT = 1 / 60;
  const SUBSTEPS = 4;
  const SUB_DT = DT / SUBSTEPS;

  const N = SPEC.tiers.length;
  const maxDur = SPEC.maxSeconds || 180;
  const maxSim = maxDur + 5;

  const GRAV = ({ low: 100, normal: 180, high: 300 })[SPEC.physics?.gravity] || 180;
  const REST = Math.min(SPEC.physics?.bounciness || 0.5, 0.65);

  /* ── Circular flask ── */
  const CX = W / 2;
  const CY = 280;
  const CRAD = 155;
  const TUBE_HW = 18;
  const TUBE_TOP = 12;
  const TUBE_BOT = CY - Math.sqrt(CRAD * CRAD - TUBE_HW * TUBE_HW);
  const TUBE_ANGLE = Math.asin(TUBE_HW / CRAD);

  /* ── Tier radii ── */
  const GR = 1.25;
  const targetMaxR = CRAD * 0.42;
  const computedBase = targetMaxR / Math.pow(GR, N - 1);
  const baseR = Math.max(14, computedBase);
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

  /* ── Particle system ── */
  const particles = [];
  let flashAmount = 0;
  let shakeX = 0, shakeY = 0;
  let shakeDecay = 0;

  /* ── Shockwave tracking ── */
  const shockwaves = [];

  function mkBody(tier, x, y, vx, vy, prot) {
    var r = R[tier];
    return { id: nid++, t: tier, x, y, vx: vx || 0, vy: vy || 0, r: r, m: r * r * r, pr: prot || 0, st: 0, sc: prot > 0 ? 0.3 : 0, dead: false, mt: 0 };
  }

  /* ── Continuous spawn — adaptive rate ── */
  let spawnAcc = 0, spawnSide = 0;

  function aliveCount() {
    let c = 0;
    for (let i = 0; i < bods.length; i++) if (!bods[i].dead) c++;
    return c;
  }

  function spawnInterval() {
    var alive = aliveCount();
    if (alive > 50) return 1.1;
    if (alive > 40) return 0.9;
    if (alive > 30) return 0.75;
    if (alive > 20) return 0.6;
    if (alive < 8) return 0.3;
    if (alive < 12) return 0.4;
    return 0.5;
  }

  /* ── Spawn particles on merge ── */
  function spawnMergeParticles(x, y, tier, count) {
    var speed = 90 + tier * 35;
    for (var i = 0; i < count; i++) {
      var angle = (i / count) * Math.PI * 2 + rng() * 0.4;
      var spd = speed * (0.6 + rng() * 0.8);
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 40,
        age: 0, maxAge: 0.4 + rng() * 0.2,
        tier: tier,
        size: 2.5 + rng() * 2.5 + tier * 0.6
      });
    }
  }

  function spawnFinalParticles(x, y) {
    for (var i = 0; i < 60; i++) {
      var angle = (i / 60) * Math.PI * 2;
      var spd = 120 + rng() * 100;
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 60,
        age: 0, maxAge: 0.8 + rng() * 0.4,
        tier: -1,
        size: 3.5 + rng() * 3.5
      });
    }
  }

  /* ── Frame storage ── */
  const frames = [];
  function captureFrame(time) {
    var live = [];
    for (var i = 0; i < bods.length; i++) {
      if (!bods[i].dead) live.push(bods[i]);
    }
    var n = live.length;
    var d = new Float32Array(n * 7);
    var tr = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var b = live[i], o = i * 7;
      d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.r;
      d[o + 3] = b.st > 0 ? 1 + 0.25 * Math.max(0, b.st / 0.15) : 1;
      d[o + 4] = b.st > 0 ? 1 - 0.20 * Math.max(0, b.st / 0.15) : 1;
      d[o + 5] = Math.min(1, b.sc);
      d[o + 6] = Math.max(0, b.mt);
      tr[i] = b.t;
    }

    var curParticles = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.age < p.maxAge) {
        var alpha = 1 - (p.age / p.maxAge);
        curParticles.push({ x: p.x, y: p.y, tier: p.tier, alpha: alpha, size: p.size });
      }
    }

    var curShockwaves = [];
    for (var i = 0; i < shockwaves.length; i++) {
      var sw = shockwaves[i];
      var swAge = time - sw.birth;
      if (swAge >= 0 && swAge < 0.3) {
        curShockwaves.push({ x: sw.x, y: sw.y, tier: sw.tier, progress: swAge / 0.3, maxR: sw.maxR });
      }
    }

    frames.push({
      d: d, tr: tr, n: n,
      sp: spawned, mg: merges, dn: done, t: time,
      ul: Array.from(unlocked),
      particles: curParticles,
      shockwaves: curShockwaves,
      flash: flashAmount,
      shakeX: shakeX,
      shakeY: shakeY
    });
  }

  /* ── Physics substep — mass-based collisions with tangential friction ── */
  function substep(dt) {
    var nb = bods.length;

    /* Integrate velocities and positions */
    for (var i = 0; i < nb; i++) {
      var b = bods[i];
      if (b.dead) continue;

      b.vy += GRAV * dt;

      /* Air damping — light so horizontal movement persists */
      b.vx *= 0.9992;
      b.vy *= 0.9992;

      /* Bottom-zone damping — balls settle as they sink lower in flask */
      if (b.y > CY) {
        var depth = Math.min((b.y - CY) / CRAD, 1);
        var bottomDamp = 1 - depth * depth * 0.006;
        b.vx *= bottomDamp;
        b.vy *= bottomDamp;
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.pr > 0) b.pr -= dt;
      if (b.st > 0) b.st -= dt;
      if (b.sc < 1) b.sc += dt * 5;
      if (b.mt > 0) b.mt -= dt;
    }

    /* Circle + tube boundary */
    for (var i = 0; i < nb; i++) {
      var b = bods[i];
      if (b.dead) continue;

      var dx = b.x - CX;
      var dy = b.y - CY;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;

      var inOpening = Math.abs(dx) < TUBE_HW + b.r * 0.5 && dy < -CRAD * 0.5;

      if (dist + b.r > CRAD && !inOpening) {
        var nx = dx / dist, ny = dy / dist;
        b.x = CX + nx * (CRAD - b.r);
        b.y = CY + ny * (CRAD - b.r);
        var vn = b.vx * nx + b.vy * ny;
        if (vn > 0) {
          /* Wall restitution — softer near the bottom for cushioning */
          var wallRest = REST;
          if (b.y > CY + CRAD * 0.3) {
            var bDepth = Math.min((b.y - CY - CRAD * 0.3) / (CRAD * 0.7), 1);
            wallRest *= (1 - bDepth * 0.4);
          }

          /* Tangential velocity for wall friction */
          var vtx = b.vx - vn * nx;
          var vty = b.vy - vn * ny;
          var wallFriction = 0.12;

          /* Reflect normal, apply friction to tangential */
          b.vx -= (1 + wallRest) * vn * nx + vtx * wallFriction;
          b.vy -= (1 + wallRest) * vn * ny + vty * wallFriction;
          b.st = 0.08;

          /* Bounce sound for significant wall hits */
          if (vn > 25 && sim - (sndT['bounce'] || 0) >= 0.05) {
            evts.push({ t: sim, sfx: 'bounce', rate: 0.85 + rng() * 0.35 });
            sndT['bounce'] = sim;
          }
        }
      }

      /* Tube walls */
      if (b.y < TUBE_BOT + b.r * 2) {
        if (b.x - b.r < CX - TUBE_HW) {
          b.x = CX - TUBE_HW + b.r;
          if (b.vx < 0) { b.vx = -b.vx * REST; b.st = 0.06; }
        }
        if (b.x + b.r > CX + TUBE_HW) {
          b.x = CX + TUBE_HW - b.r;
          if (b.vx > 0) { b.vx = -b.vx * REST; b.st = 0.06; }
        }
      }
    }

    /* Body–body collision + merge */
    var toAdd = [];
    for (var i = 0; i < nb; i++) {
      var a = bods[i];
      if (a.dead) continue;
      for (var j = i + 1; j < nb; j++) {
        var bb = bods[j];
        if (bb.dead) continue;
        var dx = bb.x - a.x, dy = bb.y - a.y;
        var mr = a.r + bb.r;
        if (dx > mr || dx < -mr || dy > mr || dy < -mr) continue;
        var d2 = dx * dx + dy * dy;
        if (d2 >= mr * mr || d2 < 0.0001) continue;
        var d = Math.sqrt(d2);

        if (a.t === bb.t && a.pr <= 0 && bb.pr <= 0 && a.t < N - 1) {
          /* ── Merge ── */
          a.dead = true; bb.dead = true;
          var nt = a.t + 1;
          var mergeX = (a.x + bb.x) / 2, mergeY = (a.y + bb.y) / 2;
          var ma = a.m, mb = bb.m, totalM = ma + mb;

          /* Momentum-weighted velocity with small upward pop */
          var tierPop = -8 - nt * 3;
          var newBod = mkBody(nt, mergeX, mergeY,
            (a.vx * ma + bb.vx * mb) / totalM * 0.5,
            Math.min((a.vy * ma + bb.vy * mb) / totalM * 0.5 + tierPop, -5), 0.08);
          newBod.mt = 0.5;
          newBod.sc = 0;
          newBod.st = 0.15;
          toAdd.push(newBod);
          merges++; lastMerge = sim;
          if (!unlocked.has(nt)) unlocked.add(nt);

          /* Particle explosion */
          var pCount = 14 + Math.min(nt, 5) * 4;
          spawnMergeParticles(mergeX, mergeY, nt, pCount);

          /* Shockwave */
          shockwaves.push({ x: mergeX, y: mergeY, tier: nt, birth: sim, maxR: R[nt] * 4 + nt * 8 });

          /* Screen shake on high-tier merges */
          if (nt >= Math.floor(N * 0.3)) {
            var shakeMag = 3 + (nt / N) * 10;
            shakeX = (rng() - 0.5) * shakeMag * 2;
            shakeY = (rng() - 0.5) * shakeMag * 2;
            shakeDecay = 0.2;
            flashAmount = Math.max(flashAmount, 0.25 + (nt / N) * 0.5);
          }

          /* Final form particles */
          if (nt === N - 1) {
            spawnFinalParticles(mergeX, mergeY);
          }

          var sk = nt === N - 1 ? 'final' : 'merge_' + a.t;
          if (sim - (sndT[sk] || 0) >= 0.06) { evts.push({ t: sim, sfx: sk, rate: 1 + (rng() - 0.5) * 0.24 }); sndT[sk] = sim; }
          if (nt === N - 1) { done = true; doneT = sim; }
          break;

        } else {
          /* ── Non-merge collision: mass-based impulse ── */
          var nx = dx / d, ny = dy / d;
          var ma = a.m, mb = bb.m, totalM = ma + mb;

          /* Positional correction — mass-weighted so lighter balls move more */
          var ov = mr - d;
          a.x -= nx * ov * (mb / totalM);
          a.y -= ny * ov * (mb / totalM);
          bb.x += nx * ov * (ma / totalM);
          bb.y += ny * ov * (ma / totalM);

          /* Normal impulse with restitution */
          var dvx = a.vx - bb.vx, dvy = a.vy - bb.vy;
          var dvn = dvx * nx + dvy * ny;
          if (dvn > 0) {
            var J = (1 + REST) * dvn / (1 / ma + 1 / mb);
            a.vx -= (J / ma) * nx;
            a.vy -= (J / ma) * ny;
            bb.vx += (J / mb) * nx;
            bb.vy += (J / mb) * ny;

            /* Tangential friction — balls don't just slide past each other */
            var dvtx = dvx - dvn * nx, dvty = dvy - dvn * ny;
            var dvt = Math.sqrt(dvtx * dvtx + dvty * dvty);
            if (dvt > 0.1) {
              var fJ = Math.min(J * 0.15, dvt * ma * mb / totalM * 0.5);
              a.vx -= (dvtx / dvt) * fJ / ma;
              a.vy -= (dvty / dvt) * fJ / ma;
              bb.vx += (dvtx / dvt) * fJ / mb;
              bb.vy += (dvty / dvt) * fJ / mb;
            }

            a.st = 0.05; bb.st = 0.05;

            /* Bounce sound for significant ball-ball hits */
            if (dvn > 30 && sim - (sndT['bounce'] || 0) >= 0.05) {
              evts.push({ t: sim, sfx: 'bounce', rate: 0.8 + rng() * 0.4 });
              sndT['bounce'] = sim;
            }
          }
        }
      }
    }
    for (var i = 0; i < toAdd.length; i++) bods.push(toAdd[i]);
  }

  /* ── Main pre-simulation ── */
  var sim = 0, nextFrame = 0, compactCounter = 0;

  while (sim < maxSim) {
    /* Continuous spawning until done */
    if (!done) {
      spawnAcc += DT;
      var interval = spawnInterval();
      while (spawnAcc >= interval) {
        spawnAcc -= interval;
        var side = (spawnSide % 2 === 0) ? -1 : 1;
        var sx = CX + side * rng() * (TUBE_HW - R[0]);
        bods.push(mkBody(0, sx, TUBE_TOP - R[0],
          side * (10 + rng() * 15), 10 + rng() * 10, 1.0));
        spawnSide++;
        spawned++;
      }
    }

    for (var s = 0; s < SUBSTEPS; s++) substep(SUB_DT);
    sim += DT;

    /* Update particles */
    for (var pi = particles.length - 1; pi >= 0; pi--) {
      var p = particles[pi];
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      p.vy += 200 * DT;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.age += DT;
      if (p.age >= p.maxAge) { particles.splice(pi, 1); }
    }

    /* Decay shockwaves */
    while (shockwaves.length > 0 && sim - shockwaves[0].birth > 0.35) shockwaves.shift();

    /* Decay flash and shake */
    if (flashAmount > 0) flashAmount = Math.max(0, flashAmount - DT * 3);
    if (shakeDecay > 0) {
      shakeDecay -= DT;
      var shakeFade = Math.max(0, shakeDecay / 0.2);
      shakeX *= shakeFade;
      shakeY *= shakeFade;
    } else {
      shakeX = 0; shakeY = 0;
    }

    /* Anti-stall: attract highest-tier same-tier pair (nearest if tied) */
    if (!done && sim - lastMerge > 1.8 && bods.length > 1) {
      var bestTier = -1, bestD2 = 1e9, bi = -1, bj = -1;
      for (var i = 0; i < bods.length; i++) {
        if (bods[i].dead) continue;
        for (var j = i + 1; j < bods.length; j++) {
          if (bods[j].dead) continue;
          if (bods[i].t !== bods[j].t || bods[i].t >= N - 1) continue;
          var dx = bods[j].x - bods[i].x, dy = bods[j].y - bods[i].y;
          var d2 = dx * dx + dy * dy;
          if (bods[i].t > bestTier || (bods[i].t === bestTier && d2 < bestD2)) {
            bestTier = bods[i].t; bestD2 = d2; bi = i; bj = j;
          }
        }
      }
      if (bi >= 0) {
        var a = bods[bi], b = bods[bj];
        var dx = b.x - a.x, dy = b.y - a.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        var stallT = sim - lastMerge;
        var tierBoost = 1 + a.t * 0.5;
        var ramp = Math.min((stallT - 1.8) * 0.6, 3.0);
        var timePressure = (!done && sim > maxSim * 0.6) ? 1 + (sim - maxSim * 0.6) / (maxSim * 0.4) * 3.0 : 1.0;
        var force = (80 + ramp * 140) * tierBoost * timePressure * DT;
        a.vx += dx / d * force; a.vy += dy / d * force;
        b.vx -= dx / d * force; b.vy -= dy / d * force;
      }
    }

    if (++compactCounter >= 30) {
      compactCounter = 0;
      var w = 0;
      for (var r2 = 0; r2 < bods.length; r2++) {
        if (!bods[r2].dead && bods[r2].y - bods[r2].r < H + 80) { bods[w++] = bods[r2]; }
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

  /* ── Slow-mo (5x) + extended hold ── */
  var slomoStart = Math.max(0, Math.floor((doneT - 1.2) * FPS));
  var doneFrame = Math.min(Math.floor(doneT * FPS), frames.length - 1);
  var mapped = [];
  for (var i = 0; i < Math.min(slomoStart, frames.length); i++) mapped.push(i);
  for (var i = slomoStart; i <= doneFrame; i++) {
    for (var rep = 0; rep < 5; rep++) mapped.push(i);
  }
  var holdIdx = Math.min(doneFrame + 1, frames.length - 1);
  var baseHoldSec = 5.0;
  var minDur = SPEC.minSeconds || 60;
  var currentDur = mapped.length / FPS;
  var holdSec = Math.max(baseHoldSec, minDur - currentDur);
  for (var h = 0; h < Math.round(holdSec * FPS); h++) mapped.push(holdIdx);

  /* ── Clean hold frame: only final-tier body, centered ── */
  var holdFrame = frames[holdIdx];
  if (holdFrame) {
    var finalBi = -1;
    for (var bi = 0; bi < holdFrame.n; bi++) {
      if (holdFrame.tr[bi] === N - 1) { finalBi = bi; break; }
    }
    if (finalBi >= 0) {
      var fo = finalBi * 7;
      var cleanD = new Float32Array(7);
      cleanD[0] = CX;
      cleanD[1] = CY;
      cleanD[2] = holdFrame.d[fo + 2];
      cleanD[3] = 1;
      cleanD[4] = 1;
      cleanD[5] = 1;
      cleanD[6] = 0;
      var cleanTr = new Uint8Array([N - 1]);
      frames[holdIdx] = {
        d: cleanD, tr: cleanTr, n: 1,
        sp: holdFrame.sp, mg: holdFrame.mg, dn: true, t: holdFrame.t,
        ul: holdFrame.ul,
        particles: holdFrame.particles || [],
        shockwaves: [],
        flash: 0,
        shakeX: 0, shakeY: 0
      };
    }
  }

  var duration = mapped.length / FPS;

  /* ── Canvas — high-DPI ── */
  var canvas = document.getElementById('sim-canvas');
  var PX = window.devicePixelRatio || 3;
  canvas.width = W * PX;
  canvas.height = H * PX;
  var ctx = canvas.getContext('2d');
  ctx.scale(PX, PX);

  /* ── Load icons (with preload) ── */
  var icos = {};
  var iconPromises = [];
  if (window.ICON_DATA) {
    for (var _k in window.ICON_DATA) {
      (function (key) {
        var img = new Image();
        iconPromises.push(new Promise(function (resolve) {
          img.onload = resolve;
          img.onerror = function () { console.warn('Icon load failed: ' + key); resolve(); };
          setTimeout(resolve, 2000);
        }));
        img.src = window.ICON_DATA[key];
        icos[key] = img;
      })(_k);
    }
  }

  /* ── Pre-build rainbow HSL table ── */
  var rainbow = [];
  for (var i = 0; i < 360; i++) rainbow.push('hsl(' + i + ',100%,55%)');

  /* ── Tier color palette ── */
  var TIER_HUES = [180, 120, 60, 30, 330, 280, 200, 45];
  function tierColor(tier) {
    return 'hsl(' + TIER_HUES[tier % TIER_HUES.length] + ',90%,60%)';
  }

  function goldColor(alpha) {
    return 'rgba(255,220,80,' + alpha + ')';
  }

  /* ── Easing functions ── */
  function easeBack(t) { var c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

  function easeElasticOut(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1;
  }

  /* ── Draw ── */
  function draw(frameIdx) {
    var mi = mapped[frameIdx];
    if (mi === undefined) return;
    var f = frames[mi];
    if (!f) return;
    var hueOff = frameIdx * 1.2;
    var isHold = frameIdx >= mapped.length - Math.round(3.0 * FPS);

    /* Black background */
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    /* Apply camera shake */
    ctx.save();
    ctx.translate(f.shakeX || 0, f.shakeY || 0);

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

    /* Draw shockwaves behind bodies */
    if (f.shockwaves) {
      for (var swi = 0; swi < f.shockwaves.length; swi++) {
        var sw = f.shockwaves[swi];
        var swAlpha = (1 - sw.progress) * 0.6;
        var swRadius = sw.progress * sw.maxR;
        ctx.globalAlpha = swAlpha;
        ctx.strokeStyle = tierColor(sw.tier);
        ctx.lineWidth = Math.max(1.5, 5 * (1 - sw.progress));
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, swRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* Bodies */
    var glowTier = Math.floor(N * 0.4);
    for (var bi = 0; bi < f.n; bi++) {
      var o = bi * 7;
      var bx = f.d[o], by = f.d[o + 1], br = f.d[o + 2];
      var bsx = f.d[o + 3], bsy = f.d[o + 4], bsc = f.d[o + 5];
      var mergeFlash = f.d[o + 6];
      var tier = f.tr[bi], bti = SPEC.tiers[tier];

      ctx.save();
      ctx.translate(bx, by);

      /* Elastic ease-out for spawn scale */
      var scl = bsc < 1 ? easeElasticOut(bsc) : 1;

      if (f.dn && tier === N - 1) {
        scl *= 1.5 + 0.12 * Math.sin(frameIdx * 0.08);
      }

      ctx.scale(bsx * scl, bsy * scl);

      var sz = br * 2;

      /* Tier glow for higher-tier items */
      if (tier >= glowTier) {
        var glowStrength = (tier - glowTier + 1) / (N - glowTier);
        var glowAlpha = 0.1 + glowStrength * 0.22;
        var glowR = br * (1.4 + glowStrength * 0.6);
        var grad = ctx.createRadialGradient(0, 0, br * 0.3, 0, 0, glowR);
        grad.addColorStop(0, tierColor(tier));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = glowAlpha;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      /* Final tier golden glow during hold */
      if (f.dn && tier === N - 1) {
        var pulseGlow = 0.5 + 0.5 * Math.sin(frameIdx * 0.06);
        var goldR = br * (3.0 + pulseGlow * 1.0);
        var goldGrad = ctx.createRadialGradient(0, 0, br * 0.5, 0, 0, goldR);
        goldGrad.addColorStop(0, 'rgba(255,224,102,0.6)');
        goldGrad.addColorStop(0.5, 'rgba(255,200,50,0.25)');
        goldGrad.addColorStop(1, 'rgba(255,180,0,0)');
        ctx.fillStyle = goldGrad;
        ctx.beginPath();
        ctx.arc(0, 0, goldR, 0, Math.PI * 2);
        ctx.fill();
      }

      /* Merge flash glow ring */
      if (mergeFlash > 0.01 && !(f.dn && tier === N - 1)) {
        var flashProgress = 1 - (mergeFlash / 0.5);
        var ringR = br + 5 + flashProgress * 25;
        var ringAlpha = (mergeFlash / 0.5) * 0.6;
        ctx.globalAlpha = ringAlpha;
        ctx.strokeStyle = tierColor(tier);
        ctx.lineWidth = 2.5 + (1 - flashProgress) * 4;
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = ringAlpha * 0.4;
        ctx.fillStyle = tierColor(tier);
        ctx.beginPath();
        ctx.arc(0, 0, br * 1.2, 0, Math.PI * 2);
        ctx.fill();
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

    /* Draw particles */
    if (f.particles) {
      for (var pi2 = 0; pi2 < f.particles.length; pi2++) {
        var p = f.particles[pi2];
        ctx.globalAlpha = p.alpha * 0.9;
        ctx.fillStyle = p.tier === -1 ? goldColor(p.alpha) : tierColor(p.tier);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /* Screen flash overlay */
    if (f.flash > 0.01) {
      ctx.globalAlpha = Math.min(f.flash * 0.35, 0.5);
      ctx.fillStyle = '#fff';
      ctx.fillRect(-10, -10, W + 20, H + 20);
      ctx.globalAlpha = 1;
    }

    /* End camera shake transform */
    ctx.restore();

    /* Hook text — bold, below circle, with drop shadow */
    if (SPEC.hook && !f.dn) {
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      wrapText(ctx, SPEC.hook, CX + 1, CY + CRAD + 42, W - 40, 26);
      ctx.fillStyle = '#fff';
      wrapText(ctx, SPEC.hook, CX, CY + CRAD + 41, W - 40, 26);
    }

    /* Final reveal text — bold, above circle, with golden glow */
    if (f.dn && SPEC.finalText) {
      ctx.save();
      var ftY = Math.max(25, CY - CRAD - 40);
      ctx.shadowColor = '#ffe066';
      ctx.shadowBlur = 12;
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      wrapText(ctx, SPEC.finalText, CX, ftY, W - 36, 30);
      ctx.restore();
    }

    /* Vignette during final reveal */
    if (f.dn) {
      var vig = ctx.createRadialGradient(CX, CY, CRAD * 0.7, CX, CY, H * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, W, H);
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

  var simObj = {
    duration: duration,
    totalFrames: mapped.length,
    events: evts,
    seek: function (t) { draw(Math.min(Math.floor(t * FPS), mapped.length - 1)); }
  };

  Promise.all(iconPromises).then(function () {
    window.SIM = simObj;
    document.dispatchEvent(new Event('sim-ready'));
  });
})();
