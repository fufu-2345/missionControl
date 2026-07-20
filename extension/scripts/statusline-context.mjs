#!/usr/bin/env node
// Claude Code statusLine: shows how full the context window is — as "% until
// auto-compact" — with a color-fading bar INSIDE the REPL (bottom line). Wire it
// in ~/.claude/settings.json (global → every claude session shows it):
//   "statusLine": { "type": "command", "command": "<abs>/statusline-context.mjs" }
//
// Claude pipes session JSON on stdin. We use context_window.total_input_tokens
// (current context size, includes cache) and divide by the EFFECTIVE window =
// min(context_window_size, autoCompactWindow). Auto-compact fires near the top of
// the autoCompactWindow cap (e.g. a [1m] session capped at 700k compacts ~686k),
// so measuring against that cap — not the raw 1M — is what "% until auto-compact"
// means. Output: `ctx [██████░░░░] NN%`, hue fading green→yellow→red with %.
//
// Self-contained: no deps, no imports from the extension build, never throws to
// the UI. Block chars █░ render fine in terminals (NOT emoji).

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WINDOW = 200000; // Claude Code's non-1M model default
const BAR_LEN = 10;

/** Context fill as 0–100% of the effective window (auto-compact fires ~98%). */
export function contextPct(tokens, window) {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

// Fade anchors: green → yellow-green(75) → orange(90) → red(100), matching the
// green<75 / yellow 75–90 / red>90 zones but continuous between.
const HUE_ANCHORS = [
  [0, 130],
  [75, 80],
  [90, 40],
  [100, 0],
];

/** Gauge hue (HSL degrees) for a fill pct, interpolated across HUE_ANCHORS. */
export function fillHue(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < HUE_ANCHORS.length; i++) {
    const [x0, h0] = HUE_ANCHORS[i - 1];
    const [x1, h1] = HUE_ANCHORS[i];
    if (p <= x1) {
      const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0);
      return Math.round(h0 + (h1 - h0) * t);
    }
  }
  return 0;
}

/** HSL (h 0–360, s/l 0–1) → {r,g,b} 0–255. */
export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** The rendered status line: `ctx [██████░░░░] NN%` in a truecolor faded hue. */
export function renderBar(pct, len = BAR_LEN) {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  const { r, g, b } = hslToRgb(fillHue(pct), 0.7, 0.55);
  return `\x1b[38;2;${r};${g};${b}mctx [${bar}] ${pct}%\x1b[0m`;
}

/** Effective autoCompactWindow for a cwd: walk up to $HOME collecting each
 *  level's .claude/settings.local.json then settings.json (most-specific first),
 *  then global ~/.claude/settings.json. First numeric autoCompactWindow wins;
 *  null when none is configured. */
export function resolveAutoCompactWindow(cwd) {
  const home = homedir();
  const files = [];
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    files.push(join(dir, ".claude", "settings.local.json"));
    files.push(join(dir, ".claude", "settings.json"));
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  files.push(join(home, ".claude", "settings.json"));
  for (const f of files) {
    try {
      const v = JSON.parse(readFileSync(f, "utf8")).autoCompactWindow;
      if (typeof v === "number" && v > 0) return v;
    } catch {
      /* missing/garbled — try the next */
    }
  }
  return null;
}

/** Build the status line from Claude's stdin JSON object. */
export function computeLine(input) {
  const cw = (input && input.context_window) || {};
  const tokens = cw.total_input_tokens || 0;
  const modelWindow = cw.context_window_size || DEFAULT_WINDOW;
  const cwd = (input && (input.cwd || (input.workspace && input.workspace.current_dir))) || process.cwd();
  const acw = resolveAutoCompactWindow(cwd);
  const effective = acw ? Math.min(modelWindow, acw) : modelWindow;
  return renderBar(contextPct(tokens, effective));
}

// Run only when executed directly (not when imported by tests).
const invoked = process.argv[1] ? safeReal(process.argv[1]) : "";
if (invoked && invoked === safeReal(fileURLToPath(import.meta.url))) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw);
    } catch {
      /* no/garbled stdin — render an empty gauge rather than crash */
    }
    try {
      process.stdout.write(computeLine(input));
    } catch {
      /* never break the REPL's status line */
    }
  });
}

function safeReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
