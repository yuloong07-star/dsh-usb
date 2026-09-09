'use strict';

// Self-update engine for the bundled @deepseek-ai/dsh agent.
//
// Flow:
//   1. checkLatest():  bundled npm runs "npm view @deepseek-ai/dsh version"
//      (respects the user's .npmrc registry / proxy settings).
//   2. User consents in a dialog ("立即更新 / 跳过此版本 / 稍后").
//   3. applyUpdate(): installs the official new version into a STAGING dir
//      (<userData>/agent-staging) with the bundled node + npm runtime, then
//      atomically swaps it in as <userData>/agent. A failed update never
//      touches the working copy.
//   4. dshBin() in main.js prefers the overlay (<userData>/agent/...) over
//      the bundled copy, so the new version takes effect after a restart.
//   5. rollback(): if the overlay fails to boot, the user can fall back to
//      the bundled version with one click.
//
// The overlay lives in the user-writable data dir, so updates work for the
// NSIS install AND the portable build (whose unpacked resources are
// re-created from the exe on every launch).

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PKG = '@deepseek-ai/dsh';
const IS_WIN = process.platform === 'win32';

let activeProc = null;

// --- settings -------------------------------------------------------------

function settingsPath(ctx) { return path.join(ctx.userDataDir, 'settings.json'); }

function loadSettings(ctx) {
  try { return JSON.parse(fs.readFileSync(settingsPath(ctx), 'utf8')); }
  catch { return {}; }
}

function saveSettings(ctx, s) {
  try { fs.writeFileSync(settingsPath(ctx), JSON.stringify(s, null, 2) + '\n'); }
  catch (err) { ctx.log('update', '保存 settings 失败: ' + err.message); }
}

// --- overlay paths --------------------------------------------------------

function overlayDir(ctx) { return path.join(ctx.userDataDir, 'agent'); }
function stagingDir(ctx) { return path.join(ctx.userDataDir, 'agent-staging'); }

function overlayBinPath(ctx) {
  return path.join(overlayDir(ctx), 'node_modules', PKG, 'lib', 'bin.js');
}

function overlayVersion(ctx) {
  try { return require(path.join(overlayDir(ctx), 'node_modules', PKG, 'package.json')).version; }
  catch { return null; }
}

function bundledVersion() {
  try { return require(PKG + '/package.json').version; }
  catch { return null; }
}

function activeVersion(ctx) { return overlayVersion(ctx) || bundledVersion(); }

// --- semver-ish compare (handles 0.1.0-rc.N style prereleases) -------------

function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-');
    const nums = core.split('.').map((s) => parseInt(s, 10) || 0);
    const preNum = parseInt((pre.match(/\d+/) || [''])[0], 10);
    return { nums, pre, preNum: Number.isNaN(preNum) ? -1 : preNum, hasPre: !!pre };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] - B.nums[i];
  }
  if (A.hasPre !== B.hasPre) return A.hasPre ? -1 : 1; // prerelease < release
  if (A.hasPre && A.pre !== B.pre) {
    if (A.preNum >= 0 && B.preNum >= 0 && A.preNum !== B.preNum) return A.preNum - B.preNum;
    return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
  }
  return 0;
}

// --- npm runner -----------------------------------------------------------

function killProc(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else proc.kill('SIGTERM');
  } catch {}
}

function abort() { killProc(activeProc); activeProc = null; }

function runNpm(ctx, args, { timeoutMs = 30 * 60 * 1000, logStream = null } = {}) {
  return new Promise((resolve, reject) => {
    const nodeBin = ctx.nodeExe();
    const cli = ctx.npmCli();
    if (!fs.existsSync(nodeBin) || !fs.existsSync(cli)) {
      return reject(new Error('内置 Node/npm 运行时缺失，无法检查或执行更新。'));
    }
    ctx.log('update', 'npm ' + args.join(' '));
    try { fs.mkdirSync(ctx.userDataDir, { recursive: true }); } catch {}
    const proc = spawn(nodeBin, [cli, ...args], {
      cwd: ctx.userDataDir,
      env: {
        ...process.env,
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProc = proc;
    let settled = false;
    let stdoutBuf = '';
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); activeProc = null; fn(value); } };
    const timer = setTimeout(() => { killProc(proc); finish(reject, new Error('npm 执行超时（' + Math.round(timeoutMs / 1000) + ' 秒）')); }, timeoutMs);
    let stderrBuf = '';
    proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); if (logStream) logStream.write(c); });
    proc.stderr.on('data', (c) => { stderrBuf += c.toString(); if (logStream) logStream.write(c); });
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code) => {
      if (code === 0) finish(resolve, stdoutBuf);
      else {
        const tail = (stderrBuf + stdoutBuf).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
        finish(reject, new Error('npm 退出码 ' + code + (tail ? '：' + tail.slice(-500) : '')));
      }
    });
  });
}

