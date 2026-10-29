local M = {}

local keymap = require("maa-pipeline.keymap")
local help = require("maa-pipeline.help")
local highlights = require("maa-pipeline.highlights")
local api = require("maa-pipeline.client")

local buffer_name = "maa-pipeline://task-options"

local namespace = vim.api.nvim_create_namespace("maa_pipeline_options")

local state = nil

local function valid_key(value)
  return value ~= nil and value ~= "" and value ~= false
end

local function save(client, root, name, selections, done)
  api.request(client, "maa-pipeline.saveTaskOptions", { root, name, selections }, done)
end

local function save_and_run(client, root, name, selections)
  save(client, root, name, selections, function()
    api.request(client, "maa-pipeline.runInterfaceTask", { root, name, selections })
  end)
end

local function autosave()
  if not state then
    return
  end
  save(state.client, state.root, state.name, state.selections)
end

local function close()
  if not state then
    return
  end
  local current = state
  state = nil
  if current.buffer and vim.api.nvim_buf_is_valid(current.buffer) then
    for _, win in ipairs(vim.fn.win_findbuf(current.buffer)) do
      pcall(vim.api.nvim_win_close, win, true)
    end
  end
end

local function init_selection(def, saved)
  if def.type == "input" then
    local values = {}
    for _, field in ipairs(def.inputs or {}) do
      values[field.name] = (saved and saved[field.name]) or field.default or ""
    end
    return values
  end
  if def.type == "checkbox" then
    if type(saved) == "table" then
      return vim.deepcopy(saved)
    end
    if type(def.default) == "table" then
      return vim.deepcopy(def.default)
    end
    return {}
  end
  if type(saved) == "string" then
    return saved
  end
  if type(def.default) == "string" then
    return def.default
  end
  return (def.cases or {})[1] and def.cases[1].name or nil
end

local function is_default(key)
  local def = state.view.options[key]
  local selection = state.selections[key]
  if def.type == "input" then
    if type(selection) ~= "table" then
      return true
    end
    for _, field in ipairs(def.inputs or {}) do
      if selection[field.name] ~= field.default then
        return false
      end
    end
    return true
  end
  if def.type == "checkbox" then
    local defaults = {}
    if type(def.default) == "table" then
      for _, name in ipairs(def.default) do
        defaults[name] = true
      end
    end
    local chosen = {}
    for _, name in ipairs(type(selection) == "table" and selection or {}) do
      chosen[name] = true
    end
    for name, value in pairs(defaults) do
      if chosen[name] ~= value then
        return false
      end
    end
    for name, value in pairs(chosen) do
      if defaults[name] ~= value then
        return false
      end
    end
    return true
  end
  return selection == def.default
end

