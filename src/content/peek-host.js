/**
 * Peek — host controller (top frame only).
 *
 * Owns the overlay, the trigger rules, and the lifecycle of a peek. The
 * peeked document itself lives in an iframe and talks back to us through
 * peek-child.js, which is how we know its URL, title and history depth
 * across the origin boundary.
 *
 * Load order matters: peek-styles.js and peek-icons.js populate the shared
 * isolated-world namespace before this file runs.
 */
(() => {
  "use strict";

  if (window.top !== window) return; // host lives only in the top frame
  const NS = (globalThis.__PEEK__ = globalThis.__PEEK__ || {});
  if (NS.host) return; // survive double-injection (dev reloads)

  const SHEET = NS.CSS;
  const ICONS = NS.ICONS;

  /* ─── Settings ──────────────────────────────────────────────────────── */

  const DEFAULTS = {
    enabled: true,
    onPinnedTabs: true, // Arc's canonical trigger
    modifier: "shift", // 'shift' | 'alt' | 'none' — peek any link
    peekNewTabLinks: true, // target=_blank / window.open from eligible tabs
    prefetch: true, // warm the document on pointerdown
    allowlist: [], // extra hosts treated like a pinned tab
    reducedEffects: false, // drop backdrop blur on weak GPUs
    dismissOnSwipe: true,
    swipeDirection: "right", // 'right' | 'left' — which way you swipe, and go
    naturalScrolling: true, // does a rightward swipe report a negative deltaX?
    swipeSensitivity: 1, // 0.5 deliberate … 2 twitchy
    splitMode: "sidePanel", // 'sidePanel' | 'window'
  };

  let settings = { ...DEFAULTS };
  let ctxPinned = false;
  let ctxReady = false;
  // The split button has to call chrome.sidePanel.open() from an extension
  // frame, and that frame needs to be told which tab it is decorating.
  let ctxTabId = null;

  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension context invalidated
    }
  };

  send({ type: "peek:hello" }).then((res) => {
    if (res) {
      settings = { ...DEFAULTS, ...(res.settings || {}) };
      ctxPinned = !!res.pinned;
      ctxTabId = typeof res.tabId === "number" ? res.tabId : null;
    }
    ctxReady = true;
    publishEligibility();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes.settings) return;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    });
  } catch {}

  /* ─── Helpers ───────────────────────────────────────────────────────── */

  const PEEKABLE = /^https?:$/;

  /**
   * The header-stripping rule has to exist before the frame's request goes
   * out, so every path that loads a peek waits on this. It's requested as
   * early as pointerdown, so by click time it's almost always already settled
   * and costs nothing.
   */
  let armPromise = null;
  function ensureArmed() {
    if (!armPromise) armPromise = send({ type: "peek:arm" });
    return armPromise;
  }
  function forgetArmed() {
    armPromise = null;
  }

  function parseURL(href) {
    try {
      return new URL(href, location.href);
    } catch {
      return null;
    }
  }

  /**
   * Does this URL point at the document we're already looking at?
   *
   * The fragment is deliberately not part of the test. `href="#"` — the usual
   * markup for a JS-driven button — parses to an empty hash, so keying on
   * "has a fragment" lets exactly the most common case through, and peeking
   * the page you are standing on is never what anyone wanted.
   */
  function isSamePageAnchor(url) {
    return (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search
    );
  }

  function hostAllowlisted() {
    if (!settings.allowlist || !settings.allowlist.length) return false;
    const h = location.hostname.replace(/^www\./, "").toLowerCase();
    return settings.allowlist.some((raw) => {
      const p = String(raw).trim().replace(/^www\./, "").toLowerCase();
      if (!p) return false;
      return h === p || h.endsWith("." + p);
    });
  }

  /** Is this tab one where a plain click should peek? (Arc: pinned tabs.) */
  function tabIsPeekContext() {
    return (settings.onPinnedTabs && ctxPinned) || hostAllowlisted();
  }

  function modifierHeld(e) {
    switch (settings.modifier) {
      case "shift":
        return e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
      case "alt":
        return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
      default:
        return false;
    }
  }

  /** Chrome's own chords keep their meaning; we never shadow them. */
  function isBrowserChord(e) {
    return e.metaKey || e.ctrlKey || e.button === 1;
  }

  function anchorFrom(event) {
    const path = event.composedPath ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLAnchorElement && node.href) return node;
      if (node instanceof SVGAElement && node.href?.baseVal) return node;
      if (node === document.body) break;
    }
    return event.target?.closest?.("a[href]") || null;
  }

  /**
   * Decide whether a click should become a peek.
   * Returns the resolved URL, or null to let the browser do its normal thing.
   */
  function resolveTrigger(event) {
    if (!settings.enabled || !ctxReady) return null;
    if (event.defaultPrevented) return null;
    if (event.button !== 0) return null;

    const a = anchorFrom(event);
    if (!a) return null;
    if (a.hasAttribute("download")) return null;

    const href = a instanceof SVGAElement ? a.href.baseVal : a.getAttribute("href");
    if (!href || href.startsWith("#")) return null;

    const url = parseURL(a instanceof SVGAElement ? a.href.baseVal : a.href);
    if (!url || !PEEKABLE.test(url.protocol)) return null;
    if (isSamePageAnchor(url)) return null;

    const byModifier = modifierHeld(event);
    if (byModifier) return url.href;

    if (isBrowserChord(event)) return null; // ⌘-click still means new tab
    if (!tabIsPeekContext()) return null;

    // In a peek context, a _blank link is exactly the case Peek exists for.
    if (a.target && a.target !== "_self" && !settings.peekNewTabLinks) return null;

    return url.href;
  }

  /* ─── The overlay ───────────────────────────────────────────────────── */

  const ORIGIN_CLAMP = [8, 92];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Swipe-to-dismiss commit points, in panel pixels and px/ms. All are tested
  // during the gesture rather than after it — see _wheel. A fling carries its
  // own floor: however fast the flick, the panel has to have actually moved,
  // or one sharp wheel tick would throw the peek away.
  const SWIPE_COMMIT_PX = 118;
  const SWIPE_FLING_V = 0.9;
  const SWIPE_FLING_MIN_PX = 46;
  // The pane is fully faded by ~2.7× the commit distance. Held as a ratio so
  // the fade keeps pace when sensitivity moves the threshold — otherwise a
  // twitchy setting would dismiss while the pane still looked barely touched.
  const SWIPE_FADE_RATIO = 320 / SWIPE_COMMIT_PX;

  /** Higher is twitchier: it divides every threshold, it doesn't scale motion. */
  const sensitivity = () => {
    const s = Number(settings.swipeSensitivity);
    return Number.isFinite(s) && s > 0 ? clamp(s, 0.5, 2) : 1;
  };

  /*
   * Two independent signs, because a swipe has two independent questions.
   *
   *   dismissSign  which way you physically move your fingers to dismiss,
   *                and therefore which way the pane is thrown, since it
   *                should always travel with your hand and not against it.
   *
   *   naturalSign  the deltaX a physical *rightward* swipe actually reports.
   *                Natural scrolling inverts it, and no API tells us which
   *                way round the user has it — so it has to be asked.
   *
   * Collapsing these into one sign is what made the gesture feel wrong for
   * anyone with natural scrolling off: whichever direction they picked, the
   * pane ran opposite their fingers, because the deltaX they produce is the
   * opposite of the one the single sign assumed.
   */
  const dismissSign = () => (settings.swipeDirection === "left" ? -1 : 1);
  const naturalSign = () => (settings.naturalScrolling === false ? 1 : -1);

  class Peek {
    constructor() {
      // The peek keeps its own session history, entirely separate from the
      // tab's. Rebuilt from what the child reports, since we can't read the
      // frame's history object across origins.
      this.entries = [];
      this.idx = -1;
      this.navIntent = null; // 'back' | 'forward' | null
      this.current = null; // { url, title, host, favicon }
      this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.state = "idle"; // idle | priming | open | closing
      // dialog.close() queues its "close" event rather than firing it inline,
      // so intent has to be tracked with a counter, not a flag that would be
      // reset before the event is ever delivered.
      this.ignoreClose = 0;
      this.handshook = false;
      this.drag = null;
      this._build();
    }

    /* ---- construction ---------------------------------------------- */

    _build() {
      this.mount = document.createElement("peek-root");
      // The host element itself must be inert to the page's own layout/CSS.
      this.mount.setAttribute(
        "style",
        "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none"
      );
      this.shadow = this.mount.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = SHEET;
      this.shadow.append(style);

      const root = document.createElement("div");
      root.className = "root";
      root.dataset.scheme = matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      root.dataset.reducedEffects = settings.reducedEffects ? "1" : "0";
      this.root = root;

      const dlg = document.createElement("dialog");
      // Inert until revealed: a primed peek must not take focus from the page
      // (dialog.show() would otherwise focus straight into it) and must not be
      // reachable by pointer or keyboard.
      dlg.inert = true;
      this.dlg = dlg;

      const panel = document.createElement("div");
      panel.className = "panel";
      this.panel = panel;

      panel.append(this._pane(), this._rail());
      dlg.append(panel);
      root.append(dlg);
      this.shadow.append(root);

      // documentElement, not body: pages transform <body> often enough that a
      // fixed child would get trapped in the wrong containing block.
      document.documentElement.append(this.mount);

      this._wire();
    }

    /**
     * The only chrome in a peek: three round buttons on the scrim, just
     * outside the pane's top-right corner. No toolbar, no title, no URL —
     * the pane is the page and nothing else.
     */
    _rail() {
      const rail = document.createElement("div");
      rail.className = "rail";

      const orb = (act, icon, tip) => {
        const b = document.createElement("button");
        b.className = "orb";
        b.type = "button";
        b.dataset.act = act;
        b.dataset.tip = tip;
        b.setAttribute("aria-label", tip);
        b.innerHTML = icon;
        return b;
      };

      this.btnClose = orb("close", ICONS.close, "Close");
      this.btnPromote = orb("promote", ICONS.promote, "Open as Tab");

      rail.append(this.btnClose, this.btnPromote, this._splitSlot());
      return rail;
    }

    /**
     * The split button, alone among the three, cannot be an ordinary button:
     * chrome.sidePanel.open() demands live user activation, and activation is
     * gone by the time a content script's message reaches the worker. So the
     * button is an extension document laid into the rail, and the click is
     * handled inside it. The shadow-DOM orb behind it is what shows if that
     * frame never loads — it routes through the worker and degrades to opening
     * the page in a tab beside this one.
     */
    _splitSlot() {
      const slot = document.createElement("div");
      slot.className = "orb-slot";
      slot.dataset.tip = "Split with This Tab";
      slot.dataset.frame = "loading";
      this.splitSlot = slot;

      const stand = document.createElement("button");
      stand.className = "orb";
      stand.type = "button";
      stand.dataset.act = "split";
      stand.setAttribute("aria-label", "Split with This Tab");
      stand.innerHTML = ICONS.split;
      slot.append(stand);

      let url = "";
      try {
        url = chrome.runtime.getURL("src/rail/split-button.html");
      } catch {
        slot.dataset.frame = "failed"; // extension context invalidated
        return slot;
      }

      const frame = document.createElement("iframe");
      frame.className = "orb-frame";
      frame.setAttribute("aria-label", "Split with This Tab");
      frame.setAttribute("scrolling", "no");
      frame.src =
        url +
        "?tab=" +
        encodeURIComponent(ctxTabId ?? "") +
        "&scheme=" +
        (this.root.dataset.scheme === "dark" ? "dark" : "light") +
        "&reduced=" +
        (settings.reducedEffects ? "1" : "0");
      this.splitFrame = frame;
      slot.append(frame);

      // If the frame never says hello — blocked resource, wrong browser — the
      // stand-in stays and nothing about the rail looks different.
      this._railT = setTimeout(() => {
        if (slot.dataset.frame === "loading") slot.dataset.frame = "failed";
      }, 1500);

      return slot;
    }

    /** Keep the split frame pointed at whatever the peek is currently showing. */
    _tellRail(url) {
      if (!this.splitFrame || this.splitSlot?.dataset.frame !== "ready") return;
      try {
        this.splitFrame.contentWindow?.postMessage({ __peekRailCmd: "url", url }, "*");
      } catch {}
    }

    _pane() {
      const stage = document.createElement("div");
      stage.className = "pane";

      this.frame = document.createElement("iframe");
      this.frame.className = "frame";
      this.frame.setAttribute("allow", "clipboard-write; fullscreen; picture-in-picture");
      this.frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");

      this.loader = document.createElement("div");
      this.loader.className = "loader";
      this.loader.innerHTML = '<div class="spinner"></div>';

      this.fallback = document.createElement("div");
      this.fallback.className = "fallback";
      this.fallback.innerHTML =
        '<h2><span class="who">This site</span> won’t load in a Peek</h2>' +
        "<p>It refuses to be embedded, so there’s nothing to preview here. " +
        "Opening it as a tab works normally.</p>";
      this.fbCta = document.createElement("button");
      this.fbCta.className = "cta";
      this.fbCta.type = "button";
      this.fbCta.textContent = "Open in New Tab";
      this.fallback.append(this.fbCta);

      stage.append(this.frame, this.loader, this.fallback);
      return stage;
    }

    /* ---- events ------------------------------------------------------ */

    _wire() {
      this.panel.addEventListener("click", (e) => {
        const b = e.target.closest?.("button.orb");
        if (!b) return;
        e.preventDefault();
        e.stopPropagation();
        this._act(b.dataset.act);
      });

      this.fbCta.addEventListener("click", () => this.promote());

      // Clicking the scrim dismisses. A modal dialog reports backdrop clicks
      // as clicks on the dialog itself, so anything outside .panel is scrim.
      this.dlg.addEventListener("pointerdown", (e) => {
        if (!e.composedPath().includes(this.panel)) this._scrimArmed = true;
      });
      this.dlg.addEventListener("pointerup", (e) => {
        if (this._scrimArmed && !e.composedPath().includes(this.panel)) this.close();
        this._scrimArmed = false;
      });

      this.dlg.addEventListener("cancel", (e) => {
        e.preventDefault(); // we animate our own dismissal
        this.close();
      });
      // Safety net for a close we didn't initiate (e.g. the element being
      // detached by the page). Our own closes are accounted for first.
      this.dlg.addEventListener("close", () => {
        if (this.ignoreClose > 0) return void this.ignoreClose--;
        this._teardown();
      });

      this.dlg.addEventListener("keydown", (e) => this._key(e), true);

      this.frame.addEventListener("load", () => this._onFrameLoad());

      if (settings.dismissOnSwipe) {
        this.dlg.addEventListener("wheel", (e) => this._wheel(e.deltaX, e.deltaY), {
          passive: true,
        });
      }

      this._onMsg = (e) => this._message(e);
      window.addEventListener("message", this._onMsg);
    }

    _act(action) {
      switch (action) {
        case "split":
          this._splitFallback();
          break;
        case "promote":
          this.promote();
          break;
        case "close":
          this.close();
          break;
      }
    }

    _key(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (meta && (e.key === "Enter" || e.key.toLowerCase() === "o")) {
        e.preventDefault();
        this.promote();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        this.copyLink();
      } else if ((meta && e.key === "[") || (e.altKey && e.key === "ArrowLeft")) {
        e.preventDefault();
        this.back();
      } else if ((meta && e.key === "]") || (e.altKey && e.key === "ArrowRight")) {
        e.preventDefault();
        this.forward();
      } else if (meta && e.key.toLowerCase() === "r") {
        e.preventDefault();
        this._toChild({ action: "reload" });
      }
    }

    /* ---- child bridge ------------------------------------------------ */

    _toChild(payload) {
      try {
        this.frame.contentWindow?.postMessage(
          { __peek: "cmd", token: this.token, ...payload },
          "*"
        );
      } catch {}
    }

    _message(e) {
      if (this.splitFrame && e.source === this.splitFrame.contentWindow) {
        return this._railMessage(e.data);
      }
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const d = e.data;
      if (!d || d.__peek !== "child" || d.token !== this.token) return;

      switch (d.kind) {
        case "state":
          // The iframe's initial about:blank reports before the real document
          // commits; recording it would put a phantom entry underneath the
          // first page and stop back-at-root from dismissing.
          if (!/^https?:/.test(d.url || "")) break;
          this.handshook = true;
          this._applyState(d);
          break;
        case "key":
          if (d.key === "Escape") this.close();
          break;
        case "swipe":
          this._wheel(d.deltaX, d.deltaY);
          break;
        case "open-tab":
          send({ type: "peek:open-tab", url: d.url, active: !!d.active });
          break;
        case "promote":
          this.promote(d.url);
          break;
      }
    }

    _railMessage(d) {
      if (!d || typeof d.__peekRail !== "string") return;
      switch (d.__peekRail) {
        case "ready":
          clearTimeout(this._railT);
          this.splitSlot.dataset.frame = "ready";
          this._tellRail(this.url());
          break;
        case "split-ok":
          // The panel is up; the peek has served its purpose.
          this.close({ from: "split" });
          break;
        case "split-fallback":
          this._splitFallback();
          break;
        case "hover":
          this.splitSlot.dataset.hover = d.on ? "1" : "0";
          break;
        case "key":
          if (d.key === "Escape") this.close();
          break;
      }
    }

    _applyState(d) {
      this.current = {
        url: d.url,
        title: d.title || "",
        host: d.host || "",
        favicon: d.favicon || "",
      };

      if (d.url && this.entries[this.idx] !== d.url) {
        this._recordNav(d.url);
        // Keep the side panel aimed at whatever the peek is showing, so a
        // split fires without waiting on a round trip.
        send({ type: "peek:current", url: d.url });
        this._tellRail(d.url);
      }

      // Title and favicon are still tracked — promote and copy need the live
      // URL, and the stack needs the navigations — they just aren't drawn.

      if (d.readyState !== "loading") {
        this.frame.dataset.painted = "1";
        this.loader.dataset.on = "0";
        clearTimeout(this._loaderT);
      }
      // A child that reports at all is by definition embedded, so retract any
      // "can't be previewed" state — it would otherwise sit on top of a
      // perfectly live page and swallow every click meant for it.
      clearTimeout(this._blockedT);
      if (this.fallback.dataset.on === "1") this.fallback.dataset.on = "0";
    }

    /** Fold a reported URL into the peek's own history stack. */
    _recordNav(url) {
      if (this.navIntent === "back" && this.entries[this.idx - 1] === url) {
        this.idx--;
      } else if (this.navIntent === "forward" && this.entries[this.idx + 1] === url) {
        this.idx++;
      } else {
        // A fresh navigation truncates anything ahead of us, exactly as a
        // real session history would.
        this.entries = this.entries.slice(0, this.idx + 1);
        this.entries.push(url);
        this.idx = this.entries.length - 1;
      }
      this.navIntent = null;
    }

    _onFrameLoad() {
      if (this._gone) return;
      // A freshly created iframe fires load for its initial about:blank before
      // we've even set src. Treating that as a committed document would start
      // the "can't be embedded" countdown against a document that was never
      // asked to load anything.
      if (!this.frame.src || this.frame.src === "about:blank") return;
      // Every committed document is a new child that has to be greeted again.
      this.handshook = false;
      this._toChild({ action: "init" });
      let tries = 0;
      clearInterval(this._initI);
      this._initI = setInterval(() => {
        if (this.handshook || ++tries > 12) return clearInterval(this._initI);
        this._toChild({ action: "init" });
      }, 40);

      // No handshake after a committed load almost always means the frame is
      // showing Chrome's "refused to connect" error page.
      clearTimeout(this._blockedT);
      this._blockedT = setTimeout(() => {
        if (!this.handshook) this._blocked();
      }, 700);
    }

    _blocked() {
      this.fallback.dataset.on = "1";
      this.loader.dataset.on = "0";
      const host = this.fallback.querySelector(".who");
      if (host) host.textContent = this.pendingHost || "This site";
    }

    /* ---- lifecycle --------------------------------------------------- */

    /** Start loading before the click completes. Nothing is shown yet. */
    prime(url) {
      const u = parseURL(url);
      this.pendingURL = url;
      this.pendingHost = u ? u.hostname.replace(/^www\./, "") : "";

      send({ type: "peek:current", url });
      this._tellRail(url);

      this.state = "priming";
      this.root.dataset.priming = "1";
      // Non-modal show: the frame renders and paints while still invisible and
      // inert, so the reveal is a compositor swap rather than a first paint.
      try {
        if (!this.dlg.open) this.dlg.show();
      } catch {}
      ensureArmed().then(() => {
        if (this._gone) return;
        this.frame.src = url;
      });
    }

    /** Reveal the primed peek, growing from the point that was clicked. */
    reveal(originPoint) {
      if (this.state === "open") return;
      this.state = "open";
      this.root.dataset.priming = "0";
      this.dlg.inert = false;

      try {
        if (this.dlg.open) {
          this.ignoreClose++;
          this.dlg.close();
        }
        this.dlg.showModal();
      } catch {
        this.dlg.setAttribute("open", ""); // <dialog> unsupported: degrade
      }

      lockScroll(true);

      const r = this.panel.getBoundingClientRect();
      if (originPoint) {
        const ox = clamp(((originPoint.x - r.left) / r.width) * 100, ...ORIGIN_CLAMP);
        const oy = clamp(((originPoint.y - r.top) / r.height) * 100, ...ORIGIN_CLAMP);
        this.panel.style.setProperty("--origin-x", ox + "%");
        this.panel.style.setProperty("--origin-y", oy + "%");
      }

      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const S = getComputedStyle(this.root);
      const spring = S.getPropertyValue("--spring").trim() || "ease-out";
      const easeOut = S.getPropertyValue("--ease-out").trim() || "ease-out";
      const dur = reduce ? 130 : parseFloat(S.getPropertyValue("--dur-open")) || 440;

      const grow = this.panel.animate(
        [
          { transform: "scale(0.955) translateY(10px)" },
          { transform: "scale(1) translateY(0)" },
        ],
        { duration: dur, easing: reduce ? easeOut : spring, fill: "none" }
      );
      this.panel.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: Math.min(200, dur),
        easing: easeOut,
        fill: "none",
      });
      grow.finished.then(() => (this.panel.style.willChange = "auto")).catch(() => {});

      this._animateBackdrop(true, reduce ? 120 : 300, easeOut);

      this.frame.focus?.();
      setTimeout(() => this._toChild({ action: "focus" }), 60);

      clearTimeout(this._loaderT);
      this._loaderT = setTimeout(() => {
        if (!this.handshook && this.fallback.dataset.on !== "1")
          this.loader.dataset.on = "1";
      }, 420);

    }

    _animateBackdrop(inward, duration, easing) {
      const dark = this.root.dataset.scheme === "dark";
      const to = dark ? "rgba(0,0,0,0.44)" : "rgba(20,20,24,0.26)";
      const from = dark ? "rgba(0,0,0,0)" : "rgba(20,20,24,0)";
      const blur = settings.reducedEffects
        ? ["none", "none"]
        : ["blur(0px) saturate(100%)", "blur(18px) saturate(112%)"];
      const kf = [
        { backgroundColor: from, backdropFilter: blur[0], opacity: 0 },
        { backgroundColor: to, backdropFilter: blur[1], opacity: 1 },
      ];
      try {
        this.dlg.animate(inward ? kf : kf.slice().reverse(), {
          duration,
          easing,
          pseudoElement: "::backdrop",
          fill: "both",
        });
      } catch {}
    }

    /* ---- gestures ---------------------------------------------------- */

    _wheel(dx, dy) {
      if (!settings.dismissOnSwipe || this.state !== "open") return;
      if (Math.abs(dx) < Math.abs(dy) * 1.4) return; // vertical scroll wins

      // Distance travelled along the dismiss axis, whichever way that points.
      const dir = dismissSign();
      const travel = dx * naturalSign() * dir;
      if (!this.drag && travel < 2) return;

      if (!this.drag) {
        this.drag = { x: 0, last: performance.now(), v: 0, n: 0 };
        this.panel.dataset.dragging = "1";
        this.panel.style.willChange = "transform, opacity";
      }
      const now = performance.now();
      const dt = now - this.drag.last;
      this.drag.n++;
      // The first event of a gesture has no interval to divide by, and
      // travel/~0ms is an enormous number that would read as a fling from a
      // standing start. Velocity only means anything from the second sample on.
      if (this.drag.n > 1) this.drag.v = travel / Math.max(1, dt);
      this.drag.last = now;
      this.drag.x = Math.max(0, this.drag.x + travel);

      const sens = sensitivity();
      const commitPx = SWIPE_COMMIT_PX / sens;

      const resisted = Math.pow(this.drag.x, 0.86) * 1.6;
      const progress = clamp(resisted / (commitPx * SWIPE_FADE_RATIO), 0, 1);
      this.panel.style.transform =
        `translateX(${resisted * dir}px) scale(${1 - progress * 0.03})`;
      this.panel.style.opacity = String(1 - progress * 0.35);

      // Commit the moment the gesture earns it, rather than when the events
      // stop arriving. macOS keeps delivering momentum wheel events for a few
      // hundred ms after the fingers lift, and every one of them pushed the
      // decision further out — so the panel hung at the end of the swipe,
      // already past the threshold, waiting for physics that had nothing left
      // to say. Deciding here also means the exit inherits the speed the
      // finger had instead of restarting from rest.
      // Both commits require more than one event. A trackpad swipe is dozens
      // of them; a mouse's horizontal tilt-wheel is exactly one, and a single
      // notch arrives scaled to ~150px — enough, on its own, to clear the
      // distance threshold and throw away a peek nobody meant to dismiss.
      const travelled = this.drag.n > 1 && resisted > commitPx;
      const flung =
        this.drag.n > 2 &&
        this.drag.v > SWIPE_FLING_V / sens &&
        resisted > SWIPE_FLING_MIN_PX / sens;
      if (travelled || flung) {
        const velocity = this.drag.v;
        clearTimeout(this._dragT);
        this.drag = null;
        this.panel.dataset.dragging = "0";
        this.close({ from: "swipe", velocity });
        return;
      }

      clearTimeout(this._dragT);
      this._dragT = setTimeout(() => this._wheelEnd(), 90);
    }

    /** Only ever the snap-back now — a committed swipe never reaches here. */
    _wheelEnd() {
      if (!this.drag) return;
      this.drag = null;
      this.panel.dataset.dragging = "0";

      const S = getComputedStyle(this.root);
      const spring = S.getPropertyValue("--spring").trim() || "ease-out";
      const a = this.panel.animate(
        [
          { transform: this.panel.style.transform, opacity: this.panel.style.opacity },
          { transform: "none", opacity: 1 },
        ],
        { duration: 420, easing: spring, fill: "none" }
      );
      a.finished
        .then(() => {
          this.panel.style.transform = "";
          this.panel.style.opacity = "";
          this.panel.style.willChange = "auto";
        })
        .catch(() => {});
    }

    /* ---- actions ----------------------------------------------------- */

    url() {
      return this.current?.url || this.pendingURL || "";
    }

    back() {
      // Back at the root of the peek's own stack dismisses it, rather than
      // dead-ending on a disabled button.
      if (this.idx <= 0) return this.close();
      this.navIntent = "back";
      this._toChild({ action: "back" });
    }

    forward() {
      if (this.idx >= this.entries.length - 1) return;
      this.navIntent = "forward";
      this._toChild({ action: "forward" });
    }

    /** No button for this any more — ⌘⇧C only, as in Arc. */
    async copyLink() {
      const u = this.url();
      if (!u) return;
      try {
        await navigator.clipboard.writeText(u);
      } catch {}
    }

    /**
     * Only reached when the extension frame couldn't do the job. The worker
     * has no user activation to spend, so the side panel is out of reach from
     * here; it puts the page in a tab beside this one instead.
     */
    _splitFallback() {
      const u = this.url();
      if (!u) return;
      send({ type: "peek:split", url: u });
      this.close({ from: "split" });
    }

    /** The one action that creates persistent state. */
    promote(explicitURL) {
      const u = explicitURL || this.url();
      if (!u) return;
      // Fire first so the tab appears with no perceptible delay; the morph
      // plays underneath in case focus stays on this tab.
      send({ type: "peek:promote", url: u });
      this._morphOut();
    }

    _morphOut() {
      if (this.state === "closing") return;
      this.state = "closing";
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const S = getComputedStyle(this.root);
      const easeOut = S.getPropertyValue("--ease-out").trim() || "ease-out";
      const dur = reduce ? 110 : 260;

      // Expand toward full-bleed: "this layer became the page".
      const r = this.panel.getBoundingClientRect();
      const sx = innerWidth / r.width;
      const sy = innerHeight / r.height;
      const s = Math.min(Math.max(sx, sy), 1.14);

      this.panel.animate(
        [
          { transform: "none", opacity: 1, borderRadius: "12px" },
          { transform: `scale(${s})`, opacity: 0, borderRadius: "0px" },
        ],
        { duration: dur, easing: easeOut, fill: "forwards" }
      );
      this._animateBackdrop(false, dur, easeOut);
      setTimeout(() => this._teardown(), dur);
    }

    close(opts = {}) {
      if (this.state === "closing") return;
      const wasOpen = this.state === "open";
      this.state = "closing";

      if (!wasOpen) return this._teardown();

      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const S = getComputedStyle(this.root);
      const easeIn = S.getPropertyValue("--ease-in").trim() || "ease-in";
      const easeOut = S.getPropertyValue("--ease-out").trim() || "ease-out";
      const dur = reduce ? 100 : parseFloat(S.getPropertyValue("--dur-close")) || 190;

      const swipe = opts.from === "swipe";
      const start = this.panel.style.transform || "none";
      const end = swipe
        ? `translateX(${dismissSign() * Math.max(innerWidth * 0.5, 420)}px) scale(0.94)`
        : "scale(0.975) translateY(6px)";

      // A swipe exit continues a motion that is already underway, so it has to
      // decelerate out of it. Easing *in* — correct for a dismissal that starts
      // from rest — reads as the panel stalling before it finally leaves. The
      // harder the fling, the less time it should spend in the air.
      const easing = swipe ? easeOut : easeIn;
      const duration = reduce
        ? dur
        : swipe
          ? clamp(250 - (opts.velocity || 0) * 55, 150, 250)
          : dur;

      const a = this.panel.animate(
        [
          { transform: start, opacity: Number(this.panel.style.opacity || 1) },
          { transform: end, opacity: 0 },
        ],
        { duration, easing, fill: "forwards" }
      );
      // Same clock as the panel, or the scrim lingers after the pane has gone.
      this._animateBackdrop(false, duration, easing);
      a.finished.then(() => this._teardown()).catch(() => this._teardown());
    }

    _teardown() {
      if (this._gone) return;
      this._gone = true;
      this.state = "idle";
      clearInterval(this._initI);
      clearTimeout(this._blockedT);
      clearTimeout(this._loaderT);
      clearTimeout(this._dragT);
      clearTimeout(this._railT);
      window.removeEventListener("message", this._onMsg);
      lockScroll(false);
      try {
        if (this.dlg.open) {
          this.ignoreClose++;
          this.dlg.close();
        }
      } catch {}
      this.frame.src = "about:blank";
      this.mount.remove();
      // Only the live peek owns the arming; a discarded prime must not
      // disarm the peek that replaced it.
      if (current === this || !current) {
        forgetArmed();
        send({ type: "peek:disarm" });
      }
      if (current === this) current = null;
    }
  }

  /* ─── Scroll lock ───────────────────────────────────────────────────── */

  let savedOverflow = null;
  let savedOverscroll = null;
  function lockScroll(on) {
    const el = document.documentElement;
    if (on) {
      if (savedOverflow !== null) return;
      savedOverflow = el.style.overflow;
      savedOverscroll = el.style.overscrollBehaviorX;
      el.style.overflow = "hidden";
      // A locked root can't consume a horizontal swipe, and unconsumed scroll
      // is what macOS Chromium turns into a back-navigation gesture — which
      // would eat the swipe-to-dismiss before it ever reaches us.
      el.style.overscrollBehaviorX = "none";
    } else if (savedOverflow !== null) {
      el.style.overflow = savedOverflow;
      el.style.overscrollBehaviorX = savedOverscroll || "";
      savedOverflow = null;
      savedOverscroll = null;
    }
  }

  /* ─── Orchestration ─────────────────────────────────────────────────── */

  let current = null; // the live peek (only ever one, as in Arc)
  let primed = null; // { peek, url, anchor } warmed on pointerdown

  function discardPrimed() {
    if (!primed) return;
    clearTimeout(primed.timer);
    if (primed.peek.state === "priming") primed.peek._teardown();
    primed = null;
  }

  function openPeek(url, originPoint) {
    if (current) {
      current._teardown();
      current = null;
    }
    let peek;
    if (primed && primed.url === url && primed.peek.state === "priming") {
      peek = primed.peek;
      primed = null;
    } else {
      discardPrimed();
      peek = new Peek();
      peek.prime(url);
    }
    current = peek;
    peek.reveal(originPoint);
    return peek;
  }

  /* ---- trigger: prefetch on pointerdown ------------------------------ */

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!settings.prefetch || current) return;
      if (e.button !== 0) return;
      const url = resolveTrigger(e);
      if (!url) return;
      if (primed && primed.url === url) return;
      discardPrimed();
      ensureArmed();
      const peek = new Peek();
      peek.prime(url);
      primed = { peek, url, at: performance.now() };
      // If the click never lands, don't leave a hidden document running.
      clearTimeout(primed.timer);
      primed.timer = setTimeout(discardPrimed, 12000);
    },
    true
  );

  document.addEventListener(
    "pointercancel",
    () => discardPrimed(),
    true
  );

  /* ---- trigger: the click itself ------------------------------------- */

  document.addEventListener(
    "click",
    (e) => {
      const url = resolveTrigger(e);
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      ensureArmed();
      openPeek(url, { x: e.clientX, y: e.clientY });
    },
    true
  );

  /* ---- trigger: window.open / _blank from the main world ------------- */

  let lastEligible = null;
  function publishEligibility() {
    const on =
      settings.enabled && settings.peekNewTabLinks && tabIsPeekContext() ? "1" : "0";
    // Only touch the attribute when it actually changes — pages with mutation
    // observers on <html> shouldn't be woken up once a second for nothing.
    if (on === lastEligible) return;
    lastEligible = on;
    document.documentElement.dataset.peekEligible = on;
  }
  const eligibilityTimer = setInterval(publishEligibility, 2000);

  document.addEventListener("peek:window-open", (e) => {
    const url = e.detail && e.detail.url;
    if (!url) return;
    const u = parseURL(url);
    if (!u || !PEEKABLE.test(u.protocol)) return;
    ensureArmed();
    openPeek(u.href, { x: innerWidth / 2, y: innerHeight / 2 });
  });

  /* ---- commands from the background worker --------------------------- */

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "peek:context":
          ctxPinned = !!msg.pinned;
          publishEligibility();
          break;
        case "peek:open":
          if (msg.url) {
            ensureArmed();
            openPeek(msg.url, lastPointer);
          }
          break;
        case "peek:promote-current":
          current?.promote();
          break;
        case "peek:close":
          current?.close();
          break;
        case "peek:hovered":
          reply?.({ url: hoveredLink() });
          return true;
        // Proof of life for the settings page: a tab that was already open
        // when Peek was installed has no content script and will not answer.
        case "peek:ping":
          reply?.({ ok: true });
          return true;
      }
    });
  } catch {}

  /* ---- hovered-link tracking (for the keyboard command) -------------- */

  let lastPointer = null;
  let lastHover = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      const a = anchorFrom(e);
      lastHover = a || null;
    },
    { capture: true, passive: true }
  );

  function hoveredLink() {
    const el = lastHover || document.activeElement?.closest?.("a[href]");
    if (!el) return null;
    if (el.hasAttribute?.("download")) return null;
    const href = el instanceof SVGAElement ? el.href.baseVal : el.href;
    const u = parseURL(href);
    if (!u || !PEEKABLE.test(u.protocol)) return null;
    // The keyboard trigger bypasses resolveTrigger, so the exclusions a click
    // gets for free have to be restated. Without this, ⌥⇧P over a table-of-
    // contents link peeks the page you are already looking at.
    if (isSamePageAnchor(u)) return null;
    return u.href;
  }

  window.addEventListener("pagehide", () => {
    clearInterval(eligibilityTimer);
    discardPrimed();
    current?._teardown();
  });

  NS.host = {
    open: (url) => openPeek(url, lastPointer),
    close: () => current?.close(),
    get current() {
      return current;
    },
    get settings() {
      return settings;
    },
  };
})();
