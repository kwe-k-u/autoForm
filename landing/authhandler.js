/**
 * landing/authhandler.js
 *
 * Deployed to Firebase Hosting (autoform-46257.web.app) alongside the
 * landing page. Loaded in a hidden iframe by the autoForm extension's
 * offscreen document (see offscreen.js) so that signInWithPopup runs on a
 * real https:// origin instead of a chrome-extension:// one — the latter
 * fails with "auth/internal-error" because Firebase's popup handshake with
 * Google isn't trusted from an extension origin.
 *
 * Protocol: parent posts {initAuth: true, provider: "google" | "apple"};
 * this page replies with a JSON-stringified {user: {...}} or {error: {...}}.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  OAuthProvider
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

const app = initializeApp(globalThis.FIREBASE_CONFIG);
const auth = getAuth(app);

// The offscreen document that iframes this page — where replies get posted.
const PARENT_ORIGIN = document.location.ancestorOrigins && document.location.ancestorOrigins[0];

function providerFor(name) {
  return name === "apple" ? new OAuthProvider("apple.com") : new GoogleAuthProvider();
}

function respond(payload) {
  if (!PARENT_ORIGIN) return;
  window.parent.postMessage(JSON.stringify(payload), PARENT_ORIGIN);
}

window.addEventListener("message", (event) => {
  if (!event.data || !event.data.initAuth) return;
  signInWithPopup(auth, providerFor(event.data.provider))
    .then((cred) => {
      const u = cred.user;
      respond({ user: { uid: u.uid, email: u.email, displayName: u.displayName, photoURL: u.photoURL } });
    })
    .catch((err) => {
      respond({ error: { code: err.code, message: err.message } });
    });
});
