# Bug 分析报告

## 一、错误现象

1. 官方 `dsh-v0.2.3-alpha.1` 发布后，main `cdbbef4f2e7bbe47e60fe9e319eb103b01ac59f9` 的手动巡检 [44985777841](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/44985777841) 于 2026-11-22 04:36 UTC 启动。依赖安装 2 秒完成，测试子进程此后不退出；25 分钟后 job 被取消。
2. 只留下 `PREPARED` 报告，aggregate 正确判为 `complete=false` / effective `INFRA_ERROR`，但通知 job 被条件跳过，没有异常 issue。
3. 输入资料完整：原 CI report/summary、job 日志及本地隔离依赖探针；没有真实用户会话或模型凭据。
4. 这是原巡检实现对首次新版本故障的后续修复，不是 npm 发布、目录同步、日用安装或 alpha.1 插件适配。

## 二、根因分析

1. 自顶向下追踪：`upstream-compat.mjs` 用无期限的同步子进程等待测试退出，同时缓存 stdout/stderr；上层 Actions 超时只能中止脚本，脚本无法写出终态，过程日志也被遮住。
2. 通知仅接受 aggregate `complete=true`，因此将其最需要报告的中间/缺失报告排除。直接转发原始报告还可能把错误 SHA 的健康结果送进通知。
3. 本地真实 alpha.1 探针暴露 `ERR_PACKAGE_PATH_NOT_EXPORTED`：插件仍导入已移除的 `@deepseek-ai/dsh-commands/brand` 子路径。多个测试加载失败后进程继续存活。该加载错误解释了本地失败，但不构成完整兼容性验收。原 first-failure 规则还会漏掉 `Error [CODE]:` 行。
4. 首轮独立审查发现同类缺口：删除 `complete` 条件仍保留隐含 `success()`；零工件下载不创建目录；无归属/数量不符的报告集合缺少全局故障；三个串行上限 8+10+10 超过同一个 25 分钟 job。前两项仍会漏报，第三项会误关闭已有异常，第四项会使终态晚于宿主取消。

## 三、最小化 Diff 格式修复补丁

- 子进程实时转发输出；依赖锁解析、安装和回归分别默认 6 分钟，同一个 25 分钟 job 合计最多 18 分钟，剩余 7 分钟给 setup/cache/报告上传等步骤。`--timeout-ms` 只允许缩短相应预算。
- 超时或中断终止 POSIX 子进程组，保留已有输出并写终态 `INFRA_ERROR`；不得把超时当作兼容。
- 保留 raw 报告和失败 gate，另从官方发现目标生成经过核对的通知记录。下载目录 ENOENT 按零报告处理，其余 I/O 错误继续抛出。中间/缺失/错误 SHA/额外报告变成这些目标的监控故障；无归属、原始报告数量或目标数量不符作为全局验证故障，不能转发未经核对的健康结果。
- 通知显式使用 `always()`，覆盖失败/取消的上游依赖，同时仍限 main 的 schedule 或显式 manual notify、候选非空、aggregate 成功，仍在独立 issue-write job；保留原指纹去重与恢复逻辑。
- coded Error 保留为首个诊断。`index.js`、包依赖及宿主均未修改。

对应的工作流差异：

```diff
diff --git a/.github/workflows/upstream-compat.yml b/.github/workflows/upstream-compat.yml
--- a/.github/workflows/upstream-compat.yml
+++ b/.github/workflows/upstream-compat.yml
@@ -227 +227 @@
-    if: (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.notify)) && github.ref == 'refs/heads/main' && needs.discover.outputs.has_candidates == 'true' && needs.aggregate.outputs.complete == 'true'
+    if: always() && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.notify)) && github.ref == 'refs/heads/main' && needs.discover.outputs.has_candidates == 'true' && needs.aggregate.result == 'success'
```

完整执行器、分类器及通知变更在同次提交中，可直接按 Git diff 审查。

## 四、防回归测试用例

