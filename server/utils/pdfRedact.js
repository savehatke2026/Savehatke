'use strict';
// ============================================================================
// SaveHatke — PDF content-stream redactor (Phase 2 overlay helper)
// ============================================================================
// The master template is flattened with subset-encoded fonts, so we cannot swap
// text by string. To replace a value WITHOUT a visible mask box, we instead
// DELETE the exact text-show operator that drew the original value (leaving the
// real background — gradient/image/solid — untouched) and report the value's
// fill colour + font size so the caller can redraw the new value in the SAME
// visual style at the SAME position. No rectangles are drawn.
//
// We locate the operator by POSITION: we replay the content stream tracking the
// CTM + text matrix + fill colour, compute each show operator's device origin,
// and match it to the target (x,y) captured from the template layout.

// ── 2D affine matrix helpers ([a,b,c,d,e,f]) ──
const I = [1, 0, 0, 1, 0, 0];
function mul(m1, m2) { // point transformed by m1 THEN m2
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
function translate(tx, ty) { return [1, 0, 0, 1, tx, ty]; }

function cmykToRgb(c, m, y, k) {
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
}

// ── Tokenizer: flat tokens with byte offsets. Arrays [...] and strings (...) /
//    <...> are single tokens. ──
function tokenize(s) {
  const toks = [];
  const n = s.length;
  let i = 0;
  const isWS = (ch) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
  const isDelim = (ch) => '()<>[]{}/%'.includes(ch);
  while (i < n) {
    const ch = s[i];
    if (isWS(ch)) { i++; continue; }
    const start = i;
    if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (ch === '(') {
      let depth = 0; i++;
      while (i < n) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === '(') depth++; else if (c === ')') { if (depth === 0) { i++; break; } depth--; } i++; }
      toks.push({ t: 'str', start, end: i });
      continue;
    }
    if (ch === '<' && s[i + 1] !== '<') { i++; while (i < n && s[i] !== '>') i++; i++; toks.push({ t: 'hstr', start, end: i }); continue; }
    if (ch === '<' && s[i + 1] === '<') { i += 2; toks.push({ t: 'dictopen', start, end: i }); continue; }
    if (ch === '>' && s[i + 1] === '>') { i += 2; toks.push({ t: 'dictclose', start, end: i }); continue; }
    if (ch === '[') {
      let depth = 0; i++;
      while (i < n) { const c = s[i]; if (c === '(') { let d = 0; i++; while (i < n) { const cc = s[i]; if (cc === '\\') { i += 2; continue; } if (cc === '(') d++; else if (cc === ')') { if (d === 0) { i++; break; } d--; } i++; } continue; } if (c === '[') depth++; else if (c === ']') { if (depth === 0) { i++; break; } depth--; } i++; }
      toks.push({ t: 'arr', start, end: i });
      continue;
    }
    if (ch === '/') { i++; while (i < n && !isWS(s[i]) && !isDelim(s[i])) i++; toks.push({ t: 'name', start, end: i, val: s.slice(start, i) }); continue; }
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) { i++; while (i < n && !isWS(s[i]) && !isDelim(s[i])) i++; toks.push({ t: 'num', start, end: i, val: parseFloat(s.slice(start, i)) }); continue; }
    // operator
    i++; while (i < n && !isWS(s[i]) && !isDelim(s[i])) i++;
    toks.push({ t: 'op', start, end: i, val: s.slice(start, i) });
  }
  return toks;
}

/**
 * Replay the content stream, delete the show operators that drew the target
 * values, and report each match's fill colour + font size.
 * @param {string} content decoded content-stream text
 * @param {Array<{x:number,y:number,tol?:number}>} targets
 * @returns {{edited:string, matches:Array}}
 */
