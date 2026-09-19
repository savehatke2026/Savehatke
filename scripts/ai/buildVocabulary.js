#!/usr/bin/env node
// ============================================
// SaveHatke AI — buildVocabulary.js
// ============================================
// Compiles the token vocabulary from the prepared corpus and writes it to
// server/models/ai/vocabulary.json.
//
// The runtime rule scorer does not need this file — it matches the taxonomy
// directly, which is what lets the engine work on a cold start with no build
// step. The vocabulary exists for the trained classifier's feature space and
// for diagnostics.
//
// Run: npm run ai:vocab  (or npm run ai:prepare which chains into it)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TRAINING = path.join(ROOT, 'data', 'ai', 'training', 'intents.jsonl');
const OUT = path.join(ROOT, 'server', 'models', 'ai', 'vocabulary.json');

// Load the tokenizer so the vocabulary is built from exactly the same
// normalisation the runtime applies — a mismatch here would silently make the
// trained model useless.
const tokenizer = require(path.join(ROOT, 'server', 'services', 'ai', 'tokenizer.js'));

const MIN_COUNT = 1;

function main() {
  if (!fs.existsSync(TRAINING)) {
    console.error(` ${path.relative(ROOT, TRAINING)} not found. Run "npm run ai:prepare" first.`);
    process.exit(1);
  }

  const rows = fs.readFileSync(TRAINING, 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));

  const counts = {};
  let featureTotal = 0;

  rows.forEach((row) => {
    // Unigrams
    tokenizer.tokenize(row.text).forEach((t) => {
      counts[t] = (counts[t] || 0) + 1;
      featureTotal += 1;
    });
    // Bigrams and char trigrams, matching tokenizer.features()
    tokenizer.features(row.text).forEach((f) => {
      if (f.startsWith('b:')) counts[f] = (counts[f] || 0) + 1;
    });
  });

  // Rank by frequency; index 0 is reserved so 0 can mean "unknown".
  const tokens = {};
  let idx = 1;
  Object.entries(counts)
    .filter(([, n]) => n >= MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([token, n]) => {
      tokens[token] = { id: idx, count: n };
      idx += 1;
    });

  const doc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    size: Object.keys(tokens).length,
    examples: rows.length,
    featureTotal,
    minCount: MIN_COUNT,
    note: 'Compiled by scripts/ai/buildVocabulary.js. The runtime rule scorer does not depend on this file.',
    tokens,
  };

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  console.log('SaveHatke AI — vocabulary');
  console.log(`  examples   : ${rows.length}`);
  console.log(`  features   : ${featureTotal}`);
  console.log(`  vocabulary : ${doc.size} tokens`);
  console.log(`  written    : ${path.relative(ROOT, OUT)}`);
  console.log('✓ done');
}

if (require.main === module) main();

module.exports = { main };