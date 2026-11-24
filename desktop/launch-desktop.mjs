import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const configDir = path.join(os.homedir(), '.kettler-mes');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}
const dbConfigPath = path.join(configDir, 'db-config.json');
const port = Number(process.env.PORT) || 3000;
const appUrl = `http://127.0.0.1:${port}`;

const hasDist = fs.existsSync(path.join(rootDir, 'dist', 'index.html'));
const tsxBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const child = spawn(tsxBin, ['server.ts'], {
  cwd: rootDir,
  env: {
    ...process.env,
    NODE_ENV: hasDist ? 'production' : 'development',
    DISABLE_HMR: 'true',
    PORT: String(port),
    KETTLER_DB_CONFIG_PATH: process.env.KETTLER_DB_CONFIG_PATH || dbConfigPath,
  },
  stdio: 'inherit',
});

function waitForReady(attempts = 60) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const poll = () => {
      const req = http.get(`${appUrl}/api/auth/status`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        left -= 1;
        if (left <= 0) {
          reject(new Error('Manufacturing Execution System desktop server did not start in time.'));
          return;
        }
        setTimeout(poll, 250);
      });
    };
    poll();
  });
}

function openStandaloneWindow(url) {
  if (process.platform === 'win32') {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const browser = edgePaths.find((p) => fs.existsSync(p));
    if (browser) {
      spawn(browser, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const bin = fs.existsSync(edge) ? edge : fs.existsSync(chrome) ? chrome : null;
    if (bin) {
      spawn(bin, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

waitForReady()
  .then(() => {
    console.log(`Manufacturing Execution System Desktop running at ${appUrl}`);
    console.log(`SQL IP config stored at: ${dbConfigPath}`);
    openStandaloneWindow(appUrl);
  })
  .catch((err) => {
    console.error(err.message);
    child.kill();
    process.exit(1);
  });

process.on('SIGINT', () => {
  child.kill();
  process.exit(0);
});
process.on('SIGTERM', () => {
  child.kill();
  process.exit(0);
});
