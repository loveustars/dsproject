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
/** 流式首 token 常为单字，若要求 ≥2 会丢掉首字，导致下一段从句中开始播 */
const MIN_CHUNK_LEN = 1;
const MAX_BUFFER_LEN = 80; // 缓冲区超过此长度强制切分（防止句子过长）
const IDLE_FLUSH_MS = 260; // 增量流在短暂静默后提前冲刷，减少“像等全文输出”的体感

/** 流式 idle 冲刷：若以逗号/顿号等「软停顿」结尾且尚无句号，不单独送 TTS（单独首分句易合成空/失败，表现为「只从第二分句播」） */
function shouldDeferIdleFlush(pending: string): boolean {
  const t = pending.trimEnd();
  if (t.length === 0) return false;
  if (t.length > MAX_BUFFER_LEN * 2) return false;
  if (!/[，,;；:：、]$/.test(t)) return false;
  return !/[。！？!?.…\n]$/.test(t);
}

function detectLang(text: string): 'zh' | 'ja' | 'en' | 'multi' {
  const hasJa = /[\u3040-\u30ff]/.test(text); // 平假名/片假名
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  const hasEn = /[A-Za-z]/.test(text);

  if (hasJa && !hasEn) return 'ja';
  if (hasEn && !hasCjk && !hasJa) return 'en';
  if (hasCjk && !hasJa && !hasEn) return 'zh';
  return 'multi';
}

function hasKana(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text);
}

function splitMixedLanguage(text: string): string[] {
  const src = text.trim();
  if (!src) return [];

  // 不要按按字符语言类型拆分（汉字和假名混排会被强行切断，造成一半中文一半日文）。
  // 只需要按标点符号长短句拆分即可。火山 TTS 大模型会自动根据整句的上下文识别语言。
  const hardBreak = /[。！？!?\n]/;
  const softBreak = /[,，;；:：、]/;
  const result: string[] = [];

  let cur = '';
  let curHasKana = false;
  let lastSpaceIdx = -1;

  for (const ch of src) {
    if (hardBreak.test(ch)) {
      cur += ch;
      if (cur.trim()) result.push(cur.trim());
      cur = '';
      curHasKana = false;
      continue;
    }

    cur += ch;
    if (ch === ' ') lastSpaceIdx = cur.length - 1;
    if (hasKana(ch)) curHasKana = true;
    // 如果句子足够长，允许在软停顿处切分（含假名则尽量不断句）
    if (softBreak.test(ch) && cur.trim().length >= 12 && !curHasKana) {
      result.push(cur.trim());
      cur = '';
      curHasKana = false;
      continue;
    }

    // 防止单段过长（超过 60 字符强制切，尽量找个空格或词间）
    if (cur.length >= 60) {
      if (lastSpaceIdx > 10 && /[A-Za-z]/.test(cur)) {
        const left = cur.slice(0, lastSpaceIdx).trim();
        const right = cur.slice(lastSpaceIdx + 1).trim();
        if (left) result.push(left);
        cur = right;
      } else {
        result.push(cur.trim());
        cur = '';
      }
      curHasKana = false;
      lastSpaceIdx = -1;
      continue;
    }
  }

  if (cur.trim()) result.push(cur.trim());
  return result;
}

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

  /** 按语言指定音色（可选），用于多语言强制切换 */
  voiceTypeMap?: Partial<Record<'zh' | 'ja' | 'en', string>>;

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

  /** 为 true 时：检测到正文为中文也改用英文音色与 language（日文仍走日文） */
  preferEnTtsVoice?: boolean;
}

