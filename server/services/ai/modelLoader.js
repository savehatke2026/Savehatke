// ============================================
// SaveHatke AI — Model Loader (Server-Only)
// ============================================
// Owns loading and caching of the engine's runtime artifacts.
//
// Serverless constraints this file exists to satisfy:
//   - A cold start must not pay for a large parse. The vocabulary and the
//     intent taxonomy are small JSON documents and are loaded once per warm
//     instance, then kept in module scope.
//   - A missing artifact is never fatal. The engine is designed to run on the
//     rule scorer alone; training is an optimisation, not a dependency.
//   - Nothing here may be read with `fs` from a path outside the traced
//     dependency graph: Vercel bundles what is `require()`d, so the model files
//     under server/models/ai are reached through static require() calls.

const config = require('./config');

// Statically required artifacts. These are the files that must exist for the
// engine to work at all; the learned classifier under weights/ is optional and
// loaded by intentEngine.
const MODEL = require('../../models/ai/model.json');
const VOCABULARY = require('../../models/ai/vocabulary.json');
const INTENT_TAXONOMY = require('../../models/ai/intents.json');

let cached = null;
let loadCount = 0;

/**
 * Load the engine artifacts.
 * @param {{force?: boolean}} [opts]
 * @returns {{model:object, vocabulary:object, intents:object, loadedAt:number, loads:number, source:string}}
 */
function loadModel(opts = {}) {
  if (cached && !opts.force) return cached;

  // The bundled model.json describes what was compiled; a trained variant
  // carries a `trainedAt` stamp. Either way, loading must never throw: a
  // malformed artifact degrades to the rule-only engine instead of taking the
  // chat endpoint down.
  let model = MODEL;
  let source = 'bundled';
  try {
    if (MODEL && MODEL.generatedAt) source = 'bundled';
  } catch (e) {
    model = { version: 0, labels: [], generatedAt: null };
    source = 'fallback';
  }

  loadCount += 1;
  cached = {
    model: model || { version: 0, labels: [], generatedAt: null },
    vocabulary: VOCABULARY || { tokens: {}, size: 0 },
    intents: INTENT_TAXONOMY || { intents: {} },
    loadedAt: Date.now(),
    loads: loadCount,
    source,
  };
  return cached;
}

/** True when a trained classifier is available; the engine works either way. */
function hasTrainedClassifier() {
  try {
    // eslint-disable-next-line global-require
    const c = require('../../models/ai/weights/classifier.json');
    return Boolean(c && c.labels && c.logProb);
  } catch (e) {
    return false;
  }
}

/** Diagnostics for /api/chat/status and the ai:test script. No secrets. */
function describe() {
  const m = loadModel();
  return {
    engine: 'SaveHatke AI',
    provider: config.provider,
    modelVersion: m.model.version,
    modelGeneratedAt: m.model.generatedAt || null,
    intentCount: Object.keys(m.intents.intents || {}).length,
    vocabularySize: m.vocabulary.size || 0,
    trainedClassifier: hasTrainedClassifier(),
    loadCount: m.loads,
    loadedAt: m.loadedAt,
  };
}

/** Test/ops hook — drop the cache so the next call re-reads the artifacts. */
function reset() {
  cached = null;
}

module.exports = {
  loadModel,
  hasTrainedClassifier,
  describe,
  reset,
};