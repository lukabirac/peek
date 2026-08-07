/**
 * Peek — side panel host.
 *
 * Chromium won't let an extension create a native split view, so this is the
 * closest real equivalent: a resizable pane beside the page, inside the same
 * window. The peeked URL arrives in the panel path's query string.
 *
 * The port opened here is what tells the service worker the panel is alive —
 * when it disconnects, the header rule that let the site embed is withdrawn.
 *
 * A side panel's sub_frame request is not attributed to the tab it sits
 * beside, so the peek's own header rule doesn't reach it. The worker installs
 * a separate one scoped to this extension as the initiator, and the frame is
 * not requested until that rule is confirmed live — otherwise the site's
 * framing headers win the race and Chromium's error page loads instead.
 */
const url = new URLSearchParams(location.search).get("u");

const host = (() => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
})();

function note(title, body, action) {
  const el = document.createElement("div");
  el.className = "note";
  el.dataset.on = "1";

  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  el.append(h, p);

  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", action.run);
    el.append(b);
  }
  document.body.append(el);
  return el;
}

if (!url || !/^https?:\/\//i.test(url)) {
  note("Nothing here yet", "Open a Peek, then use the split button to send it to this panel.");
} else {
  document.title = host || "Peek";

  // Keep the worker aware of this panel for as long as it is open.
  try {
    const port = chrome.runtime.connect({ name: "peek-sidepanel" });
    port.postMessage({ type: "alive", url });
    // Which window this panel is in — the one fact the worker cannot work out
    // for itself, since a side panel has no tab and so the port's sender
    // carries no window either. It matters because opening the panel needs a
    // user gesture but re-pointing an open one does not: a swipe that would
    // otherwise be refused can be honoured in a window already showing this.
    chrome.windows.getCurrent().then(
      (w) => {
        try {
          port.postMessage({ type: "window", windowId: w.id });
        } catch {}
      },
      () => {}
    );
  } catch {}

  const loader = document.createElement("div");
  loader.className = "loader";
  loader.innerHTML = '<div class="spinner"></div>';

  const frame = document.createElement("iframe");
  frame.setAttribute("allow", "clipboard-write; fullscreen; picture-in-picture");
  frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");

  document.body.append(frame, loader);

  const openAsTab = () => {
    chrome.tabs.create({ url, active: true }).catch(() => {});
    window.close();
  };

  /* ─── Did it actually render? ────────────────────────────────────────── */
  /*
   * A framing refusal loads Chromium's own error document, which fires `load`
   * exactly like a real page and is opaque to us across the origin boundary.
   * The one reliable signal is the content script in the framed page: it
   * answers our token, and the error page has no content script to answer.
   */

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let handshook = false;
  let blocked = null;
  let poll = null;
  let deadline = null;
  let loaderT = null;

  const ping = () => {
    try {
      frame.contentWindow?.postMessage({ __peek: "cmd", token, action: "init" }, "*");
    } catch {}
  };

  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.__peek !== "child" || d.token !== token || d.kind !== "state") return;

    handshook = true;
    clearInterval(poll);
    clearTimeout(deadline);
    clearTimeout(loaderT);
    loader.dataset.on = "0";
    frame.dataset.painted = "1";
    if (blocked) {
      blocked.remove();
      blocked = null;
    }
    if (d.title) document.title = d.title;
  });

  frame.addEventListener("load", () => {
    if (!frame.src || frame.src === "about:blank") return;
    handshook = false;
    ping();
    let tries = 0;
    clearInterval(poll);
    poll = setInterval(() => {
      if (handshook || ++tries > 20) return clearInterval(poll);
      ping();
    }, 45);

    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (handshook || blocked) return;
      loader.dataset.on = "0";
      blocked = note(
        (host || "This site") + " won't load here",
        "It refuses to be embedded. The side panel can't relax that the way a " +
          "Peek can, so this one has to be a tab.",
        { label: "Open as Tab", run: openAsTab }
      );
    }, 900);
  });

  loaderT = setTimeout(() => {
    if (!handshook && !blocked) loader.dataset.on = "1";
  }, 300);

  // Only now, with the header rule confirmed live.
  const arm = (() => {
    try {
      return chrome.runtime.sendMessage({ type: "peek:panel-arm" });
    } catch {
      return Promise.resolve(null);
    }
  })();
  arm.catch(() => null).then(() => {
    frame.src = url;
  });
}
