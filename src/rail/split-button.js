/**
 * Peek — the split button, hosted in an extension frame.
 *
 * chrome.sidePanel.open() may only be called in response to a user gesture,
 * and a gesture does not survive the hop from a content script to the service
 * worker: by the time the worker runs, the activation is spent. So this one
 * button lives in a 30×30 extension document layered into the rail. A click
 * here lands in a chrome-extension:// context that genuinely holds activation,
 * and open() can be called directly, synchronously, in the handler.
 *
 * Everything else in the peek stays in the content script.
 */
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));

document.documentElement.dataset.scheme = params.get("scheme") === "dark" ? "dark" : "light";
document.documentElement.dataset.reduced = params.get("reduced") === "1" ? "1" : "0";

// Kept current by the host so the worker can re-stage the panel if the peek
// navigated after it was first primed.
let currentURL = params.get("u") || "";

const btn = document.createElement("button");
btn.type = "button";
btn.title = "Split with This Tab";
btn.setAttribute("aria-label", "Split with This Tab");
btn.innerHTML =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2.1"/><path d="M8 3.2v9.6"/></svg>';
document.body.append(btn);

const toParent = (kind, extra) => {
  try {
    parent.postMessage({ __peekRail: kind, ...extra }, "*");
  } catch {}
};

// Only ever called from the click handler below. Activation belongs to the
// gesture, not to the frame, so nothing else can borrow this — which is why
// swiping doesn't split.
function attemptSplit() {
  // open() must be the first statement that touches an API — anything awaited
  // ahead of it would consume the activation before it gets to check.
  if (!Number.isFinite(tabId) || !chrome.sidePanel) return toParent("split-fallback");
  let opening;
  try {
    opening = chrome.sidePanel.open({ tabId });
  } catch (e) {
    return toParent("split-fallback", { error: String(e?.message || e) });
  }
  // Only now, with the gesture already spent on the thing that needed it.
  try {
    chrome.runtime.sendMessage({ type: "peek:split-confirm", tabId, url: currentURL });
  } catch {}
  Promise.resolve(opening)
    .then(() => toParent("split-ok"))
    .catch((e) => toParent("split-fallback", { error: String(e?.message || e) }));
}

btn.addEventListener("click", attemptSplit);

// :hover doesn't cross a document boundary, so the tooltip — which is drawn by
// the host's shadow DOM — has to be told when the pointer is here.
btn.addEventListener("pointerenter", () => toParent("hover", { on: true }));
btn.addEventListener("pointerleave", () => toParent("hover", { on: false }));

// The rail floats on the scrim, so anything typed while it holds focus still
// has to reach the peek that owns it.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toParent("key", { key: "Escape" });
});

window.addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const d = e.data;
  if (!d) return;
  if (d.__peekRailCmd === "url") currentURL = String(d.url || "");
});

// Tell the host we are live, so it can push the current URL down and stop
// showing the shadow-DOM stand-in.
toParent("ready");
