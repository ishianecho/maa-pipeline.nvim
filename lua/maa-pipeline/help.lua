local M = {}

local keymap = require("maa-pipeline.keymap")

M.filter_reference = {
  "Lua log filter:",
  "",
  "Available variables:",
  "  level source family phase name raw kind",
  "  ids taskId nodeId recoId actionId wfId",
  "  reco algorithm text score box",
  "  action actionDetails details list nested elapsed",
  "",
  "Examples:",
  '  level == "error"',
  '  level == "error" or level == "warn"',
  '  family == "Reco"',
  "  taskId == 3",
  '  algorithm == "TemplateMatch"',
  '  name and name:lower():find("startup", 1, true)',
  '  raw and raw:find("recognition", 1, true)',
  "",
  "Empty expression clears the filter",
}

function M.lines(title, scope, sections)
  local entries = keymap.entries(scope)
  local width = 0
  for _, entry in ipairs(entries) do
    width = math.max(width, vim.fn.strdisplaywidth(entry.key))
  end

  local lines = { title, "", "Keymaps:" }
  for _, entry in ipairs(entries) do
    table.insert(lines, string.format("  %-" .. width .. "s  %s", entry.key, entry.desc))
  end
  for _, section in ipairs(sections or {}) do
    table.insert(lines, "")
    vim.list_extend(lines, section)
  end
  local help_key = keymap.get(scope, "help")
  if help_key and help_key ~= "" and help_key ~= false then
    table.insert(lines, "")
    table.insert(lines, "Press " .. help_key .. " again to go back")
  end
  return lines
end

return M
