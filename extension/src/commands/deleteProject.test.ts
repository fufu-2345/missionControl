import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canDeleteProjectPath, confirmNameMatches, removeProjectDir } from "./deleteProject";

function tmpProjects(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-del-"));
  fs.mkdirSync(path.join(base, "projects"), { recursive: true });
  return base;
}

test("canDeleteProjectPath: ยอมรับลูกตรงใต้ projects/ ที่เป็น dir จริง", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(true);
});

test("canDeleteProjectPath: ปฏิเสธ projects root เอง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path นอก projects/", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ที่ไม่มีจริง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects", "ghost")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธไฟล์ (ไม่ใช่ dir)", () => {
  const base = tmpProjects();
  const f = path.join(base, "projects", "afile");
  fs.writeFileSync(f, "x");
  expect(canDeleteProjectPath(f).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ว่าง", () => {
  expect(canDeleteProjectPath("").ok).toBe(false);
});

test("confirmNameMatches: ตรง=true, ผิด/ว่าง=false, trim ก่อนเทียบ", () => {
  expect(confirmNameMatches("foo", "foo")).toBe(true);
  expect(confirmNameMatches("  foo  ", "foo")).toBe(true);
  expect(confirmNameMatches("foo", "bar")).toBe(false);
  expect(confirmNameMatches("", "foo")).toBe(false);
});

test("removeProjectDir: ลบ dir จริงหาย", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(path.join(p, "agents", "r"), { recursive: true });
  fs.writeFileSync(path.join(p, "file.txt"), "x");
  const r = removeProjectDir(p);
  expect(r.deleted).toBe(true);
  expect(fs.existsSync(p)).toBe(false);
});

test("removeProjectDir: ปฏิเสธ path นอก projects/ (ไม่ลบ)", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  const r = removeProjectDir(p);
  expect(r.deleted).toBe(false);
  expect(fs.existsSync(p)).toBe(true);
});
