// Reports CSS classes defined in an HTML file that no element or script
// references any more. Used to find rules orphaned when a feature is removed.
// Usage: node scripts/find-orphan-css.cjs <file.html> [prefix]
const fs = require('fs');

const file = process.argv[2];
const prefix = process.argv[3] || '';
const s = fs.readFileSync(file, 'utf8');

// Classes defined in CSS: `.name` at the start of a selector position.
const defined = new Set();
for (const m of s.matchAll(/(^|[{};\s,])\.(-?[_a-zA-Z][\w-]*)/g)) {
  if (prefix && !m[2].startsWith(prefix)) continue;
  defined.add(m[2]);
}

// Classes actually used: in class="..." attributes, or referenced by name in JS.
const used = new Set();
for (const m of s.matchAll(/class="([^"]*)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) used.add(c);
}
for (const c of defined) {
  const jsRef = new RegExp("['\".]" + c + "['\".]");
  if (jsRef.test(s)) used.add(c);
}

const orphans = [...defined].filter((c) => !used.has(c)).sort();
console.log(file + (prefix ? ' [' + prefix + '-prefix]' : ''));
console.log('  classes defined: ' + defined.size);
console.log('  orphaned: ' + (orphans.length ? orphans.join(', ') : '(none)'));