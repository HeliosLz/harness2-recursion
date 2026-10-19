# harness2-meta-recursion

Harnessing 级递归插件（dsh 0.2.1-rc.2 / Cordis 4，**第三轮冻结契约**）。

## 入口契约

```ts
export const name = 'harness2-meta-recursion'
export const inject = ['llm']
export const Config = Schema.object({ ... })
export function apply(ctx, config)
```

只监听四个结构化事件：`probe/completed`、`compose/applied`、`compose/rejected`、`propose/failed`。
其中 `propose/failed` **只做诊断日志**：不提炼经验、不计入正负经验、不参与 confidence、不写 EXPERIENCE.md。

## 门面（第二轮签名不变）

```ts
ctx.provide('harness2Experience', Object.freeze({ ready, queryPriors }))
```

`queryPriors`：同步只读；OR 匹配；`appliedComponents` 过滤；**positive 用 `minConfidenceToInject`（0.4）、negative 用 `minNegativeConfidenceToInject`（0.3），互不交叉**；`totalMatched` 为过滤后数量；排序 confidence 降序 → 最新 observed 序降序 → id；深冻结副本。

## 第三轮要点

- **归因**：反射输出必须含 `edit.candidateId`；meta 在 `appliedEdits` / `trials` 中定位并严格比对 component/operation/contentHash；不一致 → `onError('reflection-edit-mismatch')` 且**拒绝写入**；写入 EXPERIENCE.md 的 edit 字段**永远取自来源载荷**（R3-1/2/3、Q2）。
- `rejectedCandidateIds` 仅 `regression` 分支消费，每个 id 各写一条负经验；非 regression reason 一律不写（Q3）。
- **confidence v3**：`trials=0 → 0`（且不写入）；`base=0.6/0.5`；`evidenceFactor=0.5+0.5·min(1,trials/3)`；`repeatFactor=1+0.1·min(4,samePattern)`；`estimated` 乘 0.9（Q4/Q5）。默认配置下两 trial 负经验 = 0.417，可注入。
- **组件迁移**：八类冻结名；7 项旧名映射 + `migratedFrom`；未知组件跳过并 `onError('unknown-component')`；移除 `workflow-control` 回退（R3-7）。
- **第四轮**：`ExperienceEntry.outcome.tokenCostSource`（必填）与 `migratedFrom?` 正式纳入 entry schema（R4-3）；加载重算 confidence 时 sourcePenalty 生效；`propose/failed` 仅诊断。
- 文件完整性：人类文本转义 `<`、加载重算 confidence、损坏文件先 `.backup`、容量淘汰写回。

## 验证

```bash
npm run build && node --test test/verify.mjs   # 14 项
```
