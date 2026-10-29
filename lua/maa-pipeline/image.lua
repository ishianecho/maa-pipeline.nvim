local M = {}

local CELL_WIDTH = 10
local CELL_HEIGHT = 20

local placements = {}
local support = nil

function M.decode(data_url)
  if type(data_url) ~= "string" then
    return nil
  end
  local marker = "base64,"
  local index = data_url:find(marker, 1, true)
  if not index then
    return nil
  end
  local ok, data = pcall(vim.base64.decode, data_url:sub(index + #marker))
  if not ok or #data < 24 or data:sub(1, 8) ~= "\137PNG\r\n\26\n" then
    return nil
  end
  local b = { data:byte(17, 24) }
  local width = b[1] * 0x1000000 + b[2] * 0x10000 + b[3] * 0x100 + b[4]
  local height = b[5] * 0x1000000 + b[6] * 0x10000 + b[7] * 0x100 + b[8]
  if width <= 0 or height <= 0 then
    return nil
  end
  return { data = data, width = width, height = height }
end

function M.supported()
  if support == nil then
    support = false
    if vim.ui and vim.ui.img then
      local ok, supported = pcall(vim.ui.img._supported)
      support = ok and supported == true
    end
  end
  return support
end

local function place(win)
  local entry = placements[win]
  if not entry then
    return
  end
  local pos = vim.fn.win_screenpos(win)
  local scale = math.min(
    vim.api.nvim_win_get_width(win) * CELL_WIDTH / entry.width,
    vim.api.nvim_win_get_height(win) * CELL_HEIGHT / entry.height,
    1
  )
  local opts = {
    row = pos[1],
    col = pos[2],
    width = math.max(math.floor(entry.width * scale / CELL_WIDTH + 0.5), 1),
    height = math.max(math.floor(entry.height * scale / CELL_HEIGHT + 0.5), 1),
  }
  if entry.shown then
    vim.ui.img.set(entry.id, opts)
  else
    entry.id = vim.ui.img.set(entry.data, opts)
    entry.shown = true
  end
end

function M.attach(win, decoded)
  M.detach(win)
  placements[win] = {
    data = decoded.data,
    width = decoded.width,
    height = decoded.height,
    id = nil,
    shown = false,
  }
  place(win)
end

function M.detach(win)
  local entry = placements[win]
  if entry then
    placements[win] = nil
    if entry.shown then
      vim.ui.img.del(entry.id)
    end
  end
end

function M.resized(windows)
  local wins = windows or vim.tbl_keys(placements)
  for _, win in ipairs(wins) do
    if placements[win] then
      place(win)
    end
  end
end

function M.tab_enter()
  local tab = vim.api.nvim_get_current_tabpage()
  for win, entry in pairs(placements) do
    if vim.api.nvim_win_is_valid(win) then
      if vim.api.nvim_win_get_tabpage(win) == tab then
        place(win)
      elseif entry.shown then
        vim.ui.img.del(entry.id)
        entry.shown = false
      end
    end
  end
end

return M
