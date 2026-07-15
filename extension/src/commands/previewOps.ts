import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT = ".orches-preview.sh";
const PIDF = ".orches-preview.pid";
const LOGF = ".orches-preview.log";

/** The dev-server URL printed in the preview log (Next :3000 / Vite :5173 / py :8000).
 *  0.0.0.0 and 127.0.0.1 are normalized to localhost so the browser opens cleanly. */
export function parsePreviewUrl(logText: string): string | null {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i.exec(logText);
  if (!m) return null;
  return m[0].replace(/\/\/(?:127\.0\.0\.1|0\.0\.0\.0)/i, "//localhost");
}

/** A project can preview iff it ships the .orches-preview.sh toggle script. */
export function isPreviewAvailable(projectPath: string): boolean {
  try {
    return fs.statSync(path.join(projectPath, SCRIPT)).isFile();
  } catch {
    return false;
  }
}

/** Is the dev server live right now? (pid file present + that process alive) */
export function isPreviewRunning(projectPath: string): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(path.join(projectPath, PIDF), "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return true;
  } catch {
    return false;
  }
}

/** Toggle the dev server via .orches-preview.sh (the script starts if down, stops if up).
 *  Returns whether it JUST started (vs stopped), from the pre-run state.
 *  Callers MUST gate on isPreviewAvailable() first. */
export function togglePreview(projectPath: string): { started: boolean } {
  const wasRunning = isPreviewRunning(projectPath);
  const child = cp.spawn("bash", [path.join(projectPath, SCRIPT)], {
    cwd: projectPath,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { started: !wasRunning };
}

/** Poll the preview log for the served URL; fall back to :3000 after timeout. */
export async function waitForPreviewUrl(
  projectPath: string,
  timeoutMs = 15000,
): Promise<string> {
  const logPath = path.join(projectPath, LOGF);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = fs.readFileSync(logPath, "utf8");
    } catch {
      /* log not written yet */
    }
    const url = parsePreviewUrl(text);
    if (url) return url;
    if (Date.now() >= deadline) return "http://localhost:3000";
    await new Promise((r) => setTimeout(r, 500));
  }
}
