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

  async function request(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth) {
      var token = getToken(opts.auth);
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    var res = await fetch(path, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
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
