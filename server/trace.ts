export type TraceStatus = "running" | "succeeded" | "failed" | "missed";

export interface TraceEntry {
  parent: string | null;
  name: string;
  status: TraceStatus;
  depth: number;
  executions: number;
  attempts: number;
  lastRecoId: number | null;
  durationMs: number | null;
  jumpBack: boolean;
  anchor: string | null;
  action: string | null;
}

export interface TraceSnapshot {
  task: string | null;
  taskId: number | null;
  running: boolean;
  entries: TraceEntry[];
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
  images: string[];
}

export interface TraceDeps {
  onChange: (snapshot: TraceSnapshot) => void;
}

interface TraceEdgeState {
  parent: string | null;
  name: string;
  executions: number;
  attempts: number;
  lastStatus: "succeeded" | "failed" | null;
  runningSince: number | null;
  firstTs: number;
  lastTs: number;
  lastRecoId: number | null;
  jumpBack: boolean;
  anchor: string | null;
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

function edgeKey(parent: string | null, name: string): string {
  return (parent ?? "") + "\0" + name;
}

export class TraceCollector {
  private deps: TraceDeps;
  private inst: string | null = null;
  private task: string | null = null;
  private taskId: number | null = null;
  private running = false;
  private edges = new Map<string, TraceEdgeState>();
  private order: string[] = [];
  private actions = new Map<string, string>();
  private currentParent: string | null = null;
  private lastHit = new Map<string, string>();
  private lastRecoId: number | null = null;

  constructor(deps: TraceDeps) {
    this.deps = deps;
  }

  currentInst(): string | null {
    return this.inst;
  }

  latestRecoId(): number | null {
    return this.lastRecoId;
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
        this.edges = new Map();
        this.order = [];
        this.actions = new Map();
        this.currentParent = null;
        this.lastHit = new Map();
        this.lastRecoId = null;
        this.running = true;
        if (this.task) this.stateFor(null, this.task, now);
      } else {
        this.running = false;
      }
      this.changed();
      return true;
    }

    if (category === "PipelineNode") {
      if (phase === "Starting") {
        const name = text(msg.name);
        if (name) {
          const key = this.lastHit.get(name);
          const state = key ? this.edges.get(key) : undefined;
          if (state && state.executions > 0) {
            state.lastTs = now;
            state.runningSince = now;
            this.changed();
          }
        }
        return true;
      }
      const details = isRecord(msg.node_details) ? msg.node_details : null;
      const hitName = details ? text(details.name) : text(msg.name);
      const poller = details ? text(msg.name) : this.currentParent;
      const parent = poller !== undefined && poller !== hitName ? poller : null;
      if (hitName) {
        const state = this.stateFor(parent, hitName, now);
        state.lastTs = now;
        state.executions += 1;
        state.lastStatus = phase === "Succeeded" ? "succeeded" : "failed";
        state.runningSince = null;
        this.lastHit.set(hitName, edgeKey(parent, hitName));
        this.changed();
      }
      if (poller !== undefined && poller !== hitName) {
        const pkey = this.lastHit.get(poller);
        const pstate = pkey ? this.edges.get(pkey) : undefined;
        if (pstate) {
          pstate.lastTs = now;
          pstate.runningSince = null;
          this.changed();
        }
      }
      return true;
    }

    if (category === "RecognitionNode") {
      const name = text(msg.name);
      if (name && phase === "Succeeded") {
        this.stateFor(this.currentParent, name, now);
        this.changed();
      }
      return true;
    }

    if (category === "NextList") {
      if (Array.isArray(msg.list)) {
        const parent = text(msg.name) ?? null;
        this.currentParent = parent;
        for (const item of msg.list) {
          if (!isRecord(item)) continue;
          const name = text(item.name);
          if (!name) continue;
          const state = this.stateFor(parent, name, now);
          if (item.jump_back === true) state.jumpBack = true;
        }
        this.changed();
      }
      return true;
    }

    if (category === "Recognition") {
      const name = text(msg.name);
      const recoId = number(msg.reco_id);
      if (name && recoId !== undefined) {
        const state = this.stateFor(this.currentParent, name, now);
        if (phase === "Starting") state.attempts += 1;
        state.lastTs = now;
        state.lastRecoId = recoId;
        this.lastRecoId = recoId;
        const anchor = text(msg.anchor);
        if (anchor) state.anchor = anchor;
        this.changed();
      }
      return true;
    }

    if (category === "Action") {
      const name = text(msg.name);
      if (name) {
        if (phase !== "Starting" && isRecord(msg.action_details)) {
          const action = text(msg.action_details.action);
          if (action) this.actions.set(name, action);
        }
        this.changed();
      }
      return true;
    }

    return true;
  }

  snapshot(): TraceSnapshot {
    const depths = this.nodeDepths();
    const entries: TraceEntry[] = [];
    for (const key of this.order) {
      const state = this.edges.get(key);
      if (!state) continue;
      const status = this.statusOf(state);
      if (!status) continue;
      entries.push({
        parent: state.parent,
        name: state.name,
        status,
        depth: state.parent === null ? 0 : (depths.get(state.parent) ?? -1) + 1,
        executions: state.executions,
        attempts: state.attempts,
        lastRecoId: state.lastRecoId,
        durationMs: Math.max(0, state.lastTs - state.firstTs),
        jumpBack: state.jumpBack,
        anchor: state.anchor,
        action: this.actions.get(state.name) ?? null,
      });
    }
    return { task: this.task, taskId: this.taskId, running: this.running, entries };
  }

  private statusOf(state: TraceEdgeState): TraceStatus | null {
    if (state.executions > 0) {
      if (state.runningSince !== null) return this.running ? "running" : "failed";
      return state.lastStatus ?? "failed";
    }
    if (state.attempts > 0) return "missed";
    return null;
  }

  private nodeDepths(): Map<string, number> {
    const depths = new Map<string, number>();
    for (const edge of this.edges.values()) {
      if (edge.parent === null) depths.set(edge.name, 0);
    }
    let changed = true;
    let rounds = this.edges.size + 1;
    while (changed && rounds-- > 0) {
      changed = false;
      for (const edge of this.edges.values()) {
        if (edge.parent === null) continue;
        const parentDepth = depths.get(edge.parent);
        if (parentDepth === undefined) continue;
        const depth = parentDepth + 1;
        if (depth < (depths.get(edge.name) ?? Infinity)) {
          depths.set(edge.name, depth);
          changed = true;
        }
      }
    }
    return depths;
  }

  private stateFor(parent: string | null, name: string, now: number): TraceEdgeState {
    const key = edgeKey(parent, name);
    let state = this.edges.get(key);
    if (!state) {
      state = {
        parent,
        name,
        executions: 0,
        attempts: 0,
        lastStatus: null,
        runningSince: null,
        firstTs: now,
        lastTs: now,
        lastRecoId: null,
        jumpBack: false,
        anchor: null,
      };
      this.edges.set(key, state);
      this.order.push(key);
    }
    return state;
  }

  private changed() {
    this.deps.onChange(this.snapshot());
  }
}
