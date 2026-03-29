import { readdirSync, readFileSync, writeFileSync } from 'fs';

const dir = new URL('../src/pages/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const files = readdirSync(dir).filter(f => f.endsWith('.js'));
let total = 0;

for (const f of files) {
  const path = dir + '/' + f;
  const before = readFileSync(path, 'utf8');
  const after = before.replaceAll(
    'src="/icons/white/target.png" alt="Search"',
    'src="/icons/white/search.png" alt="Search"'
  );
  const count = (before.match(/target\.png" alt="Search"/g) || []).length;
  if (count > 0) {
    writeFileSync(path, after);
    console.log(`${f}: ${count} replacements`);
    total += count;
  }
}
console.log(`Total: ${total}`);
