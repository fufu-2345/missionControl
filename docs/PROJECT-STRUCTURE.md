# Repo & ghq Structure — Guide for Future AI Sessions

**Read this before creating repos, running `maw wake`/`maw bud`/`maw team up`, or restructuring anything under `~/Desktop/soulbrew`.**

## The layout

`~/Desktop/soulbrew/` is the **ghq root** — a PLAIN container directory, **NOT a git repo**.
Every real repo lives as a **ghq leaf** at `~/Desktop/soulbrew/github.com/<owner>/<repo>/`, each with its OWN `.git` + its own GitHub backup.

| What | Where |
|------|-------|
| **This tool** (Mission Control ext + skills + docs) | `github.com/fufu-2345/missionControl/` |
| **Oracles** (persistent agents with ψ memory) | `github.com/fufu-2345/{bob,jack,john,mike,orch-lead}-oracle/` |
| **Built projects** (software the tool builds) | `github.com/fufu-2345/projects/*` (ttt, rpn, morse, expense-tracker, ...) |
| **Ecosystem tools** | `github.com/Soul-Brews-Studio/{maw-js,maw-ui,arra-oracle-v3}/` |

## ⛔ THE GOLDEN RULE: never put a `.git` at the ghq root

`~/Desktop/soulbrew` must **NOT** be a git repo. ghq stops descending the instant it finds a `.git`; if the *root* has one, `ghq list` returns only the root and goes **blind to every nested leaf** → `maw wake` / `maw bud` / `maw team up` can't resolve any oracle (they all resolve through ghq).

**This actually happened (2026-06-22 → 2026-07-01):** the tool was `git init`'d AT the soulbrew top (for backup). That silently broke ghq/maw-wake for ~10 days. Fix = `rm -rf ~/Desktop/soulbrew/.git` so soulbrew is a plain dir again. Verified afterward: `ghq list` showed all 15 leaves and `maw wake orch-lead` resolved.

**To back up the tool:** back up the **leaf** (`github.com/fufu-2345/missionControl`) — it has its own `.git` and pushes to GitHub. **Never** `git init` the root to "back up everything at once."

## Creating a new repo/project the right way

Give the `.git` to a **leaf**, never the root:
- Oracle: `maw bud --from-repo <leaf-path> --stem <name>` (scaffolds ψ + fleet-registers) → then `maw oracle scan` to refresh `~/.maw/oracles.json`.
- Plain repo: `gh repo create fufu-2345/<name> --source=<leaf-path> --push` + normal `git`.

## maw charter `project:` references

Use the **leaf slug**, e.g. `project: fufu-2345/missionControl`. Do **NOT** use bare `soulbrew` — it is the ghq *root*, not a listed repo, so it won't resolve.

## Developing THIS tool (missionControl)

Edit + commit + push **inside** `github.com/fufu-2345/missionControl/`. Open THAT folder in VSCode (the extension loads from `<repo>/extension/`). All history lives on GitHub `origin/main`.

## Migration status (2026-07-01)

- **DONE:** removed soulbrew-top `.git`; ghq unblocked; this leaf forwarded to current `main`; `brew.yaml project:` → `fufu-2345/missionControl`.
- **PENDING (manual, coordinate with the human):** the old soulbrew *top* still holds DUPLICATE, now-untracked copies of the tool files (`extension/`, `claude-skills/`, `docs/`, `.maw/`, `req*.md`, ...). Once VSCode / the installed extension are re-pointed to this leaf path, delete those top-level duplicates so the tool has a single home here.
