# AGENTS

## Project
IP Sonar is a TypeScript monorepo for traceroute-based path discovery.

- `apps/backend`: Fastify API, traceroute execution, SSE streaming, tree generation.
- `apps/frontend`: Text-first UI for live output and route tree display.
- `packages/shared`: Shared API/event/types contracts.

## Run
- Dev: `npm run dev`
- Build: `npm run build`

## Current Product Shape
- Backend performs real traceroute (user machine/server perspective).
- Frontend is minimal and text-focused.
- Route tree is generated server-side as `treeText` + `treeData`.

## Engineering Conventions
- Keep backend logic deterministic and fail-safe (timeouts, cancellation).
- Prefer canonical merge keys for tree nodes (`ttl + ip`).
- Preserve SSE event compatibility when changing payloads.
- Keep UI minimal; avoid adding heavy visualization logic in v1.

## Near-term Direction
- Add optional IP enrichment (country/ASN) to `treeData`.
- Keep textual UX stable while extending metadata.
