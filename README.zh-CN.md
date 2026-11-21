# DSH 子智能体上下文压缩插件

[English](README.md) · [变更日志](CHANGELOG.md)

在 DSH Desktop 的父会话中，手动压缩**直接子智能体**的历史——仍 live 的直接压缩；已结算的*可续接*子智能体会先被唤醒恢复再压缩。插件调用子智能体已有的压缩引擎，压缩后仍可用原 session ID 继续对话。

**状态：v1.3.3 已于 2026-11-14 合入并推送 tag。** 支持原版 Harness **0.2.2-rc.1 与 0.2.2-rc.2**，无需修改 Desktop 应用源码。此前 1.3.2 与 rc.2 不兼容；这两个运行时均请使用 v1.3.3。

当前源码分支为**尚未发布的 1.3.4** 新增 `/subagent-compact-all`。`v1.3.3` tag 尚不包含该命令；下方安装来源仍指向已发布版本。

## 安装

打开 **插件 → 添加插件**，粘贴 Git 来源，再点击 **安装 → 立即启用**：

| 版本 | Git 来源 |
| --- | --- |
| **推荐：1.3.3，支持 rc.1 与 rc.2** | `https://github.com/08mamba24/dsh-subagent-compactor.git#v1.3.3` |
| 已发布 1.0.1，压缩单个 live 子成员 | `https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1` |
| 此前 1.3.2 源码，仅限 rc.1 | `https://github.com/08mamba24/dsh-subagent-compactor.git#20981ebade6a260bd4a497916b450baeebe5372d` |

