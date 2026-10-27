local M = {}

local scopes = {
  log = {
    { name = "click", key = "<CR>", desc = "filter by token under cursor" },
    { name = "filter", key = "f", desc = "prompt for a Lua filter expression" },
    { name = "help", key = "g?", desc = "toggle the help view" },
    { name = "reco", key = "d", desc = "open recognition detail" },
    { name = "detail", key = "<Tab>", desc = "show the details of the entry under the cursor" },
  },
  trace = {
    { name = "jump", key = "<CR>", desc = "jump to the node definition" },
    { name = "reco", key = "d", desc = "open recognition detail" },
    { name = "rerun", key = "r", desc = "rerun the task from this node" },
    { name = "refresh", key = "R", desc = "refresh the snapshot" },
    { name = "close", key = "q", desc = "close the window" },
    { name = "help", key = "g?", desc = "toggle the help view" },
  },
}

local function valid(value)
  return value and value ~= "" and value ~= false
end

function M.set(scope, overrides)
  local entries = scopes[scope]
  if not entries or type(overrides) ~= "table" then
    return
  end
  for _, entry in ipairs(entries) do
    local value = overrides[entry.name]
    if value ~= nil then
      entry.key = value
    end
  end
end

function M.get(scope, name)
  for _, entry in ipairs(scopes[scope] or {}) do
    if entry.name == name then
      return entry.key
    end
  end
  return nil
end

function M.entries(scope)
  local result = {}
  for _, entry in ipairs(scopes[scope] or {}) do
    if valid(entry.key) then
      table.insert(result, { key = entry.key, desc = entry.desc })
    end
  end
  return result
end

function M.setup(scope, buffer, actions)
  for _, entry in ipairs(scopes[scope] or {}) do
    local action = actions[entry.name]
    if valid(entry.key) and action ~= nil then
      vim.keymap.set("n", entry.key, action, {
        buffer = buffer,
        silent = true,
        desc = string.format("Maa %s: %s", scope, entry.desc),
      })
    end
  end
end

return M
