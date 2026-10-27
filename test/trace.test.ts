import test from "node:test";
import assert from "node:assert/strict";

import { TraceCollector, type TraceSnapshot } from "#server/trace.ts";

function collector() {
  const snapshots: TraceSnapshot[] = [];
  const trace = new TraceCollector({
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { trace, snapshots };
}

function run(...messages: Record<string, unknown>[]) {
  const { trace, snapshots } = collector();
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
    snapshot.entries.map((entry) => [entry.name, entry.status, entry.executions, entry.attempts]),
    [["NodeA", "succeeded", 1, 0]],
  );
});

test("marks attempted-but-missed candidates as missed", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Entry",
      list: [{ name: "Miss" }, { name: "Hit", jump_back: true }],
    },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 5, name: "Miss" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 5, name: "Miss" },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 6, name: "Hit", anchor: "Alias" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 6, name: "Hit" },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 10, name: "Hit" },
    {
      msg: "Action.Succeeded",
      task_id: 1,
      action_id: 3,
      name: "Hit",
      action_details: { action_id: 3, name: "Hit", action: "Click", success: true },
    },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 10, name: "Hit" },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Hit",
      list: [{ name: "Child" }],
    },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 11, name: "Child" },
    { msg: "PipelineNode.Succeeded", task_id: 1, node_id: 11, name: "Child" },
  );
  const snapshot = trace.snapshot();
  const byName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("Miss")?.status, "missed");
  assert.equal(byName.get("Miss")?.attempts, 1);
  assert.equal(byName.get("Hit")?.status, "succeeded");
  assert.equal(byName.get("Hit")?.lastRecoId, 6);
  assert.equal(byName.get("Hit")?.depth, 1);
  assert.equal(byName.get("Miss")?.depth, 1);
  assert.equal(byName.get("Child")?.depth, 2);
  assert.equal(byName.get("Hit")?.parent, "Entry");
  assert.equal(byName.get("Hit")?.jumpBack, true);
  assert.equal(byName.get("Hit")?.anchor, "Alias");
  assert.equal(byName.get("Hit")?.action, "Click");
  assert.equal(byName.get("Miss")?.jumpBack, false);
  assert.equal(byName.get("Miss")?.anchor, null);
});

test("counts stats separately per parent reference", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Entry",
      list: [{ name: "Shared" }],
    },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 1, name: "Shared" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 1, name: "Shared" },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 10,
      name: "Entry",
      node_details: { node_id: 10, name: "Shared" },
    },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Shared",
      list: [{ name: "Child" }],
    },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 11,
      name: "Shared",
      node_details: { node_id: 11, name: "Child" },
    },
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Child",
      list: [{ name: "Shared", jump_back: true }],
    },
    { msg: "Recognition.Starting", task_id: 1, reco_id: 2, name: "Shared" },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 2, name: "Shared" },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 12,
      name: "Child",
      node_details: { node_id: 12, name: "Shared" },
    },
  );
  const snapshot = trace.snapshot();
  const shared = snapshot.entries.filter((entry) => entry.name === "Shared");
  assert.equal(shared.length, 2);
  assert.deepEqual(
    shared.map((entry) => [entry.parent, entry.depth, entry.executions, entry.attempts]),
    [
      ["Entry", 1, 1, 1],
      ["Child", 3, 1, 1],
    ],
  );
  assert.equal(shared[1].jumpBack, true);
  assert.equal(shared[0].jumpBack, false);
  assert.equal(shared[1].lastRecoId, 2);
});

test("marks interrupted nodes as failed", () => {
  const { trace } = run(
    { msg: "Task.Starting", task_id: 1, entry: "Entry" },
    {
      msg: "PipelineNode.Failed",
      task_id: 1,
      node_id: 10,
      name: "Entry",
      node_details: { node_id: 10, name: "First", completed: false },
    },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 11,
      name: "First",
      node_details: { node_id: 11, name: "Second", completed: true },
    },
    { msg: "PipelineNode.Starting", task_id: 1, node_id: 11, name: "Second" },
    { msg: "Task.Failed", task_id: 1, entry: "Entry" },
  );
  const snapshot = trace.snapshot();
  const byName = new Map(snapshot.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("First")?.status, "failed");
  assert.equal(byName.get("Second")?.status, "failed");
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
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 10,
      name: "Entry",
      node_details: { node_id: 10, name: "NodeA" },
    },
    { msg: "Task.Succeeded", task_id: 1, entry: "Entry" },
    { msg: "Task.Starting", task_id: 2, entry: "Entry" },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 2,
      node_id: 20,
      name: "Entry",
      node_details: { node_id: 20, name: "NodeB" },
    },
  );
  const snapshot = trace.snapshot();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.name),
    ["NodeB"],
  );
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.entries[0].status, "succeeded");
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
    {
      msg: "NextList.Starting",
      task_id: 1,
      name: "Entry",
      list: [{ name: "NodeA" }],
    },
    { msg: "Recognition.Succeeded", task_id: 1, reco_id: 1, name: "NodeA" },
    {
      msg: "PipelineNode.Succeeded",
      task_id: 1,
      node_id: 10,
      name: "Entry",
      node_details: { node_id: 10, name: "NodeA" },
    },
  );
  assert.ok(snapshots.length >= 4);
  assert.equal(snapshots.at(-1)?.entries[0].status, "succeeded");
});
