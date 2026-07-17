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

    // 優先使用請求中的 x-gps-jsession header
    const clientJsession = req.headers['x-gps-jsession'];
    if (clientJsession) {
      options.headers['Cookie'] = `JSESSIONID=${clientJsession}`;
      console.log(`[Proxy] 使用客戶端 session: ${clientJsession.substring(0, 16)}...`);
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
