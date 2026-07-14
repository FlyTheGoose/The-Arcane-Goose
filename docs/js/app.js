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
    current: null, chat: null
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
      applyTheme(me.theme);
      renderRank(me.rank);
      $("#admin-badge").hidden = !me.is_admin;
      updateStars(me.limits);
      loadCatalog(me.limits);
      loadDeckPill();
      loadWeekBanner();
      renderPremium(me);
    }).catch(handleError);
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
        $("#deck-pill-emoji").textContent = sel.emoji || "🂠";
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
      wrap.appendChild(el("div", "group-title", GROUP_TITLES[g] || g));
      var list = el("div", "spreads");
      items.forEach(function (s) { list.appendChild(spreadCard(s)); });
      wrap.appendChild(list);
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
          if (dd.product) {
            toast("Лимит исчерпан. Докупить расклад за ⭐ " + (dd.price_stars || "") + "?");
            offerPurchase(dd, function () { drawSpread(type); });
          } else {
            toast("Лимит на сегодня исчерпан. Сброс в 00:00 UTC.");
            if (state.me) loadMe();
          }
        } else if (err.status === 403) {
          toast("Этот расклад сейчас недоступен.");
        } else handleError(err);
      });
  }

  // ---- TABLE render ----
  // layoutFor → CSS-класс раскладки. Кресты получают grid-area на широких экранах.
  function layoutFor(type, n) {
    if (type === "cross4") return "layout-cross4";
    if (type === "cross5") return "layout-cross5";
    if (n >= 6) return "layout-grid";
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
      row.appendChild(slot);
    });

    // Сброс блоков трактовки/премиума
    $("#interp").textContent = "";
    $("#interp-wrap").hidden = true;
    $("#chat-hint").hidden = true;

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
    if (card.back) {
      var bimg = document.createElement("img");
      bimg.src = API + card.back;
      bimg.alt = "";
      bimg.onerror = function () { back.classList.add("noimg"); back.textContent = "✧"; bimg.remove(); };
      back.appendChild(bimg);
    } else { back.classList.add("noimg"); back.textContent = "✧"; }

    // Лицо (front) — картинка уже повёрнута на сервере при rev=1
    var front = el("div", "face front");
    if (card.image) {
      var fimg = document.createElement("img");
      fimg.src = API + card.image;
      fimg.alt = card.name || "";
      fimg.onerror = function () { front.classList.add("noimg"); front.textContent = card.emoji || "🃏"; fimg.remove(); };
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
      } else if (cur2.done) {
        // После трактовки — диалог с картой
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
    $("#interp").appendChild(el("span", "interp-loading", "Читаю расклад…"));
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

    apiFetch("/api/spread/interpret", { method: "POST", body: { spread_id: cur.id } })
      .then(function (res) {
        cur.interpretation = res.interpretation || "";
        cur.done = true;
        cur.interpreting = false;
        showInterpretation(cur.interpretation);
        showDeepAndChat(cur);
        haptic("success");
      })
      .catch(function (err) {
        cur.interpreting = false;
        $("#interp").textContent = "Не удалось получить трактовку. Попробуй ещё раз.";
        var retry = el("button", "btn-mini", "Повторить");
        retry.onclick = function () { cur.done = false; maybeInterpret(); };
        $("#interp").appendChild(document.createElement("br"));
        $("#interp").appendChild(retry);
        handleError(err);
      });
  }

  function showInterpretation(text) {
    $("#interp-wrap").hidden = false;
    $("#interp").textContent = text || "";
  }

  // Глубокий разбор убран — остаётся только разговор с картой.
  function showChatHint(cur) {
    $("#chat-hint").hidden = false;
  }

  // ---- Card dialogue ----
  function openChat(spreadId, card) {
    state.chat = { spreadId: spreadId, card: card };
    $("#chat-card-emoji").textContent = card.emoji || "🃏";
    $("#chat-card-name").textContent = card.name || "Карта";
    var orient = (card.reversed ? "перевёрнутая" : "прямая") + (card.position ? " · " + card.position : "");
    $("#chat-card-orient").textContent = orient;
    $("#chat-log").innerHTML = "";
    $("#chat-turns").textContent = "";
    $("#chat-input").value = "";
    $("#chat-input").disabled = false;
    $("#chat-send").disabled = false;
    showScreen("chat");
    apiFetch("/api/chat?spread_id=" + spreadId + "&card_id=" + encodeURIComponent(card.id))
      .then(function (res) {
        (res.messages || []).forEach(function (m) { addBubble(m.role, m.content); });
        if (!(res.messages || []).length) {
          addBubble("card", "Я — " + (card.name || "карта") + ". Спроси меня о том, что тебя волнует.");
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
    input.value = "";
    addBubble("user", msg);
    var typing = addBubble("card", "…");
    typing.classList.add("typing");
    $("#chat-send").disabled = true;
    apiFetch("/api/chat", { method: "POST", body: {
      spread_id: state.chat.spreadId, card_id: state.chat.card.id, message: msg
    }}).then(function (res) {
      typing.remove();
      addBubble("card", res.reply || "…");
      updateTurns(res.turns, res.max_turns);
      $("#chat-send").disabled = false;
      haptic("light");
    }).catch(function (err) {
      typing.remove();
      $("#chat-send").disabled = false;
      if (err.status === 429) { toast("Достигнут лимит диалога с этой картой."); updateTurns(9999, 9999); }
      else if (err.status === 402) {
        var d = err.detail || {};
        toast("Диалог с картой за ⭐ " + (d.price_stars || "") + ".");
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
        var item = el("div", "deck-item" + (d.selected ? " selected" : ""));
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
        if (d.selected) {
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
    }).catch(handleError);
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
        grid.appendChild(cell);
      });
    }).catch(handleError);
  }

  // ---- Week ----
  function loadWeekBanner() {
    apiFetch("/api/week").then(function (w) {
      var banner = $("#week-banner");
      banner.hidden = false;
      $("#week-desc").textContent = w.claimed
        ? "Итог недели готов"
        : "Дней с картой: " + w.distinct_days + "/" + w.min_days;
      var pct = Math.min(100, Math.round((w.distinct_days / w.min_days) * 100));
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
      info.textContent = "Карта дня отмечена в " + w.distinct_days + " из " + w.min_days + " необходимых дней этой недели.";
      body.appendChild(info);
      var btn = el("button", "btn-premium");
      btn.innerHTML = '<span class="bp-ico">🌙</span><span class="bp-label">Получить итог недели</span>';
      btn.disabled = !w.can_claim;
      btn.onclick = function () { claimWeek(); };
      body.appendChild(btn);
      if (!w.can_claim) body.appendChild(el("div", "week-locked-note", "Итог откроется, когда наберётся " + w.min_days + " дней с картой дня. Выдаётся один раз."));
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

  // ---- Settings ----
  function renderSettings() {
    if (!state.me) return;
    applyTheme(state.me.theme);
    $("#daily-time").value = state.me.daily_time || "";
    $("#weekly-toggle").checked = state.me.weekly_summary !== false;
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
  //  Без ритуала переворота — карты уже известны пользовател��.
  // ========================================================
  var manualState = null;      // {type, meta, cards:[{id,reversed}|null], editing}
  var cardsCatalog = null;     // {suits:[...]} — кеш /api/cards
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

  function renderManualSpreads() {
    var wrap = $("#manual-spreads");
    wrap.innerHTML = "";
    var byGroup = {};
    state.catalog.forEach(function (s) { (byGroup[s.group] = byGroup[s.group] || []).push(s); });
    GROUP_ORDER.forEach(function (g) {
      var items = byGroup[g];
      if (!items || !items.length) return;
      wrap.appendChild(el("div", "group-title", GROUP_TITLES[g] || g));
      var list = el("div", "spreads");
      items.forEach(function (s) {
        var btn = el("button", "spread-card");
        btn.appendChild(el("div", "spread-ico", s.emoji || "🃏"));
        var body = el("div", "spread-body");
        body.appendChild(el("div", "spread-name", shortName(s)));
        body.appendChild(el("div", "spread-desc", s.label + " · " + s.n + cardWord(s.n)));
        btn.appendChild(body);
        btn.addEventListener("click", function () { selectManualSpread(s.key); });
        list.appendChild(btn);
      });
      wrap.appendChild(list);
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
        if (err.status === 429) { toast("Лимит на сегодня исчерпан. Сброс в 00:00 UTC."); haptic("error"); }
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

  function loadCalendar() {
    var grid = $("#cal-grid");
    grid.innerHTML = "<div class='empty-note'>Загрузка…</div>";
    apiFetch("/api/calendar?days=35").then(function (res) {
      grid.innerHTML = "";
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
        var cell = el("div", "cal-cell" + (info && info.card ? " has" : "") + (info && info.locked ? " locked" : ""));
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
        grid.appendChild(cell);
      });
    }).catch(handleError);
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
    var pSearch = $("#picker-search");
    if (pSearch) pSearch.addEventListener("input", function () { renderPicker(); });
    var pickerBg = $("#picker");
    if (pickerBg) pickerBg.addEventListener("click", function (e) { if (e.target === pickerBg) closePicker(); });
    $("#daily-save").addEventListener("click", function () {
      var v = $("#daily-time").value;
      if (!v) { toast("Укажи время."); return; }
      saveSetting({ daily_time: v }, "Напоминание включено.");
    });
    $("#daily-off").addEventListener("click", function () {
      $("#daily-time").value = "";
      saveSetting({ daily_time: null }, "Напоминание выключено.");
    });
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
