/**
 * Cloudflare Worker: 黄果短剧 (全量分类 + 全集展开 + AES 封面代理 + 跨分类严格全局去重)
 */

const HOSTS = [
  "https://huangguoai.com",
  "https://a1b2.ediayikma.cc",
  "https://c3d4.ediayikma.cc"
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// AES 封面解密秘钥与向量
const AES_KEY_HEX = "66356439363564663735333336323730"; // f5d965df75336270
const AES_IV_HEX  = "39376236303339346162633266626531"; // 97b60394abc2fbe1

// 全量分类配置 (注意：排序靠前的分类优先占有剧集)
const CATEGORIES = [
  { id: "recommend", name: "精选推荐", mode: "html", path: "/recommend/" },
  { id: "newest", name: "最近上新", mode: "html", path: "/newest/" },
  { id: "ai-duanju", name: "AI成人短剧", mode: "api" },
  { id: "ai-manju", name: "AI成人漫剧", mode: "api" },
  { id: "ai-huanlian", name: "AI换脸", mode: "api" },
  { id: "ai-mogai", name: "AI魔改", mode: "api" }
];

// 控制单分类抓取的最大页数
const MAX_PAGES_PER_CAT = 6; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 路由 1: 获取 M3U 播放列表
    if (path === "/live.m3u" || path === "/playlist.m3u") {
      return handleFullM3uRequest(url);
    }

    // 路由 2: 动态解密并代理封面图片
    if (path.startsWith("/img-proxy")) {
      const imgUrl = url.searchParams.get("url");
      return handleImageProxy(imgUrl);
    }

    // 路由 3: 动态播放解析 (302)
    if (path.startsWith("/play/")) {
      const parts = path.split("/"); // /play/{vid}/{ep}
      const vid = parts[2];
      const ep = parts[3] || "1";
      return handlePlayRedirect(vid, ep);
    }

    return new Response("Not Found", { status: 404 });
  }
};

/**
 * 容灾抓取
 */
async function fetchWithFallback(path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  const promises = HOSTS.map(async (domain) => {
    try {
      const resp = await fetch(domain + path, {
        headers: { "User-Agent": UA, "Referer": domain + "/" },
        signal: controller.signal
      });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 50) return { domain, text };
      }
    } catch (e) {}
    throw new Error("Failed");
  });

  try {
    const res = await Promise.any(promises);
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    return { domain: HOSTS[0], text: "" };
  }
}

/**
 * 处理 M3U 列表生成 (实现跨分类全局严格去重)
 */