function redactByPosition(content, targets) {
  const toks = tokenize(content);
  const chars = content.split('');
  const matches = new Array(targets.length).fill(null);

  let ctm = I.slice();
  const gsStack = [];
  let fill = { r: 0, g: 0, b: 0 };
  const colorStack = [];
  let tm = I.slice(), tlm = I.slice();
  let leading = 0;
  let fontSize = 0;

  const blank = (a, b) => { for (let k = a; k < b; k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' '; };

  // A template value is often drawn as MANY positioned show-ops (per glyph /
  // kerned run) that a text extractor coalesces into one item. So we delete
  // EVERY show-op whose origin lies on the target baseline within the value's
  // horizontal span [x, x+w], and remember the leftmost op's fill colour.
  const tryMatch = (opStart, opEnd, operandStart) => {
    const trm = mul(tm, ctm);
    const x = trm[4], y = trm[5];
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      const ytol = t.ytol || 2.5;
      const xtol = t.xtol || 2.5;
      const w = t.w || 0;
      if (Math.abs(y - t.y) <= ytol && x >= t.x - xtol && x <= t.x + w + xtol) {
        blank(operandStart, opEnd);
        const scale = Math.hypot(trm[0], trm[1]);
        const prev = matches[ti];
        if (!prev || x < prev.x) matches[ti] = { x, y, color: { ...fill }, scale: Math.round(scale * 1000) / 1000 };
      }
    }
  };

  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== 'op') continue;
    const op = tk.val;
    const numBefore = (cnt) => { const arr = []; let j = k - 1; while (arr.length < cnt && j >= 0) { arr.unshift(toks[j]); j--; } return arr; };
    switch (op) {
      case 'q': gsStack.push(ctm.slice()); colorStack.push({ ...fill }); break;
      case 'Q': if (gsStack.length) ctm = gsStack.pop(); if (colorStack.length) fill = colorStack.pop(); break;
      case 'cm': { const p = numBefore(6); if (p.length === 6) ctm = mul([p[0].val, p[1].val, p[2].val, p[3].val, p[4].val, p[5].val], ctm); break; }
      case 'BT': tm = I.slice(); tlm = I.slice(); break;
      case 'ET': break;
      case 'Tm': { const p = numBefore(6); if (p.length === 6) { tm = [p[0].val, p[1].val, p[2].val, p[3].val, p[4].val, p[5].val]; tlm = tm.slice(); } break; }
      case 'Td': { const p = numBefore(2); if (p.length === 2) { tlm = mul(translate(p[0].val, p[1].val), tlm); tm = tlm.slice(); } break; }
      case 'TD': { const p = numBefore(2); if (p.length === 2) { leading = -p[1].val; tlm = mul(translate(p[0].val, p[1].val), tlm); tm = tlm.slice(); } break; }
      case 'T*': { tlm = mul(translate(0, -leading), tlm); tm = tlm.slice(); break; }
      case 'TL': { const p = numBefore(1); if (p.length === 1) leading = p[0].val; break; }
      case 'Tf': { const p = numBefore(1); if (p.length) fontSize = p[0].val; break; }
      case 'g': { const p = numBefore(1); if (p.length) { const v = p[0].val; fill = { r: v, g: v, b: v }; } break; }
      case 'rg': { const p = numBefore(3); if (p.length === 3) fill = { r: p[0].val, g: p[1].val, b: p[2].val }; break; }
      case 'k': { const p = numBefore(4); if (p.length === 4) fill = cmykToRgb(p[0].val, p[1].val, p[2].val, p[3].val); break; }
      case 'Tj': case "'": { const opnd = toks[k - 1]; if (opnd) tryMatch(tk.start, tk.end, opnd.start); if (op === "'") { tlm = mul(translate(0, -leading), tlm); tm = tlm.slice(); } break; }
      case '"': { const opnd = toks[k - 1]; const strStart = opnd ? opnd.start : tk.start; tlm = mul(translate(0, -leading), tlm); tm = tlm.slice(); if (opnd) tryMatch(tk.start, tk.end, strStart); break; }
      case 'TJ': { const opnd = toks[k - 1]; if (opnd && opnd.t === 'arr') tryMatch(tk.start, tk.end, opnd.start); break; }
      default: break;
    }
    // advance text position after a show op by the string width is NOT needed:
    // we only match the show op's ORIGIN, which is set by Tm/Td/T* before it.
  }

  return { edited: chars.join(''), matches };
}

module.exports = { redactByPosition, tokenize };
