import { useEffect, useMemo, useRef, useState } from "react";
import type { CreateRunRequest, RunEvent, RunSnapshot, TreeNodeData } from "@ipsonar/shared";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const API_BASE = "http://127.0.0.1:3099";
const X_STEP = 250;
const Y_STEP = 116;

type GraphNodePayload = {
  title: string;
  subtitle?: string;
  kind: TreeNodeData["kind"];
  totalLatencyLabel?: string;
  locationLabel?: string;
  flag?: string;
};

function flagFromCountryCode(code?: string): string | undefined {
  if (!code || code.length !== 2) {
    return undefined;
  }
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    return undefined;
  }
  const base = 127397;
  return String.fromCodePoint(...upper.split("").map((c) => base + c.charCodeAt(0)));
}

function compactNodeTitle(node: TreeNodeData): string {
  if (node.kind === "hop" && node.ip) {
    return node.ip;
  }
  if (node.kind === "target" && node.target) {
    return `target: ${node.target}`;
  }
  return node.label;
}

function formatTotalLatency(node: TreeNodeData, parent?: TreeNodeData): string | undefined {
  if (node.kind !== "target") {
    return undefined;
  }
  const avg = node.totalLatencyMs?.avg ?? node.latencyMs?.avg ?? parent?.latencyMs?.avg;
  if (typeof avg !== "number") {
    return undefined;
  }
  return `${avg.toFixed(1)}ms total`;
}

function formatEdgeLabel(node: TreeNodeData, parent?: TreeNodeData): string | undefined {
  const jump = node.stepLatencyMs ? `+${node.stepLatencyMs.avg.toFixed(1)}ms` : undefined;
  const skipped = node.skippedFromPrev.avg > 0 ? `skip ${Math.round(node.skippedFromPrev.avg)}` : undefined;

  if (jump && skipped) {
    return `${jump} · ${skipped}`;
  }
  return jump ?? skipped;
}

function buildGraph(treeData?: TreeNodeData): { nodes: Node<GraphNodePayload>[]; edges: Edge[] } {
  if (!treeData) {
    return { nodes: [], edges: [] };
  }

  const nodes: Node<GraphNodePayload>[] = [];
  const edges: Edge[] = [];
  const yPositions = new Map<string, number>();
  let leafRow = 0;

  const toNodeId = (path: string[]): string => path.join("__");

  const measure = (node: TreeNodeData, path: string[]): number => {
    const nodeId = toNodeId(path);
    if (node.children.length === 0) {
      const y = leafRow * Y_STEP;
      yPositions.set(nodeId, y);
      leafRow += 1;
      return y;
    }

    const childYs: number[] = [];
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      childYs.push(measure(child, [...path, `${child.key}:${i}`]));
    }

    const y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
    yPositions.set(nodeId, y);
    return y;
  };

  const walk = (node: TreeNodeData, depth: number, path: string[], parent?: TreeNodeData, parentId?: string): string => {
    const id = toNodeId(path);
    const y = yPositions.get(id) ?? 0;

    const flag = flagFromCountryCode(node.countryCode);
    const locationLabel = node.countryName ?? (node.isPrivateIp ? "Private network" : undefined);
    const subtitle = node.kind === "target" ? "Target" : node.kind === "source" ? "Origin" : undefined;

    nodes.push({
      id,
      type: "routeNode",
      position: { x: depth * X_STEP, y },
      data: {
        title: compactNodeTitle(node),
        subtitle,
        kind: node.kind,
        totalLatencyLabel: formatTotalLatency(node, parent),
        locationLabel,
        flag
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      selectable: true
    });

    if (parentId) {
      edges.push({
        id: `${parentId}->${id}`,
        source: parentId,
        target: id,
        label: formatEdgeLabel(node, parent),
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
        type: "default",
        style: { stroke: "#000", strokeWidth: 2.2 },
        labelStyle: { fill: "#000", fontWeight: 700 },
        labelBgStyle: { fill: "#fff9df", fillOpacity: 1 },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 0
      });
    }

    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      walk(child, depth + 1, [...path, `${child.key}:${i}`], node, id);
    }

    return id;
  };

  const rootPath = ["source:0"];
  measure(treeData, rootPath);
  walk(treeData, 0, rootPath);
  return { nodes, edges };
}

function RouteNode({ data }: NodeProps<Node<GraphNodePayload>>) {
  return (
    <article className={`route-node route-node-${data.kind}`}>
      <Handle type="target" position={Position.Left} className="route-node-handle" />
      <Handle type="source" position={Position.Right} className="route-node-handle" />
      <header>
        <strong>{data.title}</strong>
      </header>
      {data.subtitle ? <p className="route-node-subtle">{data.subtitle}</p> : null}
      {data.totalLatencyLabel ? <p className="route-node-chip">{data.totalLatencyLabel}</p> : null}
      {data.locationLabel ? (
        <p className="route-node-subtle">
          {data.flag ? `${data.flag} ` : ""}
          {data.locationLabel}
        </p>
      ) : null}
    </article>
  );
}

