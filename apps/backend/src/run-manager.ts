import type { FastifyReply } from "fastify";
import type { RunEvent, RunSnapshot, TargetRunSummary, TreeNodeData, TreeNodeKind } from "@ipsonar/shared";
import geoip from "geoip-lite";
import { startTraceroute } from "./traceroute.js";
import { FIXED_TRACE_CONFIG, type NormalizedRunOptions } from "./validation.js";

type HopPoint = {
  ttl: number;
  label: string;
  raw: string;
  unanswered: boolean;
  latencyMs?: number;
};

type MutableRun = {
  snapshot: RunSnapshot;
  options: NormalizedRunOptions;
  listeners: Set<FastifyReply>;
  events: RunEvent[];
  sequence: number;
  cancelled: boolean;
  childCancels: Set<() => void>;
  tracePaths: Map<string, HopPoint[]>;
};

type TreeNode = {
  key: string;
  label: string;
  kind: TreeNodeKind;
  hits: number;
  ttl?: number;
  ip?: string;
  countryCode?: string;
  countryName?: string;
  isPrivateIp?: boolean;
  target?: string;
  latencyValues: number[];
  skippedValues: number[];
  sourceTargets: Set<string>;
  rawLines: Set<string>;
  children: Map<string, TreeNode>;
};

const MAX_TARGET_RUNTIME_MS = 20_000;
const TRACEROUTE_FANOUT = 8;
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

function isPrivateIp(ip?: string): boolean {
  if (!ip) {
    return false;
  }
  if (ip.includes(":")) {
    return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:");
  }

  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 127) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

function lookupCountry(ip?: string): { countryCode?: string; countryName?: string; isPrivateIp?: boolean } {
  if (!ip) {
    return {};
  }
  if (isPrivateIp(ip)) {
    return { isPrivateIp: true };
  }

  const lookup = geoip.lookup(ip);
  const countryCode = lookup?.country?.toUpperCase();
  const countryName = countryCode ? countryNames.of(countryCode) : undefined;
  return { countryCode, countryName, isPrivateIp: false };
}

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseHopLine(line: string): HopPoint | null {
  const m = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!m) {
    return null;
  }

  const ttl = Number(m[1]);
  if (!Number.isFinite(ttl)) {
    return null;
  }

  const tail = m[2].trim();
  if (!tail) {
    return null;
  }

  if (tail.startsWith("*")) {
    return { ttl, label: "*", raw: line, unanswered: true };
  }

  const ipInParens = tail.match(/\(([0-9a-fA-F:.]+)\)/);
  const firstToken = tail.split(/\s+/)[0];
  const label = ipInParens?.[1] ?? firstToken;
  const latencyMatch = tail.match(/([0-9]+(?:\.[0-9]+)?)\s*ms/);
  const latencyMs = latencyMatch ? Number(latencyMatch[1]) : undefined;

  return {
    ttl,
    label,
    raw: line,
    unanswered: false,
    latencyMs
  };
}

function newTreeNode(args: {
  key: string;
  label: string;
  kind: TreeNodeKind;
  ttl?: number;
  ip?: string;
  countryCode?: string;
  countryName?: string;
  isPrivateIp?: boolean;
  target?: string;
}): TreeNode {
  return {
    key: args.key,
    label: args.label,
    kind: args.kind,
    hits: 0,
    ttl: args.ttl,
    ip: args.ip,
    countryCode: args.countryCode,
    countryName: args.countryName,
    isPrivateIp: args.isPrivateIp,
    target: args.target,
    latencyValues: [],
    skippedValues: [],
    sourceTargets: new Set(),
    rawLines: new Set(),
    children: new Map()
  };
}

function buildTree(paths: Map<string, HopPoint[]>): TreeNode {
  const root = newTreeNode({ key: "source", label: "source", kind: "source" });

  for (const [target, hops] of paths.entries()) {
    const ordered = [...hops].sort((a, b) => a.ttl - b.ttl);
    const pathSteps: Array<{
      key: string;
      label: string;
      kind: TreeNodeKind;
      ttl?: number;
      ip?: string;
      target?: string;
      latencyMs?: number;
      skippedFromPrev?: number;
      raw?: string;
    }> = [];

    let previousLabel: string | null = null;
    let previousAnsweredTtl = 0;

    for (const hop of ordered) {
      if (hop.unanswered) {
        continue;
      }
      if (previousLabel !== null && hop.label === previousLabel) {
        continue;
      }
      previousLabel = hop.label;

      const skippedFromPrev = Math.max(0, hop.ttl - previousAnsweredTtl - 1);
      previousAnsweredTtl = hop.ttl;

      pathSteps.push({
        key: `hop:${hop.ttl}:${hop.label}`,
        label: `${hop.ttl}. ${hop.label}`,
        kind: "hop",
        ttl: hop.ttl,
        ip: hop.label,
        latencyMs: hop.latencyMs,
        skippedFromPrev,
        raw: hop.raw
      });
    }

    pathSteps.push({
      key: `target:${target}`,
      label: `target: ${target}`,
      kind: "target",
      target
    });

    let node = root;
    for (const step of pathSteps) {
      let child = node.children.get(step.key);
      if (!child) {
        const geo = step.ip ? lookupCountry(step.ip) : {};
        child = newTreeNode({
          key: step.key,
          label: step.label,
          kind: step.kind,
          ttl: step.ttl,
          ip: step.ip,
          countryCode: geo.countryCode,
          countryName: geo.countryName,
          isPrivateIp: geo.isPrivateIp,
          target: step.target
        });
        node.children.set(step.key, child);
      }

      child.hits += 1;
      child.sourceTargets.add(target);

      if (step.latencyMs !== undefined) {
        child.latencyValues.push(step.latencyMs);
      }
      if (step.skippedFromPrev !== undefined) {
        child.skippedValues.push(step.skippedFromPrev);
      }
      if (step.raw) {
        child.rawLines.add(step.raw);
      }

      node = child;
    }
  }

  return root;
}

