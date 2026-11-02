// What the page says when the game's files do not come. index.html loads this small plain file right after the game's own
// script (the Content Security Policy allows no inline script), and the browser runs the two in that order. So when this
// file runs, main.ts has either run (it sets `data-boot="ready"` on <html>) or failed: a file of the game did not load, or
// its start broke.
//
// The waiting itself needs no script: index.html's Play key says "Loading…", and style.css shows "Still loading. Your
// connection is slow." after 8 s and a "Try again" link after 30 s (--boot-slow, --boot-stall).
//
// A file that failed is either a network fault or an old page after a deploy (its files are gone). This file asks the server
// for the page again: when it names another game script, a new version is out ("Reload"); when it does not answer, or names
// the same script, the network is at fault ("Try again"). Both keys reload the page.
//
// After the start, a part that loads later (the emotes, a look's model, the sign-in) may fail: a small notice says so, and
// the game goes on. The next use of that part tries it again.
(function () {
  "use strict";
  var root = document.documentElement;

  function el(id) {
    return document.getElementById(id);
  }

  /** The game script this page loaded (Vite's module script). */
  function entry() {
    var s = document.querySelector('script[type="module"][src]');
    return s ? s.getAttribute("src") : null;
  }

  /** Asks the server for this page again: "new" (it names another game script: a new version), "same" or "offline". */
  function whatChanged() {
    if (!window.fetch || navigator.onLine === false) return Promise.resolve("offline");
    return fetch(location.pathname + "?boot-check=" + Date.now(), { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) return "offline";
        return res.text().then(function (html) {
          var m = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
          var mine = entry();
          return m && mine && m[1] !== mine ? "new" : "same";
        });
      })
      .catch(function () {
        return "offline";
      });
  }

  function reload() {
    location.reload();
  }

  function has3d() {
    try {
      var c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (e) {
      return false;
    }
  }

  /** The start card's note and its key, in place of Play. */
  function show(text, key) {
    var note = el("boot-note");
    var btn = el("boot-retry");
    if (note) {
      note.textContent = text;
      note.hidden = false;
    }
    if (btn) {
      btn.textContent = key;
      btn.hidden = false;
      btn.onclick = reload;
    }
  }

  // ---- the game's script did not run ----
  if (root.getAttribute("data-boot") !== "ready") {
    root.setAttribute("data-boot", "failed"); // style.css: no Play key and no timed notes now
    whatChanged().then(function (what) {
      if (what === "new") show("A new version of the game is out.", "Reload");
      else if (what === "same" && !has3d()) show("This game needs 3D graphics, and this browser has them turned off.", "Try again");
      else show("The game did not load. Check your connection, then try again.", "Try again");
    });
    return;
  }

  // ---- after the start: a part that loads later did not come ----
  var asking = false;
  function partFailed() {
    if (asking) return; // one failure can come as two events (Vite's, then the import's)
    asking = true;
    whatChanged().then(function (what) {
      asking = false;
      var bar = el("boot-bar");
      var text = el("boot-bar-text");
      var key = el("boot-bar-reload");
      var close = el("boot-bar-close");
      if (!bar || !text) return;
      var fresh = what === "new";
      text.textContent = fresh ? "A new version of the game is out. Reload to get it." : "Part of the game did not load. Check your connection.";
      if (key) {
        key.hidden = !fresh;
        key.onclick = reload;
      }
      if (close)
        close.onclick = function () {
          bar.hidden = true;
        };
      bar.hidden = false;
    });
  }

  /** A failed import(): Chrome, Safari and Firefox each say it in their own words. */
  function isLoadError(reason) {
    var m = reason && (reason.message || String(reason));
    return typeof m === "string" && /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload/i.test(m);
  }

  window.addEventListener("vite:preloadError", partFailed);
  window.addEventListener("unhandledrejection", function (e) {
    if (isLoadError(e.reason)) partFailed();
  });
})();
