import { describe, expect, test } from "bun:test";
import { pullArgs } from "./ollamaPull";

describe("pullArgs", () => {
  test("maps the bge-m3 UI key to the ollama model tag", () => {
    expect(pullArgs("bge-m3")).toEqual(["pull", "bge-m3"]);
  });
  test("maps nomic UI key to nomic-embed-text", () => {
    expect(pullArgs("nomic")).toEqual(["pull", "nomic-embed-text"]);
  });
});
