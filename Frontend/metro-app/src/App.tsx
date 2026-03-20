import React, { useState, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Map, { NavigationControl } from 'react-map-gl/mapbox';
import 'mapbox-gl/dist/mapbox-gl.css';
import './App.css';

interface Station {
  name: string;
  x: number;
  y: number;
}

interface RouteType {
  color1: string;
  color2: string;
  label1: string;
  label2: string;
  stations: Station[];
  switchAt: number;
  duration: number;
  badge?: string;
  desc: string;
}

interface Message {
  id: number;
  role: 'ai' | 'user';
  content: React.ReactNode;
}

interface ChatSession {
  id: string;
  title: string;
  timestamp: number;
  messages: Message[];
}

const routesData: RouteType[] = [
  {
    color1: '#D85A30', color2: '#185FA5', label1: '大兴机场线', label2: '10号线', duration: 52, badge: '最快',
    desc: '大兴机场线 + 10号线 · 1次换乘', switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥', x: 0.39, y: 0.57 }, { name: '劲松', x: 0.56, y: 0.40 },
      { name: '双井', x: 0.68, y: 0.32 }, { name: '国贸', x: 0.82, y: 0.22 },
    ]
  },
  {
    color1: '#D85A30', color2: '#3B6D11', label1: '大兴机场线', label2: '7号线', duration: 58,
    desc: '大兴机场线 + 7号线 · 1次换乘', switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥', x: 0.39, y: 0.57 }, { name: '大兴新城', x: 0.52, y: 0.46 },
      { name: '亦庄桥', x: 0.65, y: 0.36 }, { name: '国贸', x: 0.82, y: 0.22 },
    ]
  }
];

