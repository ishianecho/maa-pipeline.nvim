local M = {}

local keymap = require("maa-pipeline.keymap")
local highlights = require("maa-pipeline.highlights")

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

function M.hint(scope)
  local key = keymap.get(scope, "help")
  if key and key ~= "" and key ~= false then
    return "Press " .. key .. " for the help view"
  end
  return nil
end

function M.apply_desc_marks(buffer, namespace, marks)
  for _, mark in ipairs(marks or {}) do
    vim.api.nvim_buf_add_highlight(buffer, namespace, highlights.help.desc, mark.line, mark.start, mark.stop)
  end
end

function M.highlight_hint(buffer, namespace, row)
  highlights.define()
  vim.api.nvim_buf_add_highlight(buffer, namespace, highlights.help.hint, row, 0, -1)
end

function M.lines(title, scope, sections)
  local entries = keymap.entries(scope)
  local width = 0
  for _, entry in ipairs(entries) do
    width = math.max(width, vim.fn.strdisplaywidth(entry.key))
  end

  local lines = { title, "", "Keymaps:" }
  local marks = {}
  for _, entry in ipairs(entries) do
    local line = string.format("  %-" .. width .. "s  %s", entry.key, entry.desc)
    marks[#marks + 1] = {
      line = #lines,
      start = width + 4,
      stop = width + 4 + vim.fn.strdisplaywidth(entry.desc),
    }
    table.insert(lines, line)
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
  return lines, marks
end

return M
