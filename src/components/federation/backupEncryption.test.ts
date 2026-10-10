import { webcrypto } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  encryptBackupText,
  encryptedBackupFileLimit,
  readBackupText,
  validBackupPassphrase,
} from './backupEncryption';

const password = 'private memory archive passphrase';
const maxBytes = 1024 * 1024;
const source =
  '{"signature":"signed-inner","rows":["{\\"memory\\":\\"private dialogue\\",\\"bytes\\":{\\"$bytes\\":\\"AAE=\\"},\\"float\\":{\\"$float\\":\\"AAAAAAAA+H8=\\"}}"]}\n';
function file(text: string) {
  return { size: new TextEncoder().encode(text).length, text: () => Promise.resolve(text) };
}
function changed(encrypted: string, fields: Record<string, unknown>) {
  return file(JSON.stringify({ ...(JSON.parse(encrypted) as Record<string, unknown>), ...fields }));
}
function parseEnvelope(text: string) {
  return JSON.parse(text) as { salt: string; nonce: string; ciphertext: string };
}
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true }),
);

describe('browser encrypted ordinary backup envelope', () => {
  test.each(['snapshot', 'manifest', 'chunk'] as const)(
    'preserves signed inner %s bytes and exposes no memory or password',
    async (purpose) => {
      const encrypted = await encryptBackupText(source, password, purpose, maxBytes);
      expect(encrypted).not.toContain('private dialogue');
      expect(encrypted).not.toContain(password);
      expect(encrypted).not.toContain('signed-inner');
      await expect(readBackupText(file(encrypted), maxBytes, purpose, password)).resolves.toBe(
        source,
      );
    },
  );

  test('uses a fresh random salt and nonce for each download', async () => {
    const first = parseEnvelope(await encryptBackupText(source, password, 'snapshot', maxBytes));
    const second = parseEnvelope(await encryptBackupText(source, password, 'snapshot', maxBytes));
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  test('rejects wrong passwords, damaged ciphertext and authenticated metadata tampering', async () => {
    const encrypted = await encryptBackupText(source, password, 'snapshot', maxBytes);
    const envelope = parseEnvelope(encrypted);
    await expect(
      readBackupText(file(encrypted), maxBytes, 'snapshot', 'wrong password long enough'),
    ).rejects.toThrow('Could not decrypt');
    const ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    await expect(
      readBackupText(changed(encrypted, { ciphertext }), maxBytes, 'snapshot', password),
    ).rejects.toThrow('Could not decrypt');
    const nonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(4)));
    await expect(
      readBackupText(changed(encrypted, { nonce }), maxBytes, 'snapshot', password),
    ).rejects.toThrow('Could not decrypt');
    await expect(
      readBackupText(changed(encrypted, { purpose: 'chunk' }), maxBytes, 'chunk', password),
    ).rejects.toThrow('Could not decrypt');
    await expect(readBackupText(file(encrypted), maxBytes, 'manifest', password)).rejects.toThrow(
      'header',
    );
  });

  test('validates fixed algorithms, KDF work, unknown fields and encoded lengths before derivation', async () => {
    const encrypted = await encryptBackupText(source, password, 'snapshot', maxBytes);
    const derive = jest.spyOn(crypto.subtle, 'deriveKey');
    try {
      for (const fields of [
        { version: 2 },
        { iterations: 1 },
        { iterations: 999_999_999 },
        { cipher: 'AES-CBC' },
        { kdf: 'PBKDF2-SHA1' },
        { format: 'broken' },
        { salt: 'AA==' },
        { nonce: 'AA==' },
        { ciphertext: 'AA==' },
        { plaintextBytes: -1 },
        { plaintextBytes: maxBytes + 1 },
        { unexpected: 'ignored metadata would be unsafe' },
      ])
        await expect(
          readBackupText(changed(encrypted, fields), maxBytes, 'snapshot', password),
        ).rejects.toThrow();
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });

  test('allows encrypted overhead but enforces the original plaintext bound', async () => {
    const text = JSON.stringify({ memory: 'a'.repeat(200) });
    const bytes = file(text).size;
    const encrypted = await encryptBackupText(text, password, 'snapshot', bytes);
    expect(file(encrypted).size).toBeGreaterThan(bytes);
    expect(file(encrypted).size).toBeLessThanOrEqual(encryptedBackupFileLimit(bytes));
    await expect(readBackupText(file(encrypted), bytes, 'snapshot', password)).resolves.toBe(text);
    await expect(readBackupText(file(encrypted), bytes - 1, 'snapshot', password)).rejects.toThrow(
      'header',
    );
    await expect(readBackupText(file(text), bytes - 1, 'snapshot')).rejects.toThrow(
      'plaintext size',
    );
  });

  test('roundtrips the maximum 5 MiB plaintext part without unbounded base64 spread or regex recursion', async () => {
    const limit = 5 * 1024 * 1024;
    const text = '{"memory":"' + 'a'.repeat(limit - 13) + '"}';
    expect(file(text).size).toBe(limit);
    const encrypted = await encryptBackupText(text, password, 'snapshot', limit);
    await expect(readBackupText(file(encrypted), limit, 'snapshot', password)).resolves.toBe(text);
  });

  test('rejects oversized files before reading, and dishonest file sizes after reading', async () => {
    const text = jest.fn(() => Promise.resolve('{}'));
    await expect(
      readBackupText({ size: encryptedBackupFileLimit(maxBytes) + 1, text }, maxBytes, 'snapshot'),
    ).rejects.toThrow('size');
    expect(text).not.toHaveBeenCalled();
    await expect(
      readBackupText(
        { size: 2, text: () => Promise.resolve('a'.repeat(encryptedBackupFileLimit(10) + 1)) },
        10,
        'snapshot',
      ),
    ).rejects.toThrow('size');
  });

  test('keeps legacy plaintext untouched without requiring browser crypto or a password', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      await expect(readBackupText(file(source), maxBytes, 'snapshot')).resolves.toBe(source);
      await expect(encryptBackupText(source, password, 'snapshot', maxBytes)).rejects.toThrow(
        'secure browser context',
      );
      for (const text of ['null', '[]', '"data"', '{broken'])
        await expect(readBackupText(file(text), maxBytes, 'snapshot')).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  test('preserves Unicode memory and whitespace as UTF-8 without JSON reserialization', async () => {
    const text = ' {"memory":"\u8bb0\u5fc6 \ud83c\udf32"}\n';
    const encrypted = await encryptBackupText(text, password, 'snapshot', maxBytes);
    await expect(readBackupText(file(encrypted), maxBytes, 'snapshot', password)).resolves.toBe(
      text,
    );
  });

  test('requires strong bounded passphrases and supported limits', async () => {
    expect(validBackupPassphrase('short')).toBe(false);
    expect(validBackupPassphrase('x'.repeat(1025))).toBe(false);
    expect(validBackupPassphrase('界'.repeat(342))).toBe(false);
    expect(validBackupPassphrase(password)).toBe(true);
    await expect(encryptBackupText(source, 'short', 'snapshot', maxBytes)).rejects.toThrow(
      'passphrase',
    );
    await expect(
      encryptBackupText(source, password, 'snapshot', 5 * 1024 * 1024 + 1),
    ).rejects.toThrow('limit');
  });
});
