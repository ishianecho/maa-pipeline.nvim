export interface OptionCaseView {
  name: string;
  label: string;
  children: string[];
}

export interface OptionInputView {
  name: string;
  label: string;
  default: string;
  password: boolean;
}

export interface OptionView {
  key: string;
  label: string;
  description: string;
  type: string;
  level: "settings" | "task";
  default: string | string[] | null;
  cases: OptionCaseView[];
  inputs: OptionInputView[];
}

export interface TaskOptionsView {
  entry: string;
  order: string[];
  options: Record<string, OptionView>;
}

export interface TaskRunSpec {
  entry: string;
  override: Record<string, Record<string, unknown>>;
}

export type OptionSelection = string | string[] | Record<string, string> | undefined;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(def: { label?: unknown; name?: unknown; key?: string }): string {
  return typeof def.label === "string" && def.label !== ""
    ? def.label
    : ((def.name as string) ?? def.key ?? "");
}

export function mergedInterface(project: {
  bundle?: { content?: { object?: any }; imports?: { object?: any }[] };
}): any {
  const main = project.bundle?.content?.object ?? {};
  const fragments = (project.bundle?.imports ?? [])
    .map((entry) => entry?.object)
    .filter((entry) => isObject(entry));
  const merged: any = { ...main };
  merged.task = [
    ...(Array.isArray(main.task) ? main.task : []),
    ...fragments.flatMap((fragment) => (Array.isArray(fragment.task) ? fragment.task : [])),
  ];
  merged.option = Object.assign(
    {},
    isObject(main.option) ? main.option : {},
    ...fragments.map((fragment) => (isObject(fragment.option) ? fragment.option : {})),
  );
  const globalKeys = [
    ...(Array.isArray(main.global_option) ? main.global_option : []),
    ...fragments.flatMap((fragment) =>
      Array.isArray(fragment.global_option) ? fragment.global_option : [],
    ),
  ];
  merged.global_option = [...new Set(globalKeys)];
  return merged;
}

function isActive(
  def: Record<string, any>,
  config: { controller?: string; resource?: string },
): boolean {
  if (
    Array.isArray(def.controller) &&
    config.controller &&
    !def.controller.includes(config.controller)
  ) {
    return false;
  }
  if (Array.isArray(def.resource) && config.resource && !def.resource.includes(config.resource)) {
    return false;
  }
  return true;
}

function optionLevels(
  object: any,
  config: { controller?: string; resource?: string },
  task: Record<string, any> | null,
): string[][] {
  const resource = (Array.isArray(object.resource) ? object.resource : []).find(
    (item) => item?.name === config.resource,
  );
  const controller = (Array.isArray(object.controller) ? object.controller : []).find(
    (item) => item?.name === config.controller,
  );
  return [
    Array.isArray(object.global_option) ? object.global_option : [],
    Array.isArray(resource?.option) ? resource.option : [],
    Array.isArray(controller?.option) ? controller.option : [],
    Array.isArray(task?.option) ? task.option : [],
  ];
}

function promptable(def: Record<string, any>): boolean {
  return isObject(def) && def.type !== "hotkey";
}

function findTask(object: any, taskName: string): Record<string, any> | null {
  const tasks = Array.isArray(object.task) ? object.task : [];
  return tasks.find((item) => isObject(item) && item.name === taskName) ?? null;
}

export function interfaceTasks(
  object: any,
  config: { controller?: string; resource?: string },
  resolve?: (text: string) => string,
): { name: string; label: string }[] {
  const text = (value: unknown, fallback: string): string => {
    if (typeof value !== "string" || value === "") return fallback;
    const resolved = resolve ? resolve(value) : value;
    return typeof resolved === "string" && resolved !== "" ? resolved : fallback;
  };
  return (Array.isArray(object.task) ? object.task : [])
    .filter((item) => isObject(item) && typeof item.name === "string")
    .filter(
      (item) =>
        !Array.isArray(item.resource) ||
        !config.resource ||
        item.resource.includes(config.resource),
    )
    .map((item) => ({ name: item.name as string, label: text(item.label, item.name as string) }));
}

