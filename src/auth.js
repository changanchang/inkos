/**
 * InkOS Studio — 认证模块
 * 
 * 密码哈希: scrypt + 随机 salt
 * API Key 加密: AES-256-GCM
 * 会话管理: 内存 Map + HttpOnly Cookie
 * 存储: JSON 文件 (~/.inkos/users.json)
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const INKOS_HOME = process.env.INKOS_HOME || join(homedir(), '.inkos');
const USERS_FILE = join(INKOS_HOME, 'users.json');
const GUESTS_DIR = join(INKOS_HOME, 'temp_guests');
const SECRET_KEY_FILE = join(INKOS_HOME, 'server-secret.key');

// ═══════════════════════════════════════════════════════════════
// 主密钥管理
// ═══════════════════════════════════════════════════════════════

/** 获取或自动生成 AES 主密钥（32 字节 = AES-256） */
function getServerSecret() {
  if (!existsSync(INKOS_HOME)) mkdirSync(INKOS_HOME, { recursive: true });

  if (existsSync(SECRET_KEY_FILE)) {
    return readFileSync(SECRET_KEY_FILE);
  }

  const secret = randomBytes(32);
  writeFileSync(SECRET_KEY_FILE, secret);
  console.log('[AUTH] 已自动生成 AES 主密钥: server-secret.key');
  return secret;
}

const SERVER_SECRET = getServerSecret();

// ═══════════════════════════════════════════════════════════════
// 密码哈希（不可逆 — scrypt）
// ═══════════════════════════════════════════════════════════════

export function hashPassword(password, salt) {
  if (!salt) salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const result = scryptSync(password, salt, 64).toString('hex');
  return result === hash;
}

// ═══════════════════════════════════════════════════════════════
// API Key 加密（可逆 — AES-256-GCM）
// ═══════════════════════════════════════════════════════════════

export function encryptApiKey(plainKey) {
  if (!plainKey) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SERVER_SECRET, iv);
  let encrypted = cipher.update(plainKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // 格式: iv:authTag:ciphertext
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptApiKey(encryptedKey) {
  if (!encryptedKey || !encryptedKey.includes(':')) return encryptedKey; // 未加密的旧数据直接返回
  try {
    const [ivHex, authTagHex, ciphertext] = encryptedKey.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', SERVER_SECRET, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[AUTH] API Key 解密失败:', e.message);
    return ''; // 解密失败返回空，避免崩溃
  }
}

// ═══════════════════════════════════════════════════════════════
// 用户存储（JSON 文件）
// ═══════════════════════════════════════════════════════════════

function loadUsers() {
  if (!existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  if (!existsSync(INKOS_HOME)) mkdirSync(INKOS_HOME, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function findUserByEmail(email) {
  const users = loadUsers();
  return users.find(u => u.email === email.toLowerCase().trim());
}

export function findUserById(id) {
  const users = loadUsers();
  return users.find(u => u.id === id);
}

export function createUser(email, password) {
  const users = loadUsers();
  const normalizedEmail = email.toLowerCase().trim();

  if (users.find(u => u.email === normalizedEmail)) {
    throw new Error('该邮箱已被注册');
  }

  const { hash, salt } = hashPassword(password);
  const userId = randomBytes(8).toString('hex');

  const user = {
    id: userId,
    email: normalizedEmail,
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  saveUsers(users);

  // 创建用户数据目录
  const userDir = getUserDataDir(userId);
  mkdirSync(join(userDir, 'projects', 'default'), { recursive: true });

  console.log(`[AUTH] 新用户注册: ${normalizedEmail} (${userId})`);
  return user;
}

// ═══════════════════════════════════════════════════════════════
// 用户数据目录
// ═══════════════════════════════════════════════════════════════

export function getUserDataDir(userId) {
  if (userId.startsWith('guest_')) {
    return join(GUESTS_DIR, userId);
  }
  return join(INKOS_HOME, 'users', userId);
}

export function getUserProjectsDir(userId) {
  const dir = join(getUserDataDir(userId), 'projects');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getUserEnvFile(userId) {
  return join(getUserDataDir(userId), '.env');
}

export function getUserContextHistoryFile(userId) {
  return join(getUserDataDir(userId), 'context-history.json');
}

// ═══════════════════════════════════════════════════════════════
// 会话管理（内存 Map）
// ═══════════════════════════════════════════════════════════════

const sessions = new Map();
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 天

export function createSession(userId, email, isGuest = false) {
  const token = randomBytes(32).toString('hex');
  const maxAge = isGuest ? 2 * 60 * 60 * 1000 : SESSION_MAX_AGE; // Guest: 2 hours, User: 7 days
  sessions.set(token, {
    userId,
    email: email || 'guest@example.com',
    isGuest,
    expiresAt: Date.now() + maxAge
  });
  return token;
}

export function createGuestSession() {
  const guestId = `guest_${randomBytes(4).toString('hex')}`;
  const token = createSession(guestId, null, true);
  
  // Ensure the guest directory exists immediately
  const guestDir = getUserDataDir(guestId);
  mkdirSync(join(guestDir, 'projects', 'default'), { recursive: true });
  
  return { token, guestId };
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteSession(token) {
  sessions.delete(token);
}

// ═══════════════════════════════════════════════════════════════
// Cookie 解析（零依赖替代 cookie-parser）
// ═══════════════════════════════════════════════════════════════

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(pair => {
    const [key, ...val] = pair.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

// ═══════════════════════════════════════════════════════════════
// Express 中间件
// ═══════════════════════════════════════════════════════════════

export function requireAuth(req, res, next) {
  // 跳过认证路由和静态文件
  if (req.path.startsWith('/api/auth/')) return next();
  if (!req.path.startsWith('/api/')) return next();

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['inkos_session'];
  let session = getSession(token);

  if (!session) {
    // 自动分配游客 ID
    const { token: guestToken, guestId } = createGuestSession();
    res.setHeader('Set-Cookie', `inkos_session=${guestToken}; HttpOnly; Path=/; Max-Age=${2 * 3600}; SameSite=Lax`);
    session = getSession(guestToken);
    console.log(`[AUTH] 自动分配游客身份: ${guestId}`);
  }

  req.user = { id: session.userId, email: session.email, isGuest: !!session.isGuest };
  next();
}