// --- public API -----------------------------------------------------------

async function checkLatest(ctx) {
  // DSH USB: use Node.js built-in https to query npm registry directly (no npm CLI needed)
  const https = require('https');
  const url = 'https://registry.npmjs.org/' + PKG + '/latest';
  ctx.log('update', 'fetching latest version from: ' + url);
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const v = json.version;
          if (!v || !/^\d+\.\d+\.\d+/.test(v)) {
            throw new Error('invalid version in response: ' + JSON.stringify(json));
          }
          ctx.log('update', 'latest version: ' + v);
          resolve(v);
        } catch (err) {
          reject(new Error('parse error: ' + err.message));
        }
      });
    }).on('error', (err) => {
      reject(new Error('network error: ' + err.message));
    });
  });
}
const TICK = String.fromCharCode(96);

// DSH USB: after npm installs a fresh dsh agent, its dsh-app-boot must be
// patched for exFAT copy fallback and optional native dependencies before the
// overlay is swapped in. Without these patches the new version crashes at
// boot (ensureSymlink / stale native binaries).
function patchBootForExfat(ctx, bootFile) {
  if (!fs.existsSync(bootFile)) {
    throw new Error('安装后未找到 dsh-app-boot: ' + bootFile);
  }
  let content = fs.readFileSync(bootFile, 'utf8');
  let changed = false;

  const importOld = 'import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";';
  const importNew = 'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";';
  if (content.includes(importOld)) {
    content = content.split(importOld).join(importNew);
    changed = true;
  }

  const optionalOld = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];';
  const optionalNew = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];';
  if (content.includes(optionalOld)) {
    content = content.split(optionalOld).join(optionalNew);
    changed = true;
  }

  if (!content.includes('function dshCopyCurrent')) {
    const anchor = '/** Ensure `link` is a symlink to `target`, replacing a wrong link or a dsh-managed packaged proxy. */';
    if (!content.includes(anchor)) {
      throw new Error('dsh-app-boot 补丁锚点未找到: ' + bootFile);
    }
    const helper =
      '/** Return whether a real directory is a complete DSH USB copy fallback for this target. */\n' +
      'function dshCopyCurrent(link, target) {\n' +
      '\ttry {\n' +
      '\t\treturn readFileSync(join(link, ".dsh-copy-ok"), "utf8") === target;\n' +
      '\t} catch {\n' +
      '\t\treturn false;\n' +
      '\t}\n' +
      '}\n\n';
    content = content.split(anchor).join(helper + anchor);
    changed = true;
  }

  const throwBody = 'dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback';
  const throwOld = 'if ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error(' + TICK + throwBody + TICK + ');';
  const throwNew = 'if (!stat.isDirectory()) throw new Error(' + TICK + throwBody + TICK + ');\n// DSH USB: exFAT/FAT32 copy fallback. A marker file whose content matches\n// this target identifies a complete copy; anything stale is rebuilt below.\nif (dshCopyCurrent(link, target)) return;';
  if (content.includes(throwOld)) {
    content = content.split(throwOld).join(throwNew);
    changed = true;
  }

  const currentOld = 'if (entry.kind === "symlink") return stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir;';
  const currentNew =
    'if (entry.kind === "symlink") {\n' +
    '\t\t\tif (stat.isSymbolicLink()) return readlinkSync(link) === entry.packageDir;\n' +
    '\t\t\tif (stat.isDirectory()) return dshCopyCurrent(link, entry.packageDir);\n' +
    '\t\t\treturn false;\n' +
    '\t\t}';
  if (content.includes(currentOld)) {
    content = content.split(currentOld).join(currentNew);
    changed = true;
  }

  const catchOld = 'if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;';
  const catchNew =
    'if (error.code === "EEXIST" && lstatSync(link).isSymbolicLink() && symlinkPointsTo(link, target)) return;\n' +
    '\t\t// DSH USB: junctions unsupported here (exFAT/FAT32) -> copy package\n' +
    '\t\tif (error.code === "EISDIR" || error.code === "EPERM" || error.code === "ENOSYS" || error.code === "EINVAL") {\n' +
    '\t\t\ttry {\n' +
    '\t\t\t\tconst tmp = link + ".dsh-copying";\n' +
    '\t\t\t\trmSync(tmp, { recursive: true, force: true });\n' +
    '\t\t\t\tcpSync(target, tmp, { recursive: true });\n' +
    '\t\t\t\twriteFileSync(join(tmp, ".dsh-copy-ok"), target);\n' +
    '\t\t\t\trenameSync(tmp, link);\n' +
    '\t\t\t\treturn;\n' +
    '\t\t\t} catch (copyError) {\n' +
    '\t\t\t\t/* fall through to the original error below */\n' +
    '\t\t\t}\n' +
    '\t\t}\n' +
    '\t\tthrow error;';
  if (content.includes(catchOld)) {
    content = content.split(catchOld).join(catchNew);
    changed = true;
  }

  const patched =
    content.includes('function dshCopyCurrent') &&
    content.includes('optionalDependencies') &&
    content.includes('.dsh-copy-ok') &&
    content.includes('cpSync');
  if (!patched) {
    throw new Error('exFAT/可选依赖补丁校验失败（代码格式可能已变化）: ' + bootFile);
  }

  if (changed) {
    fs.writeFileSync(bootFile, content, 'utf8');
    ctx.log('update', '已应用 exFAT/可选依赖兼容补丁: ' + bootFile);
  } else {
    ctx.log('update', 'exFAT/可选依赖补丁已存在，跳过: ' + bootFile);
  }
}

