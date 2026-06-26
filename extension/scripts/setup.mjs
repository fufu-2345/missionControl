#!/usr/bin/env node
// One-shot setup for the Mission Control VSCode extension.
//
// Invoked by `pnpm run setup`. Runs preflight checks → pnpm install →
// tsc compile → backend health probe → prints next steps.
//
// Cross-platform (Node 18+ on Linux/macOS/Windows-WSL).

import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = dirname(HERE);

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function header(t) {
  const bar = "═".repeat(56);
  console.log(`\n${bar}\n  ${bold(t)}\n${bar}`);
}

function step(t) {
  console.log(`\n▶ ${t}`);
}

function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const result = fn();
    console.log(green(result || "OK"));
    return true;
  } catch (e) {
    console.log(red("FAIL"));
    console.error(`    ${red(e.message)}`);
    return false;
  }
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit", cwd: EXT_ROOT });
}

async function probe(url, label) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok
      ? `${label} ${green("✓")}`
      : `${label} ${red("✗")} (HTTP ${r.status})`;
  } catch {
    return `${label} ${dim("○ (not running)")}`;
  }
}

// ─────────────────────────  RUN  ─────────────────────────

header("Mission Control extension — setup");

// 1. Preflight
step("Preflight checks");

const nodeOk = check("Node ≥18", () => {
  const major = +process.versions.node.split(".")[0];
  if (major < 18) throw new Error(`got v${process.versions.node}, need ≥18`);
  return `v${process.versions.node}`;
});
if (!nodeOk) process.exit(1);

check("pnpm", () => execSync("pnpm --version").toString().trim());

check("tsc (after install)", () => {
  // Lazy — typescript is a devDep, may not be installed yet on first run.
  // Skip this check; install step below will pull it.
  return dim("(will install below)");
});

// 2. Install dependencies
step("Installing dependencies (pnpm install)");
try {
  run("pnpm install --prefer-offline");
} catch {
  console.error(red("\n  pnpm install failed — see error above"));
  process.exit(1);
}

// 3. Compile TypeScript
step("Compiling TypeScript (tsc -p ./)");
try {
  run("pnpm exec tsc -p ./");
  console.log(`  ${green("out/ built ✓")}`);
} catch {
  console.error(red("\n  tsc compile failed — see error above"));
  process.exit(1);
}

// 4. Backend health (best-effort, informational only)
step("Backend health");
const rest = await probe("http://127.0.0.1:7000/healthz", "REST :7000");
const ws = await probe("http://127.0.0.1:7001/healthz", "WS :7001");
console.log(`  ${rest}`);
console.log(`  ${ws}`);

const backendUp = rest.includes("✓");
if (!backendUp) {
  console.log(yellow("\n  Backend isn't running. To install + start:"));
  console.log(`    ${dim("bash scripts/setup.sh        # full first-time install")}`);
  console.log(`    ${dim("pm2 start ~/.mission-control/server/ecosystem.config.js")}`);
}

// 5. Done
header("✅ Setup complete");
console.log("\nNext steps:");
console.log(`  1. Open VSCode at ${bold("extension/")} and press ${bold("F5")}`);
console.log(`  2. In the dev host: ${bold("Ctrl+Shift+P")} → "Mission Control: Setup"`);
console.log(`  3. Enter GitHub PAT (Anthropic uses Claude Code Max, no key)`);
console.log(`\nDev loop:`);
console.log(`  ${dim("cd extension && pnpm run watch   # leave running")}`);
console.log(`  ${dim("Ctrl+R inside dev host to reload after each save")}\n`);