`v1.3.3` tag 固定到已审查的插件代码 [`7117d438`](https://github.com/08mamba24/dsh-subagent-compactor/commit/7117d438947f19fcc12abd374ce86746079031b9)。通过 Git 安装分发，未发布 npm 包或创建 GitHub Release。推送 tag 不会自动升级已有的 Desktop 安装。

确认 `@local/dsh-subagent-compactor` 已启用且版本正确。替换已有安装后，完整退出并重新打开 Desktop，让新命令定义生效。如果此前从本地目录安装过同名包，先移除旧安装来源，再添加 Git 来源。

Desktop 插件管理器负责应用插件的 bundle 配置。无需手改 profile、应用宿主补丁或发布 npm 包。`private: true` 限制的是 npm 发布，不影响 Git 安装。

## 使用

在创建子智能体的父会话中输入：

```text
/subagent-compact
/subagent-compact <子智能体的session-id>
/subagent-compact-all
/subagent-compact all
```

- **`/subagent-compact` 不带参数：**列出父会话的持久化直接子成员目录，标注 `live` 或 `persisted (not loaded)`。列表是即时观察，不会预留目标。
- **`/subagent-compact <id>`：**压缩该直接子成员。仍 live 的成员走空闲窗口压缩（默认 `waitForIdle: true`）；已结算的*可续接*成员会先被恢复——插件发送一条真实的维护唤醒消息，在恢复边沿完成压缩，唤醒消息随后由一轮正常对话回应。无法恢复的成员（一次性、外部、持久状态不完整）返回明确拒绝，如 `not-resumable`。
- **`/subagent-compact-all`（1.3.4 源码分支推荐）：**不带参数执行批量压缩。原 `/subagent-compact all` 和 `/subagent-compact --all` 执行相同批量操作，继续保留；v1.3.3 安装仍使用这两个入口。

批量压缩读取一次目录快照，同时启动所有目标的压缩尝试。live 成员直接压缩；已结算的可续接成员等待宿主容量允许后恢复，每次获准恢复只发送一条唤醒消息。按目录顺序返回结果。已结算但不可续接或不可恢复的成员带原因记为 `skipped`；单项失败不会吞掉其他结果。快照之后创建的成员属于下一次运行。

新无参数命令沿用原版宿主的无参数命令路径，压缩期间输入框可继续编辑。处理函数仍等待整批结束，宿主随后记录真实结果。原带参数命令保留宿主原有的输入等待行为。新入口无需修改应用源码；验收进度见[验证记录](docs/VALIDATION.md)。

两个子成员均成功时，回执类似：

```text
<child-1>: resumed from settled state and compacted — replaced 3 items (...)
<child-2>: resumed from settled state and compacted — replaced 3 items (...)
Summary (completed) — total 2: compacted 2 (2 after resume), nothing-to-compact 0, skipped 0, failed 0, cancelled 0, not-started: 0.
```

`completed` 允许包含被跳过的成员，但要求至少有一项完成压缩或无可压缩；一项都没压成的运行会报 `nothing-compacted` 并按错误处理，绝不暗示成功。请结合逐项结果和 `compacted` 数量判断实际完成量。批量只覆盖当前父会话的直接子成员，不递归孙成员。

**恢复已结算成员是真实的额外对话。**每次恢复发送一条维护唤醒消息；子成员历史被摘要（在其自身模型路由上多一次摘要请求），随后唤醒消息由一轮简短确认回应。这是真实交互，不是离线事务：若摘要失败，已投递的唤醒消息仍会执行，回执会如实说明。唤醒文本只要求维护确认，绝不指示新任务。设置 `resumeInactive: false` 可将所有入口限制为仅当前 live 的成员。

父模型只有一个工具：

```text
compact_subagent({ "session_id": "<子智能体的session-id>" })
```

它复用单项压缩路径，执行遵循宿主权限设置。批量压缩由命令提供，本版本没有批量模型工具。

## 确认结果

斜杠命令应显示为命令卡片。成功项包含子会话 ID、替换的历史条目数，以及摘要在该子会话日志中的序号。模型工具成功时返回 `outcome`、`target_session_id`、`summary_seq`、`replaced_items` 和 `replaced_tokens`。

`replaced_tokens` 估算的是被替换的旧历史跨度，不是加入摘要后的净节省量。每次实际压缩都会在子成员自己的模型路由上增加一次摘要请求，每次恢复还会在摘要后多一轮唤醒确认。剩余历史太短、不足以产出有效摘要的成员会以引擎的 `summary` 错误码如实失败（唤醒消息仍已投递）；待其积累更多历史后重试是通常的处理方式。

压缩摘要通过宿主会话存储持久化。批量回执只存在于命令结果中：本版本没有独立回执库或 `report` 命令，宿主可能丢弃已取消命令的结果。

## 容量等待

活跃成员占满宿主容量时，已结算目标会等待名额释放。批量、单 ID 命令和模型工具共用这套行为；live 成员仍立即并发等待各自的空闲窗口。插件不会提升宿主上限或停止正在进行的工作。

等待期间若其他消息恢复了目标，压缩会转入 live 路径，不再发送维护唤醒；若该恢复仍在宿主内部排队，只取消本次尚未接纳的维护投递，外部任务继续运行。

`resumeCapacityTimeoutMs` 默认 **120000**（两分钟），可在插件配置中设为 **1 至 600000** 毫秒。从首次容量拒绝起计时，到获准恢复结束；这个预算不限制已接纳的摘要或唤醒确认轮次。到期仍在等待的目标返回 `capacity-timeout`，保留宿主的容量诊断。取消和插件卸载也会结束等待。因容量被拒绝的尝试不会成功投递唤醒消息，也不会发起模型请求。

## 要求与边界

- 组合需要提供 `commands`、`tools`、`agents`、`subagents` 和子成员的压缩引擎。列表及批量发现目标还需要宿主的持久化子成员目录。
- 只有精确的 live runtime 父成员能压缩其直接子成员；自己、孙成员和其他父会话的子成员都会被拒绝。
- 已结算的可续接子成员会通过正常续接生命周期恢复后压缩（一条真实唤醒消息 + 一次摘要 + 一轮确认）；一次性、外部或不可恢复的成员给出明确拒绝，不会静默丢弃。同 ID 在等待空闲期间被替换为*另一个*实例时仍按 `not-resident` 保守拒绝。
- 所有 live 项立即等待各自的空闲窗口。恢复尝试遵守宿主共享容量池，等到结算和销毁真正归还名额后继续。模型限流及其他非容量错误仍逐项报告，不作为容量不足重试。
- 缺少引擎、目标被回收、同目标争用、取消和引擎失败均有明确结果，详见 [TECHNICAL.md](TECHNICAL.md)。
- 本插件提供手动命令与一个模型工具，不增加自动触发、成员删除或交接操作。

## 与未发布 1.1.0 候选的区别

旧候选把冷压缩与宿主维护补丁配套使用。1.2.0 预览改用原版运行时能力、仅 live 压缩；当前分支保留该基础并新增可续接成员的结算恢复（下表为 1.2.0 的历史快照）：

| 能力 | 未发布 1.1.0 候选 | 1.2.0 预览（历史） |
| --- | --- | --- |
| 已结束、未加载的子会话 | 通过候选宿主补丁冷恢复 | 单项拒绝，批量跳过 |
| 批量执行 | 串行 | 并发，按目录顺序回填结果 |
| 模型工具 | `compact_subagent`、`compact_all_subagents` | 只有 `compact_subagent` |
| 批量回执 | 插件存储域及 `report <batch-id>` | 仅命令结果 |
| 宿主改动 | 冷压缩需要 | 在已验证原版运行时上不需要 |

[host-patch/](host-patch/README.zh-CN.md)、[冷压缩计划](docs/COLD_COMPACTION_PLAN.md)、[宿主能力要求](docs/HOST_MAINTENANCE_REQUIREMENTS.md) 和旧验收记录保留为**未发布候选的历史资料**，不属于当前分支的安装步骤或受支持 API。从该候选升级会移除冷路径、批量模型工具、report 语法和持久化批量回执。

## 验证与测试

[v1.3.3 合入后的 CI](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/43545680782) 在原版 Harness rc.1、rc.2 上各通过 **110/110 项测试**，零失败、零跳过，两套打包检查均通过。覆盖默认 8 槽下的 16 个 settled 成员及直接父级授权边界。此前的验证记录继续保留：1.2.0 预览时点 **46/46**、1.3.2 的 rc.1 基线 **92/92**，以及 v1.3.3 最后一项审查回归加入前各运行时的 **109/109**。

历史隔离验收中，安装包自带 Web UI 成功压缩两个 live 子会话，从磁盘读回两份摘要，随后以两个原 ID 续接，并确认后续模型请求包含 checkpoint。

Web UI 验收使用本地合成模型服务，验证的是命令、持久化和续接机制，不评价真实模型摘要质量，也不代表用户日常 Electron 窗口已经验收。详见[验证记录](docs/VALIDATION.md)和[本次验收摘要](docs/acceptance/2026-11-10-live-only/acceptance.md)。

使用 Node **24.9.0 或更新版本**：

```sh
npm ci --include=dev
npm test
```

rc.2 的所有单目标入口还需要 `sessionQuery` 与 `subagentCatalog` 投影来核对直接创建者；不能只靠同树关系授权。

测试其他已提取的原版模块树：`node scripts/test-installed-runtime.mjs --modules /absolute/node_modules`。runner 仅接受 rc.1/rc.2，并检查所需 dsh 包版本一致；CI 分别运行两套依赖。这些模块级回归不代表新增原生 Electron 窗口验收。

五份受跟踪测试使用固定版本的原版运行时包、隔离临时存储和本地模拟模型服务，不发送外部模型请求。

## 源码与许可证

本仓库提供插件源码和安装说明，尚未指定许可证。通过 Git 安装分发，不发布 npm 包。