async function handleFullM3uRequest(url) {
  let m3uContent = "#EXTM3U\n";
  const host = url.origin;

  // 1. 严格按照 CATEGORIES 数组的顺序抓取数据
  const rawCategoryResults = [];
  for (const cat of CATEGORIES) {
    const catItems = [];
    for (let page = 1; page <= MAX_PAGES_PER_CAT; page++) {
      const pageItems = await fetchCategoryItems(cat, page);
      if (!pageItems || pageItems.length === 0) break;
      catItems.push(...pageItems);
    }
    rawCategoryResults.push({ groupName: cat.name, items: catItems });
  }

  // 2. 跨分类全局排重集合：确保任何剧集 ID 在所有分组中只出现一次
  const globalSeen = new Set();

  // 3. 过滤重复项并生成 M3U 文本
  for (const catRes of rawCategoryResults) {
    const { groupName, items } = catRes;

    for (const item of items) {
      // 全局判断：如果该剧集已经在之前的分类（如精选/上新）中出现过，直接跳过
      if (globalSeen.has(item.id)) continue;
      globalSeen.add(item.id);

      const totalEp = item.episodeCount || 10;
      const logoUrl = item.pic ? `${host}/img-proxy?url=${encodeURIComponent(item.pic)}` : "";

      // 平铺展开每一集
      for (let ep = 1; ep <= totalEp; ep++) {
        const epTitle = `${item.title} - 第${ep}集`;
        const playUrl = `${host}/play/${item.id}/${ep}`;

        m3uContent += `#EXTINF:-1 tvg-logo="${logoUrl}" group-title="${groupName}",${epTitle}\n`;
        m3uContent += `${playUrl}\n`;
      }
    }
  }

  return new Response(m3uContent, {
    headers: {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * 抓取单页分类数据
 */
async function fetchCategoryItems(cat, page) {
  const items = [];
  if (cat.mode === "api") {
    const apiPath = `/api/videos/category/${cat.id}?sort=hot&page=${page}&size=24`;
    const { text } = await fetchWithFallback(apiPath);
    try {
      const json = JSON.parse(text);
      const list = json?.data?.items || [];
      for (const it of list) {
        if (it.id && it.title) {
          items.push({
            id: String(it.id),
            title: it.title,
            pic: it.cover || "",
            episodeCount: it.episode_count || 10
          });
        }
      }
    } catch (e) {}
  } else {
    const htmlPath = `${cat.path}${page}/`;
    const { text } = await fetchWithFallback(htmlPath);
    items.push(...parseDramaListHtml(text));
  }

  return items;
}

/**
 * 处理 AES 图片实时解密代理
 */
async function handleImageProxy(imgUrl) {
  if (!imgUrl || !imgUrl.startsWith("http")) {
    return new Response("Invalid Url", { status: 400 });
  }

  try {
    const resp = await fetch(imgUrl, {
      headers: { "User-Agent": UA, "Referer": HOSTS[0] + "/" }
    });

    if (!resp.ok) return new Response("Fetch Error", { status: 500 });

    const rawBuffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(rawBuffer);

    // 判断是否已经是原图
    if (isNormalImage(bytes)) {
      return new Response(rawBuffer, {
        headers: { "Content-Type": detectMime(bytes), "Cache-Control": "max-age=86400" }
      });
    }

    // Web Crypto API 进行 AES-CBC 解密
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(AES_KEY_HEX), { name: "AES-CBC" }, false, ["decrypt"]
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: hexToBytes(AES_IV_HEX) }, key, rawBuffer
    );

    const decBytes = new Uint8Array(decrypted);
    return new Response(decBytes, {
      headers: { "Content-Type": detectMime(decBytes), "Cache-Control": "max-age=86400" }
    });
  } catch (e) {
    return new Response("Decrypt Error", { status: 500 });
  }
}

/**
 * 播放重定向 (302)
 */
async function handlePlayRedirect(vid, ep) {
  try {
    const epPath = `/video/${vid}/ep-${ep}/`;
    let { domain, text } = await fetchWithFallback(epPath);

    if (!text || !text.includes("m3u8")) {
      const mainRes = await fetchWithFallback(`/video/${vid}/`);
      text = mainRes.text;
      domain = mainRes.domain;
    }

    let playUrl = extractVideoUrl(text);
    if (!playUrl) playUrl = `${domain}/video/${vid}/`;

    return Response.redirect(playUrl, 302);
  } catch (err) {
    return Response.redirect("https://vjs.zencdn.net/v/oceans.mp4", 302);
  }
}

// 辅助解析与格式化工具函数
function parseDramaListHtml(html) {
  if (!html) return [];
  const list = [];
  const seen = new Set();
  const blocks = html.split('<div class="hg-drama-card"');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const vidMatch = block.match(/href="\/detail\/(\d+)\/"/);
    if (!vidMatch) continue;
    const vid = vidMatch[1];
    if (seen.has(vid)) continue;
    seen.add(vid);

    let pic = "";
    const picMatch = block.match(/data-src="([^"]+)"/) || block.match(/src="([^"]+)"/);
    if (picMatch) pic = picMatch[1];

    let title = "";
    const titleMatch = block.match(/class="[^"]*hg-drama-card__title[^"]*"[^>]*>\s*<a[^>]*>(.*?)<\/a>/s) ||
                       block.match(/alt="([^"]+)"/);
    if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

    let epCount = 10;
    const epMatch = block.match(/(?:全|更新至)(\d+)集/);
    if (epMatch) epCount = parseInt(epMatch[1]);

    if (vid && title) list.push({ id: String(vid), title, pic, episodeCount: epCount });
  }
  return list;
}

function extractVideoUrl(html) {
  if (!html) return "";
  const jsonMatch = html.match(/<script id="videoInitialData" type="application\/json">(.*?)<\/script>/s);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      return cleanUrl(data.videoSrc || data.videoUrl || data.playUrl || data.src || data.url || "");
    } catch (e) {}
  }
  const m3u8Match = html.match(/data-play-src="(https?:\/\/[^"]+\.m3u8[^"]*)"/) || 
                    html.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
  return m3u8Match ? cleanUrl(m3u8Match[1]) : "";
}

function cleanUrl(u) {
  return u.replace(/\\u0026/g, "&").replace(/&amp;/g, "&").trim();
}

function isNormalImage(b) {
  return (b[0] === 0xff && b[1] === 0xd8) || 
         (b[0] === 0x89 && b[1] === 0x50) || 
         (b[0] === 0x47 && b[1] === 0x49);
}

function detectMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "image/jpeg";
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
