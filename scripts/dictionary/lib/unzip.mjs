/**
 * The smallest zip reader that can open the Open English WordNet archive.
 *
 * The build pipeline must not need a system `unzip`, and adding a dependency
 * to unpack one pinned, checksum-verified archive would not pass the
 * dependency policy in AGENTS.md section 5. Only what that archive uses is
 * implemented: stored and deflated entries, read through the central
 * directory, with the CRC verified.
 */

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const findEndOfCentralDirectory = (buffer) => {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  throw new Error('not a zip archive: end of central directory not found');
};

/**
 * Lists the archive's files.
 *
 * @param {Buffer} buffer the whole archive
 * @returns {{ name: string, read: () => Buffer }[]}
 */
export const readZip = (buffer) => {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  const files = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error('corrupt zip archive: bad central directory header');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    files.push({
      name,
      read: () => {
        if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
          throw new Error(`corrupt zip archive: bad local header for ${name}`);
        }

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(start, start + compressedSize);
        const contents = method === 0 ? raw : inflateRawSync(raw);

        if (contents.length !== uncompressedSize) {
          throw new Error(`corrupt zip archive: ${name} has the wrong length`);
        }

        if (crc32(contents) !== crc) {
          throw new Error(`corrupt zip archive: ${name} failed its CRC check`);
        }

        return contents;
      },
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
};
