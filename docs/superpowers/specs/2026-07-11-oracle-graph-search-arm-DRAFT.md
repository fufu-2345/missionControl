# Oracle Graph Search Arm — DESIGN DRAFT (for review, NOT approved, NOT built)

Date: 2026-07-11 · Status: **DRAFT proposal** — produced autonomously while user away; brainstorming approval + open decisions below still required before any implementation.
Target repo: **arra-oracle-v3** (oracle engine) · plus a tiny extension change.

> This is Track B. Track A (graphify on a code repo for token savings) is a SEPARATE, already-done thing. This arm does NOT use graphify — it uses the oracle's own native concept-graph (decision recorded in memory [[missioncontrol-search-vector-settings]]).

---

## 1. Goal
Add **`graph`** as a third retrieval arm in the oracle's search, over the **same corpus** that FTS5 (SQLite) and vector (LanceDB) already index, and fuse all three into hybrid:

`hybrid = FTS5 (BM25) + vector (cosine/ANN) + graph (concept-traversal)`, weighted.

This realizes the extension's **"Graph" submode** for real (today it is a no-op → FTS5).

## 2. Why native concept-graph (not graphify)
- The oracle **already builds a doc-graph over the same corpus**: `handleGraph()` (arra-oracle-v3 `src/server/handlers.ts:623`) links docs that share ≥1 `concepts` tag (`oracle_documents.concepts`), weight = number of shared concepts.
- In-process (TS/Bun) → plugs straight into `search.ts` fusion; no Python process, no `graph.json` round-trip, no staleness pipeline.
- Always fresh: reflects current `oracle_documents` (the watcher re-indexes live).
- graphify is code-AST-oriented (weak on the prose ψ corpus) and its "70x" is Claude-Code file-navigation, **not** query-time retrieval — irrelevant here.

## 3. How the current hybrid works (grounded, so the graph arm slots in cleanly)
In `src/tools/search.ts`:
- FTS rows → normalized: `score: normalizeFtsScore(row.rank)`, `source:'fts'` (search.ts:408-416)
- Vector rows → normalized: `score: 1 - distance`, `source:'vector'` (search.ts:418-422)
- `combineResults(ftsResults, normalizedVectorResults)` merges + dedups; a doc found by both is tagged `source:'hybrid'` (search.ts:424)
- Optional cross-encoder rerank over top 50 (`rerankCandidates`, ORACLE_RERANKER_URL) (search.ts:429-439)
- `metadata.sources = { fts, vector, hybrid }` counts (search.ts:472-497)
- Mode enum today: `['hybrid','fts','vector']`, default `hybrid` (search.ts:52); disabled-vector downgrades to fts (search.ts:343-348)

## 4. Proposed design
### 4.1 Graph retrieval (new module, e.g. `src/tools/graph-search.ts`, ≤250 lines)
- **Seed:** take the top FTS (and vector, if enabled) hits as seed doc ids.
- **Traverse:** over the concept-edge graph (docs sharing concepts). BFS to depth `D` (default 2). Reuse/extract the edge logic from `handleGraph` (shared-concept pairs, weight = #shared) into a shared helper so both the `/api/graph` viz and this retrieval use one definition (DRY).
- **Score:** `graphScore(doc) = Σ over paths ( edgeWeight / hopDecay^depth )`, normalized to [0,1] to be comparable with FTS/vector normalized scores. Cap fan-out per node to bound cost.
- **Output:** results shaped like the others (`{id,type,content,source_file,concepts,score, source:'graph'}`).

### 4.2 Fusion
- Extend `combineResults` to accept a 3rd list (graph) — a doc present in ≥2 arms → `source:'hybrid'`. Keep the existing weight/normalization approach; add a **graph weight** `Wg` (config, default e.g. 0.5 relative to FTS/vector) so graph doesn't dominate.
- Reranker pass stays as-is (runs on the fused head).
- `metadata.sources` gains `graph`; `metadata` gains `graphMatches`, `graphAvailable`.

### 4.3 Mode + enable
- Mode enum → `['hybrid','fts','vector','graph']`. `graph` = graph-only; `hybrid` includes the graph arm when available.
- **Enable/persist:** simplest = reuse `vector-server.json` with a new `graph: { enabled, depth, weight }` section (mirrors the vector section), read by an `isGraphSectionEnabled()` alongside `isVectorSectionEnabled()`. Extension "Graph" submode → drives this + issues `mode=graph`/`hybrid`.
- No embedding/LLM needed to build (concepts already exist) → **no CPU-storm risk** (unlike vector embed). Graph is derived on demand from `oracle_documents` (optionally cached in-memory with invalidation on doc change).

### 4.4 Extension change (tiny)
- Today the "Graph" submode is a no-op → FTS5. Change it to drive real `graph`/`hybrid-with-graph` (flip the mapping once the oracle supports it). Update the readiness/label copy ("coming soon" → live).

## 5. Token/speed expectation (set correctly)
- Query-time benefit = the graph arm can return **tight connected context** (a small relevant subgraph) instead of many loosely-matched docs → modest token savings + better "related" recall on relational questions.
- **NOT** graphify's 70x (that is code-navigation, a different mechanism). Do not promise 70x here.

## 6. Scope / constraints
- **arra-oracle-v3 rules apply:** files ≤250 lines, TDD, nested one-behavior-per-file tests, Bun ≥1.2, Elysia/TypeBox, **alpha-release per merge**, **PR flow — NEVER merge without explicit user permission**.
- Extension change is small and lives in the (already-merged) Search/Oracle settings.
- Out of scope: graphify integration; AI-generated edges (start with existing concept edges; AI-augment is a later option if edges too thin).

## 7. Testing approach (for the plan phase)
- Unit: graph traversal + scoring (seed→edges→normalized scores) on a fixture corpus; fusion with 3 arms; mode routing + `graph`-disabled downgrade.
- Integration (spawned server, like existing http tests): `GET /api/search?mode=graph` and `mode=hybrid` return graph-sourced results with `metadata.sources.graph > 0` on a seeded concept corpus.
- Verify against a throwaway oracle (temp ORACLE_DATA_DIR + test port) — the pattern already used to verify the vector feature.

## 8. OPEN DECISIONS (need your call before planning/build)
1. **Enable mechanism:** new `graph` section in `vector-server.json` (proposed) vs a separate config vs always-on-when-corpus-has-concepts?
2. **Weights & depth:** default graph weight `Wg` relative to FTS/vector, and BFS depth `D` (proposed Wg≈0.5, D=2) — tune later or set now?
3. **Seeds:** seed the graph from FTS-only, or FTS+vector? (FTS-only avoids requiring vector to be enabled.)
4. **Concept-tag quality:** the graph is only as good as `oracle_documents.concepts`. Do we accept current tag quality to start, with AI-augment as a later phase?
5. **Extension "Graph" submode:** flip it to live in the same change, or keep it a placeholder until the oracle arm ships?
6. **Sequencing:** this was deferred to **after** the vector F5 verify — confirm we still do vector F5 first.

## 9. Next step (when you approve)
Run brainstorming to close §8 with you, then `writing-plans` → TDD build on an arra-oracle-v3 branch → PR for your review (no auto-merge).
