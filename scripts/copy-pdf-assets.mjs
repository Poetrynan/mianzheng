import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const destination = path.resolve(import.meta.dirname, '../apps/web/public/pdfjs');
mkdirSync(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts']) {
  cpSync(path.join(packageRoot, name), path.join(destination, name), { recursive: true });
}
console.log('PDF character maps and standard fonts copied from the installed package.');
