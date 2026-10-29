import test from "node:test";
import assert from "node:assert/strict";

import {
  interfaceTasks,
  mergedInterface,
  optionSavePlan,
  resolveTaskRun,
  savedSelections,
  taskOptions,
} from "#server/options.ts";

const interface_ = {
  controller: [
    { name: "c1", type: "Adb", option: ["控制器选项"] },
    { name: "c2", type: "Adb" },
  ],
  resource: [{ name: "r1", path: ["."], option: ["资源选项"] }],
  global_option: ["吃药"],
  option: {
    吃药: {
      type: "switch",
      description: "是否使用药水恢复理智",
      default_case: "No",
      cases: [
        { name: "Yes", pipeline_override: { UsePotion: { enabled: true } } },
        { name: "No", pipeline_override: { UsePotion: { enabled: false } } },
      ],
    },
    关卡: {
      type: "select",
      label: "选择关卡",
      default_case: "3-9",
      cases: [
        {
          name: "3-9",
          pipeline_override: { EnterTheShow: { next: "MainChapter_3" } },
          option: ["次数"],
        },
        { name: "4-1", pipeline_override: { EnterTheShow: { next: "MainChapter_4" } } },
      ],
    },
    次数: {
      type: "input",
      inputs: [
        { name: "章节号", default: "4", pipeline_type: "int" },
        { name: "密码", default: "", password: true },
      ],
      pipeline_override: { Farm: { times: "{章节号}" } },
    },
    资源选项: {
      type: "select",
      default_case: "a",
      cases: [{ name: "a", pipeline_override: { Node: { target: 1 } } }],
    },
    控制器选项: {
      type: "select",
      controller: ["c1"],
      default_case: "b",
      cases: [{ name: "b", pipeline_override: { Node: { target: 2 } } }],
    },
    任务选项: {
      type: "checkbox",
      default_case: ["x"],
      cases: [
        { name: "x", pipeline_override: { Node: { target: 3 } } },
        { name: "y", pipeline_override: { Node: { speed: "fast" } } },
      ],
    },
    热键: {
      type: "hotkey",
      cases: [{ name: "z", pipeline_override: { Node: { target: 9 } } }],
    },
  },
  task: [
    {
      name: "每日",
      label: "$任务",
      entry: "DailyStart",
      option: ["关卡", "任务选项"],
      pipeline_override: { Quit: { enabled: true } },
    },
    { name: "裸任务" },
    { name: "外服任务", entry: "OverseasStart", resource: ["r2"] },
  ],
};

const config = { controller: "c1", resource: "r1" };

test("merges main interface with import fragments", () => {
  const merged = mergedInterface({
    bundle: {
      content: {
        object: { task: [{ name: "主" }], option: { A: { type: "select" } }, global_option: ["A"] },
      },
      imports: [
        {
          object: {
            task: [{ name: "导入" }],
            option: { A: { type: "switch" } },
            global_option: ["A", "B"],
          },
        },
      ],
    },
  });
  assert.deepEqual(
    merged.task.map((task) => task.name),
    ["主", "导入"],
  );
  assert.equal(merged.option.A.type, "switch");
  assert.deepEqual(merged.global_option, ["A", "B"]);
});

test("orders promptable options global, resource, controller, then task", () => {
  const view = taskOptions(interface_, config, "每日");
  assert.equal(view.entry, "DailyStart");
  assert.deepEqual(view.order, ["吃药", "资源选项", "控制器选项", "关卡", "任务选项"]);
  assert.equal(view.options["关卡"].label, "选择关卡");
  assert.equal(view.options["关卡"].default, "3-9");
  assert.deepEqual(view.options["关卡"].cases[0].children, ["次数"]);
  assert.deepEqual(view.options["任务选项"].default, ["x"]);
});

test("hides options inapplicable to the current controller and hotkey options", () => {
  const view = taskOptions(interface_, { controller: "c2", resource: "r1" }, "每日");
  assert.ok(!view.options["控制器选项"]);
  assert.ok(!view.options["热键"]);
  assert.ok(!view.order.includes("控制器选项"));
});

test("falls back to the task name when no entry is declared", () => {
  const view = taskOptions(interface_, config, "裸任务");
  assert.equal(view.entry, "裸任务");
  assert.deepEqual(view.order, ["吃药", "资源选项", "控制器选项"]);
});

test("matches tasks by name only, so node runs carry no task options", () => {
  const view = taskOptions(interface_, config, "DailyStart");
  assert.equal(view.entry, "DailyStart");
  assert.deepEqual(view.order, ["吃药", "资源选项", "控制器选项"]);
});

