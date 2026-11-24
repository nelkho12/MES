const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

let serverProc = null;
let mainWindow = null;

function findOpenPort(preferred = 3000) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => {
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address();
        fallback.close(() => resolve(addr.port));
      });
    });
    tester.listen(preferred, '127.0.0.1', () => {
      tester.close(() => resolve(preferred));
    });
  });
}

function waitForServer(port, attempts = 60) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/auth/status`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        remaining -= 1;
        if (remaining <= 0) {
          reject(new Error('Timed out waiting for Manufacturing Execution System desktop backend.'));
          return;
        }
        setTimeout(check, 250);
      });
    };
    check();
  });
}

async function bootDesktop() {
  const rootDir = path.resolve(__dirname, '..');
  const port = await findOpenPort(3000);
  const configFile = path.join(app.getPath('userData'), 'kettler-db-config.json');

  const tsxBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );

  serverProc = spawn(tsxBin, ['server.ts'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      KETTLER_DB_CONFIG_PATH: configFile,
    },
    stdio: 'inherit',
  });

  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Manufacturing Execution System',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  bootDesktop().catch((err) => {
    console.error('Failed to launch Manufacturing Execution System desktop:', err);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill();
  }
  app.quit();
});
