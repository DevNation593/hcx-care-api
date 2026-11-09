import { ConfigService } from '@nestjs/config';
import { AddressInfo, createServer, Server, Socket } from 'net';
import { ClamdScanner, createFileScanner, NoFileScanner } from './file-scanner';

/** Reads an INSTREAM request: the command, then length-prefixed chunks until a zero length. */
function parseInstream(data: Buffer): Buffer | null {
  const command = 'zINSTREAM\0';
  if (data.subarray(0, command.length).toString() !== command) return null;
  const chunks: Buffer[] = [];
  let offset = command.length;
  while (offset + 4 <= data.length) {
    const size = data.readUInt32BE(offset);
    offset += 4;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size > data.length) return null;
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return null;
}

/** A clamd that answers FOUND for the EICAR test string and OK for anything else. */
function fakeClamd(options: { silent?: boolean } = {}) {
  const received: Buffer[] = [];
  const server: Server = createServer((socket: Socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (options.silent) return;
      if (data.toString() === 'zVERSION\0') {
        socket.end('ClamAV 1.4.1/27450/Sat Nov  7 08:00:00 2026\0');
        return;
      }
      const stream = parseInstream(data);
      if (!stream) return;
      received.push(stream);
      socket.end(
        stream.toString().includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')
          ? 'stream: Eicar-Test-Signature FOUND\0'
          : 'stream: OK\0',
      );
    });
  });
  return {
    received,
    start: () =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      ),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('ClamdScanner', () => {
  it('streams the bytes in chunks and reads a clean answer with the engine', async () => {
    const clamd = fakeClamd();
    const port = await clamd.start();
    try {
      // Larger than one chunk, so the stream is split and put back together.
      const bytes = Buffer.alloc(150 * 1024, 7);

      const result = await new ClamdScanner('127.0.0.1', port, 5000).scan(bytes);

      expect(result).toEqual({ status: 'CLEAN', engine: 'ClamAV 1.4.1/27450' });
      expect(clamd.received[0].equals(bytes)).toBe(true);
    } finally {
      await clamd.stop();
    }
  });

  it('reports the signature of an infected file', async () => {
    const clamd = fakeClamd();
    const port = await clamd.start();
    try {
      const eicar = Buffer.from(
        'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
      );

      await expect(new ClamdScanner('127.0.0.1', port, 5000).scan(eicar)).resolves.toMatchObject({
        status: 'INFECTED',
        signature: 'Eicar-Test-Signature',
      });
    } finally {
      await clamd.stop();
    }
  });

  it('answers 503 when clamd does not answer or cannot be reached', async () => {
    const silent = fakeClamd({ silent: true });
    const port = await silent.start();
    try {
      await expect(
        new ClamdScanner('127.0.0.1', port, 200).scan(Buffer.from('x')),
      ).rejects.toMatchObject({ status: 503, response: { code: 'FILE_SCAN_UNAVAILABLE' } });
    } finally {
      await silent.stop();
    }
    await expect(
      new ClamdScanner('127.0.0.1', port, 200).scan(Buffer.from('x')),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('createFileScanner', () => {
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  it('scans nothing without a driver', () => {
    expect(createFileScanner(config({}))).toBeInstanceOf(NoFileScanner);
    expect(createFileScanner(config({ FILE_SCAN_DRIVER: 'none' })).enabled).toBe(false);
  });

  it('uses clamd with its host, and refuses an incomplete or unknown driver', () => {
    expect(
      createFileScanner(config({ FILE_SCAN_DRIVER: 'clamav', CLAMAV_HOST: 'clamav.internal' })),
    ).toBeInstanceOf(ClamdScanner);
    expect(() => createFileScanner(config({ FILE_SCAN_DRIVER: 'clamav' }))).toThrow(/CLAMAV_HOST/);
    expect(() => createFileScanner(config({ FILE_SCAN_DRIVER: 'virustotal' }))).toThrow(
      /not supported/,
    );
  });
});
