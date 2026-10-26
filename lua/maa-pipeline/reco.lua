local M = {}

local namespace = vim.api.nvim_create_namespace("maa_pipeline_reco")

local function decode_png(data_url)
  if type(data_url) ~= "string" then
    return nil
  end
  local marker = "base64,"
  local index = data_url:find(marker, 1, true)
  if not index then
    return nil
  end
  local ok, data = pcall(vim.base64.decode, data_url:sub(index + #marker))
  return ok and data or nil
end

local function write_png(file, data)
  local uv = vim.uv
  local ok, fd = pcall(uv.fs_open, file, "w", 438)
  if not ok or not fd then
    return false
  end
  uv.fs_write(fd, data, -1)
  uv.fs_close(fd)
  return true
end

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
  table.insert(lines, string.format("%s  %s  %s", info.name or "?", info.hit and "HIT" or "MISS", info.algorithm or "?"))
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
      table.insert(lines, string.format("  %s  %s  %s", child.hit and "hit " or "miss", child.name or "?", child.algorithm or "?"))
    end
  end
  return lines
end

local function show_detail(reco_id, result, images)
  local info = result.info or {}
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, "maa-pipeline://reco:" .. reco_id)
  local lines = detail_lines(info)
  for _, file in ipairs(images) do
    table.insert(lines, "image: " .. file)
  end
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].bufhidden = "hide"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].filetype = "log"

  for index, file in ipairs(images) do
    if index > 1 then
      vim.cmd("vsplit")
    end
    vim.cmd("edit " .. vim.fn.fnameescape(file))
  end
  if #images > 0 then
    vim.cmd("vsplit")
  end
  vim.api.nvim_set_current_buf(buffer)

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
      local directory = vim.fn.stdpath("data") .. "/maa-pipeline.nvim/reco"
      vim.fn.mkdir(directory, "p")
      local images = {}
      local raw = decode_png(result.raw)
      if raw and #raw > 0 then
        local file = directory .. "/" .. reco_id .. ".png"
        if write_png(file, raw) then
          table.insert(images, file)
        end
      end
      for index, draw in ipairs(list(result.draws)) do
        local data = decode_png(draw)
        if data and #data > 0 then
          local file = directory .. "/" .. reco_id .. "-" .. index .. ".png"
          if write_png(file, data) then
            table.insert(images, file)
          end
        end
      end
      vim.cmd("tabnew")
      show_detail(reco_id, result, images)
    end)
  end)
end

return M
