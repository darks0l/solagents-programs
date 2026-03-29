import { readdirSync, readFileSync, writeFileSync } from 'fs';

const dir = new URL('../src/pages/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const files = readdirSync(dir).filter(f => f.endsWith('.js'));
let total = 0;

for (const f of files) {
  const path = dir + '/' + f;
  const before = readFileSync(path, 'utf8');
  const after = before.replaceAll(
    'src="/icons/white/crown.png" alt="Graduated"',
    'src="/icons/white/rocket.png" alt="Graduated"'
  );
  const count = (before.match(/crown\.png" alt="Graduated"/g) || []).length;
  if (count > 0) {
    writeFileSync(path, after);
    console.log(`${f}: ${count} replacements`);
    total += count;
  }
}
console.log(`Total: ${total}`);
