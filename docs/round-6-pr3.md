# Round-6 PR-3：Offline profile-patch applier

- 日期：2026-10-21
- 基线：PR-2 + candidateId guard（`0486415`，`npm run verify` 50/50）
- 状态：**已实现并验收**；未进入 PR-4/5
- 工具：`tools/harness2-apply/`（独立纯 JS `.mjs` + JSDoc，不 import task/meta 源码）

## 1. 命令与状态机

```bash
node tools/harness2-apply/bin/harness2-apply.mjs plan --profile <p> --ledger <l> [--edits <d>] [--cycle <id>] --cli <dsh bin.js>
node tools/harness2-apply/bin/harness2-apply.mjs preflight --rev <rev> [--smoke-cmd "<shell>"] --cli <dsh bin.js>
node tools/harness2-apply/bin/harness2-apply.mjs apply --rev <rev> --token <planToken> --allow-unevaluated --yes
node tools/harness2-apply/bin/harness2-apply.mjs verify --rev <rev> [--smoke-cmd "<shell>"]
node tools/harness2-apply/bin/harness2-apply.mjs rollback --rev <rev> [--force]
node tools/harness2-apply/bin/harness2-apply.mjs status
```

- **plan**：读 ledger 最后一条（或 `--cycle`）`compose/applied` → 用 `appliedEdits` 为权威元数据 → 从 `<edits>/<hash>.json` 取 body（hash/metadata guard）→ `--dump-config` 读 composed rows → 渲染 managed block → 写 `<editsDir 同级>/apply/revisions/<rev>/{manifest,plan,patch}.yml` + `$DSH_HOME/apply/revindex.jsonl`。
- **preflight**：复制 profile 到临时 DSH_HOME（符号链接解析为绝对路径，避免 naive copy 的 `skipping profile bundle`）→ 写入 rendered patch → `--dump-config` 断言 exit 0、无 `skipping profile bundle`、目标值可见；`toolOrder`/persona-suffix 需显式 `--smoke-cmd`，否则拒绝 `smoke-required`；写 `preflight.json`。
- **apply**：校验 token/preflight/basePatchHash/renderedPatchHash；要求 `--yes` 与 `--allow-unevaluated`（PR-4 前受控入口）；备份 byte 级 → 文件锁 + 原子写 → readback hash；写 `active.json` + `journal.jsonl`；reload 只报 `restart-required` 或 `hmr-pending-human-confirm`，**不声称 live**。evaluation 固定 `not-run`。
- **verify**：当前 patch hash 必须等于 renderedPatchHash；重新 dump + 目标值断言 + smoke（如需）。
- **rollback**：当前 patch 被外部改动时默认拒绝（`--force` 才恢复）；备份字节原子写回并校验 `basePatchHash`；重复 rollback 幂等（`alreadyBase:true`）。

退出码：0 成功；1 用户/策略错误（结构化 `{ok:false,code,error}` 到 stderr）；2 内部异常。

## 2. Renderer allowlist（PR-3）

| component/operation | 目标 | smoke |
| :-- | :-- | :-- |
| system-prompt/set-persona-prefix | row `system-prompt`.config.personaPrefix（完整 config spread 后替换） | 否 |
| system-prompt/set-persona-suffix | personaSuffix | 是（保留名未验证） |
| tool-guidance/set-tool-order | system-prompt.config.toolOrder（JSON 数组） | **必须** |
| plugins/disable-row / enable-row | row `<id>.disabled`；拒绝 hmr/plugin-manager/harness2-*/system-prompt/tools/llm/session/agent-loop | 否 |
| plugins/set-harness2-config | `harness2-task-recursion.config.<key>`；只允许 triggerThreshold/repeatedFailureWindow/cooldownMs/trajectoryWindow | 否 |
| 其他 | `unrenderable` 拒绝 | — |

`cordis.patch.yml` 的 row `config` 是整体替换：从 dump 读取完整 config，spread 后只改目标键；未修改键显式回写。`!!js` 行不渲染。空 patch（纯注释 + `[]`）会被识别并替换为 managed block，而不是文本 append。

## 3. 安全边界

- 只允许非 desktop profile；profile 名正则、路径从 `DSH_HOME/profiles` 派生，拒绝穿越。
- `--profile desktop` 直接 `desktop-profile-refused`。
- body metadata 与 appliedEdit 不一致 → `body-metadata-mismatch` 拒绝 plan；`--allow-body-metadata-mismatch` 只允许生成/检查 plan，apply 仍拒绝。
- 不读写 EXPERIENCE，不发 bus 事件，不改 ledger；journal 不含 secret；错误信息脱敏。
- 不自动重启/kill 会话；写入互斥用 profile 内文件锁；session.lock 仅提示（当前 task 插件未实现 lock 时忽略）。

## 4. 测试与验收

`npm run verify:apply`：**6/6**（`tools/harness2-apply/test/applier.test.mjs`）

1. render：空 `[]` + 带注释空 patch、managed block 插入/替换、块外字节保留；
2. plan：persona 渲染保留其他 config 键、manifest/token；缺 body、篡改 hash、metadata mismatch（allow flag 仅 plan）；
3. preflight：`skipping profile bundle` 失败；toolOrder 缺 smoke 拒绝；persona 成功并写 `preflight.json`；
4. apply：token/preflight/allow-unevaluated/yes 强制；写入后 patch/backup/active/journal 正确；verify 成功；
5. rollback：恢复 base 字节、外部改动需 `--force`、重复 rollback 幂等；desktop 拒绝；
6. 回归：`npm run verify` **50/50**（task 31 + meta 14 + loader 5）不变。

### Live 集成（`npm run pr3:integration`，本机 PASS）

用 `stage0:r6:positive` 的 ledger/edits + 隔离 DSH_HOME/profile（真实 0.2.1 CLI）：

```
{ "ok": true, "profile": "pr3-int", "revId": "rev-…",
  "applyReload": "restart-required", "evaluation": "not-run", "restored": true }
```

流程：plan → preflight → apply → dump 断言 persona 生效 → verify → rollback → 字节级恢复 base patch；全程未触碰 desktop。

## 5. 偏差与未完成

- **PR-4 前无评估报告**：`apply` 强制 `--allow-unevaluated` 才写真实 profile；journal/manifest 固定 `evaluation:'not-run'`。这是受控临时入口，不是最终语义。
- `toolOrder` / persona-suffix 的 smoke 必须由调用方提供命令；applier 不内置 smoke 供应商。
- HMR 只标记 `hmr-pending-human-confirm`，未验证 live reload；headless 一律 `restart-required`。
- preflight 使用 profile 临时复制（符号链接解析为绝对路径）；复杂 profile 的插件运行时副作用未执行 smoke 以外检查。
- 未实现 PR-4 Gate-B 评估强制、PR-5 meta 学习迁移；未改 task/meta 源码、ledger v3、bus、`AppliedEdit`、confidence。
- `set-harness2-config` 固定目标 `harness2-task-recursion`（当前唯一可调 tunable 的插件）。
