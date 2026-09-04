# 屏幕任务链与整合包社区书写指南（2026-09-04 · P4）

> 面向外部贡献者：**仅凭本文档即可提交一个可用的任务链包**（零 wxnodus 源码知识要求）。
> 机制参考（实现原创）：MAA 声明式任务链 schema（<https://github.com/MaaAssistantArknights/blob/083e4338/docs/zh-tw/protocol/task-schema.md>）——「截图→识别→任务链→动作→验证」管线；Mano-P 纯视觉驱动理念。
> 配套官方示例：`examples/watch-pack-demo`（本指南的每一步都有对应文件）。

---

## 1. 任务链包是什么

一个目录，包含：

```
my-pack/
├── chain.json          # 任务链（必需）
├── templates/          # 模板图（必需，chain 内相对引用）
│   └── login-btn.png
├── modpack.json        # 可选：/modpack install 一键安装清单
└── README.md           # 推荐：用途与维护说明
```

## 2. chain.json 语法（MAA 式声明任务链）

```jsonc
{
  "name": "登录页观察链",            // 可选，展示名
  "minIntervalMs": 3000,             // 可选，匹配节流（默认 3000，下限 1000）
  "triggers": [                      // 必需非空数组
    {
      "id": "login-button",          // 必需：命中标识（进记忆/事件）
      "template": "templates/login-btn.png",  // 必需：相对 chain.json 的模板图
      "threshold": 0.85,             // 可选：NCC 置信度阈值（默认 0.8）
      "verify": { "ocr": "登录" },   // 可选：命中后 OCR 验证（屏幕文本须包含此子串）
      "action": { "kind": "none" }   // 可选：动作（默认 none——纯观测）
    }
  ]
}
```

### 动作（action）——安全红线

| kind | 语义 | 审批 |
|---|---|---|
| `none` | 纯观测：命中仅记录（记忆/事件/证据） | 无需 |
| `click` | 在命中坐标点击（可 `x`/`y` 覆盖偏移） | **必须经审批桥**（TUI 弹窗 allow/deny；无审批桥 fail-closed 只记录） |
| `type` | 键入 `text` | 同上 |

**规则**：动作默认关闭；写动作的包必须在 README 声明行为；用户装包后仍需逐次审批。

## 3. 制作模板图（三步）

1. **取关键帧**：`/watch start --fps 3` → 稍候 → 停止后 `dataDir/watch/keyframes/` 里取最新 `kf-*.jpg`（或 `/watch keyframe`）。
2. **裁剪目标元素**（ffmpeg 单命令）：

   ```powershell
   ffmpeg -i kf-xxx.jpg -vf "crop=W:H:X:Y" my-template.png
   # W/H = 元素宽高（像素，按关键帧原分辨率）；X/Y = 左上角坐标
   ```

3. **阈值标定**：先用 0.85；真机命中多→保持，漏检→降到 0.75。**模板避开纯色大块**（σ≈0 无特征——诚实不命中）；选带纹理/文字/边框的区域。

## 4. 验证与打包（自己先跑通——MAA 社区规范）

```powershell
# ① 装载（模板真实解码，错误即报）
wxnodus -p "/watch chain <绝对路径>/chain.json"

# ② 启动视频流 → 观察命中（黑洞记忆可召回）
wxnodus -p "/watch start --fps 5"
wxnodus -p "/hole --all 屏幕任务链命中"

# ③ 命中后回放证据（自证触发时刻）
wxnodus -p "/watch clip 10"

# ④ 生成一键安装清单（目录根有 chain.json 时 export 自动收为 watch 组件）
wxnodus -p "/modpack export <目录> 我的包名"
```

## 5. 发布与安装

```powershell
# 发布：GitHub 仓库 / 本地目录 / zip（url 来源安装经 SSRF 防护下载）
# 安装（对方机器）：
wxnodus -p "/modpack install <目录|zip> --dry-run"   # 先预演
wxnodus -p "/modpack install <目录|zip>"              # 正式安装
wxnodus -p "/watch chain <dataDir>/watch/packs/<id>/chain.json"  # 装载（安装输出会给出确切路径）
```

- 版本兼容：`modpack.json` 的 `targetWxnodus`（如 `">=4.0.2"` 或 `"4.0.x"`）——不匹配时安装被 fail-closed 拒绝（绝不带病安装）；
- 防篡改：zip 分发可附 `sha256`；
- 崩溃隔离：插件类组件沙箱隔离；任务链单触发器失败不影响其余（chain-error 事件可观测）。

## 6. 提交一份任务链包的检查清单

- [ ] `chain.json` 语法经 `/watch chain` 装载零报错；
- [ ] 每个 `template` 路径真实存在且为 png/jpg；
- [ ] 动作含 click/type 的：README 声明行为 + 真机审批放行实测过；
- [ ] `threshold` 经真机标定（记下实测分数）；
- [ ] 附一张「命中示例」证据（`/watch clip` 导出帧或关键帧）；
- [ ] `modpack.json` 的 `targetWxnodus` 与实测版本一致。

> 本指南的每一步都对应官方示例 `examples/watch-pack-demo` 中的文件——照着改即可。
