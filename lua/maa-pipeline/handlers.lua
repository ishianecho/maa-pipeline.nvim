local methods = {
  trigger_completion = "maa-pipeline/triggerCompletion",
  show_references = "maa-pipeline/showReferences",
  show_text = "maa-pipeline/showText",
  runtime_log = "maa-pipeline/runtimeLog",
  configure_controller = "maa-pipeline/configureController",
  save_screenshot = "maa-pipeline/saveScreenshot",
  request_input = "maa-pipeline/requestInput",
  trace = "maa-pipeline/trace",
}

local log = require("maa-pipeline.log")
local api = require("maa-pipeline.client")

local function flush_workspace_edit(edit)
  local uris = {}
  for uri in pairs(edit.changes or {}) do
    uris[uri] = true
  end
  for _, change in ipairs(edit.documentChanges or {}) do
    if change.textDocument then
      uris[change.textDocument.uri] = true
    end
    if change.uri then
      uris[change.uri] = true
    end
  end
  vim.schedule(function()
    for uri in pairs(uris) do
      local buffer = vim.fn.bufnr(vim.uri_to_fname(uri))
      if
        buffer > 0
        and vim.api.nvim_buf_is_loaded(buffer)
        and #vim.fn.win_findbuf(buffer) == 0
        and vim.bo[buffer].modified
      then
        vim.api.nvim_buf_call(buffer, function()
          vim.cmd("silent! noautocmd write")
        end)
      end
    end
  end)
end

return {
  ["workspace/applyEdit"] = function(err, result, ctx)
    local response = vim.lsp.handlers["workspace/applyEdit"](err, result, ctx)
    if result and result.edit and response and response.applied then
      flush_workspace_edit(result.edit)
    end
    return response
  end,
  [methods.configure_controller] = function(_, result, ctx)
    vim.schedule(function()
      local client = vim.lsp.get_client_by_id(ctx.client_id)
      if not client then
        return
      end
      require("maa-pipeline.controller").select(client, result.root, result.controller, function()
        if not result.task then
          return
        end
        if result.interface then
          require("maa-pipeline.task").run(client, result.root, result.task, result.selections)
        else
          api.request(client, "maa-pipeline.runTask", { result.root, result.task })
        end
      end)
    end)
  end,
  [methods.save_screenshot] = function(_, result, ctx)
    vim.schedule(function()
      if result.roi then
        vim.fn.setreg("+", result.roi)
      end
      if not result.image then
        vim.notify("ROI copied to clipboard; no cropped image was saved")
        return
      end

      vim.ui.input({ prompt = "Input image name: ", cancelreturn = nil }, function(name)
        local client = vim.lsp.get_client_by_id(ctx.client_id)
        if not client then
          return
        end
        if not name or name == "" then
          api.request(client, "maa-pipeline.cancelScreenshot", { result.root, result.token })
          return
        end
        api.request(client, "maa-pipeline.saveScreenshot", { result.root, result.token, name }, function(saved)
          if saved then
            vim.notify("Screenshot saved: " .. saved.path)
          end
        end)
      end)
    end)
  end,
  [methods.trigger_completion] = function()
    vim.schedule(function()
      if vim.lsp.completion and vim.lsp.completion.get then
        vim.lsp.completion.get()
      else
        vim.api.nvim_feedkeys(vim.keycode("<C-x><C-o>"), "n", false)
      end
    end)
  end,
  [methods.show_references] = function(_, result, ctx)
    vim.schedule(function()
      local client = vim.lsp.get_client_by_id(ctx.client_id)
      local encoding = client and client.offset_encoding or "utf-16"
      local items = vim.lsp.util.locations_to_items(result.locations or {}, encoding)
      vim.fn.setqflist({}, " ", { title = "Maa pipeline references", items = items })
      vim.cmd.copen()
    end)
  end,
  [methods.show_text] = function(_, result)
    vim.schedule(function()
      local buffer = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_name(buffer, "maa-pipeline://" .. (result.title or "preview"))
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(result.content or "", "\n", { plain = true }))
      vim.bo[buffer].filetype = "jsonc"
      vim.bo[buffer].modifiable = false
      vim.api.nvim_set_current_buf(buffer)
    end)
  end,
  [methods.runtime_log] = function(_, result, ctx)
    log.append(ctx.client_id, result)
    local entry = result.entry
    if entry and entry.family == "Task" and entry.phase == "Starting" then
      vim.schedule(function()
        require("maa-pipeline.trace").show(ctx.client_id)
      end)
    end
  end,
  [methods.trace] = function(_, result, ctx)
    require("maa-pipeline.trace").update(ctx.client_id, result)
  end,
  [methods.request_input] = function(_, result, ctx)
    vim.schedule(function()
      vim.ui.input({ prompt = (result.title or "Value") .. ": " }, function(value)
        if not value or value == "" then
          return
        end
        local client = vim.lsp.get_client_by_id(ctx.client_id)
        if client then
          api.request(client, result.command, vim.list_extend(vim.deepcopy(result.arguments or {}), { value }))
        end
      end)
    end)
  end,
}
