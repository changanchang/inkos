<p align="center">
  <h1 align="center">InkOS Studio</h1>
  <p align="center">InkOS 的可视化 Web 界面 - 自动化小说写作管理平台</p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
</p>

## 简介

InkOS Studio 是 [InkOS](https://github.com/Narcooo/inkos) 的可视化 Web 界面，提供直观的操作界面来管理自动化小说写作流程。

## 功能特性

- **控制台** - 书籍统计、快速操作
- **书籍管理** - 创建、查看、删除书籍
- **智能写作** - 实时预览 AI 创作过程、进度显示、可随时停止
- **章节列表** - 查看、阅读、审计章节
- **创作指导** - 保存和复用创作设定
- **多模型支持** - OpenAI、Anthropic、DeepSeek、OpenRouter 等
- **终端** - 直接执行 inkos 命令

## 快速开始

### 前置条件

- Node.js >= 20.0.0
- 已安装 [InkOS CLI](https://github.com/Narcooo/inkos)

### 安装

```bash
# 克隆本仓库
git clone https://github.com/changanchang/inkos.git
cd inkos-studio

# 安装依赖
npm install

# 启动
npm start
```

访问 http://localhost:4567 即可使用。

### 配置 API

1. 打开设置页面
2. 选择 AI 提供商（OpenAI/Anthropic/DeepSeek 等）
3. 输入 API Key
4. 保存配置

## 使用说明

### 创建书籍

1. 点击「创建新书」
2. 输入书名、选择题材
3. 设置每章字数和目标章节数
4. 可选：输入创作简报

### 开始写作

1. 选择书籍
2. 输入创作指导（可选，可从历史设定中选择）
3. 设置目标字数和章节数
4. 点击「开始写作」

写作过程中可以：
- 实时预览 AI 创作的内容
- 查看进度条
- 随时点击「停止写作」终止（会删除本章内容）

### 阅读章节

1. 进入「章节列表」
2. 选择书籍
3. 点击「查看」阅读章节内容

## 支持的 AI 模型

| 提供商 | 模型示例 |
|--------|----------|
| OpenAI | gpt-4o, gpt-4-turbo |
| Anthropic | claude-sonnet-4-20250514 |
| DeepSeek | deepseek-chat, deepseek-reasoner |
| OpenRouter | 各种模型 |
| Custom | 任何 OpenAI 兼容 API |

## 项目结构

```
inkos-studio/
├── public/          # 前端静态文件
│   └── index.html   # 主页面
├── src/             # 后端代码
│   └── server.js    # Express 服务器
├── package.json
├── LICENSE
└── README.md
```

## 致谢

本项目是 [InkOS](https://github.com/Narcooo/inkos) 的可视化界面扩展。

InkOS 是一个强大的多智能体自动化小说写作系统，由 [Narcooo](https://github.com/Narcooo) 开发。

- 原项目仓库：https://github.com/Narcooo/inkos
- 原项目协议：MIT License

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

```
MIT License

Copyright (c) 2026 changanchang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
