import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * Streams the first entry of a zip archive without writing it to disk. Enough for the USDA
 * download, which is a single deflated JSON file; avoids a zip dependency and a 3 GB temp file.
 */
export async function unzipFirstEntry(src: AsyncIterable<Buffer | Uint8Array>): Promise<Readable> {
  const it = src[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  const need = async (n: number) => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) throw new Error('zip: truncated header');
      buf = Buffer.concat([buf, Buffer.from(r.value)]);
    }
  };
  await need(30);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('zip: not a zip file');
  const method = buf.readUInt16LE(8);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  await need(start);
  if (method !== 8 && method !== 0) throw new Error(`zip: unsupported compression method ${method}`);
  const first = buf.subarray(start);
  async function* rest() {
    if (first.length) yield first;
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      yield Buffer.from(r.value);
    }
  }
  const body = Readable.from(rest());
  if (method === 0) return body; // stored; trailing central directory lines are skipped by the line parser
  const inflate = zlib.createInflateRaw();
  body.on('error', (e) => inflate.destroy(e));
  return body.pipe(inflate);
}
