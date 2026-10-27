# DSH 子智能体上下文压缩插件

[English](README.md)

在 DSH Desktop 的父会话中，手动压缩仍在运行的直接子智能体历史。插件复用子智能体已有的压缩引擎，提供斜杠命令和模型工具。

**插件版本：** `1.0.1` · **包名：** `@local/dsh-subagent-compactor` · **已验证环境：** Desktop `0.12.1` / Harness `0.2.1-rc.2`。

## 安装

1. 打开 DSH Desktop → **插件 → 添加插件**。
2. 在“包名或地址”中粘贴：

   ```text
   https://github.com/08mamba24/dsh-subagent-compactor.git#v1.0.1
   ```

3. 点击 **安装 → 立即启用**，确认 `@local/dsh-subagent-compactor` `1.0.1` 正在运行。
4. 替换已有安装后，完整退出并重新打开 Desktop。实测版本中，仅刷新界面可能保留旧命令定义。

如果之前从本地目录安装过同名包，先卸载旧来源，再安装 GitHub 版本。安装由 Desktop 插件管理器处理，无需手动修改 profile，也无需发布 npm 包。`private: true` 限制的是 npm 发布，不影响 Git 来源安装。

也可以先下载源码，再在“添加插件”里选择仓库根目录：

```sh
git clone https://github.com/08mamba24/dsh-subagent-compactor.git
cd dsh-subagent-compactor
git checkout v1.0.1
```

需要固定不可变版本时，将安装地址中的 `v1.0.1` 换成本仓库的完整 40 位 commit。

## 使用

在创建子智能体的父会话中输入：

```text
/subagent-compact
```

命令列出持久化的直接子成员目录。复制完整 session ID，再执行：

```text
/subagent-compact <子智能体的session-id>
```

**调用开始时，子智能体必须仍然 live。** 可以在它处理任务时发起请求；默认 `waitForIdle: true` 会等本轮结束，再执行压缩。目录中有记录不代表当前仍可压缩：已经结算、回收的子智能体会返回 `not-resident`，本插件不会自行恢复它。

父智能体也可以在回合内调用工具：

```text
compact_subagent({ "session_id": "<子智能体的session-id>" })
```

例如告诉父智能体：“在这个直接子成员仍运行时，调用 `compact_subagent` 压缩它，并报告工具返回结果。”工具执行遵循宿主权限设置。

## 怎么确认压缩成功

带参命令应显示为真正的命令卡片。成功结果会给出子会话 ID、摘要序号和被替换的历史条目数；工具返回 `outcome`、`target_session_id`、`summary_seq`、`replaced_items`、`replaced_tokens`。

`replaced_tokens` 是被替换旧历史的估算量，不是加入摘要后的净节省量。要衡量上下文下降，应比较压缩前后的上下文估算或实际请求总输入。生成摘要会多用一次模型请求。

## 环境与边界

- 组合需要 `commands`、`tools`、`agents`、`subagents` 服务，以及子成员对应的压缩引擎。
- 只允许运行时直接父级操作，拒绝他人的子成员、自身和孙成员。
- 支持列目录和手动压缩；删除、handoff、冷会话压缩、自动触发不在此版本范围内。
- 已验证 Desktop `0.12.1` / Harness `0.2.1-rc.2`；其他版本需要另行验证。

技术说明见 [TECHNICAL.md](TECHNICAL.md)，验证口径见 [docs/VALIDATION.md](docs/VALIDATION.md)。测试依赖与命令见 [英文说明](README.md#run-the-tests)。

## 源码与许可

本仓库提供插件源码和安装说明，尚未指定许可证。本次通过 GitHub 分发，包保留 `private: true`，未发布 npm。
