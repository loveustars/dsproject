# 京轨


## 特性

-  **AI 对话集成**: 支持直接接入 OpenAI 兼容的模型接口，响应支持 Markdown 实时渲染。
-  **交互式地图**: 引入 Mapbox GL 渲染动态路线与地图。
-  **语音合成（TTS）**: 集成火山引擎豆包语音，支持中/英/日多语言朗读与调试面板。
-  **路线规划接口预留**: 右侧“推荐路线”支持对接后端 API 数据。

## 本地启动

```bash
# 安装依赖
npm install

# 启动开发服务器
### 前端
cd dsproject-main\Frontend\metro-app
npm run dev
### 语音
cd dsproject-main\Frontend\metro-app
npx tsx volcano-tts-proxy.ts
### 后端
cd dsproject-main\Backend
npm run dev
```

## 语音合成（TTS）

本项目使用火山引擎 WebSocket TTS，浏览器无法携带鉴权 Header，建议启动本地代理：

```bash
# 在 Frontend/metro-app 目录下运行
npx tsx volcano-tts-proxy.ts
```

前端在设置中填写：
- **火山引擎 Token / AppID**
- **代理 / WebSocket URL**（默认 `ws://localhost:8765`）

## 路线规划 API（右侧栏上半）

前端可在“通用设置”中填写 **路线规划 API 地址**，以 POST JSON 获取路线并渲染到右侧列表。
接口标准见：

- [docs/route-api.md](docs/route-api.md)

## 后端本地启动

```bash
# 在 backend 目录下
npm install
npm run dev
```

## 设置说明

在应用左下角的“设置”面板中，可以自行配置：
- **模型与接口**: 自定义 API Endpoint 和密钥。
- **语音合成**: TTS Token/AppID、代理地址、音色与语速。
- **通用设置**: 更改语言、配置路线规划 API 地址、填写渲染地图必须的 **Mapbox Token**。
