# Changelog / 变更日志

## Host assembly patrol attribution / 宿主装配失败的巡检归因 (2026-11-24)

- Attribute a candidate whose published host fails before the plugin is loaded to the host. Test fixtures announce the failing host row with `DSH_HOST_ASSEMBLY_FAILED <stage>`, and the watcher classifies the run `NOT_VERIFIED` with that line as the first failure instead of waiting for the deadline and reporting `INFRA_ERROR`.
  发布宿主在插件加载前失败时归因于宿主：测试夹具以 `DSH_HOST_ASSEMBLY_FAILED <阶段>` 报出失败的宿主行，巡检判为 `NOT_VERIFIED` 并保留该行为首个失败，不再等到截止时间报 `INFRA_ERROR`。
- Release fixture resources when a composition fails. Listener and scratch-directory cleanup is registered before each boot, and a fixture HTTP listener that outlives its test is closed and reported by a root after-hook.
  组合失败时释放夹具资源：监听与临时目录的清理在每次启动前注册，存活超过所属测试的夹具 HTTP 监听由根级 after 钩子关闭并上报。
- Keep an `AssertionError` ahead of the host marker, and skip the two phase checks that need a working host when it does not assemble. Add five stock tests and two watcher contracts (stock suites 120 → 125, watcher 39 → 41).
  断言失败仍优先于宿主标记；需要健康宿主的两个阶段检查在宿主无法装配时跳过。新增 5 个套件用例与 2 个巡检契约（套件 120 → 125，巡检 39 → 41）。
- Found on stock `0.2.3-alpha.1`: its `dsh-typert-protocol` reads `ctx[Context.root]`, a static that the Cordis 4.1.0 of its own lock does not define, so mounting `dsh-llm` throws. rc.5 resolves the same Cordis and assembles. rc.1–rc.5 and alpha.2 stay at 125/125; alpha.1 remains `NOT_VERIFIED` and unsupported.
  问题在原版 `0.2.3-alpha.1` 上发现：其 `dsh-typert-protocol` 读取 `ctx[Context.root]`，而自身锁文件解析出的 Cordis 4.1.0 没有这个静态成员，挂载 `dsh-llm` 时抛错。rc.5 解析到同一版 Cordis 且可正常装配。rc.1–rc.5 与 alpha.2 仍为 125/125；alpha.1 保持 `NOT_VERIFIED` 且不受支持。
- Source branch of PR #13 only; no merge, release, installation or Desktop restart is performed.
  仅为 PR #13 的源码分支，未合并、发布、安装或重启 Desktop。

## Alpha.2 compatibility candidate / 兼容候选 (2026-11-24)

- Import the runtime `CommandDefinitionId` from the public package root after the old `/brand` subpath was removed. Keep the existing rc.1–rc.5 ownership/catalog adaptation.
  运行时 `CommandDefinitionId` 改从公开包根导入，适配旧 `/brand` 子路径移除；保留已有 rc.1–rc.5 归属与目录适配。
- Compose the alpha.1+ auth service in integration fixtures. Only an absent target package is optional; missing entries and transitive dependencies stay visible, covered by negative fixtures.
  集成夹具挂载 alpha.1+ auth 服务；只允许目标包缺失，入口或传递依赖缺失继续抛错，并以负向夹具覆盖。
- Use Node 24.22.3 for CI and add a locked alpha.2 stock-host job alongside rc.1–rc.5. Prepare watcher candidates from the exact published host closure instead of mixing old vendor pins.
  CI 使用 Node 24.22.3，在 rc.1–rc.5 之外新增 alpha.2 原版宿主锁定任务；巡检按精确发布宿主准备依赖闭包，避免混装旧 vendor 固定版本。
- Source candidate only; no installed update, Desktop restart, tag or release is performed.
  仅为源码候选，未更新安装、重启 Desktop、创建 tag 或发布。

## Upstream compatibility automation / 上游兼容性自动化 (2026-11-22)

- Discover official Harness tags and releases hourly, including future RCs, and run isolated candidate regressions against exact versions. Keep fixed CI coverage on rc.1–rc.5; record executed-test evidence and distinguish incompatibility, unverified runs, and infrastructure errors.
  每小时发现官方 Harness tag 与 release，包含后续 RC，针对精确版本执行隔离候选回归；固定 CI 覆盖 rc.1–rc.5，记录真实测试证据，区分不兼容、未验证与环境故障。