function mergeHopPoints(hops: HopPoint[]): HopPoint[] {
  const byTtl = new Map<number, HopPoint>();

  for (const hop of hops) {
    const current = byTtl.get(hop.ttl);
    if (!current) {
      byTtl.set(hop.ttl, hop);
      continue;
    }

    if (current.unanswered && !hop.unanswered) {
      byTtl.set(hop.ttl, hop);
      continue;
    }

    if (!current.unanswered && !hop.unanswered) {
      const currentLatency = current.latencyMs ?? Number.POSITIVE_INFINITY;
      const nextLatency = hop.latencyMs ?? Number.POSITIVE_INFINITY;
      if (nextLatency < currentLatency) {
        byTtl.set(hop.ttl, hop);
      }
    }
  }

  return [...byTtl.values()].sort((a, b) => a.ttl - b.ttl);
}

function renderTreeChildren(node: TreeNode, prefix: string, lines: string[]): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (b.hits !== a.hits) {
      return b.hits - a.hits;
    }
    return a.label.localeCompare(b.label);
  });

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    const isLast = i === children.length - 1;
    lines.push(`${prefix}${isLast ? "└─" : "├─"} ${child.label}`);
    renderTreeChildren(child, `${prefix}${isLast ? "   " : "│  "}`, lines);
  }
}

function buildTreeText(root: TreeNode): string {
  const lines: string[] = ["Route Tree", "source"];
  renderTreeChildren(root, "", lines);
  return lines.join("\n");
}

function summarizeNumberSeries(values: number[]): { min: number; max: number; avg: number } {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0 };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

