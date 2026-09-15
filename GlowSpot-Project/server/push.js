/* Real phone-level notifications via Web Push — works even when the app
   isn't open, unlike the in-tab polling this replaces. Requires
   PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY to be set (generated once
   with `node -e "console.log(require('web-push').generateVAPIDKeys())"`);
   a safe no-op otherwise, and never throws — a failed push must not break
   the booking action that triggered it. */
const webpush = require('web-push');

const PUBLIC_KEY = process.env.PUSH_VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.PUSH_VAPID_PRIVATE_KEY || '';
const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);

if (enabled) {
  webpush.setVapidDetails('mailto:glowspot@example.com', PUBLIC_KEY, PRIVATE_KEY);
}

/* Sends to every subscription on the row (one per device/browser) and
   drops any subscription the push service reports as gone (404/410) so
   the list doesn't grow stale. `stmt` is the caller's updatePushSubscriptions
   statement (customersStmt or expertsStmt) so this can self-clean. `url`
   (optional) is where tapping the notification should land — the service
   worker opens/focuses it instead of the app root. */
async function sendPushToRow(row, stmt, title, body, url) {
  if (!enabled || !row || !Array.isArray(row.pushSubscriptions) || row.pushSubscriptions.length === 0) return;
  const payload = JSON.stringify(url ? { title, body, url } : { title, body });
  const survivors = [];
  let changed = false;
  for (const sub of row.pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      survivors.push(sub);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        changed = true; // subscription expired or was revoked — drop it
      } else {
        console.error('[push] send error:', e.message);
        survivors.push(sub); // transient failure — keep it, don't drop on a fluke
      }
    }
  }
  if (changed) await stmt.updatePushSubscriptions.run(survivors, row.id);
}

module.exports = { sendPushToRow, publicKey: PUBLIC_KEY, enabled };
