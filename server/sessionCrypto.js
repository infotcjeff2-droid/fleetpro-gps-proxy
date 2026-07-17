/**
 * Session Crypto Helper
 *
 * 提供 session 檔案的 AES-256-GCM 加解密：
 *   - 寫入：呼叫 encryptSession(plainObject) 寫到 session.json.enc
 *   - 讀取：呼叫 decryptSession() 取得 plainObject（無檔案/金鑰時回傳 null）
 *
 * 主要金鑰來源（依序）：
 *   1. process.env.GPS_SESSION_KEY（推薦 — 透過 .env 注入，不入版本控制）
 *   2. 不存在金鑰時 → 視為「開發模式不啟用加密」，所有 read/write 退化為明文讀寫
 *
 * 檔案格式：
 *   {
 *     "v": 1,
 *     "salt": "<base64>",
 *     "iv": "<base64>",
 *     "tag": "<base64>",
 *     "data": "<base64>"
 *   }
 *
 * 金鑰派生：scryptSync(password=salt, salt=user, N=2^15)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTED_FILE = path.join(__dirname, 'session.json.enc');
const PLAIN_FILE = path.join(__dirname, 'session.json');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function getMasterKey() {
  const raw = process.env.GPS_SESSION_KEY;
  if (!raw) return null;

  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LEN) return buf;
  } catch (_) {}

  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LEN, { ...SCRYPT_OPTS, salt });
}

function encryptSession(plainObject) {
  const masterKey = getMasterKey();
  const plaintext = Buffer.from(JSON.stringify(plainObject), 'utf-8');

  if (!masterKey) {
    fs.writeFileSync(PLAIN_FILE, JSON.stringify(plainObject, null, 2));
    return { mode: 'plain' };
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };

  fs.writeFileSync(ENCRYPTED_FILE, JSON.stringify(payload, null, 2));
  if (fs.existsSync(PLAIN_FILE)) {
    try { fs.unlinkSync(PLAIN_FILE); } catch (_) {}
  }
  return { mode: 'encrypted' };
}

function decryptSession() {
  const masterKey = getMasterKey();

  if (fs.existsSync(ENCRYPTED_FILE)) {
    if (!masterKey) {
      console.warn('[SessionCrypto] 偵測到加密 session.json.enc，但缺少 GPS_SESSION_KEY，跳過載入。');
      return null;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(ENCRYPTED_FILE, 'utf-8'));
      if (payload.v !== 1) throw new Error(`unsupported version ${payload.v}`);

      const salt = Buffer.from(payload.salt, 'base64');
      const iv = Buffer.from(payload.iv, 'base64');
      const tag = Buffer.from(payload.tag, 'base64');
      const data = Buffer.from(payload.data, 'base64');

      const key = deriveKey(masterKey, salt);
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(dec.toString('utf-8'));
    } catch (err) {
      console.warn('[SessionCrypto] 解密失敗:', err.message);
      return null;
    }
  }

  if (fs.existsSync(PLAIN_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PLAIN_FILE, 'utf-8'));
    } catch (_) {
      return null;
    }
  }

  return null;
}

function getMode() {
  return getMasterKey() ? 'encrypted' : 'plain';
}

module.exports = { encryptSession, decryptSession, getMode };