const formatRelativeDate = (timestamp: number) => {
  const date = new Date(timestamp);
  const now = new Date();
  
  const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const midnightEvent = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  
  const diffDays = Math.floor((midnightToday - midnightEvent) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const defaultSessions: ChatSession[] = [
  {
    id: 'session-1',
    title: '大兴机场到国贸路线',
    timestamp: Date.now(),
    messages: [
      { id: 1, role: 'ai', content: '你好！我是**地铁 AI 助手**，请问有什么可以帮您？' },
      { id: 2, role: 'user', content: '从大兴机场到国贸怎么走？' },
      { id: 3, role: 'ai', content: '推荐乘坐大兴机场线换乘10号线，具体路线已在右侧地图上为您标出。' }
    ]
  },
  {
    id: 'session-2',
    title: '早高峰换乘建议',
    timestamp: Date.now() - 24 * 60 * 60 * 1000,
    messages: [
      { id: 1, role: 'user', content: '早上哪条线人少？' },
      { id: 2, role: 'ai', content: '早高峰期间各条线路客流均较大，建议错峰出行，或避免10号线、4号线等拥挤线路。' }
    ]
  }
];

export default function App() {
  const [appLanguage, setAppLanguage] = useState<'zh' | 'en'>(() => {
    return (localStorage.getItem('metro-lang') as 'zh' | 'en') || 'zh';
  });
  useEffect(() => {
    localStorage.setItem('metro-lang', appLanguage);
  }, [appLanguage]);

  const t = (zh: string, en: string) => appLanguage === 'zh' ? zh : en;

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem('metro-sessions');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return defaultSessions;
  });

  useEffect(() => {
    localStorage.setItem('metro-sessions', JSON.stringify(sessions));
  }, [sessions]);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [hasStarted, setHasStarted] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState(0);
  
  const [inputVal, setInputVal] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // Settings state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('openai-compatible');
  const [settingsTab, setSettingsTab] = useState('api');
  const [selectedModel, setSelectedModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchMsg, setFetchMsg] = useState({ type: '', text: '' });

  const handleFetchModels = async () => {
    if (!apiEndpoint || !apiKey) {
       setFetchMsg({ type: 'error', text: '请先填写 Endpoint 和 API Key' });
       return;
    }
    setIsFetchingModels(true);
    setFetchMsg({ type: '', text: '' });
    try {
      let fetchUrl = apiEndpoint.replace(/\/+$/, '');
      if (provider === 'openai' || provider === 'openai-compatible') {
        if (!fetchUrl.endsWith('/v1')) fetchUrl += '/v1';
        fetchUrl += '/models';
      } else {
        throw new Error('当前仅支持自动获取 OpenAI 兼容接口的模型');
      }

      const res = await fetch(fetchUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      
      if (!res.ok) throw new Error(`连接失败: 状态码 ${res.status}`);
      
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        const models = data.data.map((m: any) => m.id);
        setAvailableModels(models);
        if (models.length > 0) {
          setSelectedModel(models[0]);
        }
        setFetchMsg({ type: 'success', text: `成功获取到 ${models.length} 个模型` });
      } else {
        throw new Error('API 响应格式无法解析，可能不是标准的 OpenAI 兼容接口');
      }
    } catch (err: any) {
       setFetchMsg({ type: 'error', text: err.message || '获取模型失败' });
    } finally {
      setIsFetchingModels(false);
    }
  };
  
  const currentMessages = currentSessionId ? sessions.find(s => s.id === currentSessionId)?.messages || [] : [];

  const [mapboxToken, setMapboxToken] = useState(() => {
    return localStorage.getItem('metro-mapbox-token') || '';
  });

  useEffect(() => {
    localStorage.setItem('metro-mapbox-token', mapboxToken);
  }, [mapboxToken]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isTyping]);

  const handleSend = async () => {
    if (!inputVal.trim()) return;

    const userMessage: Message = { id: Date.now(), role: 'user', content: inputVal };
    let sessionIdToUpdate = currentSessionId;
    const isNewSession = !hasStarted || !currentSessionId;

    if (isNewSession) {
      setHasStarted(true);
      setSidebarOpen(true);
      sessionIdToUpdate = `session-${Date.now()}`;
      setCurrentSessionId(sessionIdToUpdate);
      setSessions(prev => [
        {
          id: sessionIdToUpdate!,
          title: inputVal.slice(0, 10),
          timestamp: Date.now(),
          messages: [userMessage]
        },
        ...prev
      ]);
    } else {
      setSessions(prev => prev.map(s => 
        s.id === sessionIdToUpdate ? { ...s, messages: [...s.messages, userMessage] } : s
      ));
    }

    const currentMessageText = inputVal;
    setInputVal('');
    setIsTyping(true);

    try {
      // 获取上下文历史
      const session = sessions.find(s => s.id === (isNewSession ? null : sessionIdToUpdate));
      const historyMessages = session ? session.messages : [];
      const apiMessages = historyMessages
        .filter(m => typeof m.content === 'string')
        .map(m => ({
          role: m.role === 'ai' ? 'assistant' : 'user',
          content: m.content as string
        }));
      
      apiMessages.push({ role: 'user', content: currentMessageText });

      const response = await fetch(`${apiEndpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
          model: selectedModel || 'gpt-3.5-turbo',
          messages: apiMessages
        })
      });

      if (!response.ok) {
        throw new Error(`API 请求失败: ${response.status}`);
      }

      const data = await response.json();
      const aiMsgText = data.choices[0].message.content;

      const aiMessage: Message = { id: Date.now() + 1, role: 'ai', content: aiMsgText };
      
      setSessions(prev => prev.map(s => 
        s.id === sessionIdToUpdate ? { ...s, messages: [...s.messages, aiMessage] } : s
      ));
    } catch (error: any) {
      const errorMessage: Message = { id: Date.now() + 1, role: 'ai', content: `[请求出错]: ${error.message}` };
      setSessions(prev => prev.map(s => 
        s.id === sessionIdToUpdate ? { ...s, messages: [...s.messages, errorMessage] } : s
      ));
    } finally {
      setIsTyping(false);
    }
  };

  const handleNewChat = () => {
    setHasStarted(false);
    setCurrentSessionId(null);
    setHistoryOpen(false);
  };

  const handleSelectSession = (id: string) => {
    setCurrentSessionId(id);
    setHasStarted(true);
    setHistoryOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSend();
  };

  return (
    <div id="app">
      <div 
        id="drawer-overlay" 
        className={historyOpen ? 'show' : ''} 
        onClick={() => setHistoryOpen(false)}
      />

      <div id="topbar">
        <button id="menu-btn" className={historyOpen ? 'open' : ''} onClick={() => setHistoryOpen(!historyOpen)}>
          <span/><span/><span/>
        </button>
        <button id="top-new-chat-btn" onClick={handleNewChat} title="新建对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <div className="logo-area">
          <span className="logo-text">{t(' 京轨', 'Beijing Subway Assistant')}</span>
        </div>
        <button id="sidebar-toggle-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
          </svg>
        </button>
      </div>

      <div id="history-drawer" className={historyOpen ? 'open' : ''}>
         <div className="history-header">
           <div className="history-title">{t('历史记录', 'History')}</div>
         </div>
         {sessions.map(session => (
           <div 
             key={session.id} 
             className={`history-item ${session.id === currentSessionId ? 'active' : ''}`}
             onClick={() => handleSelectSession(session.id)}
           >
             <div className="history-title">{session.title}</div>
             <div className="hist-date">{appLanguage === 'zh' ? formatRelativeDate(session.timestamp) : new Date(session.timestamp).toLocaleDateString()}</div>
             <button 
               className="del-session-btn" 
               onClick={(e) => {
                 e.stopPropagation();
                 const newSessions = sessions.filter(s => s.id !== session.id);
                 setSessions(newSessions);
                 if (currentSessionId === session.id) {
                   setCurrentSessionId(null);
                   setHasStarted(false);
                 }
               }}
               title={t('删除对话', 'Delete chat')}
             >
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                 <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
               </svg>
             </button>
           </div>
         ))}
         
         <div className="history-footer">
           <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
               <circle cx="12" cy="12" r="3" />
               <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
             </svg>
             {t('设置', 'Settings')}
           </button>
         </div>
      </div>

      <div id="main" className={`${sidebarOpen ? 'sidebar-open' : ''} ${historyOpen ? 'history-open' : ''}`.trim()}>
        <div id="chat-area">
          {!hasStarted ? (
            <div className="welcome-screen">
              <div className="welcome-logo">
                <div className="metro-icon large">
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 18L8 6l4 8 4-8 4 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
              <h2 className="welcome-title">{t('今天想去哪里？', 'Where to today?')}</h2>
              
              <div className="welcome-input-wrapper">
                <div className="input-box shadow-xl">
                  <input 
                    type="text" 
                    value={inputVal}
                    onChange={(e) => setInputVal(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('试试问：从大兴机场到国贸怎么走？', 'Try asking: How do I get to Guomao?')} 
                    autoFocus
                  />
                  <button className="send-btn" onClick={handleSend}>{t('发送', 'Send')}</button>
                </div>
                <div className="input-hint">{t('京轨助手仅供参考，请以官方信息为准', 'Beijing Subway Assistant is for reference only')}</div>
              </div>
            </div>
          ) : (
            <>
              <div id="messages">
                {currentMessages.map((msg) => (
                  <div key={msg.id} className={`msg-wrap ${msg.role}`}>
                    {msg.role === 'ai' && <div className="avatar ai">M</div>}
                    <div className={`bubble ${msg.role}`}>
                      {typeof msg.content === 'string' && msg.role === 'ai' ? (
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        msg.content
                      )}
                    </div>
                    {msg.role === 'user' && <div className="avatar user">我</div>}
                  </div>
                ))}
                
                {isTyping && (
                  <div className="msg-wrap">
                    <div className="avatar ai">M</div>
                    <div className="bubble ai">
                      <div className="typing-indicator"><span/><span/><span/></div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div id="input-area">
                <div className="input-box">
                  <input 
                    type="text" 
                    value={inputVal}
                    onChange={(e) => setInputVal(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('尝试输入...', 'Type a message...')} 
                    autoFocus
                  />
                  <button className="send-btn" onClick={handleSend}>{t('发送', 'Send')}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <div className="panel-label">推荐路线</div>
        <div id="route-panel">
          {routesData.map((route, idx) => (
            <div 
              key={idx} 
              className={`route-card ${selectedRoute === idx ? 'selected' : ''}`}
              onClick={() => setSelectedRoute(idx)}
            >
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
          {mapboxToken ? (
            <Map
              mapboxAccessToken={mapboxToken}
              initialViewState={{
                longitude: 116.4074,
                latitude: 39.9042,
                zoom: 10
              }}
              style={{width: '100%', height: '100%'}}
              mapStyle={window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11'}
            >
              <NavigationControl position="bottom-right" />
            </Map>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', flexDirection: 'column', gap: '10px' }}>
              <p>{t('请在设置中配置 Mapbox Token', 'Please configure Mapbox Token in settings')}</p>
              <button 
                className="route-tag" 
                onClick={() => { setSettingsOpen(true); setSettingsTab('general'); }}
              >
                {t('去设置', 'Go to Settings')}
              </button>
            </div>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="settings-layout">
              <div className="settings-sidebar">
                <div className="settings-header-title">{appLanguage === 'zh' ? '设置' : 'Settings'}</div>
                <div 
                  className={`settings-tab ${settingsTab === 'api' ? 'active' : ''}`} 
                  onClick={() => setSettingsTab('api')}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                  {appLanguage === 'zh' ? '模型与接口' : 'Model & API'}
                </div>
                <div 
                  className={`settings-tab ${settingsTab === 'general' ? 'active' : ''}`} 
                  onClick={() => setSettingsTab('general')}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  {appLanguage === 'zh' ? '通用设置' : 'General'}
                </div>
              </div>
              <div className="settings-main">
                <button className="close-btn top-right" onClick={() => setSettingsOpen(false)}>×</button>
                
                {settingsTab === 'general' && (
                  <div className="settings-panel">
                    <h3>{appLanguage === 'zh' ? '通用设置' : 'General Settings'}</h3>
                    <div className="form-group">
                      <label>{appLanguage === 'zh' ? '界面语言' : 'Language'}</label>
                      <select value={appLanguage} onChange={e => setAppLanguage(e.target.value as 'zh' | 'en')}>
                        <option value="zh">简体中文</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div className="form-group mt-4">
                      <label>Mapbox Token</label>
                      <input 
                        type="password" 
                        value={mapboxToken} 
                        onChange={e => setMapboxToken(e.target.value)} 
                        placeholder="pk.eyJ1..." 
                      />
                      <div className="api-hint" style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                        {t('用于在右侧面板渲染交互式地图。', 'Used to render the interactive map on the right panel.')}
                        <a href="https://account.mapbox.com/access-tokens/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', marginLeft: '4px' }}>
                          {t('获取 Token', 'Get Token')}
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {settingsTab === 'api' && (
                  <div className="settings-panel">
                    <h3>{appLanguage === 'zh' ? 'API 提供商设置' : 'API Provider Settings'}</h3>
                    
                    <div className="form-group">
                      <label>{appLanguage === 'zh' ? '选择 API 提供商' : 'Select Provider'}</label>
                      <select value={provider} onChange={e => {
                        setProvider(e.target.value);
                        setAvailableModels([]); // Reset models when provider changes
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
                      <label>API Endpoint (接口地址)</label>
                      <input 
                        type="text" 
                        value={apiEndpoint} 
                        onChange={e => setApiEndpoint(e.target.value)} 
                        placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'https://接口地址.../v1'} 
                      />
                    </div>
                    
                    <div className="form-group">
                      <label>API Key (密钥)</label>
                      <input 
                        type="password" 
                        value={apiKey} 
                        onChange={e => setApiKey(e.target.value)} 
                        placeholder="sk-..." 
                      />
                    </div>

                    <div className="form-group row-flex">
                      <button 
                        className="btn-secondary" 
                        onClick={handleFetchModels} 
                        disabled={isFetchingModels}
                      >
                        {isFetchingModels ? '正在连接和获取...' : '连接并获取模型列表'}
                      </button>
                      {fetchMsg.text && (
                        <span className={fetchMsg.type === 'error' ? 'error-text' : 'success-text'}>
                          {fetchMsg.text}
                        </span>
                      )}
                    </div>

                    {availableModels.length > 0 && (
                      <div className="form-group mt-4">
                        <label>选择使用的模型</label>
                        <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                          {availableModels.map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    )}
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
