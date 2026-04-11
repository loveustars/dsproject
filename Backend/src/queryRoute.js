const fs = require("fs");
const path = require("path");

const GRAPH_PATH = path.resolve(__dirname, "../data/metro_adjacency.json");
const DISPLAY_TO_ZH_PATH = path.resolve(__dirname, "../data/metroStationDisplayToZh.json");
const ENGLISH_ALIASES_PATH = path.resolve(__dirname, "../data/metroStationEnglishAliases.json");
const EARTH_RADIUS_METERS = 6371000;
let cachedGraph = null;
let displayMapsCache = null;

function normalizeName(name) {
  return String(name || "").trim();
}

function loadDisplayMaps() {
  if (displayMapsCache) return displayMapsCache;
  displayMapsCache = { exact: {}, lower: {}, aliases: {} };
  try {
    const d = JSON.parse(fs.readFileSync(DISPLAY_TO_ZH_PATH, "utf8"));
    displayMapsCache.exact = d.exact || {};
    displayMapsCache.lower = d.lower || {};
  } catch {
    /**/
  }
  try {
    const a = JSON.parse(fs.readFileSync(ENGLISH_ALIASES_PATH, "utf8"));
    displayMapsCache.aliases = a || {};
  } catch {
    /**/
  }
  return displayMapsCache;
}

/** 将用户/模型输入的站名（含英文、拼音展示名）解析为图中存在的中文 canonical 名 */
function resolveToCanonicalChineseStation(graph, raw) {
  const n = normalizeName(raw);
  if (!n) return "";
  if (graph.stationNameToId[n]) return n;
  if (n.endsWith("站") && n.length > 1) {
    const w = n.slice(0, -1);
    if (graph.stationNameToId[w]) return w;
  }
  const maps = loadDisplayMaps();
  const keyLower = n.toLowerCase().replace(/\s+/g, " ").trim();
  const fromAlias = maps.aliases[keyLower];
  if (fromAlias && graph.stationNameToId[fromAlias]) return fromAlias;
  const fromExact = maps.exact[n];
  if (fromExact && graph.stationNameToId[fromExact]) return fromExact;
  const fromLower = maps.lower[keyLower];
  if (fromLower && graph.stationNameToId[fromLower]) return fromLower;
  return "";
}

/**
 * 从一段文本拆出起点、终点（用于 &lt;query&gt; 与 query 参数）。
 * - 含 | 时按第一个 | 分割（推荐：英文多词站名）。
 * - 仅空白分隔且恰好两段：左起点、右终点（中文站名无空格时常用）。
 * - 多于两段且无 |：最后一段为终点，前面整体为起点（兼容 "Shahe Higher Education Park Xitucheng"）。
 */
function splitRouteEndpoints(raw) {
  const text = normalizeName(raw);
  if (!text) return { origin: "", destination: "" };
  if (text.includes("|")) {
    const i = text.indexOf("|");
    const origin = normalizeName(text.slice(0, i));
    const destination = normalizeName(text.slice(i + 1));
    return { origin, destination };
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { origin: "", destination: "" };
  if (parts.length === 2) {
    return { origin: parts[0], destination: parts[1] };
  }
  return {
    origin: normalizeName(parts.slice(0, -1).join(" ")),
    destination: normalizeName(parts[parts.length - 1])
  };
}

function parseOriginDestinationFromQuery(queryText) {
  const text = String(queryText || "").trim();
  if (!text) return { origin: "", destination: "" };

  const patterns = [
    /从\s*(.+?)\s*到\s*(.+)/,
    /^(.+?)\s*(?:到|至|->|→|-)\s*(.+)$/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        origin: normalizeName(match[1]),
        destination: normalizeName(match[2])
      };
    }
  }

  return splitRouteEndpoints(text);
}

