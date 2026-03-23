/**
 * useVolcanoTTS — 火山引擎 TTS WebSocket 流式语音合成 Hook
 *
 * 协议参考: https://www.volcengine.com/docs/6561/79820
 *
 * 架构:
 *   LLM stream delta
 *     → 断句缓冲 (pushTextDelta)
 *     → WebSocket 推送文本到火山 TTS
 *     → 接收 binary MP3/PCM chunk
 *     → AudioContext 解码 + 队列顺序播放
 *
 * 浏览器直连限制:
 *   火山 WS 鉴权需要自定义 Header，浏览器 WebSocket API 不支持。
 *   解决方案二选一:
 *   A) 使用本仓库附带的 volcano-tts-proxy（Node/Deno，把 token 放服务端）
 *   B) 在火山控制台开启「Token 鉴权」模式，把 token 放 URL query 参数
 *      wss://openspeech.bytedance.com/api/v3/tts/bidirection?token=xxx
 *
 * 本 hook 默认走方案 B（token in URL）或走代理 URL。
 */

import { useRef, useCallback, useState } from 'react';

// ── 断句正则 ─────────────────────────────────────────────────────────────────
// 匹配以句末标点结尾的完整句子
const SENTENCE_END_RE = /[^。！？!?.…\n]+[。！？!?.…\n]+/g;
const MIN_CHUNK_LEN = 6;   // 字符数低于此值不单独合成
const MAX_BUFFER_LEN = 80; // 缓冲区超过此长度强制切分（防止句子过长）

// ── 火山 TTS WebSocket 协议常量 ──────────────────────────────────────────────
// 消息头 magic bytes (Version=1, HeaderSize=1, MessageType, Flags, SerialMethod=JSON, Compression=None, Reserved)
const PROTOCOL_VERSION = 0x01;
const HEADER_SIZE      = 0x01; // 4 bytes header, unit=4bytes → 1*4=4
const MESSAGE_TYPE_FULL_CLIENT  = 0x01; // 客户端完整请求
const MESSAGE_TYPE_AUDIO_ONLY   = 0x0b; // 服务端仅音频（二进制）
const MESSAGE_FLAGS_NONE  = 0x00;
const SERIAL_METHOD_JSON  = 0x01;
const COMPRESSION_NONE    = 0x00;

function buildHeader(msgType: number, msgFlags: number): Uint8Array {
  return new Uint8Array([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (msgType << 4) | msgFlags,
    (SERIAL_METHOD_JSON << 4) | COMPRESSION_NONE,
    0x00
  ]);
}

function encodeTextPayload(obj: unknown): ArrayBuffer {
  const json = JSON.stringify(obj);
  const encoded = new TextEncoder().encode(json);
  const header = buildHeader(MESSAGE_TYPE_FULL_CLIENT, MESSAGE_FLAGS_NONE);

  // payload = 4-byte big-endian size + json bytes
  const sizeBuf = new ArrayBuffer(4);
  new DataView(sizeBuf).setUint32(0, encoded.byteLength, false);

  const merged = new Uint8Array(header.byteLength + 4 + encoded.byteLength);
  merged.set(header, 0);
  merged.set(new Uint8Array(sizeBuf), header.byteLength);
  merged.set(encoded, header.byteLength + 4);
  return merged.buffer;
}

/** 解析服务端二进制消息，返回音频 ArrayBuffer 或 null（控制帧），并如果有 JSON 返回对应的字符串 */
function parseServerMessage(data: ArrayBuffer): { audio: ArrayBuffer | null; isLast: boolean; jsonStr?: string; msgTypeHex?: string } {
  const view = new DataView(data);
  if (data.byteLength < 4) return { audio: null, isLast: false };

  const msgType  = view.getUint8(1) >> 4;
  const msgFlags = view.getUint8(1) & 0x0f;
  const isLast   = (msgFlags & 0x02) !== 0;
  const msgTypeHex = `0x${msgType.toString(16)}`;

  if (msgType === MESSAGE_TYPE_AUDIO_ONLY) {
    let offset = 4;
    if (msgFlags !== 0) {
      offset += 4; // skip sequence number
    }
    const payloadSize = view.getInt32(offset, false);
    offset += 4;
    const audio = data.slice(offset, offset + payloadSize);
    return { audio, isLast, msgTypeHex };
  } else if (msgType === 0x09 || msgType === 0x0c || msgType === 0x0f) {
    let offset = 4;
    if (msgFlags !== 0) { offset += 4; }
    if (offset + 4 <= data.byteLength) {
      const payloadSize = view.getInt32(offset, false);
      offset += 4;
      const jsonBytes = data.slice(offset, offset + payloadSize);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      return { audio: null, isLast, jsonStr, msgTypeHex };
    }
  }

  return { audio: null, isLast, msgTypeHex };
}

