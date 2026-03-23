import { useState, useEffect, useRef, useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Map, { NavigationControl } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import './App.css';
import { useVolcanoTTS } from './useVolcanoTTS';

// ─── Types ─────────────────────────────────────────────────────────────────
interface Station { name: string; x: number; y: number; }
interface RouteType {
  color1: string; color2: string; label1: string; label2: string;
  stations: Station[]; switchAt: number; duration: number; badge?: string; desc: string;
}
interface Message { id: number; role: 'ai' | 'user'; content: string; }
interface ChatSession { id: string; title: string; timestamp: number; messages: Message[]; }

// ─── Static data ────────────────────────────────────────────────────────────
const routesData: RouteType[] = [
  {
    color1: '#D85A30', color2: '#185FA5', label1: '大兴机场线', label2: '10号线',
    duration: 52, badge: '最快', desc: '大兴机场线 + 10号线 · 1次换乘', switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥',    x: 0.39, y: 0.57 }, { name: '劲松',     x: 0.56, y: 0.40 },
      { name: '双井',    x: 0.68, y: 0.32 }, { name: '国贸',     x: 0.82, y: 0.22 },
    ],
  },
  {
    color1: '#D85A30', color2: '#3B6D11', label1: '大兴机场线', label2: '7号线',
    duration: 58, desc: '大兴机场线 + 7号线 · 1次换乘', switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥',    x: 0.39, y: 0.57 }, { name: '大兴新城',  x: 0.52, y: 0.46 },
      { name: '亦庄桥',  x: 0.65, y: 0.36 }, { name: '国贸',     x: 0.82, y: 0.22 },
    ],
  },
];

const formatRelativeDate = (ts: number) => {
  const date = new Date(ts), now = new Date();
  const diff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
     new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000
  );
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const defaultSessions: ChatSession[] = [
  {
    id: 'session-1', title: '大兴机场到国贸路线', timestamp: Date.now(),
    messages: [
      { id: 1, role: 'ai',   content: '你好！我是**京轨助手**，请问有什么可以帮您？' },
      { id: 2, role: 'user', content: '从大兴机场到国贸怎么走？' },
      { id: 3, role: 'ai',   content: '推荐乘坐**大兴机场线**换乘**10号线**，全程约 **52 分钟**。具体路线已在右侧地图标出。' },
    ],
  },
  {
    id: 'session-2', title: '早高峰换乘建议', timestamp: Date.now() - 86400000,
    messages: [
      { id: 1, role: 'user', content: '早上哪条线人少？' },
      { id: 2, role: 'ai',   content: '早高峰各线客流均较大，建议错峰出行，避开 **10号线**、**4号线** 等热门线路。' },
    ],
  },
];

const SYSTEM_PROMPT = `你是一个名为"京轨助手"的智能地铁出行向导，为用户提供精准的北京地铁出行建议。

【核心职能】
1. 智能出行规划：理解起点、终点和换乘意图，规划最优路线，引导用户查看右侧地图。
2. 文化融合：途经历史地标时，自然穿插简短的文化科普。

【回答格式】
- 语气友好、专业、干练。
- 使用 Markdown 排版，对线路名、站点、耗时加粗。
- 若未获取起始点，热情询问。`;

const VOLCANO_VOICES = [
  { value: 'BV700_streaming',      label: '豆包 2.0 通用女声（推荐）' },
];

type TriggerMode = 'auto' | 'manual' | 'both';

