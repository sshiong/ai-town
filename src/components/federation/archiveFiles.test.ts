import { jest } from '@jest/globals';
import {
  readArchiveJson,
  validRecoveryPassphrase,
  writeArchivePart,
  writeArchiveText,
} from './archiveFiles';

describe('archive file safety', () => {
  test('rejects an oversized part before reading its content', async () => {
    const text = jest.fn(async () => '{}');
    await expect(readArchiveJson({ size: 65537, text }, 65536)).rejects.toThrow('size');
    expect(text).not.toHaveBeenCalled();
  });
  test.each(['[]', 'null', '"archive"', '{invalid'])(
    'rejects invalid archive object %s',
    async (value) => {
      await expect(
        readArchiveJson({ size: value.length, text: async () => value }, 65536),
      ).rejects.toThrow();
    },
  );
  test('preserves the unverified object for server authentication', async () => {
    await expect(
      readArchiveJson({ size: 18, text: async () => '{"signature":"x"}' }, 65536),
    ).resolves.toEqual({ signature: 'x' });
  });
  test('checks both the character minimum and UTF-8 byte maximum', () => {
    expect(validRecoveryPassphrase('12345678901')).toBe(false);
    expect(validRecoveryPassphrase('123456789012')).toBe(true);
    expect(validRecoveryPassphrase('x'.repeat(1024))).toBe(true);
    expect(validRecoveryPassphrase('x'.repeat(1025))).toBe(false);
    expect(validRecoveryPassphrase('备'.repeat(342))).toBe(false);
    expect(validRecoveryPassphrase('备'.repeat(341))).toBe(true);
  });
  test('writes encoded chunk JSON as an object file without double encoding', async () => {
    const json = '{"rows":[{"$bytes":"AA==","$float":"x"}]}';
    const stream = {
      write: jest.fn(async (_value: string) => {}),
      close: jest.fn(async () => {}),
      abort: jest.fn(async () => {}),
    };
    const directory = { getFileHandle: async () => ({ createWritable: async () => stream }) };
    await writeArchiveText(directory, 'chunk-000001.json', json);
    expect(stream.write).toHaveBeenCalledWith(json);
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
  test('aborts a failed folder write and propagates the original error', async () => {
    const error = new Error('disk full');
    const stream = {
      write: jest.fn(async () => {
        throw error;
      }),
      close: jest.fn(async () => {}),
      abort: jest.fn(async () => {
        throw new Error('stream unavailable');
      }),
    };
    const directory = {
      getFileHandle: jest.fn(async () => ({ createWritable: async () => stream })),
    };
    await expect(writeArchivePart(directory, 'chunk-000001.json', { index: 1 })).rejects.toBe(
      error,
    );
    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(stream.close).not.toHaveBeenCalled();
  });
});
