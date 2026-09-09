'use strict';

// Self-update engine for the bundled @deepseek-ai/dsh agent.
//
// Flow:
//   1. checkLatest():  HTTPS GET registry.npmjs.org/@deepseek-ai/dsh/latest.
//   2. User consents in a dialog ("立即更新 / 跳过此版本 / 稍后").
//   3. applyUpdate(): installs the official new version into a STAGING dir
//      (<userData>/deepseek-ai-staging) with the bundled node + npm runtime,
//      patches dsh-app-boot for exFAT/optional-deps, then atomically swaps
//      it in as <userData>/deepseek-ai. A failed update never touches the
//      working copy.
//   4. dshBin() in main.js prefers the overlay (<userData>/deepseek-ai/...)
//      over the bundled copy, so the new version takes effect after a restart.
//   5. rollback(): if the overlay fails to boot, the user can fall back to
//      the bundled version with one click.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PKG = '@deepseek-ai/dsh';
const IS_WIN = process.platform === 'win32';
const AGENT_DIR_NAME = 'deepseek-ai';
const STAGING_DIR_NAME = 'deepseek-ai-staging';
const OLD_PREFIX = 'deepseek-ai-old-';
const BROKEN_PREFIX = 'deepseek-ai-broken-';

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

function overlayDir(ctx) { return path.join(ctx.userDataDir, AGENT_DIR_NAME); }
function stagingDir(ctx) { return path.join(ctx.userDataDir, STAGING_DIR_NAME); }

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
    let tmpDir = path.join(ctx.userDataDir, 'temp');
    let cacheDir = path.join(ctx.userDataDir, 'npm-cache');
    try { fs.mkdirSync(tmpDir, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
    const proc = spawn(nodeBin, [cli, ...args], {
      cwd: ctx.userDataDir,
      env: {
        ...process.env,
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_AUDIT: 'false',
        // Keep npm cache and extract temps on the USB drive.
        NPM_CONFIG_CACHE: cacheDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        TMPDIR: tmpDir,
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

// --- exFAT / optional-deps boot patch --------------------------------------
// Hardened: multi-anchor matching (exact + looser fallbacks), already-patched
// short-circuit, per-step status logging, ESM-aware node --check after write.

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

function replaceFirst(text, candidates, replacement) {
  for (const cand of candidates) {
    const idx = text.indexOf(cand);
    if (idx >= 0) {
      return { text: text.slice(0, idx) + replacement + text.slice(idx + cand.length), hit: cand };
    }
  }
  return { text, hit: null };
}

function bootPatchMarkersPresent(content) {
  return (
    content.includes('function dshCopyCurrent') &&
    content.includes('optionalDependencies') &&
    content.includes('.dsh-copy-ok') &&
    content.includes('cpSync') &&
    content.includes('DSH_USB_PROXY_MODULES')
  );
}

function applyProxyModePatch(ctx, content, steps) {
  if (content.includes('DSH_USB_PROXY_MODULES')) {
    steps.push({ name: 'proxy-mode', status: 'already' });
    return content;
  }
  const candidates = [
    'function isPackagedExecutable() {\n\treturn process.pkg !== void 0;\n}',
    'function isPackagedExecutable() {\n  return process.pkg !== void 0;\n}',
    'function isPackagedExecutable() { return process.pkg !== void 0; }',
  ];
  const replacement =
    'function isPackagedExecutable() {\n' +
    '\t// DSH USB: exFAT/FAT32 cannot create junctions; force ESM proxy packages.\n' +
    '\treturn process.pkg !== void 0 || process.env.DSH_USB_PROXY_MODULES === "1";\n' +
    '}';
  const r = replaceFirst(content, candidates, replacement);
  if (!r.hit) {
    const loose = content.match(/function\s+isPackagedExecutable\s*\(\s*\)\s*\{[^}]*process\.pkg[^}]*\}/);
    if (!loose) {
      throw new Error('exFAT 补丁步骤 proxy-mode 失败：isPackagedExecutable 锚点未找到');
    }
    content = content.replace(loose[0], replacement);
    steps.push({ name: 'proxy-mode', status: 'applied', via: 'loose' });
    return content;
  }
  steps.push({ name: 'proxy-mode', status: 'applied' });
  return r.text;
}

function patchBootForExfat(ctx, bootFile) {
  if (!fs.existsSync(bootFile)) {
    throw new Error('安装后未找到 dsh-app-boot: ' + bootFile);
  }
  const original = fs.readFileSync(bootFile, 'utf8');
  let content = normalizeEol(original);
  const steps = [];

  if (bootPatchMarkersPresent(content)) {
    steps.push({ name: 'markers', status: 'already' });
    ctx.log('update', 'exFAT/可选依赖补丁已存在，跳过: ' + bootFile);
    return { changed: false, steps };
  }

  // Older patches may lack proxy-mode only — apply that step alone when possible.
  if (
    content.includes('function dshCopyCurrent') &&
    content.includes('optionalDependencies') &&
    content.includes('.dsh-copy-ok') &&
    content.includes('cpSync')
  ) {
    content = applyProxyModePatch(ctx, content, steps);
    if (bootPatchMarkersPresent(content) && content !== normalizeEol(original)) {
      fs.writeFileSync(bootFile, content, 'utf8');
      const nodeBin0 = ctx.nodeExe && ctx.nodeExe();
      const checker0 = (nodeBin0 && fs.existsSync(nodeBin0)) ? nodeBin0 : process.execPath;
      const chk0 = spawnSync(checker0, ['--check', bootFile], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      if (chk0.status !== 0) {
        try { fs.writeFileSync(bootFile, original, 'utf8'); } catch {}
        throw new Error('proxy-mode 补丁语法校验失败，已回滚: ' + (chk0.stderr || chk0.stdout || '').slice(-300));
      }
      ctx.log('update', '已补齐 proxy-mode 补丁: ' + bootFile);
      return { changed: true, steps };
    }
    if (bootPatchMarkersPresent(content)) return { changed: false, steps };
    throw new Error('exFAT 补丁 proxy-mode 补齐失败: ' + bootFile);
  }

  // 1) extend fs import with cpSync/renameSync (tolerate either already present)
  const importCandidates = [
    'import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
    'import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
  ];
  const importReplacement = 'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";';
  if (content.includes('cpSync') && content.includes('renameSync')) {
    steps.push({ name: 'fs-import', status: 'already' });
  } else {
    const r1 = replaceFirst(content, [importCandidates[0], importCandidates[1]], importReplacement);
    if (!r1.hit) {
      // try a looser pattern: any "import { ... } from "node:fs";" that lacks cpSync
      const loose = content.match(/import\s*\{[^}]+\}\s*from\s*"node:fs";/);
      if (loose && !loose[0].includes('cpSync')) {
        content = content.replace(loose[0], importReplacement);
        steps.push({ name: 'fs-import', status: 'applied', via: 'loose' });
      } else if (loose && loose[0].includes('cpSync')) {
        steps.push({ name: 'fs-import', status: 'already' });
      } else {
        throw new Error('exFAT 补丁步骤 fs-import 失败：未找到 node:fs import');
      }
    } else {
      content = r1.text;
      steps.push({ name: 'fs-import', status: 'applied' });
    }
  }

  // 2) include optionalDependencies in managed package list
  const optionalCandidates = [
    'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];',
    'return [...Object.keys(manifest.dependencies ?? {}),...Object.keys(manifest.peerDependencies ?? {})];',
    'return [...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.peerDependencies || {})];',
  ];
  const optionalNew = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];';
  if (content.includes('...Object.keys(manifest.optionalDependencies ?? {})')) {
    steps.push({ name: 'optional-deps', status: 'already' });
  } else {
    const r2 = replaceFirst(content, optionalCandidates, optionalNew);
    if (!r2.hit) {
      const loose = content.match(/return\s*\[\.\.\.Object\.keys\(manifest\.dependencies\s*\?\?\s*\{\}\)\s*,\s*\.\.\.Object\.keys\(manifest\.peerDependencies\s*\?\?\s*\{\}\)\]/);
      if (loose) {
        content = content.replace(loose[0], optionalNew);
        steps.push({ name: 'optional-deps', status: 'applied', via: 'loose' });
      } else {
        throw new Error('exFAT 补丁步骤 optional-deps 失败：锚点未找到（上游格式可能已变化）');
      }
    } else {
      content = r2.text;
      steps.push({ name: 'optional-deps', status: 'applied' });
    }
  }

  // 3) insert dshCopyCurrent helper before ensureSymlink doc anchor
  if (content.includes('function dshCopyCurrent')) {
    steps.push({ name: 'copy-helper', status: 'already' });
  } else {
    const anchors = [
      '/** Ensure `link` is a symlink to `target`, replacing a wrong link or a dsh-managed packaged proxy. */',
      '/** Ensure `link` is a symlink to `target`',
    ];
    const helper =
      '/** Return whether a real directory is a complete DSH USB copy fallback for this target. */\n' +
      'function dshCopyCurrent(link, target) {\n' +
      '\ttry {\n' +
      '\t\treturn readFileSync(join(link, ".dsh-copy-ok"), "utf8") === target;\n' +
      '\t} catch {\n' +
      '\t\treturn false;\n' +
      '\t}\n' +
      '}\n\n';
    let inserted = false;
    for (const a of anchors) {
      const idx = content.indexOf(a);
      if (idx >= 0) {
        content = content.slice(0, idx) + helper + content.slice(idx);
        inserted = true;
        steps.push({ name: 'copy-helper', status: 'applied' });
        break;
      }
    }
    if (!inserted) {
      throw new Error('exFAT 补丁步骤 copy-helper 失败：ensureSymlink 锚点未找到');
    }
  }

  // 4) replace throw-on-non-symlink with copy-fallback early return
  const TICK = String.fromCharCode(96);
  const throwBody = 'dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback';
  const throwCandidates = [
    'if ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error(' + TICK + throwBody + TICK + ');',
    'if ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === undefined) throw new Error(' + TICK + throwBody + TICK + ');',
  ];
  const throwNew = 'if (!stat.isDirectory()) throw new Error(' + TICK + throwBody + TICK + ');\n// DSH USB: exFAT/FAT32 copy fallback. A marker file whose content matches\n// this target identifies a complete copy; anything stale is rebuilt below.\nif (dshCopyCurrent(link, target)) return;';
  if (content.includes('if (dshCopyCurrent(link, target)) return;')) {
    steps.push({ name: 'throw-to-copy', status: 'already' });
  } else {
    const r4 = replaceFirst(content, throwCandidates, throwNew);
    if (!r4.hit) {
      throw new Error('exFAT 补丁步骤 throw-to-copy 失败：ensureSymlink throw 锚点未找到');
    }
    content = r4.text;
    steps.push({ name: 'throw-to-copy', status: 'applied' });
  }

  // 5) symlink current-check also accepts a valid copy directory
  const currentCandidates = [
    'if (entry.kind === "symlink") return stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir;',
    'if (entry.kind === "symlink") {\n\t\t\treturn stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir;\n\t\t}',
  ];
  const currentNew =
    'if (entry.kind === "symlink") {\n' +
    '\t\t\tif (stat.isSymbolicLink()) return readlinkSync(link) === entry.packageDir;\n' +
    '\t\t\tif (stat.isDirectory()) return dshCopyCurrent(link, entry.packageDir);\n' +
    '\t\t\treturn false;\n' +
    '\t\t}';
  if (content.includes('if (stat.isDirectory()) return dshCopyCurrent(link, entry.packageDir);')) {
    steps.push({ name: 'current-check', status: 'already' });
  } else {
    const r5 = replaceFirst(content, currentCandidates, currentNew);
    if (!r5.hit) {
      const loose = content.match(/if\s*\(entry\.kind\s*===\s*"symlink"\)\s*return\s*stat\.isSymbolicLink\(\)\s*&&\s*readlinkSync\(link\)\s*===\s*entry\.packageDir;/);
      if (loose) {
        content = content.replace(loose[0], currentNew);
        steps.push({ name: 'current-check', status: 'applied', via: 'loose' });
      } else {
        throw new Error('exFAT 补丁步骤 current-check 失败：symlink current 锚点未找到');
      }
    } else {
      content = r5.text;
      steps.push({ name: 'current-check', status: 'applied' });
    }
  }

  // 6) symlink catch path: junction unsupported → copy package
  const catchCandidates = [
    'if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;',
    'if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target))\n\t\tthrow error;',
  ];
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
  if (content.includes('junctions unsupported here (exFAT/FAT32)')) {
    steps.push({ name: 'catch-copy', status: 'already' });
  } else {
    const r6 = replaceFirst(content, catchCandidates, catchNew);
    if (!r6.hit) {
      const loose = content.match(/if\s*\(error\.code\s*!==\s*"EEXIST"\s*\|\|\s*!lstatSync\(link\)\.isSymbolicLink\(\)\s*\|\|\s*!symlinkPointsTo\(link,\s*target\)\)\s*throw\s*error;/);
      if (loose) {
        content = content.replace(loose[0], catchNew);
        steps.push({ name: 'catch-copy', status: 'applied', via: 'loose' });
      } else {
        throw new Error('exFAT 补丁步骤 catch-copy 失败：ensureSymlink catch 锚点未找到');
      }
    } else {
      content = r6.text;
      steps.push({ name: 'catch-copy', status: 'applied' });
    }
  }

  content = applyProxyModePatch(ctx, content, steps);

  if (!bootPatchMarkersPresent(content)) {
    throw new Error('exFAT/可选依赖补丁校验失败（标记不完整）: ' + bootFile +
      ' steps=' + steps.map((s) => s.name + ':' + s.status).join(','));
  }

  const changed = content !== normalizeEol(original);
  if (changed) {
    fs.writeFileSync(bootFile, content, 'utf8');
    const nodeBin = ctx.nodeExe && ctx.nodeExe();
    const checker = (nodeBin && fs.existsSync(nodeBin)) ? nodeBin : process.execPath;
    let check = spawnSync(checker, ['--check', bootFile], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    // ESM files may fail CJS --check ("Cannot use import statement outside a module").
    if (check.status !== 0 && /Cannot use import statement|Unexpected token 'export'/.test(check.stderr || '')) {
      const mjs = bootFile + '.check.mjs';
      try {
        fs.copyFileSync(bootFile, mjs);
        check = spawnSync(checker, ['--check', mjs], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
      } finally {
        try { fs.rmSync(mjs, { force: true }); } catch {}
      }
    }
    if (check.status !== 0) {
      try { fs.writeFileSync(bootFile, original, 'utf8'); } catch {}
      const checkErr = (check.stderr || check.stdout || '').slice(-400);
      throw new Error('exFAT 补丁写回后语法校验失败，已回滚: ' + checkErr);
    }
    ctx.log('update', '已应用 exFAT/可选依赖兼容补丁: ' + bootFile +
      ' steps=' + steps.map((s) => s.name + ':' + s.status).join(','));
  } else {
    ctx.log('update', 'exFAT/可选依赖补丁无变化: ' + bootFile);
  }
  return { changed, steps };
}

function patchMcpPath(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(ctx.userDataDir, '.dsh');
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

// --- cleanup ---------------------------------------------------------------

function rmQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); return true; }
  catch { return false; }
}

function cleanupTemp(ctx) {
  const root = ctx.userDataDir;
  let removed = 0;

  const staging = stagingDir(ctx);
  if (fs.existsSync(staging)) {
    if (rmQuiet(staging)) { removed++; ctx.log('update', '清理 staging: ' + staging); }
    else ctx.log('update', '清理 staging 失败: ' + staging);
  }

  // Agent spill/subprocess temps redirected onto the USB.
  const tmp = path.join(root, 'temp');
  if (fs.existsSync(tmp) && rmQuiet(tmp)) {
    removed++;
    ctx.log('update', '清理 temp/: ' + tmp);
  }

  // keep newest 1 of old/broken backups
  for (const prefix of [OLD_PREFIX, BROKEN_PREFIX]) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
        .map((e) => {
          const full = path.join(root, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch {}
          return { full, name: e.name, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    } catch { entries = []; }
    for (const e of entries.slice(1)) {
      if (rmQuiet(e.full)) { removed++; ctx.log('update', '清理旧备份: ' + e.name); }
    }
  }

  // legacy client-update download dir
  const updates = path.join(root, 'updates');
  if (fs.existsSync(updates)) {
    if (rmQuiet(updates)) { removed++; ctx.log('update', '清理 updates/ 残留'); }
  }

  // legacy names from pre-rename builds (agent-old-*, agent-broken-*, agent-staging)
  try {
    const legacy = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (
        e.name === 'agent-staging' ||
        e.name.startsWith('agent-old-') ||
        e.name.startsWith('agent-broken-')
      ));
    for (const e of legacy) {
      if (rmQuiet(path.join(root, e.name))) { removed++; ctx.log('update', '清理旧命名残留: ' + e.name); }
    }
  } catch {}

  return removed;
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

  // Patch the freshly installed boot code before it can run.
  patchBootForExfat(ctx, path.join(staging, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'));
  patchMcpPath(ctx);

  // Atomic swap: old overlay -> backup, staging -> overlay.
  const overlay = overlayDir(ctx);
  const backup = path.join(ctx.userDataDir, OLD_PREFIX + Date.now());
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

  try { cleanupTemp(ctx); } catch (err) { ctx.log('update', '更新后清扫失败: ' + err.message); }

  const settings = loadSettings(ctx);
  settings.skipVersion = null;
  saveSettings(ctx, settings);
  ctx.log('update', '更新完成: ' + PKG + '@' + version);
  return { version, logPath };
}

function rollback(ctx) {
  const overlay = overlayDir(ctx);
  if (!fs.existsSync(overlay)) return null;
  const broken = path.join(ctx.userDataDir, BROKEN_PREFIX + Date.now());
  fs.renameSync(overlay, broken);
  try { cleanupTemp(ctx); } catch {}
  ctx.log('update', '已回退到内置版本（问题副本保留在 ' + broken + '）');
  return broken;
}

// --- host NTFS install path (exFAT / proxy mode) ---------------------------

function findHostUpdateScript(exeDir) {
  const candidates = [
    path.join(exeDir, 'update-dsh.ps1'),
    path.join(exeDir, 'scripts', 'update-dsh.ps1'),
    path.join(path.dirname(exeDir), 'scripts', 'update-dsh.ps1'),
  ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || null;
}

/**
 * Schedule a host-side agent update via update-dsh.ps1 after this process exits.
 * Used when the USB filesystem cannot create junctions (exFAT/FAT32): npm install
 * on that volume is unreliable, so install on the host NTFS temp dir, copy back,
 * patch, atomic-swap, heal profiles, then relaunch.
 *
 * Returns the spawned script path. Caller must quit the app afterwards.
 */
function applyUpdateViaHost(ctx, version, exeDir) {
  const root = exeDir || process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const ps1 = findHostUpdateScript(root);
  if (!ps1) {
    throw new Error('未找到 update-dsh.ps1（应位于 exe 旁或 scripts/ 下），无法走宿主机安装路径。');
  }
  abort();
  const logDir = path.join(ctx.userDataDir, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const cmdPath = path.join(logDir, 'host-update.cmd');
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const psExe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const selfPid = process.pid;
  // ASCII-only cmd: wait for Electron to exit, then run the host installer.
  const lines = [
    '@echo off',
    'setlocal',
    'set "SELF=' + selfPid + '"',
    'set "PS1=' + ps1 + '"',
    'set "ROOT=' + root + '"',
    'set "VER=' + version + '"',
    ':wait',
    'tasklist /FI "PID eq %SELF%" 2>nul | find "%SELF%" >nul',
    'if not errorlevel 1 (',
    '  ping -n 2 127.0.0.1 >nul',
    '  goto wait',
    ')',
    '"' + psExe + '" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Yes -Launch -Version "%VER%" -DshRoot "%ROOT%"',
    'endlocal',
  ];
  fs.writeFileSync(cmdPath, lines.join('\r\n'), 'utf8');
  const cmdExe = process.env.ComSpec || path.join(sysRoot, 'System32', 'cmd.exe');
  const child = spawn(cmdExe, ['/d', '/c', cmdPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  ctx.log('update', '已调度宿主机更新: ' + ps1 + ' version=' + version + ' cmd=' + cmdPath);
  return cmdPath;
}

module.exports = {
  PKG,
  AGENT_DIR_NAME,
  STAGING_DIR_NAME,
  OLD_PREFIX,
  BROKEN_PREFIX,
  loadSettings,
  saveSettings,
  overlayDir,
  stagingDir,
  overlayBinPath,
  overlayVersion,
  bundledVersion,
  activeVersion,
  compareVersions,
  checkLatest,
  applyUpdate,
  applyUpdateViaHost,
  findHostUpdateScript,
  rollback,
  abort,
  patchBootForExfat,
  patchMcpPath,
  cleanupTemp,
};
