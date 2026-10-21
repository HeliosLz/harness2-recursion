# Real-session E2E（第五轮）

在**隔离的 dsh profile** 里安装两个 bundle，用假 OpenAI 兼容 provider 跑两次真实 headless 会话，验证账本、`applyMode`、修订锚点与经验库。

## 前置条件

先在仓库根目录构建一次（`lib/` 不入库）：

```bash
npm install && npm run build
```

- dsh **0.2.1-rc.2** 的 CLI 运行时（不要用 desktop 内置 Electron；不要用 0.1.5 的 `dsh` 命令）。本仓库验证时使用从桌面 App 的 `app.asar` 提取的运行时：

```bash
cd /path/to/deepseek-harness/.tmp      # 任意有 asar 提取脚本的位置
node asar-extract.mjs "<DeepSeek Harness.app>/Contents/Resources/app.asar" "$DSH_RUNTIME_DIR" "dsh/node_modules"
# native addons live in app.asar.unpacked — overlay them:
cp -R "<DeepSeek Harness.app>/Contents/Resources/app.asar.unpacked/dsh/node_modules/." "$DSH_RUNTIME_DIR/dsh/node_modules/"
export E2E_CLI="$DSH_RUNTIME_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
```

- Node ≥ 24（跑 CLI 与 fake server 都用系统 node 即可；native addon 是 N-API v9，跨 Node 版本可用）。

## 运行

```bash
E2E_CLI="$DSH_RUNTIME_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" node e2e/run.mjs
```

脚本会：

1. 删掉并重建隔离 `DSH_HOME`（默认 `/tmp/h2-e2e-run`）与 `e2e/artifacts/`；
2. `dsh --profile h2e2e --from-default-profile headless` 建 profile；
3. `dsh plugin --profile h2e2e add` 两个包（**官方安装路径**）；
4. 写入 profile patch：假 provider（`retryPolicy: always`，前 3 次 500 后延迟成功）、禁用 `session-title-llm`、两个插件的配置；
5. `--dump-config` 断言两插件 rows 与配置在最终配置中；
6. 跑两次 headless 会话（第一次账本不存在，第二次已有 v3 修订）；
7. 读取 `ledger.jsonl` 断言：v3 envelope、事件顺序、token 测量来源、`applyMode`（run1=`noop-todo`，run2=`next-task-ledger`）、`previousSnapshotRef` 链、`appliedEdits` 哈希与 trial 事实一致；PR-5 后 compose 仅诊断，断言 `EXPERIENCE.md` **不产生** compose-derived 条目；
8. 生成 `e2e/artifacts/RESULTS.md`。

## 预期结果（本机实测）

```
Ledger: 4 v3 records (2 probe/completed + 2 compose/applied)
applyMode: run1=noop-todo, run2=next-task-ledger
Revision anchor chain: null -> led-… -> led-… -> led-…
EXPERIENCE.md entries: 0 (PR-5: compose is diagnostic only)
Token measurement: measured (tokenMeter)
```

> **为什么第一次是 `noop-todo`**：`applyMode` 在 `apply()` 阶段只探测一次；全新 profile 在插件激活时尚无账本可读，因此如实降级为 `noop-todo`。第二次会话启动时 `readRevisionAnchor` 读到上次的 `compose/applied`，因此为 `next-task-ledger`。这是契约规定的行为，不是缺陷。

## 清理

```bash
rm -rf /tmp/h2-e2e-run e2e/artifacts
```
