import { isIP } from "node:net";
import type { CreateRunRequest } from "@ipsonar/shared";

const HOSTNAME_REGEX = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9.-]+(?<!-)$/;

export type NormalizedRunOptions = {
  targets: string[];
};

export const FIXED_TRACE_CONFIG = {
  protocol: "icmp" as const,
  parallelTargets: 10,
  maxHops: 30,
  queriesPerHop: 1,
  timeoutSecPerProbe: 1
};

function sanitizeTarget(value: string): string {
  return value.replace(/#.*/, "").trim();
}

export function validateAndNormalizeRequest(input: unknown): NormalizedRunOptions {
  const body = (input ?? {}) as CreateRunRequest;

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    throw new Error("targets must be a non-empty array");
  }

  const dedupedTargets = Array.from(new Set(body.targets.map((t) => sanitizeTarget(t)).filter(Boolean)));

  if (dedupedTargets.length === 0) {
    throw new Error("targets must contain at least one non-empty target");
  }

  for (const target of dedupedTargets) {
    const isHost = HOSTNAME_REGEX.test(target) && target.includes(".");
    const isLiteralIp = isIP(target) !== 0;

    if (!isHost && !isLiteralIp) {
      throw new Error(`invalid target: ${target}`);
    }
  }

  return {
    targets: dedupedTargets
  };
}