// ── Options ──────────────────────────────────────────────────────────────────
export interface VolcanoTTSOptions {
  /** 代理 URL 或带 token 的火山 WS URL
   *  代理模式: 'ws://localhost:8765'
   *  直连模式: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection?token=YOUR_TOKEN'
   */
  wsUrl: string;

  /** 火山 TTS 应用 AppID（直连模式必填，代理模式由服务端注入） */
  appId?: string;

  /** 火山 TTS Token（直连模式用于 payload，或者放在 wsUrl 的 query 参数中） */
  token?: string;

  /** 音色 ID，如 'zh_female_qingxin' */
  voiceType?: string;

  /** 编码格式，推荐 'mp3' */
  encoding?: 'mp3' | 'ogg_opus' | 'pcm';

  /** 语速 0.2~3.0，默认 1.0 */
  speedRatio?: number;

  /** 音量 0.1~3.0，默认 1.0 */
  volumeRatio?: number;

  /** 采样率（PCM 模式必填），默认 24000 */
  sampleRate?: number;

  /** 是否启用（全局开关） */
  enabled?: boolean;

  /** 触发模式：'auto'=AI回复自动, 'manual'=按钮手动, 'both'=两者 */
  triggerMode?: 'auto' | 'manual' | 'both';
}

export function useVolcanoTTS(opts: VolcanoTTSOptions) {
  const [isSpeaking,    setIsSpeaking]    = useState(false);
  const [isConnecting,  setIsConnecting]  = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [debugLogs,     setDebugLogs]     = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    console.log(msg);
    setDebugLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-20));
  }, []);

  // WebSocket 实例
  const wsRef = useRef<WebSocket | null>(null);
  // AudioContext（懒创建，须在用户手势后）
  const audioCtxRef = useRef<AudioContext | null>(null);

  // 有序播放队列：{ index, chunks: ArrayBuffer[] }
  // 火山 TTS 单次连接可能只对应一句话，chunks 累积后一起解码
  const audioQueueRef   = useRef<{ index: number; chunks: ArrayBuffer[]; done: boolean }[]>([]);
  const nextPlayIdx     = useRef(0);
  const isPlayingRef    = useRef(false);
  const currentSrcRef   = useRef<AudioBufferSourceNode | null>(null);

  // 当前正在积累 chunks 的 slot index
  const currentSlotIdx  = useRef(0);

  // 文本缓冲
  const textBufferRef   = useRef('');
  const streamDoneRef   = useRef(false);

  // 请求序列号（每次 speak 调用递增）
  const reqIdRef = useRef(0);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // ── 顺序播放 ──────────────────────────────────────────────────────────────
  const tryPlayNext = useCallback(async () => {
    if (isPlayingRef.current) return;

    const expected = nextPlayIdx.current;
    const slot = audioQueueRef.current.find(s => s.index === expected);
    if (!slot) return;
    if (!slot.done) return; // 还在接收中，等收完

    if (slot.chunks.length === 0) {
      // 空 slot，跳过
      audioQueueRef.current = audioQueueRef.current.filter(s => s.index !== expected);
      nextPlayIdx.current++;
      tryPlayNext();
      return;
    }

    // 合并所有 chunks
    const totalLen = slot.chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of slot.chunks) {
      merged.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    audioQueueRef.current = audioQueueRef.current.filter(s => s.index !== expected);
    isPlayingRef.current = true;
    setIsSpeaking(true);

    try {
      const ctx = getAudioCtx();
      console.log(`[TTS] Playing slot ${expected}, total chunks: ${slot.chunks.length}, bytes: ${totalLen}`);
      const audioBuffer = await ctx.decodeAudioData(merged.buffer);
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(ctx.destination);
      currentSrcRef.current = src;
      src.start(0);
      src.onended = () => {
        console.log(`[TTS] Slot ${expected} finished playing`);
        isPlayingRef.current = false;
        currentSrcRef.current = null;
        nextPlayIdx.current++;

        // 检查是否全部播完
        const allDone = streamDoneRef.current &&
          audioQueueRef.current.length === 0 &&
          nextPlayIdx.current >= currentSlotIdx.current;
        if (allDone) {
          setIsSpeaking(false);
        } else {
          tryPlayNext();
        }
      };
    } catch (e) {
      console.warn('[TTS] Audio decode error:', e);
      isPlayingRef.current = false;
      nextPlayIdx.current++;
      tryPlayNext();
    }
  }, [getAudioCtx]);

  // ── 建立 WebSocket 并发送一句话 ───────────────────────────────────────────
  const speakSentence = useCallback((text: string, slotIndex: number) => {
    const cleanText = text.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (!cleanText) {
      // 推入空 done slot
      audioQueueRef.current.push({ index: slotIndex, chunks: [], done: true });
      tryPlayNext();
      return;
    }

    // 为这句话分配一个 slot
    audioQueueRef.current.push({ index: slotIndex, chunks: [], done: false });
    
    const urlObj = new URL(opts.wsUrl);
    if (opts.appId && opts.token) {
      if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
         // Proxy 模式：直接将 appid 和 token 作为 URL 参数供 Node Server 在 Header 注册 Bytedance WSS 
         urlObj.searchParams.set('appid', opts.appId);
         urlObj.searchParams.set('token', opts.token);
      }
    }
    
    console.log(`[TTS] Connecting to ${urlObj.toString()} for slot ${slotIndex}`);
    const ws = new WebSocket(urlObj.toString());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log(`[TTS] WS opened for slot ${slotIndex}, sending text...`);
      // 发送完整请求（fire-and-forget per sentence）
      const reqId = `req-${Date.now()}-${slotIndex}`;
      const payload = encodeTextPayload({
        app: {
          appid:   opts.appId || '',
          token:   opts.token || 'placeholder', 
          cluster: 'volcano_tts',
        },
        user:    { uid: 'metro-user' },
        request: { reqid: reqId, text: cleanText, text_type: 'plain', operation: 'query' },
        audio: {
          voice_type:   opts.voiceType   || 'BV700_streaming',
          encoding:     opts.encoding    || 'mp3',
          speed_ratio:  opts.speedRatio  || 1.0,
          volume_ratio: opts.volumeRatio || 1.0,
          pitch_ratio:  1.0,
        },
      });
      ws.send(payload);
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const { audio, isLast, jsonStr, msgTypeHex } = parseServerMessage(ev.data);
      const slot = audioQueueRef.current.find(s => s.index === slotIndex);
      
      if (jsonStr) {
        addLog(`[TTS] Server JSON Msg: ${jsonStr}`);
      } else if (msgTypeHex) {
        addLog(`[TTS] Received chunk (Type: ${msgTypeHex}), BufferSize: ${audio ? audio.byteLength : 0}`);
      }

      if (!slot) return;

      if (audio && audio.byteLength > 0) {
        slot.chunks.push(audio);
      }
      if (isLast) {
        addLog(`[TTS] Session finished for slot ${slotIndex}`);
        slot.done = true;
        ws.close();
        tryPlayNext();
      }
    };

    ws.onerror = (e) => {
      addLog(`[TTS] WS Error on slot ${slotIndex}`);
      console.warn('[TTS] WS error on slot', slotIndex, e);
      if (urlObj.hostname !== 'localhost' && urlObj.hostname !== '127.0.0.1') {
        addLog(`提示：由于浏览器不支持传递 Authorization Header，通常纯前端直连 wss://openspeech.bytedance.com 会报 403/401 握手失败。如果你没有在后台针对该 AppID 开启 URL Param Auth，请使用 ws://localhost:8765 本地代理。`);
      }
      const slot = audioQueueRef.current.find(s => s.index === slotIndex);
      if (slot) slot.done = true; // 跳过这句
      tryPlayNext();
    };

    ws.onclose = () => {
      addLog(`[TTS] WS Connection closed for slot ${slotIndex}`);
      // 确保 slot 被标记完成（服务端异常关闭时兜底）
      const slot = audioQueueRef.current.find(s => s.index === slotIndex);
      if (slot && !slot.done) {
        slot.done = true;
        tryPlayNext();
      }
    };

    // 保存 ws 引用以便 stop() 可关闭
    wsRef.current = ws;
  }, [opts, tryPlayNext]);

  // ── 公开 API ──────────────────────────────────────────────────────────────

  /** 流式模式：每次收到 LLM delta 调用此函数 */
  const pushTextDelta = useCallback((delta: string) => {
    textBufferRef.current += delta;

    // 提取完整句子
    SENTENCE_END_RE.lastIndex = 0;
    const sentences: string[] = [];
    let match;
    while ((match = SENTENCE_END_RE.exec(textBufferRef.current)) !== null) {
      sentences.push(match[0]);
    }

    // 强制切分超长缓冲
    if (sentences.length === 0 && textBufferRef.current.length > MAX_BUFFER_LEN) {
      sentences.push(textBufferRef.current);
      textBufferRef.current = '';
    } else if (sentences.length > 0) {
      const last = sentences[sentences.length - 1];
      const lastEnd = textBufferRef.current.lastIndexOf(last) + last.length;
      textBufferRef.current = textBufferRef.current.slice(lastEnd);
    }

    for (const s of sentences) {
      if (s.trim().length >= MIN_CHUNK_LEN) {
        const idx = currentSlotIdx.current++;
        speakSentence(s, idx);
      }
    }
  }, [speakSentence]);

  /** 流结束时调用，冲刷剩余文本 */
  const flushRemaining = useCallback(() => {
    streamDoneRef.current = true;
    const remaining = textBufferRef.current.trim();
    if (remaining.length >= 1) {
      const idx = currentSlotIdx.current++;
      speakSentence(remaining, idx);
    }
    textBufferRef.current = '';
  }, [speakSentence]);

  /** 手动朗读整段文本（非流式，用于点击按钮触发） */
  const speakFull = useCallback((text: string) => {
    stopAll();
    setIsConnecting(true);
    setError(null);

    // 重置状态
    audioQueueRef.current = [];
    nextPlayIdx.current = 0;
    currentSlotIdx.current = 0;
    streamDoneRef.current = false;
    textBufferRef.current = '';

    // 按句子切分后依次合成
    const parts = text.match(SENTENCE_END_RE) || [text];
    const remaining = text.replace(SENTENCE_END_RE, '').trim();

    parts.forEach((part, i) => {
      if (part.trim().length >= MIN_CHUNK_LEN) {
        currentSlotIdx.current = i;
        speakSentence(part, i);
      }
    });
    if (remaining.length >= 1) {
      speakSentence(remaining, currentSlotIdx.current++);
    }

    streamDoneRef.current = true;
    setIsConnecting(false);
  }, [speakSentence]);

  /** 开始新会话（流式模式，在 handleSend 最前调用） */
  const startSession = useCallback(() => {
    stopAll();
    audioQueueRef.current = [];
    nextPlayIdx.current = 0;
    currentSlotIdx.current = 0;
    isPlayingRef.current = false;
    textBufferRef.current = '';
    streamDoneRef.current = false;
    reqIdRef.current++;
    setError(null);
  }, []);

  /** 停止一切播放和连接 */
  function stopAll() {
    if (currentSrcRef.current) {
      try { currentSrcRef.current.stop(); } catch { /* ignore */ }
      currentSrcRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    isPlayingRef.current = false;
    audioQueueRef.current = [];
    setIsSpeaking(false);
    setIsConnecting(false);
  }

  const stop = useCallback(stopAll, []);

  return {
    // 流式模式
    pushTextDelta,
    flushRemaining,
    startSession,
    // 手动模式
    speakFull,
    // 控制
    stop,
    // 状态
    isSpeaking,
    isConnecting,
    error,
    debugLogs,
  };
}