/* ============================================================
   Tarot MiniApp — front-end logic (Milestone 2: ритуал вариант А)
   Talks to api.py. Auth via Telegram WebApp initData.

   Ритуал:
     1) на главной можно ввести вопрос (по желанию) и выбрать расклад;
     2) POST /api/spread/draw — карты приходят рубашкой вверх;
     3) тап по каждой карте — переворот; подпись позиции видна сразу;
     4) когда раскрыты ВСЕ карты — POST /api/spread/interpret и показ трактовки.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.TAROT_CONFIG || {};
  var API = (CFG.API_BASE || "").replace(/\/+$/, "");
  var TG = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

  // Запасные лейблы (каталог /api/spreads перекроет их живыми данными).
  var LABELS = {
    single: "Карта дня",
    three: "Прошлое · Настоящее · Будущее",
    three_sit: "Ситуация · Препятствие · Совет",
    three_mind: "Мысли · Чувства · Действия",
    three_cause: "Причина · Настоящее · Итог",
    cross4: "Крест (4 карты)",
    cross5: "Крест (5 карт)",
    celtic: "Кельтский крест",
    auto_1: "Карта дня", auto_3: "Три карты", auto_10: "Кельтский крест",
    manual_1: "Карта дня", manual_3: "Три карты", manual_10: "Крест",
    daily_auto: "Карта дня", daily_manual: "Карта дня"
  };
  var GROUP_TITLES = {
    daily: "На день",
    triple: "Три карты",
    cross: "Кресты",
    celtic: "Кельтский крест"
  };
  var GROUP_ORDER = ["daily", "triple", "cross", "celtic"];

  // ---- State ----
  var state = {
    me: null, features: null, catalog: [], catalogLabels: {},
    current: null, chat: null, coins: null
  };

  // ---- DOM helpers ----
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function haptic(kind) {
    try {
      if (!TG || !TG.HapticFeedback) return;
      if (kind === "error" || kind === "success" || kind === "warning") TG.HapticFeedback.notificationOccurred(kind);
      else TG.HapticFeedback.impactOccurred(kind || "light");
    } catch (e) {}
  }

  function overlay(show, text) {
    var o = $("#overlay");
    if (text) $("#overlay-text").textContent = text;
    o.hidden = !show;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  // ---- API ----
  function authHeader() {
    if (TG && TG.initData) return { Authorization: "tma " + TG.initData };
    return {};
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, authHeader(), opts.headers || {});
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { raw: txt }; }
        if (!r.ok) {
          var err = new Error("http_" + r.status);
          err.status = r.status;
          err.detail = data && data.detail !== undefined ? data.detail : data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---- Navigation ----
  // Звёздная пыль на главном экране — лёгкий CSS-слой из мерцающих частиц.
  function initStardust() {
    var home = document.getElementById("screen-home");
    if (!home || home.querySelector(".stardust")) return;
    var layer = document.createElement("div");
    layer.className = "stardust";
    for (var i = 0; i < 24; i++) {
      var s = document.createElement("span");
      s.className = "dust";
      s.style.left = (Math.random() * 100).toFixed(2) + "%";
      s.style.top = (Math.random() * 100).toFixed(2) + "%";
      var dur = (6 + Math.random() * 9);
      s.style.animationDuration = dur.toFixed(2) + "s";
      s.style.animationDelay = (-Math.random() * dur).toFixed(2) + "s";
      var sz = (1 + Math.random() * 2.6).toFixed(2);
      s.style.width = sz + "px";
      s.style.height = sz + "px";
      layer.appendChild(s);
    }
    home.insertBefore(layer, home.firstChild);
  }

  function showScreen(name) {
    $all(".screen").forEach(function (s) { s.classList.remove("active"); });
    var scr = $("#screen-" + name);
    if (scr) scr.classList.add("active");
    $all(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-nav") === name);
    });
    var sc = $(".scroll"); if (sc) sc.scrollTop = 0;
  }

  function navigate(name) {
    showScreen(name);
    if (name === "decks") loadDecks();
    else if (name === "history") loadHistory();
    else if (name === "week") loadWeek();
    else if (name === "settings") renderSettings();
    else if (name === "manual") setupManual();
    else if (name === "calendar") loadCalendar();
    else if (name === "collection") loadCollection();
    else if (name === "readers") loadReaders();
    else if (name === "quests") loadQuests();
    else if (name === "admin") loadAdminStats();
    else if (name === "home") loadMe();
  }

  // ---- Theme ----
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "violet" ? "violet" : "noir");
    $all(".theme-opt").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-theme-opt") === theme);
    });
  }

  // ---- Limits / chips ----
  function fmtRemaining(v) { return v < 0 ? "∞" : String(v); }

  function renderLimits(limits) {
    if (!limits) return;
    $all(".sc-chip").forEach(function (chip) {
      var action = chip.getAttribute("data-chip");
      if (!action || !limits[action]) return;
      var rem = limits[action].remaining;
      chip.textContent = limits[action].unlimited ? "∞" : fmtRemaining(rem);
      chip.classList.toggle("empty", !limits[action].unlimited && rem === 0);
    });
  }

  function labelFor(type) {
    return state.catalogLabels[type] || LABELS[type] || type;
  }

  // ---- /api/me ----
  function loadMe() {
    return apiFetch("/api/me").then(function (me) {
      state.me = me;
      state.features = me.features;
      state.backs = me.backs || null;
      state.backUrl = (me.backs && me.backs.url) ? me.backs.url : null;
      if (state.backUrl) preloadImage(API + state.backUrl);
      applyTheme(me.theme);
      applyLang(me.language);
      renderRank(me.rank);
      $("#admin-badge").hidden = !me.is_admin;
      updateStars(me.limits);
      loadCatalog(me.limits);
      loadDeckPill();
      loadWeekBanner();
      renderPremium(me);
      renderReaderPill(me.interpreter);
      renderCoins(me.coins);
      syncTimezone(me);
    }).catch(handleError);
  }

  // ---- Трактователи (interpreter personas) ----
  function renderReaderPill(it) {
    if (!it) return;
    var em = $("#reader-pill-emoji");
    var nm = $("#reader-pill-name");
    if (em) em.textContent = it.emoji || "\uD83D\uDD2E";
    if (nm) nm.textContent = it.name || "Таролог";
  }

  function readerActionLabel(r) {
    if (r.selected) return "✓ Выбран";
    if (r.available) return "Выбрать";
    if (r.premium_selectable) return "Включить в Premium";
    return "Купить · ⭐ " + (r.price_stars || 0);
  }

  function loadReaders() {
    var wrap = $("#readers-list");
    if (wrap) { wrap.innerHTML = ""; wrap.appendChild(el("div", "empty-note", "Загружаю трактователей…")); }
    return apiFetch("/api/interpreters").then(function (res) {
      renderReaders(res);
    }).catch(function (err) {
      if (wrap) { wrap.innerHTML = ""; wrap.appendChild(el("div", "empty-note", "Не удалось загрузить трактователей.")); }
      handleError(err);
    });
  }

  function renderReaders(res) {
    var wrap = $("#readers-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    var list = (res && res.interpreters) || [];
    if (res && res.premium_includes_one) {
      wrap.appendChild(el("div", "readers-hint",
        "В Premium входит один платный трактователь на выбор — пока подписка активна. Остальные можно купить навсегда."));
    }
    list.forEach(function (r) {
      var card = el("div", "reader-card");
      if (r.selected) card.classList.add("selected");
      if (!r.available && !r.premium_selectable) card.classList.add("locked");

      var head = el("div", "reader-head");
      head.appendChild(el("span", "reader-emoji", r.emoji || "\uD83D\uDD2E"));
      var titleWrap = el("div", "reader-title-wrap");
      titleWrap.appendChild(el("div", "reader-name", r.name || ""));
      if (r.tagline) titleWrap.appendChild(el("div", "reader-tagline", r.tagline));
      head.appendChild(titleWrap);
      var badge = "";
      if (r.free) badge = "Базовый";
      else if (r.owned) badge = "Куплен";
      else if (r.in_premium_slot) badge = "Premium";
      if (badge) head.appendChild(el("span", "reader-badge", badge));
      head.addEventListener("click", function () { card.classList.toggle("open"); });
      card.appendChild(head);

      if (r.desc) card.appendChild(el("div", "reader-desc", r.desc));

      var btn = el("button", "reader-action", readerActionLabel(r));
      if (r.selected) btn.disabled = true;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        selectReader(r.id);
      });
      card.appendChild(btn);
      wrap.appendChild(card);
    });
  }

  function selectReader(id) {
    if (!id) return;
    overlay(true, "Минутку…");
    apiFetch("/api/interpreters/select", { method: "POST", body: { id: id } })
      .then(function () {
        overlay(false);
        haptic("success");
        toast("Трактователь выбран ✨");
        loadReaders();
        loadMe();
      })
      .catch(function (err) {
        overlay(false);
        var detail = err && err.detail;
        if (err && err.status === 402 && detail && detail.product) {
          startPurchase(detail.product, function () { loadReaders(); loadMe(); });
          return;
        }
        handleError(err);
      });
  }

  // ---- Payments (Telegram Stars) ----
  // Ask the API for an invoice link, then hand it to Telegram.WebApp.openInvoice.
  // Telegram charges the user and pushes successful_payment to the BOT, which
  // fulfils the product; here we just refresh state once the popup says "paid".
  function startPurchase(product, onPaid) {
    if (!product) return;
    overlay(true, "Готовлю оплату…");
    apiFetch("/api/pay/invoice", { method: "POST", body: { product: product } })
      .then(function (res) {
        overlay(false);
        if (!res || !res.link) { toast("Не удалось создать счёт. Попробуй позже."); return; }
        if (TG && typeof TG.openInvoice === "function") {
          TG.openInvoice(res.link, function (status) {
            if (status === "paid") {
              haptic("success");
              toast("Оплата прошла ✨");
              if (onPaid) { try { onPaid(); } catch (e) {} }
              loadMe();
            } else if (status === "failed") {
              haptic("error"); toast("Оплата не удалась.");
            } else if (status === "cancelled") {
              toast("Оплата отменена.");
            }
          });
        } else {
          window.open(res.link, "_blank");
        }
      })
      .catch(function (err) { overlay(false); handleError(err); });
  }

  // Buy whatever the API said is required (à-la-carte spread / feature unlock).
  function offerPurchase(detail, onPaid) {
    if (!detail || !detail.product) return false;
    startPurchase(detail.product, onPaid);
    return true;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    } catch (e) { return ""; }
  }

  function renderPremium(me) {
    var f = me.features || {};
    var active = !!f.monetization_active;
    var isPrem = !!me.is_premium;
    var showUpsell = active && !isPrem && !me.is_admin;
    var group = $("#premium-group");
    var banner = $("#premium-banner");
    if (group) group.hidden = !active;
    if (banner) banner.hidden = !showUpsell;

    var badge = $("#premium-badge");
    if (badge) {
      badge.textContent = me.is_admin ? "ADMIN" : (isPrem ? "PREMIUM" : "FREE");
      badge.classList.toggle("is-premium", isPrem || me.is_admin);
    }
    var until = $("#premium-until");
    if (until) until.textContent = (isPrem && me.premium_until) ? ("до " + fmtDate(me.premium_until)) : "";

    var sub = $("#premium-subscribe");
    if (sub) {
      var price = (f.subscription && f.subscription.price_stars) || 0;
      var days = (f.subscription && f.subscription.period_days) || 30;
      if (isPrem || me.is_admin) {
        sub.textContent = "✓ Premium активен";
        sub.disabled = true;
        sub.onclick = null;
      } else {
        sub.textContent = "⭐ " + price + " / " + days + " дн.";
        sub.disabled = false;
        sub.onclick = function () { startPurchase("premium_sub"); };
      }
    }
  }

  function updateStars(limits) {
    if (!limits) { $("#stars").textContent = ""; return; }
    var total = 0, unlimited = false;
    Object.keys(limits).forEach(function (k) {
      if (limits[k].unlimited) unlimited = true;
      else total += Math.max(0, limits[k].remaining);
    });
    $("#stars").textContent = unlimited ? "∞ раскладов" : (total + " раскл.");
  }

  function loadDeckPill() {
    if (!state.me) return;
    apiFetch("/api/decks").then(function (res) {
      var sel = res.decks.filter(function (d) { return d.selected; })[0] || res.decks[0];
      if (sel) {
        $("#deck-pill-emoji").textContent = sel.emoji || "🎴";
        $("#deck-pill-name").textContent = sel.name;
      }
    }).catch(function () {});
  }

  // ---- Spread catalog (все расклады из /api/spreads) ----
  function loadCatalog(limits) {
    return apiFetch("/api/spreads").then(function (res) {
      state.catalog = res.spreads || [];
      state.catalogLabels = {};
      state.catalog.forEach(function (s) { state.catalogLabels[s.key] = s.label; });
      renderCatalog();
      renderLimits(limits || (state.me && state.me.limits));
    }).catch(function (err) {
      $("#spread-groups").innerHTML = "";
      $("#spread-groups").appendChild(el("div", "empty-note", "Не удалось загрузить расклады."));
      handleError(err);
    });
  }

  // Группы, свёрнутые по умолчанию (тройки/кресты/большие). «Карта дня»
  // (daily) всегда раскрыта — это главное ежедневное действие.
  var DEFAULT_OPEN_GROUP = "daily";

  // Строит сворачиваемую группу: шапка-кнопка + список карточек.
  function buildSpreadGroup(g, items, cardFactory) {
    var collapsed = g !== DEFAULT_OPEN_GROUP;
    var group = el("div", "spread-group" + (collapsed ? " collapsed" : ""));

    var head = el("button", "group-head");
    head.setAttribute("type", "button");
    var main = el("div", "group-head-main");
    main.appendChild(el("span", "group-title", GROUP_TITLES[g] || g));
    main.appendChild(el("span", "group-count", String(items.length)));
    head.appendChild(main);
    head.appendChild(el("span", "group-chevron", "\u203a"));

    var list = el("div", "spreads group-list");
    items.forEach(function (s) { list.appendChild(cardFactory(s)); });

    head.addEventListener("click", function () {
      group.classList.toggle("collapsed");
      haptic("light");
    });

    group.appendChild(head);
    group.appendChild(list);
    return group;
  }

  function renderCatalog() {
    var wrap = $("#spread-groups");
    wrap.innerHTML = "";
    var byGroup = {};
    state.catalog.forEach(function (s) {
      (byGroup[s.group] = byGroup[s.group] || []).push(s);
    });
    GROUP_ORDER.forEach(function (g) {
      var items = byGroup[g];
      if (!items || !items.length) return;
      wrap.appendChild(buildSpreadGroup(g, items, spreadCard));
    });
  }

  function spreadCard(s) {
    var btn = el("button", "spread-card");
    btn.setAttribute("data-spread", s.key);
    var ico = el("div", "spread-ico", s.emoji || "🃏");
    btn.appendChild(ico);
    var body = el("div", "spread-body");
    body.appendChild(el("div", "spread-name", shortName(s)));
    body.appendChild(el("div", "spread-desc", s.label + " · " + s.n + cardWord(s.n)));
    btn.appendChild(body);
    var chip = el("div", "sc-chip", "…");
    chip.setAttribute("data-chip", s.action);
    btn.appendChild(chip);
    btn.addEventListener("click", function () { openQuestionSheet(s.key); });
    return btn;
  }

  function shortName(s) {
    if (s.group === "daily") return "Карта дня";
    if (s.group === "triple") return "Три карты";
    if (s.key === "cross4") return "Крест · 4";
    if (s.key === "cross5") return "Крест · 5";
    if (s.group === "celtic") return "Кельтский крест";
    return s.label;
  }
  function cardWord(n) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return " карта";
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return " карты";
    return " карт";
  }

  // ---- Звание (rank) на главной ----
  function renderRank(rank) {
    if (!rank) return;
    var em = $("#rank-emoji"); if (em) em.textContent = rank.title_emoji || "✦";
    var t = $("#rank-title"); if (t) t.textContent = rank.title || "";
    var d = $("#rank-degree"); if (d) d.textContent = "Степень " + (rank.degree_roman || "");
    var f = $("#rank-bar-fill"); if (f) f.style.width = (rank.progress_pct || 0) + "%";
    var s = $("#rank-sub");
    if (s) {
      if (rank.is_max) s.textContent = rank.total_cards + " карт · вершина пути ✨";
      else s.textContent = rank.total_cards + " карт · ещё " + rank.cards_to_next + " до степени " +
        nextDegreeRoman(rank);
    }
  }
  function nextDegreeRoman(rank) {
    // Внутри звания степень растёт XIII→I; на стыке званий — снова XIII.
    if (!rank) return "";
    if (rank.degree > 1) return ROMAN[rank.degree - 1] || "";
    return "XIII";
  }
  var ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII",
    8: "VIII", 9: "IX", 10: "X", 11: "XI", 12: "XII", 13: "XIII" };

  // ---- Вопрос перед раскладом (по желанию, для любого расклада/карты дня) ----
  var pendingSpread = null;
  function openQuestionSheet(type) {
    pendingSpread = type;
    var s = null;
    for (var i = 0; i < (state.catalog || []).length; i++) {
      if (state.catalog[i].key === type) { s = state.catalog[i]; break; }
    }
    var title = $("#q-sheet-title"); if (title) title.textContent = s ? shortName(s) : "Расклад";
    var inp = $("#q-sheet-input"); if (inp) inp.value = "";
    $("#q-sheet").hidden = false;
    haptic("light");
    setTimeout(function () { try { inp && inp.focus(); } catch (e) {} }, 60);
  }
  function closeQuestionSheet() {
    $("#q-sheet").hidden = true;
    pendingSpread = null;
  }
  function confirmQuestionSheet() {
    var t = pendingSpread;
    var inp = $("#q-sheet-input");
    var q = inp ? (inp.value || "").trim() || null : null;
    closeQuestionSheet();
    if (t) drawSpread(t, q);
  }

  // ---- DRAW (шаг 1: карты рубашкой вверх) ----
  function drawSpread(type, question) {
    haptic("medium");
    overlay(true, "Тасую колоду…");
    apiFetch("/api/spread/draw", { method: "POST", body: { type: type, question: question || null } })
      .then(function (res) {
        state.current = {
          id: res.id, type: res.type, label: res.label || labelFor(res.type),
          question: res.question, cards: res.cards || [],
          revealed: {}, done: false, interpreting: false, interpretation: ""
        };
        (res.cards || []).forEach(function (c) {
          if (c.back) preloadImage(API + c.back);
          if (c.image) preloadImage(API + c.image);
        });
        renderTable(state.current);
        renderLimits(res.limits);
        updateStars(res.limits);
        overlay(false);
        showScreen("table");
        haptic("success");
      })
      .catch(function (err) {
        overlay(false);
        if (err.status === 429) {
          haptic("error");
          var dd = err.detail || {};
          if (offerLimitOptions(dd, function () { drawSpread(type, question); })) {
            // оплачено зёрнами — перерисовка внутри payWithCoins
          } else if (dd.product) {
            toast("Лимит исчерпан. Докупить расклад за ⭐ " + (dd.price_stars || "") + "?");
            offerPurchase(dd, function () { drawSpread(type, question); });
          } else {
            toast("Лимит на сегодня исчерпан. Сброс в 00:00 UTC.");
            if (state.me) loadMe();
          }
        } else if (err.status === 403) {
          toast("Этот расклад сейчас недоступен.");
        } else handleError(err);
      });
  }

  // Предзагрузка картинок: браузер декодирует их заранее, поэтому кастомная
  // рубашка/арт появляются сразу, без мелькания фона-заглушки.
  var _preloaded = {};
  function preloadImage(url) {
    if (!url || _preloaded[url]) return;
    _preloaded[url] = true;
    try { var im = new Image(); im.decoding = "async"; im.src = url; } catch (e) {}
  }

  // ---- TABLE render ----
  // layoutFor → CSS-класс раскладки. Кресты получают grid-area на широких экранах.
  function layoutFor(type, n) {
    if (type === "cross4") return "layout-cross4";
    if (type === "cross5") return "layout-cross5";
    if (n >= 6) return "layout-grid";
    if (n === 1) return "layout-single";
    if (n === 3) return "layout-three";
    return "layout-line";
  }
  var CROSS4_AREAS = ["pTop", "pBottom", "pLeft", "pRight"];
  var CROSS5_AREAS = ["pCenter", "pLeft", "pRight", "pTop", "pBottom"];

  function renderTable(cur, opts) {
    opts = opts || {};
    $("#table-title").textContent = cur.label || labelFor(cur.type);
    $("#table-question").textContent = cur.question ? "«" + cur.question + "»" : "";

    var row = $("#table-cards");
    row.className = "table-cards " + layoutFor(cur.type, cur.cards.length);
    row.innerHTML = "";

    cur.cards.forEach(function (card, i) {
      var slot = cardSlot(card, i, cur, opts);
      if (cur.type === "cross4") slot.style.gridArea = CROSS4_AREAS[i] || "";
      if (cur.type === "cross5") slot.style.gridArea = CROSS5_AREAS[i] || "";
      // Анимация раздачи: карты «вылетают» и ложатся поочерёдно (только при свежем раскладе).
      if (!opts.done) {
        slot.classList.add("dealing");
        slot.style.animationDelay = (i * 0.14).toFixed(2) + "s";
      }
      row.appendChild(slot);
    });

    // Сброс блоков трактовки/премиума
    $("#interp").textContent = "";
    $("#interp-wrap").hidden = true;
    $("#chat-hint").hidden = true;
    $("#deep-wrap").hidden = true;
    $("#deep-text").hidden = true;
    $("#deep-text").textContent = "";
    $("#spread-chat-btn").hidden = true;

    if (opts.done) {
      // История: карты уже раскрыты, трактовка готова.
      $("#table-hint").hidden = true;
      showInterpretation(cur.interpretation || "");
      showChatHint(cur);
    } else {
      $("#table-hint").hidden = false;
    }
  }

  function cardSlot(card, idx, cur, opts) {
    var revealed = opts.done || cur.revealed[idx];
    var slot = el("div", "slot");

    var tc = el("div", "tcard" + (card.reversed ? " reversed" : "") + (revealed ? " revealed" : ""));
    var inner = el("div", "tcard-inner");

    // Рубашка (back)
    var back = el("div", "face back");
    var backSrc = state.backUrl || card.back;
    if (backSrc) {
      var bimg = document.createElement("img");
      bimg.alt = "";
      bimg.onload = function () { bimg.classList.add("loaded"); };
      bimg.onerror = function () { back.classList.add("noimg"); back.textContent = "✧"; bimg.remove(); };
      bimg.src = API + backSrc;
      if (bimg.complete && bimg.naturalWidth) bimg.classList.add("loaded");
      back.appendChild(bimg);
    } else { back.classList.add("noimg"); back.textContent = "✧"; }

    // Лицо (front) — картинка уже повёрнута на сервере при rev=1
    var front = el("div", "face front");
    if (card.image) {
      var fimg = document.createElement("img");
      fimg.alt = card.name || "";
      fimg.onload = function () { fimg.classList.add("loaded"); };
      fimg.onerror = function () { front.classList.add("noimg"); front.textContent = card.emoji || "🃏"; fimg.remove(); };
      fimg.src = API + card.image;
      if (fimg.complete && fimg.naturalWidth) fimg.classList.add("loaded");
      front.appendChild(fimg);
    } else { front.classList.add("noimg"); front.textContent = card.emoji || "🃏"; }
    if (card.reversed) front.appendChild(el("span", "rev-badge", "⇅ перевёрнутая"));

    inner.appendChild(back);
    inner.appendChild(front);
    tc.appendChild(inner);
    slot.appendChild(tc);

    // Подпись позиции — видна сразу, даже пока карта закрыта
    if (card.position) slot.appendChild(el("div", "slot-pos", card.position));
    // Имя карты показываем только после раскрытия
    var nameEl = el("div", "slot-name", revealed ? (card.name || "") : "");
    slot.appendChild(nameEl);

    tc.addEventListener("click", function () {
      var cur2 = state.current;
      if (!cur2) return;
      if (!cur2.revealed[idx] && !cur2.done) {
        // Переворот
        cur2.revealed[idx] = true;
        tc.classList.add("revealed");
        nameEl.textContent = card.name || "";
        haptic("light");
        maybeInterpret();
      } else if (cur2.done && cur2.cards.length === 1) {
        // После трактовки — диалог с картой (только у расклада из одной карты)
        haptic("light");
        openChat(cur2.id, card);
      }
    });

    return slot;
  }

  function revealedCount(cur) {
    var n = 0;
    for (var k in cur.revealed) if (cur.revealed[k]) n++;
    return n;
  }

  // ---- INTERPRET (шаг 2: только после раскрытия ВСЕХ карт) ----
  function maybeInterpret() {
    var cur = state.current;
    if (!cur || cur.done || cur.interpreting) return;
    if (revealedCount(cur) < cur.cards.length) return;
    cur.interpreting = true;
    $("#table-hint").hidden = true;
    var wrap = $("#interp-wrap");
    wrap.hidden = false;
    $("#interp").innerHTML = "";
    startRitual(cur, wrap);
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

    interpAsk(cur);
  }

  // Долгий расклад считается фоном: сервер отвечает pending, мы опрашиваем статус.
  // Обрыв связи не теряет готовый текст.
  var INTERP_POLL_TRIES = 120;   // ~5 min
  var INTERP_POLL_MS = 2500;

  function interpOk(cur, text) {
    cur.interpretation = text || "";
    cur.done = true;
    cur.interpreting = false;
    finishRitual(function () {
      showInterpretation(cur.interpretation, { animate: true });
      showChatHint(cur);
    });
    haptic("success");
  }

  function interpErr(cur, msg, err) {
    cur.interpreting = false;
    stopRitual();
    $("#interp").textContent = msg || "Не удалось получить трактовку. Попробуй ещё раз.";
    var retry = el("button", "btn-mini", "Повторить");
    retry.onclick = function () { cur.done = false; maybeInterpret(); };
    $("#interp").appendChild(document.createElement("br"));
    $("#interp").appendChild(retry);
    if (err) handleError(err);
  }

  function interpAsk(cur) {
    apiFetch("/api/spread/interpret", { method: "POST", body: { spread_id: cur.id } })
      .then(function (res) {
        if (res && res.status === "pending") {
          interpPoll(cur, 0, res.poll_after_ms || INTERP_POLL_MS);
          return;
        }
        interpOk(cur, (res && res.interpretation) || "");
      })
      .catch(function (err) { interpErr(cur, null, err); });
  }

  function interpPoll(cur, tries, delay) {
    if (!cur.interpreting) return;
    if (tries > INTERP_POLL_TRIES) { interpErr(cur, "Разбор ещё считается — загляни в историю через пару минут."); return; }
    setTimeout(function () {
      if (!cur.interpreting) return;
      apiFetch("/api/spread/interpret/status", { method: "POST", body: { spread_id: cur.id } })
        .then(function (res) {
          if (res.status === "done") { interpOk(cur, res.interpretation || ""); return; }
          if (res.status === "pending") {
            interpPoll(cur, tries + 1, res.poll_after_ms || INTERP_POLL_MS);
            return;
          }
          interpErr(cur, res.message || null);
        })
        .catch(function (err) {
          // Сеть моргнула — пробуем дальше.
          if (tries > INTERP_POLL_TRIES - 4) { interpErr(cur, null, err); return; }
          interpPoll(cur, tries + 3, INTERP_POLL_MS);
        });
    }, delay || INTERP_POLL_MS);
  }

  // Статусы ожидания: третья формулировка честно говорит, что дольше обычного.
  var RITUAL_STATUS = [
    "Тасую колоду…",
    "Смотрю, как карты легли…",
    "Складываю ответ — в этот раз дольше обычного…"
  ];
  var ritualTimers = [];

  function clearRitualStatus() {
    ritualTimers.forEach(function (t) { clearTimeout(t); });
    ritualTimers = [];
  }

  // Сцена живёт только внутри #interp-wrap — стол с картами не трогаем.
  function startRitual(cur, wrap) {
    clearRitualStatus();
    var multi = !!(cur.cards && cur.cards.length > 1);
    wrap.classList.add("ritual-host");
    if (multi) wrap.classList.add("ritual-host-wide");
    var status = el("div", "interp-status", (trList("ui.ritual_status") || RITUAL_STATUS)[0]);
    $("#interp").appendChild(status);
    ritualTimers.push(setTimeout(function () { status.textContent = (trList("ui.ritual_status") || RITUAL_STATUS)[1]; }, 7000));
    ritualTimers.push(setTimeout(function () { status.textContent = (trList("ui.ritual_status") || RITUAL_STATUS)[2]; }, 18000));
    if (!window.Ritual) return;
    var back = state.backUrl || (cur.cards && cur.cards[0] && cur.cards[0].back) || "";
    try {
      Ritual.start(wrap, { type: cur.type, backUrl: back ? (API + back) : "" });
    } catch (e) {}
  }

  function unhostRitual() {
    var wrap = $("#interp-wrap");
    wrap.classList.remove("ritual-host");
    wrap.classList.remove("ritual-host-wide");
  }

  function stopRitual() {
    clearRitualStatus();
    if (window.Ritual) { try { Ritual.stop(); } catch (e) {} }
    unhostRitual();
  }

  // Ответ готов: доигрываем сброс колоды и только потом пускаем текст.
  function finishRitual(done) {
    clearRitualStatus();
    if (!window.Ritual || !Ritual.active()) { unhostRitual(); done(); return; }
    Ritual.finish(function () {
      done();
      setTimeout(unhostRitual, 1200);
    });
  }

  function showInterpretation(text, opts) {
    opts = opts || {};
    var host = $("#interp");
    $("#interp-wrap").hidden = false;
    if (opts.animate && window.Ritual) {
      Ritual.typeInto(host, text || "");
      return;
    }
    host.textContent = text || "";
  }

  // После трактовки: у тройки/крестов — расширенная трактовка и диалог обо
  // всём раскладе; у карты дня — разговор с самой картой (она и есть расклад).
  function showChatHint(cur) {
    if (cur.cards && cur.cards.length > 1) {
      $("#spread-chat-btn").hidden = false;
      showDeepBtn(cur);
    } else {
      $("#chat-hint").hidden = false;
    }
  }

  // ---- Deep-dive (расширенная трактовка, старшая модель) ----
  function showDeepBtn(cur) {
    $("#deep-wrap").hidden = false;
    var price = $("#deep-price");
    var f = state.features;
    if (f && f.monetization_active && !(f.deep_dive && f.deep_dive.included)) {
      price.hidden = false;
      price.textContent = "⭐ " + ((f.deep_dive && f.deep_dive.price_stars) || "");
    } else {
      price.hidden = true;
    }
  }

  function loadDeep() {
    var cur = state.current;
    if (!cur) return;
    var btn = $("#deep-btn");
    var lbl = btn.querySelector(".bp-label");
    var old = lbl.textContent;
    btn.disabled = true;
    lbl.textContent = "Читаю глубже…";
    apiFetch("/api/deep", { method: "POST", body: { spread_id: cur.id } })
      .then(function (res) {
        btn.disabled = false;
        lbl.textContent = old;
        $("#deep-wrap").hidden = true;
        var t = $("#deep-text");
        t.hidden = false;
        t.textContent = res.content || "";
        t.scrollIntoView({ behavior: "smooth", block: "nearest" });
        haptic("success");
      })
      .catch(function (err) {
        btn.disabled = false;
        lbl.textContent = old;
        if (err.status === 402) {
          var d = err.detail || {};
          toast("Расширенная трактовка за ⭐ " + (d.price_stars || "") + ".");
          offerPurchase(d, loadDeep);
        } else handleError(err);
      });
  }

  // ---- Card dialogue ----
  function openSpreadChat() {
    var cur = state.current;
    if (!cur) return;
    openChat(cur.id, null);
  }

  function openChat(spreadId, card) {
    var whole = !card; // диалог обо всём раскладе
    var cid = whole ? "spread" : card.id;
    state.chat = { spreadId: spreadId, card: card };
    $("#chat-card-emoji").textContent = whole ? "🔮" : (card.emoji || "🃏");
    $("#chat-card-name").textContent = whole ? "Весь расклад" : (card.name || "Карта");
    var orient = whole
      ? (state.current ? (state.current.label || "Расклад") : "Расклад")
      : (card.reversed ? "перевёрнутая" : "прямая") + (card.position ? " · " + card.position : "");
    $("#chat-card-orient").textContent = orient;
    $("#chat-input").placeholder = whole ? "Спроси о раскладе…" : "Спроси карту…";
    $("#chat-log").innerHTML = "";
    $("#chat-turns").textContent = "";
    $("#chat-input").value = "";
    $("#chat-input").disabled = false;
    $("#chat-send").disabled = false;
    showScreen("chat");
    apiFetch("/api/chat?spread_id=" + spreadId + "&card_id=" + encodeURIComponent(cid))
      .then(function (res) {
        (res.messages || []).forEach(function (m) { addBubble(m.role, m.content); });
        if (!(res.messages || []).length) {
          addBubble("card", whole
            ? "Я внимательно изучил твой расклад. Спроси о связях карт, скрытых мотивах или о том, что делать дальше."
            : "Я — " + (card.name || "карта") + ". Спроси меня о том, что тебя волнует.");
        }
        updateTurns(res.turns, res.max_turns);
      })
      .catch(function (err) { handleError(err); });
  }

  function addBubble(role, text) {
    var log = $("#chat-log");
    var b = el("div", "bubble " + (role === "user" ? "user" : "card"), text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function updateTurns(turns, max) {
    if (state.me && state.me.is_admin) { $("#chat-turns").textContent = "админ · без лимита"; return; }
    if (turns == null || max == null) { $("#chat-turns").textContent = ""; return; }
    $("#chat-turns").textContent = "Сообщений: " + turns + " / " + max;
    $("#chat-input").disabled = turns >= max;
    $("#chat-send").disabled = turns >= max;
  }

  function sendChat(ev) {
    ev.preventDefault();
    var input = $("#chat-input");
    var msg = (input.value || "").trim();
    if (!msg || !state.chat) return;
    var cid = state.chat.card ? state.chat.card.id : "spread";
    input.value = "";
    addBubble("user", msg);
    var typing = addBubble("card", "");
    typing.classList.add("typing");
    typing.innerHTML = '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>';
    $("#chat-send").disabled = true;
    apiFetch("/api/chat", { method: "POST", body: {
      spread_id: state.chat.spreadId, card_id: cid, message: msg
    }}).then(function (res) {
      typing.remove();
      addBubble("card", res.reply || "…");
      updateTurns(res.turns, res.max_turns);
      $("#chat-send").disabled = false;
      haptic("light");
    }).catch(function (err) {
      typing.remove();
      $("#chat-send").disabled = false;
      if (err.status === 429) { toast("Достигнут лимит диалога по этому раскладу."); updateTurns(9999, 9999); }
      else if (err.status === 402) {
        var d = err.detail || {};
        toast("Диалог по раскладу за ⭐ " + (d.price_stars || "") + ".");
        offerPurchase(d);
      }
      else handleError(err);
    });
  }

  // ---- Decks ----
  function loadDecks() {
    var list = $("#deck-list");
    list.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/decks").then(function (res) {
      list.innerHTML = "";
      res.decks.forEach(function (d) {
        var soon = !!d.coming_soon;
        var item = el("div", "deck-item" + (d.selected ? " selected" : "") + (soon ? " soon" : ""));
        var sw = el("div", "deck-swatch");
        var pal = d.palette || {};
        sw.style.background = pal.bg || "#222";
        sw.style.borderColor = pal.border || pal.text || "#d9c08a";
        item.appendChild(sw);
        var info = el("div", "deck-info");
        info.appendChild(el("div", "deck-title", (d.emoji ? d.emoji + " " : "") + d.name));
        info.appendChild(el("div", "deck-desc", d.description || ""));
        item.appendChild(info);
        var action = el("div", "deck-action");
        if (soon) {
          // Колода анонсирована, но ещё не вышла — выбрать нельзя.
          action.appendChild(el("span", "deck-badge soon-badge", "Скоро"));
          item.addEventListener("click", function () {
            haptic("warning");
            toast("Карты говорят скоро…");
          });
        } else if (d.selected) {
          action.appendChild(el("span", "deck-badge", "✓ Выбрана"));
        } else if (d.owned) {
          var use = el("button", "btn-mini", "Выбрать");
          use.onclick = function () { selectDeck(d.id); };
          action.appendChild(use);
        } else {
          var buy = el("button", "btn-mini ghost", "⭐ " + d.price_stars);
          buy.onclick = (function (deck) {
            return function () { startPurchase("deck:" + deck.id, function () { loadDecks(); loadDeckPill(); }); };
          })(d);
          action.appendChild(buy);
        }
        item.appendChild(action);
        list.appendChild(item);
      });
      renderBacks(res.backs);
    }).catch(handleError);
  }

  // Рубашки (card backs) — выбор внутри экрана колод.
  function renderBacks(backs) {
    var block = $("#backs-block");
    var list = $("#back-list");
    if (!block || !list) return;
    if (!backs || !backs.options || !backs.options.length) { block.hidden = true; return; }
    block.hidden = false;
    list.innerHTML = "";
    backs.options.forEach(function (b) {
      var item = el("div", "back-item" + (b.id === backs.selected ? " selected" : "") + (b.unlocked ? "" : " locked"));
      var thumb = el("div", "back-thumb");
      var img = document.createElement("img");
      img.src = API + b.url;
      img.alt = "";
      img.onerror = function () { thumb.classList.add("noimg"); thumb.textContent = b.emoji || "\u2726"; img.remove(); };
      thumb.appendChild(img);
      if (!b.unlocked) thumb.appendChild(el("span", "back-lock", "\uD83D\uDD12"));
      item.appendChild(thumb);
      item.appendChild(el("div", "back-name", (b.emoji ? b.emoji + " " : "") + b.name));
      var status;
      if (b.id === backs.selected) status = el("div", "back-status ok", "\u2713 \u0412\u044b\u0431\u0440\u0430\u043d\u0430");
      else if (b.unlocked) status = el("div", "back-status", "\u041d\u0430\u0436\u043c\u0438, \u0447\u0442\u043e\u0431\u044b \u0432\u044b\u0431\u0440\u0430\u0442\u044c");
      else status = el("div", "back-status", "\u0415\u0449\u0451 " + b.days_left + " " + dayWord(b.days_left) + " \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u0438\u043a\u0430");
      item.appendChild(status);
      if (b.unlocked && b.id !== backs.selected) {
        item.onclick = (function (bid) { return function () { selectBack(bid); }; })(b.id);
      } else if (!b.unlocked) {
        item.onclick = function () { haptic("warning"); toast("\u0420\u0443\u0431\u0430\u0448\u043a\u0430 \u043e\u0442\u043a\u0440\u043e\u0435\u0442\u0441\u044f \u043d\u0430 20-\u0439 \u0434\u0435\u043d\u044c \u043a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u0438\u043a\u0430."); };
      }
      list.appendChild(item);
    });
  }

  function dayWord(n) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return "\u0434\u0435\u043d\u044c";
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "\u0434\u043d\u044f";
    return "\u0434\u043d\u0435\u0439";
  }

  function selectBack(id) {
    haptic("light");
    apiFetch("/api/settings", { method: "POST", body: { card_back: id } })
      .then(function () {
        loadDecks();
        loadMe();
        toast("\u0420\u0443\u0431\u0430\u0448\u043a\u0430 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0430.");
      })
      .catch(function (err) {
        if (err.status === 402) toast("\u042d\u0442\u0430 \u0440\u0443\u0431\u0430\u0448\u043a\u0430 \u043f\u043e\u043a\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0430.");
        else handleError(err);
      });
  }

  function selectDeck(id) {
    haptic("light");
    apiFetch("/api/settings", { method: "POST", body: { deck: id } })
      .then(function () { loadDecks(); loadDeckPill(); toast("Колода выбрана."); })
      .catch(function (err) {
        if (err.status === 402) toast("Эта колода пока закрыта.");
        else handleError(err);
      });
  }

  // ---- History ----
  function loadHistory() {
    var list = $("#hist-list");
    list.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/history").then(function (res) {
      list.innerHTML = "";
      if (!res.history.length) { list.innerHTML = "<div class='empty-note'>Пока нет раскладов.<br>Сделай первый на главной.</div>"; return; }
      res.history.forEach(function (h) {
        var item = el("div", "hist-item");
        var top = el("div", "hist-top");
        top.appendChild(el("div", "hist-type", labelFor(h.type)));
        top.appendChild(el("div", "hist-date", fmtDate(h.created_at)));
        if (h.verdict) top.appendChild(el("span", "verdict-dot v-" + h.verdict, ""));
        item.appendChild(top);
        var names = (h.cards || []).map(function (c) { return (c.emoji || "") + c.name + (c.reversed ? " ⇅" : ""); }).join(" · ");
        item.appendChild(el("div", "hist-cards", names));
        item.onclick = function () { openHistItem(h.id); };
        list.appendChild(item);
      });
    }).catch(handleError);
  }

  function openHistItem(id) {
    overlay(true, "Открываю расклад…");
    apiFetch("/api/history/" + id).then(function (row) {
      overlay(false);
      state.current = {
        id: row.id, type: row.type, label: labelFor(row.type),
        question: row.question, cards: row.cards || [],
        revealed: {}, done: true, interpreting: false,
        interpretation: row.interpretation || ""
      };
      renderTable(state.current, { done: true });
      showScreen("table");
    }).catch(function (err) { overlay(false); handleError(err); });
  }

  // ---- Collection (коллекция карт) ----
  function loadCollection() {
    var grid = $("#coll-grid");
    if (!grid) return;
    grid.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/collection").then(function (res) {
      grid.innerHTML = "";
      var cnt = $("#coll-count");
      if (cnt) cnt.textContent = (res.collected || 0) + " / " + (res.total || 0);
      var hasBackArt = !!res.has_back_art;
      (res.cards || []).forEach(function (c) {
        var cell = el("div", "coll-cell" + (c.seen ? " seen" : " locked"));
        var img = el("div", "coll-img");
        if (c.seen) {
          var im = document.createElement("img");
          im.src = API + c.image;
          im.alt = c.name || "";
          im.loading = "lazy";
          im.onerror = function () { img.classList.add("noimg"); img.textContent = c.emoji || "🃏"; im.remove(); };
          img.appendChild(im);
        } else if (hasBackArt && c.back) {
          // Есть реальная рубашка (webp/png) — показываем её вместо «?».
          var bk = document.createElement("img");
          bk.src = API + c.back;
          bk.alt = "";
          bk.loading = "lazy";
          bk.onerror = function () { img.classList.add("noimg"); img.textContent = "?"; bk.remove(); };
          img.appendChild(bk);
        } else {
          // Пока рубашки нет — силуэт «?».
          img.classList.add("noimg");
          img.textContent = "?";
        }
        cell.appendChild(img);
        cell.appendChild(el("div", "coll-name", c.seen ? (c.name || "") : "—"));
        if (c.seen && c.count > 1) cell.appendChild(el("div", "coll-badge", "×" + c.count));
        if (c.seen) {
          cell.addEventListener("click", function () { openCardView(c); });
        }
        grid.appendChild(cell);
      });
    }).catch(handleError);
  }

  // ---- Card view (увеличенный просмотр найденной карты) ----
  function openCardView(c) {
    var m = $("#cardview");
    if (!m) return;
    haptic("light");
    var im = $("#cardview-img");
    im.src = API + c.image;
    im.alt = c.name || "";
    $("#cardview-name").textContent = c.name || "";
    var meta = [];
    if (c.suit_label) meta.push(c.suit_label);
    if (c.number) meta.push("№ " + c.number);
    if (c.count > 1) meta.push("выпадала ×" + c.count);
    $("#cardview-meta").textContent = meta.join(" · ");
    m.hidden = false;
  }

  function closeCardView() { var m = $("#cardview"); if (m) m.hidden = true; }

  // ---- Week ----
  function loadWeekBanner() {
    apiFetch("/api/week").then(function (w) {
      var banner = $("#week-banner");
      banner.hidden = false;
      var goal = w.goal_days || 7;
      $("#week-desc").textContent = w.claimed
        ? "Итог недели готов"
        : "Дней с картой: " + w.distinct_days + "/" + goal + (w.can_claim ? " · итог готов ✨" : "");
      var pct = Math.min(100, Math.round((w.distinct_days / goal) * 100));
      $("#week-bar").style.width = (w.claimed ? 100 : pct) + "%";
    }).catch(function () {});
  }

  function loadWeek() {
    var body = $("#week-body");
    body.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/week").then(function (w) {
      body.innerHTML = "";
      var info = el("div", "week-summary");
      if (w.claimed) {
        info.textContent = w.summary || "Итог недели уже получен.";
        body.appendChild(info);
        body.appendChild(el("div", "week-locked-note", "Итог выдаётся один раз в неделю и не перетрактовывается."));
        return;
      }
      var goal2 = w.goal_days || 7;
      info.textContent = "Карта дня отмечена в " + w.distinct_days + " из " + goal2 + " дней этой недели (для итога хватит " + w.min_days + ").";
      body.appendChild(info);
      var btn = el("button", "btn-premium");
      btn.innerHTML = '<span class="bp-ico">🌙</span><span class="bp-label">Получить итог недели</span>';
      btn.disabled = !w.can_claim;
      btn.onclick = function () { claimWeek(); };
      body.appendChild(btn);
      if (!w.can_claim) body.appendChild(el("div", "week-locked-note", "Итог откроется, когда наберётся " + w.min_days + " дней с картой дня (больше — точнее). Выдаётся один раз."));
    }).catch(handleError);
  }

  function claimWeek() {
    overlay(true, "Собираю итог недели…");
    apiFetch("/api/week/claim", { method: "POST" }).then(function (res) {
      overlay(false); haptic("success"); loadWeek(); loadWeekBanner();
    }).catch(function (err) {
      overlay(false);
      if (err.status === 409) { toast("Итог уже получен на этой неделе."); loadWeek(); }
      else if (err.status === 400) toast("Пока мало дней с картой дня.");
      else handleError(err);
    });
  }

  // ---- Часовой пояс ----
  // Сервер сам по себе не знает часовой пояс: Telegram его не передаёт.
  // Пока его не было, все времена считались как UTC — отсюда и вопрос в 3 ночи.
  function syncTimezone(me) {
    var tz = -(new Date().getTimezoneOffset());
    if (!me || me.tz_offset === tz) return;
    apiFetch("/api/settings", { method: "POST", body: { tz_offset: tz } })
      .then(function (res) { if (state.me) Object.assign(state.me, res); })
      .catch(function () { /* не критично: попробуем при следующем запуске */ });
  }

  function tzLabel() {
    var m = -(new Date().getTimezoneOffset());
    var sign = m < 0 ? "−" : "+";
    var a = Math.abs(m);
    return "UTC" + sign + pad2(Math.floor(a / 60)) + ":" + pad2(a % 60);
  }

  // ---- Крутилки времени (как будильник на Android) ----
  // Нативный <input type="time"> в Telegram WebView выглядит по-разному на iOS
  // и Android и часто открывает системную клавиатуру. Здесь — две колонки
  // со scroll-snap: никакого JS-инерции, всё катится средствами браузера.
  var TPICK_ITEM_H = 36;   // должно совпадать с --tpick-item в styles.css
  var TPICK_MIN_STEP = 5;

  function pad2(n) { return ("0" + n).slice(-2); }

  function tpickCol(root, values) {
    var col = el("div", "tpick-col");
    values.forEach(function (v) {
      var it = el("div", "tpick-item", pad2(v));
      it.setAttribute("data-v", String(v));
      col.appendChild(it);
    });
    var last = -1;
    var t = null;
    col.addEventListener("scroll", function () {
      var idx = Math.round(col.scrollTop / TPICK_ITEM_H);
      if (idx !== last) { last = idx; haptic("light"); }
      if (t) clearTimeout(t);
      // После остановки подсвечиваем выбранный элемент.
      t = setTimeout(function () { tpickMark(col); }, 90);
    });
    return col;
  }

  function tpickMark(col) {
    var idx = Math.round(col.scrollTop / TPICK_ITEM_H);
    for (var i = 0; i < col.children.length; i++) {
      col.children[i].classList.toggle("sel", i === idx);
    }
  }

  function tpickInit(root, value) {
    if (!root) return;
    root.innerHTML = "";
    var hours = [], mins = [], i;
    for (i = 0; i < 24; i++) hours.push(i);
    for (i = 0; i < 60; i += TPICK_MIN_STEP) mins.push(i);
    var hc = tpickCol(root, hours);
    var mc = tpickCol(root, mins);
    root.appendChild(hc);
    root.appendChild(el("div", "tpick-sep", ":"));
    root.appendChild(mc);
    root.appendChild(el("div", "tpick-hl"));
    root._cols = [hc, mc];
    tpickSet(root, value);
  }

  function tpickSet(root, value) {
    if (!root || !root._cols) return;
    var parts = String(value || "").split(":");
    var h = parseInt(parts[0], 10); if (isNaN(h)) h = 9;
    var m = parseInt(parts[1], 10); if (isNaN(m)) m = 0;
    // Минуты крутятся шагом 5 — дефолтные 20:07 надо прижать к ближайшему.
    var mIdx = Math.min(Math.round(m / TPICK_MIN_STEP), Math.floor(59 / TPICK_MIN_STEP));
    var apply = function () {
      root._cols[0].scrollTop = Math.min(Math.max(h, 0), 23) * TPICK_ITEM_H;
      root._cols[1].scrollTop = mIdx * TPICK_ITEM_H;
      tpickMark(root._cols[0]);
      tpickMark(root._cols[1]);
    };
    apply();
    // Если экран ещё скрыт (hidden), scrollTop не применится — повторяем после отрисовки.
    setTimeout(apply, 0);
  }

  function tpickValue(root) {
    if (!root || !root._cols) return null;
    var h = Math.round(root._cols[0].scrollTop / TPICK_ITEM_H);
    var mIdx = Math.round(root._cols[1].scrollTop / TPICK_ITEM_H);
    return pad2(Math.min(Math.max(h, 0), 23)) + ":" + pad2(mIdx * TPICK_MIN_STEP);
  }

  // ========================================================
  //  LANGUAGE
  //  Сервер — единственный источник правды о языке (он же говорит на нём
  //  с LLM и в боте). Здесь только применение к разметке без перезагрузки
  //  страницы: перезагрузка в Telegram WebView стоит белого экрана.
  // ========================================================
  var LANG_FALLBACK = "ru";
  var LANG_META = {
    ru: { name: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", flag: "\uD83C\uDDF7\uD83C\uDDFA" },
    en: { name: "English", flag: "\uD83C\uDDEC\uD83C\uDDE7" },
    uk: { name: "\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430", flag: "\uD83C\uDDFA\uD83C\uDDE6" }
  };

  // Ключ → переводы. Ключи ставятся в разметке через data-i18n.
  // Русские значения дублируют текст в HTML — это намеренно:
  // без JS интерфейс остаётся читаемым, а не пустым.
  var UI_STRINGS = {
    "ui.language":      { ru: "\u042f\u0437\u044b\u043a", en: "Language", uk: "\u041c\u043e\u0432\u0430" },
    "ui.language_hint": {
      ru: "\u041d\u0430 \u044d\u0442\u043e\u043c \u044f\u0437\u044b\u043a\u0435 \u0431\u0443\u0434\u0443\u0442 \u0438 \u043a\u043d\u043e\u043f\u043a\u0438, \u0438 \u0442\u0440\u0430\u043a\u0442\u043e\u0432\u043a\u0438.",
      en: "Both the buttons and the readings will use it.",
      uk: "\u0426\u0456\u0454\u044e \u043c\u043e\u0432\u043e\u044e \u0431\u0443\u0434\u0443\u0442\u044c \u0456 \u043a\u043d\u043e\u043f\u043a\u0438, \u0456 \u0442\u043b\u0443\u043c\u0430\u0447\u0435\u043d\u043d\u044f."
    },
    "ui.back":         { ru: "\u2039 \u041d\u0430\u0437\u0430\u0434", en: "\u2039 Back", uk: "\u2039 \u041d\u0430\u0437\u0430\u0434" },
    "ui.manual_other": {
      ru: "\u2039 \u0414\u0440\u0443\u0433\u043e\u0439 \u0440\u0430\u0441\u043a\u043b\u0430\u0434",
      en: "\u2039 Another spread",
      uk: "\u2039 \u0406\u043d\u0448\u0438\u0439 \u0440\u043e\u0437\u043a\u043b\u0430\u0434"
    },
    "ui.chat_back": {
      ru: "\u2039 \u041a \u0440\u0430\u0441\u043a\u043b\u0430\u0434\u0443",
      en: "\u2039 Back to spread",
      uk: "\u2039 \u0414\u043e \u0440\u043e\u0437\u043a\u043b\u0430\u0434\u0443"
    },
    "ui.title_spread":       { ru: "\u0420\u0430\u0441\u043a\u043b\u0430\u0434", en: "Spread", uk: "\u0420\u043e\u0437\u043a\u043b\u0430\u0434" },
    "ui.title_manual":       { ru: "\uD83C\uDFB4 \u0420\u0443\u0447\u043d\u043e\u0439 \u0432\u0432\u043e\u0434", en: "\uD83C\uDFB4 Manual entry", uk: "\uD83C\uDFB4 \u0420\u0443\u0447\u043d\u0435 \u0432\u0432\u0435\u0434\u0435\u043d\u043d\u044f" },
    "ui.title_calendar":     { ru: "\uD83D\uDCC5 \u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c \u0434\u043d\u044f", en: "\uD83D\uDCC5 Day calendar", uk: "\uD83D\uDCC5 \u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440 \u0434\u043d\u044f" },
    "ui.title_decks":        { ru: "\u041a\u043e\u043b\u043e\u0434\u044b", en: "Decks", uk: "\u041a\u043e\u043b\u043e\u0434\u0438" },
    "ui.title_history":      { ru: "\u0418\u0441\u0442\u043e\u0440\u0438\u044f", en: "History", uk: "\u0406\u0441\u0442\u043e\u0440\u0456\u044f" },
    "ui.title_week":         { ru: "\uD83C\uDF19 \u041c\u043e\u044f \u043d\u0435\u0434\u0435\u043b\u044f", en: "\uD83C\uDF19 My week", uk: "\uD83C\uDF19 \u041c\u0456\u0439 \u0442\u0438\u0436\u0434\u0435\u043d\u044c" },
    "ui.title_collection":   { ru: "\uD83C\uDCCF \u041a\u043e\u043b\u043b\u0435\u043a\u0446\u0438\u044f", en: "\uD83C\uDCCF Collection", uk: "\uD83C\uDCCF \u041a\u043e\u043b\u0435\u043a\u0446\u0456\u044f" },
    "ui.title_interpreters": { ru: "\uD83D\uDD2E \u0422\u0440\u0430\u043a\u0442\u043e\u0432\u0430\u0442\u0435\u043b\u0438", en: "\uD83D\uDD2E Interpreters", uk: "\uD83D\uDD2E \u0422\u043b\u0443\u043c\u0430\u0447\u0456" },
    "ui.title_quests":       { ru: "\uD83C\uDF3E \u0422\u0440\u043e\u043f\u0430 \u0413\u0443\u0441\u044f", en: "\uD83C\uDF3E Goose Trail", uk: "\uD83C\uDF3E \u0421\u0442\u0435\u0436\u043a\u0430 \u0413\u0443\u0441\u044f" },
    "ui.title_stats":        { ru: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430", en: "\uD83D\uDCCA Stats", uk: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430" },
    "ui.title_settings":     { ru: "\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438", en: "Settings", uk: "\u041d\u0430\u043b\u0430\u0448\u0442\u0443\u0432\u0430\u043d\u043d\u044f" },
    "ui.interp_head":        { ru: "\u0422\u0440\u0430\u043a\u0442\u043e\u0432\u043a\u0430", en: "Reading", uk: "\u0422\u043b\u0443\u043c\u0430\u0447\u0435\u043d\u043d\u044f" },
    "ui.ritual_status": {
      ru: [
        "\u0422\u0430\u0441\u0443\u044e \u043a\u043e\u043b\u043e\u0434\u0443\u2026",
        "\u0421\u043c\u043e\u0442\u0440\u044e, \u043a\u0430\u043a \u043a\u0430\u0440\u0442\u044b \u043b\u0435\u0433\u043b\u0438\u2026",
        "\u0421\u043a\u043b\u0430\u0434\u044b\u0432\u0430\u044e \u043e\u0442\u0432\u0435\u0442 \u2014 \u0432 \u044d\u0442\u043e\u0442 \u0440\u0430\u0437 \u0434\u043e\u043b\u044c\u0448\u0435 \u043e\u0431\u044b\u0447\u043d\u043e\u0433\u043e\u2026"
      ],
      en: [
        "Shuffling the deck\u2026",
        "Watching how the cards fell\u2026",
        "Putting the reading together \u2014 this one takes a little longer\u2026"
      ],
      uk: [
        "\u0422\u0430\u0441\u0443\u044e \u043a\u043e\u043b\u043e\u0434\u0443\u2026",
        "\u0414\u0438\u0432\u043b\u044e\u0441\u044f, \u044f\u043a \u043b\u044f\u0433\u043b\u0438 \u043a\u0430\u0440\u0442\u0438\u2026",
        "\u0417\u0431\u0438\u0440\u0430\u044e \u0432\u0456\u0434\u043f\u043e\u0432\u0456\u0434\u044c \u2014 \u0446\u044c\u043e\u0433\u043e \u0440\u0430\u0437\u0443 \u0434\u043e\u0432\u0448\u0435 \u0437\u0432\u0438\u0447\u0430\u0439\u043d\u043e\u0433\u043e\u2026"
      ]
    },
    "ui.theme":              { ru: "\u0422\u0435\u043c\u0430 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u044f", en: "Theme", uk: "\u0422\u0435\u043c\u0430 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u043d\u044f" },
    "ui.daily_reminder": {
      ru: "\u041a\u0430\u0440\u0442\u0430 \u0434\u043d\u044f \u2014 \u043d\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u043d\u0438\u0435",
      en: "Card of the day \u2014 reminder",
      uk: "\u041a\u0430\u0440\u0442\u0430 \u0434\u043d\u044f \u2014 \u043d\u0430\u0433\u0430\u0434\u0443\u0432\u0430\u043d\u043d\u044f"
    },
    "ui.evening_q": {
      ru: "\u0412\u0435\u0447\u0435\u0440\u043d\u0438\u0439 \u0432\u043e\u043f\u0440\u043e\u0441 \u2014 \u00ab\u043a\u0430\u043a \u043f\u0440\u043e\u0448\u0451\u043b \u0434\u0435\u043d\u044c?\u00bb",
      en: "Evening check-in \u2014 \u201chow was your day?\u201d",
      uk: "\u0412\u0435\u0447\u0456\u0440\u043d\u0454 \u0437\u0430\u043f\u0438\u0442\u0430\u043d\u043d\u044f \u2014 \u00ab\u044f\u043a \u043c\u0438\u043d\u0443\u0432 \u0434\u0435\u043d\u044c?\u00bb"
    },
    "ui.weekly":       { ru: "\u0418\u0442\u043e\u0433 \u043d\u0435\u0434\u0435\u043b\u0438", en: "Weekly summary", uk: "\u041f\u0456\u0434\u0441\u0443\u043c\u043e\u043a \u0442\u0438\u0436\u043d\u044f" },
    "ui.subscription": { ru: "\u041f\u043e\u0434\u043f\u0438\u0441\u043a\u0430", en: "Subscription", uk: "\u041f\u0456\u0434\u043f\u0438\u0441\u043a\u0430" },
    "ui.save":         { ru: "\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c", en: "Save", uk: "\u0417\u0431\u0435\u0440\u0435\u0433\u0442\u0438" },
    "ui.off":          { ru: "\u0412\u044b\u043a\u043b", en: "Off", uk: "\u0412\u0438\u043c\u043a" },
    "ui.tab_home":     { ru: "\u0413\u043b\u0430\u0432\u043d\u0430\u044f", en: "Home", uk: "\u0413\u043e\u043b\u043e\u0432\u043d\u0430" },
    "ui.tab_manual":   { ru: "\u0420\u0443\u0447\u043d\u043e\u0439", en: "Manual", uk: "\u0420\u0443\u0447\u043d\u0438\u0439" },
    "ui.tab_calendar": { ru: "\u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440\u044c", en: "Calendar", uk: "\u041a\u0430\u043b\u0435\u043d\u0434\u0430\u0440" },
    "ui.tab_history":  { ru: "\u0418\u0441\u0442\u043e\u0440\u0438\u044f", en: "History", uk: "\u0406\u0441\u0442\u043e\u0440\u0456\u044f" },
    "ui.tab_settings": { ru: "\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438", en: "Settings", uk: "\u041d\u0430\u043b\u0430\u0448\u0442\u0443\u0432\u0430\u043d\u043d\u044f" },
    "ui.lang_saved": {
      ru: "\u042f\u0437\u044b\u043a \u0438\u0437\u043c\u0435\u043d\u0451\u043d",
      en: "Language changed",
      uk: "\u041c\u043e\u0432\u0443 \u0437\u043c\u0456\u043d\u0435\u043d\u043e"
    }
  };

  function langCode() {
    var code = (state.me && state.me.language) || LANG_FALLBACK;
    return LANG_META[code] ? code : LANG_FALLBACK;
  }

  function tr(key, code) {
    var row = UI_STRINGS[key];
    if (!row) return null;
    return row[code || langCode()] || row[LANG_FALLBACK] || null;
  }

  // Списки (массивы) переводов: вернуть массив строк или null.
  function trList(key, code) {
    var row = UI_STRINGS[key];
    if (!row) return null;
    return row[code || langCode()] || row[LANG_FALLBACK];
  }

  // Применяет язык ко всей разметке сразу: атрибуты data-i18n (текст),
  // data-i18n-ph (placeholder) и data-i18n-aria (aria-label).
  function applyLang(code) {
    var use = LANG_META[code] ? code : LANG_FALLBACK;
    try { document.documentElement.setAttribute("lang", use); } catch (e) {}
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      var val = tr(key, use);
      if (val !== null) nodes[i].textContent = val;
    }
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) {
      var pval = tr(phs[j].getAttribute("data-i18n-ph"), use);
      if (pval !== null) phs[j].setAttribute("placeholder", pval);
    }
    var arias = document.querySelectorAll("[data-i18n-aria]");
    for (var k = 0; k < arias.length; k++) {
      var aval = tr(arias[k].getAttribute("data-i18n-aria"), use);
      if (aval !== null) arias[k].setAttribute("aria-label", aval);
    }
    var cur = $("#lang-current");
    if (cur) cur.textContent = LANG_META[use].name;
  }

  function closeLangMenu() {
    var menu = $("#lang-menu");
    var toggle = $("#lang-toggle");
    if (menu) menu.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function renderLangSelect() {
    var menu = $("#lang-menu");
    var toggle = $("#lang-toggle");
    if (!menu || !toggle) return;
    var current = langCode();
    var cur = $("#lang-current");
    if (cur) cur.textContent = LANG_META[current].name;

    menu.innerHTML = "";
    var codes = (state.me && state.me.languages)
      ? state.me.languages.map(function (l) { return l.code; })
      : ["ru", "en", "uk"];
    codes.forEach(function (code) {
      if (!LANG_META[code]) return;
      var btn = el("button", "lang-opt" + (code === current ? " active" : ""));
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", code === current ? "true" : "false");
      btn.appendChild(el("span", "lang-flag", LANG_META[code].flag));
      btn.appendChild(el("span", "lang-name", LANG_META[code].name));
      btn.appendChild(el("span", "lang-check", "\u2713"));
      btn.addEventListener("click", function () { pickLang(code); });
      menu.appendChild(btn);
    });

    if (!toggle._wired) {
      toggle._wired = true;
      toggle.addEventListener("click", function () {
        var open = menu.hidden;
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        haptic("light");
      });
      // Клик мимо — закрыть: иначе список висит поверх других настроек.
      document.addEventListener("click", function (ev) {
        var root = $("#lang-select");
        if (!root || menu.hidden) return;
        if (!root.contains(ev.target)) closeLangMenu();
      });
    }
  }

  function pickLang(code) {
    if (!LANG_META[code]) return;
    closeLangMenu();
    if (code === langCode()) return;
    // Оптимистично применяем сразу: ждать сетевой ответ ради смены
    // подписей — заметный лаг. При ошибке откатываемся назад.
    var prev = langCode();
    if (state.me) state.me.language = code;
    applyLang(code);
    renderLangSelect();
    apiFetch("/api/settings", { method: "POST", body: { language: code } })
      .then(function (res) {
        if (state.me) Object.assign(state.me, res);
        applyLang(langCode());
        renderLangSelect();
        toast(tr("ui.lang_saved"));
        haptic("light");
      })
      .catch(function (err) {
        if (state.me) state.me.language = prev;
        applyLang(prev);
        renderLangSelect();
        handleError(err);
      });
  }

  // ---- Settings ----
  function renderSettings() {
    if (!state.me) return;
    applyTheme(state.me.theme);
    tpickInit($("#daily-picker"), state.me.daily_time || "09:00");
    tpickInit($("#fb-picker"), state.me.feedback_time || "21:00");
    var tzh = $("#tz-hint");
    if (tzh) {
      tzh.textContent = "Время по твоему часовому поясу (" + tzLabel() + ")"
        + (state.me.daily_time ? "" : " · напоминание сейчас выключено");
    }
    var fbh = $("#fb-hint");
    var win = state.me.feedback_window;
    if (fbh && win) {
      fbh.textContent = "Приходит вечером. Допустимое окно: " + win.start + "–" + win.end + ".";
    }
    $("#weekly-toggle").checked = state.me.weekly_summary !== false;
    renderLangSelect();
    applyLang(langCode());
  }

  function saveSetting(body, note) {
    apiFetch("/api/settings", { method: "POST", body: body }).then(function (res) {
      if (state.me) Object.assign(state.me, res);
      if (note) toast(note);
      haptic("light");
    }).catch(handleError);
  }

  // ========================================================
  //  MANUAL MODE (ручной ввод карт)
  //  Без ритуала переворота — карты уже известны пользователю.
  // ========================================================
  var manualState = null;      // {type, meta, cards:[{id,reversed}|null], editing}
  var cardsCatalog = null;     // {suits:[...]} — кэш /api/cards
  var cardById = {};           // id -> {id,name,emoji,suit,number}
  var pickerFilter = "all";

  function setupManual() {
    $("#manual-build").hidden = true;
    $("#manual-spreads").hidden = false;
    if (state.catalog && state.catalog.length) renderManualSpreads();
    else apiFetch("/api/spreads").then(function (res) {
      state.catalog = res.spreads || [];
      state.catalogLabels = {};
      state.catalog.forEach(function (s) { state.catalogLabels[s.key] = s.label; });
      renderManualSpreads();
    }).catch(handleError);
  }

  function manualSpreadCard(s) {
    var btn = el("button", "spread-card");
    btn.appendChild(el("div", "spread-ico", s.emoji || "🃏"));
    var body = el("div", "spread-body");
    body.appendChild(el("div", "spread-name", shortName(s)));
    body.appendChild(el("div", "spread-desc", s.label + " · " + s.n + cardWord(s.n)));
    btn.appendChild(body);
    btn.addEventListener("click", function () { selectManualSpread(s.key); });
    return btn;
  }

  function renderManualSpreads() {
    var wrap = $("#manual-spreads");
    wrap.innerHTML = "";
    var byGroup = {};
    state.catalog.forEach(function (s) { (byGroup[s.group] = byGroup[s.group] || []).push(s); });
    GROUP_ORDER.forEach(function (g) {
      var items = byGroup[g];
      if (!items || !items.length) return;
      wrap.appendChild(buildSpreadGroup(g, items, manualSpreadCard));
    });
  }

  function selectManualSpread(key) {
    var s = state.catalog.filter(function (x) { return x.key === key; })[0];
    if (!s) return;
    haptic("light");
    manualState = { type: key, meta: s, cards: new Array(s.n).fill(null), editing: -1 };
    $("#manual-title").textContent = s.label;
    $("#manual-q").value = "";
    $("#manual-spreads").hidden = true;
    $("#manual-build").hidden = false;
    renderManualSlots();
  }

  function renderManualSlots() {
    var wrap = $("#manual-slots");
    wrap.innerHTML = "";
    var positions = manualState.meta.positions || [];
    manualState.cards.forEach(function (c, i) {
      var slot = el("div", "mslot");
      slot.appendChild(el("div", "mslot-pos", positions[i] || ("Карта " + (i + 1))));
      var row = el("div", "mslot-row");
      var pick = el("button", "mslot-pick" + (c ? " filled" : ""));
      if (c) {
        var base = cardById[c.id] || {};
        pick.appendChild(el("span", "mslot-emoji", base.emoji || "🃏"));
        pick.appendChild(el("span", "mslot-name", base.name || c.id));
      } else {
        pick.textContent = "+ выбрать карту";
      }
      pick.onclick = function () { openPicker(i); };
      row.appendChild(pick);
      var orient = el("button", "mslot-orient" + (c && c.reversed ? " rev" : ""));
      orient.textContent = c ? (c.reversed ? "⇅ перевёрнутая" : "↑ прямая") : "↑ прямая";
      orient.disabled = !c;
      if (c) orient.onclick = function () { manualState.cards[i].reversed = !manualState.cards[i].reversed; haptic("light"); renderManualSlots(); };
      row.appendChild(orient);
      slot.appendChild(row);
      wrap.appendChild(slot);
    });
    var filled = manualState.cards.every(function (c) { return !!c; });
    $("#manual-submit").disabled = !filled;
  }

  function ensureCards() {
    if (cardsCatalog) return Promise.resolve(cardsCatalog);
    return apiFetch("/api/cards").then(function (res) {
      cardsCatalog = res;
      (res.suits || []).forEach(function (su) {
        (su.cards || []).forEach(function (c) { cardById[c.id] = c; });
      });
      return res;
    });
  }

  function openPicker(idx) {
    manualState.editing = idx;
    overlay(true, "Загружаю карты…");
    ensureCards().then(function () {
      overlay(false);
      pickerFilter = "all";
      $("#picker-search").value = "";
      buildPickerSuits();
      renderPicker();
      $("#picker").hidden = false;
    }).catch(function (err) { overlay(false); handleError(err); });
  }

  function closePicker() { $("#picker").hidden = true; }

  function buildPickerSuits() {
    var wrap = $("#picker-suits");
    wrap.innerHTML = "";
    var all = el("button", "psuit" + (pickerFilter === "all" ? " active" : ""), "Все");
    all.onclick = function () { pickerFilter = "all"; buildPickerSuits(); renderPicker(); };
    wrap.appendChild(all);
    (cardsCatalog.suits || []).forEach(function (su) {
      var b = el("button", "psuit" + (pickerFilter === su.suit ? " active" : ""), su.label || su.suit);
      b.onclick = function () { pickerFilter = su.suit; buildPickerSuits(); renderPicker(); };
      wrap.appendChild(b);
    });
  }

  function renderPicker() {
    var grid = $("#picker-grid");
    grid.innerHTML = "";
    var q = ($("#picker-search").value || "").toLowerCase().trim();
    var used = {};
    manualState.cards.forEach(function (c, i) { if (c && i !== manualState.editing) used[c.id] = true; });
    var shown = 0;
    (cardsCatalog.suits || []).forEach(function (su) {
      if (pickerFilter !== "all" && su.suit !== pickerFilter) return;
      (su.cards || []).forEach(function (c) {
        if (q && (c.name || "").toLowerCase().indexOf(q) < 0) return;
        shown++;
        var b = el("button", "pcard" + (used[c.id] ? " used" : ""));
        b.appendChild(el("span", "pcard-emoji", c.emoji || "🃏"));
        b.appendChild(el("span", "pcard-name", c.name || c.id));
        if (used[c.id]) { b.disabled = true; b.title = "Уже выбрана"; }
        else b.onclick = function () { pickCard(c); };
        grid.appendChild(b);
      });
    });
    if (!shown) grid.appendChild(el("div", "empty-note", "Ничего не найдено."));
  }

  function pickCard(c) {
    cardById[c.id] = c;
    if (manualState.editing < 0) return;
    manualState.cards[manualState.editing] = { id: c.id, reversed: false };
    haptic("light");
    closePicker();
    renderManualSlots();
  }

  function submitManual() {
    if (!manualState) return;
    if (!manualState.cards.every(function (c) { return !!c; })) { toast("Выбери все карты расклада."); return; }
    var cards = manualState.cards.map(function (c) { return { id: c.id, reversed: !!c.reversed }; });
    var q = ($("#manual-q").value || "").trim() || null;
    overlay(true, "Читаю расклад…");
    apiFetch("/api/spread/manual", { method: "POST", body: { type: manualState.type, question: q, cards: cards } })
      .then(function (res) {
        overlay(false);
        state.current = {
          id: res.id, type: res.type, label: res.label || labelFor(res.type),
          question: res.question, cards: res.cards || [],
          revealed: {}, done: true, interpreting: false, interpretation: res.interpretation || ""
        };
        renderTable(state.current, { done: true });
        renderLimits(res.limits);
        updateStars(res.limits);
        showScreen("table");
        haptic("success");
      })
      .catch(function (err) {
        overlay(false);
        if (err.status === 429) {
          haptic("error");
          var dd = err.detail || {};
          if (offerLimitOptions(dd, function () { submitManual(); })) {
            // оплачено зёрнами
          } else if (dd.product) {
            toast("Лимит исчерпан. Докупить за ⭐ " + (dd.price_stars || "") + "?");
            offerPurchase(dd, function () { submitManual(); });
          } else {
            toast("Лимит на сегодня исчерпан. Сброс в 00:00 UTC.");
          }
        }
        else if (err.status === 400) {
          var d = err.detail || {};
          if (d.error === "duplicate_cards") toast("Карты не должны повторяться.");
          else if (d.error === "card_count") toast("Выбери все карты расклада.");
          else toast("Проверь выбранные карты.");
        } else handleError(err);
      });
  }

  // ========================================================
  //  CALENDAR (карты дня)
  // ========================================================
  var WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  var calState = null;   // последний ответ /api/calendar — нужен листу награды

  function loadCalendar() {
    var grid = $("#cal-grid");
    grid.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/calendar?days=35").then(function (res) {
      calState = res;
      grid.innerHTML = "";
      renderUpcoming(res);
      var byDay = {};
      (res.days || []).forEach(function (d) { byDay[d.day] = d; });
      WEEKDAYS.forEach(function (w) { grid.appendChild(el("div", "cal-wd", w)); });
      var today = new Date(res.today + "T00:00:00Z");
      var days = [];
      for (var i = 34; i >= 0; i--) days.push(new Date(today.getTime() - i * 86400000));
      var firstWd = (days[0].getUTCDay() + 6) % 7; // Пн=0
      for (var b = 0; b < firstWd; b++) grid.appendChild(el("div", "cal-cell blank"));
      days.forEach(function (dt) {
        var key = dt.toISOString().slice(0, 10);
        var info = byDay[key];
        var cell = el("div", "cal-cell" + (info && info.card ? " has" : "") + (info && info.locked ? " locked" : "") + (info && info.verdict ? " v-" + info.verdict : ""));
        if (key === res.today) cell.classList.add("today");
        cell.appendChild(el("div", "cal-num", String(dt.getUTCDate())));
        if (info && info.card) {
          cell.appendChild(el("div", "cal-emoji", info.card.emoji || "🃏"));
          if (info.locked) cell.appendChild(el("div", "cal-lock", "🔒"));
          cell.title = (info.card.name || "") + (info.card.reversed ? " (перевёрнутая)" : "");
          if (info.spread_id) {
            cell.classList.add("clickable");
            cell.onclick = (function (sid) { return function () { haptic("light"); openHistItem(sid); }; })(info.spread_id);
          }
        }
        var rw = (info && info.rewards) ? info.rewards : [];
        if (rw.length) {
          var free = rw.filter(function (r) { return r.claimable; }).length;
          var badge = el("div", "cal-gift" + (free ? " free" : " done"), free ? "🎁" : "✓");
          cell.appendChild(badge);
          cell.classList.add("clickable");
          // Награда важнее перехода в расклад: лист сам даёт ссылку на расклад.
          cell.onclick = (function (k) { return function () { haptic("light"); openRewardSheet(k); }; })(key);
        }
        grid.appendChild(cell);
      });
    }).catch(handleError);
  }

  function renderUpcoming(res) {
    var box = $("#cal-upcoming");
    if (!box) return;
    var list = (res.rewards_active && res.upcoming) ? res.upcoming.slice(0, 3) : [];
    if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(el("div", "cal-up-title", "Скоро"));
    list.forEach(function (u) {
      var row = el("div", "cal-up-row");
      row.appendChild(el("span", "cal-up-emoji", u.emoji || "✨"));
      row.appendChild(el("span", "cal-up-name", u.title || ""));
      row.appendChild(el("span", "cal-up-in", "через " + u.in_days + " " + dayWord(u.in_days)));
      box.appendChild(row);
    });
  }

  function dayWord(n) {
    var n100 = Math.abs(n) % 100, n1 = n100 % 10;
    if (n100 > 10 && n100 < 20) return "дней";
    if (n1 === 1) return "день";
    if (n1 > 1 && n1 < 5) return "дня";
    return "дней";
  }

  // ---- Лист награды ----
  function calDay(day) {
    if (!calState) return null;
    var found = null;
    (calState.days || []).forEach(function (d) { if (d.day === day) found = d; });
    return found;
  }

  function openRewardSheet(day) {
    var sheet = $("#reward-sheet");
    var body = $("#reward-body");
    var info = calDay(day);
    if (!sheet || !body || !info) return;
    body.innerHTML = "";
    body.appendChild(el("div", "sheet-title", day));
    if (info.card) {
      body.appendChild(el("div", "sheet-sub",
        (info.card.emoji || "🃏") + " " + (info.card.name || "")));
    }
    (info.rewards || []).forEach(function (r) {
      var row = el("div", "rw-row" + (r.claimed ? " claimed" : ""));
      row.appendChild(el("div", "rw-emoji", r.emoji || "🎁"));
      var txt = el("div", "rw-text");
      txt.appendChild(el("div", "rw-title", r.title || ""));
      txt.appendChild(el("div", "rw-desc", r.desc || ""));
      row.appendChild(txt);
      if (r.claimed) {
        row.appendChild(el("div", "rw-state", "Получено"));
      } else if (r.claimable) {
        var btn = el("button", "btn-mini", "Забрать");
        btn.onclick = function () { claimReward(day, r.key, btn); };
        row.appendChild(btn);
      } else {
        // Окно в CLAIM_GRACE_DAYS дней — чтобы награды не копились годами.
        row.appendChild(el("div", "rw-state", "Сгорело"));
      }
      body.appendChild(row);
    });
    if (info.spread_id) {
      var open = el("button", "btn-mini ghost", "Открыть расклад");
      open.onclick = function () { closeRewardSheet(); openHistItem(info.spread_id); };
      body.appendChild(open);
    }
    sheet.hidden = false;
  }

  function closeRewardSheet() {
    var sheet = $("#reward-sheet");
    if (sheet) sheet.hidden = true;
  }

  function claimReward(day, key, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    apiFetch("/api/calendar/reward/claim", { method: "POST", body: { day: day, key: key } })
      .then(function (res) {
        haptic("success");
        if (res.kind === "coins") toast("+" + res.amount + " 🌾");
        else toast((res.emoji || "🎁") + " " + (res.title || "Награда твоя"));
        if (res.coins) renderCoins(res.coins);
        if (state.me && res.backs) state.me.backs = res.backs;
        closeRewardSheet();
        loadCalendar();
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = "Забрать"; }
        if (err.status === 400) toast("За этот день уже поздно или нет карты дня.");
        else if (err.status === 409) { toast("Награда уже забрана."); loadCalendar(); }
        else handleError(err);
      });
  }

  // ---- Зёрна (coins) ----
  function coinWord(n, forms) {
    if (!forms) return "";
    n = Math.abs(n) % 100;
    var n1 = n % 10;
    if (n > 10 && n < 20) return forms.many;
    if (n1 > 1 && n1 < 5) return forms.few;
    if (n1 === 1) return forms.one;
    return forms.many;
  }

  function renderCoins(coins) {
    state.coins = coins || null;
    var pill = $("#coins-pill");
    var qb = $("#quests-banner");
    if (!coins || !coins.quests_active) {
      if (pill) pill.hidden = true;
      if (qb) qb.hidden = true;
      return;
    }
    if (pill) { pill.hidden = false; $("#coins-balance").textContent = String(coins.balance || 0); }
    if (qb) qb.hidden = false;
  }

  // ---- Тропа Гуся (quests) ----
  function loadQuests() {
    var list = $("#quests-list");
    if (list) list.innerHTML = "<div class='empty-note'>Загружаю задания…</div>";
    apiFetch("/api/quests").then(function (res) {
      renderQuests(res);
    }).catch(function (err) {
      if (list) list.innerHTML = "<div class='empty-note'>Не удалось загрузить задания.</div>";
      handleError(err);
    });
  }

  function renderQuests(res) {
    var coins = res.coins || {};
    renderCoins(coins);
    var forms = coins.forms || {};
    var bal = coins.balance || 0;
    var balEl = $("#quests-balance"); if (balEl) balEl.textContent = String(bal);
    var wordEl = $("#quests-balance-word"); if (wordEl) wordEl.textContent = coinWord(bal, forms) || "зёрен";

    var prices = $("#quests-prices");
    if (prices) {
      prices.innerHTML = "";
      var titles = { spread_one: "Одна карта", spread_three: "Три карты", spread_cross4: "Крест (4)", spread_cross5: "Крест (5)" };
      var p = coins.prices || {};
      Object.keys(titles).forEach(function (k) {
        if (!p[k]) return;
        var chip = el("div", "qprice");
        chip.appendChild(el("span", "qprice-name", titles[k]));
        chip.appendChild(el("span", "qprice-cost", "🌾 " + p[k]));
        prices.appendChild(chip);
      });
    }

    var list = $("#quests-list");
    if (!list) return;
    list.innerHTML = "";
    var quests = res.quests || [];
    if (!res.active || !quests.length) {
      list.innerHTML = "<div class='empty-note'>Заданий пока нет. Загляни позже 🌱</div>";
      return;
    }
    var delay = res.claim_delay_sec || 15;
    quests.forEach(function (q) { list.appendChild(questCard(q, delay)); });
  }

  function questCard(q, delay) {
    var card = el("div", "quest-card");
    if (q.done) card.classList.add("done");
    if (q.kind === "temporary") card.classList.add("temp");

    var head = el("div", "quest-head");
    head.appendChild(el("span", "quest-emoji", q.emoji || "🌾"));
    var tw = el("div", "quest-title-wrap");
    tw.appendChild(el("div", "quest-title", q.title || ""));
    if (q.desc) tw.appendChild(el("div", "quest-desc", q.desc));
    head.appendChild(tw);
    head.appendChild(el("div", "quest-reward", "🌾 " + (q.reward || 0)));
    card.appendChild(head);

    var foot = el("div", "quest-foot");
    if (q.freq === "daily") foot.appendChild(el("span", "quest-tag", "Каждый день"));
    if (q.kind === "temporary") foot.appendChild(el("span", "quest-tag temp", "Временное"));
    if (foot.childNodes.length) card.appendChild(foot);

    var btn = el("button", "quest-btn");
    if (q.done) {
      btn.textContent = q.freq === "daily" ? "✓ Сегодня получено" : "✓ Получено";
      btn.disabled = true;
      card.appendChild(btn);
      return card;
    }
    if (q.needs_code) {
      // Видео с кодовым словом: факт просмотра на YouTube проверить невозможно,
      // поэтому спрашиваем слово из середины видео. Код сверяется НА СЕРВЕРЕ.
      var codeWrap = el("div", "quest-code-wrap");
      var input = el("input", "quest-code-input");
      input.type = "text";
      input.maxLength = 64;
      input.placeholder = "Кодовое слово из видео";
      var wait = q.min_wait_sec || delay;
      if (q.status === "started") {
        codeWrap.appendChild(input);
        card.appendChild(codeWrap);
        btn.textContent = "Проверить и забрать 🌾 " + (q.reward || 0);
        btn.onclick = function () { claimQuest(q, btn, input.value); };
      } else {
        btn.textContent = "Открыть видео";
        btn.onclick = function () {
          if (q.url) { try { (TG && TG.openLink) ? TG.openLink(q.url) : window.open(q.url, "_blank"); } catch (e) {} }
          codeWrap.appendChild(input);
          card.appendChild(codeWrap);
          startQuest(q, btn, wait, function () {
            btn.textContent = "Проверить и забрать 🌾 " + (q.reward || 0);
            btn.onclick = function () { claimQuest(q, btn, input.value); };
          });
        };
      }
    } else if (q.verify === "trust") {
      btn.textContent = "Забрать 🌾 " + (q.reward || 0);
      btn.onclick = function () { claimQuest(q, btn); };
    } else {
      btn.textContent = q.status === "started" ? ("Забрать 🌾 " + (q.reward || 0)) : "Открыть";
      btn.onclick = function () {
        if (btn.dataset.ready === "1" || q.status === "started") { claimQuest(q, btn); return; }
        if (q.url) { try { (TG && TG.openLink) ? TG.openLink(q.url) : window.open(q.url, "_blank"); } catch (e) {} }
        startQuest(q, btn, delay);
      };
    }
    card.appendChild(btn);
    return card;
  }

  function startQuest(q, btn, delay, onReady) {
    apiFetch("/api/quests/start", { method: "POST", body: { id: q.id } }).catch(function () {});
    var left = delay;
    btn.disabled = true;
    btn.textContent = "Подожди " + left + "с…";
    var timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.dataset.ready = "1";
        btn.textContent = "Забрать 🌾 " + (q.reward || 0);
        if (onReady) onReady();
      } else { btn.textContent = "Подожди " + left + "с…"; }
    }, 1000);
  }

  function claimQuest(q, btn, code) {
    var payload = { id: q.id };
    if (code) payload.code = String(code).slice(0, 64);
    btn.disabled = true;
    apiFetch("/api/quests/claim", { method: "POST", body: payload }).then(function (res) {
      haptic("success");
      if (res.reward) toast("+" + res.reward + " 🌾");
      if (res.coins) renderCoins(res.coins);
      loadQuests();
    }).catch(function (err) {
      btn.disabled = false;
      var d = err && err.detail;
      if (err && err.status === 425 && d && d.error === "too_soon") {
        toast("Ещё чуть-чуть — подожди " + (d.wait_sec || 1) + "с.");
      } else if (err && err.status === 425 && d && d.error === "not_subscribed") {
        toast("Не вижу подписки. Подпишись и нажми снова.");
      } else if (err && err.status === 503 && d && d.error === "verification_unavailable") {
        toast("Не смог проверить подписку — это на нашей стороне. Попробуй позже.");
      } else if (err && err.status === 503 && d && d.error === "quest_not_configured") {
        toast("Задание пока не настроено. Загляни позже.");
      } else if (err && err.status === 400 && d && d.error === "wrong_code") {
        toast("Кодовое слово не совпало. Оно звучит в середине видео.");
      } else if (err && err.status === 429 && d && d.error === "too_many_attempts") {
        toast("Слишком много попыток. Попробуй через час.");
      } else if (err && err.status === 409) {
        toast("Уже получено."); loadQuests();
      } else { handleError(err); }
    });
  }

  // ---- Оплата зёрнами (redeem) ----
  function payWithCoins(action, onDone) {
    overlay(true, "Оплачиваю зёрнами…");
    apiFetch("/api/coins/redeem", { method: "POST", body: { action: action } }).then(function (res) {
      overlay(false);
      haptic("success");
      if (res.coins) renderCoins(res.coins);
      toast("Оплачено 🌾 " + (res.spent || ""));
      if (onDone) onDone();
    }).catch(function (err) {
      overlay(false);
      if (err && err.status === 402) { toast("Не хватает зёрен. Загляни на Тропу Гуся 🌾"); }
      else { handleError(err); }
    });
  }

  // Если зёрен хватает — сразу предлагаем оплату зёрнами (возвращает true).
  function offerLimitOptions(detail, onDraw) {
    var coins = state.coins || {};
    var price = detail.coin_price || 0;
    var have = coins.balance || 0;
    if (coins.quests_active && price > 0 && have >= price) {
      toast("Лимит исчерпан. Оплачиваю за 🌾 " + price);
      payWithCoins(detail.action, onDraw);
      return true;
    }
    return false;
  }

  // ---- Админ: общая статистика ----
  function loadAdminStats() {
    var body = $("#admin-body");
    if (body) body.innerHTML = "<div class='empty-note'>Загружаю…</div>";
    apiFetch("/api/admin/global-stats").then(function (res) {
      renderAdminStats(res);
    }).catch(function (err) {
      if (body) body.innerHTML = "<div class='empty-note'>Нет доступа или ошибка.</div>";
      handleError(err);
    });
  }

  function renderAdminStats(res) {
    var body = $("#admin-body");
    if (!body) return;
    body.innerHTML = "";
    var fb = res.feedback || {};
    var top = el("div", "admin-cards");
    function stat(label, val) {
      var c = el("div", "admin-stat");
      c.appendChild(el("div", "admin-stat-val", String(val)));
      c.appendChild(el("div", "admin-stat-lbl", label));
      return c;
    }
    top.appendChild(stat("Пользователи", res.users || 0));
    top.appendChild(stat("Расклады", res.spreads || 0));
    top.appendChild(stat("Ответов по карте дня", fb.total || 0));
    body.appendChild(top);

    var fbBox = el("div", "admin-fb");
    fbBox.appendChild(el("div", "admin-h", "Карта дня — совпадения"));
    var bars = el("div", "admin-bars");
    [["Совпало", fb.pct_match || 0, "green"], ["Частично", fb.pct_partial || 0, "yellow"], ["Не похоже", fb.pct_miss || 0, "red"]].forEach(function (r) {
      var row = el("div", "admin-bar-row");
      row.appendChild(el("span", "admin-bar-lbl", r[0]));
      var track = el("div", "admin-bar-track");
      var fill = el("div", "admin-bar-fill " + r[2]);
      fill.style.width = r[1] + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "admin-bar-pct", r[1] + "%"));
      bars.appendChild(row);
    });
    fbBox.appendChild(bars);
    body.appendChild(fbBox);

    var cards = (res.cards && res.cards.top) || [];
    if (cards.length) {
      var cbox = el("div", "admin-topcards");
      cbox.appendChild(el("div", "admin-h", "Частые карты дня"));
      cards.forEach(function (c) {
        var row = el("div", "admin-card-row");
        row.appendChild(el("span", "admin-card-name", (c.emoji || "🃏") + " " + (c.name || c.id || "")));
        row.appendChild(el("span", "admin-card-cnt", "×" + (c.count || 0)));
        cbox.appendChild(row);
      });
      body.appendChild(cbox);
    }
  }

  // ---- Utils ----
  function fmtDate(s) {
    if (!s) return "";
    var d = new Date(s.indexOf("T") >= 0 ? s : s.replace(" ", "T") + "Z");
    if (isNaN(d)) return s;
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function handleError(err) {
    console.error(err);
    if (err && err.status === 401) toast("Не удалось подтвердить вход. Открой мини-приложение через Telegram.");
    else toast("Что-то пошло не так. Попробуй ещё раз.");
  }

  // ---- Bind ----
  function bind() {
    $all("[data-nav]").forEach(function (b) {
      b.addEventListener("click", function () { navigate(b.getAttribute("data-nav")); });
    });
    $all(".theme-opt").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-theme-opt");
        applyTheme(t);
        if (state.me) state.me.theme = t;
        saveSetting({ theme: t }, "Тема обновлена.");
      });
    });
    // Лист-шторка вопроса перед раскладом
    var qsGo = $("#q-sheet-go");
    if (qsGo) qsGo.addEventListener("click", confirmQuestionSheet);
    var qsClose = $("#q-sheet-close");
    if (qsClose) qsClose.addEventListener("click", closeQuestionSheet);
    var qsBg = $("#q-sheet");
    if (qsBg) qsBg.addEventListener("click", function (e) { if (e.target === qsBg) closeQuestionSheet(); });
    var qsInput = $("#q-sheet-input");
    if (qsInput) qsInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) confirmQuestionSheet();
    });

    $("#chat-back").addEventListener("click", function () { showScreen("table"); });
    $("#chat-form").addEventListener("submit", sendChat);
    var deepBtn = $("#deep-btn");
    if (deepBtn) deepBtn.addEventListener("click", loadDeep);
    var scBtn = $("#spread-chat-btn");
    if (scBtn) scBtn.addEventListener("click", openSpreadChat);
    initStardust();

    // Ручной режим + модалка выбора карт
    var mReset = $("#manual-reset");
    if (mReset) mReset.addEventListener("click", function () { setupManual(); });
    var mSubmit = $("#manual-submit");
    if (mSubmit) mSubmit.addEventListener("click", submitManual);
    var mq = $("#manual-q");
    if (mq) mq.addEventListener("input", function () {
      mq.style.height = "auto"; mq.style.height = Math.min(mq.scrollHeight, 120) + "px";
    });
    var pClose = $("#picker-close");
    if (pClose) pClose.addEventListener("click", closePicker);
    var cvClose = $("#cardview-close");
    if (cvClose) cvClose.addEventListener("click", closeCardView);
    var cvBg = $("#cardview");
    if (cvBg) cvBg.addEventListener("click", function (e) { if (e.target === cvBg) closeCardView(); });
    var pSearch = $("#picker-search");
    if (pSearch) pSearch.addEventListener("input", function () { renderPicker(); });
    var pickerBg = $("#picker");
    if (pickerBg) pickerBg.addEventListener("click", function (e) { if (e.target === pickerBg) closePicker(); });
    $("#daily-save").addEventListener("click", function () {
      var v = tpickValue($("#daily-picker"));
      if (!v) { toast("Укажи время."); return; }
      saveSetting({ daily_time: v }, "Напоминание в " + v + ".");
    });
    $("#daily-off").addEventListener("click", function () {
      saveSetting({ daily_time: null }, "Напоминание выключено.");
    });
    var fbSave = $("#fb-save");
    if (fbSave) fbSave.addEventListener("click", function () {
      var v = tpickValue($("#fb-picker"));
      if (!v) return;
      saveSetting({ feedback_time: v }, "Вечерний вопрос в " + v + ".");
    });
    var rClose = $("#reward-close");
    if (rClose) rClose.addEventListener("click", closeRewardSheet);
    var rBg = $("#reward-sheet");
    if (rBg) rBg.addEventListener("click", function (e) { if (e.target === rBg) closeRewardSheet(); });
    $("#weekly-toggle").addEventListener("change", function (e) {
      saveSetting({ weekly_summary: e.target.checked }, null);
    });
  }

  // ---- Boot ----
  function boot() {
    if (TG) { try { TG.ready(); TG.expand(); } catch (e) {} }
    if (!API) { toast("API не настроен (js/config.js)."); }
    bind();
    showScreen("home");
    loadMe();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
