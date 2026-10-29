local M = {}

local detect = require("maa-pipeline.detect")
local api = require("maa-pipeline.client")
local controller = require("maa-pipeline.controller")

local function run_node(client)
  local params = vim.lsp.util.make_range_params(0, client.offset_encoding)
  params.context = { diagnostics = {} }
  client:request("textDocument/codeAction", params, function(error, actions)
    vim.schedule(function()
      if error then
        vim.notify(error.message or tostring(error), vim.log.levels.ERROR)
        return
      end

      local run_actions = vim.tbl_filter(function(action)
        return action.title and action.title:match("^Run Maa task: ") ~= nil
      end, actions or {})
      local action = run_actions[1]
      if not action then
        vim.notify("No Maa task at cursor", vim.log.levels.WARN)
        return
      end

      api.request(client, action.command.command, action.command.arguments)
    end)
  end)
end

local function run_pick_node(client)
  local root = detect.get_buffer_maa_root(0)
  local file = vim.api.nvim_buf_get_name(0)
  if not root then
    vim.notify("No Maa project found for the current buffer", vim.log.levels.WARN)
    return
  end
  if file == "" then
    vim.notify("The current buffer has no file", vim.log.levels.WARN)
    return
  end
  api.request(client, "maa-pipeline.listTasks", { root, file }, function(tasks)
    local names = {}
    for _, name in ipairs(tasks or {}) do
      if type(name) == "string" and not vim.tbl_contains(names, name) then
        table.insert(names, name)
      end
    end
    table.sort(names)
    if #names == 0 then
      vim.notify("No Maa tasks found in this file", vim.log.levels.WARN)
      return
    end
    vim.ui.select(names, { prompt = "Maa task: " }, function(choice)
      if choice then
        api.request(client, "maa-pipeline.runTask", { root, choice })
      end
    end)
  end)
end

local function run_task(client)
  local root = detect.get_buffer_maa_root(0)
  if not root then
    vim.notify("No Maa project found for the current buffer", vim.log.levels.WARN)
    return
  end
  api.request(client, "maa-pipeline.interfaceTasks", { root }, function(tasks)
    if not tasks or #tasks == 0 then
      vim.notify("No tasks declared in interface.json", vim.log.levels.WARN)
      return
    end
    vim.ui.select(tasks, {
      prompt = "Maa interface task: ",
      format_item = function(task)
        return task.label ~= "" and task.label or task.name
      end,
    }, function(choice)
      if not choice then
        return
      end
      require("maa-pipeline.task").run(client, root, choice.name)
    end)
  end)
end

function M.stop_run()
  local client = api.get()
  if not client then
    vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
    return
  end
  api.request(client, "maa-pipeline.stopTask", {})
end

function M.setup()
  local function with_client(callback)
    local client = api.get()
    if not client then
      vim.notify("maa_pipeline is not running", vim.log.levels.WARN)
      return
    end
    callback(client)
  end

  local function with_root(callback)
    with_client(function(client)
      local root = detect.get_buffer_maa_root(0)
      if not root then
        vim.notify("No Maa project found for the current buffer", vim.log.levels.WARN)
        return
      end
      callback(client, root)
    end)
  end

  local function usercmd(name, command, opts)
    opts = opts or {}
    opts.force = true
    vim.api.nvim_create_user_command(name, command, opts)
  end

  usercmd("MaaPipelineSelectController", function()
    with_root(function(client, root)
      controller.select(client, root)
    end)
  end, { desc = "Select and configure a Maa controller" })
  usercmd("MaaPipelineStop", M.stop_run, { desc = "Stop the running Maa task" })
  usercmd("MaaPipelineRun", function()
    with_client(run_node)
  end, { desc = "Run the Maa task at the cursor" })
  usercmd("MaaPipelinePickRun", function()
    with_client(run_pick_node)
  end, { desc = "Pick a Maa task and run it" })
  usercmd("MaaPipelineTaskRun", function()
    with_client(run_task)
  end, { desc = "Pick an interface.json task, confirm its options, and run it" })
  usercmd("MaaPipelineTrace", function()
    with_client(function(client)
      require("maa-pipeline.trace").show(client.id)
    end)
  end, { desc = "Open the Maa node trace view in a tab" })
  usercmd("MaaPipelineVisionClean", function()
    with_client(function(client)
      api.request(client, "maa-pipeline.cleanVision", {})
    end)
  end, { desc = "Delete saved vision screenshots under the runtime data directory" })
  usercmd("MaaPipelineScreenshot", function()
    with_root(function(client, root)
      controller.select(client, root, nil, function()
        api.request(client, "maa-pipeline.takeScreenshot", { root })
      end)
    end)
  end, { desc = "Select a controller, take a screenshot, and copy its ROI" })
  usercmd("MaaPipelineLogFilter", function(args)
    require("maa-pipeline.log").filter(args.args ~= "" and args.args or nil)
  end, { desc = "Filter MaaFramework runtime logs with Lua", nargs = "?" })
  usercmd("MaaPipelineLogExportJson", function()
    require("maa-pipeline.log").export("json")
  end, { desc = "Export filtered MaaFramework runtime logs as JSON" })
  usercmd("MaaPipelineLogExportText", function()
    require("maa-pipeline.log").export("text")
  end, { desc = "Export filtered MaaFramework runtime logs as plain text" })
end

return M
