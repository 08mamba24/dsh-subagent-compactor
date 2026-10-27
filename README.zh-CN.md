# DSH 子智能体上下文压缩插件

[English](README.md)

在 DSH Desktop 的父会话中，手动压缩直接子智能体的历史——子智能体仍在运行时可以压缩，**已经结束的 continuable 子智能体也可以按 session id 直接压缩**。插件复用子智能体自己的压缩引擎，提供斜杠命令和模型工具。

**插件版本：** `1.1.0` · **包名：** `@local/dsh-subagent-compactor` · **已验证环境：** Desktop `0.12.1` / Harness `0.2.1-rc.2`。

## 1.1.0 变化

结束后的 continuable 子智能体现在可以按 session id 压缩：无需再派一个任务、也无需抢 live 窗口。插件通过公开的 `agents.resume`，按子智能体管理器续接时使用的同一套组合（descriptor 记录的路由、独立选择的 agent preset 或继承组合、persona、tool filter）恢复持久化会话，执行一次空闲压缩，然后释放本次创建的写入句柄。鉴权、pending 输入与并发规则见 [TECHNICAL.md](TECHNICAL.md)。

## 安装

1. 打开 DSH Desktop → **插件 → 添加插件**。
2. 在“包名或地址”中粘贴：

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.1.0
   ```

3. 点击 **安装 → 立即启用**，确认 `@local/dsh-subagent-compactor` `1.1.0` 正在运行。
4. 替换已有安装后，完整退出并重新打开 Desktop。实测版本中，仅刷新界面可能保留旧命令定义。

如果之前从本地目录安装过同名包，先卸载旧来源，再安装 GitHub 版本。安装由 Desktop 插件管理器处理，无需手动修改 profile，也无需发布 npm 包。`private: true` 限制的是 npm 发布，不影响 Git 来源安装。

也可以先下载源码，再在“添加插件”里选择仓库根目录：

```sh
git clone https://github.com/08mamba24/dsh-subagent-compactor.git
cd dsh-subagent-compactor
git checkout v1.1.0
```

需要固定不可变版本时，将安装地址中的 `v1.1.0` 换成本仓库的完整 40 位 commit。

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

父智能体也可以在回合内调用工具：

```text
compact_subagent({ "session_id": "<子智能体的session-id>" })
```

例如告诉父智能体：“调用 `compact_subagent` 压缩子会话 X，并报告工具返回结果。”工具执行遵循宿主权限设置。

## 怎么确认压缩成功

带参命令应显示为真正的命令卡片。成功结果会给出子会话 ID、摘要序号和被替换的历史条目数；工具返回 `outcome`、`target_session_id`、`summary_seq`、`replaced_items`、`replaced_tokens`。

`replaced_tokens` 是被替换旧历史的估算量，不是加入摘要后的净节省量。要衡量上下文下降，应比较压缩前后的上下文估算或实际请求总输入。生成摘要会在子智能体自己的路由上多用一次模型请求。

拒绝都是显式 outcome，不会静默失败：`unknown-session`（无此会话）、`not-authorized`（他人子成员 / 孙成员 / 自身）、`unsupported-target`（one-shot、external、缺失或不受支持的 descriptor）、`pending-input`（存在持久化未处理输入——应先续接子智能体）、`busy-target`（并发压缩或他人持有写入句柄；稍后重试）、`restore-failed`、`query-unavailable`，以及引擎的六个手动压缩错误码（`busy`、`cancelled`、`changed`、`summary`、`commit`、`persistence`）。

## 环境与边界

- 组合需要 `commands`、`tools`、`agents`、`subagents` 服务，以及子成员对应的压缩引擎；冷压缩另需 `sessionQuery` 与会话持久化（同类组合中通常已具备）。
- 只允许运行时直接父级操作。live 目标按运行时所有权拒绝他人；已结束目标按子会话持久化 header 的父级血缘与其持久 descriptor 拒绝他人子成员、自身和孙成员。
- preset 组合通过 `agentPresets.serviceFor` 解析子成员引擎（绝不回退 Host 平面）；无该注册表的组合使用 Host 引擎。
- 存在持久化未处理输入的已结束子智能体会被拒绝（`pending-input`），以保证这些工作留给正常续接处理。
- 支持列目录和手动压缩；删除、handoff、自动触发不在此版本范围内。
- 已验证 Desktop `0.12.1` / Harness `0.2.1-rc.2`；其他版本需要另行验证。

技术说明见 [TECHNICAL.md](TECHNICAL.md)，验证口径见 [docs/VALIDATION.md](docs/VALIDATION.md)。测试依赖与命令见 [英文说明](README.md#run-the-tests)。

## 源码与许可

本仓库提供插件源码和安装说明，尚未指定许可证。本次通过 GitHub 分发，包保留 `private: true`，未发布 npm。
