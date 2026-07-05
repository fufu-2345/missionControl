import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  accountExists,
  captureCurrent,
  deleteAccount,
  isSafeLabel,
  listAccounts,
  switchTo,
} from "./accountsOps";

// Redirect BOTH the claude config dir (CLAUDE_CONFIG_DIR — holds the vault + the
// claude credentials file) and the codex home (CODEX_HOME — the openai provider
// file) at throwaway temp dirs so nothing touches the real ~/.claude / ~/.codex.
let tmp: string;
const AT = "2026-07-05T00:00:00.000Z";

function claudeCred(oauth: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmp, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
}
function claudeCredPath(): string {
  return path.join(tmp, ".credentials.json");
}
function codexAuth(obj: Record<string, unknown>): void {
  const dir = path.join(tmp, "codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(obj));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accts-"));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  process.env.CODEX_HOME = path.join(tmp, "codex");
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isSafeLabel", () => {
  test("accepts simple names, rejects junk", () => {
    expect(isSafeLabel("main")).toBe(true);
    expect(isSafeLabel("work-2")).toBe(true);
    expect(isSafeLabel("")).toBe(false);
    expect(isSafeLabel("_index")).toBe(false);
    expect(isSafeLabel("has space")).toBe(false);
    expect(isSafeLabel("../escape")).toBe(false);
    expect(isSafeLabel("a".repeat(61))).toBe(false);
  });
});

describe("providers view", () => {
  test("lists both providers; claude present, openai absent when not logged in", () => {
    claudeCred({ accessToken: "tok-A", subscriptionType: "max", rateLimitTier: "tier-x" });
    const v = listAccounts();
    expect(v.providers.map((p) => p.provider)).toEqual(["claude", "openai"]);
    const claude = v.providers.find((p) => p.provider === "claude")!;
    const openai = v.providers.find((p) => p.provider === "openai")!;
    expect(claude.live.present).toBe(true);
    expect(claude.live.primary).toBe("max");
    expect(openai.live.present).toBe(false);
    expect(openai.loginHint).toContain("codex");
  });
});

describe("capture (claude)", () => {
  test("requires a live session", () => {
    claudeCred({}); // no accessToken
    expect(captureCurrent("claude", "main", AT).ok).toBe(false);
  });

  test("saves live creds + marks active, leaking no token", () => {
    claudeCred({ accessToken: "tok-A", subscriptionType: "max", rateLimitTier: "tier-x" });
    expect(captureCurrent("claude", "main", AT).ok).toBe(true);
    expect(accountExists("claude", "main")).toBe(true);

    const claude = listAccounts().providers.find((p) => p.provider === "claude")!;
    expect(claude.active).toBe("main");
    expect(claude.accounts).toHaveLength(1);
    expect(claude.accounts[0]).toMatchObject({ label: "main", primary: "max", secondary: "tier-x", capturedAt: AT });
    expect(JSON.stringify(listAccounts())).not.toContain("tok-A");
  });
});

describe("capture (openai / codex, generic shape)", () => {
  test("captures any non-empty auth.json + swaps it back on switch", () => {
    codexAuth({ tokens: { access_token: "cdx-A" } });
    expect(captureCurrent("openai", "acctA", AT).ok).toBe(true);
    codexAuth({ tokens: { access_token: "cdx-B" } });
    expect(captureCurrent("openai", "acctB", AT).ok).toBe(true);

    const before = listAccounts().providers.find((p) => p.provider === "openai")!;
    expect(before.active).toBe("acctB");
    expect(before.accounts.map((a) => a.label)).toEqual(["acctA", "acctB"]);

    expect(switchTo("openai", "acctA").ok).toBe(true);
    const live = JSON.parse(fs.readFileSync(path.join(tmp, "codex", "auth.json"), "utf8"));
    expect(live.tokens.access_token).toBe("cdx-A");
    // outgoing session preserved in the backup
    const bak = JSON.parse(fs.readFileSync(path.join(tmp, "codex", "auth.json.mc-bak"), "utf8"));
    expect(bak.tokens.access_token).toBe("cdx-B");
  });
});

describe("switch (claude)", () => {
  test("swaps the live credentials + backs up the outgoing file", () => {
    claudeCred({ accessToken: "tok-A", subscriptionType: "max" });
    captureCurrent("claude", "acctA", AT);
    claudeCred({ accessToken: "tok-B", subscriptionType: "pro" });
    captureCurrent("claude", "acctB", AT);

    expect(switchTo("claude", "acctA").ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(claudeCredPath(), "utf8")).claudeAiOauth.accessToken).toBe("tok-A");
    expect(listAccounts().providers.find((p) => p.provider === "claude")!.active).toBe("acctA");
  });

  test("refuses a missing account, leaving the live file intact", () => {
    claudeCred({ accessToken: "tok-A" });
    expect(switchTo("claude", "ghost").ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(claudeCredPath(), "utf8")).claudeAiOauth.accessToken).toBe("tok-A");
  });
});

describe("delete", () => {
  test("removes account + clears active; isolated per provider", () => {
    claudeCred({ accessToken: "tok-A" });
    captureCurrent("claude", "main", AT);
    expect(deleteAccount("claude", "main").ok).toBe(true);
    expect(accountExists("claude", "main")).toBe(false);
    expect(listAccounts().providers.find((p) => p.provider === "claude")!.active).toBeNull();
  });

  test("is idempotent for an unknown label", () => {
    expect(deleteAccount("openai", "nope").ok).toBe(true);
  });
});
