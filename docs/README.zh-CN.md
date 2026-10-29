# maa-pipeline.nvim

中文 | [English](https://github.com/ishi-o/maa-pipeline.nvim/blob/main/docs/README.md)

基于 [Maa Support Extension](https://github.com/neko-para/maa-support-extension)
中的解析器和索引，为 Neovim 提供 MaaFramework Pipeline 支持

## 功能

- LSP 功能：补全、悬停提示、跳转与引用、诊断、Code Lens、代码操作、内联提示、文档链接、工作区符号和颜色支持
- Maa JSON/JSONC Pipeline 的文件类型检测
- 直接运行 MaaFramework 任务，或按 `interface.json` 任务运行并应用其 option 作为 pipeline override
- 运行日志支持原生 `ft=log` 高亮、来源和类型高亮、Lua 过滤、按需查看条目详情、JSON 或文本导出
- 使用 ImageCropper 进行截图裁剪

## 安装

<details>
<summary>lazy.nvim</summary>

```lua
{
  "ishi-o/maa-pipeline.nvim",
  build = "pnpm install && pnpm run build",
  config = function()
    require("maa-pipeline.nvim").setup()
    vim.lsp.enable("maa_pipeline")
  end,
}
```

</details>

<details>
<summary>vim.pack（Neovim 0.12+）</summary>

```lua
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(event)
    local data = event.data
    if data.spec.name ~= "maa-pipeline.nvim" then
      return
    end
    if data.kind ~= "install" and data.kind ~= "update" then
      return
    end

    vim.system({ "pnpm", "install" }, { cwd = data.path }):wait()
    vim.system({ "pnpm", "run", "build" }, { cwd = data.path }):wait()
  end,
})

vim.pack.add({
  "https://github.com/ishi-o/maa-pipeline.nvim",
})

require("maa-pipeline.nvim").setup()
vim.lsp.enable("maa_pipeline")
```

</details>

## 配置

默认配置如下：

```lua
require("maa-pipeline.nvim").setup({
  stop_hotkey = nil, -- 注册停止全局热键；为 nil 时不注册
  log = {
    key = {
      click = "<CR>", -- 按光标处来源、任务 ID 或名称过滤；false 或 "" 表示不注册
      filter = "f", -- 输入 Lua 过滤表达式；false 或 "" 表示不注册
      help = "g?", -- 切换缓冲区内帮助视图；false 或 "" 表示不注册
      reco = "d", -- 打开识别详情；false 或 "" 表示不注册
      detail = "<Tab>", -- 查看光标处条目的详情；false 或 "" 表示不注册
    },
    render = nil, -- 自定义渲染，见“深入”
  },
  trace = {
    key = {
      jump = "<CR>", -- 跳转到节点定义；false 或 "" 表示不注册
      reco = "d", -- 打开识别详情；false 或 "" 表示不注册
      rerun = "r", -- 从该节点重新运行任务；false 或 "" 表示不注册
      refresh = "R", -- 刷新快照；false 或 "" 表示不注册
      close = "q", -- 关闭窗口；false 或 "" 表示不注册
      help = "g?", -- 切换缓冲区内帮助视图；false 或 "" 表示不注册
    },
  },
  options = {
    key = {
      toggle = "e", -- 编辑光标处的选项；false 或 "" 表示不注册
      reset = "d", -- 将光标处的选项重置为默认值；false 或 "" 表示不注册
      reset_all = "D", -- 将全部选项重置为默认值；false 或 "" 表示不注册
      run = "r", -- 以当前选择运行任务；false 或 "" 表示不注册
      close = "q", -- 关闭面板；false 或 "" 表示不注册
      help = "g?", -- 切换缓冲区内帮助视图；false 或 "" 表示不注册
    },
  },
})

vim.lsp.config("maa_pipeline", {
  cmd = nil, -- nil 保留插件自带的 Node.js 命令；也可用列表指定其他命令
  filetypes = { "maa-pipeline.jsonc" }, -- 复合文件类型；所有 Maa JSON 文件均按 JSONC 处理
  root_markers = { "interface.json", "interface.jsonc", ".git" }, -- 项目根目录标记
  init_options = {
    mode = "auto", -- "auto"：检测 src/MaaCore；"maa"：使用 MAA 语法；"framework"：使用 MaaFramework 语法
    locale = "en", -- "en"：英文；"zh"：中文诊断和悬停文本
    runtime = {
      data_dir = vim.fn.stdpath("data") .. "/maa-pipeline.nvim", -- 运行日志目录
      timeout = 60000, -- 控制器和 Agent 连接超时，单位毫秒；-1 表示不限制
      debug_mode = true, -- 写入 MaaFramework 调试日志
      save_draw = false, -- 保存识别标注图到 `<data_dir>/logs/vision`
      save_on_error = true, -- 任务失败时保存识别数据
      reco_image_cache_limit = 64, -- 在内存中保留最近 N 次识别的标注图，供详情视图使用
      daemon = true, -- 任务之间保持 Maa agent 常驻
    },
  },
  capabilities = nil, -- nil 使用 Neovim 默认能力；需要时可传入扩展后的客户端能力
  on_attach = nil, -- LSP 附加到缓冲区时调用
  handlers = {}, -- 自定义方法处理器会与插件默认处理器合并
})

vim.lsp.enable("maa_pipeline") -- 覆盖完成后再启用
```

Windows 下 `maa-runtime` 会始终以管理员权限启动，因为 `Seize` 等输入行为需要与
目标应用保持相同权限级别，Neovim 本身保持普通权限

## 命令

工作目录位于 Maa 项目内（向上找到 `interface.json/jsonc`）时，LSP 客户端会自动启动，
因此 `:MaaPipelineTaskRun` 等命令在 Neovim 启动后即可使用，无需先打开 pipeline
文件。切换工作目录到其他项目时也会自动为该项目启动客户端。

| 命令 | 说明 |
| --- | --- |
| `:MaaPipelineSelectController` | 选择并配置 Maa 控制器 |
| `:MaaPipelineStop` | 停止正在运行的 Maa 任务 |
| `:MaaPipelineRun` | 运行光标所在的 Maa 任务 |
| `:MaaPipelinePickRun` | 从当前文件已声明的任务中选择并运行 |
| `:MaaPipelineTaskRun` | 选择 `interface.json` 中的任务，在面板中确认 option 后运行 |
| `:MaaPipelineScreenshot` | 选择控制器、截图、裁剪，并保存图片或复制 ROI |
| `:MaaPipelineTrace` | 在标签页中打开节点追踪视图，底部同时显示运行日志窗口 |
| `:MaaPipelineVisionClean` | 删除 `<data_dir>/logs/vision` 下累积的识别标注截图 |
| `:MaaPipelineLogFilter [expression]` | 使用 Lua 表达式过滤运行日志；空表达式清除过滤 |
| `:MaaPipelineLogExportJson` | 将过滤后的运行日志导出为 JSON |
| `:MaaPipelineLogExportText` | 将过滤后的运行日志导出为纯文本 |

## 代码操作

| 操作 | 说明 |
| --- | --- |
| `Run Maa task` | 运行光标所在任务 |
| `Select Maa controller` | 选择 `interface.json/jsonc` 中声明的控制器 |
| `ScreenShot` | 截图并裁剪 |
| `Extract locale` | 将可本地化的任务引用移动到本地化文件 |

## 进阶

### 任务 Option

节点运行（`:MaaPipelineRun`、`:MaaPipelinePickRun`、代码操作以及追踪里的 `r` 重跑）直接
post 该 pipeline 节点，不弹 option。`:MaaPipelineTaskRun` 按上游客户端的方式运行任务：先
列出 `interface.json` 声明的任务（label 经项目 `languages` 翻译文件本地化，限定其他
`resource` 的任务隐藏），然后每次运行都为所选任务打开 option 面板，任务从面板以当前选择
启动。

面板在独立标签页中展示任务的所有 option，按 `Task options`（任务自身的 option）与
`Global options`（来自 `global_option` 和当前 `resource`/`controller`）两节分组，预填已保存的值
或默认值。带 `*` 标记的行与默认值不同；子 option 缩进显示在启用它的 case 下方。
switch option 渲染为斜体 label 加 `[Y]`/`[N]` 标记（不再显示值），input 的值带下划线，
option 的 `description` 以灰色斜体显示在行尾。

- `e` 编辑光标处的行（`select`/`switch` 轮换或从 case 列表选择，`checkbox` case
  就地切换，`input` 字段就地输入）
- `d` / `D` 将光标处的选项 / 全部选项重置为默认值
- `r` 运行任务；`q` 关闭面板；`g?` 切换帮助

选择在每次修改后自动保存到 `config/maa_pi_config.json` 的 `__settings`（settings 级
option，跨任务共享）与 `__options[task]`（任务级 option）；只保存与默认值不同的项，
标记 `password: true` 的 `input` 字段永不写入。选择控制器后 `controller` 与
`resource` 同样保存到该文件。所有选择按声明顺序合并为 `pipeline_override`，随任务的
`entry` 下发，任务自身的 `pipeline_override` 最后应用。`controller` 或 `resource`
列表不包含当前资源的 option 以及 `hotkey` option 会被跳过。

### 日志过滤

每次新任务开始时，运行日志缓冲区会自动清空。
在运行日志缓冲区按 `f`，输入 Lua 表达式，留空清除，按 `g?` 切换缓冲区内帮助视图。表达式里字段可直接使用，不需要 `entry.` 前缀：

```lua
level == "error"
level == "error" or level == "warn"
family == "Reco"
taskId == 3
algorithm == "TemplateMatch"
name and name:lower():find("startup", 1, true)
raw and raw:find("recognition", 1, true)
```

可用字段：`level`、`source`、`family`、`phase`、`name`、`raw`、`kind`、`ids`、`taskId`、`nodeId`、`recoId`、`actionId`、`wfId`、`reco`、`algorithm`、`text`、`score`、`box`、`action`、`actionDetails`、`details`、`list`、`nested`、`elapsed`，以及原始的 `entry`

### 节点追踪

`:MaaPipelineTrace` 打开一个独立标签页：上方为节点追踪视图，底部窗口显示运行日志。任务开始时该标签页也会自动打开。任务运行时视图随 runtime 通知实时刷新，也可按 `r` 手动刷新。任务运行期间，日志窗口右侧会显示实时画面，约每秒刷新一次：优先显示最近一次识别的标注图（ROI 与结果框、OCR 结果），首次识别前显示原始截图。任务结束后保留最后一帧（需要终端图片支持）。

每个执行过的节点显示状态与统计：

- `[hit ]` 节点识别成功（含 `runs`/`hit` 计数与耗时）
- `[miss]` 节点作为 next 候选被识别过但从未命中
- `[fail]` 节点失败或中途中断
- `[run ]` 节点正在执行

通过父节点 `next` 列表到达的子节点按层级每级缩进两格，`zc`/`zv` 可折叠与展开节点的子树（节点的折叠从自身所在行开始，因此在父节点上按 `zc` 即可隐藏其所有后代）。被多个父节点 `next` 引用的节点每个引用各占一行，runs、try、anchor 与耗时按引用分别统计。状态标记后的 `[JumpBack]` 表示该节点经 `[JumpBack]` 链接进入（子树结束后回到父节点），`[Anchor:<别名>]` 表示通过 anchor 别名匹配。指标列按表头统一对齐：action、执行次数、识别尝试次数以及总耗时。

追踪缓冲区按键（在缓冲区内按 `g?` 可切换显示当前快捷键的帮助视图）：

| 按键 | 说明 |
| --- | --- |
| `<CR>` | 跳转到该节点在 pipeline JSON 中的定义 |
| `d` | 打开该节点最近一次识别的详情 |
| `r` | 从该节点重新运行任务 |
| `R` | 从服务器刷新 |
| `q` | 关闭窗口 |
| `g?` | 切换帮助视图 |

### 识别详情

在追踪节点或日志中带识别的行上按 `d`，打开一个新标签页，包含：

- 该次识别的框架标注图（ROI 与结果框、OCR 结果），来自内存中最近 `runtime.reco_image_cache_limit` 次识别的缓存，通过 `vim.ui.img`（Kitty 图形协议）直接显示；无标注图时回退为原始截图
- 文本详情缓冲区：命中与否、算法、box、最优候选（`score`、`text`、`count`、`label`）、`all`/`filtered` 计数与嵌套识别

终端不支持图片显示时只打开文本详情缓冲区。识别详情在 Maa 实例存活期间可用：任务运行中，或 `runtime.daemon = true` 时任务结束后。

### 自定义渲染

```lua
require("maa-pipeline.nvim").setup({
  log = {
    render = {
      render = function(entry)
        return { entry.raw or "" }, {}
      end,
      render_details = function(entry)
        return { vim.inspect(entry.details) }
      end,
    },
  },
})
```

也可以直接调用：

```lua
require("maa-pipeline.log").use({
  render = function(entry)
    return { entry.raw or "" }, {}
  end,
  render_details = function(entry)
    return { vim.inspect(entry.details) }
  end,
})
```

## 架构

- Neovim 运行 Lua 客户端，并启动内置的 Node.js LSP 服务端
- LSP 服务端使用 `@nekosu/maa-pipeline-manager` 解析项目，并启动独立的
  `maa-runtime` 子进程
- `maa-runtime` 使用项目自带的 MaaFramework（`node_modules/@maaxyz/maa-node`
  依赖，或在项目内找到的 `MaaNode.node` 部署）和 `@nekosu/maa-server`
  创建控制器、资源和任务实例，并启动 `interface.json` 里声明的外置 agent
