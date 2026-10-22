import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { STANDARD_FONTS } from './standard-fonts';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

const pdfModules = sourceFiles(SRC).filter((file) =>
  /from 'pdfkit'/.test(readFileSync(file, 'utf8')),
);

describe('standard PDF fonts', () => {
  it('finds the modules that draw PDFs', () => {
    expect(pdfModules.length).toBeGreaterThan(0);
  });

  it('lists every built-in font a PDF uses, including the default one', () => {
    const used = new Set<string>(['Helvetica']);
    for (const file of pdfModules) {
      for (const [, args] of readFileSync(file, 'utf8').matchAll(/\.font\(([^)]*)\)/g)) {
        for (const [, name] of args.matchAll(/'([^']+)'/g)) used.add(name);
      }
    }
    expect([...used].sort()).toEqual([...STANDARD_FONTS].sort());
  });

  it('loads them from every module that draws a PDF', () => {
    for (const file of pdfModules) {
      expect({ file, source: readFileSync(file, 'utf8') }).toEqual({
        file,
        source: expect.stringMatching(/import '(\.\.\/)+common\/pdf\/standard-fonts';/),
      });
    }
  });

  it('requires each listed font where a file tracer can follow it', () => {
    const source = readFileSync(path.join(__dirname, 'standard-fonts.ts'), 'utf8');
    for (const font of STANDARD_FONTS) {
      const module = `pdfkit/standard-fonts/${font.replace(/-/g, '')}`;
      expect(source).toContain(`import '${module}';`);
      expect(() => require.resolve(module)).not.toThrow();
    }
  });
});
