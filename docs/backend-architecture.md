# Backend Architecture (Succinct)

## Scope
Backend runs traceroute jobs, streams raw output to UI, and builds a merged route tree.

## Core Flow
1. `POST /api/runs` accepts targets and creates a run.
2. `RunManager` executes targets with bounded concurrency.
3. Each target launches multiple traceroute processes (fanout) for speed/resilience.
4. Output lines are streamed via SSE (`/api/runs/:runId/stream`).
5. On completion, backend merges hops and builds:
- `treeText` (printable tree)
- `treeData` (structured enriched-ready tree)
6. `GET /api/runs/:runId` returns final snapshot.

## Main Components
- `apps/backend/src/server.ts`
- HTTP API, CORS, run endpoints.
- `apps/backend/src/run-manager.ts`
- Run lifecycle, concurrency, SSE, traceroute aggregation, tree building.
- `apps/backend/src/traceroute.ts`
- OS traceroute command wrapper + stdout/stderr line streaming.
- `apps/backend/src/validation.ts`
- Request validation + fixed traceroute config.

## Data Model
- `tracePaths: Map<target, HopPoint[]>`
- Stores parsed hop candidates per target.
- `treeData: TreeNodeData`
- Canonical merged tree by hop identity (`ttl + ip`).
- Carries metadata: latency stats, skipped-hop stats, raw lines, source targets.

## Runtime Behavior
- ICMP-only fixed mode (currently).
- Per-target process fanout for faster discovery.
- Hard timeout budget to avoid stuck runs.
- Explicit cancel path: `POST /api/runs/:runId/cancel`.

## Notes
- Browser cannot perform true traceroute; backend process is required.
- UI currently consumes stream text + final tree.
