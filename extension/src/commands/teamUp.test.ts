import { expect, test } from "bun:test";

import { buildTeamUpCommand, parseCharterSession, resolveInstanceSession } from "./teamUpModel";

test("parseCharterSession: reads the session field from a charter yaml", () => {
  const yaml = [
    "name: brew",
    "description: some team",
    "session: brew",
    "members:",
    "  - role: bob",
  ].join("\n");
  expect(parseCharterSession(yaml)).toBe("brew");
});

test("parseCharterSession: tolerates extra whitespace + trailing comment", () => {
  expect(parseCharterSession("session:   carbon   ")).toBe("carbon");
  expect(parseCharterSession("session: oracle-council # pinned")).toBe("oracle-council");
});

test("parseCharterSession: null when no session field", () => {
  expect(parseCharterSession("name: brew\nmembers:\n  - role: bob")).toBeNull();
  expect(parseCharterSession("")).toBeNull();
});

test("resolveInstanceSession: base free → use base, not minted", () => {
  const r = resolveInstanceSession("brew", () => false);
  expect(r).toEqual({ session: "brew", minted: false });
});

test("resolveInstanceSession: base busy → mint the first free -N instance", () => {
  // brew + brew-2 taken, brew-3 free
  const taken = new Set(["brew", "brew-2"]);
  const r = resolveInstanceSession("brew", (s) => taken.has(s));
  expect(r).toEqual({ session: "brew-3", minted: true });
});

test("resolveInstanceSession: mirrors /orches — walks base-2..base-9", () => {
  const taken = new Set(["brew", "brew-2", "brew-3", "brew-4"]);
  const r = resolveInstanceSession("brew", (s) => taken.has(s));
  expect(r).toEqual({ session: "brew-5", minted: true });
});

test("buildTeamUpCommand: bootstrap, sequential per-member wake, rename short, attach", () => {
  expect(buildTeamUpCommand("brew", "brew-2", "/home/u/soulbrew", ["bob", "jack"])).toBe(
    "tmux new-session -A -d -s 'brew-2' -n _boot -c '/home/u/soulbrew' && { " +
      "maw team up 'brew' --session 'brew-2' --force --only 'bob' ; " +
      "maw team up 'brew' --session 'brew-2' --force --only 'jack' ; " +
      "for w in $(tmux list-windows -t '=brew-2' -F '#{window_name}'); do " +
      'tmux rename-window -t "=brew-2:$w" "${w#*-}" 2>/dev/null ; done ; ' +
      "tmux kill-window -t '=brew-2:_boot' 2>/dev/null ; " +
      "tmux attach -t '=brew-2' ; }",
  );
});

test("buildTeamUpCommand: empty roster → single plain up (charter decides)", () => {
  expect(buildTeamUpCommand("brew", "brew", "/home/u/soulbrew", [])).toBe(
    "tmux new-session -A -d -s 'brew' -n _boot -c '/home/u/soulbrew' && { " +
      "maw team up 'brew' --session 'brew' --force ; " +
      "for w in $(tmux list-windows -t '=brew' -F '#{window_name}'); do " +
      'tmux rename-window -t "=brew:$w" "${w#*-}" 2>/dev/null ; done ; ' +
      "tmux kill-window -t '=brew:_boot' 2>/dev/null ; " +
      "tmux attach -t '=brew' ; }",
  );
});
