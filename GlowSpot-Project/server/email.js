/* Free notification channel — no SMS/WhatsApp provider is wired up, so
   email (via Resend's free tier) fills that gap for booking status
   updates. A no-op whenever RESEND_API_KEY isn't set or the recipient
   has no email on file, so this is always safe to call. Never let an
   email failure break the request that triggered it — errors are logged
   and swallowed, not thrown. */
const FROM = process.env.RESEND_FROM || 'GlowSpot <onboarding@resend.dev>';

async function sendEmail(to, subject, html) {
  if (!to || !process.env.RESEND_API_KEY) return;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: FROM, to, subject, html })
    });
    if (!res.ok) console.error('[email] send failed:', res.status, await res.text());
  } catch (e) {
    console.error('[email] send error:', e.message);
  }
}

module.exports = { sendEmail };
