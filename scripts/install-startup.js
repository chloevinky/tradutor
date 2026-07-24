// Registers Tradutor to run at Windows login by dropping a shortcut to
// start.vbs into the user's shell:startup folder. Run: npm run install-startup
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

if (process.platform !== 'win32') {
  console.error('install-startup only works on Windows. On other systems, use cron/systemd/launchd.');
  process.exit(1);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const shortcut = path.join(startupDir, 'Tradutor.lnk');
const target = path.join(ROOT, 'start.vbs');

const ps = [
  '$ws = New-Object -ComObject WScript.Shell;',
  `$s = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}');`,
  `$s.TargetPath = 'wscript.exe';`,
  `$s.Arguments = '"${target.replace(/'/g, "''")}"';`,
  `$s.WorkingDirectory = '${ROOT.replace(/'/g, "''")}';`,
  `$s.Description = 'Tradutor pt-BR/EN translator';`,
  '$s.Save()',
].join(' ');

execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
console.log(`Done. Tradutor will start silently at login.\nShortcut: ${shortcut}\nRemove it any time with: npm run uninstall-startup`);
