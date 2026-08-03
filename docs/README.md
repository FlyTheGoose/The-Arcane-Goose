# Таро MiniApp (front-end)

Статическое Telegram WebApp на чистом HTML/CSS/JS. Хостится на **GitHub Pages**,
а данные берёт из API (`tarot_bot/api.py`) на VPS.

## Файлы

```
webapp/
├─ index.html        # разметка всех экранов
├─ css/styles.css    # две темы: noir (по умолчанию) и violet
└─ js/
   ├─ config.js      # АДРЕС API — единственное, что меняется между средами
   └─ app.js         # вся логика
```

## Настройка

1. Открой `js/config.js` и укажи `API_BASE` — адрес твоего API (без слеша в конце):
   ```js
   window.TAROT_CONFIG = { API_BASE: "https://api.your-domain.tld", DEV: false };
   ```
2. Залей папку `webapp/` в репозиторий и включи **GitHub Pages** (Settings → Pages → Deploy from branch).
3. В [@BotFather](https://t.me/BotFather) → `/setmenubutton` (или Bot Settings → Menu Button) укажи URL страницы GitHub Pages.
4. На сервере в `.env` пропиши `WEBAPP_ORIGIN=https://username.github.io` (тот же origin, без пути) — это CORS.

## Авторизация

Приложение отправляет `Telegram.WebApp.initData` в заголовке `Authorization: tma <initData>`.
Сервер проверяет подпись (HMAC-SHA256 по `BOT_TOKEN`). Никаких секретов во front-end нет.

## Локальная разработка

Запусти API с `API_DEV_MODE=1` (пропускает проверку Telegram) и открой `index.html` через любой
статический сервер, например:
```bash
cd webapp && python -m http.server 5173
```
Укажи в `config.js` локальный `API_BASE` (напр. `http://localhost:8080`) и добавь этот origin в `WEBAPP_ORIGIN`.

## Колоды / PNG

Карты рисуются как emoji-заглушки, но если для колоды есть PNG на сервере
(`tarot_bot/assets/cards/<deck>/<card_id>.png`, 360×540) — он автоматически подтягивается
через `/api/card-image/<deck>/<card_id>`. Ничего менять во front-end не нужно.
