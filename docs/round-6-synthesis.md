# Arena synthesis — Round-6 设计（Offline profile-patch 闭环 + gate 修复）

**Shape**：3 个 candidate 同题独立设计；判定规则 **rank all**（6 项 rubric）。
**Runner 偏差**：pstack `arena runners`/`cross-judge pool` 行缺失，且 `subagent` 工具无 model 参数 → 3 个 candidate 与 cross-judge 均继承父模型（未做跨模型族），已记录。
**产出**：base = candidate-1；grafts 来自 candidate-2/3；合成设计见 [`round-6-design.md`](round-6-design.md)。

## 评分（parent 与 cross-judge 一致）

| Candidate | D1 gate | D2 loop | D3 contract | D4 safety | D5 test | D6 impl | Total |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **c1** | 5 | 5 | 4 | 3 | 5 | 3 | **25/30** |
| c2 | 5 | 5 | 2 | 4 | 4 | 4 | 24/30 |
| c3 | 4 | 4 | 3 | 4 | 4 | 4 | 23/30 |

## Base = candidate-1

选择理由：**冻结面最小**——ledger 保持 v3、bus 保持 4 事件、`AppliedEdit`/reason union/confidence v3/组件常量不变；增量只有可选 `controlMetrics?`/`gate?`、内容寻址 sidecar、离线 CLI。且它是唯一同时提供“归档 Stage-0 replay 20/20 → v4 0/20 + 离线 apply spike”的设计。

## Grafts（已合入合成设计）

**来自 candidate-2**
1. **in-probe persona treatment**：`child.agent.ctx.get('systemPrompt')?.section({name:'deployment:persona-prefix',...})`（真实 agent-scoped 机制；同名 shadow 全局 section）。仅对可模拟的 persona 编辑启用；不可模拟 → `applicability:'unavailable'` + `edit-not-in-effect`，不假测量。
2. **verification hardening**：`--dump-config` 断言不含 `skipping profile bundle`；必须跑一次 smoke session（bogus `toolOrder` 通过 dump、在 assembly 失败）；review token = `sha256(plan)`。

**来自 candidate-3**
1. **verified experience + quarantine**：meta 不再从 `compose/*` 学习；只从 `evaluations.jsonl`/committed revision 写经验；无认证旧条目默认隔离；`eval-holdout` 不注入；`appliedComponents` 从 apply state seed；rollback 驱逐。
2. **canonical `PatchSpec` + `PROPOSE_SYSTEM` 重写**为四类可渲染 operation；`set-harness2-config` 的键白名单**禁止** `metricWeights`、`gateMinDelta`、`placeboMaxDelta` 等“改自己的裁判”的键。

## 拒绝与 disqualify

- **c2 不作 base**：`apply/committed` 的 bus re-emit + 新增 meta listeners 违反冻结的 4 事件总线；且 ledger v4、必填 metrics、`baselineMetrics` 语义重定义、10 个新 reason —— 这是契约修订 + 新传输，不是 additive。
- **c3 不作 base**：`completion` 语义重定义、§7 负经验路径退役、`trials` 含义变化；spike 允许 candidate 通过 `set-harness2-config` 调自己的 gate 阈值（一行修复后可再考虑）。
- 二者作为 graft 源仍然有效；其证据独立成立。

## 对 judge 指出的 must-fix 的处理

| Judge must-fix | 合成处理 |
| :-- | :-- |
| c1 RCA 证据 tautological | 合成设计明确“归档 ledger 无 control 臂”；replay 中降级为算术检查并打标；真实 RCA 由 `stage0:r6` live 运行验收 |
| c1 tokenCost 单位不一致 | Gate-A 排名移除 tokenCost；改为 raw-token 的 25% guard；spike 中新增该 fixture（结果 PASS） |
| c1 meta 继续从 decision 学 | 采用 c3 的 verified-experience：`recordApplied/recordRejected` 变诊断 no-op；只从 evaluation/committed 学；旧条目隔离 |
| c1 applier/ledger 边界矛盾 | 合成设计改用 **sidecar journal**（`harness2-apply/v1` / `harness2-eval/v1`），不扩展 `LedgerEnvelopeV3.event`，applier 不 import 插件源码 |
| c1 `session.lock` 弱 | 明确它只是 advisory；写入正确性靠 `withFileLock(patch)`，profile-global 仍需人工 review |
| c3 Stage-0 arm A 不是 gate 测试 | 合成设计把 stage0-v2 改为四臂，并明确“旧 fixture 是合法 JSON，不会在 parseProposal 被拒，必须在 admissibility 拒” |
| placebo 操作化不一致 | Gate-B 采用四臂：C（基线）/R（漂移重跑）/I（inert patch 阴性对照）/T（候选）；T 必须同时超过 C 与 I |

## 验证（Phase F）

- `node e2e/round6-spike/gate-replay.mjs` → **PASS 19/19**（v3 20/20 → v4 admission 0/20；token guard；legacy quarantine；RCA 打标）。
- `node e2e/round6-spike/run-spike.mjs` → **PASS 13/13**（隔离 profile、persona A/B wire、字节级 rollback、仓库隔离）。
- 详见 [`round-6-verification.md`](round-6-verification.md) 与 `e2e/round6-spike/`。
- 未验证项（live RCA、HMR live、其他 renderer、Gate-B 真实批次）在验证文档中明确标注，不冒充已证。

## Dropouts / 限制

- 无 candidate 掉线；3/3 完成。
- 没有跨模型族评委（工具无 model 参数），评委与 candidate 同族 → 对比可能偏同质；已用 parent 独立复核 + 实际 spike 运行补强。
- c1 的原 spike 中 RCA 结论已被降级；合成设计不继承其夸大表述。