- Deduplicate results and anomaly issues, close recovered issues, and allow an explicit manual notification run on main. PR runs have read-only permissions. Daily installations and published tags remain operator-managed.
  结果和异常 issue 去重，恢复后关闭；main 上可明确选择手动通知，PR 运行仅有只读权限。日用安装和发布标签仍由 operator 管理。

## 1.3.4 — Unreleased / 未发布 (2026-11-21)

- Add `/subagent-compact-all`, a no-argument entry point for the existing batch operation. It uses the stock UI path that releases the input box during execution; no application patch is required.
  新增无参数批量入口 `/subagent-compact-all`，复用原版 UI 在命令执行期间释放输入框的路径，无需修改应用源码。
- Await the full batch in the command handler so the host records its actual completion result. Authorization, capacity waiting, cancellation, per-target locks, and summary provenance stay on the shared batch path.
  命令处理函数等待整批完成后返回真实结果，授权、容量等待、取消、目标锁和摘要溯源均复用已有批量路径。
- Preserve `/subagent-compact` listing, single-ID compaction, and `all` / `--all` aliases with their input descriptor and existing host waiting behavior.
  保留 `/subagent-compact` 裸命令列表、单 ID 压缩及 `all` / `--all` 别名，保留其参数声明及宿主原有等待行为。
- This entry describes the source branch, not a published tag or an installed update. Validation status is tracked in [docs/VALIDATION.md](docs/VALIDATION.md).
  本条记录描述源码分支，不代表已发布 tag 或已更新安装；验证进度见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 1.3.3 — 2026-11-14 (Git tag / Git 标签)

- Adapt the rc.2 direct catalog through SessionQuery with disposal and explicit projection failures; preserve rc.1 listChildren and runtime ownership. No recursive descendants enter a direct-child batch.
  rc.2 通过 SessionQuery 读取直接子目录，确保释放并明确报告投影失败；保留 rc.1 的 listChildren 与运行时归属校验，不将孙级加入批量。
- Gate every rc.2 target before maintenance delivery using direct creator membership, exact Agent identity and live runtime tree ownership. Validate creator/target/local run identity at the synchronous start edge. Existing locks, idle waits, preset engines, bounded capacity admission and ALS cancellation remain in use.
  rc.2 维护消息发送前结合直接创建者、精确 Agent 身份与宿主树归属授权；同步 start 边沿校验父级、目标及本地 run 身份，保留锁、空闲等待、preset 引擎、容量回压与 ALS 取消。
- Extend stock activation fixtures and the installed-runtime runner to rc.1/rc.2. Add authorization and real direct-parent boundary regressions; CI uses two separate stock dependency trees. Historical 1.3.2 rc.1 evidence remains unchanged.
  迁移真实宿主夹具与 installed-runtime runner 以覆盖 rc.1/rc.2；新增授权和直接父级回归，CI 使用两套独立原版依赖，保留 1.3.2 的 rc.1 历史证据。
- Validation: the [post-merge CI run](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/43545680782) passed **110/110** on each of stock rc.1 and rc.2, with no failures or skips and both package dry runs passing. The earlier 109/109 runs on rc.1, installed App rc.2, and clean npm rc.2 remain historical evidence. Coverage includes the default-eight-slot 16-child checkpoint scenario.
  [合入后 CI](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/43545680782) 在原版 rc.1、rc.2 上各通过 **110/110**，零失败、零跳过，两套打包检查均通过。此前 rc.1、App 内置 rc.2、干净 npm rc.2 的 109/109 记录保留，覆盖默认 8 槽的 16 成员 checkpoint 续接。
