# pi-skills-sources

为 Pi 的技能补全显示来源，并支持按来源搜索，不修改上游 `SKILL.md`、技能名称或模型提示词。

## 使用

在 Pi 输入 `/`，技能条目显示为 `[来源] /skill:名称`，非技能命令保持原样。

| 输入                 | 补全效果                             |
| -------------------- | ------------------------------------ |
| `/wisharness`        | 搜索 WisHarness 来源的技能           |
| `/WisHarness`        | 同样匹配，来源搜索不区分大小写       |
| `/wisharness init`   | 在该来源内搜索名称包含 `init` 的技能 |
| `/ai-coding`         | 搜索 ai-coding 来源的技能            |
| `/mattpocock/skills` | 搜索 mattpocock/skills 来源的技能    |
| `/helper`            | 保留 Pi 原生的技能名称模糊搜索       |

选中 `[wisharness] /skill:init` 后插入的是 `/skill:init `，仍由 Pi 原生技能机制执行。

来源搜索是补全入口，不会注册 `/wisharness` 等新命令，输入后需要选中条目再执行。

仅展示 Pi 当前实际加载的技能，不扫描磁盘并添加未加载技能，也不解决宿主加载前发生的同名技能冲突。

## 来源识别

来源识别使用 Pi 命令的 `sourceInfo`，结合技能安装锁文件和实际文件路径，不根据技能名称猜测归属。

- 包技能优先使用 Pi 提供的包来源，本地包读取 `package.json` 的名称，因此 ZIP 安装的 WisHarness 也能识别。
- 复制安装的技能通过用户或当前项目祖先目录的 `.agents/.skill-lock.json` 识别，锁记录必须与技能路径对应。
- 符号链接解析到真实路径，缺少安装记录时尝试读取所在 Git 仓库的来源。
- 通用仓库名 `skills` 保留拥有者，例如 `mattpocock/skills`，避免多个来源显示为相同的 `skills`。
- 无可靠来源时显示 `local`，读取失败或元数据损坏时提示警告并降级，不阻止原技能使用。

不访问网络、不执行 Git 命令，不输出来源 URL 的凭据。

来源解析结果在会话中缓存，安装记录变更后执行 `/reload` 刷新。

## 安装和移除

需要 Pi 1.5.2 或兼容版本，以及 Node.js 22.18.0 以上支持原生 TypeScript 类型剥离的版本运行本项目测试。

```bash
pi install git:https://github.com/yinziyang/pi-skills-sources.git
```

正在运行的 Pi 需要执行 `/reload`，补全扩展仅在交互式 TUI 中启用。

```bash
pi remove git:https://github.com/yinziyang/pi-skills-sources.git
```

移除后执行 `/reload` 恢复原生列表。

扩展只添加自己的包加载声明，不改写其他技能和扩展的加载配置。

## 开发验证

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run format:check
```

测试使用 Node.js 内建测试框架、临时文件和 Pi 原生补全提供者，不连接线上服务。

包没有运行时第三方依赖，开发依赖中的 Pi 包用于类型检查和真实补全集成测试，运行时由宿主提供。
