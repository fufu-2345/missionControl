// Server-side GitHub repo cloning for external skill ingestion.
//
// Public repos only (spec §8 — no private-repo tokens). We shallow-clone into
// a fresh temp dir and hand the path back to the caller, who is responsible
// for calling cleanup(dir) when done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 60_000;

/**
 * Validate that `url` is an http(s) GitHub URL.
 * @param {string} url
 * @returns {boolean}
 */
export function isGithubUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'github.com' || host === 'www.github.com';
}

/**
 * Shallow-clone a public GitHub repo into a fresh unique temp directory.
 *
 * @param {string} url  http(s) github.com URL
 * @returns {Promise<string>} absolute path to the temp dir containing the clone
 * @throws {Error} on invalid URL or clone failure/timeout
 */
export async function cloneRepo(url) {
  if (!isGithubUrl(url)) {
    throw new Error('invalid url: must be an http(s) github.com URL');
  }

  const unique = `agentskill-clone-${Date.now()}-${randomBytes(6).toString('hex')}`;
  const destDir = path.join(os.tmpdir(), unique);
  fs.mkdirSync(destDir, { recursive: true });

  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', url.trim(), destDir],
      { timeout: CLONE_TIMEOUT_MS }
    );
  } catch (err) {
    // Clean up the partial/empty dir before surfacing the error.
    cleanup(destDir);
    const reason = err?.killed ? 'clone timed out' : (err?.stderr?.toString().trim() || err.message);
    throw new Error(`git clone failed: ${reason}`);
  }

  return destDir;
}

/**
 * Recursively remove a directory. Safe to call on a missing path.
 * @param {string} dir
 */
export function cleanup(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export default { isGithubUrl, cloneRepo, cleanup };
