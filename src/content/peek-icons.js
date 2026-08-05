/**
 * Peek — icon set.
 * 16×16 on a 16-unit grid, 1.6 stroke, round caps/joins: close to the
 * SF-Symbols weight Arc's chrome uses, so the toolbar reads as native.
 */
globalThis.__PEEK__ = globalThis.__PEEK__ || {};

const wrap = (d) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

globalThis.__PEEK__.ICONS = {
  close: wrap('<path d="M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4"/>'),

  /* Four corner brackets — the expand glyph Arc uses for "make this a tab". */
  promote: wrap(
    '<path d="M6.1 2.6H2.6v3.5"/><path d="M9.9 2.6h3.5v3.5"/>' +
      '<path d="M6.1 13.4H2.6V9.9"/><path d="M9.9 13.4h3.5V9.9"/>'
  ),

  /* A pane divided down the middle. */
  split: wrap(
    '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2.1"/><path d="M8 3.2v9.6"/>'
  ),

  peek: wrap(
    '<rect x="1.6" y="3.4" width="12.8" height="9.2" rx="2.2"/>' +
      '<path d="M4.6 1.6h6.8"/>'
  ),
};