- [PR #7](https://github.com/08mamba24/dsh-subagent-compactor/pull/7) merged and the annotated `v1.3.3` tag was pushed at `7117d438947f19fcc12abd374ce86746079031b9`. Install from the Git tag. No npm package, GitHub Release, daily installation update, or new native-window acceptance is included.
  [PR #7](https://github.com/08mamba24/dsh-subagent-compactor/pull/7) 已合入，注释 tag `v1.3.3` 已推送并指向 `7117d438947f19fcc12abd374ce86746079031b9`，可通过 Git tag 安装；未发布 npm 包、创建 GitHub Release、更新日用安装或声明新增原生窗口验收。

## 1.3.2 — Unreleased / 未发布

- Recheck residency before every resume attempt. A target restored by another message while waiting for capacity uses live compaction, without an extra maintenance wake. Runtime ownership and Agent identity checks still apply.
  每次恢复尝试前重查 live 状态；容量等待期间由其他消息恢复的目标转入 live 压缩，不插入维护唤醒，保留运行时归属与 Agent 实例检查。
- Distinguish the initiating send's start edge with Node AsyncLocalStorage. If another cold resume is ahead in the host's child lock, cancel only this attempt's unaccepted wake, join delivery, then wait for the external task's idle window. Caller cancellation and unrelated host errors remain visible; no host patch or new external dependency is required.
  通过 Node AsyncLocalStorage 区分本次发送的恢复事件。若其他冷恢复排在宿主 child lock 前面，仅取消本次尚未接纳的维护投递，收敛后等待外部任务的空闲窗口；调用方取消与其他宿主错误仍如实报告，无需宿主补丁或新增外部依赖。
- Regression: **92/92** tracked tests pass (unit 35, batch 40, integration 3, preset 14). Five new cases fail on 1.3.1. The stock queued-resume case keeps a fixed one-slot pool, proves the external reply persists before its summary, and accepts no maintenance wake.
  回归 **92/92**（unit 35、batch 40、integration 3、preset 14）；五条新增用例在 1.3.1 上失败。真实宿主排队恢复用例始终固定一个槽位，证明外部回复先落盘、随后压缩，且无维护唤醒被接纳。

## 1.3.1 — Unreleased / 未发布

- Fix capacity backpressure across batch, single-ID command, and model tool. Pre-start `ACTIVATION_LIMIT_REACHED` waits for public global `subagent/end` hints and retries host admission; a one-second probe covers rollback or capacity changes without an event. Live idle waits remain concurrent. No host limit is raised and no working child is terminated.
  修复批量、单 ID 命令和模型工具的容量回压：start 前的 `ACTIVATION_LIMIT_REACHED` 等待公开全局 `subagent/end` 后重新申请宿主准入，每秒补查覆盖无事件的回滚或容量变更；live 空闲等待保持并发，不提升宿主上限、不终止工作中的成员。
- Add `resumeCapacityTimeoutMs` (default 120000, integer range 1–600000) and explicit `capacity-timeout` outcomes. The budget applies only to waiting for admission; accepted summaries retain their normal lifetime. Cancellation/unload remove waits, listeners, and target locks. Only capacity refusals before start are retried; other failures remain visible.
  新增 `resumeCapacityTimeoutMs`（默认 120000，整数范围 1–600000）和明确的 `capacity-timeout` 回执。预算仅限制等待准入，不限制已经接纳的摘要；取消或卸载清理等待、监听和目标锁，仅重试 start 前的容量拒绝。
- Regression: **87/87** tracked tests pass on stock Harness `0.2.2-rc.1` with Node 24. The default-eight-slot, 16-settled-child test fails 8/16 on 1.3.0 and now persists all 16 summaries under one command and continues all 16 original IDs with their checkpoints. Additional cases cover shared-pool occupants outside the snapshot, reversed live windows, failed-summary slot release, real full-pool cancellation/timeout, competing batches, lost wakeups, and admission-only deadlines. Tests use temporary data and a loopback model; no daily Desktop deployment or new UI acceptance is implied.
  原版 Harness `0.2.2-rc.1`、Node 24 下 **87/87** 测试通过。默认 8 槽、16 个已结算成员的回归在 1.3.0 上失败 8 项，修复后一次命令持久化 16 份摘要，全部 16 个原 ID 续接请求均携带 checkpoint；另覆盖共享池外部占位、live 反序窗口、摘要失败后释放、满容量取消/超时、竞争批次、防丢唤醒和仅准入超时。均使用临时数据与本地模型，不代表日用 Desktop 已部署或新增 UI 验收。

## 1.3.0 — Unreleased / 未发布

This entry describes the `feature/resume-inactive-1.3.0` branch preview. No `v1.3.0` tag or release has been created; the published tag remains `v1.0.1`.

本条记录对应 `feature/resume-inactive-1.3.0` 分支预览。尚未创建 `v1.3.0` tag 或 release，已发布 tag 仍为 `v1.0.1`。

### Added / 新增

- `/subagent-compact all` now compacts settled continuable children too: each is resumed through the normal continuation lifecycle (one scoped `subagent/start` listener registered before a single maintenance wake message; `engine.compactNow` is called synchronously at the start edge, before the message is delivered), then the wake is answered by one normal turn. Live children keep their direct concurrent path; a mixed batch loses no item and double-wakes none.
  `/subagent-compact all` 现在也能压缩已结算的可续接子成员：每个成员通过正常续接生命周期恢复（先注册仅对该目标的 `subagent/start` 监听，再发送一条维护唤醒消息；在 start 边沿、消息投递前同步调用 `engine.compactNow`），随后唤醒消息由一轮正常对话回应。live 成员保持直接并发路径；混合批量不丢项、不重复唤醒。
- `/subagent-compact <id>` and the `compact_subagent` model tool gained the same settle-and-resume semantics (`resumed: true` is reported on success), so every surface agrees instead of reserving resume for the batch.
  `/subagent-compact <id>` 与 `compact_subagent` 模型工具获得同样的结算恢复语义（成功时报告 `resumed: true`），所有入口一致，不再把恢复能力留在批量专享。
- New batch outcome `nothing-compacted`: a run in which not a single target compacted is an explicit error and never an implied success. Settled non-continuable children (one-shot, external, unknown) are skipped up front with their mode and no wake attempt; `not-resumable` refusals surface the host's reason.
  新增批量结果 `nothing-compacted`：一项都没压成的运行按显式错误报告，绝不暗示成功。已结算且不可续接的成员（一次性、外部、未知）带模式预先跳过、不尝试唤醒；`not-resumable` 拒绝如实透出宿主原因。
- Configuration `resumeInactive` (default `true`); set `false` to restrict every surface to children that are live right now.
  新增配置 `resumeInactive`（默认 `true`）；设为 `false` 可将所有入口限制为仅当前 live 的成员。

### Behavior / 行为

- A mid-wait true reclamation (no live agent at all) falls through to one resume attempt; a same-ID instance swap during the idle wait still refuses conservatively with `not-resident` — the stale handle is never compacted.
- 等待空闲期间发生的真实回收（已无 live agent）会再尝试一次恢复；同 ID 被替换为另一个实例时仍按 `not-resident` 保守拒绝——绝不压缩过期句柄。
- Resuming is a real extra exchange, not a transaction: one summary request plus one wake-acknowledgment turn per resumed child; if the summary fails the delivered wake still runs and the receipt says so. The wake text only asks for a maintenance acknowledgment and forbids new work. Concurrent resumes share the no-cap batch policy; rate-limit failures are reported per item.
  恢复是真实的额外交互而非事务：每个被恢复成员一次摘要请求加一轮唤醒确认；摘要失败时已投递的唤醒仍会执行，回执如实说明。唤醒文本只要求维护确认并禁止新任务。并发恢复沿用无上限批量策略；限流失败逐项如实报告。

### Validation / 验证

- Four tracked suites pass **69/69** (46 baseline cases plus 23 added cases) on the clean pinned npm runtime tree with Node 24: unit 35, batch 24, integration 3, preset 7. Red-first evidence: the two new preset resume cases fail against the previous live-only `d079037` HEAD and pass on this branch; the resume-path integration case covers the plain Host plane, the two settled-children preset case proves both summaries durable with the same command provenance and a later same-id continuation seeing the committed checkpoint, and the mixed case proves one wake for the settled child and none for the live one. Review regressions cover cancellation in the resume admission gap without an unhandled rejection and keep resumed compactions a true subset of successful compactions.
  四份受跟踪测试在干净的固定版本 npm 运行时树上以 Node 24 通过 **69/69**（46 项基线加 23 项新增用例）：unit 35、batch 24、integration 3、preset 7。先红后绿证据：两条新增 preset 恢复用例在上一 live-only `d079037` HEAD 上失败、在本分支通过；恢复路径集成用例覆盖普通 Host 平面；双已结算成员 preset 用例证明两份摘要持久化且溯源同一命令、后续同 ID 续接可见 checkpoint；混合用例证明仅结算成员被唤醒一次而 live 成员无需唤醒。审查回归还覆盖恢复接纳间隙取消不产生未处理拒绝，以及恢复后压缩数量始终为成功压缩数量的真实子集。

## 1.2.0 — Unreleased / 未发布

This entry describes the `feature/live-only-1.2.0` branch preview. No `v1.2.0` tag or release has been created; the published tag remains `v1.0.1`.

本条记录对应 `feature/live-only-1.2.0` 分支预览。尚未创建 `v1.2.0` tag 或 release，已发布 tag 仍为 `v1.0.1`。

### Added / 新增

- `/subagent-compact all` (alias `--all`) takes one snapshot of the parent's direct-child catalog and attempts live-child compaction concurrently. Results retain catalog order and report each item's outcome and aggregate counts.
  `/subagent-compact all`（别名 `--all`）读取父会话的直接子成员快照，并发尝试压缩 live 子成员，按目录顺序回填逐项结果和汇总计数。
- Listing marks children as `live` or `persisted (not loaded)`. A listed record is not a reservation or proof that it remains compactable.
  列表标注 `live` 或 `persisted (not loaded)`；列出记录不代表预留了目标，也不保证随后仍可压缩。

### Compatibility / 兼容性

- Validated on stock Harness `0.2.2-rc.1`. Install and enable the plugin; no Desktop application-source or bundled-runtime patch is required.
  已在原版 Harness `0.2.2-rc.1` 上验证。安装并启用插件即可，无需修改 Desktop 应用源码或内置运行时。
- This preview supports live direct children only. Compared with the **unreleased 1.1.0 cold candidate**, it omits cold restoration, the `compact_all_subagents` model tool, `report <batch-id>`, and the separate durable batch receipt store. Only `compact_subagent` remains as a model tool; batch compaction is a command.
  本预览仅支持 live 直接子成员。相比**未发布的 1.1.0 冷压缩候选**，不提供冷恢复、`compact_all_subagents` 模型工具、`report <batch-id>` 或独立持久化批量回执库；模型工具仅保留 `compact_subagent`，批量由命令提供。
- Historical host patches and cold-candidate records remain in the repository for reference. The preview does not read, migrate, or delete existing candidate receipt records. Successful compaction summaries still persist through host session storage.
  旧宿主补丁和冷压缩候选记录保留作历史参考。本预览不读取、迁移或删除已有候选回执记录；成功的压缩摘要仍通过宿主会话存储持久化。

### Batch behavior / 批量行为

- All attempts start together so later catalog entries can wait for their own idle windows. There is no concurrency cap; model rate limits are reported as item failures. Reclaimed children are skipped. `completed` can include skips, so inspect the item results and `compacted` count.
  所有尝试同时启动，使排在后面的成员也能等待自己的空闲窗口。批量不设并发上限，模型限流会体现为单项失败；已回收成员会被跳过。`completed` 允许包含跳过项，请同时查看逐项结果和 `compacted` 数量。

### Validation / 验证

- Four tracked suites pass **46/46** on both the installed runtime tree and a clean, pinned npm runtime tree. CI runs `npm ci --include=dev`, `npm test`, and a package dry run with Node `24.18.0`.
  四份受跟踪测试在安装包模块树和干净的固定版本 npm 模块树上均 **46/46 通过**；CI 使用 Node `24.18.0` 执行依赖安装、测试与打包检查。
- The bundled Web UI compacted two live children with one user-source command. Both summaries were read back from disk; both original IDs continued, and later HTTP requests contained the committed checkpoint. The model was synthetic and local; this does not establish native Electron-window acceptance or real-model summary quality.
  安装包自带 Web UI 通过一条用户来源命令压缩了两个 live 子成员；两份摘要均从磁盘读回，两个原 ID 均续接，后续 HTTP 请求包含已提交 checkpoint。模型为本地合成服务；此结果不代表原生 Electron 窗口验收或真实模型摘要质量。

See [English usage](README.md), [中文使用说明](README.zh-CN.md), and the [acceptance record](docs/acceptance/2026-11-10-live-only/acceptance.md).
