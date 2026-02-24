# IP Sonar v1

Backend traceroute tool with a text-only web UI.

## Quick Start

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3099`

## What this version does

- Runs real traceroute from the backend host machine
- Supports multiple targets with bounded parallel execution
- Streams live traceroute lines to the browser (SSE)
- Allows run cancellation
- Builds a backend route tree from discovered hops and stores it as `treeText` in run snapshot
- Text-only output (no graph yet)

## Monorepo Layout

- `apps/backend`: Fastify API + traceroute runner
- `apps/frontend`: React text console UI
- `packages/shared`: shared TypeScript contracts

## Backend API

- `GET /health`
- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/stream`
- `POST /api/runs/:runId/cancel`

### `POST /api/runs` payload

```json
{
  "targets": ["8.8.8.8", "1.1.1.1", "example.com"]
}
```

Fixed traceroute config (not client-configurable):
- Protocol: `ICMP`
- Parallel targets: `10`
- Max hops: `30`
- Queries per hop: `3`
- Timeout per probe: `10s`
- Hard cap per target run: `45s`

## Notes

- Browser/WASM cannot perform true traceroute directly; traceroute runs in backend process.
- On Windows, `tracert` is used and TCP mode is treated as ICMP-like fallback.
