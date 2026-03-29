/**
 * Swap emoji → white 3D icon <img> tags across all page files.
 * Uses class="icon" which scales via 1em to match parent font-size.
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PAGES = join(import.meta.dirname, '..', 'src', 'pages');
const PREFIX = '/icons/white';

// Helper: build img tag
const i = (name, alt) =>
  `<img class="icon" src="${PREFIX}/${name}.png" alt="${alt}">`;

// Emoji → [iconName, alt]
// Order: longer sequences first, compound emoji before singles
const MAP = [
  // Compound emoji (with variation selectors)
  ['⚙️', 'gear', 'Settings'],
  ['🛡️', 'shield', 'Shield'],
  ['⚠️', 'shield', 'Warning'],
  ['🖼️', 'image', 'Image'],
  ['🖥️', 'monitor', 'System'],
  ['✏️', 'document', 'Edit'],
  ['🛠️', 'tools', 'Tools'],
  ['✉️', 'chat', 'Message'],
  ['🖊️', 'document', 'Write'],
  ['✍️', 'document', 'Write'],
  ['🖨️', 'gear', 'Mint'],

  // Standard emoji
  ['🔐', 'lock', 'Lock'],
  ['🔒', 'lock', 'Lock'],
  ['🔓', 'lock', 'Unlock'],
  ['👥', 'person', 'Users'],
  ['👤', 'person', 'User'],
  ['🪙', 'coin-flat', 'Token'],
  ['🔄', 'gear', 'Refresh'],
  ['🎓', 'trophy', 'Graduated'],
  ['💳', 'credit-card', 'Card'],
  ['🏥', 'shield', 'Health'],
  ['🤖', 'gear', 'Agent'],
  ['📝', 'document', 'Document'],
  ['💻', 'monitor', 'Code'],
  ['📊', 'chart', 'Chart'],
  ['🌐', 'chain', 'Web'],
  ['🎨', 'image', 'Creative'],
  ['🔍', 'target', 'Search'],
  ['🔎', 'target', 'Review'],
  ['🔧', 'tools', 'Tools'],
  ['📋', 'folder', 'List'],
  ['📈', 'chart', 'Chart'],
  ['💡', 'lightning', 'Tip'],
  ['📌', 'pin', 'Pinned'],
  ['💬', 'chat', 'Chat'],
  ['❓', 'chat', 'Help'],
  ['🚀', 'fire', 'Launch'],
  ['⚡', 'lightning', 'Fast'],
  ['🔗', 'chain', 'Link'],
  ['🧠', 'gear', 'Brain'],
  ['🧪', 'tools', 'Test'],
  ['📦', 'folder', 'Package'],
  ['🛒', 'credit-card', 'Shop'],
  ['🤝', 'chat-double', 'Fair'],
  ['💰', 'coin-tilt', 'Money'],
  ['📡', 'target', 'Verified'],
  ['🔥', 'fire', 'Fire'],
  ['✅', 'checkmark', 'Yes'],
  ['❌', 'plus', 'No'],
  ['🏦', 'safe', 'Bank'],
  ['✨', 'star', 'Special'],
  ['🧊', 'lock', 'Freeze'],
  ['💸', 'coin-tilt', 'Payout'],
  ['🌊', 'chart', 'Market'],
  ['🧾', 'document', 'Receipt'],
  ['💵', 'coin-tilt', 'Revenue'],
  ['🔌', 'chain', 'Connect'],
  ['🌑', 'skull', 'DARKSOL'],
  ['📚', 'document', 'Docs'],
  ['📄', 'document', 'Paper'],
  ['📭', 'folder', 'Empty'],
  ['🪝', 'chain', 'Hook'],
  ['🎉', 'trophy', 'Celebrate'],
  ['🖥', 'monitor', 'System'],
  ['💼', 'wallet', 'Wallet'],
  ['🔍', 'target', 'Search'],
  ['✈', 'target', 'Telegram'],
  ['🔑', 'key', 'Key'],
  ['👑', 'crown', 'Crown'],
  ['🏆', 'trophy', 'Trophy'],
  ['📝', 'document', 'Document'],
  ['🎯', 'target', 'Target'],
  ['⭐', 'star', 'Star'],

  // Special: ratings star (plain ★ char)
  ['★', 'star', 'Rating'],
];

// Files to skip replacement in certain patterns
const SKIP_PATTERNS = [
  /✕/,  // Close buttons - keep as text
  /✗/,  // Reject markers - keep as text
  /✓(?! )/,  // Bare checkmarks in tight status text, but allow "✓ Uploaded"
];

// Build regex from map
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let stats = { files: 0, replacements: 0 };

for (const file of readdirSync(PAGES).filter(f => f.endsWith('.js'))) {
  let content = readFileSync(join(PAGES, file), 'utf8');
  let fileCount = 0;

  for (const [emoji, iconName, alt] of MAP) {
    const tag = i(iconName, alt);
    const re = new RegExp(escRe(emoji), 'g');
    const matches = content.match(re);
    if (matches) {
      content = content.replace(re, tag);
      fileCount += matches.length;
    }
  }

  if (fileCount > 0) {
    writeFileSync(join(PAGES, file), content, 'utf8');
    console.log(`  ${file}: ${fileCount} replacements`);
    stats.files++;
    stats.replacements += fileCount;
  }
}

console.log(`\nDone: ${stats.replacements} emoji swapped across ${stats.files} files.`);

// Now handle the ✓ checkmarks that are followed by text (not bare ✓ in badges)
// These are like "✓ Uploaded to IPFS" → checkmark icon
for (const file of readdirSync(PAGES).filter(f => f.endsWith('.js'))) {
  let content = readFileSync(join(PAGES, file), 'utf8');
  let count = 0;

  // ✓ followed by space+text → checkmark icon
  const re = /✓(?= [A-Z])/g;
  const m = content.match(re);
  if (m) {
    content = content.replace(re, i('checkmark', 'Done'));
    count += m.length;
  }

  if (count > 0) {
    writeFileSync(join(PAGES, file), content, 'utf8');
    console.log(`  ${file}: ${count} checkmark (✓) swaps`);
    stats.replacements += count;
  }
}

// Handle 🟢/🔴 buy/sell indicators - replace with colored text instead of icons
// Actually these look fine as emoji in a trading context, skip them.

console.log(`\nFinal total: ${stats.replacements} replacements.`);
