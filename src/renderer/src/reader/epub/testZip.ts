/**
 * Builds a zip archive in memory, for tests. Not used by the application.
 */
export interface TestFile {
  readonly name: string;
  readonly data: Uint8Array | string;
  /** The same data already deflated (see `deflate`); without it the file is stored as it is. */
  readonly deflated?: Uint8Array;
  /** Mark the entry as password-protected. */
  readonly encrypted?: boolean;
}

/** Deflates data the way a zip archive holds it. */
export const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
    .getReader();
  const chunks: number[] = [];

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return new Uint8Array(chunks);
    }

    chunks.push(...value);
  }
};

export const makeZip = (files: readonly TestFile[]): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const body = file.deflated ?? raw;
    const method = file.deflated === undefined ? 0 : 8;
    const flags = file.encrypted === true ? 1 : 0;

    const local = new Uint8Array(30 + name.length + body.length);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);

    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(8, flags, true);
    entryView.setUint16(10, method, true);
    entryView.setUint32(20, body.length, true);
    entryView.setUint32(24, raw.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);

    locals.push(local);
    directory.push(entry);
    offset += local.length;
  }

  const directorySize = directory.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const out = new Uint8Array(offset + directorySize + 22);
  let at = 0;

  for (const part of [...locals, ...directory, end]) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};