- 原实现新增 5 项负控全部失败，分别命中 PREPARED 未结算、工作流抑制通知、PREPARED/缺失/错误 SHA 未告警。额外报告与 coded Error 另各有一次红控。
- 首轮 Node 24 watcher **32/32**，零失败/取消/跳过/TODO。挂起探针含真实孙进程写 heartbeat；命令超时后 heartbeat 不再增长，且报告保留原 coded Error。
- 原版 rc.1 五套完整回归 **116/116**；产品代码未改，其他固定版本由 PR CI 再核。
- 最终 runtime 代码 `17a4aa7194505f0597acfa37b453af327ba32ee7` 的真实 alpha.1 诊断使用独立 npm 依赖、临时 DSH 存储和 loopback 合成模型。10 秒每命令预算验证了真实加载错误、过程日志和终态写入；结果 **INFRA_ERROR**，不是通过。
- YAML 解析与 source/docs whitespace 检查通过；原始 `.log` 不做 whitespace 重写。
- 复审前实现 `857490646c1fac2eadcc4688bc0aec6ac306f823`：新增七个场景先在 `d6fed785ead6f840fd5dbdc534cb769dbad2b54b` 上运行，**六红、一项健康对照通过**。失败/取消祖先无法投递、缺目录 ENOENT、无归属及数量不符误关 issue 均命中预期失败；串行实验 15,757ms 才写终态，晚于缩时外层 15,000ms。原始证据见 `r2-red.log`。
- 修复后完整 watcher **39/39**，零失败/取消/跳过/TODO，见 `r2-green.log`。同一串行实验使用 600ms 对应生产一分钟，仅替换复制版 CLI 的三个时间常量；慢准备、慢安装均实际完成，挂起回归以 `INFRA_ERROR` 终结，终态耗时 **10,321ms < 15,000ms**。生产没有新增测试开关。
- 新聚合→通知回归调用真实脚本及只记录调用的 fake-gh：缺目录、无归属、数量不符均更新已有 OPEN issue 为 `INFRA_ERROR`，不调用 close；完整健康报告仍能 close。失败 gate 维持红色。
- 工作流回归从实际 YAML 提取 DAG 和条件，按 GitHub 的默认 `success()`/传递依赖语义执行失败、取消两条链，并核 main/event/notify/候选/aggregate 门槛。它是平台语义模型，不冒充 GitHub 上的失败依赖链实跑。[官方状态函数](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)、[官方 needs 语义](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)。零工件不建目录来自 [download-artifact@v4 源码](https://github.com/actions/download-artifact/blob/v4/src/download-artifact.ts)。
- 首轮精确受审 HEAD 的远端 [44989017838](https://github.com/08mamba24/dsh-subagent-compactor/actions/runs/44989017838) 已结束：rc.4/rc.5 COMPATIBLE，alpha.1 在 10 分钟上限返回 `INFRA_ERROR/runtime regression timed out`，保留真实 `ERR_PACKAGE_PATH_NOT_EXPORTED`，aggregate 成功且 gate 失败。通知因 PR 权限边界跳过。`r1-ci-summary.json` 是未改动的原始工件；这不替代 R2 合入后的 main 通知验收。

同型失败审计：不变量是“已发现目标的故障仍可投递；只有整组身份、数量和执行证据有效才允许恢复；终态写入预算必须早于宿主取消”。已扫本次 diff 的三个命令上限、aggregate 计数/归属/目标/SHA/证据校验、notify/gate 条件及 notifier 的去重/重开/关闭路径。R2 只新增一个 ENOENT 特判 catch，其余错误继续抛出；没有新增版本回退、重试链或多层内容替代。自动 fallback 检测脚本被本机 runtime 保护拦截，未计为自动通过；以上是人工 diff 分析。

复跑：

```sh
node --test test/upstream-compat-watch.test.mjs
node scripts/test-installed-runtime.mjs --modules /absolute/stock-rc1/node_modules
```

## 五、预防建议与剩余边界

1. 子命令必须在 job 的总预算前返回，故障 gate 与故障通知分别判断；不通过删除失败 gate 来恢复告警。
2. 任何健康判断必须依赖相同目标/SHA 的完整执行证据。无效集合应告警，不能关闭已有异常。
3. 本记录不证明已观察到 GitHub 的第一次 schedule 触发；自动调度仍需独立核验。原 CI 的 main 通知被跳过，修复后的真实 main 通知也仍待合入后验证。
4. alpha.1 的导入变更及后续运行契约尚未适配。此修复不承诺新版本兼容，也没有发布 npm、tag、Release 或改变日用安装。
