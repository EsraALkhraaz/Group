/* GlowSpot — shared REST API client for the 4 apps.
   Talks to the real backend in ../server (same-origin: open the apps
   from the URL the server itself prints, e.g. http://localhost:3000/...). */
(function (global) {
  'use strict';

  var TOKEN_PREFIX = 'glowspot_token_';

  function getToken(role) {
    try { return localStorage.getItem(TOKEN_PREFIX + role); } catch (e) { return null; }
  }
  function setToken(role, token) {
    try { localStorage.setItem(TOKEN_PREFIX + role, token); } catch (e) {}
  }
  function clearToken(role) {
    try { localStorage.removeItem(TOKEN_PREFIX + role); } catch (e) {}
  }

  /* The free hosting plan puts the server to sleep after ~15 minutes of no
     traffic; the first request after that takes 30-60s to wake it back up
     instead of failing. Retry through that window with a visible banner
     instead of surfacing it to the caller as a broken request. */
  var WAKE_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 20000]; // ~50s total
  var wakeBanner = null;
  function showWakeBanner() {
    if (wakeBanner) return;
    wakeBanner = document.createElement('div');
    wakeBanner.textContent = '⏳ جاري تجهيز الخادم، يستغرق هذا حتى دقيقة عند أول استخدام...';
    wakeBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#6B1F35;color:#fff;text-align:center;padding:10px;font-size:13px;' +
      'font-family:inherit;box-shadow:0 2px 8px rgba(0,0,0,.2);';
    document.body.appendChild(wakeBanner);
  }
  function hideWakeBanner() {
    if (wakeBanner && wakeBanner.parentNode) wakeBanner.parentNode.removeChild(wakeBanner);
    wakeBanner = null;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function request(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth) {
      var token = getToken(opts.auth);
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    var attempt = 0;
    var res;
    while (true) {
      try {
        res = await fetch(path, {
          method: method,
          headers: headers,
          body: body !== undefined ? JSON.stringify(body) : undefined
        });
      } catch (networkErr) {
        if (attempt < WAKE_RETRY_DELAYS.length) {
          showWakeBanner();
          await sleep(WAKE_RETRY_DELAYS[attempt]);
          attempt++;
          continue;
        }
        hideWakeBanner();
        throw networkErr;
      }
      if ((res.status === 502 || res.status === 503) && attempt < WAKE_RETRY_DELAYS.length) {
        showWakeBanner();
        await sleep(WAKE_RETRY_DELAYS[attempt]);
        attempt++;
        continue;
      }
      break;
    }
    hideWakeBanner();
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || ('http_' + res.status));
      err.error = (data && data.error) || ('http_' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  global.GlowSpotAPI = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    get: function (path, opts) { return request('GET', path, undefined, opts); },
    post: function (path, body, opts) { return request('POST', path, body || {}, opts); },
    patch: function (path, body, opts) { return request('PATCH', path, body || {}, opts); },
    del: function (path, opts) { return request('DELETE', path, undefined, opts); }
  };
})(window);
