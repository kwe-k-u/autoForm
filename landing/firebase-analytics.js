// ============================================================
// Firebase Analytics — live traffic only
// ============================================================
// Skips loading entirely on localhost / 127.0.0.1 / file:// so local
// testing and previews never pollute real analytics data.

(function () {
  "use strict";

  var isLive =
    location.protocol !== "file:" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1" &&
    location.hostname !== "";

  if (!isLive) {
    console.info("Firebase Analytics skipped — not running on a live host.");
    return;
  }

  // Comes from firebase-config.js (generated from .env via scripts/gen-firebase-config.js, committed).
  if (!globalThis.FIREBASE_CONFIG_AVAILABLE) {
    console.warn("Firebase Analytics: firebase-config.js wasn't loaded. Run `node scripts/gen-firebase-config.js` after setting the FIREBASE_* vars in .env.");
    return;
  }

  var firebaseConfig = globalThis.FIREBASE_CONFIG;

  if (!firebaseConfig.measurementId) {
    console.warn("Firebase Analytics: FIREBASE_MEASUREMENT_ID isn't set in .env.");
    return;
  }

  Promise.all([
    import("https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js"),
  ])
    .then(function (mods) {
      var app = mods[0].initializeApp(firebaseConfig);
      mods[1].getAnalytics(app);
    })
    .catch(function (err) {
      console.error("Failed to load Firebase Analytics:", err);
    });
})();
