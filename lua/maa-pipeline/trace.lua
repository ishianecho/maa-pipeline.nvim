local M = {}

local help = require("maa-pipeline.help")
local keymap = require("maa-pipeline.keymap")

local buffer_name = "maa-pipeline://trace"
local namespace = vim.api.nvim_create_namespace("maa_pipeline_trace")

local state = {
  client_id = nil,
  snapshot = nil,
  help = false,
  line_entries = {},
  fold_levels = {},
}

local METRICS_COL = 60
local MIN_NAME = 16

local status_hl = {
  succeeded = "MaaPipelineTraceSucceeded",
  running = "MaaPipelineTraceRunning",
  failed = "MaaPipelineTraceFailed",
  missed = "MaaPipelineTraceMissed",
}

local STATUS_TOKEN = {
  succeeded = "hit",
  running = "run",
  failed = "fail",
  missed = "miss",
}

local function current_client()
  return state.client_id and vim.lsp.get_client_by_id(state.client_id) or nil
end

local function fmt_duration(ms)
  if not ms then
    return ""
  end
  if ms < 1000 then
    return string.format("%dms", ms)
  end
  return string.format("%.1fs", ms / 1000)
end

local function metric_cell(text, width)
  if text == "" then
    return (" "):rep(width + 1)
  end
  if #text >= width then
    return text .. " "
  end
  return (" "):rep(width - #text) .. text .. " "
end

local function format_row(col, prefix, name, cells)
  local line = prefix
  local width = col - #line
  if width < MIN_NAME + 1 then
    width = MIN_NAME + 1
  end
  line = line .. " " .. name
  local pad = width - #name - 1
  if pad > 0 then
    line = line .. (" "):rep(pad)
  end
  return (line .. table.concat(cells)):gsub("%s+$", "")
end

local function configure_highlights()
  vim.cmd("highlight default link MaaPipelineTraceSucceeded String")
  vim.cmd("highlight default link MaaPipelineTraceFailed ErrorMsg")
  vim.cmd("highlight default link MaaPipelineTraceRunning MoreMsg")
  vim.cmd("highlight default link MaaPipelineTraceMissed WarningMsg")
end

local function current_entry()
  return state.line_entries[vim.api.nvim_win_get_cursor(0)[1]]
end

local function jump_to_node()
  local entry = current_entry()
  if not entry then
    return
  end
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  client:request("workspace/symbol", { query = entry.name }, function(error, symbols)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end
      local exact = vim.tbl_filter(function(item)
        return item.name == entry.name
      end, symbols or {})
      local matches = #exact > 0 and exact or (symbols or {})
      local location = matches[1] and matches[1].location
      if not location then
        vim.notify("No definition found for " .. entry.name, vim.log.levels.WARN)
        return
      end
      local file = vim.uri_to_fname(location.uri)
      vim.cmd("tab drop " .. vim.fn.fnameescape(file))
      vim.api.nvim_win_set_cursor(0, { location.range.start.line + 1, location.range.start.character })
    end)
  end)
end

local function open_reco()
  local entry = current_entry()
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  if not entry or type(entry.lastRecoId) ~= "number" then
    vim.notify("No recognition detail on this line", vim.log.levels.WARN)
    return
  end
  require("maa-pipeline.reco").show(client, entry.lastRecoId)
end

local function rerun_node()
  local entry = current_entry()
  if not entry then
    return
  end
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  client:request("workspace/executeCommand", {
    command = "maa-pipeline.runTask",
    arguments = { client.config.root_dir, entry.name },
  }, function(error)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
      end
    end)
  end)
end

local function sync_screenshot(snapshot)
  local client = current_client()
  if client then
    require("maa-pipeline.screenshot").set_running(client, snapshot and snapshot.running == true)
  end
end

local function refresh()
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  client:request("workspace/executeCommand", {
    command = "maa-pipeline.traceSnapshot",
    arguments = {},
  }, function(error, result)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end
      state.snapshot = result
      sync_screenshot(result)
      M.render()
    end)
  end)
end

local legend = {
  "Legend:",
  "  hit    node matched and executed",
  "  run    node currently running",
  "  fail   node failed",
  "  miss   node finished without ever matching",
  "  [JumpBack] after the status token: the subtree returns to the parent",
  "  node when it ends",
  "  [Anchor:x] after the status token: matched through the anchor alias x",
  "  metric columns: action, executions, recognition attempts, and the total",
  "  duration",
}

local function ensure_buffer()
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
    keymap.setup("trace", buffer, {
      jump = jump_to_node,
      reco = open_reco,
      rerun = rerun_node,
      refresh = refresh,
      close = function()
        pcall(vim.cmd, "close")
      end,
      help = M.toggle_help,
    })
  end
  configure_highlights()
  return buffer
