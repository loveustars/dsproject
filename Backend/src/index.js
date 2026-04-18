const http = require("http");
const { queryRoute, splitRouteEndpoints } = require("./queryRoute");
const { getCultureTree, getStationsByPath, getSimilarStations } = require("./cultureService");

const PORT = process.env.PORT || 3000;

function buildRequestId() {
  return `req_${Date.now()}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
}

function readJsonBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (err) {
      callback(err);
    }
  });
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "");
}

function ensureV1(endpoint) {
  const clean = normalizeEndpoint(endpoint);
  if (!clean) return "";
  return clean.endsWith("/v1") ? clean : `${clean}/v1`;
}

function logRequest(req) {
  console.log(`[request] ${req.method} ${req.url}`);
}

async function callChatCompletion({ endpoint, apiKey, model, messages, stream = false, max_tokens }) {
  const upstream = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages,
      stream,
      ...(typeof max_tokens === "number" ? { max_tokens } : {})
    })
  });
  return upstream;
}

function extractQueryPairs(text) {
  const src = String(text || "");
  const regex = /<query>\s*([^<]+?)\s*<\/query>/gi;
  const pairs = [];
  let match = null;
  while ((match = regex.exec(src))) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    const { origin, destination } = splitRouteEndpoints(raw);
    if (!origin || !destination) continue;
    pairs.push({ origin, destination });
  }
  return pairs;
}

async function forwardSseResponse(upstreamResp, res) {
  if (!upstreamResp.body) {
    sendSseHeaders(res);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  sendSseHeaders(res);
  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
  }
  res.end();
}

const server = http.createServer((req, res) => {
  logRequest(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    console.log("[health] ok");
    return sendJson(res, 200, { ok: true, service: "metro-backend" });
  }

  if (req.method === "GET" && req.url === "/api/culture/tree") {
    return sendJson(res, 200, {
      requestId: buildRequestId(),
      ...getCultureTree()
    });
  }

  if (req.method === "POST" && req.url === "/api/culture/stations-by-path") {
    readJsonBody(req, (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, {
          requestId: buildRequestId(),
          error: "invalid json body"
        });
      }
      const stations = getStationsByPath(Array.isArray(data.path) ? data.path : []);
      return sendJson(res, 200, {
        requestId: buildRequestId(),
        path: Array.isArray(data.path) ? data.path : [],
        total: stations.length,
        stations
      });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/culture/similar") {
    readJsonBody(req, (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, {
          requestId: buildRequestId(),
          error: "invalid json body"
        });
      }
      const stationName = String(data.stationName || "").trim();
      if (!stationName) {
        return sendJson(res, 400, {
          requestId: buildRequestId(),
          error: "stationName is required"
        });
      }

      return sendJson(res, 200, {
        requestId: buildRequestId(),
        ...getSimilarStations(stationName, data.topK)
      });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/llm/models") {
    readJsonBody(req, async (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "invalid json body" });
      }
      const endpoint = ensureV1(data.endpoint);
      const apiKey = data.apiKey || "";
      if (!endpoint) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "endpoint is required" });
      }
      try {
        const upstream = await fetch(`${endpoint}/models`, {
          method: "GET",
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
          }
        });
        const text = await upstream.text();
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (e) {
          payload = { raw: text };
        }
        return sendJson(res, upstream.status, payload);
      } catch (err) {
        return sendJson(res, 502, {
          requestId: buildRequestId(),
          error: err instanceof Error ? err.message : "upstream request failed"
        });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/llm/chat") {
    readJsonBody(req, async (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "invalid json body" });
      }
      const endpoint = ensureV1(data.endpoint);
      const apiKey = data.apiKey || "";
      const model = data.model || "qwen2.5-32b-instruct";
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const stream = data.stream !== false;
      if (!endpoint) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "endpoint is required" });
      }
      try {
        const upstream = await callChatCompletion({
          endpoint,
          apiKey,
          model,
          messages,
          stream,
          max_tokens: data.max_tokens
        });
        if (stream) {
          return forwardSseResponse(upstream, res);
        }
        const text = await upstream.text();
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (e) {
          payload = { raw: text };
        }
        return sendJson(res, upstream.status, payload);
      } catch (err) {
        return sendJson(res, 502, {
          requestId: buildRequestId(),
          error: err instanceof Error ? err.message : "upstream request failed"
        });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/llm/metro-intro-stream") {
    readJsonBody(req, async (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "invalid json body" });
      }
      const endpoint = ensureV1(data.endpoint);
      const apiKey = data.apiKey || "";
      const model = data.model || "qwen2.5-32b-instruct";
      const targetType = data.targetType === "line" ? "line" : "station";
      const targetName = String(data.targetName || "").trim();
      const language = data.language === "en" ? "en" : "zh";
      if (!endpoint) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "endpoint is required" });
      }
      if (!targetName) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "targetName is required" });
      }
      const targetDisplayEn = String(data.targetDisplayEn || "").trim();

      let systemContent;
      let userContent;
      if (targetType === "station") {
        if (language === "en") {
          const stationEn = targetDisplayEn || targetName;
          systemContent = [
            "You write short cultural blurbs for a metro station side panel (not a chat essay, not a directory dump).",
            `Internal graph key (Chinese, for grounding only): "${targetName}".`,
            `**Use this English name in all prose:** "${stationEn}" (and close natural variants like \"the ${stationEn} area\").`,
            "**Language — critical:** The **entire** reply must be **fluent English only**—headings, paragraphs, bullets. Do **not** output Chinese sentences, Chinese-only headings, or a lone Chinese title line (e.g. starting with 平安里 as the only heading). Mention other places in English (Drum and Bell Towers, Shichahai, etc.).",
            "Length: about **130–200 words** in **2–4 short paragraphs** of connected prose. You may add a brief bullet list **only if** it adds real value; do **not** replace paragraphs with a wall of one-line POIs.",
            "Tone: calm, informative, like a museum placard—history or city context where you are confident; 1–2 concrete nearby anchors with a clause of why they matter.",
            "Avoid: greetings, hype adjectives, long disclaimers, \"in conclusion\". Do **not** invent exact line numbers, opening years, or transfers—omit if unsure.",
            "**Naming:** Do **not** use **Chinese + tone-marked pinyin in parentheses** (forbidden: \"知春路 (Zhīchūn Lù)\"). Prefer the English label above for the station.",
            "Markdown allowed (optional single ## title in English)."
          ].join("\n");
          userContent = "Write the introduction in English.";
        } else {
          systemContent = [
            "你是北京地铁「站点信息栏」文案作者：给乘客一段**不长不短、可读**的片区说明，既不是长篇论文，也不是干瘪地名列表。",
            `站点：「${targetName}」（名称以系统为准，勿改写）。`,
            "**篇幅**：约 **320–480 字**，以 **2～4 个自然段**为主，句子写完整；可酌情用少量 `-` 列表补充，但**禁止**通篇只有「某某：一句话」式的凑数条目，更不要编造周边无名小店、学校、卫生院等无法核对的琐碎信息。",
            "**内容**：区位与片区氛围；与市中心或城市结构的关系；有把握时写一两句历史或沿革；周边择要提 1～2 处公众熟知的地标/公园/街区（用从句点出意义即可）。可有一句实用游览或换乘提示。",
            "**禁止**：开场客套、「综上所述」、整段免责声明；不要编造本站所属线路、开通年代、换乘细节等硬事实（不确定则略写或不写）。",
            "**站名写法**：不要用「中文站名（带调拼音）」括注；正文里站名用**中文书面一次**即可。",
            "Markdown 可用；最多一个简短 `##` 小标题，勿多级标题。"
          ].join("\n");
          userContent = "请撰写介绍。";
        }
      } else if (language === "en") {
        const lineEn = targetDisplayEn || targetName;
        systemContent = [
          "Short line overview for a metro side panel: readable prose, not a bullet-only fact sheet.",
          `Internal line label (may include Chinese): "${targetName}".`,
          `**Use this English wording for the corridor in prose:** "${lineEn}".`,
          "**Language — critical:** The **entire** reply must be **fluent English only**—no Chinese paragraphs.",
          "About **110–170 words**, **2–3 paragraphs**: role in the network, a bit of history or phases if you know them, why riders care. Optional short bullets only as a supplement.",
          "No filler openers or long disclaimers. Do not invent dates—omit if unsure.",
          "**Naming:** Never **Chinese + tone-marked pinyin in parentheses** for names; use the English wording above."
        ].join("\n");
        userContent = "Write the overview in English.";
      } else {
        systemContent = [
          "你是北京地铁「线路信息栏」文案作者：用**连贯短文**介绍一条线，风格接近站内展板——清楚、有信息量，但不要写成论文。",
          `线路：「${targetName}」。`,
          "**篇幅**：约 **280–420 字**，**2～4 段**为宜；可辅以极少量列表，但不要以列表代替正文。",
          "**内容**：修建或规划背景（有把握再写具体年份）、分期与功能变化、在路网中的位置、对乘客/城市生活的意义；可点到沿线若干知名片区，不必逐站罗列。",
          "**禁止**：套话、长免责声明；无把握的年份与工程细节不要编。",
          "**名称**：线路、站名勿写「中文（带调拼音）」括注，用中文叙述即可。",
          "Markdown 可用；最多一个简短 `##` 小标题。"
        ].join("\n");
        userContent = "请撰写介绍。";
      }

      try {
        const upstream = await callChatCompletion({
          endpoint,
          apiKey,
          model,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent }
          ],
          stream: true,
          max_tokens: 960
        });
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          let errMsg = `upstream HTTP ${upstream.status}`;
          try {
            const j = JSON.parse(text);
            errMsg = j.error?.message || j.message || errMsg;
          } catch {
            if (text) errMsg = text.slice(0, 300);
          }
          return sendJson(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, {
            requestId: buildRequestId(),
            error: errMsg
          });
        }
        return forwardSseResponse(upstream, res);
      } catch (err) {
        return sendJson(res, 502, {
          requestId: buildRequestId(),
          error: err instanceof Error ? err.message : "metro-intro upstream failed"
        });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/llm/route-batch") {
    readJsonBody(req, async (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "invalid json body" });
      }
      const endpoint = ensureV1(data.endpoint);
      const apiKey = data.apiKey || "";
      const queryModel = data.model || "qwen2.5-32b-instruct";
      const assistantText = String(data.assistantText || "");
      const userText = String(data.userText || "");
      const uiLang = String(data.language || "zh").toLowerCase() === "en" ? "en" : "zh";
      if (!endpoint) {
        return sendJson(res, 400, { requestId: buildRequestId(), error: "endpoint is required" });
      }

      const promptZh = [
        "你是路线查询提取器。当前用户界面为【中文】：输出里的站名必须与地铁图一致。",
        "给你【用户输入】和【助手回复】，请提取所有需要查询的起点终点对。",
        "规则：",
        "1. 若【用户输入】或定位上下文明确当前所在站，以该中文官方站名为起点；否则从【助手回复】推断合理起点（须为中文站名）。",
        "2. 若【助手回复】推荐可坐地铁前往的地点，提取为终点；仅自驾远郊、无对应地铁站名时不要强行配对。",
        "3. 即使未写「从A到B」，只要常识上需从某站到另一站，也要提取。",
        "4. 只输出多个 <query>...</query>，不要其它文字。",
        "5. **<query> 内起点、终点必须是北京地铁官方中文站名**（与路网数据一致）。**严禁**拼音、英文、首字母缩写或带空格罗马字（如 Huoying、Gulou Dajie、Shichahai、Sahe、Shahe Higher Education Park）。若助手正文用了外语/拼音，你必须先改写成正确中文站名再写入标签。",
        "6. 标签内两段分隔：优先 <query>沙河高教园|霍营</query>；若两端均无内部空格，也可用 <query>天安门东 王府井</query>。",
        "7. 不要把无同名地铁站的纯景点名当作站名；应换成最近地铁中文站名，无法判断则不要输出该条。",
        "8. 无可提取路线时返回空字符串。",
        "示例：",
        "助手用口语提到「沙河高教园」「霍营」→ <query>沙河高教园|霍营</query>",
        "助手误写英文站名时仍输出中文：→ <query>沙河高教园|鼓楼大街</query>"
      ].join("\n");

      const promptEn = [
        "你是路线查询提取器。当前用户界面为【英文】：标签内可用英文常用名或中文官方名，系统会映射到路网。",
        "给你【用户输入】和【助手回复】，请提取所有需要查询的起点终点对。",
        "规则：",
        "1. 若用户输入或上下文明确当前位置，以此为起点；否则不随意假设。",
        "2. 若助手推荐可乘地铁前往的地点，提取为终点；纯自驾远郊勿硬配对。",
        "3. 只输出多个 <query>...</query>，不要其它文字。",
        "4. 每标签内为起点与终点两段：优先 <query>起点|终点</query>（英文多词站名必须用 |），例如 <query>Shahe Higher Education Park|Xitucheng</query>；中文无空格也可 <query>天安门东 王府井</query>。",
        "5. 英文多词切勿拆成两站；不确定时用中文官方名 + |。",
        "6. 无可提取路线时返回空字符串。",
        "示例：<query>天安门东|王府井</query><query>天安门东|前门</query>"
      ].join("\n");

      const prompt = uiLang === "en" ? promptEn : promptZh;

      try {
        const upstream = await callChatCompletion({
          endpoint,
          apiKey,
          model: queryModel,
          stream: false,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: `**现在开始**\n\n用户输入:\n${userText}\n\n助手回复:\n${assistantText}` }
          ]
        });
        const raw = await upstream.text();
        let content = "";
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          content = parsed?.choices?.[0]?.message?.content || "";
        } catch (e) {
          content = "";
        }

        const pairs = extractQueryPairs(content);
        const routeItems = [];
        for (const pair of pairs) {
          const routeResult = queryRoute(pair.origin, pair.destination, { algorithm: data.algorithm || "astar" });
          console.log(
            `[route-batch] query="${pair.origin} ${pair.destination}" resolved_origin=${routeResult.origin || ""} resolved_destination=${
              routeResult.destination || ""
            } routes=${Array.isArray(routeResult.routes) ? routeResult.routes.length : 0} error=${routeResult.error || ""}`
          );
          const firstRoute = Array.isArray(routeResult.routes) ? routeResult.routes[0] : null;
          if (!firstRoute) {
            routeItems.push({
              routeId: `route_error_${pair.origin}_${pair.destination}`,
              title: `${pair.origin} -> ${pair.destination}`,
              origin: pair.origin,
              destination: pair.destination,
              duration: 0,
              color1: "#ef4444",
              label1: `查询失败：${routeResult.error || "route not found"}`,
              error: routeResult.error || "route not found",
              stations: []
            });
          } else {
            routeItems.push({
              ...firstRoute,
              title: `${pair.origin} -> ${pair.destination}`,
              origin: pair.origin,
              destination: pair.destination,
              error: routeResult.error || ""
            });
          }
        }

        return sendJson(res, 200, {
          requestId: buildRequestId(),
          queries: pairs,
          routes: routeItems
        });
      } catch (err) {
        return sendJson(res, 502, {
          requestId: buildRequestId(),
          error: err instanceof Error ? err.message : "route-batch upstream request failed"
        });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/route") {
    readJsonBody(req, (parseErr, data) => {
      if (parseErr) {
        return sendJson(res, 400, {
          requestId: buildRequestId(),
          error: "invalid json body"
        });
      }

      const routeResult = queryRoute(data.origin, data.destination, {
        algorithm: data.algorithm,
        query: data.query
      });

      console.log(
        `[route] input_origin=${data.origin || ""} input_destination=${data.destination || ""} input_query=${
          data.query || ""
        } resolved_origin=${routeResult.origin || ""} resolved_destination=${routeResult.destination || ""} algorithm=${
          data.algorithm || "astar"
        } routes=${Array.isArray(routeResult.routes) ? routeResult.routes.length : 0} error=${routeResult.error || ""}`
      );

      return sendJson(res, 200, {
        requestId: buildRequestId(),
        ...routeResult
      });
    });
    return;
  }

  sendJson(res, 404, {
    requestId: buildRequestId(),
    error: "not found"
  });
  console.log("[response] 404 not found");
});

server.listen(PORT, () => {
  console.log(`[metro-backend] listening on http://localhost:${PORT}`);
});
