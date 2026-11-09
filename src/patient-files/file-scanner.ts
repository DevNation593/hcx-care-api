import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';

export const FILE_SCANNER = Symbol('FILE_SCANNER');

export type ScanResult =
  | { status: 'CLEAN'; engine: string }
  | { status: 'INFECTED'; engine: string; signature: string }
  | { status: 'NOT_SCANNED' };

/** Looks for malware in the bytes of a file before anyone can read it. */
export interface FileScanner {
  /** False when no antivirus is configured: files are then stored as NOT_SCANNED. */
  readonly enabled: boolean;
  /** Throws 503 FILE_SCAN_UNAVAILABLE when the antivirus cannot answer: nothing is stored then. */
  scan(bytes: Buffer): Promise<ScanResult>;
}

export const fileScanUnavailable = () =>
  new ServiceUnavailableException({
    statusCode: 503,
    code: 'FILE_SCAN_UNAVAILABLE',
    message:
      'No fue posible analizar el archivo con el antivirus. Inténtalo de nuevo en unos minutos.',
  });

/** Used when FILE_SCAN_DRIVER is not set: every file is recorded as not scanned. */
export class NoFileScanner implements FileScanner {
  readonly enabled = false;
  async scan(): Promise<ScanResult> {
    return { status: 'NOT_SCANNED' };
  }
}

/** Bytes per INSTREAM chunk; clamd accepts any size up to its StreamMaxLength in total. */
const CHUNK_BYTES = 64 * 1024;

/**
 * ClamAV through its daemon (clamd) over TCP, with the INSTREAM command: the bytes go to clamd in
 * length-prefixed chunks and never touch a disk on this side. The answer is `stream: OK`,
 * `stream: <signature> FOUND`, or an error, which is treated as "could not scan".
 */
export class ClamdScanner implements FileScanner {
  readonly enabled = true;
  private engine: string | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  async scan(bytes: Buffer): Promise<ScanResult> {
    let answer: string;
    try {
      answer = await this.command('zINSTREAM\0', bytes);
    } catch {
      throw fileScanUnavailable();
    }
    const engine = await this.version();
    if (/^stream: OK$/.test(answer)) return { status: 'CLEAN', engine };
    const found = /^stream: (.+) FOUND$/.exec(answer);
    if (found) return { status: 'INFECTED', engine, signature: found[1] };
    // "INSTREAM size limit exceeded", "... ERROR": the file was not scanned.
    throw fileScanUnavailable();
  }

  /** "ClamAV 1.4.1/27450", without the date of the signature database. */
  private async version(): Promise<string> {
    if (this.engine) return this.engine;
    try {
      const raw = await this.command('zVERSION\0');
      this.engine = raw.split('/').slice(0, 2).join('/') || 'ClamAV';
    } catch {
      return 'ClamAV';
    }
    return this.engine;
  }

  /** Sends one command (with the stream, for INSTREAM) and returns the answer without its NUL. */
  private command(command: string, stream?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };

      socket.setTimeout(this.timeoutMs, () => finish(new Error('clamd timed out')));
      socket.on('error', (error) => finish(error));
      socket.on('data', (data) => {
        chunks.push(data);
        const text = Buffer.concat(chunks).toString('utf8');
        const end = text.indexOf('\0');
        if (end >= 0) finish(null, text.slice(0, end).trim());
      });
      socket.on('end', () =>
        finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()),
      );

      socket.connect(this.port, this.host, () => {
        socket.write(command);
        if (stream) {
          for (let offset = 0; offset < stream.length; offset += CHUNK_BYTES) {
            const chunk = stream.subarray(offset, offset + CHUNK_BYTES);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length, 0);
            socket.write(size);
            socket.write(chunk);
          }
          // A zero-length chunk ends the stream.
          socket.write(Buffer.alloc(4));
        }
      });
    });
  }
}

/**
 * FILE_SCAN_DRIVER=clamav scans every patient file with clamd (CLAMAV_HOST, CLAMAV_PORT 3310,
 * FILE_SCAN_TIMEOUT_MS 30000). Without it files are stored as NOT_SCANNED, and production says so
 * in its log at start. A driver set but incomplete stops the API from starting.
 */
export function createFileScanner(config: ConfigService): FileScanner {
  const driver = (config.get<string>('FILE_SCAN_DRIVER') ?? '').trim().toLowerCase();
  if (!driver || driver === 'none') {
    if (config.get<string>('NODE_ENV') === 'production') {
      new Logger('FileScanner').warn(
        'FILE_SCAN_DRIVER is not set: patient files are stored without an antivirus scan',
      );
    }
    return new NoFileScanner();
  }
  if (driver !== 'clamav') {
    throw new Error(`FILE_SCAN_DRIVER "${driver}" is not supported (use "clamav")`);
  }
  const host = config.get<string>('CLAMAV_HOST')?.trim();
  if (!host) throw new Error('CLAMAV_HOST is required when FILE_SCAN_DRIVER=clamav');
  const port = Number(config.get<string>('CLAMAV_PORT') ?? 3310);
  const timeoutMs = Number(config.get<string>('FILE_SCAN_TIMEOUT_MS') ?? 30000);
  if (!Number.isInteger(port) || port <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CLAMAV_PORT and FILE_SCAN_TIMEOUT_MS must be positive numbers');
  }
  return new ClamdScanner(host, port, timeoutMs);
}
