import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { MapLayerMouseEvent } from 'mapbox-gl';
import type { MapRef } from 'react-map-gl/mapbox-legacy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Map, { NavigationControl, Source, Layer, Popup } from 'react-map-gl/mapbox-legacy';
import 'mapbox-gl/dist/mapbox-gl.css';
import './App.css';
import { useVolcanoTTS } from './useVolcanoTTS';
import {
  displayLineName,
  displayPlaceLabel,
  displayRouteTitle,
  displayStationName,
  resolveLineKeyForPalette,
} from './metroNameI18n';

// ─── Types ─────────────────────────────────────────────────────────────────
interface Station {
  stationName?: string;
  name?: string;
  x?: number;
  y?: number;
  location?: [number, number];
}
interface RouteType {
  color1?: string; color2?: string; label1?: string;
  stations?: Station[]; switchAt?: number; duration: number;
  title?: string; origin?: string; destination?: string; routeId?: string;
  error?: string;
  distanceMeters?: number;
  lineSegments?: Array<{ lineName: string; stationIds?: string[]; stationNames?: string[]; coordinates: [number, number][] }>;
}
interface RouteApiResponse {
  requestId: string;
  origin?: string;
  destination?: string;
  routes: RouteType[];
  generatedAt?: string;
}
interface RouteBatchApiResponse {
  requestId: string;
  queries?: Array<{ origin: string; destination: string }>;
  routes: RouteType[];
}
interface Message { id: number; role: 'ai' | 'user'; content: string; }
interface ChatSession { id: string; title: string; timestamp: number; messages: Message[]; }
interface UserLocation {
  longitude: number;
  latitude: number;
  accuracyMeters: number;
  stationName?: string;
  distanceToStationMeters?: number;
  coordinateSource?: 'wgs84-direct' | 'gcj02-to-wgs84';
  capturedAt: number;
}

interface CultureTreeNode {
  name: string;
  count: number;
  children: CultureTreeNode[];
}

interface CultureStation {
  station_name: string;
  tree_path: string[];
  culture_tags: string[];
  culture_types: string[];
  story_summary: string;
  recommended_topics: string[];
  nearby_pois: string[];
  audience_fit: string[];
  popularity: number;
  confidence: number;
  why_recommend: string;
  line_affinity: string[];
}

interface CultureTreeApiResponse {
  requestId: string;
  tree: CultureTreeNode[];
  totalStations: number;
}

interface CultureStationsByPathApiResponse {
  requestId: string;
  path: string[];
  total: number;
  stations: CultureStation[];
}

interface CultureSimilarItem {
  station_name: string;
  tree_path: string[];
  culture_tags: string[];
  culture_types: string[];
  story_summary: string;
  score: number;
  reasons: string[];
}

interface CultureSimilarApiResponse {
  requestId: string;
  stationName: string;
  similarStations: CultureSimilarItem[];
}

type LocationCoordinateMode = 'auto' | 'wgs84-direct' | 'gcj02-to-wgs84';

function buildTreeLevelOptions(tree: CultureTreeNode[], path: string[]): CultureTreeNode[][] {
  const levels: CultureTreeNode[][] = [];
  let nodes = tree;
  levels.push(nodes);
  for (const segment of path) {
    const hit = nodes.find((n) => n.name === segment);
    if (!hit || !Array.isArray(hit.children) || hit.children.length === 0) break;
    nodes = hit.children;
    levels.push(nodes);
  }
  return levels;
}

// ─── Static data ────────────────────────────────────────────────────────────
const routesData: RouteType[] = [
  {
    color1: '#D85A30', color2: '#185FA5', label1: '大兴机场线',
    duration: 52, switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥',    x: 0.39, y: 0.57 }, { name: '劲松',     x: 0.56, y: 0.40 },
      { name: '双井',    x: 0.68, y: 0.32 }, { name: '国贸',     x: 0.82, y: 0.22 },
    ],
  },
  {
    color1: '#D85A30', color2: '#3B6D11', label1: '大兴机场线',
    duration: 58, switchAt: 2,
    stations: [
      { name: '大兴机场', x: 0.10, y: 0.85 }, { name: '大兴机场北', x: 0.23, y: 0.72 },
      { name: '草桥',    x: 0.39, y: 0.57 }, { name: '大兴新城',  x: 0.52, y: 0.46 },
      { name: '亦庄桥',  x: 0.65, y: 0.36 }, { name: '国贸',     x: 0.82, y: 0.22 },
    ],
  },
];

/** 与 BJsubway `g.color` 对齐；键为 `line_name` 去掉括号区间后的主名，或与线 GeoJSON 中 `line_name` 一致 */
const METRO_LINE_COLORS: Record<string, string> = {
  地铁1号线八通线: '#C23A30',
  地铁2号线内环: '#006098',
  地铁2号线: '#006098',
  地铁4号线大兴线: '#008e9c',
  地铁5号线: '#a6217f',
  地铁6号线: '#d29700',
  地铁7号线: '#f6c582',
  地铁8号线: '#009b6b',
  地铁9号线: '#8fc31f',
  地铁10号线内环: '#009BC0',
  地铁10号线: '#009BC0',
  地铁11号线: '#ed796b',
  地铁12号线: '#9B7EDE',
  地铁13号线: '#f9e700',
  地铁13B号线: '#f9e700',
  地铁14号线: '#d5a7a1',
  地铁15号线: '#5b3c68',
  地铁16号线: '#76a32e',
  地铁17号线: '#00a9a9',
  地铁17号线北段: '#00a9a9',
  地铁19号线: '#d6abc1',
  地铁昌平线: '#de82b2',
  地铁房山线: '#e46022',
  地铁亦庄线: '#e40077',
  首都机场线: '#a29bbb',
  地铁燕房线: '#e46022',
  地铁燕房线支线: '#e46022',
  S1线: '#b35a20',
  西郊线: '#e50619',
  北京大兴国际机场线: '#004a9f',
  北京大兴国际机场线北延: '#004a9f',
  大兴机场线: '#004a9f',
  亦庄T1线: '#e5061b',
  地铁3号线: '#D6001C',
  地铁3号线一期东段: '#D6001C',
  地铁18号线: '#64748b',
};

function metroLineColorFromName(raw: string | undefined | null): string {
  if (raw == null || typeof raw !== 'string') return '#9ca3af';
  const trimmed = resolveLineKeyForPalette(raw.trim());
  const paren = trimmed.indexOf('(');
  const base = (paren >= 0 ? trimmed.slice(0, paren) : trimmed).trim();
  if (METRO_LINE_COLORS[trimmed]) return METRO_LINE_COLORS[trimmed];
  if (METRO_LINE_COLORS[base]) return METRO_LINE_COLORS[base];
  if (base.startsWith('地铁10号线')) return METRO_LINE_COLORS['地铁10号线'];
  if (base.startsWith('地铁2号线')) return METRO_LINE_COLORS['地铁2号线'];
  if (base.startsWith('地铁17号线')) return METRO_LINE_COLORS['地铁17号线'];
  if (base.includes('国际机场线') || base.startsWith('大兴机场')) return METRO_LINE_COLORS['大兴机场线'];
  return '#9ca3af';
}

const formatRelativeDate = (ts: number, lang: 'zh' | 'en') => {
  const date = new Date(ts);
  const now = new Date();
  const diff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
     new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000
  );
  if (lang === 'zh') {
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === 2) return '2 days ago';
  const y = date.getFullYear();
  const ny = now.getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(y !== ny ? { year: 'numeric' as const } : {}),
  });
};

/** GeoJSON 中的状态文案译成英文；站名/线路名仍为数据原样 */
const METRO_STATUS_ZH_EN: Record<string, string> = {
  运营中: 'In service',
  建设中: 'Under construction',
  规划中: 'Planned',
  停运: 'Suspended',
  暂缓开通: 'Not yet open',
  未开通: 'Not open',
  即将开通: 'Opening soon',
};

function translateMetroStatus(raw: string, lang: 'zh' | 'en'): string {
  if (lang === 'zh') return raw;
  const trimmed = raw.trim();
  if (trimmed === '—' || trimmed === '-') return '—';
  return trimmed
    .split(/\s*\/\s*/)
    .map(part => {
      const p = part.trim();
      return METRO_STATUS_ZH_EN[p] || p;
    })
    .join(' / ');
}

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

const SYSTEM_PROMPT_ZH = `你是一个名为"京轨助手"的北京城市 文化导览/铁路导航 助手。你的用户打算乘坐地铁，在地铁沿线游玩。

【你的职责】
1. 如果你用户是来游玩的，你负责：地铁沿线文化景点推荐(要先说是哪个地铁站，再说景点)、沿线文化介绍、历史背景、游玩建议。
2. 如果你用户是来导航的，你负责: 地铁线路、起点终点周边文化介绍，而不要推荐景点。
3. 你不负责：具体地铁路线规划与换乘步骤（这部分由独立查询模型完成）。

【强约束（必须遵守）】
- 禁止输出任何具体乘车方案、换乘步骤、几号线到几号线、几站后下车、预计多少分钟这类路线细节。
- 如果用户问“从A到B怎么走”，你只介绍 A、B 或沿线相关的北京文化与出行建议（例如周边地标、历史典故、游览时段建议），不要给线路步骤，不要给用户推荐其它景点。
- 由于独立查询模型返回的线路会显示在用户的前端页面，用户可以看到这个线路，所以请你不要输出“我不能提供具体的换乘路线”这句话(路线是用户已经知道的了)。
- 由于独立查询模型会根据你对用户的回复来查询路线，所以你在回复用户时要明确给出地铁站，然后再可选择地给出该站点周边的景点、文化介绍、历史背景、游玩建议。
- 由于站点名称要和地图名称严格匹配，请你不要给出“东华门站”等不在地铁查询系统里的公交站。
- **凡写到地铁站名，必须用北京地铁官方中文站名**（与线路图一致），例如「沙河高教园」「霍营」「鼓楼大街」「什刹海」。中文对话里**禁止**用纯拼音或英文站名（如 Huoying、Gulou Dajie、Shichahai、Sahe / Shahe Higher Education Park），也不要写错别字，否则侧边栏路线无法查询。
- 当用户想要游玩时，系统都可能额外提供一段“用户定位上下文”（包含最近地铁站、距离、精度、时间）。如果该上下文存在，你必须把它当作当前有效事实，这会是用户出发的起点。

【回答风格】
- 语气友好、专业、简洁，像导游讲解。
- 优先提供 2-4 条高价值文化信息，避免冗长。
`;

const SYSTEM_PROMPT_EN = `You are Beijing Metro AI, a cultural guide and metro-themed assistant for Beijing. Users explore the city along subway lines.

【Your role】
1. For sightseeing: recommend culture and sights near relevant stops and areas, plus history and visit tips—in **plain English**.
2. For navigation-style questions: describe culture around origin/destination and the corridor—do **not** push unrelated attractions.
3. You do **not** provide step-by-step riding instructions (another system draws routes on the user's map).

【Hard rules】
- Do **not** output detailed transfer plans, "take line X then line Y", which stop to alight, or ETA minutes—the route panel already shows that.
- If the user asks how to get from A to B, only give culture, landmarks, and visit tips—no step-by-step transit.
- Never say you "cannot provide routing"—the user already sees the route on screen.
- Name real places and stops using **natural English** (e.g. "Shahe Higher Education Park", "Xitucheng", "Changping line", "Beijing North Station"). A separate service maps common English / exonyms to the metro graph—**you do not need to paste Chinese station names** in the main text for routing to work.
- Do **not** suggest bus-only names as if they were subway stops (e.g. invented "东华门 subway stop").
- Do **not** confuse lines (e.g. Fangshan line vs Line 14 are different systems).
- If a "user location context" system message exists, treat it as ground truth.

【Language — critical】
- The UI is **English**. Reply in **fluent English only** in the body of your answer.
- **Forbidden:** any pattern like **Chinese characters followed by romanization in parentheses** (e.g. "沙河高教园 (Shāhé Gāojiào Yuán)", "西土城 (Xī Tǔchéng)", "地铁昌平线 (Changping Line)"). **Do not** add tone-marked Pinyin or "Chinese + (Pinyin)" glosses—users find this jarring.
- **Forbidden:** mixing a Chinese name and then a long romanized form in the same sentence for the same place. Prefer **one** English phrase per place (e.g. "Shahe Higher Education Park station on the Changping line toward Xitucheng").
- You may mention a line as "**Changping line**" or "**Line 8**" in English without Chinese.

【Tone】
- Friendly, concise, like a tour guide; 2–4 high-value points, not long essays.
`;

