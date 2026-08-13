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
        const url = new URL(req.url, `http://localhost:${PORT}`);
        return url.searchParams.get('jsessionId') || url.searchParams.get('JSESSIONID') || '';
      } catch {
        return '';
      }
    })();

    const clientJsession = req.headers['x-gps-jsession'] || queryJsessionId;
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

      // CORS headers
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
      if (req.method === 'OPTIONS') {
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
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
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

  // 影像 URL 獲取端點
  if (pathname === '/api/gps/video-url') {
    console.log('[Proxy] Video URL request handling...');

    // 從查詢參數獲取設備和串流資訊
    const devIdno = searchParams.get('devIdno') || '';
    const channel = searchParams.get('channel') || '0';
    const stream = searchParams.get('stream') || '0';
    const type = searchParams.get('type') || '1';
    const jsessionId = searchParams.get('jsessionId') || sessionData.jsessionCookie || '';
    const password = searchParams.get('password') || '';
    const protocol = searchParams.get('protocol') || 'flv';

    console.log(`[Proxy] Video request: devIdno=${devIdno}, channel=${channel}, stream=${stream}, protocol=${protocol}`);

    // 構建代理 URL（避免 CORS）
    const proxyBase = getProxyBaseFromReq(req);
    let proxyFlvUrl = `${proxyBase}/api/gps/flv-stream?devIdno=${encodeURIComponent(devIdno)}&channel=${channel}&stream=${stream}&type=${type}&AVType=1&jsessionId=${jsessionId}`;
    let proxyHlsUrl = `${proxyBase}/api/gps/hls-stream?devIdno=${encodeURIComponent(devIdno)}&channel=${channel}&stream=${stream}&type=${type}&jsessionId=${jsessionId}`;
    if (password) {
      proxyFlvUrl += `&password=${encodeURIComponent(password)}`;
      proxyHlsUrl += `&password=${encodeURIComponent(password)}`;
    }

    // 同時也提供直接 URL（作為備用，給原生端使用）
    const directFlvUrl = `https://${GPS_SERVER}:6604/3/3?devIdno=${encodeURIComponent(devIdno)}&channel=${channel}&stream=${stream}&type=${type}&jsession=${encodeURIComponent(jsessionId)}&AVType=1`;
    const directHlsUrl = `https://${GPS_SERVER}/hlslive/?devIdno=${encodeURIComponent(devIdno)}&channel=${channel}&stream=${stream}&type=${type}&jsession=${encodeURIComponent(jsessionId)}&AVType=1`;

    // 返回的 URL：
    // - Web 端使用 proxyFlvUrl / proxyHlsUrl（透過代理繞過 CORS）
    // - 原生端使用 directFlvUrl / directHlsUrl
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      result: 0,
      videoUrl: proxyHlsUrl, // 預設 HLS（行動裝置/Web 友善）
      flvUrl: proxyFlvUrl,
      hlsUrl: proxyHlsUrl,
      directUrl: directFlvUrl,
      directHlsUrl,
      protocol,
      devIdno,
      channel: parseInt(channel, 10),
      stream: parseInt(stream, 10),
    }));

    return;
  }

  // HTTP-FLV 串流代理端點（將 FLV 數據流從 808GPS 轉發給 Web 端，避免 CORS）
  if (pathname === '/api/gps/flv-stream') {
    // 確保使用有效的 session（可能是 admin session）
    // 始終使用有效的 session（用戶端 session 沒有影像權限）
    const validSession = await ensureValidSession();
    if (!validSession) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '無法獲取有效 session，請重試' }));
      return;
    }

    console.log('[Proxy] FLV stream proxy (using admin session)...');

    const devIdno = searchParams.get('devIdno') || '';
    const channel = searchParams.get('channel') || '0';
    const stream = searchParams.get('stream') || '0';
    const type = searchParams.get('type') || '1';
    // 始終使用 admin session（用戶端 session 沒有影像權限）
    const jsessionId = validSession;
    // 808GPS FLV 端點也要求「密碼必須加密」（MD5）
    const password = searchParams.get('password') || '';

    // 808GPS HTTP-FLV URL 格式（根據 808GPS Web API 文件）：
    // http://console.onefleet.hk:6604/3/3?AVType=1&jsession=...&DevIDNO=...&Channel=0&Stream=1
    // 注意：
    // - 端口是 6604（不是 443）
    // - 沒有 Type 參數（影像不需要，只有對講才需要）
    // - 參數大小寫：DevIDNO, Channel, Stream（首字母大寫）
    // - jsessionId 在 URL 中是 jsession
    const flvQueryParams = {
      AVType: '1',
      jsession: jsessionId,
      DevIDNO: devIdno,
      Channel: channel,
      Stream: stream,
    };
    if (password) {
      flvQueryParams.Password = password;
    }
    const flvQueryString = new URLSearchParams(flvQueryParams).toString();

    // 使用 http:// 端口 6604
    const targetHost = 'console.onefleet.hk';
    const targetPort = 6604;
    const targetPath = `/3/3?${flvQueryString}`;

    console.log(`[Proxy] FLV stream: http://${targetHost}:${targetPort}${targetPath.substring(0, 200)}...`);

    // 設置 CORS headers（這是關鍵，允許瀏覽器跨域訪問）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    // 處理 OPTIONS 預檢請求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 流式轉發到 808GPS HTTP-FLV 端點（HTTP 端口 6604）
    // 808GPS 影像串流是長連線，必須立即轉發資料，不能緩衝
    const options = {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: 'GET',
      headers: {
        'Host': `${targetHost}:${targetPort}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'video/x-flv, application/octet-stream, */*',
        'Accept-Encoding': 'identity', // 不壓縮，保持 FLV 格式
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...(req.headers.range ? { 'Range': req.headers.range } : {}),
      },
      timeout: 60000, // 60秒超時
    };

    // 設置串流響應頭（Transfer-Encoding: chunked 不需要，HTTP/1.1 默認）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    res.setHeader('Content-Type', 'video/x-flv');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    // 處理 OPTIONS 預檢請求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const proxyReq = http.request(options, (proxyRes) => {
      console.log(`[Proxy] FLV upstream response: ${proxyRes.statusCode}`);

      // 如果上游返回非 200，可能返回 JSON 錯誤
      if (proxyRes.statusCode !== 200) {
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          console.log(`[Proxy] FLV upstream error (${proxyRes.statusCode}): ${body.substring(0, 200)}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            result: -1,
            error: `上游伺服器返回 ${proxyRes.statusCode}`,
            details: body.substring(0, 500),
          }));
        });
        return;
      }

      // 流式轉發：上游資料一到就立即轉發給客戶端
      res.writeHead(200, {
        'Content-Type': 'video/x-flv',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });

      proxyRes.on('data', chunk => {
        if (!res.destroyed) {
          res.write(chunk);
        }
      });

      proxyRes.on('end', () => {
        console.log('[Proxy] FLV stream completed');
        res.end();
      });

      proxyRes.on('error', (err) => {
        console.error(`[Proxy] FLV upstream error: ${err.message}`);
        if (!res.destroyed) {
          res.end();
        }
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy] FLV request error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, result: -1 }));
      } else {
        res.end();
      }
    });

    proxyReq.on('timeout', () => {
      console.warn('[Proxy] FLV timeout');
      proxyReq.destroy();
    });

    // 客戶端斷開時關閉代理
    req.on('close', () => {
      proxyReq.destroy();
    });

    proxyReq.end();

    return;
  }

  // HLS 串流代理端點（將 HLS 播放清單與 TS 分段從 808GPS 轉發給 Web 端，避免 CORS）
  if (pathname === '/api/gps/hls-stream' || pathname === '/api/gps/hls-segment') {
    const isSegment = pathname === '/api/gps/hls-segment';

    if (isSegment) {
      // TS 分段：直接代理二進位數據
      const segmentUrl = searchParams.get('url') || '';
      const segSessionId = searchParams.get('jsessionId') || sessionData.jsessionCookie || '';
      if (!segmentUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing segment url parameter', result: -1 }));
        return;
      }

      // 808GPS TS URL 範例：http://console.onefleet.hk:6604/hls/2026_08_05_10_08_34_502.ts?PATH=D:\GPS_MEDIA_TEMP\hls\...
      // 使用 http:// 模組因為上游是 HTTP（不是 HTTPS）
      const upstreamUrl = new URL(segmentUrl, `http://${GPS_SERVER}:6604`);

      const segHeaders = {
        'Host': upstreamUrl.host,
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        ...(segSessionId ? { 'Cookie': `JSESSIONID=${segSessionId}` } : {}),
        ...(req.headers.range ? { 'Range': req.headers.range } : {}),
      };

      const segReq = http.request({
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 6604,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: 'GET',
        headers: segHeaders,
        timeout: 30000,
      }, (segRes) => {
        const responseHeaders = { ...segRes.headers };
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        responseHeaders['Cache-Control'] = 'public, max-age=10';
        res.writeHead(segRes.statusCode || 200, responseHeaders);
        segRes.pipe(res);
        segRes.on('end', () => res.end());
      });

      segReq.on('error', (err) => {
        console.error('[Proxy] HLS segment error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, result: -1 }));
        } else {
          res.end();
        }
      });

      segReq.on('timeout', () => {
        console.warn('[Proxy] HLS segment timeout');
        segReq.destroy();
      });

      req.on('close', () => segReq.destroy());
      segReq.end();
      return;
    }

    // HLS 播放清單（.m3u8）
    console.log('[Proxy] HLS playlist proxy...');

    const devIdno = searchParams.get('devIdno') || '';
    const channel = searchParams.get('channel') || '0';
    const stream = searchParams.get('stream') || '0';
    const type = searchParams.get('type') || '1';
    const jsessionId = searchParams.get('jsessionId') || sessionData.jsessionCookie || '';
    // 808GPS HLS 端點要求「密碼必須加密」（MD5），從查詢參數取得
    const password = searchParams.get('password') || '';

    // 808GPS HLS 端點（根據官方文件）：
    // http://console.onefleet.hk:6604/hls/<requestType_deviceNumber_channelNumber_bitstreamType>.m3u8?jsession=<JSessionID>
    // 參數說明：
    // - requestType: 1 (video)
    // - deviceNumber: 設備號（devIdno）
    // - channelNumber: 通道（從 0 開始）
    // - bitstreamType: 0=主碼流（HD）, 1=子碼流（SD）
    // 注意：端口是 6604（不是 443），路徑是 /hls/（不是 /hlslive/）
    const requestType = 1; // 1 = video
    const m3u8Filename = `${requestType}_${devIdno}_${channel}_${stream}.m3u8`;
    const hlsTargetPath = `/hls/${m3u8Filename}?jsession=${encodeURIComponent(jsessionId)}`;
    console.log(`[Proxy] HLS: http://${GPS_SERVER}:6604${hlsTargetPath}`);

    const hlsHeaders = {
      'Host': `${GPS_SERVER}:6604`,
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
    };
    if (req.headers.range) {
      hlsHeaders['Range'] = req.headers.range;
    }

    const hlsOptions = {
      hostname: GPS_SERVER,
      port: 6604,
      path: hlsTargetPath,
      method: 'GET',
      headers: hlsHeaders,
      timeout: 15000,
    };

    const hlsReq = http.request(hlsOptions, (hlsRes) => {
      console.log(`[Proxy] HLS upstream response: ${hlsRes.statusCode}`);

      const upstreamContentType = hlsRes.headers['content-type'] || '';
      const upstreamBody = [];

      hlsRes.on('data', chunk => upstreamBody.push(chunk));
      hlsRes.on('end', () => {
        const body = Buffer.concat(upstreamBody).toString('utf-8');
        const isPlaylist = upstreamContentType.includes('mpegurl') ||
                          upstreamContentType.includes('m3u8') ||
                          body.trim().startsWith('#EXTM3U');

        // 上游錯誤（如 param error JSON）— 直接回傳給前端
        if (!isPlaylist) {
          console.log(`[Proxy] HLS upstream error (not playlist): ${body.substring(0, 200)}`);
          res.writeHead(hlsRes.statusCode || 502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({
            result: -1,
            error: `808GPS HLS upstream error: ${hlsRes.statusCode}`,
            upstreamResponse: body.substring(0, 500),
            upstreamStatus: hlsRes.statusCode,
          }));
          return;
        }

        // 重寫播放清單：把所有相對或絕對的 TS/子清單 URL 都改寫為代理 URL
        // 808GPS HLS 格式範例：
        //   #EXTM3U
        //   #EXT-X-VERSION:3
        //   #EXT-X-TARGETDURATION:2
        //   #EXT-X-MEDIA-SEQUENCE:0
        //   #EXTINF:2.0,
        //   2026_08_05_10_08_34_502.ts?PATH=D:\GPS_MEDIA_TEMP\...&DevIDNO=...
        //   （注意：TS URL 是相對路徑，且 query string 包含 Windows 路徑）
        const lines = body.split(/\r?\n/);
        const proxyBase = `${getProxyBaseFromReq(req)}/api/gps/hls-segment`;
        const segSession = jsessionId ? `&jsessionId=${encodeURIComponent(jsessionId)}` : '';
        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          // 跳過空行、註解行（#EXTINF、#EXT-X-*）
          if (!trimmed || trimmed.startsWith('#')) {
            return line;
          }
          // 任何含有 .ts 或 .m3u8 的行（無論是相對路徑還是絕對路徑）都重寫為代理 URL
          if (trimmed.endsWith('.ts') || trimmed.endsWith('.m3u8') ||
              trimmed.includes('.ts?') || trimmed.includes('.m3u8?') ||
              /^\d+\.ts/.test(trimmed)) {
            // 絕對 URL 直接轉發；相對路徑也用同一個代理（代理會補上 host）
            return `${proxyBase}?url=${encodeURIComponent(trimmed)}${segSession}`;
          }
          return line;
        }).join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(rewritten);
      });
    });

    hlsReq.on('error', (err) => {
      console.error('[Proxy] HLS error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, result: -1 }));
      } else {
        res.end();
      }
    });

    hlsReq.on('timeout', () => {
      console.warn('[Proxy] HLS timeout');
      hlsReq.destroy();
    });

    req.on('close', () => hlsReq.destroy());
    hlsReq.end();
    return;
  }

  // 只處理 /api/gps 路徑
  if (!pathname.startsWith('/api/gps')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /api/gps prefix.' }));
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

// 創建 HTTP 服務器
const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  const localIP = '192.168.1.55';
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   GPS Proxy Server Started                               ║
║                                                          ║
║   Local: http://localhost:${PORT}                          ║
║   Network: http://${localIP}:${PORT}                     ║
║   Target: https://${GPS_SERVER}                          ║
║                                                          ║
║   Features:                                              ║
║   - Auto-save JSESSION to session.json                   ║
║   - Auto-attach session cookie                           ║
║   - Support x-gps-jsession header                        ║
║   - Video URL endpoint: /api/gps/video-url               ║
║   - FLV stream proxy: /api/gps/flv-stream                ║
║   - HLS stream proxy: /api/gps/hls-stream                ║
║   - HLS segment proxy: /api/gps/hls-segment              ║
║                                                          ║
║   Usage:                                                  ║
║   POST to http://localhost:${PORT}/api/gps/...             ║
║   or http://${localIP}:${PORT}/api/gps/...               ║
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
