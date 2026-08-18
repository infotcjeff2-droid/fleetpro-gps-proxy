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
// Render / Heroku / Vercel 會注入 PORT；本機預設 3001
const PORT = process.env.PORT || 3001;

// 管理員登入配置（用於影像功能）
const ADMIN_ACCOUNT = process.env.GPS_ADMIN_ACCOUNT || 'admin';
const ADMIN_PASSWORD_MD5 = process.env.GPS_ADMIN_PASSWORD_MD5 || '4FF4C011268967DF32B6253CA0E7BDF0'; // MD5 of (hi2F/&}G2b9

// 持久化存儲 JSESSION
let sessionData = {
  jsessionCookie: null,
  lastLogin: null,
  isAdminSession: false,
};

// Admin session 快取（避免每次 FLV 請求都重新登入）
let cachedAdminSession = null;
let cachedAdminSessionTime = 0;
const ADMIN_SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 分鐘快取

// 載入保存的 session（加密版優先，向下相容明文）
function loadSession() {
  const loaded = cryptoUtil.decryptSession();
  if (loaded) {
    sessionData = loaded;
    console.log(`[Proxy] Session loaded (${cryptoUtil.getMode()}): ${sessionData.jsessionCookie?.substring(0, 16) ?? 'none'}...`);
  } else if (cryptoUtil.getMode() === 'encrypted') {
    console.log('[Proxy] Encrypted session not loaded (check GPS_SESSION_KEY)');
    // 無法解密加密的 session，嘗試刪除並降級到明文 session
    const crypto = require('crypto');
    const encFile = path.join(__dirname, 'session.json.enc');
    if (fs.existsSync(encFile)) {
      try {
        fs.unlinkSync(encFile);
        console.log('[Proxy] Deleted corrupted encrypted session file, will use plaintext session');
      } catch (e) {
        console.log('[Proxy] Failed to delete encrypted session file:', e.message);
      }
    }
    // 嘗試載入明文 session
    const plainFile = path.join(__dirname, 'session.json');
    if (fs.existsSync(plainFile)) {
      try {
        const plainData = JSON.parse(fs.readFileSync(plainFile, 'utf-8'));
        if (plainData && plainData.jsessionCookie) {
          sessionData = plainData;
          console.log(`[Proxy] Fallback to plaintext session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
        }
      } catch (e) {
        console.log('[Proxy] Failed to load plaintext session:', e.message);
      }
    }
  } else {
    console.log('[Proxy] No saved session');
  }
}

// 保存 session
function saveSession() {
  try {
    const result = cryptoUtil.encryptSession(sessionData);
    if (result.mode === 'encrypted') {
      console.log('[Proxy] Session encrypted and saved');
    } else {
      console.log('[Proxy] Session saved (plaintext - no GPS_SESSION_KEY)');
    }
  } catch (err) {
    console.log('[Proxy] Failed to save session:', err.message);
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

// 驗證 session 是否有效（檢查影像 API 權限）
async function validateSession() {
  if (!sessionData.jsessionCookie) return false;
  
  try {
    const result = await proxyRequest(null, {}, '/StandardApiAction_getVideoDevice.action?devIdno=018270193745', 'GET', null, {
      'Cookie': `JSESSIONID=${sessionData.jsessionCookie}`
    });
    
    if (result && result.data) {
      const json = JSON.parse(result.data);
      // result=0 表示有權限，result=8 表示無權限
      return json.result === 0;
    }
  } catch (e) {
    console.log('[Proxy] Session validation failed:', e.message);
  }
  return false;
}

// 管理員登入（用於影像功能）
async function adminLogin() {
  return new Promise((resolve, reject) => {
    const postData = `account=${ADMIN_ACCOUNT}&password=${ADMIN_PASSWORD_MD5}`;
    
    const options = {
      hostname: GPS_SERVER,
      port: 443,
      path: '/StandardApiAction_login.action',
      method: 'POST',
      headers: {
        'Host': GPS_SERVER,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.result === 0 && json.jsession) {
            console.log('[Proxy] Admin login success:', json.jsession.substring(0, 16) + '...');
            sessionData.jsessionCookie = json.jsession;
            sessionData.lastLogin = new Date().toISOString();
            sessionData.isAdminSession = true;
            saveSession();
            resolve(json.jsession);
          } else {
            console.log('[Proxy] Admin login failed:', json.message);
            resolve(null);
          }
        } catch (e) {
          console.log('[Proxy] Admin login parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.log('[Proxy] Admin login error:', e.message);
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

// 確保有有效的 session（使用快取的 admin session 來獲取影像權限）
async function ensureValidSession() {
  // 檢查快取的 admin session 是否還有效
  const now = Date.now();
  if (cachedAdminSession && (now - cachedAdminSessionTime) < ADMIN_SESSION_CACHE_TTL) {
    console.log('[Proxy] Using cached admin session');
    return cachedAdminSession;
  }
  
  // 快取過期或不存在，重新登入
  console.log('[Proxy] Admin session cache miss, logging in...');
  const adminSession = await adminLogin();
  if (adminSession) {
    cachedAdminSession = adminSession;
    cachedAdminSessionTime = now;
    console.log('[Proxy] Admin session cached');
    return adminSession;
  }
  
  // 如果 admin 登入失敗，嘗試使用現有 session
  if (sessionData.jsessionCookie) {
    console.log('[Proxy] Admin login failed, trying existing session...');
    const isValid = await validateSession();
    if (isValid) {
      return sessionData.jsessionCookie;
    }
  }
  
  console.log('[Proxy] No valid session available');
  return null;
}

function proxyRequest(req, res, path, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: GPS_SERVER,
      port: 443,
      path: path,
      method: method,
      headers: {
        'Host': GPS_SERVER,
        'User-Agent': 'FleetPro/1.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Origin': 'http://localhost:8081',
        ...extraHeaders,
      },
    };

    // 優先使用請求中的 x-gps-jsession header 或 query string 中的 jsessionId
    const queryJsessionId = (() => {
      try {
        const url = new URL(req?.url || `http://localhost:${PORT}`, `http://localhost:${PORT}`);
        return url.searchParams.get('jsessionId') || url.searchParams.get('JSESSIONID') || '';
      } catch {
        return '';
      }
    })();

    const clientJsession = (req?.headers?.['x-gps-jsession']) || queryJsessionId;
    if (clientJsession) {
      options.headers['Cookie'] = `JSESSIONID=${clientJsession}`;
      console.log(`[Proxy] Using client session: ${clientJsession.substring(0, 16)}...`);
    } else if (sessionData.jsessionCookie) {
      options.headers['Cookie'] = `JSESSIONID=${sessionData.jsessionCookie}`;
      console.log(`[Proxy] Using saved session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
    } else {
      console.log(`[Proxy] No session, anonymous request`);
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
            console.log(`[Proxy] New session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
            saveSession();
          }
        }
      }

      // 影音端點（HTML）：推遲 writeHead，等注入 cookie 完成後再發送
      const reqPath = path;
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

          const origin = req?.headers?.origin;
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

      // 調試路徑
      const isDebugPath = path.includes('getDeviceStatus') ||
                          path.includes('queryVehicleList') ||
                          path.includes('findVehicleInfoByDeviceId') ||
                          path.includes('login.action');
      if (isDebugPath) {
        console.log(`[Proxy Debug] ${method} ${path}`);
      }

      // 處理 OPTIONS 預檢請求
      if (req?.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        resolve();
        return;
      }

      // 轉發狀態碼和 headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`[Proxy] ${method} ${path} -> ${proxyRes.statusCode}`);
        
        if (isDebugPath) {
          try {
            const jsonData = JSON.parse(data);
            console.log(`[Proxy Raw] ${path}:`, JSON.stringify(jsonData, null, 2).substring(0, 2000));
          } catch {
            console.log(`[Proxy Raw] ${path}:`, data.substring(0, 500));
          }
        }

        // 登入請求處理
        if (path.includes('login.action') && proxyRes.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            if (json.result === 0 && sessionData.jsessionCookie) {
              json._proxySession = sessionData.jsessionCookie;
              json._sessionInfo = {
                lastLogin: sessionData.lastLogin,
                server: GPS_SERVER
              };
              console.log(`[Proxy] Login success, session: ${sessionData.jsessionCookie.substring(0, 16)}...`);
            } else {
              console.log(`[Proxy] Login failed (result=${json.result}), clearing session`);
              sessionData.jsessionCookie = null;
              sessionData.lastLogin = null;
              saveSession();
            }
            res.end(JSON.stringify(json));
            return;
          } catch (e) {
            // JSON 解析失敗
          }
        }
        
        res.end(data);
        resolve({ status: proxyRes.statusCode, data, headers: proxyRes.headers });
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy] Request error: ${err.message}`);
      reject(err);
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

/**
 * 從請求推算 proxy 的對外 base URL（用於重寫 HLS 子分段 URL）
 * 優先順序：X-Forwarded-* header → Host header → localhost
 */
function getProxyBaseFromReq(req) {
  const forwardedProto = req?.headers?.['x-forwarded-proto'];
  const forwardedHost = req?.headers?.['x-forwarded-host'];
  const host = forwardedHost || req?.headers?.host || `localhost:${PORT}`;
  const proto = forwardedProto || 'http';
  return `${proto}://${host}`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:3001`);
  const pathname = url.pathname;
  const searchParams = url.searchParams; // URLSearchParams object

  console.log(`[Proxy] Request: ${req.method} ${pathname}`);

  // 健康檢查端點
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

  // 移除 /api/gps 前綴
  const searchParamsString = url.searchParams.toString();
  const apiPath = searchParamsString
    ? `${pathname.replace('/api/gps', '')}?${searchParamsString}`
    : pathname.replace('/api/gps', '');
  
  if (!apiPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Specify API path, e.g. /api/gps/Login/login.action' }));
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
      console.error(`[Proxy] Error: ${err.message}`);
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
  const localIP = '192.168.1.55';
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   GPS Proxy Server Started                               ║
║                                                          ║
║   功能:                                                  ║
║   ✓ 自動保存 JSESSION 到 session.json                   ║
║   ✓ 後續請求自動附加 session cookie                      ║
║   ✓ 支持 x-gps-jsession header                          ║
║   ✓ 可選 AES-256-GCM session 加密（GPS_SESSION_KEY）    ║
║   ✓ 影像 URL 端點: /api/gps/video-url                   ║
║   ✓ FLV stream proxy: /api/gps/flv-stream              ║
║   ✓ HLS stream proxy: /api/gps/hls/*                   ║
║   ✓ Admin session 快取（5分鐘）                        ║
║                                                          ║
║   Local: http://localhost:${PORT}                          ║
║   Network: http://${localIP}:${PORT}                     ║
║   Target: https://${GPS_SERVER}                          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use! Please close other programs using this port.`);
    process.exit(1);
  }
  throw err;
});
