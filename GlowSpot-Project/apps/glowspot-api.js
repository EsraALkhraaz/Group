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

  /* Resizes/compresses an image file to a JPEG data URL before upload —
     there's no image host wired up yet, so photos are stored as base64 in
     the database, and keeping each one small (~100-300KB) is what makes
     that workable on the free-tier storage quota. */
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 1024;
    quality = quality || 0.7;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        img.onerror = reject;
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* Real phone-level push notifications (Web Push) — the service worker
     shows the notification even when this tab isn't open. `authRole` is
     'customer' or 'expert' (whichever token this app holds). */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var out = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
    return out;
  }
  async function enablePush(authRole) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw Object.assign(new Error('unsupported'), { error: 'unsupported' });
    }
    var permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw Object.assign(new Error('permission_denied'), { error: 'permission_denied' });
    }
    var reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    var vapid = await request('GET', '/api/push/vapid-public-key', undefined, {});
    if (!vapid.enabled) throw Object.assign(new Error('push_not_configured'), { error: 'push_not_configured' });
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey)
      });
    }
    await request('POST', '/api/push/subscribe', { subscription: sub.toJSON() }, { auth: authRole });
    return true;
  }
  async function pushStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return 'inactive';
      var sub = await reg.pushManager.getSubscription();
      return sub ? 'active' : 'inactive';
    } catch (e) { return 'inactive'; }
  }

  global.GlowSpotAPI = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    compressImage: compressImage,
    enablePush: enablePush,
    pushStatus: pushStatus,
    get: function (path, opts) { return request('GET', path, undefined, opts); },
    post: function (path, body, opts) { return request('POST', path, body || {}, opts); },
    patch: function (path, body, opts) { return request('PATCH', path, body || {}, opts); },
    del: function (path, opts) { return request('DELETE', path, undefined, opts); }
  };
})(window);
