/**
 * GPS Proxy Server
 *
 * 解決 Web 端 CORS 問題：瀏覽器不能直接請求 console.onefleet.hk
 * 這個 proxy 服務器在 localhost:3001 上運行，轉發請求到 808GPS API
 *
 * 啟動方式：node server/gpsProxy.js
 *
 * 特性：
 * - 自動保存 JSESSION 到本地文件
 * - 後續請求自動附加 JSESSION cookie
 * - 支持 x-gps-jsession header（從 localStorage 讀取的 session）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cryptoUtil = require('./sessionCrypto');

const GPS_SERVER = 'console.onefleet.hk';
const PORT = process.env.PORT || 3001;

// 持久化存儲 JSESSION
let sessionData = {
  jsessionCookie: null,
  lastLogin: null,
};

// 載入保存的 session（加密版優先，向下相容明文）
function loadSession() {
  const loaded = cryptoUtil.decryptSession();
  if (loaded) {
    sessionData = loaded;
    console.log(`[Proxy] 載入保存的 session (${cryptoUtil.getMode()}): ${sessionData.jsessionCookie?.substring(0, 16) ?? 'none'}...`);
  } else if (cryptoUtil.getMode() === 'encrypted') {
    console.log('[Proxy] 加密 session 未載入（檢查 GPS_SESSION_KEY 是否設定）');
  }
}

// 保存 session：若有 master key 走加密路徑，否則明文（開發模式）
function saveSession() {
  try {
    const result = cryptoUtil.encryptSession(sessionData);
    if (result.mode === 'encrypted') {
      console.log(`[Proxy] Session 已加密保存（session.json.enc）`);
    } else {
      console.log(`[Proxy] Session 已保存（明文 session.json — 無 GPS_SESSION_KEY）`);
    }
  } catch (err) {
    console.log('[Proxy] 無法保存 session:', err.message);
  }
}

// 初始化時載入 session
loadSession();

// 影音 API 端點白名單（這些返回 HTML，需要注入 session cookie）
const VIDEO_ENDPOINT_SUFFIXES = [
  'getVideoUrl.action',
  'getLiveMediaUrl.action',
  'capturePicture.action',
  'getVideoById.action',
];

// 內部專用端點（代理服務器自己處理，不是轉發到 808GPS）
const PROXY_INTERNAL_ENDPOINTS = [
  '/api/gps/video-url',
];

function isVideoEndpoint(path) {
  const filename = path.split('/').pop().split('?')[0];
  return VIDEO_ENDPOINT_SUFFIXES.some(s => filename.endsWith(s));
}

function isProxyInternalEndpoint(path) {
  return PROXY_INTERNAL_ENDPOINTS.some(s => path.startsWith(s));
}

// 注入 JSESSIONID cookie 到 HTML，讓瀏覽器自動附帶在後續請求中
// 原理：proxy 轉發 HTML 時同時 Set-Cookie，瀏覽器保存後，HTML 內的所有
// script/link 請求（指向 console.onefleet.hk 的相對路徑）會自動附帶 cookie
function injectSessionCookie(html, jsessionId) {
  if (!html || !jsessionId || !html.includes('</head>')) return html;
  const cookieScript = `<script>document.cookie='JSESSIONID=${jsessionId}; path=/; SameSite=None; Secure';</script>`;
  return html.replace('</head>', `${cookieScript}</head>`);
}

function proxyRequest(req, res, reqPath, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: GPS_SERVER,
      port: 443,
      path: reqPath,
      method: method,
      headers: {
        'Host': GPS_SERVER,
        'User-Agent': 'FleetPro/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        ...extraHeaders,
      },
    };

    // 優先順序：x-gps-jsession header > jsessionId query param > 保存的 session
    const clientJsession = req.headers['x-gps-jsession'];
    const queryJsession = req.url ? new URL(req.url, `http://localhost:${PORT}`).searchParams.get('jsessionId') : null;
    if (clientJsession) {
      options.headers['Cookie'] = `JSESSIONID=${clientJsession}`;
      console.log(`[Proxy] 使用客戶端 session (header): ${clientJsession.substring(0, 16)}...`);
    } else if (queryJsession) {
      options.headers['Cookie'] = `JSESSIONID=${queryJsession}`;
      console.log(`[Proxy] 使用客戶端 session (query): ${queryJsession.substring(0, 16)}...`);
    } else if (sessionData.jsessionCookie) {
      options.headers['Cookie'] = `JSESSIONID=${sessionData.jsessionCookie}`;
      console.log(`[Proxy] 使用保存的 session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
    } else {
      console.log(`[Proxy] 無 session，匿名請求`);
    }

    const proxyReq = https.request(options, (proxyRes) => {
      // 提取並保存 Set-Cookie header
      const setCookie = proxyRes.headers['set-cookie'];
      if (setCookie) {
        for (const cookie of setCookie) {
          const match = cookie.match(/JSESSIONID=([^;]+)/);
          if (match) {
            sessionData.jsessionCookie = match[1];
            sessionData.lastLogin = new Date().toISOString();
            console.log(`[Proxy] 新 session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
            saveSession();
          }
        }
      }

      // 影音端點（HTML）：推遲 writeHead，等注入 cookie 完成後再發送
      if (isVideoEndpoint(reqPath)) {
        let data = '';
        proxyRes.on('data', chunk => { data += chunk; });
        proxyRes.on('end', () => {
          console.log(`[VideoProxy] ${method} ${reqPath} -> ${proxyRes.statusCode}`);
          if (proxyRes.statusCode !== 200) {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/html' });
            res.end(data);
            return;
          }
          const jsessionId = sessionData.jsessionCookie || '';
          const injectedData = injectSessionCookie(data, jsessionId);

          const origin = req.headers['origin'];
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Credentials': 'true',
            'Set-Cookie': `JSESSIONID=${jsessionId}; Path=/; SameSite=None`,
            'Access-Control-Expose-Headers': 'Set-Cookie',
          });
          console.log(`[VideoProxy] 注入 session cookie 到 HTML`);
          res.end(injectedData);
        });
        return;
      }

      // 處理 CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gps-jsession');
      res.setHeader('Access-Control-Expose-Headers', 'Set-Cookie, x-session-status, x-proxy-debug');

      if (sessionData.jsessionCookie) {
        res.setHeader('x-session-status', 'active');
      }

      // 記錄所有 API 響應的關鍵資訊
      const isDebugPath = reqPath.includes('getDeviceStatus') ||
                          reqPath.includes('queryVehicleList') ||
                          reqPath.includes('findVehicleInfoByDeviceId') ||
                          reqPath.includes('login.action');
      if (isDebugPath) {
        console.log(`[Proxy Debug] ${method} ${reqPath}`);
      }

      // 處理 OPTIONS 預檢請求
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        resolve();
        return;
      }

      // 轉發狀態碼和 headers
      const responseHeaders = { ...proxyRes.headers };
      res.writeHead(proxyRes.statusCode, responseHeaders);

      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`[Proxy] ${method} ${reqPath} -> ${proxyRes.statusCode}`);

        // 如果是登入請求且成功（result === 0），返回 session info
        if (reqPath.includes('login.action') && proxyRes.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            if (json.result === 0 && sessionData.jsessionCookie) {
              json._proxySession = sessionData.jsessionCookie;
              json._sessionInfo = {
                lastLogin: sessionData.lastLogin,
                server: GPS_SERVER
              };
              console.log(`[Proxy] 登入成功，返回 session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
            } else {
              console.log(`[Proxy] 登入失敗 (result=${json.result})，清除舊 session`);
              sessionData.jsessionCookie = null;
              sessionData.lastLogin = null;
              saveSession();
            }
            res.end(JSON.stringify(json));
            return;
          } catch (e) {
            // JSON 解析失敗，返回原始數據
          }
        }

        res.end(data);
        resolve({ status: proxyRes.statusCode, data, headers: proxyRes.headers });
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy] 請求錯誤: ${err.message}`);
      reject(err);
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const searchParams = url.searchParams.toString();
  const fullPath = searchParams ? `${pathname}?${searchParams}` : pathname;

  console.log(`[Proxy] 收到請求: ${req.method} ${fullPath}`);

  // Railway 健康檢查端點
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'fleetpro-gps-proxy' }));
    return;
  }

  // 處理 /api/gps/video-url 端點（代理服務器自己處理影像 URL 解析）
  if (pathname === '/api/gps/video-url') {
    await handleVideoUrlRequest(req, res, url);
    return;
  }

  // 處理 /api/gps/hls/* 端點（代理 HLS 串流以解決 CORS 問題）
  if (pathname.startsWith('/api/gps/hls/')) {
    await handleHlsStreamProxy(req, res, pathname, url);
    return;
  }

  // 處理 /api/gps/flv-stream 端點（代理 FLV/HTTP-FLV 串流）
  if (pathname === '/api/gps/flv-stream') {
    await handleFlvStreamProxy(req, res, url);
    return;
  }

  // 只處理 /api/gps 路徑
  if (!pathname.startsWith('/api/gps')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. 請使用 /api/gps 前綴。' }));
    return;
  }

  // 移除 /api/gps 前綴，獲取實際的 API 路徑（包含 query string）
  const apiPath = searchParams
    ? `${pathname.replace('/api/gps', '')}?${searchParams}`
    : pathname.replace('/api/gps', '');
  if (!apiPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '請指定 API 路徑，例如 /api/gps/Login/login.action' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });

  req.on('end', async () => {
    try {
      await proxyRequest(
        req, res,
        apiPath,
        req.method,
        body,
        { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' }
      );
    } catch (err) {
      console.error(`[Proxy] 錯誤: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, result: -1 }));
      }
    }
  });
}

// 處理 /api/gps/video-url 請求
// 根據 808GPS 官方文檔，直接構建標準影像 URL（繞過 getVideoUrl.action API）
async function handleVideoUrlRequest(req, res, url) {
  const devIdno = url.searchParams.get('devIdno');
  const channel = url.searchParams.get('channel') || '0';
  const stream = url.searchParams.get('stream') || '0';
  const type = url.searchParams.get('type') || '1';
  const ip = url.searchParams.get('ip');
  const port = url.searchParams.get('port');
  const jsessionId = url.searchParams.get('jsessionId');

  if (!devIdno) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: -1, error: '缺少 devIdno 參數' }));
    return;
  }

  // 使用最新的 session
  const sessionToUse = jsessionId || sessionData.jsessionCookie;

  console.log(`[VideoUrl] 構建影像 URL: devIdno=${devIdno}, channel=${channel}, stream=${stream}`);

  // 根據 808GPS 官方文檔（Web Interface Documentation）：
  // HLS URL: http://console.onefleet.hk:6604/hls/1_{devIdno}_{channel}_{stream}.m3u8?jsession={jsession}
  // FLV URL: http://console.onefleet.hk:6604/3/3?AVType=1&jsession=...&DevIDNO=...&Channel=...&Stream=...
  // RTSP URL: rtsp://console.onefleet.hk:6604/3/3?...

  // 透過代理服務器返回 URL（前端從相對路徑讀取，避免 CORS）
  const hlsProxyUrl = `/api/gps/hls/1_${devIdno}_${channel}_${stream}.m3u8`;
  const flvProxyUrl = `/api/gps/flv-stream?DevIDNO=${devIdno}&Channel=${channel}&Stream=${stream}`;

  const hlsUrl = sessionToUse
    ? `http://${GPS_SERVER}:6604/hls/1_${devIdno}_${channel}_${stream}.m3u8?jsession=${sessionToUse}`
    : `http://${GPS_SERVER}:6604/hls/1_${devIdno}_${channel}_${stream}.m3u8`;
  const flvUrl = sessionToUse
    ? `http://${GPS_SERVER}:6604/3/3?AVType=1&jsession=${sessionToUse}&DevIDNO=${devIdno}&Channel=${channel}&Stream=${stream}`
    : `http://${GPS_SERVER}:6604/3/3?AVType=1&DevIDNO=${devIdno}&Channel=${channel}&Stream=${stream}`;

  // 直接返回構建好的 URL（無需再請求 808GPS，因為 getVideoUrl.action API 已停用）
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    result: 0,
    videoUrl: hlsProxyUrl,  // 預設 HLS 透過代理
    flvUrl: flvProxyUrl,    // FLV 透過代理
    hlsUrl: hlsProxyUrl,
    // 也返回原始 URL（供原生端使用）
    rawHlsUrl: hlsUrl,
    rawFlvUrl: flvUrl,
    ip: 'console.onefleet.hk',
    port: '6604',
    type,
    channel,
    stream,
    devIdno,
  }));
}

// 處理 /api/gps/hls/* 代理請求
// 代理 HLS 串流（m3u8 播放列表和 ts 切片）以解決瀏覽器 CORS 問題
async function handleHlsStreamProxy(req, res, pathname, url) {
  // 從路徑中提取 HLS 路徑：/api/gps/hls/1_xxx_0_0.m3u8 → /hls/1_xxx_0_0.m3u8
  const hlsPath = pathname.replace('/api/gps', '');

  console.log(`[HLS Proxy] ${req.method} ${hlsPath}`);

  const options = {
    hostname: GPS_SERVER,
    port: 6604,
    path: `${hlsPath}${url.search}`,
    method: req.method,
    headers: {
      'Host': `${GPS_SERVER}:6604`,
      'User-Agent': 'FleetPro/1.0',
      'Accept': '*/*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  };

  // 如果前端有 session，附加進去
  const sessionToUse = url.searchParams.get('jsession') || sessionData.jsessionCookie;
  if (sessionToUse) {
    options.headers['Cookie'] = `JSESSIONID=${sessionToUse}`;
  }

  try {
    const proxyReq = http.request(options, (proxyRes) => {
      // 處理 CORS：允許所有來源
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      // 轉發狀態碼
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/vnd.apple.mpegurl',
        'Cache-Control': proxyRes.headers['cache-control'] || 'no-cache',
      });

      // 串流轉發
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[HLS Proxy] 錯誤: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    console.error(`[HLS Proxy] 異常: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

// 處理 /api/gps/flv-stream 代理請求
async function handleFlvStreamProxy(req, res, url) {
  const devIdno = url.searchParams.get('DevIDNO');
  const channel = url.searchParams.get('Channel') || '0';
  const stream = url.searchParams.get('Stream') || '0';
  const jsession = url.searchParams.get('jsession') || sessionData.jsessionCookie;

  if (!devIdno) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '缺少 DevIDNO 參數' }));
    return;
  }

  // FLV URL 格式
  const flvPath = jsession
    ? `/3/3?AVType=1&jsession=${jsession}&DevIDNO=${devIdno}&Channel=${channel}&Stream=${stream}`
    : `/3/3?AVType=1&DevIDNO=${devIdno}&Channel=${channel}&Stream=${stream}`;

  console.log(`[FLV Proxy] ${req.method} ${flvPath}`);

  const options = {
    hostname: GPS_SERVER,
    port: 6604,
    path: flvPath,
    method: req.method,
    headers: {
      'Host': `${GPS_SERVER}:6604`,
      'User-Agent': 'FleetPro/1.0',
      'Accept': '*/*',
    },
  };

  if (jsession) {
    options.headers['Cookie'] = `JSESSIONID=${jsession}`;
  }

  try {
    const proxyReq = http.request(options, (proxyRes) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'video/x-flv',
        'Cache-Control': 'no-cache',
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[FLV Proxy] 錯誤: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    req.pipe(proxyReq);
  } catch (err) {
    console.error(`[FLV Proxy] 異常: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

// 創建 HTTP 服務器
const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   GPS Proxy Server 已啟動                                ║
║   監聽端口: ${PORT}                                       ║
║   代理目標: https://${GPS_SERVER}                         ║
║                                                          ║
║   功能:                                                  ║
║   ✓ 自動保存 JSESSION 到 session.json                   ║
║   ✓ 後續請求自動附加 session cookie                      ║
║   ✓ 支持 x-gps-jsession header                          ║
║   ✓ 可選 AES-256-GCM session 加密（GPS_SESSION_KEY）    ║
║   ✓ 影像 URL 端點: /api/gps/video-url                   ║
║                                                          ║
║   健康檢查: http://localhost:${PORT}/health               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被佔用！請先關閉其他使用該端口的程式。`);
    process.exit(1);
  }
  throw err;
});