export function taskOptions(
  object: any,
  config: { controller?: string; resource?: string },
  taskName: string,
  resolve?: (text: string) => string,
): TaskOptionsView {
  const defs = isObject(object.option) ? object.option : {};
  const task = findTask(object, taskName);
  const text = (value: string): string => {
    const resolved = resolve ? resolve(value) : value;
    return typeof resolved === "string" ? resolved : value;
  };
  const view: TaskOptionsView = {
    entry: (typeof task?.entry === "string" && task.entry) || taskName,
    order: [],
    options: {},
  };
  const visit = (key: unknown, level: "settings" | "task"): void => {
    if (typeof key !== "string" || key in view.options) return;
    const def = defs[key];
    if (!promptable(def) || !isActive(def, config)) return;
    const type = typeof def.type === "string" ? def.type : "select";
    const cases = (Array.isArray(def.cases) ? def.cases : [])
      .filter((item) => isObject(item) && typeof item.name === "string")
      .map((item) => ({
        name: item.name as string,
        label: text(label(item)),
        children: Array.isArray(item.option)
          ? item.option.filter((child) => typeof child === "string")
          : [],
      }));
    const inputs = (Array.isArray(def.inputs) ? def.inputs : [])
      .filter((item) => isObject(item) && typeof item.name === "string")
      .map((item) => ({
        name: item.name as string,
        label: text(label(item)),
        default: typeof item.default === "string" ? item.default : "",
        password: item.password === true,
      }));
    view.options[key] = {
      key,
      label: text(label({ ...def, key })),
      description: typeof def.description === "string" ? text(def.description) : "",
      type,
      level,
      default: Array.isArray(def.default_case)
        ? def.default_case.filter((item) => typeof item === "string")
        : typeof def.default_case === "string"
          ? def.default_case
          : null,
      cases,
      inputs,
    };
    for (const child of cases) {
      for (const name of child.children) visit(name, level);
    }
  };
  const seen = new Set<string>();
  const levels = optionLevels(object, config, task);
  const taskKeys = new Set(levels[3].filter((key) => typeof key === "string"));
  const levelKinds: ("settings" | "task")[] = ["settings", "settings", "settings", "task"];
  for (let index = 0; index < levels.length; index++) {
    for (const key of levels[index]) {
      if (typeof key !== "string" || seen.has(key)) continue;
      seen.add(key);
      visit(key, taskKeys.has(key) ? "task" : levelKinds[index]);
      if (key in view.options) view.order.push(key);
    }
  }
  return view;
}

export interface OptionStore {
  __settings?: Record<string, unknown>;
  __options?: Record<string, Record<string, unknown>>;
}

function sameSet(left: unknown, right: string[] | null): boolean {
  if (!Array.isArray(left)) return false;
  const wanted = [...(right ?? [])];
  return left.length === wanted.length && wanted.every((name) => left.includes(name));
}

function isDefaultSelection(def: OptionView, selection: OptionSelection): boolean {
  if (def.type === "input") {
    if (!isObject(selection)) return true;
    return def.inputs.every((field) => selection[field.name] === field.default);
  }
  if (def.type === "checkbox") {
    return sameSet(selection, def.default as string[] | null);
  }
  return selection === (def.default ?? null) || selection === undefined;
}

function sanitizeSelection(
  def: OptionView,
  selection: OptionSelection,
): Record<string, unknown> | string | string[] | null {
  if (def.type === "input") {
    if (!isObject(selection)) return null;
    const result: Record<string, string> = {};
    for (const field of def.inputs) {
      if (field.password) continue;
      if (typeof selection[field.name] === "string") result[field.name] = selection[field.name];
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  if (def.type === "checkbox") {
    if (!Array.isArray(selection)) return null;
    const names = def.cases.map((item) => item.name);
    const result = selection.filter((name) => typeof name === "string" && names.includes(name));
    return result;
  }
  if (typeof selection !== "string") return null;
  return def.cases.some((item) => item.name === selection) ? selection : null;
}

export function savedSelections(
  view: TaskOptionsView,
  store: OptionStore,
  taskName: string,
): Record<string, OptionSelection> {
  const merged: Record<string, OptionSelection> = {};
  const taskSaved = store.__options?.[taskName];
  for (const source of [store.__settings, isObject(taskSaved) ? taskSaved : null]) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!(key in view.options)) continue;
      const sanitized = sanitizeSelection(view.options[key], value as OptionSelection);
      if (sanitized !== null) merged[key] = sanitized as OptionSelection;
    }
  }
  return merged;
}

