import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Pure discovery for graphify code-graphs. No vscode. Graphify output is
// centralized under ~/.oracle/graphify/<repo>/ (each repo's graphify-out is a
// symlink to its folder here), so one scan lists every built graph. The vscode
// glue that opens the html lives in graphOpen.ts.

export interface GraphEntry {
  /** The repo subfolder name under the graphify base dir. */
  repo: string;
  /** Absolute path to that repo's graph.html. */
  htmlPath: string;
}

/** Central home for graphify graphs: ~/.oracle/graphify. */
export function graphifyBaseDir(): string {
  return path.join(os.homedir(), ".oracle", "graphify");
}

/** List repos under baseDir that have a graph.html, sorted by repo name. */
export function findGraphHtml(baseDir: string): GraphEntry[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return []; // base dir missing or unreadable → nothing to open
  }
  const out: GraphEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const htmlPath = path.join(baseDir, d.name, "graph.html");
    if (fs.existsSync(htmlPath)) out.push({ repo: d.name, htmlPath });
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}
