export type CreateRunRequest = {
  targets: string[];
};

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TargetStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TargetRunSummary = {
  target: string;
  status: TargetStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type TreeNodeKind = "source" | "hop" | "target";

export type TreeNodeData = {
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
  sourceTargets: string[];
  skippedFromPrev: {
    min: number;
    max: number;
    avg: number;
  };
  latencyMs?: {
    min: number;
    max: number;
    avg: number;
    samples: number;
  };
  rawLines: string[];
  children: TreeNodeData[];
};

export type RunSnapshot = {
  runId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  config: {
    protocol: "icmp";
    parallelTargets: number;
    maxHops: number;
    queriesPerHop: number;
    timeoutSecPerProbe: number;
  };
  targets: TargetRunSummary[];
  treeText?: string;
  treeData?: TreeNodeData;
};

export type SseEventType =
  | "run.started"
  | "target.started"
  | "target.output"
  | "target.completed"
  | "target.failed"
  | "run.completed"
  | "run.cancelled";

export type RunEvent = {
  runId: string;
  sequence: number;
  timestamp: string;
  type: SseEventType;
  target?: string;
  payload?: Record<string, unknown>;
};
