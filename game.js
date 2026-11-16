/* Neon Runner — endless neon runner. Plain canvas JS, no assets.
   Jump obstacles, duck under beams, reach 1000 m to win. 3 lives. */
(function () {
  'use strict';

  var W = 960, H = 540, GROUND_Y = 470, WIN_DIST = 1000;
  var JUMP_VEL = { low: -640, normal: -760, high: -880 };
  var SPEED_BASE = { slow: 260, normal: 320, fast: 390 };
  var GRAVITY = 2100;

  function loadSettings() {
    var s = { jump: 'normal', speed: 'normal', muted: false };
    try {
      var raw = localStorage.getItem('neonRunnerSettings');
      if (raw) { var p = JSON.parse(raw); if (p.jump) s.jump = p.jump; if (p.speed) s.speed = p.speed; if (typeof p.muted === 'boolean') s.muted = p.muted; }
    } catch (e) { /* storage unavailable */ }
    return s;
  }
  function saveSettings(s) {
    try { localStorage.setItem('neonRunnerSettings', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function loadBest() {
    try { return parseInt(localStorage.getItem('neonRunnerBest') || '0', 10) || 0; } catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('neonRunnerBest', String(v)); } catch (e) { /* ignore */ }
  }

  // ---- audio (WebAudio only, guarded) ----
  var audioCtx = null;
  function beep(freq, dur, type, vol) {
    if (G.settings.muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* no audio */ }
  }
  function sfx(name) {
    if (name === 'jump') beep(420, 0.14, 'square', 0.05);
    else if (name === 'orb') beep(880, 0.12, 'sine', 0.07);
    else if (name === 'hit') { beep(140, 0.3, 'sawtooth', 0.09); beep(90, 0.35, 'sawtooth', 0.09); }
    else if (name === 'win') { beep(523, 0.15, 'sine', 0.08); setTimeout(function () { beep(659, 0.15, 'sine', 0.08); }, 140); setTimeout(function () { beep(784, 0.3, 'sine', 0.08); }, 280); }
  }

  // ---- game state ----
  var G = {
    state: 'title', // title | playing | paused | gameover | win
    settings: loadSettings(),
    best: loadBest(),
    dist: 0, bonus: 0, lives: 3,
    speed: SPEED_BASE.normal,
    player: { x: 120, y: GROUND_Y - 56, vy: 0, w: 44, h: 56, ducking: false, onGround: true, runPhase: 0 },
    obstacles: [], orbs: [], stars: [], buildings: [], farBuildings: [], nearBuildings: [],
    particles: [],
    spawnT: 0, orbT: 0, invulnT: 0, flashT: 0, time: 0,
    hue: 185,
    scrollFar: 0, scrollNear: 0, shakeT: 0, shakeMag: 0,
    flashRed: 0, flashGold: 0, banner: null, nextMilestone: 250,
    dustT: 0, trailT: 0, lowFx: false
  };

  function reset() {
    G.dist = 0; G.bonus = 0; G.lives = 3;
    G.obstacles = []; G.orbs = [];
    G.spawnT = 0.6; G.orbT = 1.2; G.invulnT = 0; G.flashT = 0;
    G.particles = []; G.banner = null; G.nextMilestone = 250;
    G.shakeT = 0; G.flashRed = 0; G.flashGold = 0;
    G.player.y = GROUND_Y - G.player.h; G.player.vy = 0;
    G.player.ducking = false; G.player.onGround = true;
    G.speed = SPEED_BASE[G.settings.speed];
  }

  function currentSpeed() {
    var ramp = 1 + Math.min(G.dist / 1200, 0.9); // up to ~1.9x by 1000 m
    return SPEED_BASE[G.settings.speed] * ramp;
  }

  function playerBox() {
    var p = G.player;
    var h = p.ducking ? 28 : 56;
    return { x: p.x, y: GROUND_Y - h, w: p.w, h: h };
  }

  function spawnObstacle() {
    var r = Math.random();
    var kind = r < 0.45 ? 'spike' : (r < 0.75 ? 'block' : 'beam');
    var o = { kind: kind, x: W + 40 };
    if (kind === 'spike') { o.w = 34; o.h = 46; o.y = GROUND_Y - 46; }
    else if (kind === 'block') { o.w = 44; o.h = 78; o.y = GROUND_Y - 78; }
    else { o.w = 60; o.h = 22; o.y = GROUND_Y - 96; } // beam: head height, duck under it
    G.obstacles.push(o);
  }

  function spawnOrb() {
    var y = GROUND_Y - 90 - Math.random() * 110;
    G.orbs.push({ x: W + 30, y: y, r: 12, taken: false });
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function jump() {
    var p = G.player;
    if (G.state !== 'playing') return false;
    if (p.onGround) {
      p.vy = JUMP_VEL[G.settings.jump];
      p.onGround = false; p.ducking = false;
      sfx('jump');
      return true;
    }
    return false;
  }

  function duck(on) {
    if (G.state !== 'playing') return;
    G.player.ducking = on && G.player.onGround;
  }

  function hitObstacle() {
    G.lives -= 1;
    G.invulnT = 1.6; G.flashT = 0.25;
    hitSparks();
    sfx('hit');
    if (G.lives <= 0) {
      G.state = 'gameover';
      if (Math.floor(G.dist) > G.best) { G.best = Math.floor(G.dist); saveBest(G.best); }
      showOverlay('gameover');
    }
  }

  function step(dt) {
    if (G.state !== 'playing') return;
    dt = Math.min(dt, 0.05);
    G.time += dt;
    G.speed = currentSpeed();
    G.dist += (G.speed * dt) / 12; // ~ metres
    G.scrollFar += G.speed * dt * 0.22;
    G.scrollNear += G.speed * dt * 0.5;
    if (G.dist >= G.nextMilestone) { G.nextMilestone += 250; milestoneFx(); }
    // speed lines once it gets fast
    if (G.speed > 430 && Math.random() < (G.lowFx ? 0.1 : 0.25)) speedStreak();
    // hue drifts cyan -> magenta as speed rises
    G.hue = 185 + Math.min(G.dist / 1000, 1) * 115;

    var p = G.player;
    var wasAir = !p.onGround;
    p.vy += GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y >= GROUND_Y - (p.ducking ? 28 : 56)) { p.y = GROUND_Y - (p.ducking ? 28 : 56); p.vy = 0; p.onGround = true; }
    else p.onGround = false;
    if (wasAir && p.onGround) landBurst();
    p.runPhase += dt * G.speed * 0.045;

    // dust puffs + trail while running
    if (p.onGround) {
      G.dustT -= dt;
      if (G.dustT <= 0) { dustPuff(); G.dustT = G.lowFx ? 0.14 : 0.07; }
    }
    G.trailT -= dt;
    if (G.trailT <= 0) { trailDot(); G.trailT = 0.05; }

    if (G.invulnT > 0) G.invulnT -= dt;
    if (G.flashT > 0) G.flashT -= dt;

    G.spawnT -= dt;
    if (G.spawnT <= 0) {
      spawnObstacle();
      var gap = 0.85 + Math.random() * 0.9;
      G.spawnT = Math.max(0.55, gap * (320 / G.speed));
    }
    G.orbT -= dt;
    if (G.orbT <= 0) { spawnOrb(); G.orbT = 1.6 + Math.random() * 2.2; }

    var pb = playerBox();
    for (var i = G.obstacles.length - 1; i >= 0; i--) {
      var o = G.obstacles[i];
      o.x -= G.speed * dt;
      if (o.x + o.w < -20) { G.obstacles.splice(i, 1); continue; }
      if (G.invulnT <= 0 && aabb(pb, o)) {
        G.obstacles.splice(i, 1);
        hitObstacle();
        if (G.state !== 'playing') return;
      }
    }
    for (var j = G.orbs.length - 1; j >= 0; j--) {
      var orb = G.orbs[j];
      orb.x -= G.speed * dt;
      if (orb.x < -30) { G.orbs.splice(j, 1); continue; }
      var orbBox = { x: orb.x - orb.r, y: orb.y - orb.r, w: orb.r * 2, h: orb.r * 2 };
      if (!orb.taken && aabb(pb, orbBox)) {
        orb.taken = true; G.bonus += 10; G.orbs.splice(j, 1); sfx('orb');
      }
    }

    if (G.dist >= WIN_DIST) {
      G.state = 'win';
      if (Math.floor(G.dist) > G.best) { G.best = Math.floor(G.dist); saveBest(G.best); }
      sfx('win');
      showOverlay('win');
    }
  }

  // ---- rendering ----
  var canvas = null, ctx = null;
  function initStars() {
    G.stars = [];
    for (var i = 0; i < 110; i++) G.stars.push({ x: Math.random() * W, y: Math.random() * 300, s: Math.random() * 2 + 0.5, tw: Math.random() * 6 });
    // far skyline: tall, dim, slow layer
    G.farBuildings = [];
    for (var k = 0; k < 12; k++) G.farBuildings.push({ x: k * 90, w: 55 + Math.random() * 55, h: 120 + Math.random() * 150 });
    // near buildings: shorter, brighter, faster layer
    G.nearBuildings = [];
    for (var m = 0; m < 12; m++) G.nearBuildings.push({ x: m * 95, w: 45 + Math.random() * 45, h: 60 + Math.random() * 110 });
    G.buildings = G.nearBuildings;
  }

  // ---- particles & juice ----
  function particleCap() { return G.lowFx ? 120 : 300; }
  function spawnParticle(p) {
    if (G.particles.length >= particleCap()) return;
    p.life = p.maxLife; G.particles.push(p);
  }
  function burst(x, y, n, colors, speed, size, life) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      spawnParticle({ type: 'dot', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60,
        size: size * (0.6 + Math.random() * 0.8), color: colors[i % colors.length],
        maxLife: life * (0.6 + Math.random() * 0.7) });
    }
  }
  function dustPuff() {
    spawnParticle({ type: 'dot', x: G.player.x + 8 + Math.random() * 28, y: GROUND_Y - 2,
      vx: -40 - Math.random() * 60, vy: -30 - Math.random() * 50,
      size: 3 + Math.random() * 4, color: 'rgba(160,220,255,0.8)', maxLife: 0.5 });
  }
  function trailDot() {
    var pb = playerBox();
    spawnParticle({ type: 'dot', x: pb.x + 4, y: pb.y + pb.h / 2,
      vx: -60, vy: 0, size: 4 + Math.random() * 3,
      color: 'hsl(' + G.hue + ', 100%, 65%)', maxLife: 0.35 });
  }
  function speedStreak() {
    spawnParticle({ type: 'streak', x: W + 20, y: 40 + Math.random() * (GROUND_Y - 80),
      vx: -(G.speed * 2.4), vy: 0, size: 40 + Math.random() * 90,
      color: 'rgba(255,255,255,0.55)', maxLife: 0.6 });
  }
  function landBurst() {
    burst(G.player.x + 22, GROUND_Y - 4, G.lowFx ? 6 : 12, ['#aef', '#fff', '#0ff'], 180, 4, 0.45);
    G.shakeT = 0.08; G.shakeMag = 2;
  }
  function hitSparks() {
    var pb = playerBox();
    burst(pb.x + pb.w / 2, pb.y + pb.h / 2, G.lowFx ? 12 : 26, ['#ff2d55', '#ff9f1c', '#fff'], 380, 5, 0.7);
    G.shakeT = 0.35; G.shakeMag = 9;
    G.flashRed = 1;
  }
  function milestoneFx() {
    var m = Math.floor(G.dist);
    G.banner = { text: m + ' m!', t: 1.4 };
    G.flashGold = 0.7;
    burst(G.player.x + 22, G.player.y, G.lowFx ? 10 : 22, ['#ffe45e', '#fff', '#ff9f1c'], 320, 5, 0.9);
    beep(1046, 0.18, 'sine', 0.07);
  }
  function updateParticles(dt) {
    for (var i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === 'dot') p.vy += 300 * dt; // slight gravity on sparks/dust
    }
  }
  // cosmetic tick: runs every frame in every state
  function tick(dt) {
    updateParticles(dt);
    if (G.shakeT > 0) G.shakeT -= dt;
    if (G.flashRed > 0) G.flashRed = Math.max(0, G.flashRed - dt * 2.2);
    if (G.flashGold > 0) G.flashGold = Math.max(0, G.flashGold - dt * 1.6);
    if (G.banner) { G.banner.t -= dt; if (G.banner.t <= 0) G.banner = null; }
    if (G.state === 'title') { // slow ambient drift behind the title screen
      G.time += dt;
      G.scrollFar += 14 * dt; G.scrollNear += 30 * dt;
    }
  }
  function neon(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.fillStyle = color; ctx.strokeStyle = color; }

  function render() {
    if (!ctx) return;
    var hue = G.hue;
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'hsl(' + (hue + 40) + ', 70%, 10%)');
    grad.addColorStop(0.7, 'hsl(' + hue + ', 65%, 8%)');
    grad.addColorStop(1, '#050510');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    // screen shake wraps the whole scene
    ctx.save();
    if (G.shakeT > 0) {
      var sm = G.shakeMag * Math.max(G.shakeT / 0.35, 0.2);
      ctx.translate((Math.random() - 0.5) * sm * 2, (Math.random() - 0.5) * sm * 2);
    }

    // moon / sun glow (hue follows the speed shift)
    neon('hsl(' + G.hue + ', 100%, 72%)', 70);
    ctx.beginPath(); ctx.arc(W - 140, 92, 42, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(W - 140, 92, 34, 0, Math.PI * 2); ctx.fill();

    // parallax stars
    for (var i = 0; i < G.stars.length; i++) {
      var st = G.stars[i];
      var sx = (st.x - G.time * 20 * st.s) % W; if (sx < 0) sx += W;
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(G.time + st.tw));
      ctx.fillStyle = '#fff'; ctx.fillRect(sx, st.y, st.s, st.s);
    }
    ctx.globalAlpha = 1;

    // parallax skyline — far layer (dim, slow)
    for (var f = 0; f < G.farBuildings.length; f++) {
      var fb = G.farBuildings[f];
      var fx = (((fb.x - G.scrollFar) % (W + 120)) + W + 120) % (W + 120) - 60;
      ctx.fillStyle = 'rgba(30, 30, 78, 0.85)';
      ctx.fillRect(fx, GROUND_Y - fb.h, fb.w, fb.h);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.18)';
      ctx.fillRect(fx, GROUND_Y - fb.h, fb.w, 2);
    }
    // parallax skyline — near layer (brighter, faster, lit windows)
    for (var b = 0; b < G.nearBuildings.length; b++) {
      var bd = G.nearBuildings[b];
      var bx = (((bd.x - G.scrollNear) % (W + 120)) + W + 120) % (W + 120) - 60;
      ctx.fillStyle = 'rgba(14, 14, 46, 0.95)';
      ctx.fillRect(bx, GROUND_Y - bd.h, bd.w, bd.h);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.4)';
      ctx.fillRect(bx, GROUND_Y - bd.h, bd.w, 2);
      ctx.fillStyle = 'rgba(255, 228, 94, 0.55)';
      for (var wy = GROUND_Y - bd.h + 12; wy < GROUND_Y - 14; wy += 22) {
        for (var wx = bx + 8; wx < bx + bd.w - 8; wx += 18) {
          if (((wx * 7 + wy * 13 + b * 31) % 5) < 2) ctx.fillRect(wx, wy, 5, 7);
        }
      }
    }

    // ground grid
    ctx.strokeStyle = 'hsla(' + hue + ', 100%, 60%, 0.5)';
    ctx.lineWidth = 2; ctx.shadowColor = 'hsl(' + hue + ', 100%, 60%)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(0, GROUND_Y); ctx.lineTo(W, GROUND_Y); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.12)'; ctx.lineWidth = 1;
    var off = (G.time * G.speed) % 60;
    for (var gx = -off; gx < W; gx += 60) { ctx.beginPath(); ctx.moveTo(gx, GROUND_Y); ctx.lineTo(gx - 40, H); ctx.stroke(); }

    // orbs
    for (var j = 0; j < G.orbs.length; j++) {
      var orb = G.orbs[j];
      neon('#ffe45e', 16);
      ctx.beginPath(); ctx.arc(orb.x, orb.y + Math.sin(G.time * 4 + j) * 3, orb.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(orb.x, orb.y, orb.r * 0.4, 0, Math.PI * 2); ctx.fill();
    }

    // obstacles
    for (var k2 = 0; k2 < G.obstacles.length; k2++) {
      var o = G.obstacles[k2];
      if (o.kind === 'spike') {
        neon('#ff2d78', 14);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y + o.h); ctx.lineTo(o.x + o.w / 2, o.y); ctx.lineTo(o.x + o.w, o.y + o.h);
        ctx.closePath(); ctx.fill();
      } else if (o.kind === 'block') {
        neon('#ff2d78', 14);
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8);
      } else { // beam — duck under
        neon('#ff9f1c', 14);
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
        for (var hx = o.x + 6; hx < o.x + o.w - 6; hx += 12) ctx.fillRect(hx, o.y + 6, 5, o.h - 12);
        // hanging supports
        ctx.fillStyle = '#ff9f1c';
        ctx.fillRect(o.x + 4, 0, 3, o.y); ctx.fillRect(o.x + o.w - 7, 0, 3, o.y);
      }
    }

    // player
    var p = G.player;
    var pb = playerBox();
    var blink = G.invulnT > 0 && Math.floor(G.time * 12) % 2 === 0;
    if (!blink) {
      var pc = 'hsl(' + hue + ', 100%, 60%)';
      neon(pc, 22);
      var bob = p.onGround ? Math.abs(Math.sin(p.runPhase)) * 4 : 0;
      ctx.fillRect(pb.x, pb.y - bob, pb.w, pb.h);
      ctx.shadowBlur = 0; ctx.fillStyle = '#fff';
      // visor eye
      ctx.fillRect(pb.x + pb.w - 16, pb.y + 10 - bob, 12, 6);
      // legs when running
      if (p.onGround && !p.ducking) {
        var legSwing = Math.sin(p.runPhase) * 8;
        ctx.fillStyle = pc;
        ctx.fillRect(pb.x + 8, pb.y + pb.h - 2, 8, 10 + legSwing);
        ctx.fillRect(pb.x + pb.w - 16, pb.y + pb.h - 2, 8, 10 - legSwing);
      }
    }
    ctx.shadowBlur = 0;

    // particles (dust, trail, sparks, streaks)
    for (var pi = 0; pi < G.particles.length; pi++) {
      var pt = G.particles[pi];
      var pa = Math.max(pt.life / pt.maxLife, 0);
      if (pt.type === 'streak') {
        ctx.globalAlpha = pa * 0.7;
        ctx.fillStyle = pt.color;
        ctx.fillRect(pt.x, pt.y, pt.size, 2);
      } else {
        ctx.globalAlpha = pa;
        ctx.fillStyle = pt.color;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.size * pa + 0.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore(); // end shake

    // distance progress bar to 1000 m
    var prog = Math.min(G.dist / WIN_DIST, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(20, H - 26, W - 40, 8);
    ctx.fillStyle = 'hsl(' + hue + ', 100%, 60%)'; ctx.fillRect(20, H - 26, (W - 40) * prog, 8);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif';
    ctx.fillText('GOAL 1000 m', W - 110, H - 32);

    // hit / milestone flashes + milestone banner (unshaken, on top)
    if (G.flashRed > 0) { ctx.fillStyle = 'rgba(255, 0, 60, ' + (G.flashRed * 0.3) + ')'; ctx.fillRect(0, 0, W, H); }
    if (G.flashGold > 0) { ctx.fillStyle = 'rgba(255, 220, 80, ' + (G.flashGold * 0.22) + ')'; ctx.fillRect(0, 0, W, H); }
    if (G.banner) {
      ctx.globalAlpha = Math.min(1, G.banner.t);
      ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center';
      ctx.shadowColor = '#ffe45e'; ctx.shadowBlur = 24;
      ctx.fillStyle = '#ffe45e';
      ctx.fillText(G.banner.text, W / 2, 120);
      ctx.shadowBlur = 0; ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
  }

  // ---- DOM overlay screens ----
  var overlayEl = null, hudEl = null;
  function el(id) { return document.getElementById(id); }
  function setHud() {
    if (!hudEl) return;
    el('hud-dist').textContent = Math.floor(G.dist) + ' m';
    el('hud-score').textContent = '+' + G.bonus + ' bonus';
    el('hud-speed').textContent = Math.round(G.speed / 12) + ' m/s';
    el('hud-lives').textContent = '♥'.repeat(Math.max(G.lives, 0)) + '♡'.repeat(Math.max(3 - G.lives, 0));
    el('hud-best').textContent = 'Best ' + G.best + ' m';
  }
  function showOverlay(kind) {
    if (!overlayEl) return;
    hudEl.classList.toggle('hidden', kind === 'title');
    if (kind === 'title') {
      overlayEl.innerHTML =
        '<h2>NEON RUNNER</h2>' +
        '<p>Auto-run, jump the spikes and blocks, duck under the orange beams.<br>' +
        'Grab orbs for +10 m bonus. Reach <b>1000 m</b> to win — 3 lives, one lost per hit.</p>' +
        '<div class="settings">' +
        '<span class="set">Jump height: <span id="jump-set"></span></span>' +
        '<span class="set">Speed: <span id="speed-set"></span></span></div>' +
        '<button class="btn" id="start-btn">▶ START RUN</button>' +
        '<p class="controls">Space / ↑ / click / tap — jump &nbsp;·&nbsp; ↓ — duck &nbsp;·&nbsp; P — pause &nbsp;·&nbsp; M — mute<br>' +
        'Best distance: <b>' + G.best + ' m</b></p>';
      wireSettings();
      el('start-btn').addEventListener('click', startGame);
    } else if (kind === 'gameover') {
      overlayEl.innerHTML =
        '<h2>GAME OVER</h2>' +
        '<p class="big">' + Math.floor(G.dist) + ' m &nbsp;·&nbsp; +' + G.bonus + ' bonus</p>' +
        '<p>Best distance: <b>' + G.best + ' m</b> — the neon road ends here… for now.</p>' +
        '<button class="btn" id="retry-btn">↻ RUN AGAIN</button>' +
        '<button class="btn alt" id="menu-btn">TITLE SCREEN</button>';
      el('retry-btn').addEventListener('click', startGame);
      el('menu-btn').addEventListener('click', toTitle);
    } else if (kind === 'win') {
      overlayEl.innerHTML =
        '<h2>🏆 YOU WIN!</h2>' +
        '<p class="big">1000 m reached! &nbsp;·&nbsp; +' + G.bonus + ' bonus</p>' +
        '<p>You outran the neon road. Best distance: <b>' + G.best + ' m</b></p>' +
        '<button class="btn" id="retry-btn">↻ RUN AGAIN</button>' +
        '<button class="btn alt" id="menu-btn">TITLE SCREEN</button>';
      el('retry-btn').addEventListener('click', startGame);
      el('menu-btn').addEventListener('click', toTitle);
    } else if (kind === 'paused') {
      overlayEl.innerHTML =
        '<h2>PAUSED</h2><p>Take a breath. The road is waiting.</p>' +
        '<button class="btn" id="resume-btn">▶ RESUME</button>';
      el('resume-btn').addEventListener('click', togglePause);
    } else {
      overlayEl.innerHTML = '';
    }
  }
  function settingButtons(id, key, options) {
    var host = el(id);
    options.forEach(function (opt) {
      var b = document.createElement('button');
      b.className = 'setbtn' + (G.settings[key] === opt ? ' on' : '');
      b.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        G.settings[key] = opt; saveSettings(G.settings);
        showOverlay('title');
      });
      host.appendChild(b);
    });
  }
  function wireSettings() {
    settingButtons('jump-set', 'jump', ['low', 'normal', 'high']);
    settingButtons('speed-set', 'speed', ['slow', 'normal', 'fast']);
  }
  function startGame() {
    reset();
    G.state = 'playing';
    overlayEl.innerHTML = '';
    hudEl.classList.remove('hidden');
    setHud();
  }
  function toTitle() {
    G.state = 'title';
    reset();
    showOverlay('title');
  }
  function togglePause() {
    if (G.state === 'playing') { G.state = 'paused'; showOverlay('paused'); }
    else if (G.state === 'paused') { G.state = 'playing'; overlayEl.innerHTML = ''; }
  }
  function toggleMute() {
    G.settings.muted = !G.settings.muted; saveSettings(G.settings);
  }

  // ---- input ----
  function onKey(e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      if (G.state === 'title') startGame();
      else if (G.state === 'gameover' || G.state === 'win') startGame();
      else jump();
    } else if (e.code === 'ArrowDown') { e.preventDefault(); duck(true); }
    else if (e.code === 'KeyP') togglePause();
    else if (e.code === 'KeyM') toggleMute();
  }
  function onKeyUp(e) { if (e.code === 'ArrowDown') duck(false); }

  // ---- main loop ----
  var lastT = 0;
  function loop(t) {
    var dt = lastT ? (t - lastT) / 1000 : 0.016;
    lastT = t;
    if (G.state === 'playing') step(dt);
    else if (G.state === 'title') G.time += dt;
    tick(dt);
    render();
    setHud();
    requestAnimationFrame(loop);
  }

  // ---- boot (browser only) ----
  if (typeof document !== 'undefined' && document.getElementById) {
    canvas = document.getElementById('game');
    if (canvas && canvas.getContext) {
      ctx = canvas.getContext('2d');
      // high-DPI: sharp backing store, capped at 2x for phone GPUs
      var dpr = 1;
      try { dpr = Math.min(window.devicePixelRatio || 1, 2); } catch (e) { dpr = 1; }
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // small screens: fewer particles, slower dust, same gameplay
      try { G.lowFx = (window.innerWidth || 9999) < 640; } catch (e) { G.lowFx = false; }
      overlayEl = el('overlay'); hudEl = el('hud');
      initStars();
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (G.state === 'title') startGame();
        else if (G.state === 'gameover' || G.state === 'win') startGame();
        else jump();
      });
      showOverlay('title');
      requestAnimationFrame(loop);
    }
  }

  // testable API (node smoke test + debugging)
  if (typeof globalThis !== 'undefined') {
    globalThis.NeonRunner = {
      G: G, reset: reset, step: step, jump: jump, duck: duck, aabb: aabb,
      startGame: startGame, toTitle: toTitle, togglePause: togglePause,
      currentSpeed: currentSpeed, spawnObstacle: spawnObstacle, spawnOrb: spawnOrb,
      tick: tick, render: render,
      WIN_DIST: WIN_DIST, JUMP_VEL: JUMP_VEL, SPEED_BASE: SPEED_BASE
    };
  }
})();
