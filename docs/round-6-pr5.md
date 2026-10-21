# Round-6 PR-5：meta verified-experience + legacy quarantine

- 日期：2026-10-21
- 基线：PR-4.1（`75c3069`）；`verify` 50/50、`verify:apply` 9/9、`verify:eval` 6/6
- 状态：**已实现并验收**；Round-6 证据链闭环

## 1. 数据流

```
real-provider eval report (harness2-eval/v1, providerClass:real)
  → tools/harness2-eval writes eval/<batchId>/report.json (edit + source)
  → eval/index.jsonl (harness2-eval-index/v1: reportHash/provider/verdict/fold)
  → meta at load: index → report → lightweight hash/provider/provenance check
  → EXPERIENCE.md entry with verification:harness2-verification/v1
  → queryPriors (verified only)
```

compose/applied 与 compose/rejected 只作诊断：meta 保留监听与 `recordApplied/recordRejected` 导出，但立即 `onError('gate-decision-not-evidence', {cycleId})` 并返回，不写 EXPERIENCE。旧路径已删除，不保留兼容。

## 2. 验证条目

- `ExperienceEntry.verification`（additive）：
  `{schema, reportHash, batchId, revisionId, profile, providerClass:'real', verdict:'accept'|'reject', b, c, N, delta, p, tokenCostSource}`。
- 只有 `providerClass:'real'`、index/report `reportHash` 一致并通过轻量重算、`source` 存在且不缺失的评估才写入。
- `verdict:'accept'` → positive `adoption:'accepted'`；`'reject'` → negative `adoption:'rejected'`。
- `outcome.trials=N`；`metricDelta` 由 b/c 构造（successRateDelta/completion）；`observedIn=['eval:<batchId>']`；`condition.failurePattern` 来自**原始 composed source evidence**（`probe/completed.evidenceSummary`），不是 eval 任务文本。
- 同一 `reportHash` 幂等（重复 index 行/重启不重复写）。
- fake-calibration、inconclusive、reportHash 不一致、sourceMissing → 不写，诊断码：
  `verification-provider-invalid` / `verification-hash-mismatch` / `verification-source-missing` / `verification-report-invalid` / `verification-eval-holdout`。

## 3. Provenance 补充

- applier `plan` 沿 ledger `previousSnapshotRef` 链（回退到同 taskId 最近 probe）找到 `probe/completed`，把 `source:{taskId,cycleId,failurePattern,evidenceSummaryHash}` 写入 plan/manifest；不可得则 `sourceMissing:true`。
- manifest 增加 `edit`（candidateId/component/operation/contentHash）与 `appliedComponents`。
- eval report 增加可选 `edit`/`source`/`sourceMissing`/`tokenCostSource`；共享 verify 接受 additive 字段。
- eval CLI 运行后原子 append `eval/index.jsonl`（schema `harness2-eval-index/v1`）。

## 4. Legacy quarantine

- 无 `verification` 的旧条目（含 Stage-0 adversarial）默认**隔离**：不参与 `queryPriors`、不计入 `totalMatched`；文件不删除/不迁移。
- `enableLegacyExperience:true` 时仍可注入，但不伪造 verification。
- `taskDomain:'eval-holdout'` 条目永不注入。
- 新条目必须带 verification 才能进入 priors。

## 5. appliedComponents / rollback

- meta 启动读取 `applyStatePath`（默认 `<DSH_HOME>/apply/active.json`）：active 状态的 `appliedComponents` seed 到 query 的已应用集合；active 中的 `contentHashes` 与 journal `rolled-back` 的 revisionId 进入驱逐集合。
- 被 rollback 的 accepted 经验从 priors 排除（保留文件审计语义）。
- applier `active.json` 增加 `status`、`contentHashes`、`appliedComponents`。

## 6. 配置（additive）

`evaluationsPath`（空 → `<ledger dir>/eval/index.jsonl`）、`ledgerPath`、`applyStatePath`（空 → `<DSH_HOME>/apply/active.json`）、`enableLegacyExperience`（默认 false）。

## 7. 测试与验收

- `npm run verify:meta`：14/14
- `npm run verify`：50/50（task 31 + meta 14 + loader 5）
- `verify:apply` 9/9、`verify:eval` 6/6
- pr3/pr4 integration、stage0 v3 20/20、stage0:r6 正/负向 PASS（最终报告附输出）

## 8. 边界与残余风险

- providerClass 仍是本地自声明：不能密码学证明报告确实来自真实 provider；PR-4.1 的 hash/统计重算只能防篡改，不能防伪造“real”标签。生产上需操作者信任边界/未来签名。
- eval real runner 的 token/step 是近似估计；不足以作为精细效能证据。
- legacy quarantine 只过滤不迁移；旧条目仍保留在文件中供审计。
- round-6 未改 ledger v3、bus、confidence v3、Gate-v4、applier 安全语义。
