local M = {}

local function exists(path)
  return vim.uv.fs_stat(path) ~= nil
end

function M.project_root(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr or 0)
  if name == "" then
    return vim.fn.getcwd()
  end
  local found = vim.fs.find({ "interface.json", "interface.jsonc" }, {
    path = vim.fs.dirname(name),
    upward = true,
    type = "file",
  })
  if #found > 0 then
    return vim.fs.dirname(found[1])
  end
  return vim.fs.dirname(name)
end

function M.is_maa_project(root)
  return exists(root .. "/src/MaaCore") or (exists(root .. "/tasks") and exists(root .. "/template"))
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
  local found = vim.fs.find({ "interface.json", "interface.jsonc" }, {
    path = vim.fs.dirname(name),
    upward = true,
    type = "file",
  })
  return #found > 0
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

function M.setup_autoset(group)
  group = group or vim.api.nvim_create_augroup("MaaPipelineFiletype", { clear = true })
  vim.api.nvim_create_autocmd({ "BufRead", "BufNewFile" }, {
    group = group,
    pattern = "*.json,*.jsonc",
    callback = function(args)
      M.autoset(args.buf)
    end,
  })
end

return M
