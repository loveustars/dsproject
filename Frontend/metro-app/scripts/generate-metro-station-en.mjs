/**
 * 从 point GeoJSON 提取全部站点中文名，用 pinyin-pro 生成英文展示用拼音（首字母大写分词）。
 * 运行: node scripts/generate-metro-station-en.mjs
 * 输出: src/data/metroStationEnMap.json（提交到仓库，构建不依赖本脚本）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const geoPath = path.join(root, 'public/geojson_data/point_wgs84/beijing.geojson');
const outPath = path.join(root, 'src/data/metroStationEnMap.json');
const displayToZhPath = path.join(root, 'src/data/metroStationDisplayToZh.json');
const backendDisplayToZhPath = path.join(root, '..', '..', 'Backend', 'data', 'metroStationDisplayToZh.json');

const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
const names = new Set();
for (const f of geo.features || []) {
  const n = f.properties?.station_name;
  if (n) names.add(String(n).trim());
}

function toTitlePinyin(zh) {
  const raw = pinyin(zh, { toneType: 'none', type: 'string' }).trim();
  if (!raw) return zh;
  return raw
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
    .join(' ');
}

const stations = {};
for (const zh of [...names].sort()) {
  stations[zh] = toTitlePinyin(zh);
}

const exact = {};
const lower = {};
for (const [zh, en] of Object.entries(stations)) {
  exact[en] = zh;
  const k = en.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!(k in lower)) lower[k] = zh;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      version: 1,
      generatedNote: 'Auto-generated from point GeoJSON; UI display only. Routing APIs still use Chinese names.',
      stations,
    },
    null,
    2
  ),
  'utf8'
);
const displayPayload = {
  version: 1,
  generatedNote: 'Reverse of stations pinyin display → canonical Chinese for route lookup',
  exact,
  lower,
};
fs.writeFileSync(displayToZhPath, JSON.stringify(displayPayload, null, 2), 'utf8');
fs.mkdirSync(path.dirname(backendDisplayToZhPath), { recursive: true });
fs.writeFileSync(backendDisplayToZhPath, JSON.stringify(displayPayload, null, 2), 'utf8');
console.log(`Wrote ${Object.keys(stations).length} station entries to ${path.relative(root, outPath)}`);
console.log(`Wrote display→zh maps to ${path.relative(root, displayToZhPath)} and Backend/data/`);
