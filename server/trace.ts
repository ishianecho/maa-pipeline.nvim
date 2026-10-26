export type TraceStatus = "running" | "succeeded" | "failed" | "missed" | "not-executed";

export interface TraceEntry {
  name: string;
  status: TraceStatus;
  executions: number;
  hits: number;
  attempts: number;
  lastRecoId: number | null;
  durationMs: number | null;
}

export interface TraceSnapshot {
  task: string | null;
  taskId: number | null;
  running: boolean;
  entries: TraceEntry[];
  notExecuted: string[];
}

export interface RecoDetailEntry {
  box: number[];
  score?: number;
  count?: number;
  text?: string;
  cls_index?: number;
  label?: string;
  detail?: unknown;
}

export interface RecoDetailInfo {
  name: string;
  algorithm: string;
  hit: boolean;
  box: number[] | null;
  detail:
    | { all: RecoDetailEntry[]; filtered: RecoDetailEntry[]; best: RecoDetailEntry | null }
    | RecoDetailInfo[]
    | null;
}

export interface RecoDetailResult {
  info: RecoDetailInfo;
  raw: string;
  draws: string[];
}

export interface TraceDeps {
  getKnownTasks: () => Promise<string[] | null>;
  onChange: (snapshot: TraceSnapshot) => void;
}

interface TraceNameState {
  executions: number;
  hits: number;
  attempts: number;
  lastStatus: "running" | "succeeded" | "failed" | null;
  runningSince: number | null;
  firstTs: number | null;
  lastTs: number | null;
  lastRecoId: number | null;
}

const CATEGORIES = new Set([
  "Task",
  "PipelineNode",
  "RecognitionNode",
  "ActionNode",
  "NextList",
  "Recognition",
  "Action",
]);
const PHASES = new Set(["Starting", "Succeeded", "Failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class TraceCollector {
  private deps: TraceDeps;
  private inst: string | null = null;
  private task: string | null = null;
  private taskId: number | null = null;
  private running = false;
  private names = new Map<string, TraceNameState>();
  private order: string[] = [];
  private knownTasks: string[] = [];

  constructor(deps: TraceDeps) {
    this.deps = deps;
  }

  currentInst(): string | null {
    return this.inst;
  }

  ingest(inst: string, msg: unknown): boolean {
    if (!isRecord(msg)) return false;
    const raw = text(msg.msg);
    if (!raw) return false;
    const dot = raw.indexOf(".");
    if (dot < 0) return false;
    const category = raw.slice(0, dot);
    const phase = raw.slice(dot + 1);
    if (!CATEGORIES.has(category) || !PHASES.has(phase)) return false;
    this.inst = inst;
    const now = Date.now();

    if (category === "Task") {
      const entry = text(msg.entry);
      if (entry) this.task = entry;
      const taskId = number(msg.task_id);
      if (taskId !== undefined) this.taskId = taskId;
      if (phase === "Starting") {
        this.names = new Map();
        this.order = [];
        this.running = true;
        void this.loadKnownTasks();
      } else {
        this.running = false;
      }
      this.changed();
      return true;
    }

    if (category === "PipelineNode") {
      const name = text(msg.name);
      if (name) {
        const state = this.stateFor(name, now);
        state.lastTs = now;
        if (phase === "Starting") {
          state.executions += 1;
          state.runningSince = now;
          state.lastStatus = "running";
        } else {
          state.runningSince = null;
          state.lastStatus = phase === "Succeeded" ? "succeeded" : "failed";
        }
        this.changed();
      }
      return true;
    }

    if (category === "RecognitionNode") {
      const name = text(msg.name);
      if (name && phase === "Succeeded") {
        const state = this.stateFor(name, now);
        state.hits += 1;
        state.lastTs = now;
        this.changed();
      }
      return true;
    }

    if (category === "NextList") {
      if (Array.isArray(msg.list)) {
        for (const item of msg.list) {
          const name = isRecord(item) ? text(item.name) : undefined;
          if (name) this.stateFor(name, now);
        }
        this.changed();
      }
      return true;
    }

    if (category === "Recognition") {
      const name = text(msg.name);
      const recoId = number(msg.reco_id);
      if (name && recoId !== undefined) {
        const state = this.stateFor(name, now);
        if (phase === "Starting") state.attempts += 1;
        state.lastTs = now;
        state.lastRecoId = recoId;
        this.changed();
      }
      return true;
    }

    return true;
  }

  snapshot(): TraceSnapshot {
    const entries: TraceEntry[] = [];
    const active = new Set<string>();
    for (const name of this.order) {
      const state = this.names.get(name);
      if (!state) continue;
      const status = this.statusOf(state);
      if (status === "not-executed") continue;
      active.add(name);
      entries.push({
        name,
        status,
        executions: state.executions,
        hits: state.hits,
        attempts: state.attempts,
        lastRecoId: state.lastRecoId,
        durationMs:
          state.firstTs !== null && state.lastTs !== null
            ? Math.max(0, state.lastTs - state.firstTs)
            : null,
      });
    }
    const universe = new Set<string>(this.knownTasks);
    for (const name of this.order) universe.add(name);
    if (this.task) universe.delete(this.task);
    const notExecuted = [...universe].filter((name) => !active.has(name));
    return { task: this.task, taskId: this.taskId, running: this.running, entries, notExecuted };
  }

  private statusOf(state: TraceNameState): TraceStatus {
    if (state.executions > 0) {
      if (state.runningSince !== null) return this.running ? "running" : "failed";
      return state.lastStatus ?? "failed";
    }
    if (state.attempts > 0) return "missed";
    return "not-executed";
  }

  private stateFor(name: string, now: number): TraceNameState {
    let state = this.names.get(name);
    if (!state) {
      state = {
        executions: 0,
        hits: 0,
        attempts: 0,
        lastStatus: null,
        runningSince: null,
        firstTs: now,
        lastTs: now,
        lastRecoId: null,
      };
      this.names.set(name, state);
      this.order.push(name);
    }
    return state;
  }

  private async loadKnownTasks() {
    const tasks = await this.deps.getKnownTasks().catch(() => null);
    if (Array.isArray(tasks) && tasks.length) {
      this.knownTasks = tasks;
      this.changed();
    }
  }

  private changed() {
    this.deps.onChange(this.snapshot());
  }
}