export function optionSavePlan(
  view: TaskOptionsView,
  selections: Record<string, OptionSelection> | null | undefined,
  store: OptionStore,
  taskName: string,
): OptionStore {
  const chosen = selections && isObject(selections) ? selections : {};
  const settings: Record<string, unknown> = { ...(store.__settings ?? {}) };
  const task: Record<string, unknown> = { ...(store.__options?.[taskName] ?? {}) };
  const visited = new Set<string>();
  const plan = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const def = view.options[key];
    if (!def) return;
    const zone = def.level === "settings" ? settings : task;
    const sanitized = isDefaultSelection(def, chosen[key])
      ? null
      : sanitizeSelection(def, chosen[key]);
    if (sanitized === null) delete zone[key];
    else zone[key] = sanitized;
    for (const entry of def.cases) {
      for (const child of entry.children) plan(child);
    }
  };
  for (const key of view.order) plan(key);
  return { __settings: settings, __options: { ...(store.__options ?? {}), [taskName]: task } };
}

function mergeFields(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      isObject(result[key]) && isObject(value) ? mergeFields(result[key], value) : value;
  }
  return result;
}

function mergeOverride(target: Record<string, Record<string, unknown>>, override: unknown): void {
  if (!isObject(override)) return;
  for (const [node, fields] of Object.entries(override)) {
    if (!isObject(fields)) continue;
    target[node] = mergeFields(target[node] ?? {}, fields);
  }
}

function convertInput(value: string, type: unknown): string | number | boolean {
  if (type === "int") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === "bool") {
    return value === "true" || value === "1";
  }
  return value;
}

function substitute(
  template: unknown,
  values: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const exact = node.match(/^\{([^{}]+)\}$/);
      if (exact && exact[1] in values) return values[exact[1]];
      return node.replace(/\{([^{}]+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      );
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) result[key] = walk(value);
      return result;
    }
    return node;
  };
  const applied = walk(template);
  return isObject(applied) ? applied : {};
}

function selectedCases(def: Record<string, any>, selection: OptionSelection): string[] {
  const cases = (Array.isArray(def.cases) ? def.cases : [])
    .map((item) => item?.name)
    .filter((name) => typeof name === "string");
  if (Array.isArray(selection)) {
    return selection.filter((name) => typeof name === "string" && cases.includes(name));
  }
  if (typeof selection === "string") {
    return cases.includes(selection) ? [selection] : [];
  }
  if (Array.isArray(def.default_case)) {
    return def.default_case.filter((name) => typeof name === "string" && cases.includes(name));
  }
  return typeof def.default_case === "string" && cases.includes(def.default_case)
    ? [def.default_case]
    : [];
}

export function resolveTaskRun(
  object: any,
  config: { controller?: string; resource?: string },
  taskName: string,
  selections: Record<string, OptionSelection> | null | undefined,
): TaskRunSpec {
  const defs = isObject(object.option) ? object.option : {};
  const task = findTask(object, taskName);
  const chosen = selections && isObject(selections) ? selections : {};
  const override: Record<string, Record<string, unknown>> = {};

  const apply = (key: string): void => {
    const def = defs[key];
    if (!promptable(def) || !isActive(def, config)) return;
    const type = typeof def.type === "string" ? def.type : "select";
    if (type === "input") {
      const picked = isObject(chosen[key]) ? (chosen[key] as Record<string, string>) : {};
      const values: Record<string, string | number | boolean> = {};
      for (const input of Array.isArray(def.inputs) ? def.inputs : []) {
        if (!isObject(input) || typeof input.name !== "string") continue;
        const fallback = typeof input.default === "string" ? input.default : "";
        const raw = typeof picked[input.name] === "string" ? picked[input.name] : fallback;
        values[input.name] = convertInput(raw, input.pipeline_type);
      }
      mergeOverride(override, substitute(def.pipeline_override, values));
      return;
    }
    const names = selectedCases(def, chosen[key]);
    const ordered = (Array.isArray(def.cases) ? def.cases : []).filter(
      (item) => isObject(item) && typeof item.name === "string" && names.includes(item.name),
    );
    for (const entry of ordered) {
      mergeOverride(override, entry.pipeline_override);
      for (const child of Array.isArray(entry.option) ? entry.option : []) {
        if (typeof child === "string") apply(child);
      }
    }
  };

  for (const level of optionLevels(object, config, task)) {
    for (const key of level) {
      if (typeof key === "string") apply(key);
    }
  }
  if (task && isObject(task.pipeline_override)) {
    mergeOverride(override, task.pipeline_override);
  }
  return { entry: (typeof task?.entry === "string" && task.entry) || taskName, override };
}
