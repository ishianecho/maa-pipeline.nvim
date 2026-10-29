local M = {}

local detect = require("maa-pipeline.detect")

local cached_root

function M.root()
  local root = detect.get_buffer_maa_root(0)
  if not root then
    return cached_root
  end
  if cached_root == nil then
    cached_root = root
  end
  return root
end

function M.get()
  local clients = vim.lsp.get_clients({ name = "maa_pipeline", bufnr = 0 })
  local client = clients[1]
  if not client then
    local client_id = vim.b.maa_pipeline_client_id
    client = client_id and vim.lsp.get_client_by_id(client_id) or nil
  end
  if not client then
    local root = M.root()
    for _, candidate in ipairs(vim.lsp.get_clients({ name = "maa_pipeline" })) do
      if candidate.root_dir == root then
        client = candidate
        break
      end
    end
    client = client or vim.lsp.get_clients({ name = "maa_pipeline" })[1]
  end
  return client
end

function M.start()
  local root = detect.get_maa_root(vim.fn.getcwd())
  if not root then
    return
  end
  local config = vim.lsp.config["maa_pipeline"]
  if not config then
    return
  end
  config = vim.tbl_extend("force", config, { root_dir = root })
  vim.lsp.start(config, { attach = false, silent = true })
end

function M.request(client, command, arguments, on_result)
  client:request("workspace/executeCommand", {
    command = command,
    arguments = arguments,
  }, function(error, result)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end
      if on_result then
        on_result(result)
      end
    end)
  end)
end

return M
