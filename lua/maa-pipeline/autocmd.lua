local M = {}

function M.group(name)
  local id = vim.api.nvim_create_augroup(name, { clear = true })
  return function(event, spec)
    return vim.api.nvim_create_autocmd(event, vim.tbl_extend("force", spec, { group = id }))
  end
end

function M.setup(start_client)
  local detect = require("maa-pipeline.detect")
  local hotkey = require("maa-pipeline.hotkey")
  local image = require("maa-pipeline.image")

  local autocmd = M.group("MaaPipeline")
  -- detect
  autocmd({ "BufRead", "BufNewFile" }, {
    pattern = "*.json,*.jsonc",
    callback = function(args)
      detect.autoset(args.buf)
    end,
  })
  -- client
  if vim.v.vim_did_enter == 0 then
    autocmd("VimEnter", { once = true, callback = start_client })
  end
  autocmd("DirChanged", { callback = start_client })
  -- hotkey
  autocmd("VimLeavePre", {
    callback = function()
      hotkey.unregister()
    end,
  })
  -- image
  autocmd("WinClosed", {
    callback = function(args)
      image.detach(tonumber(args.match))
    end,
  })
  autocmd({ "WinResized", "VimResized" }, {
    callback = function(args)
      image.resized(args.event == "WinResized" and vim.v.event.windows or nil)
    end,
  })
  autocmd("TabEnter", {
    callback = function()
      image.tab_enter()
    end,
  })
end

return M
