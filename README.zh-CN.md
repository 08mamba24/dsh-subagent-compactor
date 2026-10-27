# DSH 子智能体上下文压缩插件

[English](README.md)

**状态：1.1.0 为未发布候选。** 下文的冷压缩能力已通过代码复审但**尚未发布**：它依赖候选宿主维护能力（`ctx.subagents.runMaintenance`，见 [host-patch/](host-patch/README.md)）。在原版 DSH 0.2.1-rc.2 运行时上，插件会明确拒绝冷压缩（`host-capability-missing`），只有 live 窗口压缩可用。当前已发布版本为 **1.0.1**（仅 live 窗口）。

在 DSH Desktop 的父会话中，手动压缩直接子智能体的历史——子智能体仍在运行时可以压缩，**已经结束的 continuable 子智能体也可以按 session id 直接压缩**。插件复用子智能体自己的压缩引擎，提供斜杠命令和模型工具。

**候选版本：** `1.1.0`（未发布）· **包名：** `@local/dsh-subagent-compactor` · **验证环境：** Desktop `0.12.1` / Harness `0.2.1-rc.2`（live 窗口为发布版运行时验证；冷路径为隔离补丁树验证）。

## 1.1.0 变化

在候选补丁宿主上，结束后的 continuable 子智能体可以按 session id 压缩，无需再派任务或抢 live 窗口。插件调用 `ctx.subagents.runMaintenance`，由管理器恢复子成员组合、执行压缩，并负责结算和释放写入句柄；插件不持有恢复句柄。鉴权、pending 输入与并发规则见 [TECHNICAL.md](TECHNICAL.md)。

## 安装

### 已发布版本（1.0.1，live 窗口压缩）

