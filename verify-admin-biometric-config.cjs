'use strict';

const assert = require('node:assert/strict');

const keys = [
  'FACE_LIVENESS_REGION',
  'AWS_REGION',
  'FACE_LIVENESS_BUCKET',
  'FACE_LIVENESS_KMS_KEY_ID',
  'FACE_LIVENESS_IDENTITY_POOL_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'FACE_LIVENESS_MIN_CONFIDENCE',
  'FACE_MATCH_MIN_SIMILARITY',
  'ADMIN_FACE_CONSENT_VERSION',
];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function clearConfig() {
  keys.forEach((key) => delete process.env[key]);
}
function restoreConfig() {
  keys.forEach((key) => {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  });
}

try {
  clearConfig();
  const service = require('./server/services/adminFaceLiveness');

  assert.equal(service.isConfigured(), false, 'Face recognition must be disabled without AWS configuration.');
  assert.deepEqual(service.getPublicConfig(), {
    enabled: false,
    region: null,
    consentVersion: null,
  }, 'Disabled public configuration must not disclose AWS details.');

  Object.assign(process.env, {
    FACE_LIVENESS_REGION: 'ap-south-1',
    FACE_LIVENESS_BUCKET: 'private-admin-biometric-test',
    FACE_LIVENESS_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:111122223333:key/00000000-0000-0000-0000-000000000000',
    FACE_LIVENESS_IDENTITY_POOL_ID: 'ap-south-1:00000000-0000-0000-0000-000000000000',
    AWS_ACCESS_KEY_ID: 'ci-only-access-key',
    AWS_SECRET_ACCESS_KEY: 'ci-only-secret-key',
    FACE_LIVENESS_MIN_CONFIDENCE: '90',
    FACE_MATCH_MIN_SIMILARITY: '95',
    ADMIN_FACE_CONSENT_VERSION: 'ci-test-consent-v1',
  });
  assert.equal(service.isConfigured(), true, 'Complete test configuration should enable the feature.');
  assert.deepEqual(service.getPublicConfig(), {
    enabled: true,
    region: 'ap-south-1',
    consentVersion: 'ci-test-consent-v1',
  }, 'Public configuration may expose only the region and consent version.');

  process.env.FACE_MATCH_MIN_SIMILARITY = '101';
  assert.equal(service.isConfigured(), false, 'Invalid matching thresholds must fail closed.');

  console.log('Admin biometric configuration checks passed.');
} finally {
  restoreConfig();
}