test("applies defaults, nested children, and task override without selections", () => {
  const spec = resolveTaskRun(interface_, config, "每日", undefined);
  assert.equal(spec.entry, "DailyStart");
  assert.deepEqual(spec.override, {
    UsePotion: { enabled: false },
    Node: { target: 3 },
    EnterTheShow: { next: "MainChapter_3" },
    Farm: { times: 4 },
    Quit: { enabled: true },
  });
});

test("honors user selections including input conversion and checkbox choices", () => {
  const spec = resolveTaskRun(interface_, config, "每日", {
    吃药: "Yes",
    关卡: "4-1",
    次数: { 章节号: "6" },
    任务选项: ["y"],
  });
  assert.deepEqual(spec.override, {
    UsePotion: { enabled: true },
    Node: { target: 2, speed: "fast" },
    EnterTheShow: { next: "MainChapter_4" },
    Quit: { enabled: true },
  });
  assert.ok(!("Farm" in spec.override));
});

test("converts input placeholders per pipeline_type", () => {
  const spec = resolveTaskRun(interface_, config, "每日", { 关卡: "3-9", 次数: { 章节号: "6" } });
  assert.deepEqual(spec.override.Farm, { times: 6 });
});

test("later levels override earlier field values", () => {
  const spec = resolveTaskRun(interface_, config, "每日", { 任务选项: [] });
  assert.equal(spec.override.Node.target, 2);
});

test("skips overrides for inapplicable options even when selected", () => {
  const spec = resolveTaskRun(interface_, { controller: "c2", resource: "r1" }, "每日", {
    控制器选项: "b",
    任务选项: [],
  });
  assert.equal(spec.override.Node.target, 1);
});

test("lists interface tasks with resolved labels and resource filtering", () => {
  const tasks = interfaceTasks(interface_, config, (text) =>
    text === "$任务" ? "每日任务" : text,
  );
  assert.deepEqual(tasks, [
    { name: "每日", label: "每日任务" },
    { name: "裸任务", label: "裸任务" },
  ]);
});

test("resolves option labels through the locale resolver", () => {
  const view = taskOptions(interface_, config, "每日", (text) => `T:${text}`);
  assert.equal(view.options["关卡"].label, "T:选择关卡");
  assert.equal(view.options["关卡"].cases[0].label, "T:3-9");
});

test("passes option descriptions through the locale resolver", () => {
  const view = taskOptions(interface_, config, "每日", (text) => `T:${text}`);
  assert.equal(view.options["吃药"].description, "T:是否使用药水恢复理智");
  assert.equal(view.options["关卡"].description, "");
});

test("savedSelections merges settings and task stores, keeping valid view keys", () => {
  const view = taskOptions(interface_, config, "每日");
  const saved = savedSelections(
    view,
    {
      __settings: { 吃药: "Yes", 资源选项: "not-a-case" },
      __options: { 每日: { 关卡: "4-1", 任务选项: ["y"], 消失的: "x" }, 别的任务: { 关卡: "3-9" } },
    },
    "每日",
  );
  assert.deepEqual(saved, {
    吃药: "Yes",
    关卡: "4-1",
    任务选项: ["y"],
  });
});

test("optionSavePlan stores only non-default values and splits them by level", () => {
  const view = taskOptions(interface_, config, "每日");
  const plan = optionSavePlan(
    view,
    { 吃药: "Yes", 次数: { 章节号: "6", 密码: "secret" }, 任务选项: ["x"] },
    {},
    "每日",
  );
  assert.deepEqual(plan, {
    __settings: { 吃药: "Yes" },
    __options: { 每日: { 次数: { 章节号: "6" } } },
  });
});

test("optionSavePlan deletes reset values and keeps other tasks untouched", () => {
  const view = taskOptions(interface_, config, "每日");
  const plan = optionSavePlan(
    view,
    {},
    {
      __settings: { 吃药: "Yes", 资源选项: "a" },
      __options: { 每日: { 关卡: "4-1" }, 别的任务: { 关卡: "3-9" } },
    },
    "每日",
  );
  assert.deepEqual(plan, {
    __settings: {},
    __options: { 每日: {}, 别的任务: { 关卡: "3-9" } },
  });
});

test("optionSavePlan stores checkbox deviations from the default set", () => {
  const view = taskOptions(interface_, config, "每日");
  const plan = optionSavePlan(view, { 任务选项: [] }, {}, "每日");
  assert.deepEqual(plan.__options, { 每日: { 任务选项: [] } });
});
