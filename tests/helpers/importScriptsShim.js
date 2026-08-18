const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * background.js loads its shared UMD modules via `importScripts(relPath)`,
 * which only exists in a real service worker. Stub it with `require` so the
 * same relative paths resolve to the same files under Node/Jest.
 */
function installImportScripts() {
  global.importScripts = function (relPath) {
    require(path.resolve(ROOT, relPath));
  };
}

module.exports = { installImportScripts, ROOT };
