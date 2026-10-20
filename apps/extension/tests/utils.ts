import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function readFixture(name: string): string {
  const p = resolve(__dirname, 'fixtures', name);
  return readFileSync(p, 'utf8');
}
