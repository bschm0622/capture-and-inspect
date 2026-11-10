// Builds a throwaway copy of the extension to load into Chromium. The repo
// directory is never loaded directly: it holds node_modules/ and test/, and
// the copy gets `host_permissions: ["<all_urls>"]` so automation can inject
// scripts and call captureVisibleTab without the toolbar click that normally
// grants activeTab. The shipped manifest is not touched.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const isExtensionFile = (f) =>
  f === 'manifest.json' ||
  /^[^/]+\.(js|html|css)$/.test(f) ||
  /^icons\/[^/]+$/.test(f);

// ref === null: the working tree as it is now (uncommitted edits included).
export function buildExtension(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-ext-'));
  let files;
  if (ref) {
    const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO }).toString().trim();
    files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: REPO })
      .toString().split('\n').filter(isExtensionFile);
    for (const f of files) {
      const buf = execFileSync('git', ['show', `${sha}:${f}`], { cwd: REPO, maxBuffer: 64 << 20 });
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), buf);
    }
  } else {
    files = [
      ...fs.readdirSync(REPO).filter((f) => isExtensionFile(f) && fs.statSync(path.join(REPO, f)).isFile()),
      ...fs.readdirSync(path.join(REPO, 'icons')).map((f) => `icons/${f}`)
    ];
    for (const f of files) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
    }
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, files };
}

export function describeRef(ref) {
  if (!ref) {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '*.js', '*.html', 'manifest.json', 'icons'], { cwd: REPO })
      .toString().split('\n').filter((l) => l && !l.includes('test/')).length > 0;
    return `working tree (HEAD ${head}${dirty ? ', with uncommitted changes' : ''})`;
  }
  return `${ref} (${execFileSync('git', ['rev-parse', '--short', ref], { cwd: REPO }).toString().trim()})`;
}
