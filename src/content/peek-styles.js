/**
 * Peek — visual layer.
 *
 * The peek is a clean pane of the page and nothing else: no toolbar, no
 * command bar, no title. The only chrome is a rail of round buttons floating
 * on the scrim just outside the pane's top-right corner — close, promote,
 * split. The palette is deliberately monochrome: the peek's job is to show
 * somebody else's page, so nothing here should compete with it for attention.
 *
 * Everything renders inside a closed shadow root attached to a <dialog> that
 * we put in the browser's top layer via showModal(). That buys us three
 * things Arc gets for free as a native app:
 *   1. we paint above every z-index the page can invent (top layer beats all),
 *   2. the page behind becomes inert — no stray clicks, no focus theft,
 *   3. ::backdrop gives us a real scrim we can blur with the compositor.
 */
globalThis.__PEEK__ = globalThis.__PEEK__ || {};

globalThis.__PEEK__.CSS = /* css */ `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }

/* ── Design tokens ──────────────────────────────────────────────────────── */
.root {
  /* Geometry. The right inset has a hard floor because the button rail lives
     in that gutter; below it the rail moves inside the pane instead. */
  --inset-y: clamp(12px, 3.4vh, 38px);
  --inset-x: clamp(52px, 5vw, 92px);
  --max-w: 1340px;
  --radius: 12px;
  --orb: 30px;
  --rail-gap: 16px;

  /* Motion — spring curve solved from stiffness 260 / damping 26 / mass 1.
     ~1.4% overshoot: enough to feel physical, never enough to look bouncy. */
  --spring: linear(0, 0.0104, 0.0383, 0.0795, 0.1301, 0.1873, 0.2484, 0.3114,
    0.3746, 0.4367, 0.4967, 0.5539, 0.6077, 0.6577, 0.7039, 0.746, 0.7841,
    0.8184, 0.8489, 0.8759, 0.8996, 0.9201, 0.9379, 0.9531, 0.9659, 0.9767,
    0.9856, 0.9929, 0.9988, 1.0034, 1.0069, 1.0096, 1.0115, 1.0128, 1.0135,
    1.0138, 1.0138, 1.0135, 1.013, 1.0123, 1.0115, 1.0107, 1.0098, 1.009,
    1.0081, 1.0073, 1.0065, 1.0057, 1.005, 1.0043, 1.0037, 1.0032, 1.0027,
    1.0022, 1.0018, 1.0015, 1.0012, 1.0009, 1.0007, 1.0005, 1.0004, 1.0002,
    1.0001, 1, 1);
  --ease-out: cubic-bezier(0.19, 0.91, 0.28, 1);
  --ease-in: cubic-bezier(0.4, 0, 0.9, 0.35);
  --dur-open: 440ms;
  --dur-close: 190ms;

  /* Colour — light scheme. Ink and paper, no hue anywhere. */
  --ink: #101012;
  --on-ink: #ffffff;
  --surface: #ffffff;
  --orb-bg: rgba(255, 255, 255, 0.92);
  --orb-bg-hover: #ffffff;
  --orb-fg: #232326;
  --orb-ring: rgba(16, 16, 18, 0.09);
  --text: #101012;
  --text-dim: #74747c;
  --tip-bg: rgba(16, 16, 18, 0.92);
  --tip-fg: #ffffff;
  --spin: rgba(16, 16, 18, 0.55);
  --shadow:
    0 0 0 0.5px rgba(16, 16, 18, 0.12),
    0 2px 6px -1px rgba(16, 16, 18, 0.10),
    0 12px 26px -6px rgba(16, 16, 18, 0.16),
    0 40px 80px -20px rgba(16, 16, 18, 0.32);
  --orb-shadow: 0 1px 2px rgba(16, 16, 18, 0.14), 0 4px 12px -3px rgba(16, 16, 18, 0.22);

  position: fixed;
  inset: 0;
  pointer-events: none;
}

.root[data-scheme="dark"] {
  --ink: #f2f2f4;
  --on-ink: #101012;
  --surface: #141416;
  --orb-bg: rgba(38, 38, 42, 0.92);
  --orb-bg-hover: #34343a;
  --orb-fg: #ededf0;
  --orb-ring: rgba(255, 255, 255, 0.11);
  --text: #f2f2f4;
  --text-dim: #8a8a93;
  --tip-bg: rgba(242, 242, 244, 0.94);
  --tip-fg: #101012;
  --spin: rgba(255, 255, 255, 0.62);
  --shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.08),
    0 2px 6px -1px rgba(0, 0, 0, 0.34),
    0 12px 26px -6px rgba(0, 0, 0, 0.44),
    0 40px 80px -20px rgba(0, 0, 0, 0.62);
  --orb-shadow: 0 1px 2px rgba(0, 0, 0, 0.36), 0 4px 12px -3px rgba(0, 0, 0, 0.44);
}

/* ── Dialog + scrim ─────────────────────────────────────────────────────── */
dialog {
  all: unset;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  max-width: none;
  max-height: none;
  background: transparent;
  overflow: hidden;
  /* .root is pointer-events:none so the page stays live while we're priming;
     the dialog opts itself back in once it's modal. */
  pointer-events: auto;
}
/* all:unset also wipes the UA rule that hides a closed dialog, so both states
   have to be stated explicitly. The panel is centred here rather than on .root
   — the dialog is fixed-positioned, so it is the panel's containing block. */
dialog:not([open]) { display: none; }
dialog[open] { display: grid; place-items: center; }

/* Primed but not yet revealed: loaded, painted, invisible, inert.
   The subtree — not just the dialog — has to opt out of hit-testing, because
   .pane re-enables pointer-events and would otherwise swallow the very
   mouseup that is supposed to trigger the peek. */
.root[data-priming="1"] dialog,
.root[data-priming="1"] dialog * { pointer-events: none; }
.root[data-priming="1"] dialog { opacity: 0; }

/* ::backdrop inheritance from the originating element is a recent addition,
   so these are written as literals rather than custom properties. The open /
   close transitions are driven from JS against these same values. */
dialog::backdrop {
  background: rgba(16, 16, 18, 0.26);
  backdrop-filter: blur(18px) saturate(112%);
  -webkit-backdrop-filter: blur(18px) saturate(112%);
}
.root[data-scheme="dark"] dialog::backdrop { background: rgba(0, 0, 0, 0.46); }
.root[data-reduced-effects="1"] dialog::backdrop {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* ── Panel ──────────────────────────────────────────────────────────────── */
/* .panel is the animated, positioned box; it carries no paint of its own so
   the rail can hang outside it without being clipped. */
.panel {
  position: relative;
  width: min(calc(100vw - var(--inset-x) * 2), var(--max-w));
  height: calc(100vh - var(--inset-y) * 2);
  transform-origin: var(--origin-x, 50%) var(--origin-y, 50%);
  will-change: transform, opacity;
  pointer-events: auto;
}

/* .pane is the page itself: a clean rounded rectangle, nothing else. */
.pane {
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  /* overflow:hidden alone leaves hairline bleed at the corners over a
     composited iframe; the paint containment clips it cleanly. */
  overflow: hidden;
  contain: paint;
}

.frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: transparent;
  opacity: 0;
  transition: opacity 160ms linear;
}
.frame[data-painted="1"] { opacity: 1; }

/* ── Button rail ────────────────────────────────────────────────────────── */
.rail {
  position: absolute;
  left: 100%;
  top: 4px;
  margin-left: var(--rail-gap);
  display: flex;
  flex-direction: column;
  gap: 13px;
  z-index: 2;
}

.orb {
  all: unset;
  position: relative;
  width: var(--orb);
  height: var(--orb);
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--orb-bg);
  color: var(--orb-fg);
  box-shadow: var(--orb-shadow), inset 0 0 0 0.5px var(--orb-ring);
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
  cursor: default;
  transition: background-color 120ms linear, transform 140ms var(--ease-out),
    box-shadow 120ms linear;
}
.orb svg { width: 15px; height: 15px; display: block; }
.orb:hover { background: var(--orb-bg-hover); transform: scale(1.07); }
.orb:active { transform: scale(0.94); }
.orb:focus-visible {
  box-shadow: var(--orb-shadow), 0 0 0 2px var(--ink);
}
.root[data-reduced-effects="1"] .orb {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* The split button is the one control that has to live in an extension frame
   — see split-button.js. The slot reserves its space in the rail and carries
   the tooltip, since a cross-document child can't draw into our shadow root.
   The shadow-DOM orb underneath is the stand-in if that frame never loads. */
.orb-slot {
  position: relative;
  width: var(--orb);
  height: var(--orb);
  flex: 0 0 auto;
}
.orb-slot .orb { position: absolute; inset: 0; }
.orb-frame {
  position: absolute;
  inset: 0;
  width: var(--orb);
  height: var(--orb);
  border: 0;
  display: block;
  background: transparent;
  color-scheme: normal;
  opacity: 0;
}
.orb-slot[data-frame="ready"] .orb-frame { opacity: 1; }
.orb-slot[data-frame="ready"] .orb { visibility: hidden; }
.orb-slot[data-frame="failed"] .orb-frame { display: none; }

/* Tooltips, entirely in CSS so there is no positioning work at hover time.
   They open leftward, over the pane, because the rail is against the gutter. */
[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  right: calc(100% + 9px);
  top: 50%;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--tip-bg);
  color: var(--tip-fg);
  /* Restated rather than inherited: :host uses all:initial, and a stray
     serif here is the one place it shows. */
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
  font-size: 11.5px;
  font-weight: 530;
  letter-spacing: -0.003em;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-50%) translateX(4px) scale(0.96);
  transition: opacity 110ms linear, transform 110ms var(--ease-out);
}
/* :hover reaches an ancestor even when the pointer is inside a child frame,
   which is what keeps the split button's tooltip working. */
[data-tip]:hover::after,
.orb-slot[data-hover="1"]::after { opacity: 1; transform: translateY(-50%); }
.orb-slot[data-frame="ready"] .orb::after { content: none; }

/* Narrow windows have no gutter to spare, so the rail tucks into the pane's
   own top-right corner and the tooltips are dropped. */
@media (max-width: 720px) {
  .root { --inset-x: 12px; }
  .rail { left: auto; right: 10px; top: 10px; margin-left: 0; }
  [data-tip]::after { display: none; }
}

/* ── Loading ────────────────────────────────────────────────────────────── */
/* Shown only if the page is slow enough that the open animation has already
   finished, so a fast site never flashes it. A tapered ring rather than a
   bordered circle: the fade-out tail reads as motion even at low contrast,
   which lets it sit quietly at 55% ink instead of shouting in colour. */
.loader {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0;
  transform: scale(0.86);
  transition: opacity 220ms linear, transform 260ms var(--ease-out);
  pointer-events: none;
}
.loader[data-on="1"] { opacity: 1; transform: none; }
.loader .spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    transparent 26deg,
    color-mix(in oklab, var(--spin) 12%, transparent) 96deg,
    var(--spin) 348deg,
    transparent 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  animation: peek-spin 760ms linear infinite;
}
@keyframes peek-spin { to { transform: rotate(360deg); } }

/* ── Blocked / failed embed ─────────────────────────────────────────────── */
.fallback {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  background: var(--surface);
}
.fallback[data-on="1"] { display: flex; }
.fallback h2 {
  all: unset;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.012em;
}
.fallback p {
  all: unset;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-dim);
  max-width: 42ch;
}
.fallback .cta {
  all: unset;
  margin-top: 4px;
  padding: 8px 15px;
  border-radius: 8px;
  background: var(--ink);
  color: var(--on-ink);
  font-size: 13px;
  font-weight: 560;
  letter-spacing: -0.004em;
  cursor: default;
  transition: opacity 110ms linear, transform 110ms var(--ease-out);
}
.fallback .cta:hover { opacity: 0.86; }
.fallback .cta:active { transform: scale(0.97); }
.fallback .cta:focus-visible { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--ink); }

/* ── Drag ───────────────────────────────────────────────────────────────── */
.panel[data-dragging="1"] { transition: none; }
.panel[data-dragging="1"] .frame { pointer-events: none; }

/* ── Reduced motion ─────────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .root { --dur-open: 120ms; --dur-close: 100ms; --spring: linear(0, 1); }
  .loader { transform: none; }
  .loader .spinner { animation-duration: 1.6s; }
  .orb { transition: background-color 120ms linear; }
  .orb:hover, .orb:active { transform: none; }
}
`;
