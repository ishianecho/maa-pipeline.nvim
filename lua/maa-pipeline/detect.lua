local M = {}

--- find maa root from a path
--- @param path string
function M.get_maa_root(path)
  local found = vim.fs.find({ "interface.json", "interface.jsonc" }, {
    path = path,
    upward = true,
    type = "file",
  })
  if #found > 0 then
    return vim.fs.dirname(found[1])
  end
  return nil
end

--- find maa root from a buffer (or else from cwd)
--- @param bufnr number
function M.get_buffer_maa_root(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr or 0)
  if name == "" then
    return M.get_maa_root(vim.fn.getcwd())
  end
  return M.get_maa_root(vim.fs.dirname(name))
end

function M.is_pipeline_file(name)
  if not name or name == "" then
    return false
  end
  local normalized = name:gsub("\\", "/")
  if not normalized:match("%.jsonc?$") then
    return false
  end
  local base = vim.fs.basename(normalized)
  if base == "interface.json" or base == "interface.jsonc" or base == "default_pipeline.json" then
    return true
  end
  if normalized:match("/pipeline/[^/]+%.jsonc?$") or normalized:match("/tasks/[^/]+%.jsonc?$") then
    return true
  end
  return M.get_maa_root(vim.fs.dirname(normalized)) ~= nil
end

function M.autoset(bufnr)
  bufnr = bufnr or 0
  local name = vim.api.nvim_buf_get_name(bufnr)
  if M.is_pipeline_file(name) then
    vim.b[bufnr].maa_pipeline = true
    return true
  end
  return false
end

return M