function colorFromLine(lineName, fallback = "#4f46e5") {
  const key = normalizeName(lineName);
  if (!key) return fallback;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const palette = ["#185FA5", "#D85A30", "#22c55e", "#a855f7", "#0ea5e9", "#f59e0b", "#14b8a6"];
  return palette[hash % palette.length];
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

function loadGraph() {
  if (cachedGraph) return cachedGraph;
  const raw = fs.readFileSync(GRAPH_PATH, "utf8");
  cachedGraph = JSON.parse(raw);
  return cachedGraph;
}

function findStationIdByName(graph, stationName) {
  const canonical = resolveToCanonicalChineseStation(graph, stationName);
  if (!canonical) return "";
  return graph.stationNameToId[canonical] || "";
}

function reconstructPath(parentByNode, endId) {
  const path = [];
  let current = endId;
  while (current) {
    path.push(current);
    current = parentByNode[current] || "";
  }
  return path.reverse();
}

function buildPathStations(graph, nodePath) {
  return nodePath.map((id) => {
    const station = graph.stations[id];
    return {
      stationId: id,
      stationName: station.stationName,
      lineNames: station.lineNames,
      location: station.location
    };
  });
}

function calcTransfers(graph, nodePath) {
  if (nodePath.length < 2) return { transfers: 0, lineSequence: [] };
  let previousLine = null;
  let transfers = 0;
  const lineSequence = [];

  for (let i = 0; i < nodePath.length - 1; i += 1) {
    const fromId = nodePath[i];
    const toId = nodePath[i + 1];
    const edges = graph.adjacency[fromId] || [];
    const edge = edges.find((item) => item.to === toId);
    if (!edge) continue;
    lineSequence.push(edge.lineKey);
    if (previousLine && previousLine !== edge.lineKey) transfers += 1;
    previousLine = edge.lineKey;
  }

  return { transfers, lineSequence };
}

function getStepLineOptions(graph, nodePath) {
  const options = [];
  for (let i = 0; i < nodePath.length - 1; i += 1) {
    const fromId = nodePath[i];
    const toId = nodePath[i + 1];
    const edges = graph.adjacency[fromId] || [];
    const lines = Array.from(new Set(edges.filter((e) => e.to === toId).map((e) => e.lineKey)));
    options.push(lines);
  }
  return options;
}

function resolveLineSequence(graph, nodePath) {
  const stepOptions = getStepLineOptions(graph, nodePath);
  if (stepOptions.length === 0) return [];
  const dp = [];
  dp[0] = {};
  for (const line of stepOptions[0]) {
    dp[0][line] = { switches: 0, prev: "" };
  }
  if (Object.keys(dp[0]).length === 0) return [];

  for (let step = 1; step < stepOptions.length; step += 1) {
    dp[step] = {};
    for (const line of stepOptions[step]) {
      let best = null;
      for (const prevLine of Object.keys(dp[step - 1])) {
        const prev = dp[step - 1][prevLine];
        const switches = prev.switches + (prevLine === line ? 0 : 1);
        if (!best || switches < best.switches) {
          best = { switches, prev: prevLine };
        }
      }
      if (best) dp[step][line] = best;
    }
    if (Object.keys(dp[step]).length === 0) return [];
  }

  const lastStep = dp.length - 1;
  let endLine = "";
  for (const line of Object.keys(dp[lastStep])) {
    if (!endLine || dp[lastStep][line].switches < dp[lastStep][endLine].switches) endLine = line;
  }
  if (!endLine) return [];

  const seq = new Array(stepOptions.length);
  seq[lastStep] = endLine;
  for (let step = lastStep; step > 0; step -= 1) {
    seq[step - 1] = dp[step][seq[step]].prev;
  }
  return seq.filter(Boolean);
}

function buildLineSegments(graph, nodePath, lineSequence) {
  if (nodePath.length < 2 || lineSequence.length < 1) return [];
  const segments = [];
  let currentLine = lineSequence[0];
  let currentStationIds = [nodePath[0], nodePath[1]];

  for (let i = 1; i < lineSequence.length; i += 1) {
    const line = lineSequence[i];
    const toId = nodePath[i + 1];
    if (line === currentLine) {
      currentStationIds.push(toId);
    } else {
      segments.push({
        lineName: currentLine,
        stationIds: currentStationIds,
        stationNames: currentStationIds.map((id) => graph.stations[id].stationName),
        coordinates: currentStationIds.map((id) => graph.stations[id].location)
      });
      currentLine = line;
      currentStationIds = [nodePath[i], toId];
    }
  }
  segments.push({
    lineName: currentLine,
    stationIds: currentStationIds,
    stationNames: currentStationIds.map((id) => graph.stations[id].stationName),
    coordinates: currentStationIds.map((id) => graph.stations[id].location)
  });
  return segments;
}

function aStarRoute(graph, originId, destinationId) {
  const open = new Set([originId]);
  const cameFrom = {};
  const gScore = { [originId]: 0 };
  const fScore = {
    [originId]: haversineMeters(
      graph.stations[originId].location,
      graph.stations[destinationId].location
    )
  };

  while (open.size > 0) {
    let current = null;
    let currentF = Infinity;
    for (const node of open) {
      const score = fScore[node] ?? Infinity;
      if (score < currentF) {
        currentF = score;
        current = node;
      }
    }

    if (!current) break;
    if (current === destinationId) return reconstructPath(cameFrom, current);
    open.delete(current);

    const neighbors = graph.adjacency[current] || [];
    for (const edge of neighbors) {
      const tentativeG = (gScore[current] ?? Infinity) + edge.distance;
      if (tentativeG < (gScore[edge.to] ?? Infinity)) {
        cameFrom[edge.to] = current;
        gScore[edge.to] = tentativeG;
        fScore[edge.to] =
          tentativeG +
          haversineMeters(
            graph.stations[edge.to].location,
            graph.stations[destinationId].location
          );
        open.add(edge.to);
      }
    }
  }

  return [];
}

function buildTransferGraph(graph) {
  const transferAdj = {};
  const stationIds = Object.keys(graph.stations);
  for (const id of stationIds) transferAdj[id] = [];

  for (const fromId of Object.keys(graph.adjacency)) {
    const grouped = new Map();
    const edges = graph.adjacency[fromId] || [];
    for (const edge of edges) {
      if (!grouped.has(edge.to)) grouped.set(edge.to, []);
      grouped.get(edge.to).push(edge.lineKey);
    }

    for (const [toId, lines] of grouped.entries()) {
      transferAdj[fromId].push({ to: toId, lines: Array.from(new Set(lines)) });
    }
  }

  return transferAdj;
}

function minTransferRoute(graph, originId, destinationId) {
  const transferAdj = buildTransferGraph(graph);
  const deque = [{ node: originId, line: "" }];
  const best = { [`${originId}|`]: { transfers: 0, steps: 0 } };
  const parent = {};

  while (deque.length > 0) {
    const state = deque.shift();
    const stateKey = `${state.node}|${state.line}`;
    const base = best[stateKey];
    if (!base) continue;

    const neighbors = transferAdj[state.node] || [];
    for (const next of neighbors) {
      for (const lineKey of next.lines) {
        const switchCost = state.line && state.line !== lineKey ? 1 : 0;
        const nextTransfers = base.transfers + switchCost;
        const nextSteps = base.steps + 1;
        const nextKey = `${next.to}|${lineKey}`;
        const old = best[nextKey];
        const shouldUpdate =
          !old ||
          nextTransfers < old.transfers ||
          (nextTransfers === old.transfers && nextSteps < old.steps);
        if (!shouldUpdate) continue;

        best[nextKey] = { transfers: nextTransfers, steps: nextSteps };
        parent[nextKey] = stateKey;
        const nextState = { node: next.to, line: lineKey };
        if (switchCost === 0) {
          deque.unshift(nextState);
        } else {
          deque.push(nextState);
        }
      }
    }
  }

  let targetKey = "";
  for (const key of Object.keys(best)) {
    const [node] = key.split("|");
    if (node !== destinationId) continue;
    if (!targetKey) {
      targetKey = key;
      continue;
    }
    const cur = best[key];
    const old = best[targetKey];
    if (
      cur.transfers < old.transfers ||
      (cur.transfers === old.transfers && cur.steps < old.steps)
    ) {
      targetKey = key;
    }
  }
  if (!targetKey) return [];

  const nodePath = [];
  let cursor = targetKey;
  while (cursor) {
    const [node] = cursor.split("|");
    nodePath.push(node);
    cursor = parent[cursor] || "";
  }
  return nodePath.reverse();
}

function estimateMinutes(totalDistanceMeters, stationCount) {
  const speedMetersPerMin = 500;
  const runMinutes = totalDistanceMeters / speedMetersPerMin;
  const dwellMinutes = Math.max(stationCount - 1, 0) * 0.5;
  return Math.max(1, Math.round(runMinutes + dwellMinutes));
}

function calcPathDistance(graph, nodePath) {
  let totalDistance = 0;
  for (let i = 0; i < nodePath.length - 1; i += 1) {
    const fromId = nodePath[i];
    const toId = nodePath[i + 1];
    const edge = (graph.adjacency[fromId] || []).find((item) => item.to === toId);
    totalDistance += edge ? edge.distance : 0;
  }
  return totalDistance;
}

function pathToStationLabel(graph, nodePath) {
  if (!Array.isArray(nodePath) || nodePath.length === 0) return "";
  return nodePath
    .map((id) => graph.stations[id] && graph.stations[id].stationName)
    .filter(Boolean)
    .join(" ");
}

function formatRouteLabelBySegments(segments) {
  return segments
    .map((seg) => {
      const stationLines = seg.stationNames.map((name) => `- ${name}`).join("\n");
      return `【${seg.lineName}】\n${stationLines}`;
    })
    .join("\n");
}

function queryRoute(origin, destination, options = {}) {
  const graph = loadGraph();
  const parsedFromQuery = parseOriginDestinationFromQuery(options.query);
  const safeOrigin = normalizeName(origin) || parsedFromQuery.origin;
  const safeDestination = normalizeName(destination) || parsedFromQuery.destination;
  const algorithm = String(options.algorithm || "astar").toLowerCase();

  const originId = findStationIdByName(graph, safeOrigin);
  const destinationId = findStationIdByName(graph, safeDestination);
  const originResolved = resolveToCanonicalChineseStation(graph, safeOrigin) || safeOrigin;
  const destinationResolved = resolveToCanonicalChineseStation(graph, safeDestination) || safeDestination;

  if (!originId || !destinationId) {
    return {
      origin: safeOrigin,
      destination: safeDestination,
      generatedAt: new Date().toISOString(),
      error: "station not found",
      routes: []
    };
  }

  const shortestPath = aStarRoute(graph, originId, destinationId);
  const minTransferPath = minTransferRoute(graph, originId, destinationId);
  const selectedPath =
    algorithm === "bfs" || algorithm === "min_transfer" ? minTransferPath : shortestPath;

  if (selectedPath.length === 0) {
    return {
      origin: originResolved,
      destination: destinationResolved,
      generatedAt: new Date().toISOString(),
      error: "route not found",
      routes: []
    };
  }

  const stations = buildPathStations(graph, selectedPath);
  const totalDistance = calcPathDistance(graph, selectedPath);
  const lineSequence = resolveLineSequence(graph, selectedPath);
  const transfers = lineSequence.reduce(
    (acc, line, idx) => (idx > 0 && line !== lineSequence[idx - 1] ? acc + 1 : acc),
    0
  );
  const lineSegments = buildLineSegments(graph, selectedPath, lineSequence);
  const shortestSegments = buildLineSegments(graph, shortestPath, resolveLineSequence(graph, shortestPath));
  const shortestLabel = formatRouteLabelBySegments(shortestSegments);

  return {
    origin: originResolved,
    destination: destinationResolved,
    generatedAt: new Date().toISOString(),
    algorithm,
    routes: [
      {
        routeId: "route_1",
        title: `${originResolved} -> ${destinationResolved}`,
        duration: estimateMinutes(totalDistance, stations.length),
        color1: "#185FA5",
        label1: shortestLabel || "-",
        distanceMeters: Math.round(totalDistance),
        transferCount: transfers,
        lineSequence,
        lineSegments,
        stations
      }
    ]
  };
}

module.exports = {
  queryRoute,
  splitRouteEndpoints
};
