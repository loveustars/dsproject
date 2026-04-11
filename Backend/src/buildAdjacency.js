const fs = require("fs");
const path = require("path");

const pointGeoPath = path.resolve(__dirname, "../geojson_data/point_wgs84/beijing.geojson");
const lineGeoPath = path.resolve(__dirname, "../geojson_data/line_wgs84/beijing.geojson");
const outputPath = path.resolve(__dirname, "../data/metro_adjacency.json");
const EARTH_RADIUS_METERS = 6371000;

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

function baseLineKey(name) {
  return String(name || "").split("(")[0].trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function addEdge(adjacency, fromId, toId, distance, lineKey, rawLineName) {
  if (!adjacency[fromId]) adjacency[fromId] = [];
  const duplicate = adjacency[fromId].some(
    (e) => e.to === toId && e.lineKey === lineKey && e.rawLineName === rawLineName
  );
  if (duplicate) return;
  adjacency[fromId].push({
    to: toId,
    distance: Math.round(distance),
    lineKey,
    rawLineName
  });
}

function buildGraph() {
  const points = readJson(pointGeoPath);
  const lines = readJson(lineGeoPath);
  const stations = {};
  const stationNameToId = {};
  const adjacency = {};
  const lineMeta = {};

  for (const feature of lines.features || []) {
    const p = feature.properties || {};
    if (!p.line_name) continue;
    const lineKey = baseLineKey(p.line_name);
    if (!lineMeta[lineKey]) {
      lineMeta[lineKey] = {
        keyname: p.keyname || lineKey,
        line_name: p.line_name || lineKey,
        company: p.company || "",
        status: p.status || ""
      };
    }
  }

  const perLineStations = {};
  for (const feature of points.features || []) {
    const props = feature.properties || {};
    const geometry = feature.geometry || {};
    const stationName = String(props.station_name || "").trim();
    const rawLineName = String(props.line_name || "").trim();
    const lineKey = baseLineKey(rawLineName);
    const stationNum = Number(props.station_num || 0);
    const coordinates = geometry.coordinates || [];
    if (!stationName || coordinates.length < 2 || !rawLineName) continue;

    if (!stationNameToId[stationName]) {
      const stationId = `S${Object.keys(stationNameToId).length + 1}`;
      stationNameToId[stationName] = stationId;
      stations[stationId] = {
        stationName,
        location: [Number(coordinates[0]), Number(coordinates[1])],
        lineNames: [lineKey]
      };
      adjacency[stationId] = [];
    } else {
      const stationId = stationNameToId[stationName];
      const lineNames = stations[stationId].lineNames;
      if (!lineNames.includes(lineKey)) lineNames.push(lineKey);
    }

    if (!perLineStations[rawLineName]) perLineStations[rawLineName] = [];
    perLineStations[rawLineName].push({
      stationNum,
      stationName
    });
  }

  for (const rawLineName of Object.keys(perLineStations)) {
    const lineKey = baseLineKey(rawLineName);
    const ordered = perLineStations[rawLineName]
      .slice()
      .sort((a, b) => a.stationNum - b.stationNum);
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const fromId = stationNameToId[ordered[i].stationName];
      const toId = stationNameToId[ordered[i + 1].stationName];
      if (!fromId || !toId || fromId === toId) continue;
      const distance = haversineMeters(stations[fromId].location, stations[toId].location);
      addEdge(adjacency, fromId, toId, distance, lineKey, rawLineName);
      addEdge(adjacency, toId, fromId, distance, lineKey, rawLineName);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: {
      pointGeoPath: path.relative(path.resolve(__dirname, ".."), pointGeoPath),
      lineGeoPath: path.relative(path.resolve(__dirname, ".."), lineGeoPath)
    },
    stats: {
      stationCount: Object.keys(stations).length,
      edgeCount: Object.values(adjacency).reduce((acc, edges) => acc + edges.length, 0)
    },
    stations,
    stationNameToId,
    adjacency,
    lineMeta
  };
}

function main() {
  const graph = buildGraph();
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2), "utf8");
  console.log(`adjacency graph generated: ${outputPath}`);
  console.log(`stations=${graph.stats.stationCount}, edges=${graph.stats.edgeCount}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildGraph };
