# 宿主补丁：原理、Desktop 副本制作方式与安装边界

**完整冷压缩能力需要插件与宿主补丁一起使用。** 在原版 Harness 0.2.1-rc.2 上，仅安装插件不能压缩已结束的子会话；插件会明确返回 `host-capability-missing`。

插件源码、宿主补丁文件与 CI 已合入本仓库 `main`。这不等于补丁已进入官方 Desktop，也不等于用户安装插件时会自动应用补丁。仓库提供**可移植的副本制作/启动/检查脚本**（macOS arm64，见下文），但没有补丁版 Desktop 的正式发布包。

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

## 如何制作补丁版 Desktop 副本（可执行命令）

适用并门禁校验的对象：**macOS arm64 + 官方 Desktop 0.12.1 / Harness 0.2.1-rc.2**（`app.asar` SHA256 `366bef41…fefaaa`）。其他版本会被明确拒绝，不做强行适配。在仓库根目录 `npm ci --include=dev` 之后（打包工具 `@electron/asar` 在 devDependencies，仅制作时使用，插件运行不依赖）：

```sh
# 制作（先校验源版本/包 id/哈希；只在 stage 里构建，最后一次性落到目标位）
node host-patch/make-desktop-copy.mjs \
  --source "/Applications/DSH Desktop.app" \
  --target "<你的目录>/DSH Desktop Compactor.app"

# 启动（或直接双击副本——profile/端口已烧定，双击也安全）
node host-patch/launch-desktop-copy.mjs --app "<你的目录>/DSH Desktop Compactor.app"

# 随时体检（副本完整性 + 签名 + 原版仍是基线）
node host-patch/check-desktop-copy.mjs --app "<你的目录>/DSH Desktop Compactor.app"
```

`make-desktop-copy.mjs` 做的事：克隆源 app 到隔离 stage；解包 `app.asar`；对抽取出的**原版** `dsh-agent-loop`/`dsh-subagent` lib 应用 0002/0003（要求干净落上，出现 fuzz/offset 即失败）；把副本切到 development 通道、烧定按目标路径派生的独立 profile/端口对为**字面量**——`DSH_DEV_PROFILE`/`DSH_DEV_HARNESS_PORT`/`DSH_DEV_MOBILE_PORT` 环境变量对副本无效（启动器也会清洗这三个变量），裸双击与脚本启动身份一致；保留 unpacked 布局重打包；更新 Electron ASAR 完整性记录；改独立 bundle id；仅对副本做 ad-hoc 签名并校验；确认源 `app.asar` 前后哈希不变。全部证据写入 `<副本>.app.manifest.json`。失败只清理本次 stage；目标已存在、目标嵌套在源内、危险路径一律拒绝。

启动后通过官方“**插件 → 添加插件**”安装本仓库插件，再在父会话里用 `/subagent-compact` 与 `--all`。回退 = 退出副本并删除副本及其 sidecar manifest；副本独立 profile 里的会话默认保留。完整用户链路（含回退细节）见[顶层中文说明](../README.zh-CN.md)。

安全边界：绝不写入/覆盖源 app；绝不触碰日常 profile（副本 profile 独立派生）；调试端口仅在显式 `--debug-port` 时开启。

首次真实机制验收（独立副本 + 官方 UI 安装 + 真实模型的冷批量/续接/重启回执）见[真实 Desktop 批量验收报告](../docs/acceptance/2026-10-27-batch/acceptance.md)——当时用的是等效的本机脚本；本目录的脚本是它的可移植化。制作/启动/检查与门禁拒绝路径另有[回归测试](../test/desktop-copy.test.mjs)覆盖（错版本/hash/包 id、危险与已存在目标、失败清理、重复执行、启动隔离）。

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

已交付：只靠公开仓库即可完成“制作补丁版副本 → 启动 → 官方 UI 安装插件 → 冷/批量压缩 → 体检 → 回退”的完整链路（macOS arm64 + Desktop 0.12.1 基线，全部带门禁与回归测试）。

仍开放：Desktop 升级到 0.12.1 之外需更新基线常量并重新全链验证；副本不自动更新也不自动迁移日常会话/凭证；Harness monorepo 完整源码构建未做；更长期的正路是上游官方提供 `runMaintenance` 宿主接口，让补丁整个退役。

因此，**“源码已合入”“CI 已通过”“副本链路可复现”和“原版 Desktop 安装插件即得冷压缩”仍是四件不同的事**——最后一件依赖上游，前三件已在本仓库闭环。
