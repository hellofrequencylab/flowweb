// FW-C-089: a draft copies into Gmail with a small Frequency logo above the Owner's name.
// The draft stays plain text everywhere else; only the copy carries an HTML twin, with the logo as a
// hosted image so it survives the paste.

/** Frequency's round logo, served from frequencylocal.com so a pasted email can load it. */
export const LOGO_URL = 'https://frequencylocal.com/images/Frequency-Logo-Round-Icon.png';
const LOGO_PX = 32;

export type SignOffSplit = { before: string; signOff: string; after: string };

/**
 * Finds the sign-off: the short block (two to four lines, no link, no template slot) just before a
 * "P.S." paragraph, or the last paragraph when there is no P.S. Returns null when there is none.
 */
export function splitSignOff(text: string): SignOffSplit | null {
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  let at = paras.findIndex((p) => /^P\.?S\.?\b/i.test(p.trim())) - 1;
  if (at < -1) at = paras.length - 1;
  if (at < 0) return null;
  const block = (paras[at] ?? '').trim();
  const lines = block.split('\n');
  if (lines.length < 2 || lines.length > 4 || /https?:\/\/|\{\{/.test(block)) return null;
  if (lines.some((l) => l.length > 60 || /[?!]$/.test(l.trim()))) return null;
  return {
    before: paras.slice(0, at).join('\n\n'),
    signOff: block,
    after: paras.slice(at + 1).join('\n\n'),
  };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function linked(line: string): string {
  return esc(line).replace(/https:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}">${u}</a>`);
}

const paras = (text: string) =>
  text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 1em">${p.split('\n').map(linked).join('<br>')}</p>`)
    .join('');

const logo = (src: string) =>
  `<img src="${esc(src)}" alt="Frequency" width="${LOGO_PX}" height="${LOGO_PX}" style="display:block;width:${LOGO_PX}px;height:${LOGO_PX}px;margin:0 0 6px;border:0">`;

/** The HTML twin of a draft for the clipboard: paragraphs, live links and the logo above the sign-off. */
export function draftHtml(text: string, src: string = LOGO_URL): string {
  const s = splitSignOff(text);
  if (!s) return paras(text);
  return `${paras(s.before)}${logo(src)}${paras(s.signOff)}${paras(s.after)}`;
}
