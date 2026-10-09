export async function readArchiveJson(
  file: Pick<File, 'size' | 'text'>,
  maxBytes: number,
): Promise<unknown> {
  if (file.size > maxBytes)
    throw new Error('The selected file exceeds the supported size for this archive part.');
  const value: unknown = JSON.parse(await file.text());
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose an exported JSON object.');
  return value;
}

type ArchiveWritable = {
  write: (text: string) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};
export type ArchiveDirectory = {
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<{ createWritable: () => Promise<ArchiveWritable> }>;
};
type DirectoryWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<ArchiveDirectory>;
};
export function supportsArchiveDirectory() {
  return typeof (window as DirectoryWindow).showDirectoryPicker === 'function';
}
export async function selectArchiveDirectory() {
  const picker = (window as DirectoryWindow).showDirectoryPicker;
  if (!picker)
    throw new Error(
      'Folder downloads are unavailable in this browser. Download the manifest and chunks separately.',
    );
  return picker.call(window, { mode: 'readwrite' });
}
export async function writeArchivePart(
  directory: ArchiveDirectory,
  filename: string,
  value: unknown,
) {
  return writeArchiveText(directory, filename, JSON.stringify(value));
}

export async function writeArchiveText(
  directory: ArchiveDirectory,
  filename: string,
  json: string,
) {
  const handle = await directory.getFileHandle(filename, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(json);
    await stream.close();
  } catch (error) {
    try {
      await stream.abort();
    } catch {
      // Preserve the original write failure even if the failed stream cannot be aborted.
    }
    throw error;
  }
}

export function validRecoveryPassphrase(value: string) {
  return value.length >= 12 && new TextEncoder().encode(value).length <= 1024;
}
