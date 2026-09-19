#!/usr/bin/env node
// ============================================
// SaveHatke AI — train.js
// ============================================
// Trains the optional intent classifier and writes
// server/models/ai/weights/classifier.json.
//
// WHY NAIVE BAYES
// The engine's rule scorer already classifies well because the taxonomy is
// explicit. What a learned model adds is graceful handling of phrasing nobody
// wrote down — a typo, a brand spelled differently, a word order we did not
// anticipate. A multinomial Naive Bayes over bag-of-features is the right size
// for that: it trains in milliseconds, is a few tens of kilobytes on disk,
// runs in pure arithmetic on CPU, and its per-label log-probabilities are
// directly inspectable when a classification looks wrong.
//
// It is deliberately NOT a neural network. Nothing here needs a GPU, and the
// engine must keep working if this file is never run.
//
// SECURITY: trains only on the prepared corpus, which prepareData.js has
// already screened for emails, keys, tokens and code-shaped strings.
//
// Run: npm run ai:train

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TRAINING = path.join(ROOT, 'data', 'ai', 'training', 'intents.jsonl');
const TAXONOMY = path.join(ROOT, 'server', 'models', 'ai', 'intents.json');
const WEIGHTS_DIR = path.join(ROOT, 'server', 'models', 'ai', 'weights');
const OUT = path.join(WEIGHTS_DIR, 'classifier.json');

const tokenizer = require(path.join(ROOT, 'server', 'services', 'ai', 'tokenizer.js'));

const LAPLACE_ALPHA = 0.35;   // smoothing; small alpha because the vocabulary is small
const MIN_FEATURE_COUNT = 2;  // drop hapax features — they are noise, not signal
const TEST_FRACTION = 0.2;

function loadRows() {
  if (!fs.existsSync(TRAINING)) {
    console.error(` ${path.relative(ROOT, TRAINING)} not found. Run "npm run ai:prepare" first.`);
    process.exit(1);
  }
  return fs.readFileSync(TRAINING, 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Deterministic shuffle so a rerun produces the same split. */
function shuffle(rows) {
  let seed = 424242;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out = rows.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main() {
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'));
  const allLabels = Object.keys(taxonomy.intents || {}).filter((l) => l !== 'UNKNOWN');
  const rows = loadRows();

  const shuffled = shuffle(rows);
  const testSize = Math.max(1, Math.floor(shuffled.length * TEST_FRACTION));
  const test = shuffled.slice(0, testSize);
  const train = shuffled.slice(testSize);

  // ── Feature extraction + document frequencies ──
  const featureDocCount = {};
  const docs = train.map((row) => {
    const feats = tokenizer.features(row.text);
    const uniq = [...new Set(feats)];
    uniq.forEach((f) => { featureDocCount[f] = (featureDocCount[f] || 0) + 1; });
    return { label: row.intent, feats: uniq, text: row.text };
  });

  const vocabulary = new Set(
    Object.entries(featureDocCount)
      .filter(([, n]) => n >= MIN_FEATURE_COUNT)
      .map(([f]) => f)
  );

  // ─ Counts ──
  const labelDocCount = {};
  const labelFeatureCount = {};
  const labelTotalFeatures = {};

  docs.forEach((doc) => {
    labelDocCount[doc.label] = (labelDocCount[doc.label] || 0) + 1;
    if (!labelFeatureCount[doc.label]) labelFeatureCount[doc.label] = {};
    const bucket = labelFeatureCount[doc.label];
    doc.feats.forEach((f) => {
      if (!vocabulary.has(f)) return;
      bucket[f] = (bucket[f] || 0) + 1;
      labelTotalFeatures[doc.label] = (labelTotalFeatures[doc.label] || 0) + 1;
    });
  });

  // Labels with no training data cannot be predicted — exclude them rather
  // than emit a prior of zero that would make the model unable to ever return
  // them. They remain reachable through the rule scorer.
  const labels = allLabels.filter((l) => labelDocCount[l] > 0);

  if (!labels.length) {
    console.error(' No labels with training data — cannot train.');
    process.exit(1);
  }

  // ── Priors and log-probabilities ──
  const totalDocs = labels.reduce((s, l) => s + labelDocCount[l], 0);
  const vocabSize = vocabulary.size;
  const prior = {};
  const logProb = {};

  labels.forEach((label) => {
    const docsForLabel = labelDocCount[label];
    // Smoothed prior, floored so a rare intent is not impossible.
    prior[label] = Math.log(Math.max(docsForLabel / totalDocs, 1e-4));

    const totals = labelTotalFeatures[label] || 0;
    const denom = totals + LAPLACE_ALPHA * vocabSize;
    const bucket = {};
    Object.entries(labelFeatureCount[label]).forEach(([f, count]) => {
      bucket[f] = Math.log((count + LAPLACE_ALPHA) / denom);
    });
    // The unseen-feature log-probability, so inference never needs a lookup miss.
    bucket.__unseen = Math.log(LAPLACE_ALPHA / denom);
    logProb[label] = bucket;
  });

  const model = {
    version: 1,
    kind: 'multinomial-naive-bayes',
    trainedAt: new Date().toISOString(),
    labels,
    prior,
    logProb,
    vocabularySize: vocabSize,
    training: {
      examples: train.length,
      testExamples: test.length,
      featuresRetained: vocabSize,
      featuresDropped: Object.keys(featureDocCount).length - vocabSize,
      alpha: LAPLACE_ALPHA,
    },
    note: 'Trained by scripts/ai/train.js. Loaded by services/ai/intentEngine.js when present. The engine also works without it.',
  };

  if (!fs.existsSync(WEIGHTS_DIR)) fs.mkdirSync(WEIGHTS_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf8');

  // ── Held-out accuracy, reported honestly ──
  const score = (row) => {
    const feats = [...new Set(tokenizer.features(row.text))];
    let best = null;
    let bestScore = -Infinity;
    labels.forEach((label) => {
      let s = prior[label];
      const bucket = logProb[label];
      feats.forEach((f) => {
        if (!vocabulary.has(f)) return;
        s += bucket[f] !== undefined ? bucket[f] : bucket.__unseen;
      });
      if (s > bestScore) { bestScore = s; best = label; }
    });
    return best;
  };

  let correct = 0;
  const perIntent = {};
  test.forEach((row) => {
    const predicted = score(row);
    const ok = predicted === row.intent;
    if (ok) correct += 1;
    if (!perIntent[row.intent]) perIntent[row.intent] = { total: 0, correct: 0 };
    perIntent[row.intent].total += 1;
    if (ok) perIntent[row.intent].correct += 1;
  });
  const accuracy = test.length ? correct / test.length : 0;

  console.log('SaveHatke AI — training (multinomial naive bayes)');
  console.log(`  labels            : ${labels.length}`);
  console.log(`  training examples : ${train.length}`);
  console.log(`  test examples     : ${test.length}`);
  console.log(`  vocabulary        : ${vocabSize} features (${model.training.featuresDropped} dropped)`);
  console.log(`  held-out accuracy : ${(accuracy * 100).toFixed(1)}%`);
  console.log(`  written           : ${path.relative(ROOT, OUT)}`);

  const weak = Object.entries(perIntent)
    .filter(([, v]) => v.total >= 2 && v.correct / v.total < 0.5)
    .map(([k, v]) => `${k} ${v.correct}/${v.total}`);
  if (weak.length) console.log(`   weak intents    : ${weak.join(', ')}`);
  console.log('✓ done — the engine uses this model in addition to the rule scorer.');
}

if (require.main === module) main();

module.exports = { main };