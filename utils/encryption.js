const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must be set in .env and must be exactly 32 characters long'
    );
  }
  return Buffer.from(key, 'utf8');
}

/**
 * Encrypts a plaintext string (e.g. a WordPress Application Password).
 * Returns a single string "iv:authTag:ciphertext" (all hex-encoded) so it
 * can be stored as one field in MongoDB.
 */
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(
    ':'
  );
}

/**
 * Decrypts a string produced by encrypt().
 */
function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = String(payload).split(':');

  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Invalid encrypted payload format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
