# harness2-task-recursion

任务级递归插件（dsh 0.2.1-rc.2 / Cordis 4，**第三轮冻结契约**）。

## 入口契约

```ts
export const name = 'harness2-task-recursion'
export const inject = ['tools', 'llm', 'agents']
export const Config = Schema.object({ ... })
export function apply(ctx, config)
```

## 循环

```
失败信号（request-error / 同工具连续失败）
  → 同步调度后台 cycle（去重 + cooldown）
    1. Propose  ctx.llm.stream（失败重试一次；失败 → onError('propose-failed')，不伪造事件）
    2. Probe    每候选一个隔离子智能体；TrialRecord 携带 candidateId/component/operation/editContentHash
    3. probe/completed  先 append 账本 v3，成功后 emit（schema 校验失败/账本失败 → 不 emit）
    4. Compose  observeOnly → cost-limit → low-evidence → regression → apply
    5. compose/*  append v3 后 emit；applied 携带 appliedEdits（与 appliedCandidateIds 一一对应）
    6. 下一个 pre-step 仅 applyMode=pre-step-patch 时同步应用 pendingPatch
```

## 第三轮要点

- `TrialRecord` 元数据三个字段必填；缺失 → `onError('trial-metadata-incomplete')` 并拒绝 `probe/completed`（Q1）。
- `ProbeMetrics.tokenCostSource`：Propose 用 usage chunk；baseline/trial 优先 `tokenMeter`，否则估算；同一 metrics 单一来源（Q4）。
- 账本 v3 envelope；`readLedgerTail` 接受 v2|v3 并内存映射，v2 文件不重写（Q7）。
- `ComposeRejectedPayload.rejectedCandidateIds` 按 reason 构造，并保证 ∈ `trials`（Q3）。
- 组件名来自 `src/constants.ts`（八类冻结），与 meta 包逐字节相同（R3-7）。
- **第四轮**：Propose 两次失败 → 终态事件 `propose/failed`（`reason ∈ llm-error/schema-invalid/hash-mismatch/component-invalid`、`attempts=2`、`lastError`、可选 baseline），账本 `event='propose/failed'`，append 成功后才 emit 且与同 cycleId 的 probe/compose 事件互斥；`rejectedCandidateIds` 只取 trials 中出现过的 id（R4-2）。
- `TODO(ROUND2_APPLY)`（运行时补丁 API）、`TODO(ROUND2_SANDBOX)`（Probe 沙箱）保留。

## 验证

```bash
npm run build && node --test test/verify.mjs   # 15 项（含 propose/failed 与 R4-2 用例）
```
