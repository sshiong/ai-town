// This envelope protects downloaded ordinary data. Identity recovery remains separate.
export type BackupFilePurpose = 'snapshot' | 'manifest' | 'chunk';
const format = 'ai-town-encrypted-backup';
const iterations = 600_000;
const maxPartBytes = 5 * 1024 * 1024;
const encoder = new TextEncoder();
type Header = {
  format: typeof format;
  version: 1;
  purpose: BackupFilePurpose;
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  nonce: string;
  plaintextBytes: number;
};
type Envelope = Header & { ciphertext: string };

export function validBackupPassphrase(value: string) {
  return value.length >= 12 && encoder.encode(value).length <= 1024;
}

function requirePassphrase(value: string) {
  if (!validBackupPassphrase(value))
    throw new Error('Use a backup passphrase of at least 12 characters, up to 1024 UTF-8 bytes.');
}

function browserCrypto() {
  if (!globalThis.crypto?.subtle)
    throw new Error('Backup encryption requires Web Crypto in a secure browser context (HTTPS).');
  return globalThis.crypto;
}

function validateLimit(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxPartBytes)
    throw new Error('Unsupported backup part size limit.');
}

export function encryptedBackupFileLimit(maxBytes: number) {
  validateLimit(maxBytes);
  return 4 * Math.ceil((maxBytes + 16) / 3) + 2048;
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

function fromBase64(value: unknown, byteLength: number) {
  if (
    typeof value !== 'string' ||
    value.length !== 4 * Math.ceil(byteLength / 3) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('Invalid encrypted backup encoding.');
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== byteLength || toBase64(bytes) !== value)
    throw new Error('Invalid encrypted backup encoding.');
  return bytes;
}

function header(envelope: Pick<Header, 'purpose' | 'salt' | 'nonce' | 'plaintextBytes'>): Header {
  // Fixed ordering authenticates every public field independently of JSON property order.
  return {
    format,
    version: 1,
    purpose: envelope.purpose,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: envelope.salt,
    nonce: envelope.nonce,
    plaintextBytes: envelope.plaintextBytes,
  };
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  requirePassphrase(passphrase);
  const crypto = browserCrypto();
  const password = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    password.fill(0);
  }
}

export async function encryptBackupText(
  text: string,
  passphrase: string,
  purpose: BackupFilePurpose,
  maxBytes: number,
): Promise<string> {
  validateLimit(maxBytes);
  requirePassphrase(passphrase);
  const bytes = encoder.encode(text);
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error('Backup part exceeds its size limit.');
  const crypto = browserCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const metadata = header({
    purpose,
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    plaintextBytes: bytes.length,
  });
  try {
    const key = await deriveKey(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: 128,
        additionalData: encoder.encode(JSON.stringify(metadata)),
      },
      key,
      bytes,
    );
    return JSON.stringify({ ...metadata, ciphertext: toBase64(new Uint8Array(ciphertext)) });
  } finally {
    bytes.fill(0);
  }
}

function validateEnvelope(
  value: Record<string, unknown>,
  purpose: BackupFilePurpose,
  maxBytes: number,
) {
  const keys = [
    'format',
    'version',
    'purpose',
    'cipher',
    'kdf',
    'iterations',
    'salt',
    'nonce',
    'plaintextBytes',
    'ciphertext',
  ];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.format !== format ||
    value.version !== 1 ||
    value.purpose !== purpose ||
    value.cipher !== 'AES-256-GCM' ||
    value.kdf !== 'PBKDF2-SHA256' ||
    value.iterations !== iterations ||
    typeof value.plaintextBytes !== 'number' ||
    !Number.isSafeInteger(value.plaintextBytes) ||
    value.plaintextBytes < 1 ||
    value.plaintextBytes > maxBytes
  )
    throw new Error('Unsupported or invalid encrypted backup header.');
  const envelope = value as Envelope;
  return {
    envelope,
    salt: fromBase64(envelope.salt, 16),
    nonce: fromBase64(envelope.nonce, 12),
    ciphertext: fromBase64(envelope.ciphertext, envelope.plaintextBytes + 16),
  };
}

// Returns the original text, including row JSON strings and Convex byte/nonfinite encodings.
// Only the ordinary archive plaintext is sent to existing server validation; passwords never are.
export async function readBackupText(
  file: Pick<File, 'size' | 'text'>,
  maxBytes: number,
  purpose: BackupFilePurpose,
  passphrase = '',
): Promise<string> {
  const fileLimit = encryptedBackupFileLimit(maxBytes);
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > fileLimit)
    throw new Error('The selected backup file exceeds the supported size for this archive part.');
  const text = await file.text();
  const textBytes = encoder.encode(text).length;
  if (textBytes > fileLimit) throw new Error('The selected backup file exceeds its size limit.');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose an exported AI Town JSON object.');
  if (
    !(('format' in value && value.format === format) || ('ciphertext' in value && 'kdf' in value))
  ) {
    if (textBytes > maxBytes)
      throw new Error('The selected backup part exceeds its plaintext size limit.');
    return text;
  }
  const { envelope, salt, nonce, ciphertext } = validateEnvelope(
    value as Record<string, unknown>,
    purpose,
    maxBytes,
  );
  requirePassphrase(passphrase);
  const key = await deriveKey(passphrase, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await browserCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: 128,
        additionalData: encoder.encode(JSON.stringify(header(envelope))),
      },
      key,
      ciphertext,
    );
  } catch {
    throw new Error(
      'Could not decrypt this backup. Check the passphrase and use an intact encrypted file.',
    );
  }
  const bytes = new Uint8Array(plaintext);
  try {
    if (bytes.length !== envelope.plaintextBytes) throw new Error('Invalid decrypted backup size.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