function patchMcpPath(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(ctx.userDataDir, 'dsh-home');
  const file = path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-computer-use-win', 'cordis.patch.yml');
  if (!fs.existsSync(file)) return;
  let content = fs.readFileSync(file, 'utf8');
  const oldPath = "new URL('mcp/server.mjs', baseUrl)";
  const newPath = "new URL('node_modules/dsh-computer-use-win/mcp/server.mjs', baseUrl)";
  if (content.includes(newPath)) return;
  if (!content.includes(oldPath)) {
    ctx.log('update', 'MCP 旧路径未找到，跳过: ' + file);
    return;
  }
  content = content.split(oldPath).join(newPath);
  fs.writeFileSync(file, content, 'utf8');
  ctx.log('update', '已修复 dsh-computer-use-win MCP 路径: ' + file);
}

async function applyUpdate(ctx, version) {
  const staging = stagingDir(ctx);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const logPath = path.join(ctx.userDataDir, 'logs', 'update.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  try {
    await runNpm(ctx, [
      'install', '--prefix', staging, PKG + '@' + version,
      '--save-exact', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier',
    ], { timeoutMs: 30 * 60 * 1000, logStream });
  } catch (err) {
    logStream.end();
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(err.message + '（日志: ' + logPath + '）');
  }
  logStream.end();

  const bin = path.join(staging, 'node_modules', PKG, 'lib', 'bin.js');
  if (!fs.existsSync(bin)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('安装完成但未找到 dsh 入口文件（日志: ' + logPath + '）');
  }

  // DSH USB: patch the freshly installed boot code before it can run.
  patchBootForExfat(ctx, path.join(staging, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'));
  patchMcpPath(ctx);

  // Atomic swap: old overlay -> backup, staging -> overlay. The backup is
  // deliberately kept (agent-old-<ts>) so a bad boot has a manual fallback.
  // M4 修复：两处重命名都纳入 try，失败时回滚并清理 staging 残留。
  const overlay = overlayDir(ctx);
  const backup = path.join(ctx.userDataDir, 'agent-old-' + Date.now());
  try {
    if (fs.existsSync(overlay)) fs.renameSync(overlay, backup);
    fs.renameSync(staging, overlay);
  } catch (err) {
    try {
      if (!fs.existsSync(overlay) && fs.existsSync(backup)) fs.renameSync(backup, overlay);
    } catch (rollbackErr) {
      ctx.log('update', '回滚 overlay 失败: ' + String(rollbackErr && rollbackErr.message));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('切换新版本失败: ' + (err && err.message) + '（staging 已清理）');
  }
  if (fs.existsSync(backup)) {
    ctx.log('update', '旧版本保留在: ' + backup);
  }

  const settings = loadSettings(ctx);
  settings.skipVersion = null;
  saveSettings(ctx, settings);
  ctx.log('update', '更新完成: ' + PKG + '@' + version);
  return { version, logPath };
}

function rollback(ctx) {
  const overlay = overlayDir(ctx);
  if (!fs.existsSync(overlay)) return null;
  const broken = path.join(ctx.userDataDir, 'agent-broken-' + Date.now());
  fs.renameSync(overlay, broken);
  ctx.log('update', '已回退到内置版本（问题副本保留在 ' + broken + '）');
  return broken;
}

module.exports = {
  PKG,
  loadSettings,
  saveSettings,
  overlayBinPath,
  overlayVersion,
  bundledVersion,
  activeVersion,
  compareVersions,
  checkLatest,
  applyUpdate,
  rollback,
  abort,
  patchBootForExfat,
  patchMcpPath,
};
