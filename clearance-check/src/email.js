// Results email via Resend (MS-004). Structure follows real-audio-creator
// supabase/functions/send-download-email, the license email (600px table
// layout, boxed REAL AUDIO wordmark, 2px ink rules, table-wrapped red button,
// small grey footer), so it reads as the same sender. Colour and type come from
// the result page (public/styles.css): cream ground, brand red, ink, and the
// drawn Patrick Hand face, falling back to the license email's mono stack where
// a client ignores web fonts (Gmail). Like the result page (Reject1): black
// "Your result:" then the verdict in red at the same size, track name in red,
// no separate verdict box; every result word is red, "clear" included.
import { verdictFor, PLATFORMS } from '../public/lib.js';

const CREAM = '#FFF8E0';
const RED = '#E55A3C';
const INK = '#1A1A1A';
const GRAY = '#6B6258';
const RULE = '#C7C0B5';
const MONO = "Menlo,Consolas,'Liberation Mono','Courier New',monospace";
const DRAWN = `'Patrick Hand',${MONO}`;
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap';
const LABEL = { clear: 'Clear', claimed: 'Claimed', muted: 'Muted', error: 'Couldn’t check', pending: 'Pending' };
const WARNING = 'This reflects right now. Any rightsholder can turn on enforcement at any time, so a clear result today can change later.';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildEmail(row, link) {
  const v = verdictFor(row);
  const name = row.original_filename || 'your track';
  const lines = PLATFORMS.map((p) => {
    const r = row[`${p.key}_result`];
    return { name: p.name, label: LABEL[r] || r, note: row[`${p.key}_note`] };
  });

  // Same as the result page: platform names in ink, every status in red.
  const rowsHtml = lines
    .map(
      (l, i) => `<tr>
                    <td style="padding:12px 0;${i ? `border-top:1px solid ${RULE};` : ''}font-family:${DRAWN};font-size:20px;line-height:1.3;color:${INK};">${esc(l.name)}</td>
                    <td align="right" style="padding:12px 0;${i ? `border-top:1px solid ${RULE};` : ''}font-family:${DRAWN};font-size:20px;line-height:1.3;color:${RED};">${esc(l.label)}${l.note ? `<div style="font-size:15px;color:${GRAY};">${esc(l.note)}</div>` : ''}</td>
                  </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en" style="background:${CREAM};">
  <head>
    <meta charset="utf-8">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light only">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your clearance check</title>
    <link href="${FONT_CSS}" rel="stylesheet">
  </head>
  <body style="margin:0;padding:0;background:${CREAM};">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">
      ${esc(v.text)} Clearance check for ${esc(name)}.
    </div>
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:${CREAM};">
      <tr>
        <td align="center" style="padding:24px 16px 48px 16px;">
          <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:${CREAM};">
            <tr>
              <td align="left" style="padding:8px 16px 20px 16px;">
                <span style="font-family:${MONO};display:inline-block;border:2px solid ${INK};padding:8px 12px;font-weight:700;letter-spacing:.02em;color:${INK};font-size:18px;line-height:1;">REAL&nbsp;AUDIO</span>
              </td>
            </tr>
            <tr><td style="height:2px;background:${INK};"></td></tr>
            <tr>
              <td align="center" style="padding:36px 16px 8px 16px;font-family:${DRAWN};">
                <div style="font-size:40px;line-height:1.15;color:${INK};">Your result: <span style="color:${RED};">${esc(v.text)}</span></div>
                <div style="font-size:20px;line-height:1.4;margin-top:12px;color:${INK};">Results for <span style="color:${RED};">${esc(name)}</span></div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 16px 0 16px;">
                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="border:2px solid ${INK};">
                  <tr><td style="padding:4px 18px;">
                    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                  ${rowsHtml}
                    </table>
                  </td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 16px 0 16px;">
                <table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="${RED}" style="border:2px solid ${INK};">
                  <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${DRAWN};font-size:20px;color:#ffffff;text-decoration:none;letter-spacing:.02em;">See your result &rarr;</a>
                </td></tr></table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 16px 0 16px;">
                <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
                  <td style="border:2px solid ${RED};padding:14px 16px;font-family:${DRAWN};font-size:18px;line-height:1.4;color:${RED};">${esc(WARNING)}</td>
                </tr></table>
              </td>
            </tr>
            <tr><td style="height:40px;line-height:40px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td></tr>
            <tr><td style="height:2px;background:${INK};"></td></tr>
            <tr>
              <td align="left" style="padding:20px 16px 0 16px;color:${GRAY};font-family:${MONO};">
                <div style="font-size:12px;line-height:1.7;">Your result stays at <a href="${esc(link)}" style="color:${INK};text-decoration:underline;">this link</a>, and it always shows the latest check.</div>
                <div style="font-size:12px;line-height:1.7;margin-top:8px;color:#999999;">© Real Audio · You received this because you asked us to check a track. This is the only email we send about it.</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Your result: ${v.text}`,
    '',
    `Results for ${name}`,
    '',
    ...lines.map((l) => `${l.name}: ${l.label}${l.note ? ` (${l.note})` : ''}`),
    '',
    `See your result: ${link}`,
    '',
    WARNING,
    '',
    '— Real Audio',
  ].join('\n');

  return { subject: `Clearance check: ${v.flagged ? 'flagged' : 'looks clear'} — ${name}`, html, text };
}

export async function sendResultEmail(env, row, link) {
  const { subject, html, text } = buildEmail(row, link);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Same dedupe as the license email: if Resend accepted a send but the
      // response was lost and the claim was released, the retry doesn't
      // deliver a second copy.
      'Idempotency-Key': `clearance-result:${row.id}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Real Audio <hello@real.audio>',
      to: [row.email],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}
