'use strict';
const assert = require('node:assert/strict');
const images = require('../services/couponImages');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==','base64');
const JPG = Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
function b64(b){ return b.toString('base64'); }
assert.throws(() => images.validateImageUpload({dataBase64:b64(Buffer.from('<script>alert(1)</script>')),contentType:'image/png'}), /Unsupported image format/);
assert.throws(() => images.validateImageUpload({dataBase64:b64(PNG),contentType:'image/jpeg'}), /does not match/);
assert.throws(() => images.validateImageUpload({dataBase64:b64(Buffer.concat([PNG,Buffer.from('<script>') ])),contentType:'image/png'}), /incomplete|damaged/);
assert.throws(() => images.validateImageUpload({dataBase64:'%%%not-base64%%%',contentType:'image/png'}), /could not be decoded|could not be read|Unsupported/);
console.log('couponImagesValidation: 4 passed');
