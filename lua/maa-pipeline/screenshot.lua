local M = {}

local image = require("maa-pipeline.image")

local trace_buffer_name = "maa-pipeline://trace"
local log_buffer_name = "maa-pipeline://runtime"
local buffer_name = "maa-pipeline://screenshot"
local INTERVAL = 1000

local warned = false
local state = {
  client = nil,
  win = nil,
  timer = nil,
  running = false,
  fetching = false,
}

local function fetch()
  if state.fetching or not (state.win and vim.api.nvim_win_is_valid(state.win)) then
    return
  end
  state.fetching = true
  local client = state.client
  local win = state.win
  client:request("workspace/executeCommand", {
    command = "maa-pipeline.screencap",
    arguments = { client.config.root_dir },
  }, function(error, result)
    vim.schedule(function()
      state.fetching = false
      if error or type(result) ~= "string" or not vim.api.nvim_win_is_valid(win) then
        return
      end
      local decoded = image.decode(result)
      if decoded then
        image.attach(win, decoded)
      end
    end)
  end)
end

local function stop()
  state.running = false
  if state.timer then
    state.timer:stop()
    state.timer:close()
    state.timer = nil
  end
end

local function ensure_window(base_win)
  if state.win and vim.api.nvim_win_is_valid(state.win) then
    if vim.api.nvim_win_get_tabpage(state.win) == vim.api.nvim_win_get_tabpage(base_win) then
      return true
    end
    return false
  end
  if not image.supported() then
    if not warned then
      warned = true
      vim.notify("Terminal has no image support; live screenshot disabled", vim.log.levels.WARN)
    end
    return false
  end
  local buffer = vim.fn.bufnr(buffer_name)
  if buffer < 0 then
    buffer = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buffer, buffer_name)
    vim.bo[buffer].buftype = "nofile"
    vim.bo[buffer].bufhidden = "hide"
    vim.bo[buffer].swapfile = false
  end
  local base_width = vim.api.nvim_win_get_width(base_win)
  local ok, win = pcall(vim.api.nvim_open_win, buffer, false, {
    win = base_win,
    vertical = true,
    split = "right",
  })
  if not ok then
    return false
  end
  pcall(vim.api.nvim_win_set_width, win, math.max(math.floor(base_width * 0.45), 16))
  vim.wo[win].number = false
  vim.wo[win].relativenumber = false
  vim.wo[win].signcolumn = "no"
  vim.wo[win].foldcolumn = "0"
  vim.wo[win].wrap = false
  state.win = win
  return true
end

local function trace_log_window()
  local trace_win = vim.fn.win_findbuf(vim.fn.bufnr(trace_buffer_name))[1]
  if not trace_win then
    return nil
  end
  local tabpage = vim.api.nvim_win_get_tabpage(trace_win)
  for _, win in ipairs(vim.fn.win_findbuf(vim.fn.bufnr(log_buffer_name))) do
    if vim.api.nvim_win_get_tabpage(win) == tabpage then
      return win
    end
  end
  return nil
end

function M.set_running(client, running)
  if not running then
    stop()
    return
  end
  state.client = client
  local base_win = trace_log_window()
  if not base_win or not ensure_window(base_win) then
    stop()
    return
  end
  if not state.running then
    state.running = true
    state.timer = vim.uv.new_timer()
    state.timer:start(0, INTERVAL, vim.schedule_wrap(fetch))
  end
end

return M
