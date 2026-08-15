'use strict';

/**
 * Fernet (spec v0x80) decryption, ported 1:1 from the Android app's
 * `fernetDecrypt` (javax.crypto AES/CBC/PKCS5Padding + HmacSHA256).
 *
 * Uses Node's crypto. Only decryption is needed by this app.
 */

const crypto = require('crypto');

function base64UrlDecode(value) {
  let normalized = String(value == null ? '' : value).trim();
  const padding = (4 - (normalized.length % 4)) % 4;
  normalized += '='.repeat(padding);
  const b64 = normalized.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * @param {string} token Fernet token (base64url).
 * @param {string} key   Fernet key (base64url, 32 bytes after decode).
 * @returns {string} Decrypted UTF-8 plaintext.
 */
function fernetDecrypt(token, key) {
  const tokenBytes = base64UrlDecode(token);
  const keyBytes = base64UrlDecode(key);

  if (tokenBytes.length < 57 || keyBytes.length !== 32 || tokenBytes[0] !== 0x80) {
    throw new Error('Invalid Fernet token');
  }

  const signingKey = keyBytes.subarray(0, 16);
  const encryptionKey = keyBytes.subarray(16, 32);

  const signatureStart = tokenBytes.length - 32;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(tokenBytes.subarray(0, signatureStart))
    .digest();
  const actual = tokenBytes.subarray(signatureStart);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('Invalid Fernet signature');
  }

  const iv = tokenBytes.subarray(9, 25);
  const cipherText = tokenBytes.subarray(25, signatureStart);
  const decipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey, iv);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

module.exports = { fernetDecrypt, base64UrlDecode };
