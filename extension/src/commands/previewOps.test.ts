import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isPreviewAvailable,
  isPreviewRunning,
  parsePreviewUrl,
  waitForPreviewUrl,
} from "./previewOps";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-preview-"));
}

test("parsePreviewUrl: Next / Vite / Django logs, 0.0.0.0 normalized to localhost", () => {
  expect(parsePreviewUrl("▲ Next.js 15\n- Local: http://localhost:3000")).toBe(
    "http://localhost:3000",
  );
  expect(parsePreviewUrl("➜  Local:   http://localhost:5173/")).toBe(
    "http://localhost:5173",
  );
  expect(parsePreviewUrl("Starting development server at http://127.0.0.1:8000/")).toBe(
    "http://localhost:8000",
  );
  expect(parsePreviewUrl("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)")).toBe(
    "http://localhost:8000",
  );
  expect(parsePreviewUrl("no url here")).toBeNull();
});

test("isPreviewAvailable: true only when .orches-preview.sh exists", () => {
  const p = tmp();
  expect(isPreviewAvailable(p)).toBe(false);
  fs.writeFileSync(path.join(p, ".orches-preview.sh"), "#!/usr/bin/env bash\n");
  expect(isPreviewAvailable(p)).toBe(true);
});

test("isPreviewRunning: alive pid true, missing/bogus pid false", () => {
  const p = tmp();
  expect(isPreviewRunning(p)).toBe(false); // no pid file
  fs.writeFileSync(path.join(p, ".orches-preview.pid"), String(process.pid));
  expect(isPreviewRunning(p)).toBe(true); // this test process is alive
  fs.writeFileSync(path.join(p, ".orches-preview.pid"), "2147480000"); // almost surely dead
  expect(isPreviewRunning(p)).toBe(false);
});

test("waitForPreviewUrl: returns URL already present in the log", async () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, ".orches-preview.log"), "ready - http://localhost:4321");
  expect(await waitForPreviewUrl(p, 2000)).toBe("http://localhost:4321");
});

test("waitForPreviewUrl: falls back to :3000 on timeout", async () => {
  const p = tmp();
  expect(await waitForPreviewUrl(p, 300)).toBe("http://localhost:3000");
});