end

local function render_snapshot(lines)
  local snapshot = state.snapshot

  local function add(line, entry)
    table.insert(lines, line)
    state.line_entries[#lines] = entry
  end

  if not snapshot then
    add("No Maa task traced yet; run a task and press " .. keymap.get("trace", "refresh") .. " to refresh", nil)
  else
    add(string.format("Task: %s (%s)", snapshot.task or "?", snapshot.running and "running" or "finished"), nil)
    add("", nil)
    local col = METRICS_COL
    local prefixes = {}
    for i, entry in ipairs(snapshot.entries or {}) do
      local prefix = string.format("%s[%-4s]", ("  "):rep(entry.depth or 0), STATUS_TOKEN[entry.status] or "?")
      if entry.jumpBack == true then
        prefix = prefix .. " [JumpBack]"
      end
      if type(entry.anchor) == "string" then
        prefix = prefix .. " [Anchor:" .. entry.anchor .. "]"
      end
      prefixes[i] = prefix
      col = math.max(col, #prefix + 1 + #entry.name)
    end
    add(
      format_row(col, "[    ]", "NODE", {
        metric_cell("ACTION", 11),
        metric_cell("RUNS", 5),
        metric_cell("TRY", 5),
        metric_cell("TIME", 7),
      }),
      nil
    )
    local fold_rows = {}
    local fold_depths = {}
    for i, entry in ipairs(snapshot.entries or {}) do
      add(
        format_row(col, prefixes[i], entry.name, {
          metric_cell(type(entry.action) == "string" and entry.action or "", 11),
          metric_cell(entry.executions > 0 and tostring(entry.executions) or "", 5),
          metric_cell(entry.attempts > 0 and tostring(entry.attempts) or "", 5),
          metric_cell(fmt_duration(entry.durationMs), 7),
        }),
        entry
      )
      table.insert(fold_rows, #lines)
      table.insert(fold_depths, entry.depth or 0)
    end
    for i, row in ipairs(fold_rows) do
      local depth = fold_depths[i]
      local deeper = i < #fold_rows and fold_depths[i + 1] > depth
      state.fold_levels[row] = deeper and (">" .. (depth + 1)) or tostring(depth)
    end
  end
end

function M.toggle_help()
  state.help = not state.help
  M.render()
end

function M.foldexpr(lnum)
  return state.fold_levels[lnum] or "0"
end

local function apply_folds(buffer)
  for _, win in ipairs(vim.fn.win_findbuf(buffer)) do
    if state.help then
      vim.wo[win].foldmethod = "manual"
    elseif vim.wo[win].foldmethod ~= "expr" then
      vim.wo[win].foldexpr = "v:lua.require'maa-pipeline.trace'.foldexpr(v:lnum)"
      vim.wo[win].foldmethod = "expr"
      vim.wo[win].foldlevel = 99
    end
  end
end

function M.render()
  local buffer = ensure_buffer()
  local lines = {}
  state.line_entries = {}
  state.fold_levels = {}

  if state.help then
    lines = help.lines("Maa pipeline trace", "trace", { legend })
  else
    render_snapshot(lines)
  end

  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  apply_folds(buffer)
  if not state.help then
    for row, entry in pairs(state.line_entries) do
      if status_hl[entry.status] then
        local indent = (entry.depth or 0) * 2
        vim.api.nvim_buf_add_highlight(buffer, namespace, status_hl[entry.status], row - 1, indent, indent + 6)
      end
    end
  end
  return buffer
end

function M.update(client_id, snapshot)
  state.client_id = client_id
  state.snapshot = snapshot
  sync_screenshot(snapshot)
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer >= 0 and vim.fn.bufwinid(buffer) >= 0 and not state.help then
    M.render()
  end
end

function M.show(client_id)
  state.client_id = client_id
  local buffer = ensure_buffer()
  if state.snapshot ~= nil then
    M.render()
  end
  local windows = vim.api.nvim_list_wins()
  for _, win in ipairs(windows) do
    if vim.api.nvim_win_get_buf(win) == buffer then
      vim.api.nvim_set_current_win(win)
      refresh()
      return
    end
  end
  vim.cmd("tabnew")
  vim.api.nvim_set_current_buf(buffer)
  apply_folds(buffer)
  require("maa-pipeline.log").show(client_id)
  local win = vim.fn.bufwinid(buffer)
  if win >= 0 then
    vim.api.nvim_set_current_win(win)
  end
  refresh()
end

return M
