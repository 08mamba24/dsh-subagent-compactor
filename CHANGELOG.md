# Changelog / 变更日志

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
