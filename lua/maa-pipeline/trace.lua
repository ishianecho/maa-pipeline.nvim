local M = {}

local buffer_name = "maa-pipeline://trace"
local namespace = vim.api.nvim_create_namespace("maa_pipeline_trace")

local state = {
  client_id = nil,
  snapshot = nil,
  line_entries = {},
}

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

local function configure_highlights()
  vim.cmd("highlight default link MaaPipelineTraceSucceeded String")
  vim.cmd("highlight default link MaaPipelineTraceFailed ErrorMsg")
  vim.cmd("highlight default link MaaPipelineTraceRunning MoreMsg")
  vim.cmd("highlight default link MaaPipelineTraceMissed WarningMsg")
  vim.cmd("highlight default link MaaPipelineTracePending Comment")
end

local function current_entry()
  return state.line_entries[vim.api.nvim_win_get_cursor(0)[1]]
end

local function request_snapshot(client, callback)
  client:request("workspace/executeCommand", {
    command = "maa-pipeline.traceSnapshot",
    arguments = {},
  }, function(error, result)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end
      callback(result)
    end)
  end)
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
  if not entry or entry.lastRecoId == nil then
    vim.notify("No recognition detail on this line", vim.log.levels.WARN)
    return
  end
  require("maa-pipeline.reco").show(client, entry.lastRecoId)
end

local function refresh()
  local client = current_client()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  request_snapshot(client, function(result)
    state.snapshot = result
    M.render()
  end)
end

local function ensure_buffer()
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
    vim.keymap.set("n", "<CR>", jump_to_node, {
      buffer = buffer,
      silent = true,
      desc = "Maa trace: jump to node definition",
    })
    vim.keymap.set("n", "<Tab>", open_reco, {
      buffer = buffer,
      silent = true,
      desc = "Maa trace: open recognition detail",
    })
    vim.keymap.set("n", "r", refresh, {
      buffer = buffer,
      silent = true,
      desc = "Maa trace: refresh",
    })
    vim.keymap.set("n", "q", function()
      pcall(vim.cmd, "close")
    end, {
      buffer = buffer,
      silent = true,
      desc = "Maa trace: close",
    })
  end
  configure_highlights()
  return buffer
end

function M.render()
  local buffer = ensure_buffer()
  local snapshot = state.snapshot
  local lines = {}
  state.line_entries = {}

  local function add(line, entry)
    table.insert(lines, line)
    state.line_entries[#lines] = entry
  end

  if not snapshot then
    add("No Maa task traced yet; run a task and press r to refresh", nil)
  else
    add(
      string.format(
        "Task: %s (%s)",
        snapshot.task or "?",
        snapshot.running and "running" or "finished"
      ),
      nil
    )
    add("", nil)
    for _, entry in ipairs(snapshot.entries or {}) do
      local metrics = {}
      if entry.executions > 0 then
        table.insert(metrics, string.format("runs=%d", entry.executions))
      end
      if entry.hits > 0 then
        table.insert(metrics, string.format("hit=%d", entry.hits))
      end
      if entry.attempts > 0 then
        table.insert(metrics, string.format("try=%d", entry.attempts))
      end
      local duration = fmt_duration(entry.durationMs)
      if duration ~= "" then
        table.insert(metrics, duration)
      end
      add(
        string.format("[%-4s] %-40s %s", STATUS_TOKEN[entry.status] or "?", entry.name, table.concat(metrics, " ")),
        entry
      )
    end
    if #(snapshot.notExecuted or {}) > 0 then
      add("", nil)
      add("not executed:", nil)
      for _, name in ipairs(snapshot.notExecuted) do
        add("  " .. name, { name = name, status = "not-executed" })
      end
    end
  end

  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
  for row, entry in pairs(state.line_entries) do
    if status_hl[entry.status] then
      vim.api.nvim_buf_add_highlight(buffer, namespace, status_hl[entry.status], row - 1, 0, 7)
    elseif entry.status == "not-executed" then
      vim.api.nvim_buf_add_highlight(buffer, namespace, "MaaPipelineTracePending", row - 1, 2, -1)
    end
  end
  return buffer
end

function M.update(client_id, snapshot)
  state.client_id = client_id
  state.snapshot = snapshot
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer >= 0 and vim.fn.bufwinid(buffer) >= 0 then
    M.render()
  end
end

function M.show(client_id)
  state.client_id = client_id
  local buffer = ensure_buffer()
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
  require("maa-pipeline.log").show(client_id)
  local win = vim.fn.bufwinid(buffer)
  if win >= 0 then
    vim.api.nvim_set_current_win(win)
  end
  refresh()
end

return M
