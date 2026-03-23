/**
 * volcano-tts-proxy.ts
 * 轻量 WebSocket 代理 — 解决浏览器无法携带自定义鉴权 Header 的问题
 *
 * 用法:
 *   npx tsx volcano-tts-proxy.ts
 *   # 或编译后: node volcano-tts-proxy.js
 *
 * 环境变量 (.env):
 *   VOLCANO_APP_ID=your_app_id
 *   VOLCANO_TOKEN=your_access_token
 *   VOLCANO_CLUSTER=volcano_tts        # 或 volcano_tts_cn 等
 *   PROXY_PORT=8765                    # 代理监听端口
 *   ALLOWED_ORIGIN=http://localhost:5173  # 允许的前端 origin（留空则不限制）
 *
 * 前端连接:
 *   const ws = new WebSocket('ws://localhost:8765')
 *
 * 工作原理:
 *   Browser ──WS──▶ 本代理（注入鉴权头） ──WS──▶ 火山 TTS
 *   Browser ◀──WS── 本代理（透传音频帧） ◀──WS── 火山 TTS
 */

import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

// ── 配置 ─────────────────────────────────────────────────────────────────────
const DEFAULT_CLUSTER = process.env.VITE_VOLCANO_CLUSTER || process.env.VOLCANO_CLUSTER || 'volcano_tts';
const PORT            = parseInt(process.env.PROXY_PORT || '8765', 10);
const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || '';

// 火山 TTS WebSocket 端点（国内版）
const VOLCANO_WS_URL = `wss://openspeech.bytedance.com/api/v1/tts/ws_binary`;

// ── 协议工具（与前端 hook 保持一致） ─────────────────────────────────────────
const HEADER_SIZE_UNITS = 1; // 1 unit = 4 bytes
const MSG_TYPE_FULL_CLIENT  = 0x01;
const MSG_TYPE_AUDIO_ONLY   = 0x0b;
const MSG_FLAGS_NONE = 0x00;
const SERIAL_JSON    = 0x01;
const COMPRESS_NONE  = 0x00;

function buildHeader(msgType: number, msgFlags: number): Buffer {
  const version = 0x01;
  const headerSize = 0x01;
  const serialMethod = SERIAL_JSON;
  const compression = COMPRESS_NONE;

  return Buffer.from([
    (version << 4) | headerSize,
    (msgType << 4) | msgFlags,
    (serialMethod << 4) | compression,
    0x00
  ]);
}

/**
 * 将前端发来的二进制帧反序列化为 JSON，
 * 注入服务端鉴权字段后重新序列化
 */
function injectAuth(rawFrame: Buffer, appId: string, token: string, cluster: string): Buffer {
  // 解析 header (4 bytes)
  const headerBytes = 4; // header size is always 4 bytes when headersize=1
  const payloadSize = rawFrame.readUInt32BE(headerBytes);
  const jsonStr = rawFrame.subarray(headerBytes + 4, headerBytes + 4 + payloadSize).toString('utf8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return rawFrame; // 无法解析则透传
  }

  // 注入 / 覆盖鉴权字段
  const app = (parsed.app as Record<string, unknown>) || {};
  app.appid   = appId;
  app.token   = token;
  app.cluster = cluster;
  parsed.app  = app;

  const newJson    = Buffer.from(JSON.stringify(parsed), 'utf8');
  const sizeBuf    = Buffer.allocUnsafe(4);
  sizeBuf.writeUInt32BE(newJson.byteLength, 0);

  const msgType  = rawFrame[1] >> 4;
  const msgFlags = rawFrame[1] & 0x0f;
  const header   = buildHeader(msgType, msgFlags);

  return Buffer.concat([header, sizeBuf, newJson]);
}

