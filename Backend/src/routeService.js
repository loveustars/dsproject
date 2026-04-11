function queryRoute(origin, destination) {
  const safeOrigin = String(origin || "起点").trim() || "起点";
  const safeDestination = String(destination || "终点").trim() || "终点";

  return {
    origin: safeOrigin,
    destination: safeDestination,
    generatedAt: new Date().toISOString(),
    routes: [
      {
        routeId: "demo_1",
        title: `${safeOrigin} -> ${safeDestination}`,
        duration: 30,
        color1: "#185FA5",
        color2: "#D85A30",
        label1: "示例线A",
        label2: "示例线B",
        switchAt: 2,
        stations: []
      }
    ]
  };
}

module.exports = {
  queryRoute
};
