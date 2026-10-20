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

## Round-6 PR-1（Gate-v4）

- 新配置：`gatePolicy: v4 | v3`（默认 v4；v3 仅供归档 replay）、`controlReplicates`（默认 2）、`maxAppliedEdits`（默认 1）。
- Gate-v4：admission ≠ certification；2 个真实 recovery control；deadband；tokenCost 只做 25% guard；control 缺失/不稳定 → `low-evidence` fail closed。
- 仅 `set-persona-prefix` 可在 probe 内模拟（agent-scoped `systemPrompt.section`）；其余 canonical 编辑 `applicability:'unavailable'`，等待离线 applier。
- Gate-v4 fail-closed：`applicability` 缺失即 `unavailable`；空 transcript trial 无效；completion 由 assistant 输出推导，且 completion 回归会拒绝。
- 白名单/deny lexicon/自调裁判键见 `src/admissibility.ts`；`PROPOSE_SYSTEM` 已改为 canonical operations。

## 验证

```bash
npm run build && node --test test/verify.mjs   # 21 项（含 admissibility、gate-v4、归档 replay、v4 正向路径）
npm run stage0:r6                              # live Gate-v4 负向验收（需要 dsh 0.2.1 CLI）
npm run stage0:r6:positive                     # live Gate-v4 正向验收
```
