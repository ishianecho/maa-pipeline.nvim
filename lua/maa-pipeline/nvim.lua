local M = {}

local client = require("maa-pipeline.client")
local detect = require("maa-pipeline.detect")
local cmds = require("maa-pipeline.cmds")
local hotkey = require("maa-pipeline.hotkey")
local autocmd = require("maa-pipeline.autocmd")

function M.setup(options)
  if not vim.lsp.config then
    error("maa-pipeline.nvim requires Neovim 0.11 or newer")
  end

  options = options or {}
  autocmd.setup(client.start)
  detect.autoset(0)
  vim.lsp.config("maa_pipeline", {
    init_options = {
      mode = options.mode,
      locale = options.locale,
      runtime = options.runtime,
    },
  })
  if options.log then
    local log = require("maa-pipeline.log")
    if options.log.render ~= nil then
      log.use(options.log.render)
    end
    if options.log.key ~= nil then
      require("maa-pipeline.keymap").set("log", options.log.key)
    end
  end
  if options.trace and options.trace.key ~= nil then
    require("maa-pipeline.keymap").set("trace", options.trace.key)
  end
  if options.options and options.options.key ~= nil then
    require("maa-pipeline.keymap").set("options", options.options.key)
  end
  if vim.v.vim_did_enter == 1 then
    client.start()
  end
  if options.stop_hotkey then
    if jit.os == "Windows" then
      local registered = hotkey.register(options.stop_hotkey, cmds.stop_run)
      if not registered then
        vim.schedule(function()
          vim.notify("Failed to register MaaPipelineStop hotkey: " .. options.stop_hotkey, vim.log.levels.WARN)
        end)
      end
    end
  elseif jit.os == "Windows" then
    vim.schedule(function()
      vim.notify(
        'MaaPipelineStop hotkey is disabled; set setup({ stop_hotkey = "Ctrl+Alt+S" }) to enable it',
        vim.log.levels.INFO
      )
    end)
  end
  cmds.setup()
end

return M
