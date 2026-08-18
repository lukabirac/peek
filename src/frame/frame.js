/**
 * Peek target-frame wrapper.
 *
 * The host page must never be the sandboxed page's direct parent: a same-origin
 * target with both allow-scripts and allow-same-origin could otherwise remove
 * its own sandbox attribute. This extension-origin document stays between the
 * two, so every http(s) target is cross-origin from its parent and the sandbox
 * cannot be escaped.
 *
 * It also relays the existing host ↔ child bridge without interpreting it.
 */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const raw = params.get("url");
  const token = params.get("token") || "";
  let url = null;
  try {
    url = new URL(raw || "");
  } catch {}
  if (!url || !/^https?:$/.test(url.protocol) || !token) return;

  // A secure host cannot frame an insecure redirect. Apply the upgrade only
  // for that case; an ordinary HTTP host must keep HTTP-only targets working.
  if (params.get("upgrade") === "1") {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "upgrade-insecure-requests";
    document.head.append(policy);
  }

  const frame = document.createElement("iframe");
  frame.setAttribute("allow", "clipboard-write; fullscreen; picture-in-picture");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute(
    "sandbox",
    "allow-same-origin allow-scripts allow-forms allow-modals " +
      "allow-popups allow-popups-to-escape-sandbox allow-downloads " +
      "allow-pointer-lock allow-presentation allow-orientation-lock " +
      "allow-storage-access-by-user-activation"
  );

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === window.parent) {
      if (data?.__peek === "cmd") frame.contentWindow?.postMessage(data, "*");
      return;
    }
    if (event.source === frame.contentWindow && data?.__peek === "child") {
      window.parent.postMessage(data, "*");
    }
  });

  frame.addEventListener("load", () => {
    window.parent.postMessage({ __peekFrame: "load", token }, "*");
  });

  // Set the final, always cross-origin URL before connecting the sandboxed
  // frame. Chromium otherwise evaluates the initial same-origin about:blank
  // document and reports the allow-scripts + allow-same-origin escape warning.
  frame.src = url.href;
  document.body.append(frame);
})();
