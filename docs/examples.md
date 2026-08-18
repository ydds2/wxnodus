# 场景示例（Examples）

> wxnodus 用户文档三件套之三（supremacy 2.3，2026-08-18）。10 个可复现场景——命令均为真实命令（链接契约测试校验）。
> 前置：`docs/getting-started.md`；出问题：`docs/troubleshooting.md`。

## 1. 一句话搭一个待办系统

```bash
wxnodus -p "/build 一个本地待办 Web 应用：支持增删改查、完成标记、localStorage 持久化"
```
产物：规格 → 分解 → 脚手架 → 启动验证 → 证据链（`/evidence` 查看）。验证失败会如实报告（绝不假装成功）。

## 2. 调试循环：改代码 → 跑测试 → 修错 → 复跑

```bash
wxnodus
# 会话内：
帮我修复 tests/kernel-cost.test.ts 的失败——先跑一遍测试看到失败输出，再修
```
agent 会 `bash npm test -- <文件>` 读失败 → `fs_edit`/`apply_patch` 修改 → 复跑验证。`/undo` 随时回退。

## 3. 读一个陌生仓库

```bash
wxnodus -p "用 /map 生成仓库地图，然后总结这个项目的架构分层与关键模块"
```
`/map`（repo map，符号索引注入上下文）→ agent 基于地图逐层读码总结。

## 4. 多会话并行 + 分支实验

```bash
wxnodus
/sessions              # 列表
/new                   # 新会话（实现方案 B）
/fork                  # 分支当前会话（保留 A 路线，B 路线试错）
/resume <id>           # 随时切回
```
`/fork lineage` 查看分支血缘；`/sessions --json` 是桌面端/IDE 的数据源。

## 5. 定时任务 + 后台任务

```bash
/cron add "每天 09:00" "git pull && npm test"    # 真实调度
/jobs list                                        # 后台任务中心
/term                                              # 后台交互终端（PTY）
```

## 6. 安全执行：沙盒 + 审批规则

```bash
/sandbox os L0          # bash 全部只读 + 断网执行（标准用户可用）
/perm rule add bash "git push*" deny "推送请手动执行"   # execpolicy 首词规则
/perm rule add bash "git *" allow                          # 其余 git 放行
```
优先级：红线 > 规则 deny > 会话 deny > 会话 allow > 模式判定。

## 7. 视觉与桌面自动化（需 GLM-4V key）

```bash
/img screenshot.png "这个报错是什么意思？"
/computer "打开记事本，输入 hello 并截图回来"
```
Computer Use = robotjs 动作层 + GLM-4V 屏幕理解（UIA 文本树对文本模型也可用）。

## 8. 远程执行（ssh 通道）

```bash
/remote ssh://dev@build-box:22
/remote run "docker ps && df -h"
# 此后 bash 工具命令也经 ssh 转发（输出带「远端未沙盒」诚实标注）
/remote off
```

## 9. 分享与导入

```bash
/share export --encrypt                 # WXNODUS_SHARE_PASS=口令 环境变量传入
/share import ./session-xxx.wxnshare    # 校验 sha256 → 入库，血缘标记 share:<源id>
```

## 10. 自动化接入（无头模式）

```bash
wxnodus -p "跑一遍测试并汇报结果" --wire | node examples/wire-events.mjs
wxnodus -p "/acp server"     # Zed / JetBrains ACP 接入
```
`--wire` 事件流（JSONL + stdin 双向审批帧 + 退出码协议）是 IDE 插件/桌面端的机器接口——schema 见 `docs/wire-protocol.md`。
