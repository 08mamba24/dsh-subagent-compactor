# DSH 子智能体上下文压缩插件

[English](README.md)

在 DSH Desktop 的父会话中，手动压缩 **live（仍驻留）的直接子智能体**的历史。插件调用子智能体已有的压缩引擎，压缩后仍可用原 session ID 继续对话。

**状态：1.2.0 分支预览，尚未打 tag 或发布。** 当前已发布 tag 仍为 **v1.0.1**。本分支面向原版 Harness **0.2.2-rc.1**，安装并启用插件即可，无需修改 Desktop 应用源码或内置运行时。

## 安装

打开 **插件 → 添加插件**，粘贴 Git 来源，再点击 **安装 → 立即启用**：

| 版本 | Git 来源 |
| --- | --- |
| 已发布 1.0.1，压缩单个 live 子成员 | `https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1` |
| 本次 1.2.0 预览分支，含 live 批量压缩 | `https://github.com/08mamba24/dsh-subagent-compactor.git#feature/live-only-1.2.0` |

分支引用会随开发更新；需要固定版本时请使用完整 commit ID。本预览没有 `v1.2.0` 发布 tag。

确认 `@local/dsh-subagent-compactor` 已启用且版本正确。替换已有安装后，完整退出并重新打开 Desktop，让新命令定义生效。如果此前从本地目录安装过同名包，先移除旧安装来源，再添加 Git 来源。

Desktop 插件管理器负责应用插件的 bundle 配置。无需手改 profile、应用宿主补丁或发布 npm 包。`private: true` 限制的是 npm 发布，不影响 Git 安装。

## 使用

在创建子智能体的父会话中输入：

```text
/subagent-compact
/subagent-compact <子智能体的session-id>
/subagent-compact all
```

- **不带参数：**列出父会话的持久化直接子成员目录，标注 `live` 或 `persisted (not loaded)`。列表是即时观察，不会预留目标。
- **一个 session ID：**压缩该 live 直接子成员。请在它仍运行时发起；默认 `waitForIdle: true` 会等本轮结束再压缩。已经结算并被回收的目标返回 `not-resident`。
- **`all` 或 `--all`：**读取一次目录快照，同时启动所有目标的压缩尝试，按目录顺序返回结果。已不再 live 的成员记为 `skipped`；单项失败不会吞掉其他结果。快照之后创建的成员属于下一次运行。

两个子成员均成功时，回执类似：

```text
<child-1>: compacted — replaced 3 items (...)
<child-2>: compacted — replaced 3 items (...)
Summary (completed) — total 2: compacted 2, nothing-to-compact 0, skipped 0, failed 0, cancelled 0, not-started: 0.
```

`completed` 允许包含被跳过的成员；请结合逐项结果和 `compacted` 数量判断实际完成量。批量只覆盖当前父会话的直接子成员，不递归孙成员。

父模型只有一个工具：

```text
compact_subagent({ "session_id": "<子智能体的session-id>" })
```

它复用单项压缩路径，执行遵循宿主权限设置。批量压缩由命令提供，本版本没有批量模型工具。

## 确认结果

斜杠命令应显示为命令卡片。成功项包含子会话 ID、替换的历史条目数，以及摘要在该子会话日志中的序号。模型工具成功时返回 `outcome`、`target_session_id`、`summary_seq`、`replaced_items` 和 `replaced_tokens`。

`replaced_tokens` 估算的是被替换的旧历史跨度，不是加入摘要后的净节省量。每次实际压缩都会在子成员自己的模型路由上增加一次摘要请求。

压缩摘要通过宿主会话存储持久化。批量回执只存在于命令结果中：本版本没有独立回执库或 `report` 命令，宿主可能丢弃已取消命令的结果。

## 要求与边界

- 组合需要提供 `commands`、`tools`、`agents`、`subagents` 和子成员的压缩引擎。列表及批量发现目标还需要宿主的持久化子成员目录。
- 只有精确的 live runtime 父成员能压缩其直接子成员；自己、孙成员和其他父会话的子成员都会被拒绝。
- 已结算的子成员不在本版本范围内。正常续接可以让同一 ID 再次 live，但插件不会只为压缩而恢复子会话。
- 批量全并发、不设并发上限，让各项都能等待自己的 live 窗口。模型限流可能造成单项失败，回执会如实报告。
- 缺少引擎、目标被回收、同目标争用、取消和引擎失败均有明确结果，详见 [TECHNICAL.md](TECHNICAL.md)。
- 本插件提供手动命令与一个模型工具，不增加自动触发、成员删除或交接操作。

## 与未发布 1.1.0 候选的区别

旧候选把冷压缩与宿主维护补丁配套使用。本次 1.2.0 使用原版运行时能力，恢复为仅 live 压缩：

| 能力 | 未发布 1.1.0 候选 | 1.2.0 预览 |
| --- | --- | --- |
| 已结束、未加载的子会话 | 通过候选宿主补丁冷恢复 | 单项拒绝，批量跳过 |
| 批量执行 | 串行 | 并发，按目录顺序回填结果 |
| 模型工具 | `compact_subagent`、`compact_all_subagents` | 只有 `compact_subagent` |
| 批量回执 | 插件存储域及 `report <batch-id>` | 仅命令结果 |
| 宿主改动 | 冷压缩需要 | 在已验证原版运行时上不需要 |

[host-patch/](host-patch/README.zh-CN.md)、[冷压缩计划](docs/COLD_COMPACTION_PLAN.md)、[宿主能力要求](docs/HOST_MAINTENANCE_REQUIREMENTS.md) 和旧验收记录保留为**未发布候选的历史资料**，不属于 1.2.0 的安装步骤或受支持 API。从该候选升级会移除冷路径、批量模型工具、report 语法和持久化批量回执。

## 验证与测试

1.2.0 的安装包运行时验证及干净 npm 依赖树验证，均在原版 Harness `0.2.2-rc.1` 上通过 **46/46 个受 Git 跟踪的测试**：unit 25、batch 15、integration 1、preset integration 5。隔离运行的安装包自带 Web UI 成功压缩两个 live 子会话，从磁盘读回两份摘要，随后以两个原 ID 续接，并确认后续模型请求包含 checkpoint。

Web UI 验收使用本地合成模型服务，验证的是命令、持久化和续接机制，不评价真实模型摘要质量，也不代表用户日常 Electron 窗口已经验收。详见[验证记录](docs/VALIDATION.md)和[本次验收摘要](docs/acceptance/2026-11-10-live-only/acceptance.md)。

使用 Node **24.9.0 或更新版本**：

```sh
npm ci --include=dev
npm test
```

四份受跟踪测试使用固定版本的原版运行时包、隔离临时存储和本地模拟模型服务，不发送外部模型请求。

## 源码与许可证

本仓库提供插件源码和安装说明，尚未指定许可证。通过 Git 安装分发，不发布 npm 包。
