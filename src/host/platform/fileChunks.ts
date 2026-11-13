import { open } from 'node:fs/promises';

/** Close on early return so coverage checks can stop at the first directive. */
export async function* readFileChunks(filePath: string): AsyncIterable<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
