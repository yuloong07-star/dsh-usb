'use strict';

// DSH USB — Electron shell around the DeepSeek Harness browser UI.
//
// What it does:
//   1. Boots the bundled dsh CLI ("dsh web") with a standalone Node runtime.
//   2. Waits until the web UI answers HTTP on 127.0.0.1:<free-port>.
//   3. Shows it in a native window; quits the server when the app exits.
//   4. Checks for official @deepseek-ai/dsh releases and, with the user's
//      consent, self-updates the agent (see updater.js).
//
// The dsh CLI is spawned with the bundled node.exe (vendor/node/node.exe in
// dev, resources/node/node.exe when packaged) so that prebuilt native
// modules (sharp, node-pty, koffi, ...) match the Node ABI they were
// installed for. We deliberately never rebuild them against Electron.

const { app, BrowserWindow, Menu, Tray, shell, dialog, Notification, ipcMain, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

const updater = require('./updater');
const { SessionWatcher, scanZstdFrames } = require('./session-watcher');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// H2/H3 路径围栏：文件还原/打开只允许「会话 cwd」之下的项目文件。
// 任意绝对路径（如写入 Startup\*.bat）一律拒绝；缓存 5 分钟。
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = /\.(bat|cmd|com|exe|ps1|vbs|lnk|js|jse|msi|scr|pif|reg)$/i;
const fileRootsCache = { at: 0, roots: [] };

function fileRoots() {
  if (Date.now() - fileRootsCache.at < 5 * 60 * 1000) return fileRootsCache.roots;
  const home = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const roots = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'session.jsonl.zstd') continue;
      try {
        const buf = fs.readFileSync(p);
        const { frames } = scanZstdFrames(buf);
        if (frames.length === 0) continue;
        const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
        const header = JSON.parse(text.split('\n', 1)[0]);
        if (header && typeof header.cwd === 'string' && header.cwd) roots.push(header.cwd);
      } catch { /* 跳过损坏日志 */ }
    }
  };
  walk(path.join(home, 'sessions'));
  fileRootsCache.roots = [...new Set(roots)];
  fileRootsCache.at = Date.now();
  return fileRootsCache.roots;
}

function isUnderFileRoots(p) {
  const resolved = path.resolve(p);
  return fileRoots().some((r) => {
    const rp = path.resolve(r);
    return resolved === rp || resolved.startsWith(rp + path.sep);
  });
}

const IS_WIN = process.platform === 'win32';

// DSH USB: redirect userData at module load time (before Chromium init) so
// nothing is ever written to %APPDATA%. Migrate the legacy layout FIRST so an
// empty dshusb/ (created by a previous crashed start) cannot block rename.
function isEmptyDataRoot(dir) {
  try {
    const ignore = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);
    return fs.readdirSync(dir).every((n) => ignore.has(n));
  } catch { return false; }
}

function renameQuiet(from, to, tag) {
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    fs.renameSync(from, to);
    try { log('boot', `迁移 ${tag}: ${from} → ${to}`); } catch {}
    return true;
  } catch (err) {
    try { log('boot', `迁移 ${tag} 失败: ${err.message}`); } catch {}
    return false;
  }
}

function migrateLegacyLayout(exeDir) {
  try {
    const oldRoot = path.join(exeDir, 'dsh');
    const newRoot = path.join(exeDir, 'dshusb');
    if (fs.existsSync(oldRoot)) {
      if (!fs.existsSync(newRoot)) {
        renameQuiet(oldRoot, newRoot, 'userData 根目录');
      } else if (isEmptyDataRoot(newRoot)) {
        try {
          fs.rmSync(newRoot, { recursive: true, force: true });
          renameQuiet(oldRoot, newRoot, 'userData 根目录（空的新目录已替换）');
        } catch (err) {
          try { log('boot', '替换空 dshusb 失败: ' + err.message); } catch {}
        }
      } else {
        try { log('boot', `旧目录 ${oldRoot} 与新目录并存，保留 ${newRoot}，旧目录未合并`); } catch {}
      }
    }
    const root = fs.existsSync(newRoot) ? newRoot : null;
    if (!root) return;
    renameQuiet(path.join(root, 'agent'), path.join(root, 'deepseek-ai'), 'agent overlay');
    renameQuiet(path.join(root, 'dsh-home'), path.join(root, '.dsh'), 'DSH_HOME');
  } catch (err) {
    try { log('boot', '布局迁移失败: ' + err.message); } catch {}
  }
}

try {
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else {
    const exeDirEarly = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    try { migrateLegacyLayout(exeDirEarly); } catch {}
    app.setPath('userData', path.join(exeDirEarly, 'dshusb'));
  }
} catch {}
const APP_VERSION = '1.3.0';
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let serverProc = null;
let webUrl = null;
let quitting = false;
let updateBusy = false;
let notifyOnTurnEnd = true;
let sessionWatcher = null;
let userDataDir = '';
let logsDir = '';
let dshHome = '';
let desktopLog = null;
let tray = null;
let forceQuit = false;
let restartingServer = false;
let proxyModules = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
  try { if (desktopLog) desktopLog.write(line); } catch {}
  if (process.env.DSH_DESKTOP_DEBUG) process.stdout.write(line);
}

function nodeExe() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'node', 'node.exe');
  return path.resolve(__dirname, 'vendor', 'node', 'node.exe');
}

