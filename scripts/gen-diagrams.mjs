#!/usr/bin/env node
/**
 * Generates the README diagram and the social-preview card.
 *
 * One source, three files, because GitHub needs the light and dark variants as SEPARATE images - it
 * picks between them with `<picture>` + `prefers-color-scheme`, and a `@media` block inside an SVG
 * is not reliable once GitHub's sanitiser has been through it. Hand-maintaining two near-identical
 * SVGs is how they drift, so they are emitted from the same geometry with two palettes.
 *
 *   npm run gen:diagrams
 *
 * This is the only thing in the repo with a dependency, and it is a devDependency: the mock itself
 * is one file and needs nothing.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'img');

const PALETTES = {
  light: { bg: 'none', card: '#ffffff', ink: '#1f2328', muted: '#656d76', line: '#c3cbd4', edge: '#8c959f', rule: '#dde3ea', accent: '#215fff', wash: '#f6f8fa', ok: '#1a7f37', bad: '#cf222e', warn: '#9a6700', body: '#30363d', screen: '#0d1117' },
  dark: { bg: 'none', card: '#161b22', ink: '#e6edf3', muted: '#8b949e', line: '#30363d', edge: '#6e7681', rule: '#262c36', accent: '#5b8cff', wash: '#0d1117', ok: '#3fb950', bad: '#f85149', warn: '#d29922', body: '#21262d', screen: '#010409' },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';
/** A monospace glyph advances by ~0.6em in the faces above - enough to size a box around text. */
const monoWidth = (s, size) => s.length * size * 0.6;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, { size = 11, fill, font = FONT, weight = 400, anchor = 'start', spacing } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
  `${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;

/**
 * A card machine: body, screen, keypad, card slot. The repo's one piece of iconography.
 *
 * Its colours are FIXED, not taken from the palette: a terminal is a physical object, and it looks
 * the same whichever canvas it sits on. Palette-driven keys went murky on the dark wash.
 */
const DEVICE = { body: '#30363d', edge: '#484f58', key: '#dde3ea', screen: '#010409', ink: '#7ee787' };

function terminal(p, x, y, w, { screenLines = [], lit = false } = {}) {
  const pad = w * 0.09;
  const screenH = w * 0.52;
  const keyW = (w - pad * 2 - pad * 0.6 * 2) / 3;
  const keyH = keyW * 0.56;
  const keyTop = y + pad * 1.4 + screenH + pad;
  const keypadH = keyH * 4 + pad * 0.55 * 3;
  const slotY = keyTop + keypadH + pad * 0.9;
  const h = slotY + pad * 0.42 + pad * 1.1 - y; // the body ends below the slot, never clipping it

  const keys = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      keys.push(
        `<rect x="${x + pad + c * (keyW + pad * 0.6)}" y="${keyTop + r * (keyH + pad * 0.55)}" width="${keyW}" height="${keyH}" rx="${keyH * 0.28}" fill="${DEVICE.key}" opacity="0.9"/>`,
      );
    }
  }
  const lines = screenLines
    .map((l, i) =>
      text(x + pad * 1.6, y + pad * 1.4 + 15 + i * 14, l.t, {
        size: l.size ?? 9.5,
        fill: l.fill ?? (lit ? DEVICE.ink : p.muted),
        font: MONO,
        weight: l.weight ?? 400,
      }),
    )
    .join('\n    ');
  return `
  <g>
    <rect x="${x + 3}" y="${y + 4}" width="${w}" height="${h}" rx="${w * 0.1}" fill="${p.edge}" opacity="0.2"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.1}" fill="${DEVICE.body}" stroke="${DEVICE.edge}" stroke-width="1"/>
    <rect x="${x + pad}" y="${y + pad * 1.4}" width="${w - pad * 2}" height="${screenH}" rx="${w * 0.03}" fill="${DEVICE.screen}"/>
    ${lines}
    ${keys.join('\n    ')}
    <rect x="${x + w * 0.22}" y="${slotY}" width="${w * 0.56}" height="${pad * 0.42}" rx="${pad * 0.21}" fill="${DEVICE.key}" opacity="0.45"/>
  </g>`;
}

/** The browser window the mock serves: this is what you click to decide how the sale ends. */
function console_(p, x, y, w, h) {
  const btn = (bx, by, label, tone) => {
    const tw = label.length * 5.3 + 16;
    return {
      w: tw,
      svg: `<rect x="${bx}" y="${by}" width="${tw}" height="20" rx="4" fill="${tone ?? p.wash}" fill-opacity="${tone ? 0.13 : 1}" stroke="${tone ?? p.line}" stroke-width="1"/>
    ${text(bx + tw / 2, by + 13.6, label, { size: 9, fill: tone ?? p.ink, anchor: 'middle' })}`,
    };
  };

  let bx = x + 22;
  const buttons = [
    ['Tap card', p.ok],
    ['Pay by UPI', p.ok],
    ['Decline', p.bad],
    ['Stuck mid-payment', p.warn],
    ['Let it expire', null],
  ]
    .map(([label, tone]) => {
      const b = btn(bx, y + 112, label, tone);
      bx += b.w + 6;
      return b.svg;
    })
    .join('\n    ');
  // The buttons are the mock's real labels, so they must FIT rather than be abbreviated.
  if (bx - 6 > x + w - 16) throw new Error(`console buttons overflow by ${Math.ceil(bx - 6 - (x + w - 16))}px`);

  const rule = (ry) => `<rect x="${x + 12}" y="${ry}" width="${w - 24}" height="1" fill="${p.rule}"/>`;
  const saleRow = (ry, amount, offers, state, tone, dim = false) => `
    ${rule(ry)}
    ${text(x + 22, ry + 20, amount, { size: 11.5, fill: dim ? p.muted : p.ink, weight: 600 })}
    ${text(x + 104, ry + 20, offers, { size: 10, fill: p.muted })}
    ${text(x + w - 24, ry + 20, state, { size: 10, fill: tone, anchor: 'end', weight: 600 })}`;

  return `
  <g>
    <rect x="${x + 2}" y="${y + 3}" width="${w}" height="${h}" rx="7" fill="${p.edge}" opacity="0.16"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${p.card}" stroke="${p.edge}" stroke-width="1.25"/>
    <path d="M${x} ${y + 28} h${w}" stroke="${p.line}" stroke-width="1"/>
    <circle cx="${x + 17}" cy="${y + 14.5}" r="3.6" fill="${p.line}"/>
    <circle cx="${x + 29}" cy="${y + 14.5}" r="3.6" fill="${p.line}"/>
    <circle cx="${x + 41}" cy="${y + 14.5}" r="3.6" fill="${p.line}"/>
    <rect x="${x + 58}" y="${y + 7}" width="${w - 76}" height="15" rx="7.5" fill="${p.wash}"/>
    ${text(x + 68, y + 17.5, 'localhost:8201', { size: 9.5, fill: p.muted, font: MONO })}
    ${text(x + 22, y + 52, 'Pine Labs terminal (mock)', { size: 12.5, fill: p.ink, weight: 700 })}
    ${text(x + 22, y + 71, 'Push a sale from your app, then act as the customer here.', { size: 10, fill: p.muted })}
    ${saleRow(y + 82, '\u20b9500.00', 'Card \u00b7 UPI', 'pending', p.warn)}
    ${buttons}
    ${saleRow(y + 142, '\u20b91,200.00', 'All modes', 'approved \u00b7 CARD', p.ok, true)}
    ${text(x + 22, y + 182, 'ref 877080  \u00b7  machine 3923', { size: 9.5, fill: p.muted, font: MONO })}
    ${rule(y + 196)}
    ${text(x + 22, y + 214, 'The machine offers only the modes your app allowed for that sale.', { size: 9.5, fill: p.muted })}
  </g>`;
}

const arrow = (p, x1, x2, y) => `
  <path d="M${x1} ${y} L${x2} ${y}" stroke="${p.muted}" stroke-width="1.5"/>
  <path d="M${x2 - 6} ${y - 5} L${x2} ${y} L${x2 - 6} ${y + 5}" fill="none" stroke="${p.muted}" stroke-width="1.5"/>`;

/** The README strip: push an amount -> choose how it ends -> ask, and handle every answer. */
function diagram(p) {
  const W = 1240;
  const H = 356;
  const TOP = 76;      // every column's content starts here
  const BOTTOM = 306;  // ...and ends here
  const CAP = 332;     // one caption baseline for all three

  const fields = [
    ['Amount', '"50000"', '// paise'],
    ['AllowedPaymentMode', '"1|10"', '// pipes'],
    ['SequenceNumber', '1001', '// numeric'],
    ['AutoCancelDuration', '2', '// minutes'],
  ];
  const reqLines = fields
    .map(
      ([k, v, note], i) =>
        text(66, 136 + i * 22, k, { size: 10, fill: p.muted, font: MONO }) +
        text(186, 136 + i * 22, v, { size: 10, fill: p.ink, font: MONO }) +
        text(240, 136 + i * 22, note, { size: 9, fill: p.edge, font: MONO }),
    )
    .join('\n  ');

  const outcomes = [
    ['0', 'TXN APPROVED', p.ok, 'the card was taken'],
    ['2', 'TXN DECLINED BY ISSUER', p.bad, 'the card was refused'],
    ['1001', 'TXN UPLOADED', p.warn, 'still waiting - not a failure'],
    ['1', 'INVALID TRANSACTION NUMBER', p.muted, 'nobody paid, it expired'],
    ['1', 'CANNOT CANCEL ... IN PROGRESS', p.warn, 'mid-payment: do not double-collect'],
  ];
  const outRows = outcomes
    .map(
      ([code, msg, tone, note], i) => `
    <rect x="872" y="${TOP + i * 46}" width="320" height="38" rx="5" fill="${p.card}" stroke="${p.line}" stroke-width="1"/>
    <rect x="872" y="${TOP + i * 46}" width="3.5" height="38" rx="1.75" fill="${tone}"/>
    ${text(886, TOP + 15 + i * 46, code, { size: 10, fill: tone, font: MONO, weight: 700 })}
    ${text(916, TOP + 15 + i * 46, msg, { size: 9.5, fill: p.ink, font: MONO })}
    ${text(916, TOP + 30 + i * 46, note, { size: 9.5, fill: p.muted })}`,
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your app pushes an amount, the mock lets you choose how the sale ends - tap a card, decline, get stuck mid-payment, let it expire - and your integration must handle every answer the status call returns">
  <rect width="${W}" height="${H}" fill="${p.bg}"/>
  ${text(48, 28, 'Push a sale, choose how it ends, and make your code handle every answer.', { size: 15, fill: p.ink, weight: 600 })}

  ${text(48, 58, '1 - YOUR APP PUSHES AN AMOUNT', { size: 12, fill: p.muted, weight: 600, spacing: 0.6 })}
  <rect x="48" y="${TOP}" width="272" height="${BOTTOM - TOP}" rx="6" fill="${p.wash}" stroke="${p.line}" stroke-width="1.25"/>
  ${text(66, 104, 'POST', { size: 10, fill: p.muted, font: MONO })}
  ${text(104, 104, 'UploadBilledTransaction', { size: 10, fill: p.accent, font: MONO, weight: 700 })}
  ${reqLines}
  <rect x="66" y="240" width="236" height="1" fill="${p.line}"/>
  ${text(66, 262, '\u2192 reference', { size: 10, fill: p.muted, font: MONO })}
  ${text(186, 262, '877081', { size: 10, fill: p.accent, font: MONO, weight: 700 })}
  ${text(66, 284, 'the sale\u2019s identity from here on,', { size: 9.5, fill: p.muted })}
  ${text(66, 297, 'not the number you sent', { size: 9.5, fill: p.muted })}
  ${text(48, CAP, 'No terminal. No account. No callback URL.', { size: 10.5, fill: p.muted })}

  ${arrow(p, 332, 364, 191)}

  ${text(376, 58, '2 - THIS IS THE MACHINE', { size: 12, fill: p.muted, weight: 600, spacing: 0.6 })}
  ${console_(p, 376, TOP, 440, BOTTOM - TOP)}
  ${text(376, CAP, 'You are the customer at the counter - including the endings hardware will not give you on demand.', { size: 10.5, fill: p.muted })}

  ${arrow(p, 828, 860, 191)}

  ${text(872, 58, '3 - YOU ASK HOW IT ENDED', { size: 12, fill: p.muted, weight: 600, spacing: 0.6 })}
  ${outRows}
  ${text(872, CAP, 'GetCloudBasedTxnStatus - branch on the code, never the HTTP status.', { size: 10.5, fill: p.muted })}
</svg>
`;
}

