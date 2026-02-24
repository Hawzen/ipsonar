import { spawn } from "node:child_process";

export type TracerouteConfig = {
  target: string;
  maxHops: number;
  timeoutSecPerProbe: number;
  queriesPerHop: number;
};

export type RunningTrace = {
  childPid?: number;
  cancel: () => void;
  completion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
};

export function startTraceroute(
  config: TracerouteConfig,
  onStdoutLine: (line: string) => void,
  onStderrLine: (line: string) => void
): RunningTrace {
  const platform = process.platform;
  const { command, args } = buildCommand(platform, config);

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  attachLineReader(child.stdout, onStdoutLine);
  attachLineReader(child.stderr, onStderrLine);

  const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

  return {
    childPid: child.pid,
    cancel: () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1200).unref();
    },
    completion
  };
}

function buildCommand(platform: NodeJS.Platform, cfg: TracerouteConfig): {
  command: string;
  args: string[];
} {
  if (platform === "win32") {
    const args = ["-d", "-h", String(cfg.maxHops), "-w", String(cfg.timeoutSecPerProbe * 1000), cfg.target];
    return { command: "tracert", args };
  }

  const args: string[] = [];

  args.push("-I");

  args.push("-m", String(cfg.maxHops));
  args.push("-q", String(cfg.queriesPerHop));
  args.push("-w", String(cfg.timeoutSecPerProbe));
  args.push(cfg.target);

  return { command: "traceroute", args };
}

function attachLineReader(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void
): void {
  if (!stream) {
    return;
  }

  let buffer = "";
  stream.setEncoding("utf8");

  stream.on("data", (chunk: string) => {
    buffer += chunk;

    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      if (line.length) {
        onLine(line);
      }
    }
  });

  stream.on("end", () => {
    if (buffer.trim().length) {
      onLine(buffer.trimEnd());
      buffer = "";
    }
  });
}