// ─── App ────────────────────────────────────────────────────────────────────
export default function App() {
  // persist
  const [appLanguage, setAppLanguage] = useState<'zh' | 'en'>(
    () => (localStorage.getItem('metro-lang') as 'zh' | 'en') || 'zh'
  );
  const [apiEndpoint,   setApiEndpoint]   = useState(() => localStorage.getItem('metro-endpoint') || 'https://api.openai.com/v1');
  const [apiKey,        setApiKey]        = useState(() => localStorage.getItem('metro-key')      || '');
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('metro-model')    || '');
  const [mapboxToken,   setMapboxToken]   = useState(() => localStorage.getItem('metro-mapbox-token') || '');
  const [ttsEnabled,    setTtsEnabled]    = useState(() => localStorage.getItem('metro-tts') !== 'false');
  const [ttsAppId,      setTtsAppId]      = useState(() => localStorage.getItem('metro-tts-appid') || '');
  const [ttsToken,      setTtsToken]      = useState(() => localStorage.getItem('metro-tts-token') || '');
  const [ttsWsUrl,      setTtsWsUrl]      = useState(() => localStorage.getItem('metro-tts-ws')    || 'ws://localhost:8765');
  const [ttsVoice,      setTtsVoice]      = useState(() => localStorage.getItem('metro-tts-voice') || 'BV700_streaming');
  const [ttsSpeed,      setTtsSpeed]      = useState(() => parseFloat(localStorage.getItem('metro-tts-speed') || '1.0'));
  const [triggerMode,   setTriggerMode]   = useState<TriggerMode>(
    () => (localStorage.getItem('metro-tts-trigger') as TriggerMode) || 'both'
  );

  useEffect(() => { localStorage.setItem('metro-lang',         appLanguage); },        [appLanguage]);
  useEffect(() => { localStorage.setItem('metro-endpoint',     apiEndpoint); },        [apiEndpoint]);
  useEffect(() => { localStorage.setItem('metro-key',          apiKey); },             [apiKey]);
  useEffect(() => { localStorage.setItem('metro-model',        selectedModel); },      [selectedModel]);
  useEffect(() => { localStorage.setItem('metro-mapbox-token', mapboxToken); },        [mapboxToken]);
  useEffect(() => { localStorage.setItem('metro-tts',          String(ttsEnabled)); }, [ttsEnabled]);
  useEffect(() => { localStorage.setItem('metro-tts-appid',    ttsAppId); },           [ttsAppId]);
  useEffect(() => { localStorage.setItem('metro-tts-token',    ttsToken); },           [ttsToken]);
  useEffect(() => { localStorage.setItem('metro-tts-ws',       ttsWsUrl); },           [ttsWsUrl]);
  useEffect(() => { localStorage.setItem('metro-tts-voice',    ttsVoice); },           [ttsVoice]);

  // 兼容迁移：历史版本可能保存了不稳定的直连地址，这里自动切回本地代理
  useEffect(() => {
    const old = localStorage.getItem('metro-tts-ws') || '';
    if (old.includes('openspeech.bytedance.com')) {
      setTtsWsUrl('ws://localhost:8765');
    }
  }, []);
  useEffect(() => { localStorage.setItem('metro-tts-speed',    String(ttsSpeed)); },   [ttsSpeed]);
  useEffect(() => { localStorage.setItem('metro-tts-trigger',  triggerMode); },        [triggerMode]);

  const t = (zh: string, en: string) => appLanguage === 'zh' ? zh : en;

  // sessions
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem('metro-sessions');
    if (saved) { try { return JSON.parse(saved); } catch { /**/ } }
    return defaultSessions;
  });
  useEffect(() => { localStorage.setItem('metro-sessions', JSON.stringify(sessions)); }, [sessions]);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [hasStarted,    setHasStarted]    = useState(false);
  const [historyOpen,   setHistoryOpen]   = useState(false);
  const [sidebarOpen,   setSidebarOpen]   = useState(false);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [inputVal,      setInputVal]      = useState('');
  const [isTyping,      setIsTyping]      = useState(false);

  // settings
  const [settingsOpen,     setSettingsOpen]     = useState(false);
  const [settingsTab,      setSettingsTab]      = useState('api');
  const [provider,         setProvider]         = useState('openai-compatible');
  const [availableModels,  setAvailableModels]  = useState<string[]>([]);
  const [modelSearch,      setModelSearch]      = useState('');
  const [fetchingModels,   setFetchingModels]   = useState(false);
  const [fetchMsg,         setFetchMsg]         = useState({ type: '', text: '' });
  const [debugInfo,        setDebugInfo]        = useState<{ req?: string; res?: string; status?: number } | null>(null);

  // streaming
  const [streamingText,  setStreamingText]  = useState('');
  const streamingTextRef = useRef('');

  // TTS
  const tts = useVolcanoTTS({
    wsUrl:      ttsToken ? `${ttsWsUrl}?token=${ttsToken}` : ttsWsUrl,
    appId:      ttsAppId,
    token:      ttsToken,
    voiceType:  ttsVoice,
    speedRatio: ttsSpeed,
    enabled:    ttsEnabled,
    triggerMode,
  });

  const currentMessages = currentSessionId
    ? (sessions.find(s => s.id === currentSessionId)?.messages ?? [])
    : [];

  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isTyping, streamingText]);

  // ── handleSend ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!inputVal.trim() || isTyping) return;

    const userMsg: Message = { id: Date.now(), role: 'user', content: inputVal };
    let sessionId = currentSessionId;
    const isNew = !hasStarted || !currentSessionId;

    if (isNew) {
      setHasStarted(true);
      setSidebarOpen(true);
      sessionId = `session-${Date.now()}`;
      setCurrentSessionId(sessionId);
      setSessions(prev => [{ id: sessionId!, title: inputVal.slice(0, 12), timestamp: Date.now(), messages: [userMsg] }, ...prev]);
    } else {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: [...s.messages, userMsg] } : s));
    }

    const query = inputVal;
    setInputVal('');
    setIsTyping(true);
    streamingTextRef.current = '';
    setStreamingText('');

    const autoTts = ttsEnabled && (triggerMode === 'auto' || triggerMode === 'both');
    if (autoTts) tts.startSession();

    try {
      const session = sessions.find(s => s.id === (isNew ? null : sessionId));
      const history = (session?.messages ?? []).filter(m => typeof m.content === 'string');
      while (history.length && history[0].role === 'ai') history.shift();

      const apiMsgs = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
        { role: 'user', content: query },
      ];

      const resp = await fetch(`${apiEndpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: selectedModel || 'gpt-3.5-turbo', messages: apiMsgs, stream: true }),
      });

      if (!resp.ok || !resp.body) {
        const err = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${err.slice(0, 200)}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim().startsWith('data:')) continue;
          const data = line.trim().slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              streamingTextRef.current += delta;
              setStreamingText(streamingTextRef.current);
              if (autoTts) tts.pushTextDelta(delta);
            }
          } catch { /**/ }
        }
      }

      if (autoTts) tts.flushRemaining();

      const finalText = streamingTextRef.current;
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { id: Date.now() + 1, role: 'ai', content: finalText }] }
          : s
      ));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { id: Date.now() + 1, role: 'ai', content: `[请求出错]: ${msg}` }] }
          : s
      ));
      tts.stop();
    } finally {
      setIsTyping(false);
      setStreamingText('');
      streamingTextRef.current = '';
    }
  }, [inputVal, isTyping, currentSessionId, hasStarted, sessions, apiEndpoint, apiKey, selectedModel, ttsEnabled, triggerMode, tts]);

  const handleNewChat = () => { tts.stop(); setHasStarted(false); setCurrentSessionId(null); setHistoryOpen(false); };
  const handleSelectSession = (id: string) => { tts.stop(); setCurrentSessionId(id); setHasStarted(true); setHistoryOpen(false); };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') handleSend(); };

  const handleFetchModels = async () => {
    if (!apiEndpoint || !apiKey) { setFetchMsg({ type: 'error', text: '请先填写 Endpoint 和 API Key' }); return; }
    setFetchingModels(true); setFetchMsg({ type: '', text: '' });
    try {
      let url = apiEndpoint.replace(/\/+$/, '');
      if (!url.endsWith('/v1')) url += '/v1';
      const res = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`状态码 ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.data)) {
        const models: string[] = data.data.map((m: { id: string }) => m.id);
        setAvailableModels(models);
        if (models.length) setSelectedModel(models[0]);
        setFetchMsg({ type: 'success', text: `获取到 ${models.length} 个模型` });
      } else throw new Error('响应格式无法解析');
    } catch (e: unknown) {
      setFetchMsg({ type: 'error', text: e instanceof Error ? e.message : '失败' });
    } finally { setFetchingModels(false); }
  };

  const handleTestConn = async () => {
    setDebugInfo({ req: '测试中...', res: '' });
    try {
      const url = `${apiEndpoint.replace(/\/$/, '')}/chat/completions`;
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      const body = { model: selectedModel || 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 };
      const hid = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '无';
      setDebugInfo({ req: `POST ${url}\nAuthorization: Bearer ${hid}`, res: '等待响应...' });
      const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
      const text = await res.text();
      setDebugInfo(prev => ({ ...prev, status: res.status, res: `${res.status} ${res.ok ? 'OK' : 'Error'}\n\n${text}` }));
    } catch (e: unknown) {
      setDebugInfo(prev => ({ ...prev, status: 0, res: `Network Error: ${e instanceof Error ? e.message : ''}` }));
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div id="app">
      {/* Topbar */}
      <div id="topbar">
        <button id="menu-btn" className={historyOpen ? 'open' : ''} onClick={() => setHistoryOpen(!historyOpen)}>
          <span /><span /><span />
        </button>
        <button id="top-new-chat-btn" onClick={handleNewChat} title="新建对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="logo-area">
          <span className="logo-text">{t('京轨', 'Beijing Metro AI')}</span>
        </div>

        {/* TTS pill */}
        {ttsEnabled && (tts.isSpeaking || tts.isConnecting) && (
          <button className="tts-status-pill" onClick={tts.stop} title={t('点击停止', 'Click to stop')}>
            <span className="tts-wave"><span /><span /><span /><span /></span>
            <span>{tts.isConnecting && !tts.isSpeaking ? t('合成中…', 'Synth…') : t('播放中', 'Playing')}</span>
          </button>
        )}

        <button id="sidebar-toggle-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
          </svg>
        </button>
      </div>

      {/* History */}
      <div id="history-drawer" className={historyOpen ? 'open' : ''}>
        <div className="history-header">
          <div className="history-section-label">{t('历史记录', 'History')}</div>
        </div>
        <div className="history-list">
          {sessions.map(s => (
            <div key={s.id} className={`history-item ${s.id === currentSessionId ? 'active' : ''}`}
              onClick={() => handleSelectSession(s.id)}>
              <div className="history-title">{s.title}</div>
              <div className="hist-date">{formatRelativeDate(s.timestamp)}</div>
              <button className="del-session-btn" onClick={e => {
                e.stopPropagation();
                setSessions(prev => prev.filter(x => x.id !== s.id));
                if (currentSessionId === s.id) { setCurrentSessionId(null); setHasStarted(false); }
              }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="history-footer">
          <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="18" height="18">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('设置', 'Settings')}
          </button>
        </div>
      </div>

      {/* Main */}
      <div id="main" className={`${sidebarOpen ? 'sidebar-open' : ''} ${historyOpen ? 'history-open' : ''}`.trim()}>
        <div id="chat-area">
          {!hasStarted ? (
            <div className="welcome-screen">
              <div className="welcome-logo">
                <div className="metro-icon large">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M4 18L8 6l4 8 4-8 4 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
              <h2 className="welcome-title">{t('今天想去哪里？', 'Where to today?')}</h2>
              <div className="welcome-input-wrapper">
                <div className="input-box shadow-xl">
                  <input type="text" value={inputVal} onChange={e => setInputVal(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('试试问：从大兴机场到国贸怎么走？', 'Try: How do I get to Guomao?')}
                    autoFocus />
                  <button className="send-btn" onClick={handleSend}>{t('发送', 'Send')}</button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div id="messages">
                {currentMessages.map(msg => (
                  <div key={msg.id} className={`msg-wrap ${msg.role}`}>
                    {msg.role === 'ai' && <div className="avatar ai">M</div>}
                    <div className={`bubble ${msg.role}`}>
                      {msg.role === 'ai'
                        ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
                        : msg.content}
                      {/* 手动朗读按钮 */}
                      {msg.role === 'ai' && ttsEnabled && (triggerMode === 'manual' || triggerMode === 'both') && (
                        <button className="msg-tts-btn" onClick={() => tts.speakFull(msg.content)}
                          title={t('朗读此消息', 'Read aloud')}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {msg.role === 'user' && <div className="avatar user">我</div>}
                  </div>
                ))}

                {isTyping && streamingText && (
                  <div className="msg-wrap ai">
                    <div className="avatar ai">M</div>
                    <div className="bubble ai">
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}

                {isTyping && !streamingText && (
                  <div className="msg-wrap ai">
                    <div className="avatar ai">M</div>
                    <div className="bubble ai">
                      <div className="typing-indicator"><span /><span /><span /></div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div id="input-area">
                <div className="input-box">
                  <input type="text" value={inputVal} onChange={e => setInputVal(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('尝试输入...', 'Type a message...')}
                    disabled={isTyping} autoFocus />
                  <button className={`tts-toggle-btn ${ttsEnabled ? 'active' : ''}`}
                    onClick={() => { tts.stop(); setTtsEnabled(v => !v); }}
                    title={ttsEnabled ? t('关闭语音', 'Disable TTS') : t('开启语音', 'Enable TTS')}>
                    {ttsEnabled
                      ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                        </svg>
                    }
                  </button>
                  <button className="send-btn" onClick={handleSend} disabled={isTyping}>{t('发送', 'Send')}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <div id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <div className="panel-label">推荐路线</div>
        <div id="route-panel">
          {routesData.map((route, idx) => (
            <div key={idx} className={`route-card ${selectedRoute === idx ? 'selected' : ''}`} onClick={() => setSelectedRoute(idx)}>
              <div className="line-dot" style={{ background: route.color1 }} />
              <div className="route-info-text">
                <div className="route-name">大兴机场 → 国贸</div>
                <div className="route-sub">{route.desc}</div>
              </div>
              <div className="route-duration">{route.duration} 分</div>
            </div>
          ))}
        </div>
        <div className="panel-label">线路地图</div>
        <div id="map-panel">
          {mapboxToken
            ? <Map mapboxAccessToken={mapboxToken}
                initialViewState={{ longitude: 116.4074, latitude: 39.9042, zoom: 10 }}
                style={{ width: '100%', height: '100%' }}
                mapStyle={window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11'}>
                <NavigationControl position="bottom-right" />
              </Map>
            : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', flexDirection: 'column', gap: 10 }}>
                <p>{t('请在设置中配置 Mapbox Token', 'Configure Mapbox Token in settings')}</p>
                <button className="btn-secondary" onClick={() => { setSettingsOpen(true); setSettingsTab('general'); }}>{t('去设置', 'Settings')}</button>
              </div>
          }
        </div>
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="settings-layout">
              <div className="settings-sidebar">
                <div className="settings-header-title">{t('设置', 'Settings')}</div>
                {[
                  { key: 'api',     label: t('模型与接口', 'Model & API') },
                  { key: 'tts',     label: t('语音合成',   'Voice / TTS') },
                  { key: 'general', label: t('通用设置',   'General') },
                ].map(tab => (
                  <div key={tab.key}
                    className={`settings-tab ${settingsTab === tab.key ? 'active' : ''}`}
                    onClick={() => setSettingsTab(tab.key)}>
                    {tab.label}
                  </div>
                ))}
              </div>

              <div className="settings-main">
                <button className="close-btn top-right" onClick={() => setSettingsOpen(false)}>×</button>

                {/* API */}
                {settingsTab === 'api' && (
                  <div className="settings-panel">
                    <h3>{t('API 设置', 'API Settings')}</h3>
                    <div className="form-group">
                      <label>{t('提供商', 'Provider')}</label>
                      <select value={provider} onChange={e => {
                        setProvider(e.target.value); setAvailableModels([]);
                        if (e.target.value === 'openai') setApiEndpoint('https://api.openai.com/v1');
                        else if (e.target.value === 'openai-compatible') setApiEndpoint('https://aihubmix.com/v1');
                      }}>
                        <option value="openai-compatible">OpenAI 兼容接口</option>
                        <option value="openai">OpenAI</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="anthropic">Anthropic</option>
                      </select>
                    </div>
                    <div className="form-group mt-4">
                      <label>API Endpoint</label>
                      <input type="text" value={apiEndpoint} onChange={e => setApiEndpoint(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>API Key</label>
                      <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." />
                    </div>
                    <div className="form-group row-flex">
                      <button className="btn-secondary" onClick={handleFetchModels} disabled={fetchingModels}>
                        {fetchingModels ? '获取中…' : '获取模型列表'}
                      </button>
                      {fetchMsg.text && <span className={fetchMsg.type === 'error' ? 'error-text' : 'success-text'}>{fetchMsg.text}</span>}
                    </div>
                    {availableModels.length > 0 && (
                      <div className="form-group mt-4">
                        <label>{t('选择模型', 'Model')}</label>
                        <input type="text" placeholder="搜索…" value={modelSearch} onChange={e => setModelSearch(e.target.value)} style={{ marginBottom: 8 }} />
                        <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                          {availableModels.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())).map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="form-group mt-4" style={{ borderTop: '1px dashed var(--border-light)', paddingTop: 16 }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>连接排查</span>
                        <button className="btn-secondary" onClick={handleTestConn}>发测试请求</button>
                      </label>
                      {debugInfo && (
                        <div style={{ background: 'var(--bg-secondary)', padding: 10, borderRadius: 6, fontSize: 11, fontFamily: 'monospace', overflowX: 'auto', marginTop: 8 }}>
                          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{debugInfo.req}</pre>
                          <pre style={{ whiteSpace: 'pre-wrap', color: debugInfo.status === 200 ? '#10b981' : '#ef4444', marginTop: 8 }}>{debugInfo.res}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* TTS */}
                {settingsTab === 'tts' && (
                  <div className="settings-panel">
                    <h3>{t('语音合成设置', 'Voice / TTS')}</h3>

                    <div className="form-group">
                      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{t('启用语音朗读', 'Enable TTS')}</span>
                        <button className={`toggle-switch ${ttsEnabled ? 'on' : ''}`}
                          onClick={() => { tts.stop(); setTtsEnabled(v => !v); }}>
                          <span className="toggle-knob" />
                        </button>
                      </label>
                    </div>

                    <div className="form-group mt-4">
                      <label>{t('触发方式', 'Trigger Mode')}</label>
                      <div className="trigger-mode-group">
                        {([
                          ['auto',   t('自动朗读', 'Auto')],
                          ['manual', t('手动点击', 'Manual')],
                          ['both',   t('两种都支持', 'Both')],
                        ] as [TriggerMode, string][]).map(([val, label]) => (
                          <button key={val}
                            className={`trigger-mode-btn ${triggerMode === val ? 'active' : ''}`}
                            onClick={() => setTriggerMode(val)}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="settings-hint">
                        {triggerMode === 'auto'   && t('AI 回复时自动流式朗读', 'Auto-reads AI replies with streaming TTS')}
                        {triggerMode === 'manual' && t('点击消息旁喇叭按钮手动朗读', 'Click speaker icon to read each message')}
                        {triggerMode === 'both'   && t('自动朗读 + 保留手动按钮', 'Auto-read + manual speaker button')}
                      </div>
                    </div>

                    <div className="form-group mt-4">
                      <label>
                        {t('火山引擎 Token', 'Volcano Token')}
                      </label>
                      <input type="password" value={ttsToken} onChange={e => setTtsToken(e.target.value)}
                        placeholder={t('填写用于直连火山引擎的 Token', 'Token for Volcano TTS')} />
                      <div className="settings-hint">
                        {t('填写此项即可纯前端直连火山引擎，无需启动本地代理后端！', 'Fill this to connect directly from frontend, no proxy needed!')}
                      </div>
                    </div>

                    <div className="form-group mt-4">
                      <label>
                        {t('火山引擎 AppID', 'Volcano AppID')}
                      </label>
                      <input type="text" value={ttsAppId} onChange={e => setTtsAppId(e.target.value)}
                        placeholder="71089..." />
                      <div className="settings-hint">
                        {t('直连需要提供对应 Token 的 AppID', 'AppID associated with the Token')}
                      </div>
                    </div>

                    <div className="form-group mt-4">
                      <label>
                        {t('代理 / 火山 WebSocket URL', 'Proxy / Volcano WS URL')}
                        <span className="settings-badge">{t('必填', 'Required')}</span>
                      </label>
                      <input type="text" value={ttsWsUrl} onChange={e => setTtsWsUrl(e.target.value)}
                        placeholder="ws://localhost:8765" />
                      <div className="settings-hint">
                        {t('推荐使用本地代理：ws://localhost:8765（最稳定，避免浏览器握手鉴权限制）。', 'Recommended: ws://localhost:8765 (most stable, avoids browser auth header limits).')}
                      </div>
                    </div>

                    <div className="form-group mt-4">
                      <label>{t('音色', 'Voice')}</label>
                      <select value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}>
                        {VOLCANO_VOICES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                      </select>
                      <div className="settings-hint">
                        {t('当前账号仅授权该音色。已验证可直接合成中文/英文/日文/法文文本。', 'Only this voice is granted for current account. Verified for Chinese/English/Japanese/French text synthesis.')}
                      </div>
                    </div>

                    <div className="form-group mt-4">
                      <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{t('语速', 'Speed')}</span>
                        <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{ttsSpeed.toFixed(1)}×</span>
                      </label>
                      <input type="range" min="0.5" max="2.0" step="0.1" value={ttsSpeed}
                        onChange={e => setTtsSpeed(parseFloat(e.target.value))}
                        style={{ width: '100%', marginTop: 8 }} />
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                        <span>0.5×</span><span>1.0×</span><span>2.0×</span>
                      </div>
                    </div>

                    <div className="form-group mt-4" style={{ borderTop: '1px solid #333', paddingTop: '15px' }}>
                      <label>{t('TTS 诊断面板', 'TTS Debugger')}</label>
                      <button className="btn-secondary" onClick={() => {
                        tts.speakFull('你好，能听到我的声音吗？我是一段测试语音！');
                      }}>
                        发测试语音
                      </button>
                      <div className="debug-box" style={{ marginTop: '10px', background: '#1e1e1e', padding: '10px', borderRadius: '6px', fontSize: '12px', color: '#00ffcc', maxHeight: '150px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                        {tts.debugLogs.length === 0 ? '目前无连接...\n点击上方[发测试语音]以发起连接' : tts.debugLogs.join('\n')}
                      </div>
                    </div>

                    <div className="tts-info-card mt-4">
                      <div className="tts-info-title">⚡ 工作原理</div>
                      <div className="tts-info-body">
                        LLM 流式输出 → 按标点断句 → 每句建立独立 WebSocket 连接推送到火山 TTS → 接收 MP3 分片 → AudioContext 解码按序队列播放。多句并发请求，有序播放保证连贯。
                      </div>
                    </div>
                  </div>
                )}

                {/* General */}
                {settingsTab === 'general' && (
                  <div className="settings-panel">
                    <h3>{t('通用设置', 'General')}</h3>
                    <div className="form-group">
                      <label>{t('界面语言', 'Language')}</label>
                      <select value={appLanguage} onChange={e => setAppLanguage(e.target.value as 'zh' | 'en')}>
                        <option value="zh">简体中文</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div className="form-group mt-4">
                      <label>Mapbox Token</label>
                      <input type="password" value={mapboxToken} onChange={e => setMapboxToken(e.target.value)} placeholder="pk.eyJ1..." />
                      <div className="settings-hint">
                        {t('用于渲染右侧交互式地图。', 'Renders the interactive map panel.')}
                        <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', marginLeft: 4 }}>
                          {t('获取 Token →', 'Get Token →')}
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}