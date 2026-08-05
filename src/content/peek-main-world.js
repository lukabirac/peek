/**
 * Peek — main-world shim.
 *
 * Plenty of "open in a new tab" affordances never touch an <a> element; they
 * call window.open(). This patch routes those into a peek when the tab is in
 * a peek context, and otherwise leaves the original behaviour untouched.
 *
 * Real popups — anything asking for a sized window, which is what OAuth and
 * payment flows use — are deliberately left alone.
 */
(() => {
  "use strict";

  const nativeOpen = window.open;
  if (typeof nativeOpen !== "function") return;

  const eligible = () => document.documentElement?.dataset?.peekEligible === "1";

  const isPlainNavigation = (features) => {
    if (!features) return true;
    return !/\b(width|height|left|top|popup)\b/i.test(String(features));
  };

  const dispatch = (url) => {
    try {
      document.dispatchEvent(
        new CustomEvent("peek:window-open", { detail: { url: String(url) } })
      );
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Stand-in for the WindowProxy that window.open would have returned.
   * The `open blank, then assign location` pattern is common enough that the
   * stub has to handle a deferred URL.
   */
  function makeStub() {
    let done = false;
    const fire = (url) => {
      if (done || !url) return;
      done = true;
      dispatch(url);
    };
    const locationProxy = {
      set href(v) {
        fire(v);
      },
      get href() {
        return "";
      },
      assign: fire,
      replace: fire,
      toString: () => "",
    };
    return {
      get location() {
        return locationProxy;
      },
      set location(v) {
        fire(typeof v === "string" ? v : v?.href);
      },
      closed: false,
      opener: window,
      focus() {},
      blur() {},
      close() {
        this.closed = true;
      },
      postMessage() {},
      get document() {
        return null;
      },
    };
  }

  window.open = function (url, target, features) {
    try {
      if (
        eligible() &&
        isPlainNavigation(features) &&
        (!target || target === "_blank" || target === "")
      ) {
        const href = url ? String(url) : "";
        if (!href) return makeStub(); // location assigned later
        if (/^https?:/i.test(href) || href.startsWith("/") || !/^[a-z]+:/i.test(href)) {
          const abs = new URL(href, location.href).href;
          if (/^https?:/i.test(abs) && dispatch(abs)) return makeStub();
        }
      }
    } catch {
      /* fall through to the real thing */
    }
    return nativeOpen.apply(window, arguments);
  };

  // Keep the patch looking untouched to feature-detection code.
  try {
    window.open.toString = () => nativeOpen.toString();
  } catch {}
})();
