# YouTube 双语字幕 / YouTube Bilingual Subtitles

> 一个开源的 Chrome 扩展，在 YouTube 上显示 AI 双语字幕，支持生词高亮、点词查义、词汇追踪，可接入云端 API 或本地大模型。
>
> An open-source Chrome extension that shows AI-powered bilingual subtitles on YouTube, with word highlighting, click-to-define, vocabulary tracking, and support for both cloud APIs and local LLMs.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Ollama](https://img.shields.io/badge/Ollama-Compatible-orange)
![OpenAI Compatible](https://img.shields.io/badge/OpenAI-Compatible-412991?logo=openai)

---

## ✨ 功能特点 / Features

| 功能 | 描述 |
|------|------|
| 🌍 **双语字幕** | 同时显示视频原文字幕 + AI 翻译字幕 |
| 🎨 **生词高亮** | 已掌握（绿色）、生词（橙色）、学习中（蓝色虚线）|
| ⏸️ **点击暂停** | 点击字幕区域暂停/恢复视频 |
| 📖 **单词弹窗** | 点击任意单词，显示发音 / 词性 / 释义 / 例句解释 |
| ✅ **词汇追踪** | 标记单词为"已掌握"或"学习中"，持久保存 |
| 📝 **字幕面板** | 右侧可滑动字幕列表，点击跳转到对应时间 |
| 🤖 **AI 翻译** | 支持 OpenAI / 任意兼容 API / 本地 Ollama 大模型 |
| 📚 **词汇管理** | 统计、导出、导入词汇表（JSON 格式）|
| 🚫 **零成本可选** | 配置本地大模型后完全免费使用 |

---

## 🚀 安装扩展 / Installation

### 1. 下载源码

```bash
git clone https://github.com/YOUR_USERNAME/YouTubeTranslator.git
# 或直接下载 ZIP 解压
```

### 2. 加载到 Chrome

1. 打开 Chrome，地址栏输入：`chrome://extensions/`
2. 右上角开启 **「开发者模式」**（Developer mode）
3. 点击 **「加载已解压的扩展程序」**（Load unpacked）
4. 选择项目文件夹 `YouTubeTranslator`
5. 扩展加载成功，首次安装会自动打开设置页面

### 3. 配置 AI 翻译（必须）

点击浏览器右上角的扩展图标 → **「Full Settings」** 进入完整设置页面，选择以下任一翻译方式：

---

## 🤖 AI 翻译配置 / AI Translation Setup

### 方式一：云端 API（推荐新手）

在设置页选择 **「Cloud API」**，填入以下信息：

| 服务商 | API Endpoint | Model | 费用参考 |
|--------|-------------|-------|---------|
| **OpenAI** | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` | ~$0.15/百万 token |
| **DeepSeek** ⭐ | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` | ~¥1/百万 token（极低）|
| **通义千问** | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus` | ~¥0.8/百万 token |
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-2.0-flash` | 免费额度充足 |

> 💡 **推荐 DeepSeek**：翻译质量接近 GPT-4o，价格约为其 1/10，1 元人民币可翻译数千条字幕。

---

### 方式二：本地大模型（免费、隐私）

本地部署无需任何 API Key，完全免费且数据不离开你的电脑。

---

## 💻 本地大模型部署指南 / Local LLM Deployment

### 🔧 工具：Ollama

[Ollama](https://ollama.com) 是目前最简单的本地大模型运行工具，一条命令即可下载并运行模型。

#### 安装 Ollama

**Windows：**
```powershell
# 方法一：通过 winget 安装（推荐）
winget install Ollama.Ollama

# 方法二：直接下载安装包
# 访问 https://ollama.com/download 下载 OllamaSetup.exe
```

**macOS：**
```bash
# 方法一：官网下载（推荐）
# 访问 https://ollama.com/download 下载 .dmg 安装包

# 方法二：Homebrew
brew install ollama
```

**Linux：**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

---

### 📊 根据你的硬件选择模型

#### 🖥️ 配置一：NVIDIA RTX 3060 12GB (Windows)

| 推荐模型 | 显存占用 | 翻译质量 | 下载大小 |
|---------|---------|---------|---------|
| **`qwen2.5:14b`** ⭐ 首选 | ~9 GB | ★★★★☆ | ~9 GB |
| `qwen2.5:7b` | ~5 GB | ★★★☆☆ | ~5 GB |

```bash
# 下载并运行（首次下载约 9GB，之后秒启动）
ollama pull qwen2.5:14b

# 验证模型可用
ollama run qwen2.5:14b "将这句话翻译成中文：Hello, how are you?"
```

**插件配置：**
- Provider: `Local LLM`
- Local Endpoint: `http://localhost:11434/api/generate`
- Model Name: `qwen2.5:14b`

---

#### 💻 配置二：MacBook Air M4 24GB 统一内存 (macOS)

Apple Silicon 的统一内存可被 GPU 完全使用，24GB 可跑 32b 量化模型，翻译质量大幅提升！

| 推荐模型 | 内存占用 | 翻译质量 | 下载大小 |
|---------|---------|---------|---------|
| **`qwen2.5:32b`** ⭐ 首选 | ~20 GB | ★★★★★ | ~20 GB |
| `qwen2.5:14b` | ~9 GB | ★★★★☆ | ~9 GB |

```bash
# 启动 Ollama 服务（macOS 安装后后台自动运行）
# 下载模型
ollama pull qwen2.5:32b

# 验证翻译效果
ollama run qwen2.5:32b "翻译成中文：The quick brown fox jumps over the lazy dog."
```

> ⚠️ **注意**：M4 Air 没有主动散热，长时间高负载会降频。如果跑 32b 降频明显，可以切换到 14b 保持流畅。

**插件配置：**
- Provider: `Local LLM`
- Local Endpoint: `http://localhost:11434/api/generate`
- Model Name: `qwen2.5:32b`

---

#### 🖥️ 配置三：AMD RX 7900 XTX 24GB + 64GB RAM (Windows/Linux)

7900 XTX 拥有 24GB VRAM，是三台设备中最强的本地推理机器！

| 推荐模型 | 显存占用 | 翻译质量 | 下载大小 | 备注 |
|---------|---------|---------|---------|------|
| **`qwen2.5:32b`** ⭐ 首选 | ~20 GB | ★★★★★ | ~20 GB | 全 GPU，速度最快 |
| `qwen2.5:72b` 进阶 | ~42 GB | ★★★★★+ | ~42 GB | 显存+内存混合，速度较慢 |

```bash
# 下载模型
ollama pull qwen2.5:32b

# 如果想体验最高质量（72B，会调用 64GB 内存辅助）
ollama pull qwen2.5:72b
```

> ⚠️ **AMD GPU 注意事项（Windows）**：
> Ollama 在 Windows 上已内置 ROCm 支持，但 AMD GPU 在 Windows 上的兼容性不如 Linux。如遇到 GPU 未被识别（只跑 CPU），请：
> 1. 更新 AMD 显卡驱动到最新版
> 2. 或考虑安装双系统 Linux（Ubuntu 22.04 + ROCm），性能最佳

**插件配置：**
- Provider: `Local LLM`
- Local Endpoint: `http://localhost:11434/api/generate`
- Model Name: `qwen2.5:32b`

---

### ▶️ 启动 Ollama 服务

下载模型后，每次使用前需要确保 Ollama 服务在运行：

**Windows：**
- 安装后 Ollama 会自动在系统托盘运行（右下角查看）
- 或手动在 PowerShell 运行：`ollama serve`

**macOS：**
- 安装后自动后台运行
- 或终端运行：`ollama serve`

**验证服务是否正常：**
```bash
# 在浏览器访问或命令行测试
curl http://localhost:11434/api/tags
# 应返回已安装的模型列表
```

---

### ⚙️ 在插件中配置本地大模型

1. 打开 YouTube 视频页面
2. 点击浏览器右上角扩展图标
3. 点击 **「Full Settings」**
4. 在 **「AI Translation Settings」** 中：
   - Translation Provider 选择 **「Local LLM」**
   - Local Endpoint 填写：`http://localhost:11434/api/generate`
   - Model Name 填写你下载的模型名（如 `qwen2.5:14b`）
5. 点击 **「Test Connection」** 验证连接
6. 点击 **「Save Settings」** 保存
7. 刷新 YouTube 页面，开启视频字幕（CC），即可看到双语字幕！

---

## 📁 项目结构 / Project Structure

```
YouTubeTranslator/
├── manifest.json          # Chrome Extension Manifest V3
├── background/
│   └── background.js      # Service Worker，处理安装和消息路由
├── content/
│   ├── content.js         # 内容脚本主入口，处理 YouTube SPA 导航
│   ├── content.css        # 字幕、弹窗、面板样式（暗色主题）
│   ├── subtitle.js        # 字幕拦截、双语渲染、词汇高亮
│   ├── panel.js           # 右侧字幕面板 + 词汇本标签页
│   └── wordPopup.js       # 单词释义弹窗组件
├── lib/
│   ├── languages.js       # 语言定义、文本分词（支持中日韩）
│   ├── storage.js         # Chrome storage 封装（设置、词汇、翻译缓存）
│   └── translator.js      # AI 翻译服务（云端 API + 本地 LLM）
├── popup/
│   ├── popup.html         # 工具栏弹出窗口
│   ├── popup.css          # 弹窗样式
│   └── popup.js           # 弹窗逻辑（快速设置、状态显示）
├── options/
│   ├── options.html       # 完整设置页面
│   ├── options.css        # 设置页样式
│   └── options.js         # 设置页逻辑（API 测试、词汇管理）
├── icons/                  # 扩展图标（16/48/128px）
└── _locales/
    ├── en/messages.json   # 英文本地化
    └── zh_CN/messages.json # 中文本地化
```

---

## 🎮 使用方法 / How to Use

1. **打开 YouTube 视频**，确保视频有英文字幕（点击 CC 按钮开启）
2. **字幕自动替换**：插件会拦截原始字幕并显示双语版本
3. **点击字幕区域** → 视频暂停/播放
4. **点击单词** → 视频暂停 + 弹出释义窗口
   - 查看发音、词性、翻译、解释
   - 点击 **✓ Mastered** 标记为已掌握（绿色）
   - 点击 **📖 Learning** 标记为学习中（蓝色）
5. **右侧面板**：点击播放器中的列表按钮切换显示
   - **Subtitles 标签**：完整字幕列表，点击跳转
   - **Vocabulary 标签**：查看所有标记的单词

---

## 🔑 颜色标注说明 / Word Color Guide

| 颜色 | 含义 |
|------|------|
| 🟢 **绿色** | 已标记为「已掌握」的单词 |
| 🟠 **橙色下划线** | 未标记的单词（可能是生词）|
| 🔵 **蓝色虚线** | 已标记为「学习中」的单词 |

---

## ⚙️ 设置说明 / Settings Reference

| 设置项 | 说明 |
|--------|------|
| Target Language | 视频的语言（你在学习的语言）|
| Native Language | 你的母语（翻译目标语言）|
| Proficiency Level | 语言水平（影响词汇高亮策略）|
| AI Provider | 翻译服务：Cloud API / Custom API / Local LLM |
| API Key | 云端 API 密钥 |
| API Endpoint | API 地址（支持任何 OpenAI 兼容接口）|
| Model | 模型名称 |
| Font Size | 字幕字体大小（12-28px）|
| Auto Translate | 是否自动翻译每条字幕 |
| Show Panel | 启动时是否自动显示字幕面板 |

---

## 🔧 常见问题 / FAQ

**Q：字幕没有出现？**
A：请确保：（1）在 YouTube 视频页面（URL 含 `/watch`）；（2）视频本身有字幕且已开启（CC 按钮）；（3）扩展已启用（工具栏弹窗中开关为开）

**Q：翻译不出来 / 显示 Translation Error？**
A：检查设置页的 API 配置，点击 「Test Connection」查看具体错误。本地 LLM 请确认 Ollama 服务已运行（`ollama serve`）

**Q：Ollama 没有使用 GPU？**
A：运行 `ollama run qwen2.5:14b` 时查看任务管理器 GPU 占用。AMD 用户 Windows 下可能需要更新驱动或改用 Linux

**Q：MacBook 发热明显？**
A：32b 模型计算量大属正常，可切换到 14b 降低负载

**Q：能换其他翻译模型吗？**
A：可以！任何 Ollama 支持的模型都能用，在设置中修改 Model Name 即可。推荐翻译模型：`qwen2.5:14b`、`qwen2.5:32b`、`gemma2:9b`

---

## 🤝 贡献 / Contributing

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证 / License

MIT License © 2026