const DEFAULT_BACKEND_BASE = 'http://localhost:3000';

function getBackendBaseUrl(routeApiEndpoint: string): string {
  const value = (routeApiEndpoint || '').trim();
  if (!value) return DEFAULT_BACKEND_BASE;
  const marker = '/api/route';
  const idx = value.indexOf(marker);
  if (idx >= 0) return value.slice(0, idx);
  return value.replace(/\/+$/, '');
}

function getRouteApiUrl(routeApiEndpoint: string): string {
  const value = (routeApiEndpoint || '').trim();
  if (value) return value;
  return `${DEFAULT_BACKEND_BASE}/api/route`;
}

type ParsedRouteLabelItem =
  | { type: 'line'; text: string; color: string }
  | { type: 'station'; text: string; color: string };
type LabelSegment = { lineName: string; stations: string[] };

function parseRouteLabelText(rawLabel: string): ParsedRouteLabelItem[] {
  const label = String(rawLabel || '');
  const lines = label
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  let currentColor = '#4f46e5';
  const items: ParsedRouteLabelItem[] = [];
  for (const line of lines) {
    const lineMatch = line.match(/^【(.+?)】$/);
    if (lineMatch) {
      const lineName = lineMatch[1].trim();
      currentColor = metroLineColorFromName(lineName);
      items.push({ type: 'line', text: lineName, color: currentColor });
      continue;
    }

    const stationMatch = line.match(/^-+\s*(.+)$/);
    if (stationMatch) {
      items.push({ type: 'station', text: stationMatch[1].trim(), color: currentColor });
    }
  }
  return items;
}

function normalizeLineBaseName(raw: string | undefined | null): string {
  if (raw == null || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const idx = trimmed.indexOf('(');
  return (idx >= 0 ? trimmed.slice(0, idx) : trimmed).trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function geometryToPaths(geometry: Geometry | null | undefined): [number, number][][] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') {
    const path = geometry.coordinates
      .map(c => [Number(c[0]), Number(c[1])] as [number, number])
      .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    return path.length >= 2 ? [path] : [];
  }
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates
      .map(line =>
        line
          .map(c => [Number(c[0]), Number(c[1])] as [number, number])
          .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]))
      )
      .filter(line => line.length >= 2);
  }
  return [];
}

function buildPolylineBetweenPoints(
  paths: [number, number][][],
  start: [number, number],
  end: [number, number]
): [number, number][] {
  type Candidate = {
    distScore: number;
    path: [number, number][];
    startIdx: number;
    endIdx: number;
  };
  let best: Candidate | null = null;
  const sq = (a: [number, number], b: [number, number]) => {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
  };
  for (const p of paths) {
    if (p.length < 2) continue;
    let sIdx = 0;
    let eIdx = 0;
    let sBest = Number.POSITIVE_INFINITY;
    let eBest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < p.length; i += 1) {
      const ds = sq(p[i], start);
      const de = sq(p[i], end);
      if (ds < sBest) {
        sBest = ds;
        sIdx = i;
      }
      if (de < eBest) {
        eBest = de;
        eIdx = i;
      }
    }
    const score = sBest + eBest;
    if (!best || score < best.distScore) {
      best = { distScore: score, path: p, startIdx: sIdx, endIdx: eIdx };
    }
  }
  if (!best) return [start, end];
  const { path, startIdx, endIdx } = best;
  const raw = startIdx <= endIdx ? path.slice(startIdx, endIdx + 1) : path.slice(endIdx, startIdx + 1).reverse();
  if (raw.length < 2) return [start, end];
  raw[0] = start;
  raw[raw.length - 1] = end;
  return raw;
}

