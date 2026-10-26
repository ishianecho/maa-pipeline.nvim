import test from "node:test";
import assert from "node:assert/strict";

import { TraceCollector, type TraceSnapshot } from "#server/trace.ts";

function collector(knownTasks: string[] = []) {
  const snapshots: TraceSnapshot[] = [];
  const trace = new TraceCollector({
    getKnownTasks: async () => knownTasks,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { trace, snapshots };
}

function run(...messages: Record<string, unknown>[]) {
  const { trace, snapshots } = collector(["Declared", "Entry", "NeverTouched"]);
  for (const message of messages) trace.ingest("inst", message);
  return { trace, snapshots };
}

test("tracks node lifecycle across a successful task", async () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "RecognitionNode.Succeeded", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "Task.Succeeded", task_id: 1, entry: "Entry" },
  );
  const snapshot = trace.snapshot();
  assert.equal(snapshot.task, "Entry");
  assert.equal(snapshot.running, false);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.name, entry.status, entry.executions, entry.hits]),
    [["NodeA", "succeeded", 1, 1]],
  );
});

test("marks attempted-but-missed candidates as missed", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Entry",
      list: [{ name: "Miss" }, { name: "Hit" }],
    },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 5, name: "Miss" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 5, name: "Miss" },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 6, name: "Hit" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 6, name: "Hit" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "Hit" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "Hit" },
  );
  const snapshot = trace.snapshot();
  const byName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("Miss")?.status, "missed");
  assert.equal(byName.get("Miss")?.attempts, 1);
  assert.equal(byName.get("Hit")?.status, "succeeded");
  assert.equal(byName.get("Hit")?.lastRecoId, 6);
});

test("includes interrupted nodes as failed and later nodes as not executed", async () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "First" },
    { msg: "PipelineNode.Failed", task_id: 1, node_id: 10, name: "First" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 11, name: "Second" },
    { msg: "Task.Failed", task_id: 1, entry: "Entry" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = trace.snapshot();
  const byName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("First")?.status, "failed");
  assert.equal(byName.get("Second")?.status, "failed");
  assert.ok(snapshot.notExecuted.includes("Declared"));
  assert.ok(snapshot.notExecuted.includes("NeverTouched"));
  assert.ok(!snapshot.notExecuted.includes("Entry"));
});

test("keeps the latest reco id per name and counts repeated executions", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "Loop" },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 7, name: "Loop" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "Loop" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 11, name: "Loop" },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 8, name: "Loop" },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 9, name: "Loop" },
    { msg: "PipelineNode.Failed", task_id: 1, node_id: 11, name: "Loop" },
  );
  const entry = trace.snapshot().entries[0];
  assert.equal(entry.executions, 2);
  assert.equal(entry.attempts, 3);
  assert.equal(entry.lastRecoId, 9);
  assert.equal(entry.durationMs !== null && entry.durationMs >= 0, true);
});

test("resets state when a new task starts", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "Task.Succeeded", task_id: 1, entry: "Entry" },
    { msg: "Task.Starting", task_id: 2, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 2, node_id: 20, name: "NodeB" },
  );
  const snapshot = trace.snapshot();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.name),
    ["NodeB"],
  );
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.entries[0].status, "running");
});

test("ignores messages that are not trace notifications", () => {
  const { trace, snapshots } = collector();
  assert.equal(trace.ingest("inst", { msg: "Something.Else" }), false);
  assert.equal(trace.ingest("inst", "text"), false);
  assert.equal(snapshots.length, 0);
});

test("emits a snapshot on every state change", () => {
  const { snapshots } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "NodeA" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "NodeA" },
  );
  assert.ok(snapshots.length >= 3);
  assert.equal(snapshots.at(-1)?.entries[0].status, "succeeded");
});
