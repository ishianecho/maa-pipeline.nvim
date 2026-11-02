local M = {}

local CELL_WIDTH = 10
local CELL_HEIGHT = 20

local placements = {}

local function png_size(data)
  if #data < 24 or data:sub(1, 8) ~= "\137PNG\r\n\26\n" then
    return nil
  end
  local b = { data:byte(17, 24) }
  local width = b[1] * 0x1000000 + b[2] * 0x10000 + b[3] * 0x100 + b[4]
  local height = b[5] * 0x1000000 + b[6] * 0x10000 + b[7] * 0x100 + b[8]
  if width <= 0 or height <= 0 then
    return nil
  end
  return width, height
end

local function jpeg_size(data)
  local pos = 3
  while pos + 8 < #data do
    if data:byte(pos) ~= 0xff then
      return nil
    end
    local marker = data:byte(pos + 1)
    if marker >= 0xd0 and marker <= 0xd9 or marker == 0x01 then
      pos = pos + 2
    elseif marker >= 0xc0 and marker <= 0xcf and marker ~= 0xc4 and marker ~= 0xc8 and marker ~= 0xcc then
      local height = data:byte(pos + 5) * 0x100 + data:byte(pos + 6)
      local width = data:byte(pos + 7) * 0x100 + data:byte(pos + 8)
      if width <= 0 or height <= 0 then
        return nil
      end
      return width, height
    else
      pos = pos + 2 + data:byte(pos + 2) * 0x100 + data:byte(pos + 3)
    end
  end
  return nil
end

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
  if not ok or #data < 4 then
    return nil
  end
  local width, height
  if data:byte(1) == 0xff and data:byte(2) == 0xd8 then
    width, height = jpeg_size(data)
  else
    width, height = png_size(data)
  end
  if not width then
    return nil
  end
  return { data_url = data_url, data = data, width = width, height = height }
end

local function geometry(win, width, height)
  local pos = vim.fn.win_screenpos(win)
  local scale = math.min(
    vim.api.nvim_win_get_width(win) * CELL_WIDTH / width,
    vim.api.nvim_win_get_height(win) * CELL_HEIGHT / height,
    1
  )
  return {
    row = pos[1],
    col = pos[2],
    width = math.max(math.floor(width * scale / CELL_WIDTH + 0.5), 1),
    height = math.max(math.floor(height * scale / CELL_HEIGHT + 0.5), 1),
  }
end

M.default_renderer = {
  supported = function()
    if not (vim.ui and vim.ui.img) then
      return false
    end
    local ok, supported = pcall(vim.ui.img._supported)
    return ok and supported == true
  end,
  attach = function(win, decoded)
    local handle = {
      data = decoded.data,
      width = decoded.width,
      height = decoded.height,
      id = vim.ui.img.set(decoded.data, geometry(win, decoded.width, decoded.height)),
    }
    return handle
  end,
  update = function(handle, win)
    local opts = geometry(win, handle.width, handle.height)
    if handle.id then
      vim.ui.img.set(handle.id, opts)
    else
      handle.id = vim.ui.img.set(handle.data, opts)
    end
  end,
  hide = function(handle)
    if handle.id then
      vim.ui.img.del(handle.id)
      handle.id = nil
    end
  end,
  detach = function(handle)
    if handle.id then
      vim.ui.img.del(handle.id)
    end
  end,
}

M.renderer = M.default_renderer

function M.supported()
  local ok, supported = pcall(M.renderer.supported)
  return ok and supported == true
end

function M.attach(win, decoded)
  local previous = placements[win]
  placements[win] = M.renderer.attach(win, decoded)
  if previous then
    M.renderer.detach(previous)
  end
end

function M.detach(win)
  local handle = placements[win]
  if handle then
    placements[win] = nil
    M.renderer.detach(handle)
  end
end

function M.resized(windows)
  local wins = windows or vim.tbl_keys(placements)
  for _, win in ipairs(wins) do
    local handle = placements[win]
    if handle and vim.api.nvim_win_is_valid(win) then
      M.renderer.update(handle, win)
    end
  end
end

function M.tab_enter()
  local tab = vim.api.nvim_get_current_tabpage()
  for win, handle in pairs(placements) do
    if vim.api.nvim_win_is_valid(win) then
      if vim.api.nvim_win_get_tabpage(win) == tab then
        M.renderer.update(handle, win)
      else
        M.renderer.hide(handle)
      end
    end
  end
end

return M
