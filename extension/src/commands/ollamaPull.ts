import * as cp from "node:child_process";

// Spawns `ollama pull <tag>` locally (ollama lives at /usr/local/bin/ollama on
// this machine, on PATH). Maps the UI model key to the real ollama tag. No
// vscode import — the pure pullArgs() is unit-tested; pullModel() streams
// progress lines to a callback the webview host turns into postMessage updates.

const TAGS: Record<string, string> = {
  "bge-m3": "bge-m3",
  nomic: "nomic-embed-text",
};

/** UI key → ollama pull argv. */
export function pullArgs(model: string): string[] {
  return ["pull", TAGS[model] || model];
}

/** Spawn `ollama pull`, stream stderr (progress) lines, resolve exit code. */
export function pullModel(model: string, onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = cp.spawn("ollama", pullArgs(model), { stdio: ["ignore", "pipe", "pipe"] });
    const feed = (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}
