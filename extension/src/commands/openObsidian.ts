import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

/** How to launch the Obsidian desktop app on this machine. Discovered at call time
 *  (never a hardcoded path) so it survives moving machines: PATH → user AppImage →
 *  flatpak → snap. Returns null if Obsidian can't be found. */
export function findObsidianLauncher(
  deps: {
    onPath?: (cmd: string) => boolean;
    readdir?: (dir: string) => string[];
    home?: string;
  } = {},
): { cmd: string; args: string[] } | null {
  const onPath =
    deps.onPath ??
    ((cmd: string) => {
      try {
        cp.execFileSync("which", [cmd], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
  const readdir = deps.readdir ?? ((dir: string) => fs.readdirSync(dir));
  const home = deps.home ?? os.homedir();

  // 1) a real `obsidian` binary on PATH (some installs / distro packages)
  if (onPath("obsidian")) return { cmd: "obsidian", args: [] };

  // 2) an Obsidian AppImage the user downloaded (the soulbrew VM case).
  //    --no-sandbox + --disable-gpu match what runs on this GPU-less headless VM;
  //    both are harmless elsewhere (just skip GPU accel / the unavailable sandbox).
  for (const dir of [path.join(home, "Applications"), home, path.join(home, "Downloads")]) {
    let hit: string | undefined;
    try {
      hit = readdir(dir).find((f) => /^obsidian.*\.appimage$/i.test(f));
    } catch {
      continue; // dir missing/unreadable
    }
    if (hit) {
      return {
        cmd: path.join(dir, hit),
        args: ["--appimage-extract-and-run", "--no-sandbox", "--disable-gpu"],
      };
    }
  }

  // 3) flatpak / snap installs
  if (onPath("flatpak")) return { cmd: "flatpak", args: ["run", "md.obsidian.Obsidian"] };
  if (onPath("snap")) return { cmd: "snap", args: ["run", "obsidian"] };

  return null;
}

/** Launch the Obsidian app (opens its last-used vault). If an instance is already
 *  running, Obsidian focuses it rather than spawning a twin. */
export function openObsidianCommand(): void {
  const launcher = findObsidianLauncher();
  if (!launcher) {
    void vscode.window.showWarningMessage(
      "Mission Control: หา Obsidian ไม่เจอ — ลงแอป Obsidian ก่อน (obsidian.md) แล้วลองใหม่",
    );
    return;
  }
  try {
    const child = cp.spawn(launcher.cmd, launcher.args, { detached: true, stdio: "ignore" });
    child.unref(); // let it outlive the extension host
    vscode.window.setStatusBarMessage("Mission Control: เปิด Obsidian…", 4000);
  } catch (e) {
    void vscode.window.showErrorMessage("Mission Control: เปิด Obsidian ไม่ได้ — " + String(e));
  }
}
