/**
 * offscreen.js
 *
 * Runs inside the extension's offscreen document (created on demand by
 * background.js). Firebase's signInWithPopup can't complete its handshake
 * with Google from a chrome-extension:// origin, so the actual sign-in call
 * happens on a real https:// page (see landing/authhandler.js, deployed via
 * Firebase Hosting) loaded here in an iframe. This script just relays one
 * request/response between background.js and that iframe.
 *
 * See: https://firebase.google.com/docs/auth/web/chrome-extension
 */
(() => {
  "use strict";

  const HOSTED_AUTH_URL = "https://autoform-46257.web.app/authhandler.html";
  const HOSTED_AUTH_ORIGIN = new URL(HOSTED_AUTH_URL).origin;

  const iframe = document.createElement("iframe");
  iframe.src = HOSTED_AUTH_URL;
  iframe.style.display = "none";
  document.documentElement.appendChild(iframe);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return false;

    function handleIframeMessage(event) {
      // Only trust replies that actually came from the hosted auth page.
      if (event.origin !== HOSTED_AUTH_ORIGIN) return;
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // Not our message (Firebase's own SDK posts other internal noise into the iframe)
      }
      window.removeEventListener("message", handleIframeMessage);
      sendResponse(parsed);
    }

    window.addEventListener("message", handleIframeMessage);
    iframe.contentWindow.postMessage({ initAuth: true, provider: message.provider }, HOSTED_AUTH_ORIGIN);
    return true; // Keep the message channel open for the async iframe reply
  });
})();
