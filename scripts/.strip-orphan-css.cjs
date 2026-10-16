// One-off: strip CSS rules whose selectors are exclusively orphaned classes.
// Refuses to touch any rule that also styles a live class, and reports those.
// Usage: node scripts/.strip-orphan-css.cjs <file.html> <prefix>
const fs = require('fs');

const file = process.argv[2];
const prefix = process.argv[3];
let css = fs.readFileSync(file, 'utf8');

const styleStart = css.indexOf('<style>');
const styleEnd = css.lastIndexOf('</style>');
if (styleStart === -1 || styleEnd === -1) throw new Error('no <style> block');
const head = css.slice(0, styleStart + 7);
const body = css.slice(styleStart + 7, styleEnd);
const tail = css.slice(styleEnd);

const removed = [];
const keptMixed = [];
let out = '';
let i = 0;
while (i < body.length) {
  const brace = body.indexOf('{', i);
  if (brace === -1) { out += body.slice(i); break; }

  // Walk back to the selector start: after the previous '}', ';' or start.
  let selStart = brace;
  while (selStart > 0 && !/[};]/.test(body[selStart - 1])) selStart--;

  // Find the matching close brace for this block.
  let depth = 0;
  let j = brace;
  for (; j < body.length; j++) {
    if (body[j] === '{') depth++;
    else if (body[j] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error('unbalanced braces at ' + brace);

  const selector = body.slice(selStart, brace).replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').trim();
  const inner = body.slice(brace + 1, j);

  const isAtRule = selector.startsWith('@');
  const classNames = [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  const allOrphan = classNames.length > 0 && classNames.every((c) => c.startsWith(prefix));

  if (!isAtRule && allOrphan) {
    removed.push(selector.replace(/\s+/g, ' ').slice(0, 70));
    // Drop the rule plus one trailing separator (semicolon and/or whitespace).
    let after = j + 1;
    while (body[after] === ';' || body[after] === '\r' || body[after] === '\n' || body[after] === ' ') after++;
    out += body.slice(i, selStart);
    i = after;
    continue;
  }
  if (classNames.length && !allOrphan && !isAtRule) {
    const nonPrefix = classNames.filter((c) => !c.startsWith(prefix));
    if (nonPrefix.length) keptMixed.push(selector.replace(/\s+/g, ' ').slice(0, 70));
  }

  out += body.slice(i, j + 1);
  i = j + 1;
}

fs.writeFileSync(file, head + out + tail);
console.log('removed ' + removed.length + ' rules:');
for (const r of removed) console.log('  - ' + r);
if (keptMixed.length) {
  console.log('\nKEPT (selector mixes live classes, review by hand):');
  for (const r of keptMixed) console.log('  * ' + r);
}