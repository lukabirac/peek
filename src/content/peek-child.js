/**
 * Peek — child bridge (runs in every frame).
 *
 * Cross-origin, the host can't read the iframe's URL, title or history, and
 * can't call history.back() on it. This script closes that gap: it stays
 * completely silent until the host addresses it by token, then reports page
 * state upward and executes navigation commands downward.
 *
 * It never speaks first, so ordinary iframes on the web see no messages
 * from us at all.
 */
(() => {
  "use strict";

  if (window.parent === window) return; // top frame has nothing to report to

  let token = null;
  let active = false;
  let lastSent = "";

  /* ─── Reporting ─────────────────────────────────────────────────────── */

  function faviconURL() {
    const links = document.querySelectorAll(
      'link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]'
    );
    let best = null;
    let bestSize = -1;
    for (const l of links) {
      if (!l.href) continue;
      const sizes = (l.getAttribute("sizes") || "").match(/(\d+)/);
      const size = sizes ? parseInt(sizes[1], 10) : l.rel.includes("apple") ? 180 : 32;
      // Prefer something in the 16–64px band; huge apple-touch icons look
      // soft when scaled down into a 15px slot.
      const score = size >= 16 && size <= 64 ? 100 - Math.abs(32 - size) : 10;
      if (score > bestSize) {
        bestSize = score;
        best = l.href;
      }
    }
    if (best) return best;
    try {
      return new URL("/favicon.ico", location.origin).href;
    } catch {
      return "";
    }
  }

  function themeColor() {
    const m = document.querySelector('meta[name="theme-color" i]');
    return m?.content || "";
  }

  function state(force) {
    if (!active) return;
    // about:blank and friends are transient scaffolding, not a page the user
    // navigated to; the host has no use for them.
    if (!/^https?:$/.test(location.protocol)) return;
    const payload = {
      __peek: "child",
      token,
      kind: "state",
      url: location.href,
      title: document.title || "",
      host: location.hostname.replace(/^www\./, ""),
      favicon: faviconURL(),
      themeColor: themeColor(),
      historyLength: history.length,
      readyState: document.readyState,
    };
    const sig = [payload.url, payload.title, payload.readyState, payload.favicon].join("|");
    if (!force && sig === lastSent) return;
    lastSent = sig;
    try {
      window.parent.postMessage(payload, "*");
    } catch {}
  }

  function tell(kind, extra) {
    if (!active) return;
    try {
      window.parent.postMessage({ __peek: "child", token, kind, ...extra }, "*");
    } catch {}
  }

  /* ─── Activation ────────────────────────────────────────────────────── */

  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.__peek !== "cmd" || typeof d.token !== "string") return;

    if (!active) {
      token = d.token;
      active = true;
      attach();
      state(true);
    }
    if (d.token !== token) return;

    switch (d.action) {
      case "init":
        state(true);
        break;
      case "back":
        history.back();
        break;
      case "forward":
        history.forward();
        break;
      case "reload":
        location.reload();
        break;
      case "focus":
        try {
          window.focus();
          if (document.activeElement === document.body) document.body?.focus?.();
        } catch {}
        break;
    }
  });

  /* ─── Instrumentation, installed only once activated ────────────────── */

  let attached = false;
  function attach() {
    if (attached) return;
    attached = true;

    // The swipe that dismisses a peek starts life over this document. If the
    // page can't scroll horizontally, the browser claims the gesture for its
    // own back-navigation and we never see a usable wheel event — so this
    // frame opts out of overscroll entirely. Scoped to the framed instance,
    // which is thrown away when the peek closes.
    try {
      document.documentElement.style.overscrollBehaviorX = "none";
    } catch {}

    document.addEventListener("readystatechange", () => state());
    window.addEventListener("load", () => state(true));
    window.addEventListener("popstate", () => setTimeout(state, 0));
    window.addEventListener("hashchange", () => setTimeout(state, 0));
    window.addEventListener("pageshow", () => state(true));

    // SPA route changes never fire a navigation event we can observe from
    // outside, so watch the History API directly.
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      if (typeof orig !== "function") continue;
      history[fn] = function (...args) {
        const r = orig.apply(this, args);
        setTimeout(state, 0);
        return r;
      };
    }

    // Titles arrive late on plenty of sites.
    const watchTitle = () => {
      const t = document.querySelector("title");
      if (!t) return;
      new MutationObserver(() => state()).observe(t, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };
    if (document.head) watchTitle();
    else document.addEventListener("DOMContentLoaded", watchTitle, { once: true });

    // Esc inside the peeked page must dismiss it, same as Esc outside.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") tell("key", { key: "Escape" });
        else if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
          tell("promote", { url: location.href });
      },
      true
    );

    // ⌘-click inside a peek means "I actually want this as a tab".
    window.addEventListener(
      "click",
      (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        const a = e.target?.closest?.("a[href]");
        if (!a || !/^https?:$/.test(a.protocol)) return;
        e.preventDefault();
        tell("open-tab", { url: a.href, active: e.shiftKey });
      },
      true
    );

    // Forward the back-swipe only when the page itself has nothing left to
    // scroll horizontally — otherwise a carousel would fight the gesture.
    window.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.4) return;
        const el = document.scrollingElement || document.documentElement;
        const canScrollLeft = el.scrollLeft > 0;
        let node = e.target;
        while (node && node !== el) {
          if (node.scrollWidth > node.clientWidth + 1 && node.scrollLeft > 0) return;
          node = node.parentElement;
        }
        if (canScrollLeft) return;
        tell("swipe", { deltaX: e.deltaX, deltaY: e.deltaY });
      },
      { capture: true, passive: true }
    );

    // Cheap safety net for anything the hooks above miss.
    setInterval(state, 900);
  }
})();
