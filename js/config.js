/*
 * MiniApp configuration.
 *
 * Set API_BASE to your deployed API origin (the VPS behind Caddy), with NO
 * trailing slash. During local development you can point it at your machine
 * and run the API with API_DEV_MODE=1.
 *
 * The MiniApp itself is static and is hosted on GitHub Pages; only this file
 * needs to change between environments.
 */
window.TAROT_CONFIG = {
  API_BASE: "https://proof-billion-explained-mens.trycloudflare.com",
  // When true, the app won't require Telegram WebApp (pairs with API_DEV_MODE=1).
  DEV: false,
};