// ── HTTP 服务（用于健康检查） ──────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'volcano-tts' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── WebSocket 代理 ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientWs, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
    console.warn(`[Proxy] 拒绝来自 ${origin} 的连接（与 ALLOWED_ORIGIN 不匹配）`);
    clientWs.close(1008, 'Origin not allowed');
    return;
  }

  // 从连接 URL 参数中提取 token 和 appid（支持前端动态传参）
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const appId = reqUrl.searchParams.get('appid') || process.env.VITE_VOLCANO_APPID || '';
  const token = reqUrl.searchParams.get('token') || process.env.VITE_VOLCANO_TOKEN || '';
  const cluster = reqUrl.searchParams.get('cluster') || DEFAULT_CLUSTER;

  console.log(`[Proxy] 客户端连接: ${req.socket.remoteAddress}, AppID: ${appId ? '已提供' : '未提供'}`);

  if (!appId || !token) {
    console.error(`[Proxy] ❌ 缺少 appId 或 token，无法建立上游连接！`);
    clientWs.close(1008, 'Missing appid or token');
    return;
  }

  // 连接火山后端
  const volcanoWs = new WebSocket(VOLCANO_WS_URL, {
    headers: {
      // 火山 API 强制要求 Header Bearer 鉴权
      'Authorization': `Bearer; ${token}`,
    },
  });

  volcanoWs.binaryType = 'arraybuffer';

  // 解决竞态：客户端可能先发消息，而上游火山连接尚未 open
  const pendingMessages: Array<{ data: Buffer; isBinary: boolean }> = [];

  volcanoWs.on('open', () => {
    console.log('[Proxy] 上游火山连接已建立，开始转发缓存消息');
    while (pendingMessages.length > 0 && volcanoWs.readyState === WebSocket.OPEN) {
      const item = pendingMessages.shift();
      if (!item) break;
      if (item.isBinary) {
        const injected = injectAuth(item.data, appId, token, cluster);
        volcanoWs.send(injected);
      } else {
        volcanoWs.send(item.data);
      }
    }
  });

  // 客户端 → 代理 → 火山（注入鉴权）
  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      if (volcanoWs.readyState !== WebSocket.OPEN) {
        pendingMessages.push({ data: Buffer.from(data), isBinary });
        return;
      }
      if (isBinary) {
        const injected = injectAuth(data, appId, token, cluster);
        volcanoWs.send(injected);
      } else {
        // 文本帧直接透传（一般不会有）
        volcanoWs.send(data);
      }
    } catch (e) {
      console.error('[Proxy] 转发到火山失败:', e);
    }
  });

  // 火山 → 代理 → 客户端（音频帧直接透传）
  volcanoWs.on('message', (data) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    try {
      clientWs.send(data as Buffer, { binary: true });
    } catch (e) {
      console.error('[Proxy] 转发到客户端失败:', e);
    }
  });

  // 错误 & 关闭处理
  const cleanup = (source: string) => () => {
    console.log(`[Proxy] 连接关闭 (${source})`);
    if (clientWs.readyState  === WebSocket.OPEN)  clientWs.close();
    if (volcanoWs.readyState === WebSocket.OPEN) volcanoWs.close();
  };

  clientWs.on('close',  cleanup('client'));
  clientWs.on('error',  (e) => { console.error('[Proxy] 客户端错误:', e); cleanup('client')(); });
  volcanoWs.on('close', cleanup('volcano'));
  volcanoWs.on('error', (e) => { console.error('[Proxy] 火山连接错误:', e); cleanup('volcano')(); });
});

httpServer.listen(PORT, () => {
  console.log(`[Proxy] ✅ 火山 TTS WebSocket 代理已启动`);
  console.log(`[Proxy]    监听端口  : ${PORT}`);
  console.log(`[Proxy]    目标服务  : ${VOLCANO_WS_URL}`);
  console.log(`[Proxy]    健康检查  : http://localhost:${PORT}/health`);
  console.log(`[Proxy]    状态      : 等待前端携带 ?appid=xxx&token=yyy 接入...`);
});