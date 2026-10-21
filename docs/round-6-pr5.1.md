# Round-6 PR-5.1：meta 独立重算 evaluation 统计

- 日期：2026-10-21
- 基线：PR-5（`46d5a4e`）
- 触发：release review 发现 meta 只校验 `reportHash/providerClass/source/edit`，未重算 `perTask ↔ b/c/N/delta/p/verdict`；applier 拒绝的伪造报告仍可能进入负经验
- 状态：**已实现并验收**

## 1. 修复内容

新增 `packages/harness2-meta-recursion/src/evaluation-verify.ts`（自包含，不 import tools/，保持 meta 包可发布）：

- 冻结 OEP/v1 规则：`minDelta 0.15`、`maxP 0.05`、`toolFailureSlack 1`、`tokenRatioMax 1.25`、`maxDriftDiff 2`、inert/null 必须拒绝；
- 从 `report.perTask` 独立重算：
  - 每 task 必须恰好有 C/R/I/T 四臂且字段完整；
  - b=#{T=1,C=0}、c=#{T=0,C=1}、N=perTask.length、delta=(b−c)/N；
  - 精确单侧 McNemar p；
  - secondary（toolFailures/tokenCost 中位数）、drift、mount/schema、inert 检查；
  - `verdict` 必须等于重算值（accept/reject/inconclusive）；
- 逐项比较报告中的 `b/c/N/delta/p/inertControlRejected/nullProxyRejected/mountSchemaFailures/drift/inert/verdict`；
- `reportHash` 由独立 `stableStringify` 重算；
- 任何不一致 → `onError('verification-report-invalid')`，不写经验。

meta ingest 只使用重算后的 `stats` 构造 `verification`，不再信任报告顶层统计。

## 2. 测试

`npm run verify:meta` → **16/16**：

- 原有 14 项更新为完整 `perTask` 报告；
- 新增 15：伪造 b/delta、p、verdict/inert、空 perTask 全部不写经验；
- 新增 16：accept/reject 两方向由 perTask 重算得到正确 b/c/verdict。

`npm run verify` → **52/52**（task 31 + meta 16 + loader 5）。

## 3. 残余信任边界

- `providerClass:'real'` 仍是本地自声明；本修复防“统计自洽的伪造/损坏报告”，不防本地操作者伪造整个 real 评估（无签名/CI 产出证明）。
- 如果要密码学级认证，需要 eval/applier 产出签名报告或接入可信 CI；不在 PR-5.1 范围。
