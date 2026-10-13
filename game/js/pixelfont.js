// Bitmap pixel font for «Дорога України».
//   drawText(ctx, text, x, y, color, opts = {}) → width in px
//     opts: { align: 'left'|'center'|'right', shadow: true | '#colour', scale: 1|2|3… }
//     (x, y) is the top-left of the cap line; glyphs are 5 px tall (×scale),
//     accents (Й Ї Ё) rise 1 px above y, descenders (Щ Ц Д , ) drop 1 px below.
//   measureText(text, opts = {}) → width in px (opts.scale honoured)
// Lowercase is drawn as small caps (same glyphs) — the usual trick for 5-px pixel fonts.
// Covers Ukrainian А–Я/а–я incl. Є І Ї Ґ, apostrophe, Latin A–Z, digits, . , : ; - « » ! ? ₴ % / + = ( ) ° and space.
// No DOM access: safe to import from Node.

export const FONT_H = 5;     // cap height in px (×scale)
export const LINE_H = 8;     // suggested line advance (×scale)

// Glyph rows: '#' = ink. A leading '^' row marks an accent row drawn at y-1.
// Rows past the 5th are descenders.
const G = {
  // digits
  '0': '###|#.#|#.#|#.#|###', '1': '.#.|##.|.#.|.#.|###', '2': '###|..#|###|#..|###', '3': '###|..#|.##|..#|###',
  '4': '#.#|#.#|###|..#|..#', '5': '###|#..|###|..#|###', '6': '###|#..|###|#.#|###', '7': '###|..#|.#.|.#.|.#.',
  '8': '###|#.#|###|#.#|###', '9': '###|#.#|###|..#|###',
  // Cyrillic
  'А': '.#.|#.#|###|#.#|#.#', 'Б': '###|#..|##.|#.#|##.', 'В': '##.|#.#|##.|#.#|##.', 'Г': '###|#..|#..|#..|#..',
  'Ґ': '^..#|###|#..|#..|#..|#..', 'Д': '.###.|.#.#.|.#.#.|.#.#.|#####|#...#', 'Е': '###|#..|##.|#..|###',
  'Є': '.##|#..|##.|#..|.##', 'Ж': '#.#.#|#.#.#|.###.|#.#.#|#.#.#', 'З': '##.|..#|.#.|..#|##.',
  'И': '#..#|#..#|#.##|##.#|#..#', 'І': '###|.#.|.#.|.#.|###', 'Ї': '^#.#|###|.#.|.#.|.#.|###',
  'Й': '^.##.|#..#|#..#|#.##|##.#|#..#', 'К': '#.#|#.#|##.|#.#|#.#', 'Л': '.###|.#.#|.#.#|.#.#|##.#',
  'М': '#...#|##.##|#.#.#|#...#|#...#', 'Н': '#.#|#.#|###|#.#|#.#', 'О': '.#.|#.#|#.#|#.#|.#.',
  'П': '###|#.#|#.#|#.#|#.#', 'Р': '##.|#.#|##.|#..|#..', 'С': '.##|#..|#..|#..|.##', 'Т': '###|.#.|.#.|.#.|.#.',
  'У': '#.#|#.#|.##|..#|##.', 'Ф': '..#..|.###.|#.#.#|.###.|..#..', 'Х': '#.#|#.#|.#.|#.#|#.#',
  'Ц': '#.#.|#.#.|#.#.|#.#.|####|...#', 'Ч': '#.#|#.#|###|..#|..#', 'Ш': '#.#.#|#.#.#|#.#.#|#.#.#|#####',
  'Щ': '#.#.#|#.#.#|#.#.#|#.#.#|#####|....#', 'Ь': '#..|#..|##.|#.#|##.', 'Ю': '#..#.|#.#.#|###.#|#.#.#|#..#.',
  'Я': '.##|#.#|.##|#.#|#.#', 'Ы': '#...#|#...#|##..#|#.#.#|##..#', 'Э': '##.|..#|.##|..#|##.',
  'Ъ': '##..|.#..|.##.|.#.#|.##.', 'Ё': '^#.#|###|#..|##.|#..|###',
  // Latin (shapes shared with Cyrillic where identical)
  'B': '##.|#.#|##.|#.#|##.', 'C': '.##|#..|#..|#..|.##', 'D': '##.|#.#|#.#|#.#|##.', 'F': '###|#..|##.|#..|#..',
  'G': '.##|#..|#.#|#.#|.##', 'I': '###|.#.|.#.|.#.|###', 'J': '..#|..#|..#|#.#|.#.', 'L': '#..|#..|#..|#..|###',
  'N': '#..#|##.#|#.##|#..#|#..#', 'Q': '.##.|#..#|#..#|#.#.|.#.#', 'R': '##.|#.#|##.|#.#|#.#',
  'S': '.##|#..|.#.|..#|##.', 'U': '#.#|#.#|#.#|#.#|###', 'V': '#.#|#.#|#.#|#.#|.#.', 'W': '#...#|#...#|#.#.#|##.##|#...#',
  'Y': '#.#|#.#|.#.|.#.|.#.', 'Z': '###|..#|.#.|#..|###',
  // punctuation & symbols
  ' ': '..|..|..|..|..', '.': '.|.|.|.|#', ',': '.|.|.|.|#|#', ':': '.|#|.|#|.', ';': '.|#|.|#|#',
  '-': '...|...|###|...|...', '«': '....|.#.#|#.#.|.#.#|....', '»': '....|#.#.|.#.#|#.#.|....',
  '!': '#|#|#|.|#', '?': '###|..#|.##|...|.#.', '₴': '.##.|####|..#.|####|.##.', '%': '#.#|..#|.#.|#..|#.#',
  '/': '..#|..#|.#.|#..|#..', "'": '#|#|.|.|.', '"': '#.#|#.#|...|...|...', '+': '...|.#.|###|.#.|...',
  '=': '...|###|...|###|...', '(': '.#|#.|#.|#.|.#', ')': '#.|.#|.#|.#|#.', '°': '###|#.#|###|...|...',
  '×': '...|#.#|.#.|#.#|...', '_': '...|...|...|...|###', '#': '#.#|###|#.#|###|#.#', '*': '#.#|.#.|#.#|...|...',
  '<': '..#|.#.|#..|.#.|..#', '>': '#..|.#.|..#|.#.|#..', '…': '.....|.....|.....|.....|#.#.#',
  '█': '###|###|###|###|###',
};
const ALIAS = {
  'A': 'А', 'E': 'Е', 'H': 'Н', 'K': 'К', 'M': 'М', 'O': 'О', 'P': 'Р', 'T': 'Т', 'X': 'Х',
  '’': "'", 'ʼ': "'", '‘': "'", '`': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-',
};

