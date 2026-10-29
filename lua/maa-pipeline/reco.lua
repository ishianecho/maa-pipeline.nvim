local M = {}

local image = require("maa-pipeline.image")
local highlights = require("maa-pipeline.highlights")
local api = require("maa-pipeline.client")

local namespace = vim.api.nvim_create_namespace("maa_pipeline_reco")

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
  local support = image.supported()
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
  for index, item in ipairs(images) do
    image.attach(windows[index], item)
  end

  local status = info.hit and "HIT" or "MISS"
  local offset = select(2, lines[1]:find(info.name or "?", 1, true))
  local start = offset and lines[1]:find(status, offset + 1, true)
  if start then
    vim.api.nvim_buf_add_highlight(
      buffer,
      namespace,
      info.hit and highlights.reco.hit or highlights.reco.miss,
      0,
      start - 1,
      start - 1 + #status
    )
  end
  highlights.define()
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
  api.request(client, "maa-pipeline.recoDetail", { reco_id }, function(result)
    local images = {}
    for _, item in ipairs(list(result.images)) do
      local decoded = image.decode(item)
      if decoded then
        table.insert(images, decoded)
      end
    end
    show_detail(reco_id, result.info or {}, images)
  end)
end

return M
