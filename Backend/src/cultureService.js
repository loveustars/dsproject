const fs = require("fs");
const path = require("path");

const CULTURE_PATH = path.resolve(__dirname, "../data/stationCultureTree.json");

let cache = null;

function normalizeText(v) {
  return String(v || "").trim();
}

function normalizeTextArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const t = normalizeText(item);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function normalizeStation(raw) {
  const station_name = normalizeText(raw && raw.station_name);
  if (!station_name) return null;
  return {
    station_name,
    tree_path: normalizeTextArray(raw && raw.tree_path),
    culture_tags: normalizeTextArray(raw && raw.culture_tags),
    culture_types: normalizeTextArray(raw && raw.culture_types),
    story_summary: normalizeText(raw && raw.story_summary),
    recommended_topics: normalizeTextArray(raw && raw.recommended_topics),
    nearby_pois: normalizeTextArray(raw && raw.nearby_pois),
    audience_fit: normalizeTextArray(raw && raw.audience_fit),
    popularity: Number.isFinite(Number(raw && raw.popularity)) ? Number(raw.popularity) : 0,
    confidence: Number.isFinite(Number(raw && raw.confidence)) ? Number(raw.confidence) : 0,
    why_recommend: normalizeText(raw && raw.why_recommend),
    line_affinity: normalizeTextArray(raw && raw.line_affinity)
  };
}

function buildTree(stations) {
  const root = new Map();

  for (const station of stations) {
    const pathArr = station.tree_path;
    let layer = root;
    for (const segment of pathArr) {
      if (!layer.has(segment)) {
        layer.set(segment, { name: segment, count: 0, children: new Map() });
      }
      const node = layer.get(segment);
      node.count += 1;
      layer = node.children;
    }
  }

  const toArray = (map) => {
    return Array.from(map.values())
      .map((node) => ({
        name: node.name,
        count: node.count,
        children: toArray(node.children)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  };

  return toArray(root);
}

function ensureCache() {
  if (cache) return cache;

  let raw = { stations: [] };
  try {
    raw = JSON.parse(fs.readFileSync(CULTURE_PATH, "utf8"));
  } catch {
    raw = { stations: [] };
  }
  const inputStations = Array.isArray(raw.stations) ? raw.stations : [];
  const stations = inputStations.map(normalizeStation).filter(Boolean);
  const byName = new Map(stations.map((s) => [s.station_name, s]));
  const tree = buildTree(stations);

  cache = { stations, byName, tree };
  return cache;
}

function isPathPrefix(pathArr, prefixArr) {
  if (prefixArr.length === 0) return true;
  if (pathArr.length < prefixArr.length) return false;
  for (let i = 0; i < prefixArr.length; i += 1) {
    if (pathArr[i] !== prefixArr[i]) return false;
  }
  return true;
}

function getCultureTree() {
  const c = ensureCache();
  return {
    tree: c.tree,
    totalStations: c.stations.length
  };
}

function getStationsByPath(pathArr) {
  const c = ensureCache();
  const prefix = normalizeTextArray(pathArr);
  return c.stations.filter((s) => isPathPrefix(s.tree_path, prefix));
}

function jaccardScore(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const item of sa) {
    if (sb.has(item)) inter += 1;
  }
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

function commonPrefixLength(a, b) {
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a[i] === b[i]) i += 1;
  return i;
}

function buildReason(base, candidate) {
  const reasons = [];
  const prefixLen = commonPrefixLength(base.tree_path, candidate.tree_path);
  if (prefixLen > 0) {
    reasons.push(`同属主题：${base.tree_path.slice(0, prefixLen).join(" > ")}`);
  }
  const sharedTags = base.culture_tags.filter((t) => candidate.culture_tags.includes(t)).slice(0, 3);
  if (sharedTags.length > 0) {
    reasons.push(`共享标签：${sharedTags.join("、")}`);
  }
  const sharedTypes = base.culture_types.filter((t) => candidate.culture_types.includes(t)).slice(0, 2);
  if (sharedTypes.length > 0) {
    reasons.push(`同类属性：${sharedTypes.join("、")}`);
  }
  return reasons;
}

function getSimilarStations(stationName, topK = 5) {
  const c = ensureCache();
  const key = normalizeText(stationName);
  const base = c.byName.get(key);
  if (!base) {
    return {
      stationName: key,
      similarStations: []
    };
  }

  const candidates = [];
  for (const candidate of c.stations) {
    if (candidate.station_name === base.station_name) continue;

    const prefix = commonPrefixLength(base.tree_path, candidate.tree_path);
    const maxDepth = Math.max(base.tree_path.length, candidate.tree_path.length, 1);
    const pathScore = prefix / maxDepth;
    const tagScore = jaccardScore(base.culture_tags, candidate.culture_tags);
    const typeScore = jaccardScore(base.culture_types, candidate.culture_types);
    const lineScore = jaccardScore(base.line_affinity, candidate.line_affinity);
    const popScore = Math.max(0, Math.min(1, Number(candidate.popularity || 0)));

    const score = pathScore * 0.45 + tagScore * 0.3 + typeScore * 0.12 + lineScore * 0.08 + popScore * 0.05;
    candidates.push({
      station_name: candidate.station_name,
      tree_path: candidate.tree_path,
      culture_tags: candidate.culture_tags,
      culture_types: candidate.culture_types,
      story_summary: candidate.story_summary,
      score: Number(score.toFixed(4)),
      reasons: buildReason(base, candidate)
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.station_name.localeCompare(b.station_name, "zh-Hans-CN"));
  const limit = Number.isFinite(Number(topK)) ? Math.max(1, Math.min(20, Number(topK))) : 5;
  return {
    stationName: base.station_name,
    similarStations: candidates.slice(0, limit)
  };
}

module.exports = {
  getCultureTree,
  getStationsByPath,
  getSimilarStations
};