local function chosen_cases(def, selection)
  local names = {}
  if def.type == "checkbox" then
    for _, name in ipairs(type(selection) == "table" and selection or {}) do
      names[#names + 1] = name
    end
    return names
  end
  if type(selection) == "string" then
    names[#names + 1] = selection
  end
  return names
end

local function ensure_selection(key)
  local def = state.view.options[key]
  if not def or state.selections[key] ~= nil then
    return
  end
  state.selections[key] = init_selection(def, (state.view.saved or {})[key])
end

local function active_children(key)
  local def = state.view.options[key]
  local chosen = {}
  for _, name in ipairs(chosen_cases(def, state.selections[key])) do
    chosen[name] = true
  end
  local children = {}
  for _, case in ipairs(def.cases or {}) do
    if chosen[case.name] then
      for _, child in ipairs(case.children or {}) do
        children[#children + 1] = child
      end
    end
  end
  return children
end

local function case_label(def, name)
  for _, case in ipairs(def.cases or {}) do
    if case.name == name then
      return case.label ~= "" and case.label or case.name
    end
  end
  return name
end

local function mark(key)
  return is_default(key) and "  " or "* "
end

local function indent_text(indent)
  return string.rep("  ", indent)
end

local function switch_on(def, selection)
  for _, case in ipairs(def.cases or {}) do
    if case.name == selection then
      local name = case.name:lower()
      return name ~= "no" and name ~= "n"
    end
  end
  return false
end

local function push_option(rows, lines, key, indent)
  local def = state.view.options[key]
  ensure_selection(key)
  local push = function(row)
    row.line_index = #lines + 1
    rows[#rows + 1] = row
    lines[#lines + 1] = row.line
  end
  local push_segments = function(segments, row)
    local parts = {}
    local hl = {}
    local position = 0
    for _, segment in ipairs(segments) do
      parts[#parts + 1] = segment[1]
      if segment[2] then
        hl[#hl + 1] = { segment[2], position, position + #segment[1] }
      end
      position = position + #segment[1]
    end
    row.line = table.concat(parts)
    row.hl = hl
    push(row)
  end
  local description = type(def.description) == "string" and def.description or ""
  description = vim.trim(description:gsub("%c+", " "))
  local function with_desc(segments)
    if description == "" then
      return segments
    end
    local copy = vim.list_extend({}, segments)
    copy[#copy + 1] = { "  " .. description, highlights.option.desc }
    return copy
  end
  if def.type == "checkbox" then
    local chosen = {}
    for _, name in ipairs(type(state.selections[key]) == "table" and state.selections[key] or {}) do
      chosen[name] = true
    end
    push_segments(with_desc({
      { indent_text(indent) },
      { mark(key) },
      { def.label },
      { ": " },
    }), { key = key, kind = "option" })
    for _, case in ipairs(def.cases or {}) do
      local box = chosen[case.name] and "[x] " or "[ ] "
      push({
        key = key,
        kind = "case",
        case = case.name,
        line = indent_text(indent + 2) .. box .. case.label,
      })
    end
  elseif def.type == "input" then
    local values = type(state.selections[key]) == "table" and state.selections[key] or {}
    for index, field in ipairs(def.inputs or {}) do
      local segments = {
        { indent_text(indent) },
        { mark(key) },
        { field.label },
        { ": " },
        { tostring(values[field.name] or ""), highlights.option.input },
      }
      push_segments(index == 1 and with_desc(segments) or segments, {
        key = key,
        kind = "field",
        field = field.name,
      })
    end
  elseif def.type == "switch" then
    local on = switch_on(def, state.selections[key])
    push_segments(with_desc({
      { indent_text(indent) },
      { mark(key) },
      { def.label, highlights.option.switch },
      { " " },
      { on and "[Y]" or "[N]", on and highlights.option.switch_on or highlights.option.switch_off },
    }), { key = key, kind = "option" })
  else
    local selection = state.selections[key]
    push_segments(with_desc({
      { indent_text(indent) },
      { mark(key) },
      { def.label },
      { ": " },
      { selection ~= nil and case_label(def, selection) or "" },
    }), { key = key, kind = "option" })
  end
  for _, child in ipairs(active_children(key)) do
    push_option(rows, lines, child, indent + 1)
  end
end

local function hints()
  local items = {
    { "toggle", "edit" },
    { "reset", "reset" },
    { "reset_all", "reset all" },
    { "run", "run" },
    { "close", "close" },
    { "help", "help" },
  }
  local parts = {}
  for _, item in ipairs(items) do
    local key = keymap.get("options", item[1])
    if valid_key(key) then
      parts[#parts + 1] = key .. " " .. item[2]
    end
  end
  return table.concat(parts, "  ")
end

local function option_sections()
  local settings = {}
  local task = {}
  for _, key in ipairs(state.view.order or {}) do
    local def = state.view.options[key]
    if def then
      table.insert(def.level == "settings" and settings or task, key)
    end
  end
  return settings, task
end

local function current_row()
  if not state or not state.line_rows then
    return nil
  end
  return state.line_rows[vim.fn.line(".")]
end

local function panel_window()
  if not state or not vim.api.nvim_buf_is_valid(state.buffer) then
    return nil
  end
  return vim.fn.win_findbuf(state.buffer)[1]
end

local function render()
  if not state or not vim.api.nvim_buf_is_valid(state.buffer) then
    return
  end
  local cursor_row = current_row()
  local rows = {}
  highlights.define()
  local hint = hints()
  local lines = { "Maa task options — " .. state.name, hint, "" }
  local settings, task = option_sections()
  local function push_section(title, keys)
    lines[#lines + 1] = title .. ":"
    local base = #rows
    for _, key in ipairs(keys) do
      push_option(rows, lines, key, 2)
    end
    if #rows == base then
      lines[#lines + 1] = indent_text(2) .. "(none)"
    end
    lines[#lines + 1] = ""
  end
  push_section("Task options", task)
  if #settings > 0 then
    push_section("Global options", settings)
  end
  if #state.view.order == 0 then
    lines[#lines] = "No options for this task"
  end
  state.rows = rows
  state.line_rows = {}
  for _, row in ipairs(rows) do
    state.line_rows[row.line_index] = row
  end
  vim.bo[state.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(state.buffer, 0, -1, false, lines)
  vim.bo[state.buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(state.buffer, namespace, 0, -1)
  for _, row in ipairs(rows) do
    for _, range in ipairs(row.hl or {}) do
      vim.api.nvim_buf_add_highlight(
        state.buffer,
        namespace,
        range[1],
        row.line_index - 1,
        range[2],
        range[3]
      )
    end
  end
  if hint ~= "" then
    help.highlight_hint(state.buffer, namespace, 1)
  end
  local win = panel_window()
  if cursor_row and win then
    for _, row in ipairs(rows) do
      if row.key == cursor_row.key
        and row.kind == cursor_row.kind
        and row.case == cursor_row.case
        and row.field == cursor_row.field
      then
        vim.api.nvim_win_set_cursor(win, { row.line_index, 0 })
        break
      end
    end
  end
end

local function render_help()
  if not state or not vim.api.nvim_buf_is_valid(state.buffer) then
    return
  end
  local lines, marks = help.lines("Maa task options — " .. state.name, "options", {
    {
      "Press the edit key on any row: select and switch",
      "options cycle through their cases (or pick from a list when",
      "there are more than three), checkbox cases toggle, input",
      "fields edit in place.",
      "",
      "Rows marked * differ from the default value.",
      "Child options appear indented under the case that activates them",
      "and disappear when that case is not chosen.",
      "",
      "Choices save to config/maa_pi_config.json automatically on every",
      "change; :MaaPipelineTaskRun opens this panel before every run,",
      "prefilled with the saved choices.",
      "",
      "Levels: Task options come from the task itself; Global options come",
      "from global_option or the current resource/controller.",
    },
  })
  vim.bo[state.buffer].modifiable = true
  vim.api.nvim_buf_set_lines(state.buffer, 0, -1, false, lines)
  vim.bo[state.buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(state.buffer, namespace, 0, -1)
  highlights.define()
  help.apply_desc_marks(state.buffer, namespace, marks)
end

local function redraw()
  if state and state.help_mode then
    render_help()
  else
    render()
  end
end

local function set_selection(key, value)
  state.selections[key] = value
  for _, child in ipairs(active_children(key)) do
    ensure_selection(child)
  end
  redraw()
  autosave()
end

local function pick_case(def, current, callback)
  local cases = def.cases or {}
  if #cases <= 3 then
    local index = 1
    for i, case in ipairs(cases) do
      if case.name == current then
        index = i
      end
    end
    callback(cases[(index % #cases) + 1].name)
    return
  end
  local items = {}
  for _, case in ipairs(cases) do
    items[#items + 1] = { name = case.name, label = case.label }
  end
  vim.ui.select(items, {
    prompt = def.label .. ": ",
    format_item = function(item)
      return item.label .. (item.name == def.default and " *" or "")
    end,
  }, function(choice)
    if not choice then
      return
    end
    callback(choice.name)
  end)
end

local function change_row()
  local row = current_row()
  if not row then
    return
  end
  local def = state.view.options[row.key]
  if row.kind == "case" then
    local selected = {}
    for _, name in ipairs(state.selections[row.key] or {}) do
      selected[name] = true
    end
    if selected[row.case] then
      selected[row.case] = nil
    else
      selected[row.case] = true
    end
    local names = {}
    for _, case in ipairs(def.cases or {}) do
      if selected[case.name] then
        names[#names + 1] = case.name
      end
    end
    set_selection(row.key, names)
    return
  end
  if row.kind == "field" then
    local label = row.field
    for _, field in ipairs(def.inputs or {}) do
      if field.name == row.field then
        label = field.label ~= "" and field.label or field.name
      end
    end
    local values = type(state.selections[row.key]) == "table" and state.selections[row.key] or {}
    local default = tostring(values[row.field] or "")
    vim.ui.input({ prompt = label .. ": ", default = default }, function(value)
      if value == nil or not state then
        return
      end
      values[row.field] = value
      redraw()
      autosave()
    end)
    return
  end
  if def.type == "select" or def.type == "switch" then
    pick_case(def, state.selections[row.key], function(name)
      if state then
        set_selection(row.key, name)
      end
    end)
  end
end

local function reset_option(key)
  local def = state.view.options[key]
  state.selections[key] = init_selection(def, nil)
  for _, child in ipairs(active_children(key)) do
    reset_option(child)
  end
end

local function reset_row()
  local row = current_row()
  if row then
    reset_option(row.key)
    redraw()
    autosave()
  end
end

local function reset_all()
  for _, key in ipairs(state.view.order or {}) do
    reset_option(key)
  end
  redraw()
  autosave()
end

local function run_task()
  save_and_run(state.client, state.root, state.name, state.selections)
  close()
end

local function toggle_help()
  if not state then
    return
  end
  state.help_mode = not state.help_mode
  redraw()
end

local function ensure_buffer()
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
    keymap.setup("options", buffer, {
      toggle = change_row,
      reset = reset_row,
      reset_all = reset_all,
      run = run_task,
      close = close,
      help = toggle_help,
    })
  end
  return buffer
end

function M.open(client, root, name, view)
  close()
  state = {
    client = client,
    root = root,
    name = name,
    view = view,
    saved = view.saved or {},
    selections = {},
    rows = {},
    line_rows = {},
    help_mode = false,
  }
  state.buffer = ensure_buffer()
  local windows = vim.fn.win_findbuf(state.buffer)
  if #windows > 0 then
    vim.api.nvim_set_current_win(windows[1])
  else
    vim.cmd("tabnew")
    vim.api.nvim_set_current_buf(state.buffer)
  end
  render()
end

function M.run(client, root, name, selections)
  if selections == nil then
    api.request(client, "maa-pipeline.taskOptions", { root, name }, function(view)
      M.open(client, root, name, view)
    end)
    return
  end
  save_and_run(client, root, name, selections)
end

return M