function npmCli() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js');
  return path.resolve(__dirname, 'vendor', 'npm', 'bin', 'npm-cli.js');
}

// Context shared with the updater module.
function updCtx() {
  return { userDataDir, nodeExe, npmCli, log };
}

// Updated overlay (user-approved official release) takes precedence over the
// bundled copy; the bundled copy is the fallback.
function dshBin() {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) return ov;
  return require.resolve('@deepseek-ai/dsh/lib/bin.js');
}

function dshVersion() { return updater.activeVersion(updCtx()) || '未知'; }

function dshVersionSource() {
  return updater.overlayVersion(updCtx()) ? '用户目录（已更新）' : '内置';
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) {
      // M2 修复：先优雅（无 /F）给进程收尾机会（避免撕裂 session.jsonl.zstd），
      // 短等待后仍存活再强杀。
      spawn('taskkill', ['/pid', String(proc.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      const pid = proc.pid;
      setTimeout(() => {
        try {
          const query = 'tasklist /FI "PID eq ' + pid + '" /FO CSV /NH';
          const alive = require('node:child_process').execSync(query, { encoding: 'utf8', windowsHide: true });
          if (alive.includes(String(pid))) {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
        } catch { /* 进程已退出或查询失败 */ }
      }, 1500);
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    }
  } catch (err) {
    log('killTree', String(err));
  }
}

// Environment for the dsh child: drop harness/session leftovers so the
// desktop instance boots clean, keep everything else (proxy, API keys, ...).
function childEnv() {
  const env = { ...process.env };
  for (const k of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    delete env[k];
  }
  if (dshHome) env.DSH_HOME = dshHome;
  if (proxyModules) env.DSH_USB_PROXY_MODULES = '1';
  // Keep agent spill/subprocess temps and npm cache on the USB, not the host.
  try {
    const tmpDir = path.join(userDataDir, 'temp');
    fs.mkdirSync(tmpDir, { recursive: true });
    env.TMP = tmpDir;
    env.TEMP = tmpDir;
    env.TMPDIR = tmpDir;
  } catch {}
  env.NO_COLOR = '1';
  return env;
}

// exFAT/FAT32 cannot create junctions; force dsh-app-boot into ESM proxy mode.
function detectJunctionSupport(dir) {
  const target = path.join(dir, '.dsh-junction-target');
  const probe = path.join(dir, '.dsh-junction-probe');
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, probe, 'junction');
    return fs.lstatSync(probe).isSymbolicLink();
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}

function isDshProxyDir(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(manifest && manifest.dsh && manifest.dsh.moduleFallback);
  } catch {
    return false;
  }
}

// Remove materialized copies / broken links under profiles so heal can rebuild
// as proxies. Leaves valid symlinks (NTFS) and existing proxies alone.
function sanitizeProfileModulesForProxy(home) {
  const roots = [
    path.join(home, 'profiles', 'node_modules'),
    path.join(home, 'profiles', 'web', 'node_modules'),
  ];
  let removed = 0;
  const scrub = (parent, name) => {
    const p = path.join(parent, name);
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) {
      try { fs.statSync(p); } catch {
        try { fs.unlinkSync(p); removed++; } catch {}
      }
      return;
    }
    if (!st.isDirectory()) return;
    if (name.startsWith('@')) {
      for (const child of fs.readdirSync(p)) scrub(p, child);
      try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch {}
      return;
    }
    if (isDshProxyDir(p)) return;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {}
  };
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) scrub(root, name);
    } catch {}
  }
  return removed;
}

function showBox(opts) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, opts);
  return dialog.showMessageBox(opts);
}

// ---------------------------------------------------------------------------
// dsh web server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    // M1 修复：重入前先终结旧进程，避免孤儿 harness 同时写同一 DSH_HOME。
    if (serverProc && !serverProc.killed && !quitting) {
      log('dsh', 'startServer 重入：先终结旧进程再启动');
      killTree(serverProc);
      serverProc = null;
    }
    const nodeBin = nodeExe();
    const bin = dshBin();
    if (!fs.existsSync(nodeBin)) {
      return reject(new Error(
        '找不到内置 Node 运行时: ' + nodeBin + '\n' +
        (app.isPackaged ? '安装包可能不完整，请重新安装。' : '开发模式请先运行: npm run fetch-node')
      ));
    }
    const out = fs.createWriteStream(path.join(logsDir, 'dsh-web.log'), { flags: 'a' });
    log('dsh', `启动: "${nodeBin}" "${bin}" web --host 127.0.0.1 --port 0 --no-open`);
    const proc = spawn(nodeBin, [bin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: userDataDir,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc = proc;
    let settled = false;
    let bootTimer = null;
    const finish = (fn, value) => {
      if (!settled) { settled = true; fn(value); }
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    };
    const onData = (chunk) => {
      out.write(chunk);
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (m) finish(resolve, m[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c) => out.write(c));
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code, signal) => {
      out.end();
      log('dsh', `进程退出 code=${code} signal=${signal}`);
      // 原地重启（插件市场）或已替换为新进程时，不打扰用户、也不清掉新进程的句柄。
      const intentional = restartingServer || serverProc !== proc;
      if (serverProc === proc) serverProc = null;
      finish(reject, new Error(`dsh web 启动失败（退出码 ${code}）。日志: ${path.join(logsDir, 'dsh-web.log')}`));
      if (!quitting && !intentional && webUrl && mainWindow && !mainWindow.isDestroyed()) {
        showBox({
          type: 'error',
          title: 'DSH 服务已停止',
          message: 'DeepSeek Harness 服务意外退出。',
          detail: `日志文件：${path.join(logsDir, 'dsh-web.log')}`,
          buttons: ['重新启动', '退出'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) startAndShow().catch((err) => handleBootFailure(err));
          else app.quit();
        });
      }
    });
    // Safety net in case the URL line never appears.
    bootTimer = setTimeout(() => finish(reject, new Error('等待 dsh web 启动超时（600 秒）')), 600000);
    bootTimer.unref();
  });
}

