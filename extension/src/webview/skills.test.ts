import { describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// skills.ts imports vscode only for the panel/handlers (not for listSkills),
// so a bare stub lets us load the module and test the pure disk-reading path.
mock.module("vscode", () => ({}));

function writeSkill(root: string, name: string, frontmatter: string, uploaded = false): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n\nbody\n`);
  if (uploaded) fs.writeFileSync(path.join(dir, ".mc-uploaded"), "");
}

describe("listSkills grouping", () => {
  test("auto-created skills land in the 'generated' bucket, distinct from system/uploaded", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skills-"));
    process.env.MC_SKILLS_DIR = tmp;
    try {
      writeSkill(tmp, "gen-one",
        "name: gen-one\ndescription: a generated one\ninstaller: auto-skill\ncategory: testing");
      writeSkill(tmp, "sys-one",
        "name: sys-one\ndescription: '[core] v1 G-SKLL | a normal skill'");
      writeSkill(tmp, "up-one", "name: up-one\ndescription: an uploaded one", true);

      const { listSkills } = await import("./skills");
      const byName = Object.fromEntries(listSkills().map((s) => [s.name, s]));

      expect(byName["gen-one"].group).toBe("generated");
      expect(byName["gen-one"].category).toBe("testing"); // uses frontmatter category
      expect(byName["sys-one"].group).toBe("system");
      expect(byName["up-one"].group).toBe("uploaded");
    } finally {
      delete process.env.MC_SKILLS_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
