# DICOMassist

**AI 驱动的医学影像分析**

[English](./README.en.md) | 简体中文

智能切片筛选 + 多模态 AI 分析。DICOMassist 是一个基于 Web 的 DICOM 查看器,在把影像交给 LLM 分析之前,先智能地选出正确的图像——因为难点不在 AI 本身,而在于知道该给它看什么。

<p align="center">
  <img src="docs/demo.gif" alt="DICOMassist 演示" width="800" />
</p>

<p align="center">
  <a href="https://youtu.be/fdDkg8ZleyA">观看完整演示视频</a> · <a href="https://qdsang.github.io/DICOMassist/">在线演示</a>
</p>

> ⚠️ **仅供教学和研究使用。** 非认证医疗器械,不用于临床诊断或治疗决策。

## 工作原理

一个膝关节 MRI 可能有 200+ 张切片、8+ 个序列。把它们一股脑丢给 AI 只会得到垃圾结果。DICOMassist 采用**两次调用架构**:

1. **加载** — 将 DICOM 文件或文件夹拖放到浏览器中
2. **分析** — 描述要评估的内容(例如"评估 ACL 撕裂分级")
3. **规划** — LLM 分析检查元数据,根据临床问题选出最优的序列、切片范围和窗宽窗位
4. **审阅** — 仅将聚焦的切片发送给多模态分析,生成带可交互切片引用的结论(点击即可跳转)

## 核心特性

- **智能切片筛选** — AI 推理出哪些序列方向、权重和切片范围具有诊断价值,只采样这些切片
- **多序列支持** — 自动识别定位像,提取序列元数据(方向、MRI 权重、分辨率)
- **交互式结果** — 结论中的切片引用可点击,直接跳转查看器到对应图像
- **隐私优先** — DICOM 文件完全在浏览器中处理,不上传到任何服务器。图像数据仅在运行分析时发送给你配置的 LLM 提供商
- **多种布局** — 1×1、1×2、2×1、2×2 网格,以及 MPR(轴位/矢状位/冠状位)
- **标准工具** — 窗宽窗位、缩放、平移、长度测量、旋转、翻转、反色、电影播放
- **提供商无关** — 支持 Claude API(推荐)或通过 Ollama 使用本地模型

## 快速开始

### 在线演示

访问 [qdsang.github.io/DICOMassist](https://qdsang.github.io/DICOMassist/)

### 本地运行

```bash
git clone https://github.com/erketellal/DICOMassist.git
cd DICOMassist
npm install
npm run dev
```

### 配置 AI 分析

1. 点击工具栏中的 ⚙ 设置图标
2. 选择 **Claude API** 并输入你的 API 密钥([在此获取](https://console.anthropic.com))
3. 加载 DICOM 文件,点击 **Analyze**,描述要评估的内容

如需使用本地模型,安装 [Ollama](https://ollama.ai),拉取模型(`ollama pull gemma3:4b`),然后在设置中选择 Ollama。注意:本地模型在医学影像分析上的质量显著低于 Claude。

### 示例数据

可以 使用公开的 DICOM 数据集来试用 DICOMassist:

- [DICOM Library](https://www.dicomlibrary.com) — 免费示例数据集
- [The Cancer Imaging Archive](https://www.cancerimagingarchive.net) — 研究数据集
- [OAI(骨关节炎倡议)](https://nda.nih.gov/oai/) — 膝关节 MRI 数据集

## 技术栈

- **React 18** + TypeScript + Vite
- **Cornerstone3D v4** — 医学影像渲染、视口管理、工具
- **Claude API**(Anthropic)— 用于图像分析的多模态 LLM
- **Ollama** — 可选的本地模型支持

## 架构

```
用户提示("评估 ACL 撕裂")
        │
        ▼
   ┌─────────┐     检查元数据
   │  调用 1  │◄─── (序列列表、方向、
   │ (文本)   │     切片数、分辨率)
   └────┬────┘
        │ 选择方案:
        │ 序列 #8 矢状位 PD-FS,切片 13-27
        ▼
   ┌──────────┐     聚焦的 JPEG 导出
   │  调用 2   │◄─── (15 张切片,已加窗,
   │ (视觉)   │     带切片标签)
   └────┬─────┘
        │
        ▼
   带切片引用的分析结论
```

## 贡献

欢迎贡献!这是一个开源项目——欢迎提 issue、提交 PR 或建议新功能。

## 许可证

MIT

---

*DICOMassist 是一个教学工具,用于演示 AI 驱动的医学影像分析中的智能数据准备。它不是认证医疗器械,不得用于临床决策。*
