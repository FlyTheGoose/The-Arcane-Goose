/* ritual.js — сцена ожидания трактовки.
 *
 * Живёт ТОЛЬКО поверх зоны трактовки (#interp-wrap): стол с раскрытыми
 * картами не трогаем, поэтому ничего в существующей верстке не ломается.
 *
 * Публичный API:
 *   Ritual.start(hostEl, { type, backUrl })   — запустить сцену
 *   Ritual.finish(done)                        — ответ пришёл: сброс + callback
 *   Ritual.stop()                              — снять сцену немедленно (ошибка)
 *   Ritual.typeInto(el, text, done)            — печать первого абзаца
 */
window.Ritual = (function () {
  "use strict";

  var REDUCED = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- профили по ключу расклада (cards.SPREADS) ----
  var PROFILES = {
    single: { cards: 1, entrance: false, discard: false, shuffles: ["idle"],
              switchShuffle: false, maxClots: 2, fogCap: 0.5,
              minShuffle: 0.5, dust: 80 },
    three:  { cards: 3, entrance: true, discard: true,
              shuffles: ["riffle-fan", "overhand", "four-cut"],
              switchShuffle: false, maxClots: 6, fogCap: 0.66,
              minShuffle: 0.8, dust: 130 },
    cross:  { cards: 6, entrance: true, discard: true,
              shuffles: ["riffle-fan", "overhand", "four-cut"],
              switchShuffle: true, maxClots: 6, fogCap: 0.72,
              minShuffle: 0.8, dust: 140 }
  };

  function profileFor(type) {
    if (type === "cross4" || type === "cross5" || type === "celtic") return PROFILES.cross;
    if (type && type.indexOf("three") === 0) return PROFILES.three;
    return PROFILES.single;   // single, one, чат с картой, карта дня
  }

  var ENTER_DUR = { "drop": 0.95, "condense": 1.15, "spark-fan": 1.10, "slide-in": 0.90 };
  var DISC_DUR = { "stack-up": 1.40, "deal-down": 1.10, "scatter": 1.25,
                   "implode": 1.05, "blow-away": 1.15 };
  // Запреты «появление → сброс»: одинаковый силуэт движения читается как откат.
  var FORBID = {
    "condense": ["implode"],
    "spark-fan": ["implode", "scatter"],
    "slide-in": ["scatter"],
    "drop": []
  };

  function Bag(items) { this.items = items.slice(); this.pool = []; this.last = null; }
  Bag.prototype.next = function (skip) {
    for (var guard = 0; guard < 12; guard++) {
      if (!this.pool.length) {
        this.pool = this.items.slice();
        for (var i = this.pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = this.pool[i]; this.pool[i] = this.pool[j]; this.pool[j] = t;
        }
        if (this.pool.length > 1 && this.pool[0] === this.last) this.pool.push(this.pool.shift());
      }
      var v = this.pool.shift();
      if (!skip || skip.indexOf(v) < 0) { this.last = v; return v; }
    }
    return this.items[0];
  };
  var shufBag = new Bag(["riffle-fan", "overhand", "four-cut"]);
  var enterBag = new Bag(["drop", "condense", "spark-fan", "slide-in"]);
  var discBag = new Bag(["stack-up", "deal-down", "scatter", "implode", "blow-away"]);

  var ENTER = 0, SHUFFLE = 1, OUT = 2;
  var scene = null, backImg = null, backSrc = null, raf = 0, typeTimer = null;

  function haptic(kind) {
    try {
      var TG = window.Telegram && window.Telegram.WebApp;
      if (TG && TG.HapticFeedback) TG.HapticFeedback.impactOccurred(kind || "light");
    } catch (e) {}
  }

  // ------------------------------------------------------------------ start
  function start(host, opts) {
    stop();
    if (!host) return;
    opts = opts || {};
    var prof = profileFor(opts.type);

    var layer = document.createElement("div");
    layer.className = "ritual-layer";
    var cv = document.createElement("canvas");
    layer.appendChild(cv);
    // host уже position:relative (см. styles.css .interp-block)
    host.appendChild(layer);

    if (opts.backUrl && backSrc !== opts.backUrl) {
      backImg = new Image();
      backImg.src = opts.backUrl;
      backSrc = opts.backUrl;
    }

    var enter = prof.entrance ? enterBag.next() : null;
    var discard = prof.discard
      ? discBag.next(enter && FORBID[enter] ? FORBID[enter] : null)
      : null;

    scene = {
      host: host, layer: layer, cv: cv, ctx: cv.getContext("2d"),
      prof: prof, W: 0, H: 0,
      phase: enter ? ENTER : SHUFFLE, t: 0, phaseT: 0,
      shuffleStart: 0, pendingDone: null,
      density: 0, stir: 0, dispel: 0,
      enter: enter, discard: discard,
      shuffle: prof.shuffles[Math.floor(Math.random() * prof.shuffles.length)],
      switchAt: 5.5 + Math.random() * 3,
      outT: 0, flash: 0, cards: [], dust: [], clots: [], N: prof.cards
    };
    for (var i = 0; i < scene.N; i++) {
      scene.cards.push({
        i: i, phase: Math.random() * 6.283, cycle: 2.4 + Math.random() * 1.5,
        offset: Math.random() * 3, dropDelay: i * 0.06 + Math.random() * 0.05,
        dirX: (Math.random() - 0.5) * 2, spinDir: Math.random() < 0.5 ? -1 : 1
      });
    }
    measure();
    for (var j = 0; j < prof.dust; j++) scene.dust.push(newDust(true));
    bindInput();
    window.addEventListener("resize", measure);
    if (!REDUCED) {
      scene.prev = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function measure() {
    if (!scene) return;
    var r = scene.host.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    scene.W = r.width; scene.H = r.height;
    scene.cv.width = Math.round(r.width * dpr);
    scene.cv.height = Math.round(r.height * dpr);
    scene.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function newDust(spread) {
    var W = scene.W, H = scene.H;
    return {
      x: Math.random() * W,
      y: spread ? (H * 0.1 + Math.random() * H) : (H + 20 + Math.random() * 60),
      r: 22 + Math.random() * 52,
      vx: (Math.random() - 0.5) * 6, vy: -6 - Math.random() * 9,
      a: 0.05 + Math.random() * 0.13,
      star: Math.random() < 0.22, bound: null, life: Math.random() * 5
    };
  }

  // ------------------------------------------------------------------ input
  var last = null, dragClot = null, tapTimes = [], tapPos = null, vel = { x: 0, y: 0 };

  function pos(e) {
    var r = scene.layer.getBoundingClientRect();
    var p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  }

  function releaseClot(c) {
    for (var j = 0; j < scene.dust.length; j++) {
      if (scene.dust[j].bound === c) scene.dust[j].bound = null;
    }
  }

  function spawnClot(x, y) {
    // Потолок сгустков: самый старый распускается, а не игнорируется тап —
    // иначе жест перестаёт отвечать и это читается как поломка.
    while (scene.clots.length >= scene.prof.maxClots) releaseClot(scene.clots.shift());
    var clot = { x: x, y: y, vx: 0, vy: 0, r: 52, strength: 1, held: true };
    scene.clots.push(clot);
    var taken = 0;
    for (var i = 0; i < scene.dust.length && taken < 26; i++) {
      var p = scene.dust[i];
      if (p.bound) continue;
      p.bound = clot; p.a = Math.min(0.3, p.a * 1.7); p.r *= 0.8; taken++;
    }
    for (var k = 0; k < 20; k++) {
      var q = newDust(false);
      q.x = x + (Math.random() - 0.5) * 66; q.y = y + (Math.random() - 0.5) * 66;
      q.a = 0.14 + Math.random() * 0.16; q.r = 16 + Math.random() * 32;
      q.bound = clot; q.vx = 0; q.vy = 0;
      scene.dust.push(q);
    }
    var cap = scene.prof.dust + 110;
    if (scene.dust.length > cap) scene.dust.splice(0, scene.dust.length - cap);
    haptic("light");
    dragClot = clot;
  }

  function onDown(e) {
    if (!scene || scene.phase >= OUT) return;
    var p = pos(e); last = p; vel = { x: 0, y: 0 };
    var now = performance.now();
    if (tapPos && Math.hypot(p.x - tapPos.x, p.y - tapPos.y) > 44) tapTimes = [];
    tapPos = p;
    tapTimes.push(now);
    tapTimes = tapTimes.filter(function (t) { return now - t < 700; });
    if (tapTimes.length >= 3) { tapTimes = []; spawnClot(p.x, p.y); return; }
    for (var i = 0; i < scene.clots.length; i++) {
      var c = scene.clots[i];
      if (Math.hypot(p.x - c.x, p.y - c.y) < c.r * 1.15) { dragClot = c; c.held = true; break; }
    }
  }

  function onMove(e) {
    if (!scene || !last) return;
    e.preventDefault();
    var p = pos(e);
    var dx = p.x - last.x, dy = p.y - last.y, d = Math.hypot(dx, dy);
    vel.x = vel.x * 0.6 + dx * 0.4; vel.y = vel.y * 0.6 + dy * 0.4;
    last = p;
    if (!d) return;
    if (dragClot) {
      dragClot.x += (p.x - dragClot.x) * 0.35;
      dragClot.y += (p.y - dragClot.y) * 0.35;
      dragClot.vx = vel.x * 0.9; dragClot.vy = vel.y * 0.9;
      return;
    }
    scene.stir = Math.min(1, scene.stir + d / 900);
    for (var i = 0; i < scene.dust.length; i++) {
      var q = scene.dust[i];
      if (q.bound) continue;
      var ddx = q.x - p.x, ddy = q.y - p.y, dist = Math.hypot(ddx, ddy);
      if (dist < 100) {
        var k = (1 - dist / 100) * 0.5;
        q.vx += dx * k + (-ddy) * 0.05 * k;
        q.vy += dy * k + (ddx) * 0.05 * k;
      }
    }
  }

  function onUp() {
    if (dragClot) {
      var speed = Math.hypot(vel.x, vel.y);
      dragClot.held = false;
      if (speed > 9) { dragClot.vx = vel.x * 7; dragClot.vy = vel.y * 7; dragClot.strength = 0.75; }
    }
    dragClot = null; last = null;
  }

  function bindInput() {
    var L = scene.layer;
    L.addEventListener("touchstart", onDown, { passive: true });
    L.addEventListener("touchmove", onMove, { passive: false });
    L.addEventListener("touchend", onUp);
    L.addEventListener("mousedown", onDown);
    L.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // --------------------------------------------------------------- geometry
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }
  function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  function baseSlot(i, cx, cy) {
    var N = scene.N, W = scene.W;
    if (N === 1) return { x: cx, y: cy, rot: 0, k: 0 };
    var k = (i - (N - 1) / 2) / (N - 1 || 1);
    return { x: cx + k * Math.min(W * 0.5, 140) * 0.6, y: cy + Math.abs(k) * 10,
             rot: k * 0.28, k: k };
  }

  function shuffleOffset(style, c, cx, b) {
    var o = { dx: 0, dy: 0, drot: 0, z: c.i }, N = scene.N, W = scene.W;
    if (style === "idle") {
      o.dy = Math.sin(scene.t * 1.3) * 3.2;
      o.drot = Math.sin(scene.t * 0.9) * 0.02;
      return o;
    }
    if (style === "riffle-fan") {
      var u = ((scene.t + c.offset) % c.cycle) / c.cycle;
      var pull = u < 0.5 ? Math.sin(u * 6.283) : 0;
      var dir = (c.i % 2 === 0) ? 1 : -1;
      o.dx = dir * (30 + 14 * Math.abs(b.k)) * pull; o.dy = -22 * pull;
      o.drot = dir * 0.1 * pull;
    } else if (style === "overhand") {
      var period = 0.62;
      var idx = Math.floor(scene.phaseT / period) % N;
      var u2 = (scene.phaseT % period) / period;
      o.dx = (c.i - (N - 1) / 2) * 1.6 - b.x + cx;
      o.dy = -c.i * 2.4;
      o.drot = -b.rot + (c.i - (N - 1) / 2) * 0.01;
      if (c.i === idx) {
        var lift = Math.sin(u2 * Math.PI);
        o.dx += 50 * lift; o.dy += -32 * lift; o.drot += 0.16 * lift; o.z = 100;
      }
    } else if (style === "four-cut") {
      var cycle = 3.4;
      var u3 = (scene.phaseT % cycle) / cycle;
      var piles = Math.min(4, N);
      var pile = c.i % piles;
      var spread = Math.min(W * 0.32, 110);
      var target = (pile - (piles - 1) / 2) / ((piles - 1) / 2 || 1) * spread;
      var swap = (pile % 2 === 0) ? 1 : -1;
      var open, shift;
      if (u3 < 0.32) { open = easeInOut(u3 / 0.32); shift = 0; }
      else if (u3 < 0.62) { open = 1; shift = easeInOut((u3 - 0.32) / 0.30); }
      else if (u3 < 0.85) { open = 1 - easeInOut((u3 - 0.62) / 0.23); shift = 1; }
      else { open = 0; shift = 1; }
      o.dx = (target + shift * swap * spread * 0.66) * open - b.x + cx + (c.i - (N - 1) / 2) * 1.4;
      o.dy = -Math.floor(c.i / piles) * 3 - open * 6;
      o.drot = -b.rot * open;
      o.z = c.i + shift * 4 * (pile % 2);
    }
    return o;
  }

  function entranceMod(kind, c, p, e) {
    var inv = 1 - e, W = scene.W, H = scene.H;
    if (kind === "drop") {
      p.y -= inv * inv * (H * 0.9); p.rot += inv * c.dirX * 0.25;
      p.alpha = Math.min(1, e * 1.6);
    } else if (kind === "condense") {
      p.scale = 0.86 + 0.14 * e; p.alpha = e * e; p.glow = 1 - e;
    } else if (kind === "spark-fan") {
      p.x = W / 2 + (p.x - W / 2) * e; p.y = H * 0.44 + (p.y - H * 0.44) * e;
      p.rot *= e; p.scale = 0.5 + 0.5 * e; p.alpha = Math.min(1, e * 2);
    } else if (kind === "slide-in") {
      var side = (c.i % 2 === 0) ? -1 : 1;
      p.x += side * inv * (W * 0.85); p.rot += side * inv * 0.5;
      p.alpha = Math.min(1, e * 1.8);
    }
    return p;
  }

  function discardMod(kind, c, p, tt) {
    var e = Math.min(1, tt / 0.8), W = scene.W, H = scene.H, N = scene.N;
    if (e <= 0) return p;
    if (kind === "stack-up") {
      var s = easeOut(e);
      p.x += (W / 2 - p.x) * s;
      p.y += (H * 0.44 - p.y) * s - Math.max(0, tt - 0.45) * 520;
      p.rot *= (1 - s); p.alpha = 1 - Math.max(0, (tt - 0.6)) / 0.5;
    } else if (kind === "deal-down") {
      var q = e * e;
      p.y += q * H * 0.95; p.x += q * c.dirX * 110; p.rot += q * c.dirX * 0.8;
      p.alpha = 1 - Math.max(0, (e - 0.6)) / 0.4;
    } else if (kind === "scatter") {
      var ang = (c.i / N) * 6.283 + 0.4, q2 = easeOut(e);
      p.x += Math.cos(ang) * q2 * W * 0.85; p.y += Math.sin(ang) * q2 * H * 0.7;
      p.rot += q2 * c.spinDir * 1.6; p.scale = (p.scale || 1) * (1 - 0.25 * q2);
      p.alpha = 1 - q2 * 0.95;
    } else if (kind === "implode") {
      var q3 = easeInOut(e);
      p.x += (W / 2 - p.x) * q3; p.y += (H * 0.44 - p.y) * q3;
      p.scale = (p.scale || 1) * (1 - 0.9 * q3); p.rot += q3 * c.spinDir * 2.2;
      p.alpha = 1 - Math.pow(q3, 2.2);
    } else if (kind === "blow-away") {
      var q4 = e * e;
      p.x += q4 * (W * 0.9); p.y -= q4 * (H * 0.25) + Math.sin(c.i) * 18 * q4;
      p.rot += q4 * 0.9; p.alpha = 1 - q4;
    }
    return p;
  }

  // ---------------------------------------------------------------- drawing
  function drawCards(dt) {
    var ctx = scene.ctx, W = scene.W, H = scene.H;
    var cx = W / 2, cy = H * 0.44;
    var cw = Math.min(scene.N === 1 ? 96 : 78, W * (scene.N === 1 ? 0.26 : 0.2));
    var ch = cw * 1.62;
    var list = [];
    for (var i = 0; i < scene.N; i++) {
      var c = scene.cards[i];
      c.phase += dt * (0.9 + c.i * 0.05);
      var b = baseSlot(i, cx, cy);
      var o = shuffleOffset(scene.shuffle, c, cx, b);
      var p = {
        x: b.x + o.dx + Math.sin(c.phase) * 2.4,
        y: b.y + o.dy + Math.cos(c.phase * 0.8) * 1.6,
        rot: b.rot + o.drot + Math.sin(c.phase * 0.7) * 0.03,
        alpha: 1, scale: 1, glow: 0, z: o.z
      };
      if (scene.phase === ENTER && scene.enter) {
        var e = Math.max(0, Math.min(1, (scene.phaseT - c.i * 0.075) / 0.62));
        p = entranceMod(scene.enter, c, p, e);
      }
      if (scene.phase >= OUT && scene.discard) {
        p = discardMod(scene.discard, c, p, Math.max(0, scene.outT - c.dropDelay));
      }
      if (p.alpha <= 0.02) continue;
      p.cw = cw; p.ch = ch;
      list.push(p);
    }
    list.sort(function (a, b2) { return a.z - b2.z; });
    for (var n = 0; n < list.length; n++) {
      var q = list[n];
      ctx.save();
      ctx.globalAlpha = q.alpha;
      ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      if (q.scale !== 1) ctx.scale(q.scale, q.scale);
      if (q.glow > 0.01) {
        ctx.shadowColor = "rgba(160,130,220," + q.glow.toFixed(2) + ")";
        ctx.shadowBlur = 24 + q.glow * 22;
      } else {
        ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 7;
      }
      rr(ctx, -q.cw / 2, -q.ch / 2, q.cw, q.ch, 7);
      ctx.fillStyle = "#0d0b10"; ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.save(); ctx.clip();
      if (backImg && backImg.complete && backImg.naturalWidth) {
        ctx.drawImage(backImg, -q.cw / 2, -q.ch / 2, q.cw, q.ch);
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(217,192,138,0.32)"; ctx.lineWidth = 1;
      rr(ctx, -q.cw / 2, -q.ch / 2, q.cw, q.ch, 7); ctx.stroke();
      ctx.restore();
    }
  }

  function updateClots(dt) {
    for (var i = scene.clots.length - 1; i >= 0; i--) {
      var c = scene.clots[i];
      if (!c.held) {
        c.x += c.vx * dt * 21; c.y += c.vy * dt * 21;
        c.vx *= 0.94; c.vy *= 0.94; c.vy -= dt * 3;
        c.strength -= dt * 0.22;
      }
      // Пошёл текст — сгустки распускаются, чтобы не перекрывать трактовку.
      if (scene.dispel > 0) { c.held = false; c.strength -= dt * 2.6; }
      if (c.strength <= 0 || c.y < -110 || c.x < -150 || c.x > scene.W + 150) {
        releaseClot(c); scene.clots.splice(i, 1);
      }
    }
  }

  function drawFog(dt) {
    var ctx = scene.ctx, W = scene.W, H = scene.H;
    var push = scene.phase >= OUT ? Math.min(1, scene.outT / 1.1) : 0;
    var alive = 0;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < scene.dust.length; i++) {
      var p = scene.dust[i];
      p.life += dt;
      if (p.bound) {
        var c = p.bound;
        var dx = c.x - p.x, dy = c.y - p.y, d = Math.max(6, Math.hypot(dx, dy));
        var pull = (d > c.r ? 5.5 : 1.6) * c.strength;
        p.vx += (dx / d) * pull + (-dy / d) * 1.1;
        p.vy += (dy / d) * pull + (dx / d) * 1.1;
        p.vx *= 0.90; p.vy *= 0.90;
      } else {
        p.vx *= 0.985; p.vy *= 0.988; p.vy -= dt * 2;
      }
      p.x += p.vx * dt * (1 + scene.stir * 1.5);
      p.y += p.vy * dt * (1 + scene.stir * 1.1);
      if (push > 0) {
        var ex = p.x - W / 2, ey = p.y - H * 0.45, ed = Math.max(20, Math.hypot(ex, ey));
        p.x += (ex / ed) * 240 * push * dt; p.y += (ey / ed) * 190 * push * dt;
      }
      if (p.y < -80 || p.x < -130 || p.x > W + 130) { scene.dust[i] = newDust(false); continue; }
      if (p.y < H * 0.92) alive++;
      var vis = scene.density * (1 - push);
      if (vis <= 0.01) continue;
      var a = p.a * vis;
      if (p.star) {
        ctx.globalAlpha = Math.min(1, a * 3.4);
        ctx.fillStyle = "rgba(232,220,190,1)";
        ctx.beginPath(); ctx.arc(p.x, p.y, 1 + Math.sin(p.life * 3) * 0.45, 0, 6.283); ctx.fill();
      } else {
        var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        var core = p.bound ? "rgba(150,120,205," : "rgba(120,96,168,";
        g.addColorStop(0, core + a.toFixed(3) + ")");
        g.addColorStop(0.45, "rgba(74,62,110," + (a * 0.55).toFixed(3) + ")");
        g.addColorStop(1, "rgba(10,8,14,0)");
        ctx.globalAlpha = 1; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    }
    ctx.restore();
    // Поле не должно оголяться после активного разгона.
    var floorN = Math.round(scene.prof.dust * 0.8);
    if (scene.phase < OUT && alive < floorN && scene.dust.length < scene.prof.dust + 90) {
      for (var k = 0; k < 3; k++) scene.dust.push(newDust(false));
    }
  }

  function drawFlash() {
    if (scene.flash <= 0.01) return;
    var ctx = scene.ctx, W = scene.W, H = scene.H;
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    var g = ctx.createRadialGradient(W / 2, H * 0.44, 0, W / 2, H * 0.44, Math.max(W, H) * 0.7);
    g.addColorStop(0, "rgba(217,192,138," + (scene.flash * 0.45).toFixed(3) + ")");
    g.addColorStop(1, "rgba(217,192,138,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  // ------------------------------------------------------------------- loop
  function frame(now) {
    if (!scene) return;
    var dt = Math.min(0.05, (now - scene.prev) / 1000);
    scene.prev = now;
    scene.t += dt; scene.phaseT += dt;

    if (scene.phase === ENTER) {
      scene.density = Math.min(0.3, scene.density + dt * 0.16);
      if (scene.phaseT > (ENTER_DUR[scene.enter] || 0.9)) {
        scene.phase = SHUFFLE; scene.phaseT = 0; scene.shuffleStart = scene.t;
      }
    } else if (scene.phase === SHUFFLE) {
      // Туман густеет от времени ожидания, жест только добавляет сверху:
      // прогресс остаётся честным, ответ приходит когда приходит.
      var natural = Math.min(scene.prof.fogCap, scene.t / 9);
      scene.density = Math.min(1, Math.max(scene.density, natural + scene.stir * 0.28));
      scene.stir = Math.max(0, scene.stir - dt * 0.45);
      if (scene.prof.switchShuffle && scene.phaseT > scene.switchAt) {
        scene.shuffle = shufBag.next(); scene.phaseT = 0;
        scene.switchAt = 5.5 + Math.random() * 3;
      }
      if (scene.pendingDone && (scene.t - scene.shuffleStart) >= scene.prof.minShuffle) {
        beginOut();
      }
    } else {
      scene.outT += dt;
      scene.flash = Math.max(0, scene.flash - dt * 1.8);
      scene.density = Math.max(0, scene.density - dt * 0.55);
      var ddur = scene.discard ? (DISC_DUR[scene.discard] || 1.1) : 0.5;
      if (!scene.textStarted && scene.outT > ddur * 0.72) {
        scene.textStarted = true;
        scene.dispel = 1;
        var cb = scene.pendingDone; scene.pendingDone = null;
        if (cb) cb();
      }
      if (scene.outT > ddur + 0.5) { stop(); return; }
    }

    updateClots(dt);
    scene.ctx.clearRect(0, 0, scene.W, scene.H);
    drawCards(dt);
    drawFog(dt);
    drawFlash();
    raf = requestAnimationFrame(frame);
  }

  function beginOut() {
    scene.phase = OUT; scene.outT = 0;
    scene.flash = scene.discard ? 1 : 0.4;
    scene.textStarted = false;
  }

  // Ответ пришёл. Если минимальный показ ещё не выдержан — доигрываем,
  // иначе сцена мигнёт на быстрых ответах.
  function finish(done) {
    if (!scene) { if (done) done(); return; }
    if (REDUCED) { stop(); if (done) done(); return; }
    scene.pendingDone = done || function () {};
    if (scene.phase === SHUFFLE && (scene.t - scene.shuffleStart) >= scene.prof.minShuffle) {
      beginOut();
    }
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    window.removeEventListener("resize", measure);
    window.removeEventListener("mouseup", onUp);
    if (scene && scene.layer && scene.layer.parentNode) {
      scene.layer.parentNode.removeChild(scene.layer);
    }
    scene = null; last = null; dragClot = null; tapTimes = [];
  }

  function active() { return !!scene; }

  // ---------------------------------------------------------- typed reading
  // Средняя скорость чтения про себя — около 20 знаков/с. Берём чуть быстрее.
  var CPS = 29;

  function typeInto(host, text, done) {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    host.innerHTML = "";
    text = text || "";
    var split = text.indexOf("\n\n");
    var first = split > 0 ? text.slice(0, split) : text;
    var rest = split > 0 ? text.slice(split + 2) : "";

    var pFirst = document.createElement("div");
    pFirst.className = "interp-para";
    host.appendChild(pFirst);
    var pRest = null;
    if (rest) {
      pRest = document.createElement("div");
      pRest.className = "interp-para interp-rest";
      pRest.textContent = rest;
      host.appendChild(pRest);
    }

    function showRest() {
      if (pRest) setTimeout(function () { pRest.classList.add("on"); }, 120);
      if (done) done();
    }

    if (REDUCED) {
      pFirst.textContent = first;
      if (pRest) pRest.classList.add("on");
      if (done) done();
      return;
    }

    var caret = document.createElement("span");
    caret.className = "interp-caret";
    caret.textContent = "\u258c";
    var idx = 0, finished = false;

    function finishNow() {
      if (finished) return;
      finished = true;
      if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
      pFirst.textContent = first;
      host.onclick = null;
      showRest();
    }
    // Тап по тексту допечатывает мгновенно: ждать анимацию текста нельзя.
    host.onclick = finishNow;

    function step() {
      if (finished) return;
      idx++;
      pFirst.textContent = first.slice(0, idx);
      pFirst.appendChild(caret);
      if (idx >= first.length) { caret.remove(); finishNow(); return; }
      var ch = first.charAt(idx - 1);
      var d = 1000 / CPS;
      if (ch === "," || ch === ";" || ch === ":") d += 90;
      else if (ch === "." || ch === "!" || ch === "?") d += 180;
      else if (ch === "\u2014") d += 70;
      typeTimer = setTimeout(step, d);
    }
    typeTimer = setTimeout(step, 180);
  }

  return { start: start, finish: finish, stop: stop, active: active,
           typeInto: typeInto, profileFor: profileFor };
})();
