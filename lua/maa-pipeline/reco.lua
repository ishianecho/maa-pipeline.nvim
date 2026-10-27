local M = {}

local namespace = vim.api.nvim_create_namespace("maa_pipeline_reco")
local group = vim.api.nvim_create_augroup("MaaPipelineReco", { clear = true })

local CELL_WIDTH = 10
local CELL_HEIGHT = 20

local placements = {}
local support = nil

local function decode_image(data_url)
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

vim.api.nvim_create_autocmd("WinClosed", {
  group = group,
  callback = function(args)
    local win = tonumber(args.match)
    local entry = placements[win]
    if entry then
      placements[win] = nil
      if entry.shown then
        vim.ui.img.del(entry.id)
      end
    end
  end,
})
vim.api.nvim_create_autocmd({ "WinResized", "VimResized" }, {
  group = group,
  callback = function(args)
    local wins = args.event == "WinResized" and vim.v.event.windows or vim.tbl_keys(placements)
    for _, win in ipairs(wins) do
      if placements[win] then
        place(win)
      end
    end
  end,
})
vim.api.nvim_create_autocmd("TabEnter", {
  group = group,
  callback = function()
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
  end,
})

local function list(value)
  if type(value) ~= "table" then
    return {}
  end
  return value
end

local function fmt_box(value)
  if type(value) ~= "table" then
    return nil
  end
  return "[" .. table.concat(value, ",") .. "]"
end

local function fmt_reco_entry(item)
  local parts = {}
  local box = fmt_box(item.box)
  if box then
    table.insert(parts, "box=" .. box)
  end
  for _, key in ipairs({ "score", "text", "count", "label", "cls_index" }) do
    if item[key] ~= nil and item[key] ~= vim.NIL then
      table.insert(parts, key .. "=" .. tostring(item[key]))
    end
  end
  return table.concat(parts, " ")
end

local function detail_lines(info)
  local lines = {}
  table.insert(
    lines,
    string.format("%s  %s  %s", info.name or "?", info.hit and "HIT" or "MISS", info.algorithm or "?")
  )
  local box = fmt_box(info.box)
  if box then
    table.insert(lines, "box=" .. box)
  end
  local detail = info.detail
  if type(detail) == "table" and detail.best ~= nil then
    local best = detail.best ~= vim.NIL and fmt_reco_entry(detail.best) or "none"
    table.insert(lines, "best: " .. best)
    table.insert(lines, string.format("all=%d filtered=%d", #list(detail.all), #list(detail.filtered)))
  elseif type(detail) == "table" and #detail > 0 then
    table.insert(lines, "nested:")
    for index, child in ipairs(detail) do
      if index > 8 then
        table.insert(lines, string.format("  ... %d more", #detail - 8))
        break
      end
      table.insert(
        lines,
        string.format("  %s  %s  %s", child.hit and "hit " or "miss", child.name or "?", child.algorithm or "?")
      )
    end
  end
  return lines
end

local function map_quit(buffer)
  vim.keymap.set("n", "q", function()
    pcall(vim.cmd, "tabclose")
  end, {
    buffer = buffer,
    silent = true,
    desc = "Maa reco: close the detail tab",
  })
end

local function show_detail(reco_id, info, images)
  if support == nil then
    support = false
    if vim.ui and vim.ui.img then
      local ok, supported = pcall(vim.ui.img._supported)
      support = ok and supported == true
    end
  end
  local had_images = #images > 0
  if had_images and not support then
    images = {}
    vim.notify("Terminal has no image support; showing recognition details only", vim.log.levels.WARN)
  end
  local name = "maa-pipeline://reco:" .. reco_id
  local existing = vim.fn.bufnr(name)
  if existing >= 0 then
    local win = vim.fn.bufwinid(existing)
    if win >= 0 then
      vim.api.nvim_set_current_win(win)
      return
    end
    vim.api.nvim_buf_delete(existing, { force = true })
  end
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, name)
  local lines = detail_lines(info)
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].bufhidden = "wipe"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].filetype = "log"
  map_quit(buffer)

  vim.cmd("tabnew")
  local windows = {}
  if #images > 0 then
    local info_win = vim.api.nvim_get_current_win()
    vim.cmd("vsplit")
    for index, _ in ipairs(images) do
      if index > 1 then
        vim.cmd("split")
      end
      local placeholder = vim.api.nvim_create_buf(false, true)
      vim.bo[placeholder].buftype = "nofile"
      vim.bo[placeholder].bufhidden = "wipe"
      vim.bo[placeholder].swapfile = false
      local win = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(win, placeholder)
      vim.wo[win].number = false
      vim.wo[win].relativenumber = false
      vim.wo[win].signcolumn = "no"
      vim.wo[win].foldcolumn = "0"
      map_quit(placeholder)
      table.insert(windows, win)
    end
    vim.api.nvim_set_current_win(info_win)
  end
  vim.api.nvim_set_current_buf(buffer)
  for index, image in ipairs(images) do
    placements[windows[index]] = {
      data = image.data,
      width = image.width,
      height = image.height,
      id = nil,
      shown = false,
    }
    place(windows[index])
  end

  local status = info.hit and "HIT" or "MISS"
  local offset = select(2, lines[1]:find(info.name or "?", 1, true))
  local start = offset and lines[1]:find(status, offset + 1, true)
  if start then
    vim.api.nvim_buf_add_highlight(
      buffer,
      namespace,
      info.hit and "MaaPipelineRecoHit" or "MaaPipelineRecoMiss",
      0,
      start - 1,
      start - 1 + #status
    )
  end
  vim.cmd("highlight default link MaaPipelineRecoHit String")
  vim.cmd("highlight default link MaaPipelineRecoMiss ErrorMsg")
  if had_images and #images == 0 then
    return
  end
  if #images == 0 then
    vim.notify("No screenshots retained for reco " .. reco_id .. "; the Maa instance may be gone", vim.log.levels.WARN)
  end
end

function M.show(client, reco_id)
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  client:request("workspace/executeCommand", {
    command = "maa-pipeline.recoDetail",
    arguments = { reco_id },
  }, function(error, result)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end
      local images = {}
      for _, image in ipairs(list(result.images)) do
        local decoded = decode_image(image)
        if decoded then
          table.insert(images, decoded)
        end
      end
      show_detail(reco_id, result.info or {}, images)
    end)
  end)
end

return M