export function App(): React.JSX.Element {
    const [targetsInput, setTargetsInput] = useState("stc.com.sa    # Saudi Arabia\ngoogle.com    # United States\nbbc.co.uk     # United Kingdom\novh.com       # France\nhawzen.me     # United States\ngov.za        # South Africa\nbaidu.com     # China");
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [runStatus, setRunStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputLines, setOutputLines] = useState<string[]>([]);

  const sseRef = useRef<EventSource | null>(null);
  const graphHostRef = useRef<HTMLDivElement | null>(null);
  const intentionalCloseRef = useRef(false);
  const outputText = useMemo(() => outputLines.join("\n"), [outputLines]);
  const graph = useMemo(() => buildGraph(run?.treeData), [run?.treeData]);

  useEffect(() => {
    const host = graphHostRef.current;
    if (!host) {
      return;
    }
    const attribution = host.querySelector(".react-flow__attribution");
    if (attribution instanceof HTMLElement) {
      attribution.hidden = true;
    }
  }, [graph.nodes.length, graph.edges.length]);

  async function startRun(): Promise<void> {
    setError(null);
    setOutputLines([]);
    closeSse();
    intentionalCloseRef.current = false;

    const targets = targetsInput
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);

    if (!targets.length) {
      setError("Provide at least one target.");
      return;
    }

    const payload: CreateRunRequest = { targets };

    const res = await fetch(`${API_BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = (await res.json()) as RunSnapshot | { error: string };
    if (!res.ok) {
      setError("error" in json ? json.error : "Could not start run");
      setRunStatus("failed");
      return;
    }

    setRun(json as RunSnapshot);
    setRunStatus("running");

    const runId = (json as RunSnapshot).runId;
    const sse = new EventSource(`${API_BASE}/api/runs/${runId}/stream`);
    sseRef.current = sse;

    const eventTypes: RunEvent["type"][] = [
      "run.started",
      "target.started",
      "target.output",
      "target.completed",
      "target.failed",
      "run.completed",
      "run.cancelled"
    ];

    const consume = (event: MessageEvent<string>) => {
      const parsed = JSON.parse(event.data) as RunEvent;
      consumeEvent(parsed);
    };

    for (const eventType of eventTypes) {
      sse.addEventListener(eventType, (event) => consume(event as MessageEvent<string>));
    }

    sse.onmessage = consume;

    sse.onerror = () => {
      if (intentionalCloseRef.current) {
        return;
      }
      void recoverRunFromSnapshot(runId);
    };
  }

  async function cancelRun(): Promise<void> {
    if (!run) {
      return;
    }

    await fetch(`${API_BASE}/api/runs/${run.runId}/cancel`, { method: "POST" });
  }

  function consumeEvent(event: RunEvent): void {
    if (event.type === "run.completed" || event.type === "run.cancelled") {
      setRunStatus(event.type === "run.cancelled" ? "cancelled" : "completed");
      const maybeTree = event.payload?.treeText;
      if (typeof maybeTree === "string") {
        const maybeTreeData = event.payload?.treeData as TreeNodeData | undefined;
        setRun((prev) => (prev ? { ...prev, treeText: maybeTree, treeData: maybeTreeData ?? prev.treeData } : prev));
      }
      appendLine(`[${event.type}] ${event.timestamp}`);
      closeSse();
      return;
    }

    if (event.type === "target.started" && event.target) {
      appendLine(`[${event.target}] started`);
      return;
    }

    if (event.type === "target.output" && event.target) {
      const line = (event.payload?.line as string | undefined) ?? "";
      appendLine(`[${event.target}] ${line}`);
      return;
    }

    if ((event.type === "target.completed" || event.type === "target.failed") && event.target) {
      appendLine(`[${event.target}] ${event.type}`);
    }
  }

  function appendLine(line: string): void {
    setOutputLines((prev) => [...prev, line]);
  }

  function closeSse(): void {
    if (sseRef.current) {
      intentionalCloseRef.current = true;
      sseRef.current.close();
      sseRef.current = null;
    }
  }

  async function recoverRunFromSnapshot(runId: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/api/runs/${runId}`);
      if (!res.ok) {
        throw new Error(`snapshot fetch failed (${res.status})`);
      }
      const snapshot = (await res.json()) as RunSnapshot;
      setRun(snapshot);
      setRunStatus(snapshot.status);

      if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") {
        appendLine(`[run.recovered] ${snapshot.status}`);
        closeSse();
        return;
      }
    } catch {
      setError("Stream disconnected. Check backend logs and try again.");
      closeSse();
      return;
    }

    setError("Stream disconnected. Check backend logs and try again.");
    closeSse();
  }

  return (
    <div className="page">
      <h1>IP Sonar</h1>

      <div className="grid">
        <label>
          Targets (one per line)
          <textarea value={targetsInput} onChange={(e) => setTargetsInput(e.target.value)} rows={8} />
        </label>

        <div className="actions">
          <button onClick={() => void startRun()}>Start</button>
          <button onClick={() => void cancelRun()} disabled={!run || runStatus !== "running"}>
            Cancel
          </button>
          <span>Status: {runStatus}</span>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="console">
        {run?.treeText ? (
          <section className="tree-section">
            <h2>Route Tree</h2>
            {graph.nodes.length > 0 ? (
              <div className="tree-graph" ref={graphHostRef}>
                <ReactFlow
                  key={run?.runId ?? "no-run"}
                  nodes={graph.nodes}
                  edges={graph.edges}
                  fitView
                  fitViewOptions={{ padding: 0.15 }}
                  nodeTypes={{ routeNode: RouteNode }}
                >
                  <Controls showInteractive={false} />
                  <Background gap={22} size={1} color="#d5d5d5" />
                </ReactFlow>
              </div>
            ) : null}
            <pre className="tree-pre">{run.treeText}</pre>
          </section>
        ) : null}
        <section>
          <h2>Output</h2>
          <pre className="output-pre">{outputText || "No output yet."}</pre>
        </section>
      </div>

      <div className="corner-logo" aria-hidden="true">
        IP SONAR
      </div>
    </div>
  );
}
