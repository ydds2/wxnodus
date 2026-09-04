# watch-pack-demo —— 官方任务链包示例（P4 社区分发范式）

这是「任务链包」的最小可发布形态：一个目录 = `chain.json`（MAA 式声明任务链）+ `templates/`（模板图）+ 可选 `modpack.json`（一键安装清单）。

## 结构

```
watch-pack-demo/
├── chain.json          # 任务链：模板触发 + 阈值 + 动作（本包为观测链——不执行动作）
├── templates/
│   └── demo-block.png  # 待匹配的屏幕元素模板（ffmpeg 色块生成）
├── modpack.json        # /modpack install 一键安装清单（kind: watch）
└── README.md
```

## 使用

```powershell
# 一键安装（复制到 dataDir/watch/packs/watch-pack-demo/）
wxnodus -p "/modpack install examples/watch-pack-demo"

# 装载任务链（模板经 ffmpeg 真实解码）
wxnodus -p "/watch chain <dataDir>/watch/packs/watch-pack-demo/chain.json"

# 启动视频流（命中即记入黑洞记忆：/hole --all 屏幕任务链命中）
wxnodus -p "/watch start --fps 5"

# 命中后回放证据
wxnodus -p "/watch clip 10"
```

> 模板 `demo-block.png` 是合成色块，仅用于验证「装载→解码→匹配管线」；真实任务链请用你自己的屏幕元素截图（见 `docs/screenwatch-chain-authoring-guide.md`）。