/** 1280x640 social card - what GitHub, Slack and search show when the repo is linked. */
function social(p) {
  const W = 1280;
  const H = 640;
  const cmd = 'npx github:eka-care/pos-terminal-mock';
  const cmdW = monoWidth(cmd, 21) + 48;
  const chip = (cx, cy, label, tone) => {
    const tw = label.length * 9.2 + 26;
    return `<rect x="${cx}" y="${cy}" width="${tw}" height="32" rx="16" fill="${tone}" fill-opacity="0.12" stroke="${tone}" stroke-width="1.25"/>
  ${text(cx + tw / 2, cy + 21, label, { size: 15, fill: tone, anchor: 'middle' })}`;
  };
  let cx = 88;
  const chips = [
    ['approved', p.ok],
    ['declined', p.bad],
    ['still waiting', p.warn],
    ['expired', p.muted],
  ]
    .map(([label, tone]) => {
      const out = chip(cx, 452, label, tone);
      cx += label.length * 9.2 + 26 + 12;
      return out;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="POS Terminal Mock - a stand-in card machine, so you can build a POS integration without the hardware">
  <rect width="${W}" height="${H}" fill="${p.wash}"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${p.accent}"/>
  ${text(88, 180, 'POS Terminal Mock', { size: 74, fill: p.ink, weight: 700 })}
  ${text(88, 240, 'A stand-in card machine, for developers who do not have one.', { size: 28, fill: p.ink })}
  ${text(88, 300, 'Build the whole flow - declines, timeouts, a customer who walks', { size: 21, fill: p.muted })}
  ${text(88, 330, 'off mid-payment - before you ever hold a terminal.', { size: 21, fill: p.muted })}
  ${text(88, 406, 'EVERY ENDING, ON DEMAND', { size: 14, fill: p.muted, weight: 600, spacing: 0.8 })}
  ${chips}
  <rect x="88" y="524" width="${cmdW}" height="54" rx="8" fill="${p.card}" stroke="${p.line}" stroke-width="1.25"/>
  ${text(112, 558, cmd, { size: 21, fill: p.accent, font: MONO })}
  ${terminal(p, 900, 128, 200, {
    lit: true,
    screenLines: [
      { t: 'SALE  Rs 500.00', size: 11.5, weight: 700 },
      { t: 'TAP OR INSERT', size: 10 },
      { t: 'ref 877081', size: 9.5, fill: '#56d364' },
    ],
  })}
  ${text(1000, 560, 'Pine Labs today. MIT.', { size: 17, fill: p.muted, anchor: 'middle' })}
</svg>
`;
}

/**
 * PNG as well as SVG, for the two places SVG does not reach: GitHub's social preview (it accepts
 * only PNG/JPG, uploaded through Settings) and npm, which strips SVG out of a README entirely. The
 * README itself uses the PNGs so one image works everywhere; the SVGs stay as the source of truth.
 *
 * Rendered at 2x so the diagram stays sharp on a retina screen.
 */
function png(svg, width, file) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true } });
  const buf = r.render().asPng();
  writeFileSync(join(OUT, file), buf);
  return `${file} (${(buf.length / 1024).toFixed(0)} KB)`;
}

mkdirSync(OUT, { recursive: true });
const light = diagram(PALETTES.light);
const dark = diagram(PALETTES.dark);
// The light card is the one uploaded as GitHub's social preview (Settings takes a single image);
// the dark one is for the README and the site, which can pick with <picture>.
const card = social(PALETTES.light);
const cardDark = social(PALETTES.dark);
writeFileSync(join(OUT, 'overview-light.svg'), light);
writeFileSync(join(OUT, 'overview-dark.svg'), dark);
writeFileSync(join(OUT, 'social-card.svg'), card);
writeFileSync(join(OUT, 'social-card-dark.svg'), cardDark);
const made = [
  png(light, 2480, 'overview-light.png'),
  png(dark, 2480, 'overview-dark.png'),
  png(card, 1280, 'social-card.png'), // exactly the 1280x640 GitHub asks for
  png(cardDark, 1280, 'social-card-dark.png'),
];
console.log('wrote docs/img: SVG sources + ' + made.join(', '));
