# 宿主补丁：原理、Desktop 副本制作方式与安装边界

**完整冷压缩能力需要插件与宿主补丁一起使用。** 在原版 Harness 0.2.1-rc.2 上，仅安装插件不能压缩已结束的子会话；插件会明确返回 `host-capability-missing`。

插件源码、宿主补丁文件与 CI 已合入本仓库 `main`。这不等于补丁已进入官方 Desktop，也不等于用户安装插件时会自动应用补丁。当前有经过验收的本机副本，尚无通用的一键宿主补丁安装器或补丁版 Desktop 发布包。

## 补丁改了什么

| 模块 | 改动与目的 |
|---|---|
| `dsh-subagent` | 增加 `runMaintenance`：按父子权限恢复已结束的 continuable 子会话，执行压缩，然后交回正常结算和释放流程，无需派发额外任务 |
| `dsh-agent-loop` | 同步关闭输入准入，取消或释放时保留已接受的消息，并恢复已取出但尚未提交的消息批次 |
| `dsh-agent` | 补齐上述公开接口的 TypeScript 类型声明；这个包没有运行时改动 |

补丁文件分两类：

- [0001：Harness 源码补丁](0001-harness-source-0.2.1-rc.2-maintenance-capability.diff)，基于 `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`。
- [0002：agent-loop JS 等价补丁](0002-agent-loop-lib.equivalent.diff)和 [0003：subagent JS 等价补丁](0003-dsh-subagent-lib.equivalent.diff)，用于隔离运行树与 Desktop 副本验收。

完整 Harness monorepo 源码构建尚未完成。源码审查、类型基线比较、JS 等价补丁执行和完整源码构建是不同证据，不能互相替代。

## 已验收的 Desktop 副本怎么制作

以下记录已经执行的制作方式，适用对象是 **macOS Desktop 0.12.1 / Harness 0.2.1-rc.2**，不是对任意 Desktop 版本通用的安装教程。

1. 复制原来的 `DSH Desktop.app`，只在独立副本上工作。
2. 解包副本的 `Contents/Resources/app.asar`，放入上述两个已审查的 JS 运行时模块。
3. 为副本启用独立 development profile、日志、应用标识和端口，使验收数据与日常数据分开。
4. 重新打包 ASAR，保留原有 unpacked 资源布局，更新 Electron ASAR 完整性记录，并只对副本做本地 ad-hoc 签名。
5. 启动副本，通过官方“插件 → 添加插件”界面安装并启用本插件。
6. 在专用合成工作区验证：两个已结束成员的手动批量、模型工具批量、原 ID 续接，以及完整重启后的持久回执查询。

原安装包的 ASAR 哈希在验收前后相同；正式 Desktop 和日常 profile 没有被当作试验目标。实际制作脚本 `prepare.mjs` 仍只在本机，它包含本机路径和版本假设，尚未作为仓库的可移植安装命令发布。

截图、事件序号、请求输入长度和结果见[真实 Desktop 批量验收报告](../docs/acceptance/2026-10-27-batch/acceptance.md)。报告保留验收当时的状态；后来合入 main 与 CI 跑通，不会自动把候选变成正式发布版。

## 怎么复现自动测试

仓库 CI 从公共 npm 依赖和提交的 lockfile 安装，不依赖本机解包的 Desktop。使用已验证的 Node 24.18.0，在仓库根目录运行：

```sh
npm ci
npm run test:stock
npm run test:gap-diag
```

补丁版测试需先按 [CI workflow](../.github/workflows/ci.yml) 中的步骤制作隔离模块树并应用 0002、0003，再运行 `npm run test:patched`。这套命令只构建测试环境，不给已经安装的 Desktop 打补丁。

[真实 GitHub Ubuntu runner](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/40554288771) 已通过原版 46 项测试、3 条缺能力诊断和补丁版 83 项测试。测试使用临时存储与本地假模型；真实模型的 Desktop 旅程是上面的另一份验收证据。

## 正式使用还缺什么

要交付给日常 Desktop 使用，还需要版本与原文件校验、备份和回退、更新后的重新适配，以及可维护的安装或分发流程；或者由上游正式提供所需宿主接口。本仓库目前没有一步完成这些工作的安装器。

因此，**“源码已合入”“CI 已通过”“补丁副本已验收”和“原版 Desktop 安装插件即可用”是四件不同的事**。本项目已完成前三项，尚未交付最后一项。