function toTreeNodeData(node: TreeNode): TreeNodeData {
  const latencySummary = summarizeNumberSeries(node.latencyValues);
  const skippedSummary = summarizeNumberSeries(node.skippedValues);

  return {
    key: node.key,
    label: node.label,
    kind: node.kind,
    hits: node.hits,
    ttl: node.ttl,
    ip: node.ip,
    countryCode: node.countryCode,
    countryName: node.countryName,
    isPrivateIp: node.isPrivateIp,
    target: node.target,
    sourceTargets: [...node.sourceTargets].sort(),
    skippedFromPrev: skippedSummary,
    latencyMs:
      node.latencyValues.length > 0
        ? {
            min: latencySummary.min,
            max: latencySummary.max,
            avg: latencySummary.avg,
            samples: node.latencyValues.length
          }
        : undefined,
    rawLines: [...node.rawLines].slice(0, 10),
    children: [...node.children.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(toTreeNodeData)
  };
}

export class RunManager {
  private readonly runs = new Map<string, MutableRun>();
  private activeRunId?: string;

  createRun(options: NormalizedRunOptions): RunSnapshot {
    if (this.activeRunId) {
      throw new Error("another run is already active; cancel or wait for completion");
    }

    const id = runId();
    const targets: TargetRunSummary[] = options.targets.map((target) => ({ target, status: "queued" }));

    const snapshot: RunSnapshot = {
      runId: id,
      status: "queued",
      createdAt: nowIso(),
      config: { ...FIXED_TRACE_CONFIG },
      targets
    };

    this.runs.set(id, {
      snapshot,
      options,
      listeners: new Set(),
      events: [],
      sequence: 0,
      cancelled: false,
      childCancels: new Set(),
      tracePaths: new Map()
    });

    this.activeRunId = id;
    void this.executeRun(id);
    return snapshot;
  }

  getRun(runId: string): RunSnapshot | undefined {
    return this.runs.get(runId)?.snapshot;
  }

  attachSse(reply: FastifyReply, runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type"
    });

    run.listeners.add(reply);

    for (const event of run.events) {
      this.sendSseEvent(reply, event);
    }

    reply.raw.on("close", () => {
      run.listeners.delete(reply);
    });

    return true;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.cancelled) {
      return false;
    }

    run.cancelled = true;
    for (const cancelFn of run.childCancels) {
      cancelFn();
    }
    return true;
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    run.snapshot.status = "running";
    run.snapshot.startedAt = nowIso();
    this.emit(run, { type: "run.started", payload: { targets: run.options.targets.length } });

    try {
      await this.withConcurrency(run.options.targets, FIXED_TRACE_CONFIG.parallelTargets, async (target) => {
        if (run.cancelled) {
          return;
        }
        await this.executeTarget(run, target);
      });

      if (run.cancelled) {
        run.snapshot.status = "cancelled";
        for (const target of run.snapshot.targets) {
          if (target.status === "queued" || target.status === "running") {
            target.status = "cancelled";
            target.completedAt = nowIso();
          }
        }
        run.snapshot.completedAt = nowIso();
        this.emit(run, { type: "run.cancelled" });
      } else if (run.snapshot.targets.some((target) => target.status === "failed")) {
        run.snapshot.status = "failed";
        run.snapshot.completedAt = nowIso();
      } else {
        run.snapshot.status = "completed";
        run.snapshot.completedAt = nowIso();
      }

      const treeRoot = buildTree(run.tracePaths);
      run.snapshot.treeText = buildTreeText(treeRoot);
      run.snapshot.treeData = toTreeNodeData(treeRoot);
      // Backend-side printable tree for debugging and quick inspection.
      console.log(`\n[${run.snapshot.runId}]\n${run.snapshot.treeText}\n`);

      this.emit(run, {
        type: "run.completed",
        payload: { status: run.snapshot.status, treeText: run.snapshot.treeText, treeData: run.snapshot.treeData }
      });
    } finally {
      this.activeRunId = undefined;
      for (const listener of run.listeners) {
        listener.raw.end();
      }
      run.listeners.clear();
    }
  }

  private async executeTarget(run: MutableRun, targetName: string): Promise<void> {
    const target = run.snapshot.targets.find((t) => t.target === targetName);
    if (!target) {
      return;
    }

    target.status = "running";
    target.startedAt = nowIso();
    this.emit(run, { type: "target.started", target: targetName });

    const rawHops: HopPoint[] = [];
    run.tracePaths.set(targetName, rawHops);

    let hitHardTimeout = false;
    const traces = Array.from({ length: TRACEROUTE_FANOUT }, (_, idx) =>
      startTraceroute(
        {
          target: targetName,
          maxHops: FIXED_TRACE_CONFIG.maxHops,
          timeoutSecPerProbe: FIXED_TRACE_CONFIG.timeoutSecPerProbe,
          queriesPerHop: FIXED_TRACE_CONFIG.queriesPerHop
        },
        (line) => {
          const hop = parseHopLine(line);
          if (hop) {
            rawHops.push(hop);
          }

          this.emit(run, {
            type: "target.output",
            target: targetName,
            payload: { stream: "stdout", line: `[t${idx + 1}] ${line}` }
          });
        },
        (line) => {
          this.emit(run, {
            type: "target.output",
            target: targetName,
            payload: { stream: "stderr", line: `[t${idx + 1}] ${line}` }
          });
        }
      )
    );

    for (const trace of traces) {
      run.childCancels.add(trace.cancel);
    }

    const targetTimeout = setTimeout(() => {
      hitHardTimeout = true;
      for (const trace of traces) {
        trace.cancel();
      }
      this.emit(run, {
        type: "target.output",
        target: targetName,
        payload: {
          stream: "stderr",
          line: `[timeout] traceroute process exceeded hard ${Math.floor(MAX_TARGET_RUNTIME_MS / 1000)}s budget`
        }
      });
    }, MAX_TARGET_RUNTIME_MS);

    const completions = await Promise.all(traces.map((trace) => trace.completion));
    clearTimeout(targetTimeout);
    for (const trace of traces) {
      run.childCancels.delete(trace.cancel);
    }

    const mergedHops = mergeHopPoints(rawHops);
    run.tracePaths.set(targetName, mergedHops);

    if (run.cancelled) {
      target.status = "cancelled";
      target.completedAt = nowIso();
      return;
    }

    target.completedAt = nowIso();
    if (completions.some((result) => result.exitCode === 0) || hitHardTimeout) {
      target.status = "completed";
      this.emit(run, { type: "target.completed", target: targetName });
      return;
    }

    const failed = completions[0];
    target.status = "failed";
    target.error = `traceroute exited with code=${failed.exitCode} signal=${failed.signal}`;
    this.emit(run, {
      type: "target.failed",
      target: targetName,
      payload: { error: target.error }
    });
  }

  private emit(run: MutableRun, partial: Omit<RunEvent, "runId" | "sequence" | "timestamp">): void {
    run.sequence += 1;
    const event: RunEvent = {
      runId: run.snapshot.runId,
      sequence: run.sequence,
      timestamp: nowIso(),
      ...partial
    };

    run.events.push(event);
    for (const listener of run.listeners) {
      this.sendSseEvent(listener, event);
    }
  }

  private sendSseEvent(reply: FastifyReply, event: RunEvent): void {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private async withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let idx = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const current = idx;
        idx += 1;
        await fn(items[current]);
      }
    });

    await Promise.all(workers);
  }
}