1. 打开 DSH Desktop → **插件 → 添加插件**。
2. 在“包名或地址”中粘贴：

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1
   ```

3. 点击 **安装 → 立即启用**，确认 `@local/dsh-subagent-compactor` `1.0.1` 正在运行。
4. 替换已有安装后，完整退出并重新打开 Desktop。实测版本中，仅刷新界面可能保留旧命令定义。

如果之前从本地目录安装过同名包，先卸载旧来源，再安装 GitHub 版本。安装由 Desktop 插件管理器处理，无需手动修改 profile，也无需发布 npm 包。`private: true` 限制的是 npm 发布，不影响 Git 来源安装。

### 1.1.0 候选（没有可安装的发布 tag）

1.1.0 候选**没有 tag、没有发布**：它以 `feature/cold-session-compaction` 分支加候选宿主补丁的形式存在。不要把它装进真实 Desktop 并期待冷压缩——原版运行时缺少所需能力，插件会明确拒绝冷压缩。评估候选请按 [host-patch/README.md](host-patch/README.md) 的隔离验证树进行。引用时请使用分支头部的完整 40 位 commit，而不是不存在的 tag。

## 使用

在创建子智能体的父会话中输入：

```text
/subagent-compact
```

命令列出持久化的直接子成员目录。每行结尾标注 `— live`（已加载的 agent）或 `— persisted (not loaded)`（仅持久化记录；列表是即时观察，不是预留）。复制完整 session ID，再执行：

```text
/subagent-compact <子智能体的session-id>
```

两种合法情形：

- **子智能体仍 live** —— 在它运行时发起即可；默认 `waitForIdle: true` 会等本轮结束再压缩。
- **子智能体已结束**（已结算、被回收的 continuable 子智能体）—— 之后任意时刻按 id 调用。插件恢复子会话、压缩一次、释放句柄；不会发送新任务。压缩后同一 id 仍可正常续接。

### 批量：一次压缩全部直接子成员

```text
/subagent-compact --all
```

对调用父会话**启动时刻的持久化目录快照**中的每个直接子成员逐个压缩（快照之后新增的成员属于下一次运行；不递归孙成员、不涉及其他父会话的成员）。各项**串行**执行并沿用同一 per-target 锁——并发的单项压缩同一目标会得到 `busy-target`。每一项都单独报告结果与原因（压缩成功含 summary seq / 替换条目数 / 被替换历史 token 估算、无可压历史、one-shot 或 pending 被拒、引擎失败等）；单项失败不会吞掉其余项。批量结果只有在每个子成员都压缩成功或无可压历史时才是 `completed`；全部未成功为 `all-failed`，部分失败为 `partial-failure`，被取消为 `batch-cancelled`——包括取消落在目录读取尚未结束时的情形；这些非干净结果都会让命令报错，绝不报成功。取消（或卸载插件）会停止尚未开始的项（记为 `not-started`）并保留已完成的结果；取消落地时目录已读出的，已知的全部目标都会逐项记为 `not-started`，目录真未读出的则明确报告快照未知。每个被压缩的子成员仍会在自己的模型路由上多一次摘要请求。原版运行时上冷路径项会被拒（`host-capability-missing` 计入 failed），live 项照常压缩。

每个完成的批量都会持久化一条**回执**——插件自有版本化**存储域**（`subagent_compactor_batch_receipts`，经组合的 `storageDomain` 设施打开）中一条经 schema 校验的记录。回执显式携带所属父会话 id，该 id 即授权边界：其他父会话读不到也覆盖不了，fork 继承的历史不会冒充本会话自己创建的回执。写入在后端确认落盘的那一刻即持久（每批次一条、绝不覆盖），插件重载、宿主重启后仍在。宿主的 abort 语义会丢弃被取消命令自身的结果——回执必须持久化正是为此。裸 `/subagent-compact` 列表会附上本父最近一条**未干净完成**的回执（干净批次的结果当时已正常送达）；任意回执（干净与否）都可按 id 取回：

```text
/subagent-compact report <batch-id>
```

回执写入失败会在返回文本中如实写明（`NOT persisted: …`），绝不谎称已持久化；记录形状由域的 zod schema 在打开时强制校验——外来载荷根本进不了域。

父智能体也可以在回合内调用工具：

```text
compact_subagent({ "session_id": "<子智能体的session-id>" })
compact_all_subagents({})   // 上述批量入口，附结构化计数
```

例如告诉父智能体：“调用 `compact_subagent` 压缩子会话 X，并报告工具返回结果。”工具执行遵循宿主权限设置。批量工具的计数——`total`、`compacted`、`nothing_to_compact`、`failed`、`cancelled`、`not_started`——是批量结果的结构化数值，绝不从报告文本反向解析（错误行里可能出现任意数字）。

## 怎么确认压缩成功

带参命令应显示为真正的命令卡片。成功结果会给出子会话 ID、摘要序号和被替换的历史条目数；工具返回 `outcome`、`target_session_id`、`summary_seq`、`replaced_items`、`replaced_tokens`。

`replaced_tokens` 是被替换旧历史的估算量，不是加入摘要后的净节省量。要衡量上下文下降，应比较压缩前后的上下文估算或实际请求总输入。生成摘要会在子智能体自己的路由上多用一次模型请求。

拒绝都是显式 outcome，不会静默失败：`unknown-session`（无此会话）、`not-authorized`（他人子成员 / 孙成员 / 自身）、`unsupported-target`（one-shot、external、缺失或不受支持的 descriptor）、`pending-input`（存在持久化未处理输入——应先续接子智能体）、`busy-target`（并发压缩或他人持有写入句柄；稍后重试）、`restore-failed`、`query-unavailable`，以及引擎的六个手动压缩错误码（`busy`、`cancelled`、`changed`、`summary`、`commit`、`persistence`）。

## 环境与边界

- 组合需要 `commands`、`tools`、`agents`、`subagents` 服务，以及子成员对应的压缩引擎；冷压缩另需 `sessionQuery` 与会话持久化（同类组合中通常已具备）。批量回执存放在插件自有的存储域（`@deepseek-ai/dsh-storage-domain`，新增必需 peer；域内记录经 schema 校验、不进模型可见面），经组合的 `storageDomain` 设施打开；设施缺失或写入失败时，批量文本会如实写 `NOT persisted`，绝不谎称已持久化。
- 只允许运行时直接父级操作。live 目标按运行时所有权拒绝他人；已结束目标按子会话持久化 header 的父级血缘与其持久 descriptor 拒绝他人子成员、自身和孙成员。
- preset 组合通过 `agentPresets.serviceFor` 解析子成员引擎（绝不回退 Host 平面）；无该注册表的组合使用 Host 引擎。
- 冷压缩依赖宿主的管理器侧维护能力（`ctx.subagents.runMaintenance`）。在原版 0.2.1-rc.2 运行时上，插件会明确拒绝冷压缩（`host-capability-missing`）；[host-patch/](host-patch/README.md) 中的隔离候选宿主补丁提供该能力：已接受输入不丢失、正常续接全程可用、仅卸载插件不损滞留输入。live 窗口压缩在两种运行时上都可用。
- 支持列目录和手动压缩；删除、handoff、自动触发不在此版本范围内。
- 已验证 Desktop `0.12.1` / Harness `0.2.1-rc.2`；其他版本需要另行验证。

技术说明见 [TECHNICAL.md](TECHNICAL.md)，验证口径见 [docs/VALIDATION.md](docs/VALIDATION.md)。测试依赖与命令见 [英文说明](README.md#run-the-tests)。

## 源码与许可

本仓库提供插件源码和安装说明，尚未指定许可证。本次通过 GitHub 分发，包保留 `private: true`，未发布 npm。
