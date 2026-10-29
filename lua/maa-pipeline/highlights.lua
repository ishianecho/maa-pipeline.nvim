local M = {}

M.help = {
  hint = "MaaPipelineHelpHint",
  desc = "MaaPipelineHelpDesc",
}

M.option = {
  switch = "MaaPipelineOptionSwitch",
  switch_on = "MaaPipelineOptionSwitchOn",
  switch_off = "MaaPipelineOptionSwitchOff",
  input = "MaaPipelineOptionInput",
  desc = "MaaPipelineOptionDesc",
}

M.log = {
  source = "MaaPipelineLogSource",
  filter = "MaaPipelineLogFilter",
  family = {
    Task = "MaaPipelineLogTask",
    Node = "MaaPipelineLogNode",
    Next = "MaaPipelineLogNext",
    Reco = "MaaPipelineLogReco",
    Action = "MaaPipelineLogAction",
    Loading = "MaaPipelineLogLoading",
    Freeze = "MaaPipelineLogFreeze",
    Ctrl = "MaaPipelineLogCtrl",
    Plain = "MaaPipelineLogPlain",
  },
}

M.trace = {
  succeeded = "MaaPipelineTraceSucceeded",
  running = "MaaPipelineTraceRunning",
  failed = "MaaPipelineTraceFailed",
  missed = "MaaPipelineTraceMissed",
}

M.reco = {
  hit = "MaaPipelineRecoHit",
  miss = "MaaPipelineRecoMiss",
}

local function link(name, target)
  vim.api.nvim_set_hl(0, name, { default = true, link = target })
end

local function gray_italic(name)
  local comment = vim.api.nvim_get_hl(0, { name = "Comment", link = false })
  local attrs = { italic = true }
  if comment.fg then
    attrs.fg = comment.fg
  end
  vim.api.nvim_set_hl(0, name, attrs)
end

function M.define()
  vim.api.nvim_set_hl(0, M.help.desc, { default = true, italic = true })
  gray_italic(M.help.hint)
  vim.api.nvim_set_hl(0, M.option.switch, { default = true, italic = true })
  link(M.option.switch_on, "String")
  link(M.option.switch_off, "Comment")
  vim.api.nvim_set_hl(0, M.option.input, { default = true, underline = true })
  gray_italic(M.option.desc)
  link(M.log.source, "Title")
  for family, group in pairs(M.log.family) do
    local target = family == "Task" and "Title"
      or family == "Node" and "Identifier"
      or family == "Next" and "Statement"
      or family == "Reco" and "Type"
      or family == "Action" and "Function"
      or family == "Loading" and "Special"
      or family == "Freeze" and "PreProc"
      or family == "Ctrl" and "Constant"
      or "Normal"
    link(group, target)
  end
  link(M.trace.succeeded, "String")
  link(M.trace.failed, "ErrorMsg")
  link(M.trace.running, "MoreMsg")
  link(M.trace.missed, "WarningMsg")
  link(M.reco.hit, "String")
  link(M.reco.miss, "ErrorMsg")
end

return M