function invertHexColor(hexColor: string): string {
  const raw = String(hexColor || '').trim();
  const match = raw.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return '#000000';
  const hex = match[1];
  const r = 255 - parseInt(hex.slice(0, 2), 16);
  const g = 255 - parseInt(hex.slice(2, 4), 16);
  const b = 255 - parseInt(hex.slice(4, 6), 16);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function formatDurationText(minutes: number | undefined, distanceMeters: number | undefined, lang: 'zh' | 'en'): string {
  const d = Number(distanceMeters || 0);
  const dash = lang === 'zh' ? '耗时: -' : 'Time: —';
  if (!(d > 0)) return dash;
  const m = Math.max(0, Math.round(Number(minutes || 0)));
  if (m <= 0) return dash;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (lang === 'en') {
    if (h <= 0) return `Time: ${m} min`;
    return rem === 0 ? `Time: ${h} h` : `Time: ${h} h ${rem} min`;
  }
  if (h <= 0) return `耗时: ${m}分`;
  return `耗时: ${h}时${rem}分`;
}

function formatDistanceText(distanceMeters: number | undefined, lang: 'zh' | 'en'): string {
  const d = Number(distanceMeters || 0);
  if (!(d > 0)) return lang === 'zh' ? '路程: -' : 'Distance: —';
  const km = (d / 1000).toFixed(2);
  return lang === 'zh' ? `路程: ${km}公里` : `Distance: ${km} km`;
}

// 评估箭头样式时可快速切换：true=反色箭头，false=黑色箭头
const USE_INVERTED_ARROW_COLOR = true;

function parseRouteItemsFromSegments(route?: RouteType): ParsedRouteLabelItem[] {
  if (!route || !Array.isArray(route.lineSegments) || route.lineSegments.length === 0) return [];
  const items: ParsedRouteLabelItem[] = [];
  for (const seg of route.lineSegments) {
    const lineName = String(seg.lineName || '').trim();
    if (!lineName) continue;
    const color = metroLineColorFromName(lineName);
    items.push({ type: 'line', text: lineName, color });
    const names = Array.isArray(seg.stationNames) ? seg.stationNames : [];
    for (const n of names) {
      const station = String(n || '').trim();
      if (!station) continue;
      items.push({ type: 'station', text: station, color });
    }
  }
  return items;
}

function parseRouteLabelSegments(rawLabel: string): LabelSegment[] {
  const lines = String(rawLabel || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const segments: LabelSegment[] = [];
  let current: LabelSegment | null = null;
  for (const line of lines) {
    const lineMatch = line.match(/^【(.+?)】$/);
    if (lineMatch) {
      current = { lineName: lineMatch[1].trim(), stations: [] };
      segments.push(current);
      continue;
    }
    const stationMatch = line.match(/^-+\s*(.+)$/);
    if (stationMatch && current) {
      current.stations.push(stationMatch[1].trim());
    }
  }
  return segments.filter(s => s.stations.length >= 2);
}

function extractRouteCoordinates(route?: RouteType): [number, number][] {
  if (!route || !Array.isArray(route.stations)) return [];
  const coords: [number, number][] = [];
  for (const station of route.stations) {
    if (Array.isArray(station?.location) && station.location.length >= 2) {
      const lon = Number(station.location[0]);
      const lat = Number(station.location[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) coords.push([lon, lat]);
    }
  }
  return coords;
}

function stationDisplayName(station: Station | undefined): string {
  if (!station) return '';
  return String(station.stationName || station.name || '').trim();
}

function extractSegmentedRouteFeatures(route?: RouteType): Array<{ coordinates: [number, number][]; color: string }> {
  if (!route || !Array.isArray(route.stations) || route.stations.length < 2) return [];
  if (Array.isArray(route.lineSegments) && route.lineSegments.length > 0) {
    const direct = route.lineSegments
      .map(seg => ({
        coordinates: Array.isArray(seg.coordinates) ? seg.coordinates : [],
        color: metroLineColorFromName(seg.lineName),
      }))
      .filter(seg => seg.coordinates.length >= 2);
    if (direct.length > 0) {
      // 只用于地图绘制：保留换乘站作为下一段起点，但将重合点轻微错开，形成可见断开。
      const broken: Array<{ coordinates: [number, number][]; color: string }> = [];
      for (const seg of direct) {
        const coords = seg.coordinates.map(c => [c[0], c[1]] as [number, number]);
        if (coords.length >= 2) {
          broken.push({ coordinates: coords, color: seg.color });
        }
      }
      return broken;
    }
  }
  const segments = parseRouteLabelSegments(route.label1 || '');
  if (segments.length === 0) {
    const fallback = extractRouteCoordinates(route);
    if (fallback.length < 2) return [];
    return [{ coordinates: fallback, color: route.color1 || '#ef4444' }];
  }

  const orderedStations = route.stations;
  let cursor = 0;
  const result: Array<{ coordinates: [number, number][]; color: string }> = [];

  for (const seg of segments) {
    const segCoords: [number, number][] = [];
    let localCursor = cursor;
    for (const stationName of seg.stations) {
      let matchedIdx = -1;
      for (let i = localCursor; i < orderedStations.length; i += 1) {
        if (stationDisplayName(orderedStations[i]) === stationName) {
          matchedIdx = i;
          break;
        }
      }
      if (matchedIdx < 0) continue;
      const loc = orderedStations[matchedIdx]?.location;
      if (Array.isArray(loc) && loc.length >= 2) {
        const lng = Number(loc[0]);
        const lat = Number(loc[1]);
        if (Number.isFinite(lng) && Number.isFinite(lat)) segCoords.push([lng, lat]);
      }
      localCursor = matchedIdx;
    }
    if (segCoords.length >= 2) {
      result.push({ coordinates: segCoords, color: metroLineColorFromName(seg.lineName) });
      cursor = localCursor;
    }
  }
  return result;
}

function getRenderedRouteItems(route?: RouteType): ParsedRouteLabelItem[] {
  const bySegments = parseRouteItemsFromSegments(route);
  if (bySegments.length > 0) return bySegments;
  return parseRouteLabelText(route?.label1 || '');
}

function boundsFromCoordinates(coords: [number, number][]) {
  if (!coords.length) return null;
  let minLng = coords[0][0];
  let minLat = coords[0][1];
  let maxLng = coords[0][0];
  let maxLat = coords[0][1];
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

function haversineMeters(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

function gcj02ToWgs84(lng: number, lat: number): { longitude: number; latitude: number } {
  if (outOfChina(lng, lat)) return { longitude: lng, latitude: lat };
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  const mgLat = lat + dLat;
  const mgLng = lng + dLng;
  return {
    longitude: lng * 2 - mgLng,
    latitude: lat * 2 - mgLat,
  };
}

function formatLocationSystemContext(loc: UserLocation | null): string {
  if (!loc) {
    return [
      '用户定位上下文：',
      '- 定位状态: 不可用',
      '- 说明: 本次未获取到浏览器定位（可能是未授权、超时或设备不支持）',
      '若用户询问“我现在在哪/我附近有什么”，请先请用户开启定位权限，或让用户手动提供地铁站名。',
    ].join('\n');
  }
  return [
    '用户定位上下文：',
    '- 定位状态: 可用',
    `- 最近定位时间戳: ${new Date(loc.capturedAt).toISOString()}`,
    `- 定位精度(米): ${loc.accuracyMeters}`,
    `- 坐标归一化来源: ${loc.coordinateSource || 'wgs84-direct'}`,
    loc.stationName ? `- 用户附近地铁站: ${loc.stationName}` : '- 用户附近地铁站: 未匹配成功',
    typeof loc.distanceToStationMeters === 'number' ? `- 用户距离该站约: ${loc.distanceToStationMeters} 米` : '',
    '请优先推荐离该站点更近、换乘更少的地铁沿线游览建议。',
  ]
    .filter(Boolean)
    .join('\n');
}

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
  const [locationCoordinateMode, setLocationCoordinateMode] = useState<LocationCoordinateMode>(
    () => (localStorage.getItem('metro-location-coord-mode') as LocationCoordinateMode) || 'auto'
  );
  const [ttsEnabled,    setTtsEnabled]    = useState(() => localStorage.getItem('metro-tts') !== 'false');
  const [ttsAppId,      setTtsAppId]      = useState(() => localStorage.getItem('metro-tts-appid') || '');
  const [ttsToken,      setTtsToken]      = useState(() => localStorage.getItem('metro-tts-token') || '');
  const [ttsWsUrl,      setTtsWsUrl]      = useState(() => localStorage.getItem('metro-tts-ws')    || 'ws://localhost:8765');
  const [ttsVoice,      setTtsVoice]      = useState(() => localStorage.getItem('metro-tts-voice') || 'BV700_streaming');
  const [ttsVoiceZh,    setTtsVoiceZh]    = useState(() => localStorage.getItem('metro-tts-voice-zh') || '');
  const [ttsVoiceJa,    setTtsVoiceJa]    = useState(() => localStorage.getItem('metro-tts-voice-ja') || '');
  const [ttsVoiceEn,    setTtsVoiceEn]    = useState(() => localStorage.getItem('metro-tts-voice-en') || '');
  const [ttsSpeed,      setTtsSpeed]      = useState(() => parseFloat(localStorage.getItem('metro-tts-speed') || '1.0'));
  const [routeApiEndpoint, setRouteApiEndpoint] = useState(() => localStorage.getItem('metro-route-api') || '');
  const [apiRoutes, setApiRoutes] = useState<RouteType[]>([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const sidebarMapRef = useRef<MapRef | null>(null);
  const fullscreenMapRef = useRef<MapRef | null>(null);

  // ─── GeoJSON Layers (public/) ───────────────────────────────────────────
  // 浏览器无法直接读取你本机的 D:\\... 绝对路径，这里约定文件放在 public 下：
  // /geojson_data/line/wgs84/beijing.geojson
  // /geojson_data/point/wgs84/beijing.geojson
  const GEOJSON_LINE_URL = '/geojson_data/line_wgs84/beijing.geojson';
  const GEOJSON_POINT_URL = '/geojson_data/point_wgs84/beijing.geojson';
  const [lineGeojson, setLineGeojson] = useState<FeatureCollection<Geometry, GeoJsonProperties> | null>(null);
  const [pointGeojson, setPointGeojson] = useState<FeatureCollection<Geometry, GeoJsonProperties> | null>(null);
  const [geojsonLoadError, setGeojsonLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setGeojsonLoadError(null);
        const [lineRes, pointRes] = await Promise.all([
          fetch(GEOJSON_LINE_URL),
          fetch(GEOJSON_POINT_URL),
        ]);
        if (!lineRes.ok) throw new Error(`line geojson HTTP ${lineRes.status}`);
        if (!pointRes.ok) throw new Error(`point geojson HTTP ${pointRes.status}`);
        const [lineData, pointData] = await Promise.all([lineRes.json(), pointRes.json()]);
        if (cancelled) return;
        setLineGeojson(lineData);
        setPointGeojson(pointData);
      } catch (e) {
        if (cancelled) return;
        setGeojsonLoadError(e instanceof Error ? e.message : String(e));
        setLineGeojson(null);
        setPointGeojson(null);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coloredLineGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    if (!lineGeojson) return null;
    return {
      ...lineGeojson,
      features: lineGeojson.features.map(f => {
        const ln = f.properties?.line_name;
        return {
          ...f,
          properties: {
            ...f.properties,
            line_color: metroLineColorFromName(typeof ln === 'string' ? ln : undefined),
          },
        };
      }),
    };
  }, [lineGeojson]);

  const coloredPointGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    if (!pointGeojson) return null;
    return {
      ...pointGeojson,
      features: pointGeojson.features.map(f => {
        const ln = f.properties?.line_name;
        return {
          ...f,
          properties: {
            ...f.properties,
            point_color: metroLineColorFromName(typeof ln === 'string' ? ln : undefined),
          },
        };
      }),
    };
  }, [pointGeojson]);

  type StationPopupState = { longitude: number; latitude: number; stationName: string; lines: string[]; status: string };
  const [stationPopup, setStationPopup] = useState<StationPopupState | null>(null);
  const [popupIntroLoading, setPopupIntroLoading] = useState(false);
  const [popupIntroTitle, setPopupIntroTitle] = useState('');
  const [popupIntroText, setPopupIntroText] = useState('');
  const [popupIntroTtsEnabled, setPopupIntroTtsEnabled] = useState(
    () => localStorage.getItem('metro-popup-intro-tts') !== 'false'
  );
  const metroIntroAbortRef = useRef<AbortController | null>(null);

  const [triggerMode,   setTriggerMode]   = useState<TriggerMode>(
    () => (localStorage.getItem('metro-tts-trigger') as TriggerMode) || 'both'
  );

  const [viewMode, setViewMode] = useState<'chat' | 'explore'>('chat');
  const [cultureTree, setCultureTree] = useState<CultureTreeNode[]>([]);
  const [cultureTreeLoading, setCultureTreeLoading] = useState(false);
  const [cultureTreeError, setCultureTreeError] = useState('');
  const [culturePath, setCulturePath] = useState<string[]>([]);
  const [cultureStations, setCultureStations] = useState<CultureStation[]>([]);
  const [cultureStationsLoading, setCultureStationsLoading] = useState(false);
  const [cultureStationsError, setCultureStationsError] = useState('');
  const [selectedCultureStation, setSelectedCultureStation] = useState<string>('');
  const [exploreSimilarStations, setExploreSimilarStations] = useState<CultureSimilarItem[]>([]);
  const [exploreSimilarLoading, setExploreSimilarLoading] = useState(false);
  const [exploreSimilarError, setExploreSimilarError] = useState('');
  const [popupSimilarStations, setPopupSimilarStations] = useState<CultureSimilarItem[]>([]);
  const [popupSimilarLoading, setPopupSimilarLoading] = useState(false);
  const [popupSimilarError, setPopupSimilarError] = useState('');

  useEffect(() => { localStorage.setItem('metro-lang',         appLanguage); },        [appLanguage]);
  useEffect(() => { localStorage.setItem('metro-endpoint',     apiEndpoint); },        [apiEndpoint]);
  useEffect(() => { localStorage.setItem('metro-key',          apiKey); },             [apiKey]);
  useEffect(() => { localStorage.setItem('metro-model',        selectedModel); },      [selectedModel]);
  useEffect(() => { localStorage.setItem('metro-mapbox-token', mapboxToken); },        [mapboxToken]);
  useEffect(() => { localStorage.setItem('metro-location-coord-mode', locationCoordinateMode); }, [locationCoordinateMode]);
  useEffect(() => { localStorage.setItem('metro-tts',          String(ttsEnabled)); }, [ttsEnabled]);
  useEffect(() => { localStorage.setItem('metro-tts-appid',    ttsAppId); },           [ttsAppId]);
  useEffect(() => { localStorage.setItem('metro-tts-token',    ttsToken); },           [ttsToken]);
  useEffect(() => { localStorage.setItem('metro-tts-ws',       ttsWsUrl); },           [ttsWsUrl]);
  useEffect(() => { localStorage.setItem('metro-tts-voice',    ttsVoice); },           [ttsVoice]);
  useEffect(() => { localStorage.setItem('metro-tts-voice-zh', ttsVoiceZh); },         [ttsVoiceZh]);
  useEffect(() => { localStorage.setItem('metro-tts-voice-ja', ttsVoiceJa); },         [ttsVoiceJa]);
  useEffect(() => { localStorage.setItem('metro-tts-voice-en', ttsVoiceEn); },         [ttsVoiceEn]);

  // 兼容迁移：历史版本可能保存了不稳定的直连地址，这里自动切回本地代理
  useEffect(() => {
    const old = localStorage.getItem('metro-tts-ws') || '';
    if (old.includes('openspeech.bytedance.com')) {
      setTtsWsUrl('ws://localhost:8765');
    }
  }, []);
  useEffect(() => { localStorage.setItem('metro-tts-speed',    String(ttsSpeed)); },   [ttsSpeed]);
  useEffect(() => { localStorage.setItem('metro-route-api',    routeApiEndpoint); },  [routeApiEndpoint]);
  useEffect(() => { localStorage.setItem('metro-tts-trigger',  triggerMode); },        [triggerMode]);
  useEffect(() => { localStorage.setItem('metro-popup-intro-tts', String(popupIntroTtsEnabled)); }, [popupIntroTtsEnabled]);

  const t = (zh: string, en: string) => appLanguage === 'zh' ? zh : en;

  const fetchCultureTree = useCallback(async () => {
    const backendBase = getBackendBaseUrl(routeApiEndpoint);
    setCultureTreeLoading(true);
    setCultureTreeError('');
    try {
      const resp = await fetch(`${backendBase}/api/culture/tree`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as CultureTreeApiResponse;
      setCultureTree(Array.isArray(data.tree) ? data.tree : []);
    } catch (e) {
      setCultureTree([]);
      setCultureTreeError(e instanceof Error ? e.message : 'culture tree api error');
    } finally {
      setCultureTreeLoading(false);
    }
  }, [routeApiEndpoint]);

  const fetchCultureStationsByPath = useCallback(async (path: string[]) => {
    const backendBase = getBackendBaseUrl(routeApiEndpoint);
    setCultureStationsLoading(true);
    setCultureStationsError('');
    try {
      const resp = await fetch(`${backendBase}/api/culture/stations-by-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as CultureStationsByPathApiResponse;
      setCultureStations(Array.isArray(data.stations) ? data.stations : []);
    } catch (e) {
      setCultureStations([]);
      setCultureStationsError(e instanceof Error ? e.message : 'culture stations api error');
    } finally {
      setCultureStationsLoading(false);
    }
  }, [routeApiEndpoint]);

  const fetchSimilarStations = useCallback(async (stationName: string, scene: 'popup' | 'explore') => {
    const backendBase = getBackendBaseUrl(routeApiEndpoint);
    if (scene === 'popup') {
      setPopupSimilarLoading(true);
      setPopupSimilarError('');
      setPopupSimilarStations([]);
    } else {
      setExploreSimilarLoading(true);
      setExploreSimilarError('');
      setExploreSimilarStations([]);
    }

    try {
      const resp = await fetch(`${backendBase}/api/culture/similar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationName, topK: 5 }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as CultureSimilarApiResponse;
      const items = Array.isArray(data.similarStations) ? data.similarStations : [];
      if (scene === 'popup') {
        setPopupSimilarStations(items);
      } else {
        setExploreSimilarStations(items);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'culture similar api error';
      if (scene === 'popup') {
        setPopupSimilarError(msg);
      } else {
        setExploreSimilarError(msg);
      }
    } finally {
      if (scene === 'popup') {
        setPopupSimilarLoading(false);
      } else {
        setExploreSimilarLoading(false);
      }
    }
  }, [routeApiEndpoint]);

  useEffect(() => {
    if (viewMode !== 'explore') return;
    if (cultureTree.length > 0) return;
    void fetchCultureTree();
  }, [viewMode, cultureTree.length, fetchCultureTree]);

  useEffect(() => {
    if (viewMode !== 'explore') return;
    if (culturePath.length === 0) {
      setCultureStations([]);
      setCultureStationsError('');
      setSelectedCultureStation('');
      setExploreSimilarStations([]);
      setExploreSimilarError('');
      return;
    }
    void fetchCultureStationsByPath(culturePath);
  }, [viewMode, culturePath, fetchCultureStationsByPath]);

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
  const [historyWidth,  setHistoryWidth]  = useState(() => {
    const v = Number(localStorage.getItem('metro-history-w'));
    return Number.isFinite(v) ? clamp(v, 180, 420) : 240;
  });
  const [sidebarWidth,  setSidebarWidth]  = useState(() => {
    const v = Number(localStorage.getItem('metro-sidebar-w'));
    return Number.isFinite(v) ? clamp(v, 280, 560) : 360;
  });
  const [mapExpanded,   setMapExpanded]   = useState(false);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [inputVal,      setInputVal]      = useState('');
  const [isTyping,      setIsTyping]      = useState(false);
  const isSidebarVisible = viewMode === 'chat' && sidebarOpen;

  useEffect(() => {
    if (viewMode === 'explore' && sidebarOpen) {
      setSidebarOpen(false);
      setMapExpanded(false);
    }
  }, [viewMode, sidebarOpen]);

  useEffect(() => { localStorage.setItem('metro-history-w', String(historyWidth)); }, [historyWidth]);
  useEffect(() => { localStorage.setItem('metro-sidebar-w', String(sidebarWidth)); }, [sidebarWidth]);

  // settings
  const [settingsOpen,     setSettingsOpen]     = useState(false);
  const [settingsTab,      setSettingsTab]      = useState('api');
  const [provider,         setProvider]         = useState('openai-compatible');
  const [availableModels,  setAvailableModels]  = useState<string[]>([]);
  const [modelSearch,      setModelSearch]      = useState('');
  const [fetchingModels,   setFetchingModels]   = useState(false);
  const [fetchMsg,         setFetchMsg]         = useState({ type: '', text: '' });
  const [debugInfo,        setDebugInfo]        = useState<{ req?: string; res?: string; status?: number } | null>(null);
  const [latestUserLocation, setLatestUserLocation] = useState<UserLocation | null>(null);

  // streaming
  const [streamingText,  setStreamingText]  = useState('');
  const streamingTextRef = useRef('');

  // TTS
  const tts = useVolcanoTTS({
    wsUrl:      ttsToken ? `${ttsWsUrl}?token=${ttsToken}` : ttsWsUrl,
    appId:      ttsAppId,
    token:      ttsToken,
    voiceType:  ttsVoice,
    voiceTypeMap: {
      zh: ttsVoiceZh || ttsVoice,
      ja: ttsVoiceJa || ttsVoice,
      en: ttsVoiceEn || ttsVoice,
    },
    speedRatio: ttsSpeed,
    enabled:    ttsEnabled,
    triggerMode,
    preferEnTtsVoice: appLanguage === 'en',
  });

  const closeStationPopup = useCallback(() => {
    metroIntroAbortRef.current?.abort();
    metroIntroAbortRef.current = null;
    tts.stop();
    setStationPopup(null);
    setPopupIntroLoading(false);
    setPopupIntroTitle('');
    setPopupIntroText('');
    setPopupSimilarStations([]);
    setPopupSimilarLoading(false);
    setPopupSimilarError('');
  }, [tts]);

  async function requestMetroIntro(targetType: 'station' | 'line', targetName: string) {
    if (!targetName) return;
    metroIntroAbortRef.current?.abort();
    const ac = new AbortController();
    metroIntroAbortRef.current = ac;
    setPopupIntroLoading(true);
    setPopupIntroText('');
    setPopupIntroTitle(
      targetType === 'station'
        ? (appLanguage === 'zh' ? `站点文化：${targetName}` : `Station culture: ${displayStationName(targetName, 'en')}`)
        : (appLanguage === 'zh' ? `线路历史：${targetName}` : `Line history: ${displayLineName(targetName, 'en')}`)
    );
    const autoTts = popupIntroTtsEnabled && ttsEnabled && (triggerMode === 'auto' || triggerMode === 'both');
    if (autoTts) {
      tts.startSession();
      void tts.unlockAudio();
    }
    try {
      const backendBase = getBackendBaseUrl(routeApiEndpoint);
      const resp = await fetch(`${backendBase}/api/llm/metro-intro-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          endpoint: apiEndpoint,
          apiKey,
          model: selectedModel || 'gpt-3.5-turbo',
          targetType,
          targetName,
          ...(appLanguage === 'en'
            ? {
                targetDisplayEn:
                  targetType === 'station'
                    ? displayStationName(targetName, 'en')
                    : displayLineName(targetName, 'en'),
              }
            : {}),
          language: appLanguage,
        }),
      });
      if (ac.signal.aborted) return;
      if (!resp.ok || !resp.body) {
        const err = await resp.text().catch(() => '');
        throw new Error(err || `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let merged = '';
      const applyDelta = (delta: string) => {
        if (ac.signal.aborted) return;
        merged += delta;
        flushSync(() => {
          setPopupIntroText(merged);
        });
        if (autoTts) tts.pushTextDelta(delta);
      };
      const consumeSseLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
          };
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) applyDelta(delta);
        } catch {
          /**/
        }
      };
      while (true) {
        if (ac.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) consumeSseLine(line);
      }
      if (ac.signal.aborted) return;
      if (buf.trim()) {
        for (const line of buf.split('\n')) consumeSseLine(line);
      }
      if (!merged.trim()) {
        setPopupIntroText(appLanguage === 'zh' ? '模型暂未返回内容。' : 'Model returned empty content.');
      }
      if (autoTts) tts.flushRemaining();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setPopupIntroText(
        appLanguage === 'zh'
          ? `获取介绍失败：${err instanceof Error ? err.message : '未知错误'}`
          : `Failed to get introduction: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      if (autoTts) tts.stop();
    } finally {
      if (!ac.signal.aborted) setPopupIntroLoading(false);
    }
  }

  const onMetroMapClick = useCallback((e: MapLayerMouseEvent) => {
    const selectedFeats = (e.features ?? []).filter(f => f.layer?.id === 'selected-route-stations-layer');
    const baseFeats = (e.features ?? []).filter(f => f.layer?.id === 'beijing-points-layer');
    const feats = selectedFeats.length > 0 ? selectedFeats : baseFeats;
    if (feats.length === 0) {
      closeStationPopup();
      return;
    }
    metroIntroAbortRef.current?.abort();
    metroIntroAbortRef.current = null;
    tts.stop();
    const geom = feats[0].geometry;
    if (!geom || geom.type !== 'Point') return;
    const coords = geom.coordinates;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    const lineSet = new Set<string>();
    const statusSet = new Set<string>();
    let stationName = '';
    for (const f of feats) {
      const p = f.properties;
      if (p && typeof p.station_name === 'string' && p.station_name) stationName = p.station_name;
      if (p && typeof p.line_name === 'string' && p.line_name) lineSet.add(p.line_name);
      if (p && typeof p.status === 'string' && p.status) statusSet.add(p.status);
    }
    setPopupIntroLoading(false);
    setPopupIntroTitle('');
    setPopupIntroText('');
    setPopupSimilarStations([]);
    setPopupSimilarLoading(false);
    setPopupSimilarError('');
    setStationPopup({
      longitude: lng,
      latitude: lat,
      stationName: stationName || (appLanguage === 'zh' ? '未知站点' : 'Unknown station'),
      lines: [...lineSet].sort(),
      status: [...statusSet].join(' / ') || '—',
    });
  }, [appLanguage, closeStationPopup, tts]);

  const onMetroMapMouseMove = useCallback((e: MapLayerMouseEvent) => {
    const hit = (e.features ?? []).some(
      f => f.layer?.id === 'selected-route-stations-layer' || f.layer?.id === 'beijing-points-layer'
    );
    e.target.getCanvas().style.cursor = hit ? 'pointer' : '';
  }, []);

  const currentMessages = currentSessionId
    ? (sessions.find(s => s.id === currentSessionId)?.messages ?? [])
    : [];
  const resolvedRouteApiEndpoint = getRouteApiUrl(routeApiEndpoint);
  const shownRoutes = apiRoutes.length > 0 ? apiRoutes : routesData;
  const cultureLevelOptions = useMemo(() => buildTreeLevelOptions(cultureTree, culturePath), [cultureTree, culturePath]);

  const stationLineCoordLookup = useMemo(() => {
    const lookup = new globalThis.Map<string, [number, number]>();
    if (!pointGeojson) return lookup;
    for (const f of pointGeojson.features) {
      if (!f.geometry || f.geometry.type !== 'Point') continue;
      const coords = f.geometry.coordinates;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const stationName = String(f.properties?.station_name || '').trim();
      const lineRaw = String(f.properties?.line_name || '').trim();
      if (!stationName || !lineRaw) continue;
      const lineBase = normalizeLineBaseName(lineRaw);
      if (!lineBase) continue;
      const key = `${stationName}@@${lineBase}`;
      if (!lookup.has(key)) lookup.set(key, [lng, lat]);
    }
    return lookup;
  }, [pointGeojson]);

  const linePathsByBaseName = useMemo(() => {
    const lookup = new globalThis.Map<string, [number, number][][]>();
    if (!lineGeojson) return lookup;
    for (const f of lineGeojson.features) {
      const rawName = typeof f.properties?.line_name === 'string' ? f.properties.line_name : '';
      const base = normalizeLineBaseName(rawName);
      if (!base) continue;
      const paths = geometryToPaths(f.geometry);
      if (paths.length === 0) continue;
      const current = lookup.get(base) || [];
      current.push(...paths);
      lookup.set(base, current);
    }
    return lookup;
  }, [lineGeojson]);

  const stationPoints = useMemo(() => {
    const items: Array<{ stationName: string; longitude: number; latitude: number }> = [];
    if (!pointGeojson) return items;
    const seen = new Set<string>();
    for (const f of pointGeojson.features) {
      if (!f.geometry || f.geometry.type !== 'Point') continue;
      const coords = f.geometry.coordinates;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      const stationName = String(f.properties?.station_name || '').trim();
      if (!stationName) continue;
      const key = `${stationName}@@${lng.toFixed(6)}@@${lat.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ stationName, longitude: lng, latitude: lat });
    }
    return items;
  }, [pointGeojson]);

  const latestUserLocationGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    if (!latestUserLocation) return null;
    const lng = Number(latestUserLocation.longitude);
    const lat = Number(latestUserLocation.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            accuracy: Number(latestUserLocation.accuracyMeters || 0),
            stationName: latestUserLocation.stationName || '',
            distanceToStationMeters: Number(latestUserLocation.distanceToStationMeters || 0),
            coordinateSource: latestUserLocation.coordinateSource || 'wgs84-direct',
            capturedAt: latestUserLocation.capturedAt,
          },
          geometry: {
            type: 'Point',
            coordinates: [lng, lat],
          },
        },
      ],
    } as FeatureCollection<Geometry, GeoJsonProperties>;
  }, [latestUserLocation]);

  const resolveNearestStation = useCallback((longitude: number, latitude: number) => {
    let bestName = '';
    let bestDist = Number.POSITIVE_INFINITY;
    for (const s of stationPoints) {
      const dist = haversineMeters(longitude, latitude, s.longitude, s.latitude);
      if (dist < bestDist) {
        bestDist = dist;
        bestName = s.stationName;
      }
    }
    if (!Number.isFinite(bestDist) || !bestName) return null;
    return { stationName: bestName, distanceMeters: Math.round(bestDist) };
  }, [stationPoints]);

  const normalizeBrowserLocationToWgs84 = useCallback((longitude: number, latitude: number) => {
    const directNearest = resolveNearestStation(longitude, latitude);
    const gcjCandidate = gcj02ToWgs84(longitude, latitude);
    const convertedNearest = resolveNearestStation(gcjCandidate.longitude, gcjCandidate.latitude);

    const directDist = directNearest?.distanceMeters ?? Number.POSITIVE_INFINITY;
    const convertedDist = convertedNearest?.distanceMeters ?? Number.POSITIVE_INFINITY;

    if (locationCoordinateMode === 'wgs84-direct') {
      return {
        longitude,
        latitude,
        coordinateSource: 'wgs84-direct' as const,
        nearest: directNearest,
      };
    }

    if (locationCoordinateMode === 'gcj02-to-wgs84') {
      return {
        longitude: gcjCandidate.longitude,
        latitude: gcjCandidate.latitude,
        coordinateSource: 'gcj02-to-wgs84' as const,
        nearest: convertedNearest,
      };
    }

    // auto: 选择离地铁站网络更“合理”的一个（减少国内坐标偏移导致的站点匹配错误）
    if (convertedDist + 80 < directDist) {
      return {
        longitude: gcjCandidate.longitude,
        latitude: gcjCandidate.latitude,
        coordinateSource: 'gcj02-to-wgs84' as const,
        nearest: convertedNearest,
      };
    }

    return {
      longitude,
      latitude,
      coordinateSource: 'wgs84-direct' as const,
      nearest: directNearest,
    };
  }, [resolveNearestStation, locationCoordinateMode]);

  const requestBrowserLocation = useCallback(async (): Promise<UserLocation | null> => {
    if (!navigator.geolocation) return null;
    return await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const longitude = Number(pos.coords.longitude);
          const latitude = Number(pos.coords.latitude);
          const accuracyMeters = Number(pos.coords.accuracy || 0);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
            resolve(null);
            return;
          }
          const normalized = normalizeBrowserLocationToWgs84(longitude, latitude);
          resolve({
            longitude: normalized.longitude,
            latitude: normalized.latitude,
            accuracyMeters: Number.isFinite(accuracyMeters) ? Math.round(accuracyMeters) : 0,
            stationName: normalized.nearest?.stationName,
            distanceToStationMeters: normalized.nearest?.distanceMeters,
            coordinateSource: normalized.coordinateSource,
            capturedAt: Date.now(),
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 60000,
        }
      );
    });
  }, [normalizeBrowserLocationToWgs84]);

  const selectedRouteLineGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    const route = shownRoutes[selectedRoute];
    const segmented = extractSegmentedRouteFeatures(route);
    if (segmented.length === 0) return null;
    const segSource = Array.isArray(route?.lineSegments) ? route.lineSegments : [];
    const mapped = segmented.map((seg, idx) => {
      const meta = segSource[idx];
      const lineBase = normalizeLineBaseName(meta?.lineName || '');
      const names = Array.isArray(meta?.stationNames) ? meta.stationNames : [];
      if (!lineBase || names.length < 2) return seg;
      const stationCoords: [number, number][] = [];
      for (const n of names) {
        const stationName = String(n || '').trim();
        const key = `${stationName}@@${lineBase}`;
        const coord = stationLineCoordLookup.get(key);
        if (coord) stationCoords.push(coord);
      }
      if (stationCoords.length < 2) return seg;

      const linePaths = linePathsByBaseName.get(lineBase) || [];
      if (linePaths.length === 0) return { ...seg, coordinates: stationCoords };

      const rebuilt: [number, number][] = [];
      for (let i = 0; i < stationCoords.length - 1; i += 1) {
        const part = buildPolylineBetweenPoints(linePaths, stationCoords[i], stationCoords[i + 1]);
        if (part.length < 2) continue;
        if (rebuilt.length > 0) rebuilt.push(...part.slice(1));
        else rebuilt.push(...part);
      }
      if (rebuilt.length >= 2) return { ...seg, coordinates: rebuilt };
      return { ...seg, coordinates: stationCoords };
    });
    return {
      type: 'FeatureCollection',
      features: mapped.map(seg => ({
        type: 'Feature',
        properties: {
          routeColor: USE_INVERTED_ARROW_COLOR ? invertHexColor(seg.color) : '#ffffff',
          routeHaloColor: seg.color,
        },
        geometry: {
          type: 'LineString',
          coordinates: seg.coordinates,
        },
      })) as Array<{
        type: 'Feature';
        properties: { routeColor: string };
        geometry: { type: 'LineString'; coordinates: [number, number][] };
      }>,
    };
  }, [shownRoutes, selectedRoute, stationLineCoordLookup, linePathsByBaseName]);

  const selectedRouteStationsGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    const route = shownRoutes[selectedRoute];
    if (!route || !Array.isArray(route.lineSegments) || route.lineSegments.length === 0) return null;
    const features: Feature<Geometry, GeoJsonProperties>[] = [];
    for (const seg of route.lineSegments) {
      const lineName = String(seg.lineName || '').trim();
      const lineBase = normalizeLineBaseName(lineName);
      const color = metroLineColorFromName(lineName);
      const names = Array.isArray(seg.stationNames) ? seg.stationNames : [];
      const coords = Array.isArray(seg.coordinates) ? seg.coordinates : [];
      const count = Math.min(names.length, coords.length);
      for (let i = 0; i < count; i += 1) {
        const stationName = String(names[i] || '').trim();
        const mapped = lineBase ? stationLineCoordLookup.get(`${stationName}@@${lineBase}`) : undefined;
        const c = mapped || coords[i];
        if (!Array.isArray(c) || c.length < 2) continue;
        const lng = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        features.push({
          type: 'Feature',
          properties: {
            station_name: stationName,
            line_name: lineName,
            point_color: color,
            status: '运营中',
          },
          geometry: {
            type: 'Point',
            coordinates: [lng, lat],
          },
        });
      }
    }
    if (features.length === 0) return null;
    return { type: 'FeatureCollection', features };
  }, [shownRoutes, selectedRoute, stationLineCoordLookup]);

  const selectedRouteTransferGeojson = useMemo((): FeatureCollection<Geometry, GeoJsonProperties> | null => {
    const route = shownRoutes[selectedRoute];
    if (!route || !Array.isArray(route.lineSegments) || route.lineSegments.length < 2) return null;
    const features: Feature<Geometry, GeoJsonProperties>[] = [];

    for (let i = 0; i < route.lineSegments.length - 1; i += 1) {
      const fromSeg = route.lineSegments[i];
      const toSeg = route.lineSegments[i + 1];
      const fromNames = Array.isArray(fromSeg.stationNames) ? fromSeg.stationNames : [];
      const toNames = Array.isArray(toSeg.stationNames) ? toSeg.stationNames : [];
      if (fromNames.length === 0 || toNames.length === 0) continue;

      const transferFrom = String(fromNames[fromNames.length - 1] || '').trim();
      const transferTo = String(toNames[0] || '').trim();
      if (!transferFrom || transferFrom !== transferTo) continue;

      const fromKey = `${transferFrom}@@${normalizeLineBaseName(fromSeg.lineName || '')}`;
      const toKey = `${transferTo}@@${normalizeLineBaseName(toSeg.lineName || '')}`;
      const fromCoord = stationLineCoordLookup.get(fromKey);
      const toCoord = stationLineCoordLookup.get(toKey);
      if (!fromCoord || !toCoord) continue;
      const fromColor = metroLineColorFromName(fromSeg.lineName || '');
      const toColor = metroLineColorFromName(toSeg.lineName || '');

      const same =
        Math.abs(fromCoord[0] - toCoord[0]) < 1e-9 &&
        Math.abs(fromCoord[1] - toCoord[1]) < 1e-9;
      if (same) continue;

      features.push({
        type: 'Feature',
        properties: {
          transfer_name: transferFrom,
          arrowColor: fromColor,
          arrowHaloColor: toColor,
        },
        geometry: {
          type: 'LineString',
          coordinates: [fromCoord, toCoord],
        },
      });
    }

    if (features.length === 0) return null;
    return { type: 'FeatureCollection', features };
  }, [shownRoutes, selectedRoute, stationLineCoordLookup]);

  const fitSelectedRouteOnMap = useCallback((mapRef: RefObject<MapRef | null>, routeIndex = selectedRoute) => {
    const route = shownRoutes[routeIndex];
    const segmented = extractSegmentedRouteFeatures(route);
    const coordinates = segmented.flatMap(s => s.coordinates);
    if (coordinates.length < 2 || !mapRef.current) return;
    const b = boundsFromCoordinates(coordinates);
    if (!b) return;
    mapRef.current.fitBounds(
      [[b.minLng, b.minLat], [b.maxLng, b.maxLat]],
      { padding: { top: 40, bottom: 40, left: 40, right: 40 }, duration: 700 }
    );
  }, [shownRoutes, selectedRoute]);

  const handleRouteCardClick = useCallback((idx: number) => {
    setSelectedRoute(idx);
    // 即使点击同一栏位，也强制触发一次地图定位。
    setTimeout(() => {
      fitSelectedRouteOnMap(sidebarMapRef, idx);
      if (mapExpanded) fitSelectedRouteOnMap(fullscreenMapRef, idx);
    }, 0);
  }, [fitSelectedRouteOnMap, mapExpanded]);

  const loadRoutes = useCallback(async (payload?: { query?: string; origin?: string; destination?: string }) => {
    setRouteLoading(true);
    setRouteError(null);
    try {
      const res = await fetch(resolvedRouteApiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: payload?.query,
          origin: payload?.origin,
          destination: payload?.destination,
          language: appLanguage,
          client: 'metro-app',
          version: 'v1'
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RouteApiResponse;
      const normalized = (data.routes || []).map(r => ({
        ...r,
        color1: r.color1 || '#4f46e5',
        color2: r.color2 || '#22c55e',
        label1: r.label1 || '',
        error: r.error || '',
        distanceMeters: Number(r.distanceMeters || 0),
        stations: r.stations || [],
      }));
      setApiRoutes(normalized);
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'route api error');
      setApiRoutes([]);
    } finally {
      setRouteLoading(false);
    }
  }, [resolvedRouteApiEndpoint, appLanguage]);

  useEffect(() => {
    loadRoutes();
  }, [resolvedRouteApiEndpoint, loadRoutes]);

  useEffect(() => {
    if (selectedRoute >= shownRoutes.length) setSelectedRoute(0);
  }, [shownRoutes, selectedRoute]);

  useEffect(() => {
    fitSelectedRouteOnMap(sidebarMapRef);
    if (mapExpanded) fitSelectedRouteOnMap(fullscreenMapRef);
  }, [selectedRoute, shownRoutes, mapExpanded, fitSelectedRouteOnMap]);

  useEffect(() => {
    if (!mapExpanded) return;
    const raf = requestAnimationFrame(() => fitSelectedRouteOnMap(fullscreenMapRef, selectedRoute));
    const timer = setTimeout(() => fitSelectedRouteOnMap(fullscreenMapRef, selectedRoute), 220);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [mapExpanded, selectedRoute, fitSelectedRouteOnMap]);

  useEffect(() => {
    if (!sidebarOpen || !sidebarMapRef.current) return;
    const doResize = () => {
      sidebarMapRef.current?.resize?.();
      sidebarMapRef.current?.getMap?.().resize?.();
    };
    const raf = requestAnimationFrame(doResize);
    const timer = setTimeout(doResize, 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [sidebarOpen, sidebarWidth]);

  const startResize = useCallback((side: 'left' | 'right', e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const onMouseMove = (evt: MouseEvent) => {
      if (side === 'left') {
        setHistoryWidth(clamp(evt.clientX, 180, 420));
      } else {
        setSidebarWidth(clamp(window.innerWidth - evt.clientX, 280, 560));
      }
    };
    const onMouseUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isTyping, streamingText]);

  // ── send message ───────────────────────────────────────────────────────────
  const sendMessageWithQuery = useCallback(async (queryOverride?: string, forceNewSession = false) => {
    const query = (typeof queryOverride === 'string' ? queryOverride : inputVal).trim();
    if (!query || isTyping) return;

    const userMsg: Message = { id: Date.now(), role: 'user', content: query };
    let sessionId = currentSessionId;
    const isNew = forceNewSession || !hasStarted || !currentSessionId;

    if (isNew) {
      setHasStarted(true);
      setSidebarOpen(true);
      sessionId = `session-${Date.now()}`;
      setCurrentSessionId(sessionId);
      setSessions(prev => [{ id: sessionId!, title: query.slice(0, 12), timestamp: Date.now(), messages: [userMsg] }, ...prev]);
    } else {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: [...s.messages, userMsg] } : s));
    }

    setInputVal('');
    setIsTyping(true);
    streamingTextRef.current = '';
    setStreamingText('');

    const autoTts = ttsEnabled && (triggerMode === 'auto' || triggerMode === 'both');
    if (autoTts) {
      tts.startSession();
      void tts.unlockAudio();
    }

    try {
      const latestLocation = await requestBrowserLocation();
      setLatestUserLocation(latestLocation);

      const session = sessions.find(s => s.id === (isNew ? null : sessionId));
      const history = (session?.messages ?? []).filter(m => typeof m.content === 'string');
      while (history.length && history[0].role === 'ai') history.shift();

      const locationContext = formatLocationSystemContext(latestLocation);

      const apiMsgs = [
        { role: 'system', content: appLanguage === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH },
        { role: 'system', content: locationContext },
        ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
        { role: 'user', content: query },
      ];

      const backendBase = getBackendBaseUrl(routeApiEndpoint);
      const resp = await fetch(`${backendBase}/api/llm/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          endpoint: apiEndpoint,
          apiKey,
          model: selectedModel || 'gpt-3.5-turbo',
          messages: apiMsgs,
          stream: true
        }),
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
      const finalTextForDisplay = finalText;
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { id: Date.now() + 1, role: 'ai', content: finalTextForDisplay }] }
          : s
      ));

      // 先结束流式态，避免同一条消息短暂出现两份（流式+最终消息）。
      setIsTyping(false);
      setStreamingText('');
      streamingTextRef.current = '';

      try {
        const routeBatchResp = await fetch(`${backendBase}/api/llm/route-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: apiEndpoint,
            apiKey,
            model: selectedModel || 'gpt-3.5-turbo',
            assistantText: finalTextForDisplay,
            userText: query,
            algorithm: 'astar',
            language: appLanguage,
          }),
        });
        if (routeBatchResp.ok) {
          const data = (await routeBatchResp.json()) as RouteBatchApiResponse;
          const normalized = (data.routes || []).map(r => ({
            ...r,
            color1: r.color1 || '#4f46e5',
            color2: r.color2 || '#22c55e',
            label1: r.label1 || '',
            error: r.error || '',
            distanceMeters: Number(r.distanceMeters || 0),
            stations: r.stations || [],
          }));
          if (normalized.length > 0) {
            setApiRoutes(normalized);
          } else {
            loadRoutes({ query });
          }
        } else {
          loadRoutes({ query });
        }
      } catch {
        loadRoutes({ query });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { id: Date.now() + 1, role: 'ai', content: `${t('请求出错：', 'Request error: ')}${msg}` }] }
          : s
      ));
      tts.stop();
    } finally {
      setIsTyping(false);
      setStreamingText('');
      streamingTextRef.current = '';
    }
  }, [inputVal, isTyping, currentSessionId, hasStarted, sessions, apiEndpoint, apiKey, selectedModel, ttsEnabled, triggerMode, tts, routeApiEndpoint, loadRoutes, requestBrowserLocation, appLanguage]);

  const handleSend = useCallback(async (queryOverride?: string | ReactMouseEvent<HTMLButtonElement>, forceNewSession = false) => {
    const query = typeof queryOverride === 'string' ? queryOverride : undefined;
    await sendMessageWithQuery(query, forceNewSession);
  }, [sendMessageWithQuery]);

  const handleExploreGoToStation = useCallback((stationName: string) => {
    if (isTyping) return;
    const target = String(stationName || '').trim();
    if (!target) return;
    const prompt = appLanguage === 'zh'
      ? `从当前位置前往${target}`
      : `How do I get from my current location to ${displayStationName(target, 'en')}?`;
    setViewMode('chat');
    setHistoryOpen(false);
    setMapExpanded(false);
    closeStationPopup();
    void handleSend(prompt, true);
  }, [isTyping, appLanguage, closeStationPopup, handleSend]);

  const handleNewChat = () => { tts.stop(); setHasStarted(false); setCurrentSessionId(null); setHistoryOpen(false); };
  const handleSelectSession = (id: string) => { tts.stop(); setCurrentSessionId(id); setHasStarted(true); setHistoryOpen(false); };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') handleSend(); };

  const handleFetchModels = async () => {
    if (!apiEndpoint || !apiKey) {
      setFetchMsg({ type: 'error', text: t('请先填写 Endpoint 和 API Key', 'Please fill in Endpoint and API Key') });
      return;
    }
    setFetchingModels(true); setFetchMsg({ type: '', text: '' });
    try {
      const backendBase = getBackendBaseUrl(routeApiEndpoint);
      const res = await fetch(`${backendBase}/api/llm/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: apiEndpoint, apiKey })
      });
      if (!res.ok) throw new Error(t(`状态码 ${res.status}`, `HTTP ${res.status}`));
      const data = await res.json();
      if (Array.isArray(data.data)) {
        const models: string[] = data.data.map((m: { id: string }) => m.id);
        setAvailableModels(models);
        if (models.length) setSelectedModel(models[0]);
        setFetchMsg({ type: 'success', text: t(`获取到 ${models.length} 个模型`, `Fetched ${models.length} model(s)`) });
      } else throw new Error(t('响应格式无法解析', 'Unable to parse response'));
    } catch (e: unknown) {
      setFetchMsg({ type: 'error', text: e instanceof Error ? e.message : t('失败', 'Failed') });
    } finally { setFetchingModels(false); }
  };

  const handleTestConn = async () => {
    setDebugInfo({ req: t('测试中...', 'Testing…'), res: '' });
    try {
      const backendBase = getBackendBaseUrl(routeApiEndpoint);
      const url = `${backendBase}/api/llm/chat`;
      const body = { model: selectedModel || 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'Hi' }] };
      const hid = apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : t('无', 'none');
      setDebugInfo({
        req: `POST ${url}\n${t('上游 Endpoint:', 'Upstream endpoint:')} ${apiEndpoint}\nAuthorization: Bearer ${hid}`,
        res: t('等待响应…', 'Waiting for response…'),
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: apiEndpoint,
          apiKey,
          ...body,
          stream: false
        })
      });
      const text = await res.text();
      setDebugInfo(prev => ({ ...prev, status: res.status, res: `${res.status} ${res.ok ? 'OK' : 'Error'}\n\n${text}` }));
    } catch (e: unknown) {
      setDebugInfo(prev => ({ ...prev, status: 0, res: `Network Error: ${e instanceof Error ? e.message : ''}` }));
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  const renderMetroMap = (mapRef: RefObject<MapRef | null>, mapKind: 'sidebar' | 'fullscreen') => (
    <>
      {mapboxToken
        ? <div
            className={mapKind === 'fullscreen' ? 'metro-map-wrap metro-map-wrap--fullscreen' : 'metro-map-wrap'}
            style={{ width: '100%', height: '100%' }}>
            <Map ref={mapRef}
            mapboxAccessToken={mapboxToken}
            initialViewState={
              mapKind === 'fullscreen'
                ? { longitude: 116.4074, latitude: 39.9042, zoom: 2 }
                : { longitude: 116.4074, latitude: 39.9042, zoom: 10 }
            }
            style={{ width: '100%', height: '100%' }}
            mapStyle={window.matchMedia('(prefers-color-scheme: dark)').matches ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11'}
            interactiveLayerIds={['selected-route-stations-layer', 'beijing-points-layer']}
            onLoad={() => {
              if (mapKind === 'fullscreen') fitSelectedRouteOnMap(fullscreenMapRef, selectedRoute);
            }}
            onClick={onMetroMapClick}
            onMouseMove={onMetroMapMouseMove}>
            <NavigationControl position="bottom-right" />
            {coloredLineGeojson && (
              <Source id="beijing-lines" type="geojson" data={coloredLineGeojson}>
                <Layer
                  id="beijing-lines-layer"
                  type="line"
                  layout={{ 'line-join': 'round', 'line-cap': 'round' }}
                  paint={{ 'line-color': ['get', 'line_color'], 'line-width': 2.5, 'line-opacity': 0.85 }}
                />
              </Source>
            )}
            {coloredPointGeojson && (
              <Source id="beijing-points" type="geojson" data={coloredPointGeojson}>
                <Layer
                  id="beijing-points-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 3.5,
                    'circle-color': ['get', 'point_color'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1,
                    'circle-opacity': 0.95,
                  }}
                />
              </Source>
            )}
            {selectedRouteLineGeojson && (
              <Source id="selected-route-line" type="geojson" data={selectedRouteLineGeojson}>
                <Layer
                  id="selected-route-arrow-layer"
                  type="symbol"
                  layout={{
                    'symbol-placement': 'line',
                    'symbol-spacing': 22,
                    'text-field': '➠', // ➜➠⇨➡🡺➣➧
                    'text-size': 22,
                    'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-rotation-alignment': 'map',
                    'text-keep-upright': false,
                  }}
                  paint={{
                    'text-color': ['get', 'routeColor'],
                    'text-opacity': 0.98,
                    'text-halo-color': ['get', 'routeHaloColor'],
                    'text-halo-width': 1.6,
                  }}
                />
              </Source>
            )}
            {selectedRouteTransferGeojson && (
              <Source id="selected-route-transfer" type="geojson" data={selectedRouteTransferGeojson}>
                <Layer
                  id="selected-route-transfer-layer"
                  type="symbol"
                  layout={{
                    'symbol-placement': 'line',
                    'symbol-spacing': 18,
                    'text-field': '➠',
                    'text-size': 18,
                    'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-rotation-alignment': 'map',
                    'text-keep-upright': false,
                  }}
                  paint={{
                    'text-color': ['get', 'arrowColor'],
                    'text-opacity': 0.98,
                    'text-halo-color': ['get', 'arrowHaloColor'],
                    'text-halo-width': 1.5,
                  }}
                />
              </Source>
            )}
            {selectedRouteStationsGeojson && (
              <Source id="selected-route-stations" type="geojson" data={selectedRouteStationsGeojson}>
                <Layer
                  id="selected-route-stations-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 5,
                    'circle-color': ['get', 'point_color'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1.3,
                    'circle-opacity': 1,
                  }}
                />
              </Source>
            )}
            {latestUserLocationGeojson && (
              <Source id="user-location" type="geojson" data={latestUserLocationGeojson}>
                {/* 外圈：用于肉眼验证定位偏移（不追求米级精度）。 */}
                <Layer
                  id="user-location-accuracy-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 12,
                    'circle-color': '#3b82f6',
                    'circle-opacity': 0.18,
                    'circle-stroke-color': '#3b82f6',
                    'circle-stroke-width': 1,
                    'circle-stroke-opacity': 0.35,
                  }}
                />
                {/* 内圈：用户当前位置点 */}
                <Layer
                  id="user-location-dot-layer"
                  type="circle"
                  paint={{
                    'circle-radius': 5,
                    'circle-color': '#3b82f6',
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                    'circle-opacity': 1,
                  }}
                />
              </Source>
            )}
            {stationPopup && (
              <Popup
                longitude={stationPopup.longitude}
                latitude={stationPopup.latitude}
                anchor="bottom"
                offset={8}
                className="metro-station-popup-mapbox"
                onClose={closeStationPopup}
                closeButton
                closeOnClick={false}
                maxWidth="min(340px, 92vw)">
                <div className="metro-station-popup">
                  <div className="metro-station-popup__title">
                    {displayStationName(stationPopup.stationName, appLanguage)}
                  </div>
                  <div className="metro-station-popup__row">
                    <span className="metro-station-popup__label">{t('状态', 'Status')}</span>
                    <span>{translateMetroStatus(stationPopup.status, appLanguage)}</span>
                  </div>
                  <div className="metro-station-popup__row metro-station-popup__lines">
                    <span className="metro-station-popup__label">{t('线路', 'Lines')}</span>
                    <ul className="metro-station-popup__line-list">
                      {stationPopup.lines.map(line => (
                        <li key={line}>
                          <span className="metro-station-popup__dot" style={{ background: metroLineColorFromName(line) }} />
                          <button
                            className="metro-station-popup__line-btn"
                            onClick={() => requestMetroIntro('line', line)}
                            title={t(`介绍${line}历史`, `Line history: ${displayLineName(line, 'en')}`)}>
                            {displayLineName(line, appLanguage)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="metro-station-popup__actions">
                    <button
                      className="metro-station-popup__action-btn"
                      disabled={popupIntroLoading}
                      onClick={() => requestMetroIntro('station', stationPopup.stationName)}>
                      {t('介绍该站周边文化', 'Introduce nearby culture')}
                    </button>
                    <button
                      className="metro-station-popup__action-btn"
                      disabled={popupSimilarLoading}
                      onClick={() => {
                        void fetchSimilarStations(stationPopup.stationName, 'popup');
                      }}>
                      {popupSimilarLoading ? t('查找中…', 'Finding…') : t('找相似站点', 'Find similar stations')}
                    </button>
                  </div>
                  {(popupIntroLoading || popupIntroText) && (
                    <div className="metro-station-popup__intro">
                      {popupIntroTitle && (
                        <div className="metro-station-popup__intro-title">{popupIntroTitle}</div>
                      )}
                      <div className="metro-station-popup__intro-body">
                        {popupIntroText
                          ? (
                            <>
                              <div className="markdown-body metro-station-popup__intro-markdown">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{popupIntroText}</ReactMarkdown>
                              </div>
                              {popupIntroLoading && <span className="metro-station-popup__stream-cursor" aria-hidden />}
                            </>
                            )
                          : popupIntroLoading
                            ? t('请稍等…', 'Generating, please wait…')
                            : null}
                      </div>
                    </div>
                  )}
                  {(popupSimilarLoading || popupSimilarStations.length > 0 || popupSimilarError) && (
                    <div className="metro-station-popup__intro">
                      <div className="metro-station-popup__intro-title">{t('相似站点推荐', 'Similar station recommendations')}</div>
                      {popupSimilarError && (
                        <div className="metro-station-popup__intro-body" style={{ color: '#f87171' }}>
                          {popupSimilarError}
                        </div>
                      )}
                      {!popupSimilarError && popupSimilarStations.length === 0 && popupSimilarLoading && (
                        <div className="metro-station-popup__intro-body">{t('正在计算相似站点…', 'Calculating similar stations…')}</div>
                      )}
                      {!popupSimilarError && popupSimilarStations.length > 0 && (
                        <div className="metro-similar-list">
                          {popupSimilarStations.map((item) => (
                            <button
                              key={item.station_name}
                              className="metro-similar-item"
                              onClick={() => requestMetroIntro('station', item.station_name)}>
                              <span className="metro-similar-item__name">{displayStationName(item.station_name, appLanguage)}</span>
                              <span className="metro-similar-item__score">{Math.round(item.score * 100)}%</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="metro-station-popup__footer-actions">
                    <button
                      type="button"
                      className="metro-station-popup__read-aloud-btn"
                      disabled={!popupIntroText.trim() || popupIntroLoading || !ttsEnabled}
                      onClick={() => {
                        if (!popupIntroText.trim()) return;
                        tts.speakFull(popupIntroText);
                      }}
                      title={t('朗读当前介绍', 'Read this introduction aloud')}
                      aria-label={t('朗读当前介绍', 'Read this introduction aloud')}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden>
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`tts-toggle-btn ${popupIntroTtsEnabled ? 'active' : ''}`}
                      onClick={() => {
                        if (popupIntroTtsEnabled) tts.stop();
                        setPopupIntroTtsEnabled(v => !v);
                      }}
                      title={popupIntroTtsEnabled ? t('关闭站点介绍语音', 'Disable intro voice') : t('开启站点介绍语音', 'Enable intro voice')}
                      aria-label={popupIntroTtsEnabled ? t('关闭站点介绍语音', 'Disable intro voice') : t('开启站点介绍语音', 'Enable intro voice')}>
                      {popupIntroTtsEnabled
                        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
                          </svg>
                        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15" aria-hidden>
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
                          </svg>}
                    </button>
                  </div>
                </div>
              </Popup>
            )}
          </Map>
        </div>
        : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', flexDirection: 'column', gap: 10 }}>
            <p>{t('请在设置中配置 Mapbox Token', 'Configure Mapbox Token in settings')}</p>
            <button className="btn-secondary" onClick={() => { setSettingsOpen(true); setSettingsTab('general'); }}>{t('去设置', 'Settings')}</button>
          </div>
      }
      {geojsonLoadError && (
        <div style={{ fontSize: 12, color: '#f87171', padding: '6px 2px', position: 'absolute' as const, left: 10, bottom: 10, background: 'rgba(0,0,0,0.35)', borderRadius: 6, maxWidth: 360 }}>
          {t('GeoJSON 加载失败：', 'Failed to load GeoJSON: ')}{geojsonLoadError}
        </div>
      )}
    </>
  );

  return (
    <div
      id="app"
      style={
        {
          '--history-w': `${historyWidth}px`,
          '--sidebar-w': `${sidebarWidth}px`,
        } as CSSProperties
      }>
      {/* Topbar */}
      <div id="topbar">
        <button id="menu-btn" className={historyOpen ? 'open' : ''} onClick={() => setHistoryOpen(!historyOpen)}>
          <span /><span /><span />
        </button>
        <button id="top-new-chat-btn" onClick={handleNewChat} title={t('新建对话', 'New chat')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="logo-area">
          <span className="logo-text">{t('京轨 —— 在地铁上读懂北京', 'JingRail.AI: Understand Beijing on the Metro')}</span>
          <button
            className={`top-nav-btn ${viewMode === 'explore' ? 'active' : ''}`}
            onClick={() => setViewMode(viewMode === 'chat' ? 'explore' : 'chat')}>
            {viewMode === 'chat' ? t('进入探索', 'Explore') : t('返回对话', 'Back to chat')}
          </button>
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
              <div className="hist-date">{formatRelativeDate(s.timestamp, appLanguage)}</div>
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
        <div className="resize-handle resize-handle-left" onMouseDown={(e) => startResize('left', e)} />
      </div>

      {/* Main */}
      <div id="main" className={`${isSidebarVisible ? 'sidebar-open' : ''} ${historyOpen ? 'history-open' : ''}`.trim()}>
        <div id="chat-area">
          {viewMode === 'explore' ? (
            <div className="explore-screen">
              <div className="explore-header">
                <h2>{t('文化探索', 'Culture explorer')}</h2>
                <div className="explore-header-actions">
                  {culturePath.length > 0 && (
                    <span className="explore-breadcrumb">{culturePath.join(' > ')}</span>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setCulturePath([]);
                      setSelectedCultureStation('');
                      setExploreSimilarStations([]);
                      setExploreSimilarError('');
                    }}>
                    {t('重置筛选', 'Reset filters')}
                  </button>
                </div>
              </div>
              <div className="explore-layout">
                <div className="explore-panel explore-panel--tree">
                  <div className="panel-label">{t('按文化树筛选', 'Filter by culture tree')}</div>
                  <div className="explore-panel-body">
                    {cultureTreeLoading && <div className="explore-empty">{t('文化树加载中…', 'Loading culture tree…')}</div>}
                    {cultureTreeError && <div className="explore-error">{cultureTreeError}</div>}
                    {!cultureTreeLoading && !cultureTreeError && cultureLevelOptions.length === 0 && (
                      <div className="explore-empty">{t('暂无文化树数据', 'No culture tree data')}</div>
                    )}
                    {!cultureTreeLoading && !cultureTreeError && cultureLevelOptions.map((levelNodes, depth) => (
                      <div key={`level-${depth}`} className="explore-level-block">
                        <div className="explore-level-title">{t(`第${depth + 1}层`, `Level ${depth + 1}`)}</div>
                        <div className="explore-chip-wrap">
                          {levelNodes.map((node) => {
                            const active = culturePath[depth] === node.name;
                            return (
                              <button
                                key={`${depth}-${node.name}`}
                                className={`explore-chip ${active ? 'active' : ''}`}
                                onClick={() => {
                                  setCulturePath([...culturePath.slice(0, depth), node.name]);
                                  setSelectedCultureStation('');
                                  setExploreSimilarStations([]);
                                  setExploreSimilarError('');
                                }}>
                                <span>{node.name}</span>
                                <span className="explore-chip-count">{node.count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {!cultureTreeLoading && !cultureTreeError && culturePath.length === 0 && (
                      <div className="explore-guide">
                        {t('先选择至少一个标签层级，再展示候选站点。', 'Pick at least one tag level to reveal candidate stations.')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="explore-panel explore-panel--candidates">
                  <div className="panel-label">{t('候选站点', 'Candidate stations')}</div>
                  <div className="explore-panel-body">
                    {culturePath.length === 0 && (
                      <div className="explore-empty">{t('先在左侧选择标签层级，再显示候选站点。', 'Choose labels in the left column first.')}</div>
                    )}
                    {culturePath.length > 0 && cultureStationsLoading && <div className="explore-empty">{t('站点加载中…', 'Loading stations…')}</div>}
                    {culturePath.length > 0 && cultureStationsError && <div className="explore-error">{cultureStationsError}</div>}
                    {culturePath.length > 0 && !cultureStationsLoading && !cultureStationsError && cultureStations.length === 0 && (
                      <div className="explore-empty">{t('当前标签下暂无站点', 'No stations under current labels')}</div>
                    )}
                    {culturePath.length > 0 && !cultureStationsLoading && !cultureStationsError && cultureStations.length > 0 && (
                      <div className="explore-station-list">
                        {cultureStations.map((station) => (
                          <div
                            key={station.station_name}
                            className={`explore-station-card ${selectedCultureStation === station.station_name ? 'active' : ''}`}>
                            <div className="explore-station-title">{displayStationName(station.station_name, appLanguage)}</div>
                            <div className="explore-station-summary">{station.story_summary || t('暂无简介', 'No summary')}</div>
                            <div className="explore-chip-wrap">
                              {station.culture_tags.slice(0, 4).map((tag) => (
                                <span key={`${station.station_name}-${tag}`} className="explore-mini-chip">{tag}</span>
                              ))}
                            </div>
                            <div className="explore-station-actions">
                              <button
                                className="btn-secondary"
                                onClick={() => {
                                  setSelectedCultureStation(station.station_name);
                                  void fetchSimilarStations(station.station_name, 'explore');
                                }}>
                                {t('找相似站点', 'Find similar stations')}
                              </button>
                              <button
                                className="btn-secondary"
                                disabled={isTyping}
                                onClick={() => {
                                  handleExploreGoToStation(station.station_name);
                                }}>
                                {t('前往', 'Go')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="explore-panel explore-panel--similar">
                  <div className="panel-label">{t('相似推荐 Top-K', 'Top-K similar stations')}</div>
                  <div className="explore-panel-body">
                    {!selectedCultureStation && <div className="explore-empty">{t('在中间列点击“找相似站点”后，这里显示推荐结果。', 'Use “Find similar stations” in the middle column to view results here.')}</div>}
                    {selectedCultureStation && exploreSimilarLoading && (
                      <div className="explore-empty">{t('正在计算相似站点…', 'Calculating similar stations…')}</div>
                    )}
                    {selectedCultureStation && exploreSimilarError && <div className="explore-error">{exploreSimilarError}</div>}
                    {selectedCultureStation && !exploreSimilarLoading && !exploreSimilarError && exploreSimilarStations.length === 0 && (
                      <div className="explore-empty">{t('暂无推荐结果', 'No recommendations')}</div>
                    )}
                    {exploreSimilarStations.length > 0 && (
                      <div className="explore-similar-list">
                        {exploreSimilarStations.map((item) => (
                          <div key={item.station_name} className="explore-similar-item">
                            <div className="explore-similar-item__head">
                              <span>{displayStationName(item.station_name, appLanguage)}</span>
                              <strong>{Math.round(item.score * 100)}%</strong>
                            </div>
                            <div className="explore-similar-item__reason">{item.reasons.join('；') || t('标签相近', 'Similar labels')}</div>
                            <div className="explore-similar-item__actions">
                              <button
                                className="btn-secondary"
                                disabled={isTyping}
                                onClick={() => {
                                  handleExploreGoToStation(item.station_name);
                                }}>
                                {t('前往', 'Go')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : !hasStarted ? (
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
                    {msg.role === 'user' && <div className="avatar user">{t('我', 'You')}</div>}
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
      {viewMode === 'chat' && (
      <div id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <div className="resize-handle resize-handle-right" onMouseDown={(e) => startResize('right', e)} />
        <div className="sidebar-section sidebar-route-section">
          <div className="panel-label">{t('推荐路线', 'Suggested routes')}</div>
          <div id="route-panel">
            {shownRoutes.map((route, idx) => (
              <div key={idx} className={`route-card ${selectedRoute === idx ? 'selected' : ''}`} onClick={() => handleRouteCardClick(idx)}>
                <div className="route-info-text">
                  <div className="route-name">
                    {route.origin && route.destination
                      ? `${displayPlaceLabel(route.origin, appLanguage)} → ${displayPlaceLabel(route.destination, appLanguage)}`
                      : (route.title
                          ? (appLanguage === 'en' ? displayRouteTitle(route.title, appLanguage) : route.title)
                          : t('推荐路线', 'Suggested route'))}
                  </div>
                  <div className="route-label-lines">
                    {getRenderedRouteItems(route).map((item, itemIdx) => (
                      <div
                        key={`${idx}-${itemIdx}-${item.type}-${item.text}`}
                        className={item.type === 'line' ? 'route-line-header' : 'route-station-item'}
                        style={item.type === 'line' ? { color: item.color } : undefined}>
                        {item.type === 'station' && <span className="route-station-dot" style={{ color: item.color }} />}
                        <span className={item.type === 'station' ? 'route-station-name' : undefined}>
                          {item.type === 'line'
                            ? `【${displayLineName(item.text, appLanguage)}】`
                            : displayStationName(item.text, appLanguage)}
                        </span>
                      </div>
                    ))}
                    {getRenderedRouteItems(route).length === 0 && <div className="route-line-header">-</div>}
                  </div>
                </div>
                <div className="route-duration">
                  {route.error ? (
                    t('失败', 'Failed')
                  ) : (
                    <>
                      <div>{formatDurationText(route.duration, route.distanceMeters, appLanguage)}</div>
                      <div>{formatDistanceText(route.distanceMeters, appLanguage)}</div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          {routeLoading && (
            <div style={{ fontSize: 12, color: '#8ea0b5', padding: '6px 10px' }}>{t('正在获取路线…', 'Loading routes…')}</div>
          )}
          {routeError && (
            <div style={{ fontSize: 12, color: '#f87171', padding: '6px 10px' }}>{t('路线接口错误：', 'Route API error: ')}{routeError}</div>
          )}
        </div>

        <div className="sidebar-section sidebar-map-section">
          <div className="panel-label">{t('线路地图', 'Line map')}</div>
          <div id="map-panel">
            <button
              className="map-expand-btn"
              onClick={() => {
                setMapExpanded(true);
                requestAnimationFrame(() =>
                  fitSelectedRouteOnMap(fullscreenMapRef, selectedRoute)
                );
              }}
              title={t('放大地图', 'Expand map')}>
              ⤢
            </button>
            {renderMetroMap(sidebarMapRef, 'sidebar')}
          </div>
        </div>
      </div>
      )}

      {viewMode === 'chat' && mapExpanded && (
        <div className="map-fullscreen-overlay" onClick={() => setMapExpanded(false)}>
          <div className="map-fullscreen-content" onClick={e => e.stopPropagation()}>
            <button className="map-close-btn" onClick={() => setMapExpanded(false)}>{t('关闭', 'Close')}</button>
            <div className="map-fullscreen-canvas">
              {renderMetroMap(fullscreenMapRef, 'fullscreen')}
            </div>
          </div>
        </div>
      )}

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
                        <option value="openai-compatible">{t('OpenAI 兼容接口', 'OpenAI-compatible API')}</option>
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
                        {fetchingModels ? t('获取中…', 'Fetching…') : t('获取模型列表', 'Fetch model list')}
                      </button>
                      {fetchMsg.text && <span className={fetchMsg.type === 'error' ? 'error-text' : 'success-text'}>{fetchMsg.text}</span>}
                    </div>
                    {availableModels.length > 0 && (
                      <div className="form-group mt-4">
                        <label>{t('选择模型', 'Model')}</label>
                        <input type="text" placeholder={t('搜索…', 'Search…')} value={modelSearch} onChange={e => setModelSearch(e.target.value)} style={{ marginBottom: 8 }} />
                        <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                          {availableModels.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())).map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="form-group mt-4" style={{ borderTop: '1px dashed var(--border-light)', paddingTop: 16 }}>
                      <label style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{t('连接排查', 'Connection debug')}</span>
                        <button className="btn-secondary" onClick={handleTestConn}>{t('发测试请求', 'Send test request')}</button>
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
                      <label>{t('按语言指定音色（可选）', 'Per-language voice override (optional)')}</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
                        <input
                          type="text"
                          value={ttsVoiceZh}
                          onChange={e => setTtsVoiceZh(e.target.value)}
                          placeholder={t('中文音色 ID（留空=默认）', 'Chinese voice ID (empty = default)')}
                        />
                        <input
                          type="text"
                          value={ttsVoiceJa}
                          onChange={e => setTtsVoiceJa(e.target.value)}
                          placeholder={t('日文音色 ID（建议填写日语专用音色）', 'Japanese voice ID (recommended to set a JP voice)')}
                        />
                        <input
                          type="text"
                          value={ttsVoiceEn}
                          onChange={e => setTtsVoiceEn(e.target.value)}
                          placeholder={t('英文音色 ID（留空=默认）', 'English voice ID (empty = default)')}
                        />
                      </div>
                      <div className="settings-hint">
                        {t('如果日语仍只读汉字，请填写一个支持日语的音色 ID。', 'If Japanese still reads only kanji, set a JP-capable voice ID here.')}
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
                        tts.speakFull('你好，能听到我的声音吗？我是一段测试语音！' +
                          '\n' +
                          '中文：故宫的四个城角，各有一座玲珑挺拔的角楼。' +
                          '日本語：故宮の四つの隅には、それぞれ精巧で高くそびえる角楼があります。\n' +
                          'English: There is a delicate and towering corner tower at each of the four corners of the Forbidden City.');
                      }}>
                        {t('发测试语音（多语言）', 'Send test speech (multi-lang)')}
                      </button>
                      <div className="debug-box" style={{ marginTop: '10px', background: '#1e1e1e', padding: '10px', borderRadius: '6px', fontSize: '12px', color: '#00ffcc', maxHeight: '320px', overflowY: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                        {tts.debugLogs.length === 0
                          ? t('目前无连接…\n点击上方按钮发起连接', 'No connection yet.\nClick the button above to connect.')
                          : tts.debugLogs.join('\n')}
                      </div>
                    </div>

                    {/*<div className="tts-info-card mt-4">
                      <div className="tts-info-title">⚡ 工作原理</div>
                      <div className="tts-info-body">
                        LLM 流式输出 → 按标点断句 → 每句建立独立 WebSocket 连接推送到火山 TTS → 接收 MP3 分片 → AudioContext 解码按序队列播放。多句并发请求，有序播放保证连贯。
                      </div>
                    </div>
                    */}
                  </div>
                )}

                {/* General */}
                {settingsTab === 'general' && (
                  <div className="settings-panel">
                    <h3>{t('通用设置', 'General')}</h3>
                    <div className="form-group">
                      <label>{t('路线规划 API 地址', 'Route API Endpoint')}</label>
                      <input type="text" value={routeApiEndpoint} onChange={e => setRouteApiEndpoint(e.target.value)}
                        placeholder="http://localhost:3000/api/route" />
                      <div className="settings-hint">
                        {t('用于右侧路线列表的数据来源（POST JSON）。留空则使用内置示例数据。', 'Data source for the right route list (POST JSON). Leave empty to use built-in demo data.')}
                      </div>
                    </div>
                    <div className="form-group">
                      <label>{t('定位坐标模式', 'Location Coordinate Mode')}</label>
                      <select value={locationCoordinateMode} onChange={e => setLocationCoordinateMode(e.target.value as LocationCoordinateMode)}>
                        <option value="auto">{t('自动（推荐）', 'Auto (recommended)')}</option>
                        <option value="wgs84-direct">{t('使用浏览器原始坐标（WGS84）', 'Use browser raw coordinates (WGS84)')}</option>
                        <option value="gcj02-to-wgs84">{t('使用 GCJ-02 → WGS84 转换后坐标', 'Use GCJ-02 → WGS84 converted coordinates')}</option>
                      </select>
                      <div className="settings-hint">
                        {t('如果你发现地图上的定位点整体偏移，可以切换坐标模式进行验证。', 'If the location dot looks offset, switch modes to verify.')}
                      </div>
                    </div>
                    <div className="form-group">
                      <label>{t('界面语言', 'Language')}</label>
                      <select value={appLanguage} onChange={e => setAppLanguage(e.target.value as 'zh' | 'en')}>
                        <option value="zh">{t('简体中文', 'Simplified Chinese')}</option>
                        <option value="en">{t('English', 'English')}</option>
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