export function useVolcanoTTS(opts: VolcanoTTSOptions) {
  const [isSpeaking,    setIsSpeaking]    = useState(false);
  const [isConnecting,  setIsConnecting]  = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [debugLogs,     setDebugLogs]     = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    console.log(msg);
    setDebugLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-200));
  }, []);

  // WebSocket 实例
  const wsRef = useRef<WebSocket | null>(null);
  // AudioContext（懒创建，须在用户手势后）
  const audioCtxRef = useRef<AudioContext | null>(null);

  // 有序播放队列：{ index, chunks, done, silencePrime? }
  // silencePrime：流式开始时插入的本地静音，不占火山连接；用于抵消「首包合成/解码偶发被吞」
  const audioQueueRef   = useRef<
    { index: number; chunks: ArrayBuffer[]; done: boolean; silencePrime?: boolean }[]
  >([]);
  const nextPlayIdx     = useRef(0);
  const isPlayingRef    = useRef(false);
  const currentSrcRef   = useRef<AudioBufferSourceNode | null>(null);

  // 当前正在积累 chunks 的 slot index
  const currentSlotIdx  = useRef(0);

  // 文本缓冲
  const textBufferRef   = useRef('');
  const streamDoneRef   = useRef(false);
  const idleFlushTimerRef = useRef<number | null>(null);

  // 请求序列号（每次 speak 调用递增）
  const reqIdRef = useRef(0);

  // 合成队列（串行发送到 TTS，避免多连接并发导致 workflow/resource 阻塞）
  const synthQueueRef = useRef<{ slotIndex: number; text: string }[]>([]);
  const isSynthesizingRef = useRef(false);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  /** 在用户手势回调里调用（如点击「介绍」、发送消息），提前 await resume，满足浏览器自动播放策略 */
  const unlockAudio = useCallback(async () => {
    try {
      const ctx = getAudioCtx();
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      /**/
    }
  }, [getAudioCtx]);

  // ── 顺序播放 ──────────────────────────────────────────────────────────────
  const tryPlayNext = useCallback(async () => {
    if (isPlayingRef.current) return;

    const expected = nextPlayIdx.current;
    const slot = audioQueueRef.current.find(s => s.index === expected);
    if (!slot) return;
    if (!slot.done) return; // 还在接收中，等收完

    if (slot.silencePrime) {
      const ctx = getAudioCtx();
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /**/
        }
      }
      audioQueueRef.current = audioQueueRef.current.filter(s => s.index !== expected);
      isPlayingRef.current = true;
      setIsSpeaking(true);
      const sampleRate = ctx.sampleRate;
      const sec = 0.09;
      const frames = Math.max(1, Math.floor(sampleRate * sec));
      const buf = ctx.createBuffer(1, frames, sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      currentSrcRef.current = src;
      addLog(`[TTS] Playing slot ${expected} silence-prime (${sec}s)`);
      src.start(0);
      src.onended = () => {
        isPlayingRef.current = false;
        currentSrcRef.current = null;
        nextPlayIdx.current++;
        const allDone = streamDoneRef.current &&
          audioQueueRef.current.length === 0 &&
          nextPlayIdx.current >= currentSlotIdx.current;
        if (allDone) {
          setIsSpeaking(false);
        } else {
          tryPlayNext();
        }
      };
      return;
    }

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
      // 流式首句常在 setTimeout(idle flush) 后播放，已脱离用户手势；同步 resume() 未 await 时上下文仍为 suspended，会整段无声并被误认为「跳过首句」
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /**/
        }
      }
      console.log(`[TTS] Playing slot ${expected}, total chunks: ${slot.chunks.length}, bytes: ${totalLen}, ctx=${ctx.state}`);
      const audioBuffer = await ctx.decodeAudioData(merged.buffer.slice(0));
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
  }, [getAudioCtx, addLog]);

  // ── 建立 WebSocket 并发送一句话（底层执行器：由串行队列调度） ───────────────
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
    
    const normalizedText = cleanText.replace(/^\s*(中文|日本語|日语|英语|English)\s*[:：]\s*/i, '').trim();
    const finalText = normalizedText || cleanText;
    const lang = detectLang(finalText);
    const ttsLang =
      opts.preferEnTtsVoice && lang === 'zh' ? 'en' : lang;

    let ws: WebSocket | null = null;
    let finished = false;
    let inactivityTimer: number | null = null;
    let watchdogTimer: number | null = null;

    const clearTimers = () => {
      if (inactivityTimer) {
        window.clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (watchdogTimer) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    const finalizeSlot = (reason: string, closeWs = true) => {
      if (finished) return;
      finished = true;
      clearTimers();
      addLog(`[TTS] Finalize slot ${slotIndex}: ${reason}`);

      const slot = audioQueueRef.current.find(s => s.index === slotIndex);
      if (slot && !slot.done) slot.done = true;

      isSynthesizingRef.current = false;
      tryPlayNext();
      processSynthQueue();

      if (closeWs && ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch { /**/ }
      }
    };

    const startSession = (textToSend: string) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch { /**/ }
      }

      console.log(`[TTS] Connecting to ${urlObj.toString()} for slot ${slotIndex}`);
      ws = new WebSocket(urlObj.toString());
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log(`[TTS] WS opened for slot ${slotIndex}, sending text...`);
        // 发送完整请求（fire-and-forget per sentence）
        const reqId = `req-${Date.now()}-${slotIndex}`;
        const resolvedVoice =
          opts.voiceTypeMap?.[ttsLang as 'zh' | 'ja' | 'en'] ||
          opts.voiceType ||
          'BV700_streaming';

        const resolvedLanguage =
          ttsLang === 'ja' ? 'ja' :
          ttsLang === 'en' ? 'en' :
          'cn';

        addLog(`[TTS] slot ${slotIndex} lang=${lang} ttsLang=${ttsLang} audio.lang=${resolvedLanguage} len=${finalText.length} kana=${hasKana(finalText) ? 'yes' : 'no'}`);
        addLog(`[TTS] slot ${slotIndex} textPreview=${JSON.stringify(textToSend.slice(0, 120))}`);

        const payload = encodeTextPayload({
          app: {
            appid:   opts.appId || '',
            token:   opts.token || 'placeholder', 
            cluster: 'volcano_tts',
          },
          user:    { uid: 'metro-user' },
          request: {
            reqid: reqId,
            text: textToSend,
            text_type: 'plain',
            operation: 'query',
          },
          audio: {
            voice_type:   resolvedVoice,
            encoding:     opts.encoding    || 'mp3',
            speed_ratio:  opts.speedRatio  || 1.0,
            volume_ratio: opts.volumeRatio || 1.0,
            pitch_ratio:  1.0,
            language:     resolvedLanguage,
          },
        });
        ws?.send(payload);

        // 防卡死兜底：服务端异常不回 last chunk 时，强制结束当前 slot
        watchdogTimer = window.setTimeout(() => {
          finalizeSlot('watchdog-timeout');
        }, 12000);
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

          if (inactivityTimer) window.clearTimeout(inactivityTimer);
          // 一段时间未收到新分片，视为服务端未发 last 标记，强制切下一段
          inactivityTimer = window.setTimeout(() => {
            finalizeSlot('audio-inactivity-timeout');
          }, 1200);
        }

        // 错误/控制消息：避免一直占住“播放中”
        if (jsonStr && (msgTypeHex === '0xf' || msgTypeHex === '0xc')) {
          finalizeSlot('server-error-or-control');
          return;
        }

        if (isLast) {
          addLog(`[TTS] Session finished for slot ${slotIndex}`);
          finalizeSlot('isLast');
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
        finalizeSlot('ws-error', false);
      };

      ws.onclose = () => {
        addLog(`[TTS] WS Connection closed for slot ${slotIndex}`);
        finalizeSlot('ws-close', false);
      };

      // 保存 ws 引用以便 stop() 可关闭
      wsRef.current = ws;
    };

    startSession(finalText);
  }, [opts, tryPlayNext, addLog]);

  const processSynthQueue = useCallback(() => {
    if (isSynthesizingRef.current) return;
    const next = synthQueueRef.current.shift();
    if (!next) {
      if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
        setIsSpeaking(false);
      }
      return;
    }
    isSynthesizingRef.current = true;
    speakSentence(next.text, next.slotIndex);
  }, [speakSentence]);

  const enqueueSentence = useCallback((text: string) => {
    const chunks = splitMixedLanguage(text);
    for (const chunk of chunks) {
      const clean = chunk.trim();
      if (!clean || clean.length < MIN_CHUNK_LEN) continue;
      const idx = currentSlotIdx.current++;
      synthQueueRef.current.push({ slotIndex: idx, text: clean });
    }
    processSynthQueue();
  }, [processSynthQueue]);

  // ── 公开 API ──────────────────────────────────────────────────────────────

  /** 流式模式：每次收到 LLM delta 调用此函数 */
  const pushTextDelta = useCallback((delta: string) => {
    textBufferRef.current += delta;

    if (idleFlushTimerRef.current) {
      window.clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }

    // 提取完整句子（用 match.index 累计已消费长度，避免 lastIndexOf 在重复子串时切错导致丢字）
    SENTENCE_END_RE.lastIndex = 0;
    const sentences: string[] = [];
    let consumedEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_END_RE.exec(textBufferRef.current)) !== null) {
      sentences.push(match[0]);
      consumedEnd = match.index + match[0].length;
    }

    // 强制切分超长缓冲（尽量避免英文断词）
    if (sentences.length === 0 && textBufferRef.current.length > MAX_BUFFER_LEN) {
      const buf = textBufferRef.current;
      const lastSpace = buf.lastIndexOf(' ');
      if (lastSpace > 10 && /[A-Za-z]/.test(buf)) {
        sentences.push(buf.slice(0, lastSpace));
        textBufferRef.current = buf.slice(lastSpace + 1);
      } else {
        sentences.push(buf);
        textBufferRef.current = '';
      }
    } else if (sentences.length > 0) {
      textBufferRef.current = textBufferRef.current.slice(consumedEnd);
    }

    for (const s of sentences) {
      enqueueSentence(s);
    }

    // 若短时间没有新 token，提前冲刷缓冲（不必等句号）
    idleFlushTimerRef.current = window.setTimeout(() => {
      const pending = textBufferRef.current.trim();
      if (!pending) return;
      if (shouldDeferIdleFlush(pending)) return;
      if (pending.length >= 8 || /[,，;；:：、]/.test(pending)) {
        enqueueSentence(pending);
        textBufferRef.current = '';
      }
    }, IDLE_FLUSH_MS);
  }, [enqueueSentence]);

  /** 流结束时调用，冲刷剩余文本 */
  const flushRemaining = useCallback(() => {
    streamDoneRef.current = true;
    if (idleFlushTimerRef.current) {
      window.clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }
    const remaining = textBufferRef.current.trim();
    if (remaining.length >= 1) {
      enqueueSentence(remaining);
    }
    textBufferRef.current = '';
  }, [enqueueSentence]);

  /** 手动朗读整段文本（非流式，用于点击按钮触发） */
  const speakFull = useCallback((text: string) => {
    void unlockAudio();
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

    parts.forEach((part) => {
      if (part.trim().length >= MIN_CHUNK_LEN) {
        enqueueSentence(part);
      }
    });
    if (remaining.length >= 1) {
      enqueueSentence(remaining);
    }

    streamDoneRef.current = true;
    setIsConnecting(false);
  }, [enqueueSentence, unlockAudio]);

  /** 开始新会话（流式模式，在 handleSend 最前调用） */
  const startSession = useCallback(() => {
    stopAll();
    audioQueueRef.current = [];
    nextPlayIdx.current = 0;
    // 索引 0 预留给本地静音槽，正文 TTS 从 1 起，与「首路火山偶发无声」错开
    currentSlotIdx.current = 1;
    isPlayingRef.current = false;
    textBufferRef.current = '';
    streamDoneRef.current = false;
    if (idleFlushTimerRef.current) {
      window.clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }
    reqIdRef.current++;
    synthQueueRef.current = [];
    isSynthesizingRef.current = false;
    setError(null);
    audioQueueRef.current.push({
      index: 0,
      chunks: [],
      done: true,
      silencePrime: true,
    });
    tryPlayNext();
  }, [tryPlayNext]);

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
    synthQueueRef.current = [];
    isSynthesizingRef.current = false;
    if (idleFlushTimerRef.current) {
      window.clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }
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
    unlockAudio,
    // 状态
    isSpeaking,
    isConnecting,
    error,
    debugLogs,
  };
}