// Compile each glyph to horizontal ink runs: flat Int8Array [dx, dy, len, ...]
const GLYPHS = new Map();
for (const ch in G) {
  let rows = G[ch].split('|'), top = 0;
  if (rows[0][0] === '^') { rows[0] = rows[0].slice(1); top = 1; }
  const w = Math.max(...rows.map(r => r.length));
  const runs = [];
  rows.forEach((r, ry) => {
    for (let x = 0; x < r.length;) {
      if (r[x] !== '#') { x++; continue; }
      let e = x; while (e < r.length && r[e] === '#') e++;
      runs.push(x, ry - top, e - x); x = e;
    }
  });
  GLYPHS.set(ch, { w, runs: Int8Array.from(runs) });
}
const UNKNOWN = GLYPHS.get('?');

function glyph(ch) {
  let g = GLYPHS.get(ch);
  if (g) return g;
  const a = ALIAS[ch]; if (a) return GLYPHS.get(a);
  const up = ch.toUpperCase();
  if (up !== ch) { g = GLYPHS.get(up) || GLYPHS.get(ALIAS[up]); if (g) return g; }
  return UNKNOWN;
}

export function measureText(text, opts = {}) {
  const s = (opts && opts.scale) | 0 || 1;
  text = String(text);
  if (!text.length) return 0;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += glyph(text[i]).w + 1;
  return (w - 1) * s;
}

function inkPass(ctx, text, x, y, s) {
  for (let i = 0; i < text.length; i++) {
    const g = glyph(text[i]), r = g.runs;
    for (let k = 0; k < r.length; k += 3) ctx.fillRect(x + r[k] * s, y + r[k + 1] * s, r[k + 2] * s, s);
    x += (g.w + 1) * s;
  }
}

export function drawText(ctx, text, x, y, color = '#fff', opts = {}) {
  text = String(text);
  const s = (opts.scale | 0) || 1;
  const w = measureText(text, opts);
  x = Math.round(x); y = Math.round(y);
  if (opts.align === 'center') x -= w >> 1; else if (opts.align === 'right') x -= w;
  if (opts.shadow) { ctx.fillStyle = opts.shadow === true ? '#000' : opts.shadow; inkPass(ctx, text, x + s, y + s, s); }
  ctx.fillStyle = color;
  inkPass(ctx, text, x, y, s);
  return w;
}
