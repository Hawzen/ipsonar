import Fastify from "fastify";
import type { CreateRunRequest } from "@ipsonar/shared";
import { RunManager } from "./run-manager.js";
import { validateAndNormalizeRequest } from "./validation.js";

const app = Fastify({ logger: true });
const runs = new RunManager();

app.addHook("onRequest", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "content-type");

  if (request.method === "OPTIONS") {
    reply.code(204).send();
    return reply;
  }
});

app.options("/api/*", async (_request, reply) => {
  reply.code(204);
  return "";
});

app.get("/health", async () => ({ ok: true, service: "ipsonar-backend", platform: process.platform }));

app.post("/api/runs", async (request, reply) => {
  try {
    const normalized = validateAndNormalizeRequest(request.body as CreateRunRequest);
    const run = runs.createRun(normalized);
    reply.code(201);
    return run;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply.code(400);
    return { error: message };
  }
});

app.get("/api/runs/:runId", async (request, reply) => {
  const params = request.params as { runId: string };
  const run = runs.getRun(params.runId);
  if (!run) {
    reply.code(404);
    return { error: "run not found" };
  }
  return run;
});

app.get("/api/runs/:runId/stream", async (request, reply) => {
  const params = request.params as { runId: string };
  const attached = runs.attachSse(reply, params.runId);
  if (!attached) {
    reply.code(404).send({ error: "run not found" });
  }
});

app.post("/api/runs/:runId/cancel", async (request, reply) => {
  const params = request.params as { runId: string };
  const cancelled = runs.cancel(params.runId);
  if (!cancelled) {
    reply.code(404);
    return { error: "run not found or already cancelled" };
  }
  return { ok: true };
});

const port = Number(process.env.PORT || 3099);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`backend listening on :${port}`);
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
