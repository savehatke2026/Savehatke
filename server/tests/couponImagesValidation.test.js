'use strict';
const assert = require('node:assert/strict');
const images = require('../services/couponImages');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==','base64');
function b64(b){ return b.toString('base64'); }
assert.throws(() => images.validateImageUpload({dataBase64:b64(Buffer.from('<script>alert(1)</script>')),contentType:'image/png'}), /Unsupported image format/);
assert.throws(() => images.validateImageUpload({dataBase64:b64(PNG),contentType:'image/jpeg'}), /does not match/);
assert.throws(() => images.validateImageUpload({dataBase64:b64(Buffer.concat([PNG,Buffer.from('<script>') ])),contentType:'image/png'}), /incomplete|damaged/);
assert.throws(() => images.validateImageUpload({dataBase64:'%%%not-base64%%%',contentType:'image/png'}), /could not be decoded|could not be read|Unsupported/);
console.log('couponImagesValidation: 4 passed');
