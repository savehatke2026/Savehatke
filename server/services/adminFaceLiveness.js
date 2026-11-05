'use strict';

// Server-only AWS integration for SaveHatke admin camera face verification.
// Browser credentials are short-lived Cognito unauthenticated-role credentials
// with permission ONLY to call rekognition:StartFaceLivenessSession.

const {
  RekognitionClient,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  CompareFacesCommand,
} = require('@aws-sdk/client-rekognition');
const {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} = require('@aws-sdk/client-cognito-identity');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let clients = null;

function readConfig() {
  const region = String(process.env.FACE_LIVENESS_REGION || process.env.AWS_REGION || 'ap-south-1').trim();
  const bucket = String(process.env.FACE_LIVENESS_BUCKET || '').trim();
  const kmsKeyId = String(process.env.FACE_LIVENESS_KMS_KEY_ID || '').trim();
  const identityPoolId = String(process.env.FACE_LIVENESS_IDENTITY_POOL_ID || '').trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const sessionToken = String(process.env.AWS_SESSION_TOKEN || '').trim();
  const livenessThreshold = Number(process.env.FACE_LIVENESS_MIN_CONFIDENCE || '');
  const matchThreshold = Number(process.env.FACE_MATCH_MIN_SIMILARITY || '');
  const consentVersion = String(process.env.ADMIN_FACE_CONSENT_VERSION || '').trim();

  const thresholdsValid = Number.isFinite(livenessThreshold) && livenessThreshold > 0 &&
    livenessThreshold <= 100 && Number.isFinite(matchThreshold) &&
    matchThreshold > 0 && matchThreshold <= 100;
  const configured = Boolean(region && bucket && kmsKeyId && identityPoolId &&
    accessKeyId && secretAccessKey && thresholdsValid && consentVersion);

  return {
    region, bucket, kmsKeyId, identityPoolId, accessKeyId, secretAccessKey,
    sessionToken, livenessThreshold, matchThreshold, consentVersion, configured,
  };
}

function isConfigured() {
  return readConfig().configured;
}

function getClients() {
  const config = readConfig();
  if (!config.configured) throw new Error('Camera face recognition is not configured.');
  if (clients && clients.region === config.region &&
      clients.accessKeyId === config.accessKeyId) return clients;

  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
  clients = {
    region: config.region,
    accessKeyId: config.accessKeyId,
    rekognition: new RekognitionClient({ region: config.region, credentials }),
    cognito: new CognitoIdentityClient({ region: config.region, credentials }),
    s3: new S3Client({ region: config.region, credentials }),
  };
  return clients;
}

function getPublicConfig() {
  const config = readConfig();
  return {
    enabled: config.configured,
    region: config.configured ? config.region : null,
    consentVersion: config.configured ? config.consentVersion : null,
  };
}

async function createSession({ keyPrefix }) {
  const config = readConfig();
  const aws = getClients();
  const result = await aws.rekognition.send(new CreateFaceLivenessSessionCommand({
    ClientRequestToken: require('crypto').randomUUID(),
    KmsKeyId: config.kmsKeyId,
    Settings: {
      AuditImagesLimit: 0,
      ChallengePreferences: [{ Type: 'FaceMovementAndLightChallenge' }],
      OutputConfig: {
        S3Bucket: config.bucket,
        S3KeyPrefix: keyPrefix,
      },
    },
  }));
  if (!result.SessionId) throw new Error('AWS did not return a face liveness session.');
  return { sessionId: result.SessionId, keyPrefix, bucket: config.bucket };
}

async function getBrowserCredentials() {
  const config = readConfig();
  const aws = getClients();
  const identity = await aws.cognito.send(new GetIdCommand({
    IdentityPoolId: config.identityPoolId,
  }));
  if (!identity.IdentityId) throw new Error('Cognito did not return a temporary identity.');

  const result = await aws.cognito.send(new GetCredentialsForIdentityCommand({
    IdentityId: identity.IdentityId,
  }));
  const credentials = result.Credentials;
  if (!credentials || !credentials.AccessKeyId || !credentials.SecretKey ||
      !credentials.SessionToken || !credentials.Expiration) {
    throw new Error('Cognito did not return complete temporary credentials.');
  }

  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

async function getSessionResults(sessionId) {
  const aws = getClients();
  return aws.rekognition.send(new GetFaceLivenessSessionResultsCommand({
    SessionId: sessionId,
  }));
}

function getReferenceImage(results, expectedBucket, expectedPrefix) {
  const image = results && results.ReferenceImage && results.ReferenceImage.S3Object;
  const bucket = String(image && image.Bucket || '');
  const key = String(image && image.Name || '');
  if (!bucket || !key || bucket !== expectedBucket || !key.startsWith(expectedPrefix)) {
    throw new Error('AWS returned an invalid face reference image location.');
  }
  return { bucket, key };
}

async function compareReferenceImages(enrolled, live) {
  const config = readConfig();
  const aws = getClients();
  const result = await aws.rekognition.send(new CompareFacesCommand({
    SourceImage: { S3Object: { Bucket: enrolled.bucket, Name: enrolled.key } },
    TargetImage: { S3Object: { Bucket: live.bucket, Name: live.key } },
    SimilarityThreshold: config.matchThreshold,
    QualityFilter: 'AUTO',
  }));
  const matches = Array.isArray(result.FaceMatches) ? result.FaceMatches : [];
  const highest = matches.reduce((max, item) => {
    const value = Number(item && item.Similarity || 0);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  return {
    matched: highest >= config.matchThreshold,
    similarity: highest,
    requiredSimilarity: config.matchThreshold,
  };
}

async function deleteReferenceImage(image) {
  if (!image || !image.bucket || !image.key) return;
  const config = readConfig();
  const aws = getClients();
  if (image.bucket !== config.bucket) return;
  await aws.s3.send(new DeleteObjectCommand({
    Bucket: image.bucket,
    Key: image.key,
  }));
}

function evaluateLiveness(results) {
  const config = readConfig();
  const confidence = Number(results && results.Confidence);
  const successful = String(results && results.Status || '').toUpperCase() === 'SUCCEEDED';
  return {
    live: successful && Number.isFinite(confidence) && confidence >= config.livenessThreshold,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    requiredConfidence: config.livenessThreshold,
    status: String(results && results.Status || 'UNKNOWN'),
  };
}

module.exports = {
  isConfigured,
  getPublicConfig,
  readConfig,
  createSession,
  getBrowserCredentials,
  getSessionResults,
  getReferenceImage,
  compareReferenceImages,
  deleteReferenceImage,
  evaluateLiveness,
};
