// ============================================
// SaveHatke — Image Content Sniffing
// ============================================
// Decides what a file actually is by reading its leading bytes, instead of
// trusting the browser-supplied MIME type or the filename extension. Both of
// those are attacker-controlled: a .png extension and image/png Content-Type say
// nothing about the payload.
//
// Only the three raster formats the support form accepts are recognised. Anything
// else — SVG (script-bearing), HTML, PDF, archives, ELF/PE executables, or an
// image with a script appended after a valid header — is rejected by falling
// through to null.

// Signatures are checked against the first bytes of the buffer.
const SIGNATURES = [
  { mime: 'image/png',  ext: '.png',  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: '.jpg',  bytes: [0xff, 0xd8, 0xff] },
];

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/** RIFF....WEBP — the format tag sits at offset 8, after the RIFF size field. */
function isWebp(buffer) {
  if (buffer.length < 12) return false;
  return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * @param {Buffer} buffer
 * @returns {{mime: string, ext: string}|null} null when the bytes are not one of
 *          the accepted image formats.
 */
function sniffImage(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  for (const sig of SIGNATURES) {
    if (startsWith(buffer, sig.bytes)) return { mime: sig.mime, ext: sig.ext };
  }
  if (isWebp(buffer)) return { mime: 'image/webp', ext: '.webp' };

  return null;
}

/**
 * A JPEG must end with the EOI marker and a PNG with an IEND chunk. Truncated
 * uploads and files with a valid header but junk appended fail here, so a
 * half-written screenshot never becomes a broken reference on a ticket.
 */
function looksComplete(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  if (mime === 'image/jpeg') {
    return buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  }
  if (mime === 'image/png') {
    return buffer.slice(-8, -4).toString('ascii') === 'IEND';
  }
  if (mime === 'image/webp') {
    // RIFF declares its own payload size at offset 4; it must match what arrived.
    const declared = buffer.readUInt32LE(4);
    return declared + 8 === buffer.length;
  }
  return false;
}

module.exports = { sniffImage, looksComplete };
