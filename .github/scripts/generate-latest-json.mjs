#!/usr/bin/env node
// 在 Release 流程末尾运行：从 GitHub Release 资产中提取 .sig 内容，
// 拼出 latest.json 并上传到同一个 Release，供 Tauri Updater 拉取。

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAG = process.env.TAG;
if (!TAG) {
  console.error('TAG env is required');
  process.exit(1);
}
const PKG_VERSION = TAG.replace(/^v/, '');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function listAssets() {
  const json = gh(['release', 'view', TAG, '--json', 'assets']);
  return JSON.parse(json).assets || [];
}

function getNotes() {
  try {
    const json = gh(['release', 'view', TAG, '--json', 'body']);
    return JSON.parse(json).body || '';
  } catch {
    return '';
  }
}

const assets = listAssets();
const tmp = mkdtempSync(join(tmpdir(), 'updater-'));

function findAsset(regex) {
  return assets.find((a) => regex.test(a.name));
}

function findSig(regex) {
  const sigRegex = new RegExp(regex.source + '\\.sig$');
  const asset = assets.find((a) => sigRegex.test(a.name));
  if (!asset) return null;
  const out = join(tmp, asset.name);
  execFileSync('gh', ['release', 'download', TAG, '-p', asset.name, '-O', out, '--clobber']);
  return readFileSync(out, 'utf8').trim();
}

// 平台匹配规则 —— 跟 tauri-action 输出的产物文件名对应。
// macOS:    AI Terminal_0.3.2_aarch64.app.tar.gz / x64.app.tar.gz
// Windows:  AI Terminal_0.3.2_x64-setup.nsis.zip
// Linux:    ai-terminal_0.3.2_amd64.AppImage.tar.gz
const targets = {
  'darwin-aarch64': /aarch64\.app\.tar\.gz$/,
  'darwin-x86_64': /(?:x64|x86_64)\.app\.tar\.gz$/,
  'windows-x86_64': /x64-setup\.nsis\.zip$/,
  'linux-x86_64': /amd64\.AppImage\.tar\.gz$/,
};

const platforms = {};
for (const [key, regex] of Object.entries(targets)) {
  const asset = findAsset(regex);
  if (!asset) {
    console.log(`[skip] no asset for ${key} (pattern: ${regex})`);
    continue;
  }
  const signature = findSig(regex);
  if (!signature) {
    console.log(`[skip] no .sig for ${key} (asset: ${asset.name})`);
    continue;
  }
  platforms[key] = { signature, url: asset.browser_download_url };
  console.log(`[ok] ${key}: ${asset.name}`);
}

const manifest = {
  version: PKG_VERSION,
  notes: getNotes(),
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  platforms,
};

const out = 'latest.json';
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log('--- latest.json ---');
console.log(readFileSync(out, 'utf8'));

if (Object.keys(platforms).length === 0) {
  console.error('No platforms resolved — refusing to upload empty manifest.');
  process.exit(1);
}

execFileSync('gh', ['release', 'upload', TAG, out, '--clobber'], { stdio: 'inherit' });
rmSync(tmp, { recursive: true, force: true });
console.log('latest.json uploaded to release', TAG);
