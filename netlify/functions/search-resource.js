const VCSOSO_ORIGIN = "https://vcsoso.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NETDISK_RE =
  /https?:\/\/(?:[^\s"'<>]*\.)?(?:pan\.baidu\.com|aliyundrive\.com|alipan\.com|quark\.cn|drive\.uc\.cn|123pan\.com|lanzou[a-z0-9.-]*|xunlei[a-z0-9.-]*|cloud\.189\.cn|pan\.xunlei\.com)[^\s"'<>]*/gi;

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return json({ ok: false, error: "只支持 GET 请求" }, 405);
  }

  const q = String(event.queryStringParameters?.q || "").trim();

  if (!q) {
    return json({ ok: false, error: "缺少搜索关键词" }, 400);
  }

  try {
    const results = await searchVcsoso(q);

    return json({
      ok: true,
      query: q,
      results,
    });
  } catch (error) {
    return json({ ok: false, error: "搜索接口暂时不可用" }, 502);
  }
};

async function searchVcsoso(query) {
  const searchPageUrl = `${VCSOSO_ORIGIN}/s/${encodeURIComponent(query)}.html`;

  const pageRes = await fetch(searchPageUrl, {
    headers: getVcsosoHeaders(`${VCSOSO_ORIGIN}/`),
  });

  if (!pageRes.ok) throw new Error("search page failed");

  const pageContentType = pageRes.headers.get("content-type") || "";
  const pageText = await pageRes.text();

  if (pageContentType.includes("application/json")) {
    return normalizeResults(JSON.parse(pageText), query);
  }

  const token = extractSearchToken(pageText);

  if (!token) {
    return parseHtmlResults(pageText, query);
  }

  const sseUrl = `${VCSOSO_ORIGIN}/api/other/web_search?${new URLSearchParams({
    title: query,
    is_type: "0",
    _t: token,
  }).toString()}`;

  const sseRes = await fetch(sseUrl, {
    headers: {
      ...getVcsosoHeaders(searchPageUrl),
      Accept: "text/event-stream, application/json, text/plain, */*",
    },
  });

  if (!sseRes.ok) throw new Error("search stream failed");

  const sseContentType = sseRes.headers.get("content-type") || "";
  const sseText = await sseRes.text();

  if (sseContentType.includes("application/json")) {
    return normalizeResults(JSON.parse(sseText), query);
  }

  const items = parseSseItems(sseText, token);
  const results = [];

  for (const item of items) {
    const title = cleanText(item.title || item.name || query);
    let rawUrl = String(item.url || item.link || item.showUrl || "").trim();

    if (!rawUrl) continue;

    rawUrl = decodeBasic(rawUrl);

    let finalUrl = extractNetdiskUrl(rawUrl);

    if (!finalUrl && !/^https?:\/\//i.test(rawUrl)) {
      const resolved = await resolveVcsosoUrl(rawUrl, title, searchPageUrl);
      finalUrl = extractNetdiskUrl(resolved);
    }

    if (!finalUrl) continue;

    results.push({
      title: title || query,
      url: finalUrl,
      status: item.status || "unknown",
    });
  }

  const normalized = dedupeResults(results);
  if (normalized.length > 0) return normalized;

  return parseHtmlResults(pageText, query);
}

function getVcsosoHeaders(referer) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Referer: referer,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/plain,*/*;q=0.8",
  };
}

function extractSearchToken(html) {
  return html.match(/var\s+_st\s*=\s*["']([^"']+)["']/)?.[1] || "";
}

function parseSseItems(sseText, token) {
  const items = [];

  for (const line of sseText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload.includes("[DONE]")) continue;

    try {
      const decrypted = decryptPayload(payload, token);
      const data = JSON.parse(decrypted);

      if (Array.isArray(data)) {
        items.push(...data);
      } else if (data && typeof data === "object") {
        items.push(data);
      }
    } catch {
      // Ignore malformed chunks.
    }
  }

  return items;
}

function decryptPayload(encoded, token) {
  const raw = Buffer.from(encoded, "base64");
  const key = [];

  for (let i = 0; i < token.length; i += 2) {
    key.push(parseInt(token.slice(i, i + 2), 16));
  }

  const bytes = Buffer.alloc(raw.length);

  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw[i] ^ key[i % key.length];
  }

  return new TextDecoder("utf-8").decode(bytes);
}

async function resolveVcsosoUrl(rawUrl, title, referer) {
  try {
    const res = await fetch(`${VCSOSO_ORIGIN}/api/other/save_url`, {
      method: "POST",
      headers: {
        ...getVcsosoHeaders(referer),
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: encodeURIComponent(rawUrl),
        title,
      }),
    });

    if (!res.ok) return "";

    const data = await res.json();
    return data?.data?.url || data?.url || "";
  } catch {
    return "";
  }
}

function normalizeResults(data, query) {
  const source = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.data)
        ? data.data
        : [];

  const results = [];

  for (const item of source) {
    const title = cleanText(item.title || item.name || query);
    const rawUrl = decodeBasic(item.url || item.link || item.showUrl || "");
    const url = extractNetdiskUrl(rawUrl);

    if (!url) continue;

    results.push({
      title: title || query,
      url,
      status: item.status || "unknown",
    });
  }

  return dedupeResults(results);
}

function parseHtmlResults(html, query) {
  const decodedHtml = decodeBasic(html);
  const results = [];

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(decodedHtml))) {
    const href = decodeBasic(match[1]);
    const text = cleanText(match[2]);
    const url = extractNetdiskUrl(href);

    if (!url) continue;

    results.push({
      title: text || query,
      url,
      status: "unknown",
    });
  }

  const rawUrls = decodedHtml.match(NETDISK_RE) || [];

  for (const rawUrl of rawUrls) {
    const url = extractNetdiskUrl(rawUrl);
    if (!url) continue;

    results.push({
      title: query,
      url,
      status: "unknown",
    });
  }

  return dedupeResults(results);
}

function extractNetdiskUrl(value) {
  const text = decodeBasic(value);
  const matches = text.match(NETDISK_RE);
  if (!matches || matches.length === 0) return "";
  return trimUrl(matches[0]);
}

function dedupeResults(results) {
  const seen = new Set();
  const output = [];

  for (const item of results) {
    const url = trimUrl(item.url);
    const key = normalizeUrl(url);

    if (!url || seen.has(key)) continue;

    seen.add(key);
    output.push({
      title: item.title || "资源",
      url,
      status: item.status || "unknown",
    });

    if (output.length >= 10) break;
  }

  return output;
}

function decodeBasic(value) {
  let text = String(value || "");

  text = text
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep original text if it is not valid percent-encoding.
  }

  return text;
}

function cleanText(text) {
  return decodeBasic(text)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimUrl(url) {
  return String(url || "").replace(/[)\]}>，。；;、]+$/g, "");
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(data),
  };
}
