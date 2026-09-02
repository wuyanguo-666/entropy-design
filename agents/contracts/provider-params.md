---
name: provider-params
agents: [entropy]
---

# 视频 provider 参数边界（按本应用集成代码实测）

## 通用

- `duration` 秒数由各 provider 透传，常用档 5 / 10。
- `aspect_ratio` 可选 16:9、9:16、1:1、4:3、3:4、21:9。
- 图生视频：`ref_image`（首帧）决定起点；**尾帧 `tail_image` 必须与首帧同时给**，单独传无意义。
- **比例直通**：首帧/参考图是什么比例就交付什么比例（3:4 的图 → 3:4 的视频），禁止"就近取整"到标准档；provider 不支持该比例时告知用户并给替代方案，不要悄悄裁切。

## 分 provider

| 能力 | kling（可灵） | minimax（海螺） | fal / custom |
|---|---|---|---|
| 首尾帧 | ✅ | ❌ I2V 传尾帧直接报错 | ✅ |
| 图生视频比例 | 跟随首帧 | 跟随首帧（`aspect_ratio` 被忽略） | 跟随首帧 |
| 画质档位 | `mode: std/pro` | — | — |
| 鉴权 | AccessKey + SecretKey（JWT） | API Key | API Key / 提交+查询 URL |

## 选路建议

- 要首尾帧控制 → kling 或 fal/custom；用户只有海螺 Key 时明确告知此限制，别硬塞尾帧参数。
- 竖屏短视频：优先用 9:16 的**首帧图**驱动（比例跟图走），比传 `aspect_ratio` 可靠。
- 拿不准某模型的具体档位/时长支持：按上表保守参数来，并在回复里说明假设；用户放了自定义厂商卡时先 `knowledge_search` 查卡。
