// Pure guard + fs removal for the delete-project button (orchestrator screen).
// NO vscode import — unit-tested standalone with `bun test`. The native confirm
// dialogs + tmux running-check live in webview/orchestrator.ts. The path always
// comes from a scanned ResumableProject.path, never user text; this guard is the
// last line against an rm -rf of the wrong directory.
import * as fs from "node:fs";
import * as path from "node:path";

import { snapshotProjectDocs } from "./docsBackup";

/** Deletable only when: exists, resolves (symlinks followed) to a real
 *  directory, is a DIRECT child of a dir named `projects` (i.e.
 *  `.../projects/<name>`), and is not the `projects` dir itself. */
export function canDeleteProjectPath(projectPath: string): { ok: boolean; reason?: string } {
  if (!projectPath || typeof projectPath !== "string") return { ok: false, reason: "path ว่าง" };
  let resolved: string;
  try {
    resolved = fs.realpathSync(projectPath); // follows symlinks + normalizes; throws if missing
  } catch {
    return { ok: false, reason: `ไม่พบโฟลเดอร์: ${projectPath}` };
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    return { ok: false, reason: `stat ไม่ได้: ${resolved}` };
  }
  if (!st.isDirectory()) return { ok: false, reason: "ไม่ใช่โฟลเดอร์" };
  const parent = path.dirname(resolved);
  if (resolved === parent) return { ok: false, reason: "path ไม่ถูกต้อง (root)" };
  if (path.basename(parent) !== "projects")
    return { ok: false, reason: `ต้องเป็นลูกตรงใต้ projects/ (พบ: ${resolved})` };
  return { ok: true };
}

/** type-to-confirm: พิมพ์ (trim แล้ว) ต้องตรง basename เป๊ะ. */
export function confirmNameMatches(typed: string, expected: string): boolean {
  return typeof typed === "string" && typed.trim() === expected;
}

/** Guard → snapshot docs → ลบโฟลเดอร์ (recursive). ไม่ผ่าน guard หรือ snapshot
 *  ล้มเหลว = ไม่ลบ + reason. snapshot injectable เพื่อเทส (default = ตัวจริง). */
export function removeProjectDir(
  projectPath: string,
  snapshot: (p: string) => void = snapshotProjectDocs,
): { deleted: boolean; reason?: string } {
  const g = canDeleteProjectPath(projectPath);
  if (!g.ok) return { deleted: false, reason: g.reason };
  const resolved = fs.realpathSync(projectPath);
  try {
    snapshot(resolved); // back up BEFORE the destructive delete
  } catch (e) {
    return { deleted: false, reason: `backup ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` };
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return { deleted: true };
}
