/* GlowSpot — window.storage polyfill
   The 4 apps in this folder were authored against an async key/value
   `window.storage.get(key, shared)` / `window.storage.set(key, value, shared)`
   API. This file provides that API on top of localStorage so the apps run
   standalone in any browser (no server, no external runtime). If a real
   `window.storage` is already provided by the hosting environment, this
   polyfill does nothing and gets out of the way. */
(function () {
  if (window.storage) return;

  var PREFIX = 'glowspot_';

  window.storage = {
    get: function (key) {
      return new Promise(function (resolve) {
        try {
          var raw = localStorage.getItem(PREFIX + key);
          resolve(raw == null ? null : { value: raw });
        } catch (e) {
          resolve(null);
        }
      });
    },
    set: function (key, value) {
      return new Promise(function (resolve, reject) {
        try {
          localStorage.setItem(PREFIX + key, value);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }
  };
})();
