import { afterEach, describe, expect, test } from "bun:test";
import { __setFetch, getConfig, patchConfig, startIndex } from "./oracleVectorClient";

afterEach(() => __setFetch(undefined));

function jsonResponse(obj: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => obj } as unknown as Response;
}

describe("getConfig", () => {
  test("maps a 200 JSON body into { online:true, config }", async () => {
    __setFetch(async () => jsonResponse({ enabled: true }));
    const r = await getConfig();
    expect(r.online).toBe(true);
    expect(r.config.enabled).toBe(true);
  });

  test("connection failure → { online:false, config:null }", async () => {
    __setFetch(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const r = await getConfig();
    expect(r.online).toBe(false);
    expect(r.config).toBe(null);
  });
});

describe("patchConfig", () => {
  test("sends PATCH with JSON body and returns parsed payload", async () => {
    let seenMethod = "";
    let seenBody = "";
    __setFetch(async (_url: string, init: RequestInit) => {
      seenMethod = String(init.method);
      seenBody = String(init.body);
      return jsonResponse({ path: "/x", enabled: false });
    });
    const out = await patchConfig({ enabled: false });
    expect(seenMethod).toBe("PATCH");
    expect(JSON.parse(seenBody)).toEqual({ enabled: false });
    expect(out.path).toBe("/x");
  });

  test("non-2xx throws", async () => {
    __setFetch(async () => jsonResponse({ error: "bad" }, false, 400));
    await expect(patchConfig({ enabled: true })).rejects.toThrow();
  });
});

describe("startIndex", () => {
  test("posts model in the body", async () => {
    let seenBody = "";
    __setFetch(async (_url: string, init: RequestInit) => {
      seenBody = String(init.body);
      return jsonResponse({ jobId: "j1", status: "started" });
    });
    const out = await startIndex("nomic");
    expect(JSON.parse(seenBody).model).toBe("nomic");
    expect(out.status).toBe("started");
  });
});
