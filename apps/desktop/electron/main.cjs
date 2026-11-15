// macOS app shell. The engine is a separate Node process (browser
// scenarios, MCP, export); the window is only a GUI over its local API.
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// Packaged, the engine, GUI and demo project sit in the app's resources and
// Electron itself runs the engine as Node; from a checkout, the repo's Node does.
const packaged = app.isPackaged;
const root = packaged ? path.join(process.resourcesPath, 'engine') : path.resolve(__dirname, '../../..');
const cli = packaged ? path.join(root, 'src/cli.ts') : path.join(root, 'packages/engine/src/cli.ts');
const preferredPort = Number(process.env.TC_PORT ?? 4317);
const workspace = path.resolve(process.env.TC_WORKSPACE ?? (packaged ? path.join(app.getPath('documents'), 'Test Cartographer', 'Demo shop') : path.join(root, 'workspace')));
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
    const env = packaged
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', TC_GUI_DIR: path.join(process.resourcesPath, 'gui') }
      : { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
    engine = spawn(packaged ? process.execPath : (process.env.TC_NODE ?? 'node'), [cli, 'serve', '--port', String(port), '--ws', workspace], { cwd: root, env });
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

// The packaged app ships the demo shop (next to the engine, to share its
// dependencies) and runs it while the demo project is open.
const shop = path.join(root, 'demo-shop');
const demoOpen = packaged && !process.env.TC_WORKSPACE;
let shopServer;

function edit(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`Couldn't set up the demo project: ${path.basename(file)} has changed.`);
  fs.writeFileSync(file, text.replace(from, to));
}

// First launch of the packaged app: copy in the demo project, pointed at the
// shop inside the app instead of the repo checkout it was written for.
// shortcut: paths are the app's location on first launch; moving the app later breaks the demo's MCP, delete the demo folder to redo it.
function ensureWorkspace() {
  if (!demoOpen || fs.existsSync(path.join(workspace, 'cartographer.yaml'))) return;
  fs.cpSync(path.join(process.resourcesPath, 'demo'), workspace, { recursive: true });
  const q = JSON.stringify;
  edit(path.join(workspace, 'cartographer.yaml'), 'command: node\n    args: [../demo/shop/mcp.ts]\n    env:\n',
    `command: ${q(process.execPath)}\n    args: [${q(path.join(shop, 'mcp.ts'))}]\n    env:\n      ELECTRON_RUN_AS_NODE: "1"\n`);
  edit(path.join(workspace, 'sources.yaml'), 'path: ../demo/shop', `path: ${q(shop)}`);
}

// Test runs need Playwright's browser; this is a quick no-op once it's there.
function installBrowser() {
  if (!packaged) return;
  spawn(process.execPath, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
}

async function startShop() {
  if (!demoOpen || !(await portIsFree(4400))) return;
  shopServer = spawn(process.execPath, [path.join(shop, 'server.ts')], { cwd: shop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
}

async function engineUrl() {
  if (process.env.TC_UI_URL) return process.env.TC_UI_URL;
  ensureWorkspace();
  installBrowser();
  await startShop();
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
app.on('quit', () => {
  engine?.kill();
  shopServer?.kill();
});
