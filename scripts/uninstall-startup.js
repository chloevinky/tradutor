// Removes the Tradutor startup shortcut. Run: npm run uninstall-startup
import fs from 'fs';
import path from 'path';

if (process.platform !== 'win32') {
  console.error('uninstall-startup only works on Windows.');
  process.exit(1);
}

const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Tradutor.lnk');

if (fs.existsSync(shortcut)) {
  fs.unlinkSync(shortcut);
  console.log('Removed ' + shortcut);
} else {
  console.log('No startup shortcut found — nothing to do.');
}