function waitUntilUp(url, timeoutMs = 120000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url + '/', { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(url);
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error('Web UI 未在预期时间内就绪'));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

function startAndShow() {
  return startServer()
    .then(waitUntilUp)
    .then((url) => {
      webUrl = url;
      if (typeof _loadTimeoutId !== 'undefined') { clearTimeout(_loadTimeoutId); _loadTimeoutId = null; }
      log('boot', 'Web UI 就绪: ' + url);
      if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow.loadURL(url).then(() => url);
      }
      return url;
    });
}

function handleBootFailure(err) {
  const ov = updater.overlayBinPath(updCtx());
  if (ov && fs.existsSync(ov)) {
    showBox({
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: '更新后的 agent 无法启动。',
      detail: (err && err.message || String(err)) + '\n\n可回退到内置版本继续使用。',
      buttons: ['回退到内置版本并重试', '重试', '退出'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 0) {
        updater.rollback(updCtx());
        startAndShow().catch((e2) => fatal('DeepSeek Harness 启动失败', e2));
      } else if (response === 1) {
        startAndShow().catch((e2) => handleBootFailure(e2));
      } else {
        app.quit();
      }
    });
  } else {
    fatal('DeepSeek Harness 启动失败', err);
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'DSH USB',
    backgroundColor: '#0b1220',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 风格化无边框窗口：去掉原生标题栏/菜单栏，自绘玻璃栏 + Win11 原生圆角。
    ...(IS_WIN ? { frame: false, roundedCorners: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'assets', 'loading.html'));
  // DSH USB: 120s startup timeout - prompt user if loading takes too long
  let _loadTimeoutId = setTimeout(() => {
    if (webUrl) return; // already loaded
    const { dialog } = require('electron');
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'DSH USB',
      message: '" + [char]0x52A0 + [char]0x8F7D + [char]0x8D85 + [char]0x65F6 + "',
      detail: '" + [char]0x5E94 + [char]0x7528 + [char]0x5DF2 + [char]0x8D85 + [char]0x8FC7 + " 2 " + [char]0x5206 + [char]0x949F + [char]0x672A + [char]0x5B8C + [char]0x6210 + [char]0x52A0 + [char]0x8F7D + [char]0x3002 + "\n\n" + [char]0x7EE7 + [char]0x7EED + [char]0x7B49 + [char]0x5F85 + [char]0xFF1F + "',
      buttons: ['" + [char]0x7EE7 + [char]0x7EED + [char]0x7B49 + [char]0x5F85 + "', '" + [char]0x7EC8 + [char]0x6B62 + [char]0x8FDB + [char]0x7A0B + "'],
      defaultId: 0,
    }).then((result) => {
      if (result.response === 1) {
        const { execSync } = require('child_process');
        try { execSync('taskkill /F /IM \"DSH USB.exe\"', { windowsHide: true }); } catch {}
        try { execSync('taskkill /F /IM node.exe /FI \"WINDOWTITLE eq dsh*\"', { windowsHide: true }); } catch {}
        process.exit(1);
      }
    });
  }, 120000);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Keep the app brand in the OS title bar (the web UI sets its own <title>).
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('DSH USB');
  });

  // Open target=_blank / window.open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the window pinned to the local web UI; send external links out.
  // H1 修复：origin 精确比较（protocol+host+port），杜绝前缀/异域/userinfo 逃逸；
  // file: 一律拦截（同 webContents 下 file 页面仍持有 preload 桥）；will-redirect 同规则。
  const isAllowedWebUrl = (url) => {
    try {
      const target = new URL(url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
      if (webUrl) {
        const base = new URL(webUrl);
        return target.origin === base.origin;
      }
      return target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';
    } catch {
      return false;
    }
  };
  const guardNavigation = (event, url) => {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);

  // 渲染进程错误捕获：插件/页面异常统一落到 desktop.log，便于排查空白视图。
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level === 'error' || level === 'warning') {
      log('page', `[${level}] ${message} (${sourceId || 'unknown'}:${line})`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('page', `渲染进程异常退出: ${details.reason} (exitCode=${details.exitCode})`);
  });

  // 移除菜单栏后仍保留的键盘快捷键。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.key === 'F11') { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === 'F12') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && input.shift && key === 'i') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
    else if (input.control && key === 'r') { mainWindow.reload(); event.preventDefault(); }
    else if (input.alt && key === 'f4') { mainWindow.close(); event.preventDefault(); }
  });

  // 自绘最大化/还原按钮需要感知窗口状态。
  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chrome:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  mainWindow.on('enter-full-screen', sendMaxState);
  mainWindow.on('leave-full-screen', sendMaxState);

  // 关闭 → 隐藏到托盘（可在 chrome 菜单关闭该行为）。
  mainWindow.on('close', (event) => {
    if (!forceQuit && IS_WIN && closeToTrayEnabled() && tray) {
      event.preventDefault();
      mainWindow.hide();
      trayHintOnce();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function fatal(title, err) {
  log('fatal', title + ': ' + ((err && (err.stack || err.message)) || err));
  const detail = '错误：' + ((err && err.message) || err) + '\n\n日志目录：' + logsDir;
  if (!mainWindow || mainWindow.isDestroyed()) {
    dialog.showErrorBox(title, detail);
    app.exit(1);
    return;
  }
  showBox({
    type: 'error',
    title,
    message: title,
    detail,
    buttons: ['重试', '退出'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) startAndShow().catch((err2) => handleBootFailure(err2));
    else app.quit();
  });
}

// ---------------------------------------------------------------------------
// Self-update flow (official @deepseek-ai/dsh releases, user-consented)
// ---------------------------------------------------------------------------

function showUpdateWindow(version, kind = 'agent') {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: true,
    title: '正在更新',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'assets', 'updating.html')).then(() => {
    win.webContents
      .executeJavaScript(`window.__init && window.__init(${JSON.stringify({ version, kind })})`)
      .catch(() => {});
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

async function runUpdateFlow(manual) {
  if (quitting) return;
  if (updateBusy) {
    if (manual) await showBox({ type: 'info', title: '更新', message: '更新正在进行中，请稍候。', buttons: ['确定'] });
    return;
  }
  const ctx = updCtx();
  let latest;
  try {
    latest = await updater.checkLatest(ctx);
  } catch (err) {
    log('update', '检查失败: ' + err.message);
    if (manual) {
      await showBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接 npm registry。',
        detail: err.message + '\n\n可通过环境变量 NPM_CONFIG_REGISTRY 配置镜像。',
        buttons: ['确定'],
      });
    }
    return;
  }
  const current = updater.activeVersion(ctx);
  const settings = updater.loadSettings(ctx);
  if (updater.compareVersions(latest, current) <= 0) {
    if (manual) {
      await showBox({
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本。',
        detail: `@deepseek-ai/dsh@${current}`,
        buttons: ['确定'],
      });
    }
    return;
  }
  if (!manual && settings.skipVersion === latest) return;

  // exFAT/proxy mode: npm install on the USB volume is unreliable — use the
  // host NTFS installer (update-dsh.ps1) after the shell exits.
  const hostInstall = !!proxyModules;

  const { response } = await showBox({
    type: 'info',
    title: '发现新版本',
    message: `官方 @deepseek-ai/dsh 发布了新版本：${latest}`,
    detail: hostInstall
      ? `当前版本：${current}\n\n当前 U 盘不支持 junction（exFAT/proxy 模式），将走宿主机安装路径：\n· 在本机 NTFS 临时目录下载并安装\n· 复制回 U 盘、打兼容补丁并原子替换\n· 完成后自动重新启动 DSH USB\n\n是否立即更新？`
      : `当前版本：${current}\n\n是否立即更新？\n· 从 npm 官方源下载新版本及其依赖（首次约 250MB）\n· 更新期间界面保持可用，完成后重启应用生效\n· 失败会自动保留当前版本`,
    buttons: ['立即更新', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    settings.skipVersion = latest;
    updater.saveSettings(ctx, settings);
    log('update', '用户跳过版本 ' + latest);
    return;
  }
  if (response === 2) return;

  updateBusy = true;
  const progressWin = showUpdateWindow(latest, hostInstall ? 'host' : 'agent');
  try {
    if (hostInstall) {
      const cmdPath = updater.applyUpdateViaHost(ctx, latest, process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath));
      const { response: r2 } = await showBox({
        type: 'info',
        title: '已调度宿主机更新',
        message: `即将更新到 @deepseek-ai/dsh@${latest}`,
        detail: '应用将退出，由宿主机安装脚本完成下载与替换，随后自动重新启动。\n日志：' + cmdPath,
        buttons: ['立即退出并更新', '取消'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r2 !== 0) {
        try { fs.rmSync(cmdPath, { force: true }); } catch {}
        updateBusy = false;
        if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
        return;
      }
      quitting = true;
      forceQuit = true;
      killTree(serverProc);
      if (sessionWatcher) sessionWatcher.stop();
      setTimeout(() => app.exit(0), 300);
      return;
    }
    await updater.applyUpdate(ctx, latest);
    const { response: r2 } = await showBox({
      type: 'info',
      title: '更新完成',
      message: `已更新到 @deepseek-ai/dsh@${latest}`,
      detail: '重启应用后生效。',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r2 === 0) {
      quitting = true;
      killTree(serverProc);
      app.relaunch();
      app.exit(0);
    }
  } catch (err) {
    log('update', '更新失败: ' + err.message);
    await showBox({
      type: 'error',
      title: '更新失败',
      message: '未能完成更新，仍使用当前版本。',
      detail: err.message,
      buttons: ['确定'],
    });
  } finally {
    updateBusy = false;
    if (progressWin && !progressWin.isDestroyed()) progressWin.destroy();
  }
}

// ---------------------------------------------------------------------------
// Session-completion notifications
// ---------------------------------------------------------------------------

const lastNotifyAt = new Map(); // sessionId -> timestamp (rate-limit)

function onSessionTurnEnd(info) {
  if (!notifyOnTurnEnd || quitting) return;
  const now = Date.now();
  const last = lastNotifyAt.get(info.sessionId) || 0;
  if (now - last < 30000) return; // same session: at most one toast per 30s
  lastNotifyAt.set(info.sessionId, now);
  log('notify', '任务完成: ' + JSON.stringify(info));
  try {
    const n = new Notification({
      title: info.title || 'DSH 任务完成',
      body: info.body || '会话任务已完成',
      icon: path.join(__dirname, 'assets', 'icon.png'),
    });
    n.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    log('notify', '通知发送失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Chrome（自绘标题栏）IPC、托盘、快捷方式
// ---------------------------------------------------------------------------

function closeToTrayEnabled() {
  const s = updater.loadSettings(updCtx());
  return s.closeToTray !== false;
}

function setCloseToTray(v) {
  const s = updater.loadSettings(updCtx());
  s.closeToTray = !!v;
  updater.saveSettings(updCtx(), s);
}

function repoUrls() {
  return {
    github: 'https://github.com/yuloong07-star/dsh-usb',
    gitee: 'https://gitee.com/yuloong07-star/dsh-usb',
  };
}

async function showAbout() {
  const urls = repoUrls();
  const { response } = await showBox({
    type: 'info',
    title: '关于 DSH USB',
    message: 'DSH USB',
    detail: 'DeepSeek Harness 桌面客户端\n\nagent 版本：' + dshVersion() + '（' + dshVersionSource() + '）\n模块模式：' + (proxyModules ? 'proxy（exFAT 兼容）' : 'symlink') + '\n数据目录：' + userDataDir + '\nDSH_HOME：' + (dshHome || '（dsh 默认）') +
      '\n\n项目仓库：\n  GitHub: ' + urls.github + '\n  Gitee:  ' + urls.gitee,
    buttons: ['复制 GitHub 地址', '复制 Gitee 地址', '确定'],
  });
  if (response === 0) clipboard.writeText(urls.github);
  else if (response === 1) clipboard.writeText(urls.gitee);
}

function registerChromeIpc() {
  ipcMain.handle('chrome:init', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    let iconDataUri = '';
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
      if (buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50) {
        iconDataUri = 'data:image/png;base64,' + buf.toString('base64');
      }
    } catch {}
    const s = updater.loadSettings(updCtx());
    const urls = repoUrls();
    return {
      appVersion: APP_VERSION,
      agentVersion: dshVersion(),
      agentSource: dshVersionSource(),
      notifyOnTurnEnd,
      closeToTray: s.closeToTray !== false,
      iconDataUri,
      repoUrls: urls,
      staticPort: previewStaticPort,
    };
  });

  ipcMain.handle('chrome:window', (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return null;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'toggle-maximize': mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
      case 'is-maximized': return mainWindow.isMaximized();
    }
    return null;
  });

  ipcMain.handle('chrome:menu', async (event, { action } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { notifyOnTurnEnd, closeToTray: closeToTrayEnabled() };
    }
    switch (action) {
      case 'reload': mainWindow.reload(); break;
      case 'devtools': mainWindow.webContents.toggleDevTools(); break;
      case 'fullscreen': mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
      case 'open-browser': if (webUrl) shell.openExternal(webUrl); break;
      case 'open-logs': shell.openPath(logsDir); break;
      case 'check-agent-update': runUpdateFlow(true); break;
      case 'toggle-notify': {
        notifyOnTurnEnd = !notifyOnTurnEnd;
        const s = updater.loadSettings(updCtx());
        s.notifyOnTurnEnd = notifyOnTurnEnd;
        updater.saveSettings(updCtx(), s);
        break;
      }
      case 'toggle-close-to-tray': setCloseToTray(!closeToTrayEnabled()); break;
      case 'about': showAbout(); break;
      // ---------------------------------------------------------------------------
// DSH USB: "quit and clean cache". Chromium keeps cache files locked while
// the process is alive, so the cleanup script is spawned DETACHED: it waits
// for every "DSH USB" process to exit, then removes the cache/temp folders
// under the local dsh userData dir. Settings and sessions are NOT touched.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DSH USB: copying the package across drives/machines materializes profile
// junctions into real directories (or leaves them pointing at the old drive),
// which makes dsh's ensureSymlink fail with EISDIR at boot. Detect that and
// wipe profiles so dsh rebuilds them against the current paths.
// ---------------------------------------------------------------------------
case 'quit': scheduleCacheCleanup(); forceQuit = true; app.quit(); break;
    }
    return { notifyOnTurnEnd, closeToTray: closeToTrayEnabled() };
  });

  // 插件市场：原地重启 dsh web 服务（安装/卸载插件后生效，窗口重载到新端口）。
  ipcMain.handle('chrome:restart-service', async (event, payload = {}) => {
    if (payload?.intent !== 'restart-service') return { ok: false, error: 'missing-intent' };
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'unauthorized' };
    if (!serverProc || restartingServer) return { ok: false, error: 'not-running' };
    log('service', '请求重启 dsh web 服务');
    restartingServer = true;
    try {
      killTree(serverProc);
      const url = await startAndShow();
      log('service', 'dsh web 服务已重启: ' + url);
      return { ok: true, url };
    } catch (err) {
      log('service', '重启失败: ' + ((err && err.message) || err));
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      restartingServer = false;
    }
  });

  // 复制文本到剪贴板（菜单「更新源」复制按钮 / 关于对话框）。
  ipcMain.handle('dsh:copy-text', (event, { text } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false };
    if (typeof text !== 'string' || !text || text.length > 2048) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  // preload 转发的页面异常（window.onerror / unhandledrejection）。
  ipcMain.on('dsh:page-error', (event, payload) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    log('page-error', String(payload));
  });

  // 文件还原（「文件」视图的回退）：按会话日志里已持久化的写前/写后全文，
  // 做精确内容匹配后替换 —— 只有内容一致才动手，天然幂等且安全。
  ipcMain.handle('dsh:file-revert', async (event, { changes } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { results: [] };
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results = [];
    for (const c of changes) {
      const p = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(p) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: p, status: 'invalid' });
        continue;
      }
      if (!isUnderFileRoots(p)) {
        results.push({ path: p, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(p);
        const content = exists ? fs.readFileSync(p, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          // 新建 → 删除（内容必须仍是 agent 写入的原文）
          if (content !== null && content === newText) { fs.rmSync(p); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          // 删除 → 恢复（文件必须仍不存在）
          if (content === null) { fs.writeFileSync(p, oldText, 'utf8'); results.push({ path: p, status: 'reverted' }); }
          else results.push({ path: p, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            fs.writeFileSync(p, content.replace(newText, oldText), 'utf8');
            results.push({ path: p, status: 'reverted' });
          } else if (content !== null && content === oldText) {
            results.push({ path: p, status: 'skipped' });
          } else {
            results.push({ path: p, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (err) {
        results.push({ path: p, status: 'failed', error: String((err && err.message) || err) });
      }
    }
    log('file-revert', JSON.stringify(results.slice(0, 20)));
    return { results };
  });

  // 「全部文件」视图的打开请求：用系统默认程序打开项目文件。
  ipcMain.handle('dsh:file-open', async (event, { path: p } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    if (!isUnderFileRoots(p)) return { ok: false, error: 'path outside session workspace' };
    if (DANGEROUS_EXT.test(p)) return { ok: false, error: 'executable files are not openable from the file view' };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: 'file not found' };
      const msg = await shell.openPath(p);
      if (msg) return { ok: false, error: msg };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 预览面板：用系统浏览器打开 http(s) URL。
  ipcMain.handle('dsh:open-external', async (event, { url } = {}) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'forbidden' };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

let trayHintShown = false;
function trayHintOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: 'DSH USB 仍在运行',
      content: '窗口已隐藏到系统托盘，点击托盘图标可重新打开。',
      iconType: 'info',
    });
  } catch {}
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (!IS_WIN) return;
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    tray.setToolTip('DSH USB');
    const menu = Menu.buildFromTemplate([
      { label: '显示 DSH USB', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '会话完成通知',
        type: 'checkbox',
        checked: notifyOnTurnEnd,
        click: (item) => {
          notifyOnTurnEnd = item.checked;
          const s = updater.loadSettings(updCtx());
          s.notifyOnTurnEnd = item.checked;
          updater.saveSettings(updCtx(), s);
        },
      },
      { type: 'separator' },
      { label: '退出并清理缓存', click: () => { scheduleCacheCleanup(); forceQuit = true; app.quit(); } },
      { label: '仅退出', click: () => { forceQuit = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
      else showMainWindow();
    });
    tray.on('double-click', () => showMainWindow());
    log('boot', '系统托盘已就绪');
  } catch (err) {
    log('boot', '创建系统托盘失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 配套 dsh 插件同步（注入 web profile：文件更改追踪/还原）
// ---------------------------------------------------------------------------

const COMPANION_PLUGINS = [
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
];

function syncCompanionPlugins() {
  if (!IS_WIN) return;
  try {
    const home = dshHome || path.join(os.homedir(), '.dsh');
    const profileDir = path.join(home, 'profiles', 'web');
    const profileModules = path.join(profileDir, 'node_modules', '@deepseek-ai');
    fs.mkdirSync(profileModules, { recursive: true });
    for (const p of COMPANION_PLUGINS) {
      const src = path.join(__dirname, 'assets', 'plugins', p.name.slice('@deepseek-ai/'.length));
      if (!fs.existsSync(path.join(src, 'package.json'))) continue;
      const dest = path.join(profileModules, p.name.slice('@deepseek-ai/'.length));
      fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
      for (const f of ['package.json', 'lib/index.js', 'lib/client.js']) {
        const sf = path.join(src, f);
        if (fs.existsSync(sf)) fs.copyFileSync(sf, path.join(dest, f));
      }
    }
    // 注册到 profile 的 patch 层（幂等）。
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    let patch = '';
    try { patch = fs.readFileSync(patchFile, 'utf8'); } catch { patch = ''; }
    let changed = false;
    for (const p of COMPANION_PLUGINS) {
      if (new RegExp('id:\\s*' + p.id + '\\b').test(patch)) continue;
      const block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/\[\]/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH USB 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(patchFile, patch);
      log('boot', '已同步配套插件到 web profile: ' + COMPANION_PLUGINS.map((p) => p.id).join(', '));
    }
  } catch (err) {
    log('boot', '同步配套插件失败: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// 快捷方式维护：修复「没有桌面快捷方式 / 快捷方式指向的文件消失」，
// 并让快捷方式图标跟随图标设计更新（.lnk 单独指定 icon.ico）。
// ---------------------------------------------------------------------------

// 图标设计版本：更换图标时 +1，触发所有快捷方式图标刷新。
const SHORTCUT_ICON_VERSION = 'whale-2';

function shortcutIconPath() {
  // 复制到 userData 保证路径稳定（便携版 exe 解压目录每次启动都会变）。
  const ico = path.join(userDataDir, 'icon.ico');
  try {
    const src = path.join(__dirname, 'assets', 'icon.ico');
    if (!fs.existsSync(src)) return '';
    if (!fs.existsSync(ico) || fs.statSync(src).size !== fs.statSync(ico).size) {
      fs.copyFileSync(src, ico);
    }
    return ico;
  } catch (err) {
    log('boot', '复制快捷方式图标失败: ' + err.message);
    return path.join(__dirname, 'assets', 'icon.ico');
  }
}

function maintainShortcuts() {
  if (!app.isPackaged || !IS_WIN) return;
  try {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const settings = updater.loadSettings(updCtx());
    const linksDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const startMenu = path.join(linksDir, 'DSH USB.lnk');
    const desktop = path.join(app.getPath('desktop'), 'DSH USB.lnk');
    const ico = shortcutIconPath();
    const opts = {
      target,
      description: 'DeepSeek Harness 桌面客户端',
      ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      appUserModelId: 'com.deepseek.dsh.desktop',
    };
    let changed = false;
    // exe 被移动过，或图标设计更新过：替换现有快捷方式（修复“指向的文件消失”）。
    if ((settings.shortcutTarget && settings.shortcutTarget !== target) || settings.shortcutIcon !== SHORTCUT_ICON_VERSION) {
      for (const p of [startMenu, desktop]) {
        if (fs.existsSync(p)) {
          try { shell.writeShortcutLink(p, 'replace', opts); changed = true; } catch {}
        }
      }
    }
    // 缺失则创建：便携版补桌面快捷方式；开始菜单快捷方式是系统通知的前置条件。
    if (!fs.existsSync(startMenu)) {
      try { shell.writeShortcutLink(startMenu, 'create', opts); changed = true; } catch {}
    }
    if (!fs.existsSync(desktop)) {
      try { shell.writeShortcutLink(desktop, 'create', opts); changed = true; } catch {}
    }
    if (changed) {
      settings.shortcutTarget = target;
      settings.shortcutIcon = SHORTCUT_ICON_VERSION;
      updater.saveSettings(updCtx(), settings);
      log('boot', '快捷方式已维护（开始菜单/桌面 → ' + target + '，图标 ' + SHORTCUT_ICON_VERSION + '）');
    }
  } catch (err) {
    log('boot', '快捷方式维护失败: ' + err.message);
  }
}

function warnTempRun() {
  if (!app.isPackaged || !IS_WIN || !process.env.PORTABLE_EXECUTABLE_DIR) return;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR.toLowerCase();
  const tmp = os.tmpdir().toLowerCase();
  if (dir === tmp || dir.startsWith(tmp + path.sep)) {
    showBox({
      type: 'warning',
      title: '正在从临时目录运行',
      message: '当前便携版位于系统临时目录。',
      detail: '临时目录中的文件可能被系统自动清理，导致快捷方式失效或程序“消失”。\n建议把 DSH USB exe 移动到固定位置（如桌面或 D 盘）后再运行。',
      buttons: ['知道了'],
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 预览静态文件服务：独立端口的只读文件服务，供「站内 HTML 预览」的 iframe 使用。
// 为什么要独立端口：浏览器对同一主机 HTTP/1.1 并发连接上限 6，web UI 自身
// 长连接已占满；预览 iframe 及其相对资源若走 dsh 宿主会被排队。仅接受回环。
// ---------------------------------------------------------------------------

let previewStaticPort = 0;

function startPreviewStaticServer() {
  const MIME = {
    ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
    ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
    ".json": "application/json", ".map": "application/json", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".xml": "application/xml"
  };
  const TEXT_MIME = /^(text\/|application\/(json|javascript|xhtml\+xml|xml)|image\/svg)/;
  const server = http.createServer((req, res) => {
    const ra = req.socket && req.socket.remoteAddress;
    if (ra !== "127.0.0.1" && ra !== "::1" && ra !== "::ffff:127.0.0.1") {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname.slice(1));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (!path.isAbsolute(p)) {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mime = MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": TEXT_MIME.test(mime) ? mime + "; charset=utf-8" : mime,
        "content-length": String(st.size),
        "cache-control": "no-store"
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    previewStaticPort = server.address().port;
    log("boot", "预览静态服务已启动: http://127.0.0.1:" + previewStaticPort);
  });
  server.on("error", (err) => log("boot", "预览静态服务失败: " + err.message));
}

function scheduleCacheCleanup() {
  try {
    // Script lives on the USB userData dir so quitting never leaves files in %TEMP%.
    const dirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'logs', 'Network', 'temp'];
    const scriptDir = path.join(userDataDir, 'logs');
    fs.mkdirSync(scriptDir, { recursive: true });
    const ps1Path = path.join(scriptDir, 'dsh-usb-cleanup.ps1');
    const body = [
      "$target = " + JSON.stringify(userDataDir),
      "$me = $MyInvocation.MyCommand.Path",
      "$deadline = (Get-Date).AddSeconds(60)",
      "while ((Get-Date) -lt $deadline -and (Get-Process -Name 'DSH USB' -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }",
      "foreach ($d in @(" + dirs.map((d) => JSON.stringify(d)).join(',') + ")) {",
      "  Remove-Item -LiteralPath (Join-Path $target $d) -Recurse -Force -ErrorAction SilentlyContinue",
      "}",
      // A running .ps1 cannot delete itself on Windows; hand off to cmd.
      "Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','ping -n 3 127.0.0.1 >nul & del /f /q \"' + $me + '\"' -WindowStyle Hidden",
    ].join('\r\n');
    fs.writeFileSync(ps1Path, body, 'utf8');
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const psExe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cmdExe = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
    // NOTE: spawning powershell directly with detached+stdio:ignore exits
    // silently without doing anything; a cmd wrapper is required.
    spawn(cmdExe, ['/d', '/c', psExe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('quit', 'scheduled post-exit cache cleanup: ' + ps1Path);
  } catch (err) {
    log('quit', 'schedule cache cleanup failed: ' + err.message);
  }
}
// Migrate helpers live at module top (before setPath); boot() re-runs idempotently.

function boot() {
  // Portable builds keep all data next to the exe.
  if (!app.isPackaged && process.env.DSH_DESKTOP_USERDATA) {
    app.setPath('userData', process.env.DSH_DESKTOP_USERDATA);
  } else {
    // DSH USB build: keep ALL runtime data in a local "dshusb" folder next to
    // the exe so nothing is written to %APPDATA% and the USB drive stays
    // fully self-contained.
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    migrateLegacyLayout(exeDir);
    app.setPath('userData', path.join(exeDir, 'dshusb'));
  }

  userDataDir = app.getPath('userData');
  logsDir = path.join(userDataDir, 'logs');
  // DSH_HOME: respect an explicit override; otherwise use local .dsh so agent
  // sessions/config live on the USB drive instead of ~/.dsh.
  dshHome = process.env.DSH_HOME || path.join(userDataDir, '.dsh');
  fs.mkdirSync(logsDir, { recursive: true });
  if (dshHome) fs.mkdirSync(dshHome, { recursive: true });
  desktopLog = fs.createWriteStream(path.join(logsDir, 'desktop.log'), { flags: 'a' });
  log('boot', `DSH USB ${APP_VERSION}  userData=${userDataDir}  dshHome=${dshHome || '(dsh 默认)'}  agent=${dshVersion()}(${dshVersionSource()})`);

  try { updater.cleanupTemp(updCtx()); } catch (err) { log('boot', '启动清扫失败: ' + err.message); }

  try {
    proxyModules = !detectJunctionSupport(userDataDir);
    if (proxyModules) {
      process.env.DSH_USB_PROXY_MODULES = '1';
      const n = sanitizeProfileModulesForProxy(dshHome);
      log('boot', `junction 不可用，启用 ESM proxy 模块（清理残留 ${n} 项）；dsh 启动时将自动 heal`);
    } else {
      log('boot', 'junction 可用，使用 symlink 模块链接');
    }
  } catch (err) {
    log('boot', 'junction 探测失败，按 proxy 模式处理: ' + err.message);
    proxyModules = true;
    process.env.DSH_USB_PROXY_MODULES = '1';
  }

  // 移除原生菜单栏（文件/视图/帮助），全部功能由自绘 chrome 与托盘提供。
  Menu.setApplicationMenu(null);
  startPreviewStaticServer();
  registerChromeIpc();
  createTray();
  syncCompanionPlugins();
  createWindow();
  startAndShow()
    .then(() => {
      // Session-completion notifications: watch dsh session logs under the
      // effective DSH_HOME (same config the CLI uses).
      const s = updater.loadSettings(updCtx());
      notifyOnTurnEnd = s.notifyOnTurnEnd !== false;
      const home = dshHome || path.join(os.homedir(), '.dsh');
      sessionWatcher = new SessionWatcher({
        sessionsDir: path.join(home, 'sessions'),
        log,
        onTurnEnd: (info) => onSessionTurnEnd(info),
      });
      sessionWatcher.start();
      // maintainShortcuts(); // DSH USB: never create desktop/start-menu shortcuts on first run
      warnTempRun();

      // [patched] agent auto-update disabled (manual menu only)
    })
    .catch((err) => handleBootFailure(err));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.deepseek.dsh.desktop');
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('before-quit', () => {
    quitting = true;
    forceQuit = true;
    log('boot', '正在退出，停止 dsh web 进程树…');
    killTree(serverProc);
    updater.abort();
    if (sessionWatcher) sessionWatcher.stop();
    if (tray) { try { tray.destroy(); } catch {} tray = null; }
  });
  // 关闭窗口后常驻托盘；托盘不存在时才随窗口退出。
  app.on('window-all-closed', () => {
    if (!IS_WIN || !tray) app.quit();
  });
  app.whenReady().then(boot).catch((err) => fatal('应用初始化失败', err));
}
