# CI 中使用 wxnodus（GitHub Action / 预提交 / SDK 密钥注入 · A-S5 2026-08-28）

> 三种姿势按需取用；全部**零云端中心**——密钥走平台 secret/env，数据不出仓库与 runner。

## ① GitHub Action（headless 单次执行）

`.github/workflows/review.yml`（示例——PR 审查/生成命令）：

```yaml
name: wxnodus-review
on: { pull_request: { types: [opened, synchronize] } }
jobs:
  review:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22.11.0' }
      - run: npm install -g wxnodus
      - name: 逐文件审查（-p 非交互 + 语义退出码）
        env:
          WXNODUS_API_KEY: ${{ secrets.WXNODUS_API_KEY }}   # 密钥注入唯一通道（见 ③）
          WXNODUS_SERVE_TOKEN: ''                            # 显式清空防继承
        run: |
          git diff --name-only origin/master...HEAD > changed.txt
          wxnodus -p "审查以下变更文件（$(cat changed.txt)）：找逻辑缺陷/回归风险，输出简表。无问题输出「PASS」"
        # 退出码：0 成功 / 1 失败 / 42 输入错误 / 53 轮次上限——分支可判（下例）
      - name: 失败时打标签
        if: ${{ failure() }}
        run: echo "wxnodus 审查未通过" && exit 1
```

`--json` 出结构化 stream-json（事件分类学 init/message/tool_use/tool_result/error/result）可被下游脚本消费；`--output-schema` 强约束结论形状（codex 同族）。

## ② 预提交（pre-commit / 手工钩）

`.pre-commit-config.yaml`（本地无网络发布面——本地 venv/npm 双形态取一）：

```yaml
repos:
  - repo: local
    hooks:
      - id: wxnodus-diff-review
        name: wxnodus 变更审查（staged diff）
        language: system
        entry: wxnodus -p "审查 git diff --cached：有缺陷输出问题清单并以 1 退出；干净输出 PASS"
        pass_filenames: false
        stages: [pre-commit]
      - id: wxnodus-commit-msg
        name: 提交信息规范（commitlint 语义 + 中文摘要）
        language: system
        entry: wxnodus -p "把 stdin 提交草稿改写为 conventional commit（type(scope): 中文摘要），只输出结果"
        stages: [commit-msg]
```

免记命令路由：`wxnodus "跑测试"`（NL 路由命中本地命令不进模型）。

## ③ SDK 密钥注入（CI/容器最小权限）

**铁律**：密钥只经 `env`/secrets 进程注入，绝不写 settings 文件/仓库/日志。

| 通道 | 键 | 语义 |
|---|---|---|
| 优先 | `WXNODUS_<PROVIDER>_KEY`（如 `WXNODUS_DEEPSEEK_KEY`） | 按 baseURL 推断的厂商专属槽（已知厂商） |
| 兜底 | `WXNODUS_API_KEY` | 通用 env 密钥（任意 OpenAI 兼容端点） |
| 进程内 | `settings.apiKeyEnc`（AES-256-GCM） | 本机持久（CLI `--model set-key` 产物；CI 不用） |

```yaml
env:
  WXNODUS_API_KEY: ${{ secrets.WXNODUS_API_KEY }}
  WXNODUS_SERVE_TOKEN: ''        # SDK spawn-attach 模式无需此键（随机 token 由握手行回传）
```

SDK（`@wxnodus/sdk`）CI 用法：`launchWxnodus({ env: { WXNODUS_API_KEY } })`——握手 token 走子进程 stdout（管道私有，不落盘不入 env）。
`@wxnodus/core` 进程内门面：`new WxnodusAgent({ settings: { apiKeyEnc: null, /* env 会被内核读取 */ } })`。

## ④ npm 发布（三包）

workflow：`.github/workflows/publish-npm.yml`（本仓已建）。前置一次性：
1. npmjs.org 生成 **Automation token**（Granular：仅允许发布 `wxnodus`、`@wxnodus/sdk`、`@wxnodus/core` 三包）；
2. 仓库 Secrets 添加 `NPM_TOKEN`；
3. 手动触发 workflow（先 `dry-run=true` 看 pack 清单，再 `false` 真发布）。

根包 `files` 已含 dist/README/LICENSE；SDK/core 包 `files` 为 src+README（TS 源直发形态，Node 22 + tsx/loader 消费；如需编译产物可后续切 dist——pack 清单日志可核对）。
