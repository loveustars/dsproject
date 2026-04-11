/**
 * 地铁站点 / 线路名的「仅展示」英文化。
 * 所有请求后端 A*、route-batch、站点介绍 API 等仍必须使用中文 canonical 名（与 GeoJSON / metro_adjacency 一致）。
 */
import stationData from './data/metroStationEnMap.json';

const STATION_EN: Record<string, string> = stationData.stations as Record<string, string>;

/**
 * 自动生成的 metroStationEnMap 多为「逐词拼音 + 空格」，英文界面可读性差；
 * 在此覆盖为常见英文/惯用译名（与地图 API 使用的中文 canonical 名无关）。
 */
const STATION_EN_OVERRIDE: Record<string, string> = {
  '2号航站楼': 'Terminal 2',
  '3号航站楼': 'Terminal 3',
  沙河: 'Shahe',
  沙河高教园: 'Shahe Higher Education Park',
  巩华城: 'Gonghua Cheng',
  朱辛庄: 'Zhuxinzhuang',
  生命科学园: 'Life Science Park',
  西二旗: "Xi'erqi",
  清河站: 'Qinghe Railway Station',
  上地: 'Shangdi',
  五道口: 'Wudaokou',
  知春路: 'Zhichunlu',
  西土城: 'Xitucheng',
};

/** 线路「括号前」主名 → 英文（与 point GeoJSON 中 line_name 前缀一致） */
const LINE_BASE_EN: Record<string, string> = {
  北京大兴国际机场线北延: 'Daxing Airport Express (North extension)',
  地铁10号线内环: 'Line 10 (Inner loop)',
  地铁10号线外环: 'Line 10 (Outer loop)',
  地铁11号线: 'Line 11',
  地铁12号线: 'Line 12',
  地铁13B号线: 'Line 13B',
  地铁13号线: 'Line 13',
  地铁14号线: 'Line 14',
  地铁15号线: 'Line 15',
  地铁16号线: 'Line 16',
  地铁17号线: 'Line 17',
  地铁18号线: 'Line 18',
  地铁19号线: 'Line 19',
  地铁1号线八通线: 'Line 1 / Batong Line',
  地铁2号线内环: 'Line 2 (Inner loop)',
  地铁2号线外环: 'Line 2 (Outer loop)',
  地铁3号线: 'Line 3',
  地铁3号线一期东段: 'Line 3 (Phase 1 east)',
  地铁4号线大兴线: 'Line 4 / Daxing Line',
  地铁5号线: 'Line 5',
  地铁6号线: 'Line 6',
  地铁7号线: 'Line 7',
  地铁8号线: 'Line 8',
  地铁9号线: 'Line 9',
  地铁亦庄线: 'Yizhuang Line',
  地铁房山线: 'Fangshan Line',
  地铁昌平线: 'Changping Line',
  地铁燕房线: 'Yanfang Line',
  地铁燕房线支线: 'Yanfang Line (branch)',
  大兴机场线: 'Daxing Airport Express',
  西郊线: 'Western Suburbs Line',
  首都机场线: 'Capital Airport Express',
};

/** 英文线路展示名 → 中文主名，供配色等与 METRO_LINE_COLORS 对齐 */
const EN_LINE_BASE_TO_ZH = new Map<string, string>();
for (const [zh, en] of Object.entries(LINE_BASE_EN)) {
  EN_LINE_BASE_TO_ZH.set(en.toLowerCase(), zh);
}

/** 将可能的英文线路名还原为中文（仅用于颜色等内部逻辑）；已是中文则原样返回 */
export function resolveLineKeyForPalette(raw: string): string {
  const t = String(raw || '').trim();
  if (!t) return t;
  const open = t.indexOf('(');
  const base = (open >= 0 ? t.slice(0, open) : t).trim();
  const suffix = open >= 0 ? t.slice(open) : '';
  const zhBase = EN_LINE_BASE_TO_ZH.get(base.toLowerCase());
  if (zhBase) return suffix ? `${zhBase}${suffix}` : zhBase;
  return t;
}

function lineBaseEnglishFallback(base: string): string {
  const b = base.trim();
  if (LINE_BASE_EN[b]) return LINE_BASE_EN[b];
  const m = b.match(/^地铁(\d+[A-Za-z]?)号线$/);
  if (m) return `Line ${m[1]}`;
  if (b.startsWith('地铁') && b.endsWith('线')) return b.replace(/^地铁/, '').replace(/线$/, ' Line'); // 末手段
  return b;
}

export function displayStationName(zh: string, lang: 'zh' | 'en'): string {
  const z = String(zh || '').trim();
  if (!z || lang === 'zh') return z;
  if (STATION_EN_OVERRIDE[z]) return STATION_EN_OVERRIDE[z];
  if (STATION_EN[z]) return STATION_EN[z];
  if (z.endsWith('站') && z.length > 1) {
    const w = z.slice(0, -1);
    if (STATION_EN_OVERRIDE[w]) return STATION_EN_OVERRIDE[w];
    if (STATION_EN[w]) return STATION_EN[w];
  }
  return z;
}

/** 展示用：带括号的方向线名，如 地铁15号线(俸伯--清华东路西口) */
export function displayLineName(zh: string, lang: 'zh' | 'en'): string {
  const z = String(zh || '').trim();
  if (!z || lang === 'zh') return z;
  const open = z.indexOf('(');
  if (open > 0 && z.endsWith(')')) {
    const base = z.slice(0, open).trim();
    const inner = z.slice(open + 1, -1).trim();
    const baseEn = lineBaseEnglishFallback(base);
    const sep = inner.includes('--') ? '--' : inner.includes('—') ? '—' : '-';
    const parts = inner.split(sep).map((s) => s.trim()).filter(Boolean);
    const partsEn = parts.map((p) => displayStationName(p, 'en'));
    return `${baseEn} (${partsEn.join(' – ')})`;
  }
  return lineBaseEnglishFallback(z);
}

/** 路线卡片起终点等自由文本：整串若在站点表中有则译，否则原样 */
export function displayPlaceLabel(text: string, lang: 'zh' | 'en'): string {
  const z = String(text || '').trim();
  if (!z || lang === 'zh') return z;
  if (STATION_EN[z] || STATION_EN_OVERRIDE[z]) return displayStationName(z, 'en');
  if (z.endsWith('站') && z.length > 1) {
    const w = z.slice(0, -1);
    if (STATION_EN[w] || STATION_EN_OVERRIDE[w]) return displayStationName(w, 'en');
  }
  return z;
}

/** 后端 title 形如「沙河高教园 -> 霍营」：英文界面下拆段并译站名 */
export function displayRouteTitle(title: string, lang: 'zh' | 'en'): string {
  const raw = String(title || '').trim();
  if (!raw || lang === 'zh') return raw;
  const seps = [/\s*->\s*/, /\s*→\s*/, /\s+到\s+/];
  for (const sep of seps) {
    const parts = raw.split(sep).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) {
      return `${displayPlaceLabel(parts[0], 'en')} → ${displayPlaceLabel(parts[1], 'en')}`;
    }
  }
  return raw;
}
