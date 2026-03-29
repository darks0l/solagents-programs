import { readFileSync, writeFileSync, readdirSync } from 'fs';

const tag = (name, alt) => `<img class="icon" src="/icons/white/${name}.png" alt="${alt}">`;

const EXTRAS = [
  ['⏰', 'clock', 'Clock'],
  ['⏳', 'clock', 'Loading'],
  ['⏱', 'clock', 'Time'],
];

const dir = '../src/pages';
let total = 0;

for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
  let content = readFileSync(`${dir}/${file}`, 'utf8');
  let count = 0;
  for (const [emoji, icon, alt] of EXTRAS) {
    const re = new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const m = content.match(re);
    if (m) {
      content = content.replaceAll(emoji, tag(icon, alt));
      count += m.length;
    }
  }
  if (count) {
    writeFileSync(`${dir}/${file}`, content);
    console.log(`${file}: ${count} fixes`);
    total += count;
  }
}
console.log(`Total: ${total}`);
