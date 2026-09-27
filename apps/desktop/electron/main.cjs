// macOS app shell. The engine is a separate Node process (browser
// scenarios, MCP, export); the window is only a GUI over its local API.
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const preferredPort = Number(process.env.TC_PORT ?? 4317);
const workspace = path.resolve(process.env.TC_WORKSPACE ?? path.join(root, 'workspace'));
let engine;

// An engine already serving the same workspace (for example, `pnpm tc serve`
// in a terminal) is reused instead of starting a second one.
async function runningEngine(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/project`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const { root: served } = await res.json();
    return path.resolve(served) === workspace;
  } catch {
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startEngine(port) {
  return new Promise((resolve, reject) => {
    let output = '';
    engine = spawn(process.env.TC_NODE ?? 'node', [path.join(root, 'packages/engine/src/cli.ts'), 'serve', '--port', String(port), '--ws', workspace], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    engine.stdout.on('data', (d) => {
      process.stdout.write(d);
      if (String(d).includes('engine:')) resolve();
    });
    engine.stderr.on('data', (d) => {
      output += d;
      process.stderr.write(d);
    });
    engine.on('error', (e) => reject(new Error(`Couldn't start the engine: ${e.message}. Check that Node.js 24+ is on your PATH or set TC_NODE.`)));
    engine.on('exit', (code) => {
      engine = undefined;
      reject(new Error(`The engine exited with code ${code}.\n\n${output.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

async function engineUrl() {
  if (process.env.TC_UI_URL) return process.env.TC_UI_URL;
  if (await runningEngine(preferredPort)) return `http://127.0.0.1:${preferredPort}`;
  const port = (await portIsFree(preferredPort)) ? preferredPort : await freePort();
  await startEngine(port);
  return `http://127.0.0.1:${port}`;
}

async function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#e6ecea',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  await win.loadURL(url);
}

app.whenReady().then(async () => {
  try {
    await createWindow(await engineUrl());
  } catch (e) {
    dialog.showErrorBox('Test Cartographer could not start', e.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => engine?.kill());
