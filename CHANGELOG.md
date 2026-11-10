# Changelog / 变更日志

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

- Four tracked suites pass **67/67** (baseline 46 unchanged) on the clean pinned npm runtime tree with Node 24: unit 35, batch 23, integration 2, preset 7. Red-first evidence: the two new preset resume cases fail against the previous live-only `d079037` HEAD and pass on this branch; the resume-path integration case covers the plain Host plane, the two settled-children preset case proves both summaries durable with the same command provenance and a later same-id continuation seeing the committed checkpoint, and the mixed case proves one wake for the settled child and none for the live one.
  四份受跟踪测试在干净的固定版本 npm 运行时树上以 Node 24 通过 **67/67**（46 项基线不变）：unit 35、batch 23、integration 2、preset 7。先红后绿证据：两条新增 preset 恢复用例在上一 live-only `d079037` HEAD 上失败、在本分支通过；恢复路径集成用例覆盖普通 Host 平面；双已结算成员 preset 用例证明两份摘要持久化且溯源同一命令、后续同 ID 续接可见 checkpoint；混合用例证明仅结算成员被唤醒一次而 live 成员无需唤醒。

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
