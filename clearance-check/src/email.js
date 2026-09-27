// Results email via Resend. Markup follows real-audio-creator
// supabase/functions/send-download-email (table layout, mono type, REAL AUDIO
// wordmark box, brand accent) so it reads as the same sender.
import { verdictFor, PLATFORMS } from '../public/lib.js';

const ACCENT = '#E55A3C';
const INK = '#111111';
const MONO = "Menlo,Consolas,'Liberation Mono','Courier New',monospace";
const LABEL = { clear: 'Clear', claimed: 'Claimed', muted: 'Muted', error: 'Couldn’t check', pending: 'Pending' };
const WARNING = 'This reflects right now. Any rightsholder can turn on enforcement at any time, so a clear result today can change later.';

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildEmail(row, link) {
  const v = verdictFor(row);
  const name = row.original_filename || 'your track';
  const lines = PLATFORMS.map((p) => {
    const r = row[`${p.key}_result`];
    const note = row[`${p.key}_note`];
    return { name: p.name, label: LABEL[r] || r, flagged: r !== 'clear', note };
  });

  const rowsHtml = lines
    .map(
      (l) => `<tr><td style="padding:10px 0;border-bottom:1px solid #eeeeee;font-family:${MONO};font-size:15px;color:${INK};">${esc(l.name)}</td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid #eeeeee;font-family:${MONO};font-size:15px;font-weight:700;color:${l.flagged ? ACCENT : INK};">${esc(l.label)}${l.note ? `<div style="font-weight:400;font-size:12px;color:#444444;">${esc(l.note)}</div>` : ''}</td></tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en" style="background:#ffffff;">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light only">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your clearance check</title>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background:#ffffff;">
      <tr><td align="center" style="padding:24px 16px 48px 16px;">
        <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;">
          <tr><td align="left" style="padding:8px 16px 20px 16px;">
            <span style="font-family:${MONO};display:inline-block;border:2px solid ${INK};padding:8px 12px;font-weight:700;letter-spacing:.02em;color:${INK};font-size:18px;line-height:1;">REAL&nbsp;AUDIO</span>
          </td></tr>
          <tr><td style="padding:0 16px;font-family:${MONO};font-size:13px;color:#444444;">Clearance check for ${esc(name)}</td></tr>
          <tr><td style="padding:8px 16px 16px 16px;font-family:${MONO};font-size:20px;font-weight:700;color:${v.flagged ? ACCENT : INK};">${esc(v.text)}</td></tr>
          <tr><td style="padding:0 16px;"><table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${rowsHtml}</table></td></tr>
          <tr><td style="padding:20px 16px 0 16px;">
            <table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="${ACCENT}" style="border:2px solid ${INK};">
              <a href="${esc(link)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:.02em;">See your result &rarr;</a>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding:20px 16px 0 16px;font-family:${MONO};font-size:12px;font-style:italic;color:${ACCENT};">${esc(WARNING)}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Clearance check for ${name}`,
    '',
    v.text,
    '',
    ...lines.map((l) => `${l.name}: ${l.label}${l.note ? ` (${l.note})` : ''}`),
    '',
    `See your result: ${link}`,
    '',
    WARNING,
  ].join('\n');

  return { subject: `Clearance check: ${v.flagged ? 'flagged' : 'looks clear'} — ${name}`, html, text };
}

export async function sendResultEmail(env, row, link) {
  const { subject, html, text } = buildEmail(row, link);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
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
