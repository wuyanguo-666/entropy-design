# 内置 ffmpeg（可选）

把 `ffmpeg.exe` 与 `ffprobe.exe` 放在本目录，`npm run dist` 会把它们打进安装包的
`resources/ffmpeg/`。应用内解析顺序：**设置 → 常规 → FFmpeg 路径 > 本目录内置 > 系统 PATH**，
用户显式配置永远优先。

不放这两个 exe 也能打包（目录仅含本 README），媒体功能会回退到系统 PATH 探测。

## 来源建议（自行下载）

- <https://www.gyan.dev/ffmpeg/builds/> — `ffmpeg-release-essentials.zip`
- <https://github.com/BtbN/FFmpeg-Builds/releases> — `ffmpeg-master-latest-win64-gpl.zip`

解压后取 `bin/` 下的两个 exe 放到本目录即可，或直接用脚本：

```bash
node tools/fetch-ffmpeg.mjs <上面任一 zip 的直链>
```
