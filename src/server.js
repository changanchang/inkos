import express from 'express';
import cors from 'cors';
import { exec, execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, delimiter, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, createReadStream, readdirSync, statSync, unlinkSync, renameSync, rmSync } from 'fs';
import { homedir } from 'os';
import {
  verifyPassword, encryptApiKey, decryptApiKey,
  findUserByEmail, createUser, getUserProjectsDir, getUserEnvFile, getUserContextHistoryFile,
  createSession, createGuestSession, getSession, deleteSession, parseCookies, requireAuth,
  ensureDirSync
} from './auth.js';
import multer from 'multer';
import AdmZip from 'adm-zip';

// Config multer for zip imports (use memory storage for processing directly)
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态解析 @actalk/inkos CLI 路径
// 优先级：1) Electron asar:false 打包路径 (resources/app)
//         2) Electron asarUnpacked 路径（旧配置兼容）
//         3) 本地 node_modules（开发环境）
//         4) 全局 npm 安装
function resolveInkosCliPath() {
  // 1. Electron asar:false 打包后：resources/app/node_modules/...
  if (process.resourcesPath) {
    const p1 = join(process.resourcesPath, 'app', 'node_modules', '@actalk', 'inkos', 'dist', 'index.js');
    if (existsSync(p1)) {
      console.log('[INKOS_CLI] 使用 resources/app 路径:', p1);
      return p1;
    }
    // 2. 旧版 asarUnpack 兼容路径
    const p2 = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@actalk', 'inkos', 'dist', 'index.js');
    if (existsSync(p2)) {
      console.log('[INKOS_CLI] 使用 asar.unpacked 路径:', p2);
      return p2;
    }
  }
  // 3. 开发环境 / 直接 node 启动时的本地 node_modules
  const local = join(__dirname, '..', 'node_modules', '@actalk', 'inkos', 'dist', 'index.js');
  if (existsSync(local)) {
    console.log('[INKOS_CLI] 使用本地 node_modules 路径:', local);
    return local;
  }
  // 4. 全局 npm 安装路径（Windows: %APPDATA%\npm\node_modules）
  const globalRoot = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules')
    : join(homedir(), '.npm-global', 'lib', 'node_modules');
  const globalPath = join(globalRoot, '@actalk', 'inkos', 'dist', 'index.js');
  console.log('[INKOS_CLI] 使用全局 npm 路径:', globalPath);
  return globalPath;
}
const INKOS_CLI_PATH = resolveInkosCliPath();


const app = express();
const PORT = process.env.PORT || 4567;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

// ═══════════════════════════════════════════════════════════════
// EXE 客户端下载 API（无需认证）
// ═══════════════════════════════════════════════════════════════
const DIST_DIR = join(__dirname, '..', 'dist_desktop');

app.get('/api/download/client', (req, res) => {
  try {
    const zipFile = existsSync(DIST_DIR)
      ? readdirSync(DIST_DIR).find(f => f.endsWith('.zip') && f.includes('InkOS'))
      : null;
    if (!zipFile) {
      return res.status(404).json({ error: '客户端安装包暂未发布，请稍后再试' });
    }
    const filePath = join(DIST_DIR, zipFile);
    const stat = statSync(filePath);
    const versionMatch = zipFile.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFile)}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-App-Version', version);
    res.setHeader('X-App-Size', stat.size.toString());
    createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[DOWNLOAD]', e.message);
    res.status(500).json({ error: '下载失败，请稍后重试' });
  }
});

app.get('/api/download/client-info', (req, res) => {
  try {
    const zipFile = existsSync(DIST_DIR)
      ? readdirSync(DIST_DIR).find(f => f.endsWith('.zip') && f.includes('InkOS'))
      : null;
    if (!zipFile) {
      return res.json({ available: false });
    }
    const stat = statSync(join(DIST_DIR, zipFile));
    const versionMatch = zipFile.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    res.json({
      available: true,
      version,
      size: stat.size,
      sizeLabel: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
      filename: zipFile
    });
  } catch (e) {
    res.json({ available: false });
  }
});

// 认证中间件
app.use(requireAuth);

// 代理目标注册表（解密后的 API Key → 上游 URL）
const proxyTargets = new Map();

// ============================================================
// 认证 API
// ============================================================
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码长度至少 6 位' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  try {
    const user = createUser(email, password);
    const token = createSession(user.id, user.email);
    res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=None; Secure`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码不能为空' });
  }
  const user = findUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  if (!verifyPassword(password, user.passwordHash, user.salt)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  const token = createSession(user.id, user.email);
  res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=None; Secure`);
  res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['inkos_session'];
  if (token) deleteSession(token);
  res.setHeader('Set-Cookie', 'inkos_session=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure');
  res.json({ success: true });
});

app.post('/api/auth/guest-login', (req, res) => {
  try {
    const { token, guestId } = createGuestSession();
    res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${2 * 3600}; SameSite=Lax`);
    res.json({ success: true, user: { id: guestId, email: 'guest@example.com', isGuest: true } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 桌面端自动登录 — EXE 专用，无需密码直接进入
app.post('/api/auth/desktop-auto-login', async (req, res) => {
  try {
    const DESKTOP_USER_EMAIL = 'local@inkos.desktop';
    const DESKTOP_USER_ID = 'desktop_local_user';
    const INKOS_HOME = process.env.INKOS_HOME || join(homedir(), '.inkos');
    const usersFile = join(INKOS_HOME, 'users.json');

    // 检查是否已存在桌面用户，若不存在则初始化
    let user = findUserByEmail(DESKTOP_USER_EMAIL);
    if (!user) {
      const users = existsSync(usersFile)
        ? JSON.parse(readFileSync(usersFile, 'utf-8'))
        : [];
      const desktopUser = {
        id: DESKTOP_USER_ID,
        email: DESKTOP_USER_EMAIL,
        passwordHash: '',
        salt: '',
        isDesktop: true,
        createdAt: new Date().toISOString()
      };
      users.push(desktopUser);
      ensureDirSync(INKOS_HOME);
      writeFileSync(usersFile, JSON.stringify(users, null, 2));
      user = desktopUser;
      // 创建用户数据目录
      ensureDirSync(join(INKOS_HOME, 'users', DESKTOP_USER_ID, 'projects', 'default'));
      console.log('[AUTH] 桌面用户首次初始化完成');
    }

    // 创建长期 Session（30 天）
    const token = createSession(user.id, user.email, false);
    res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
    res.json({ success: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[AUTH] 桌面自动登录失败:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['inkos_session'];
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: '未登录' });
  }
  res.json({ user: { id: session.userId, email: session.email } });
});

// ============================================================
// LLM Proxy — strips reasoning_content from DeepSeek R1 streams
// so that inkos receives a standard OpenAI-compatible response
// ============================================================
app.all('/llm-proxy/*', async (req, res) => {
  // 多用户代理：优先从 session / proxyTargets 获取配置
  const reqApiKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const proxyCookies = parseCookies(req.headers.cookie);
  const proxySession = getSession(proxyCookies['inkos_session']);

  let realBaseUrl, apiKey;
  if (proxySession) {
    const userEnv = readEnv(getUserEnvFile(proxySession.userId));
    realBaseUrl = userEnv.INKOS_LLM_PROXY_TARGET || userEnv.INKOS_LLM_BASE_URL || 'https://api.deepseek.com';
    apiKey = decryptApiKey(userEnv.INKOS_LLM_API_KEY || '') || reqApiKey;
  } else if (reqApiKey && proxyTargets.has(reqApiKey)) {
    realBaseUrl = proxyTargets.get(reqApiKey);
    apiKey = reqApiKey;
  } else {
    const fallbackEnv = readEnv(join(homedir(), '.inkos', '.env'));
    realBaseUrl = fallbackEnv.INKOS_LLM_PROXY_TARGET || fallbackEnv.INKOS_LLM_BASE_URL || 'https://api.deepseek.com';
    apiKey = fallbackEnv.INKOS_LLM_API_KEY || reqApiKey;
  }
  
  // Build upstream URL: replace /llm-proxy with /v1
  const upstreamPath = '/v1' + req.originalUrl.replace('/llm-proxy', '');
  const upstreamUrl = `${realBaseUrl}${upstreamPath}`;
  
  console.log(`[LLM-PROXY] ${req.method} ${upstreamUrl}`);
  
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    
    const fetchOpts = {
      method: req.method,
      headers,
    };
    
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(req.body);
    }
    
    const upstream = await fetch(upstreamUrl, fetchOpts);
    
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[LLM-PROXY] Upstream error ${upstream.status} from ${realBaseUrl}: ${errText}`);
      res.status(upstream.status).send(errText);
      return;
    }
    
    const isStream = req.body?.stream === true;
    
    if (!isStream) {
      // Non-streaming: just strip reasoning_content from the JSON response
      const data = await upstream.json();
      if (data.choices) {
        for (const choice of data.choices) {
          if (choice.message) {
            delete choice.message.reasoning_content;
          }
        }
      }
      res.json(data);
      return;
    }
    
    // Streaming: proxy SSE line by line, stripping reasoning_content
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer
        
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            res.write(line + '\n');
            continue;
          }
          
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          
          try {
            const chunk = JSON.parse(payload);
            // Strip reasoning_content from delta
            if (chunk.choices) {
              for (const choice of chunk.choices) {
                if (choice.delta) {
                  delete choice.delta.reasoning_content;
                  // If delta has no content and no role after stripping, skip
                  if (!choice.delta.content && !choice.delta.role && !choice.delta.tool_calls && choice.finish_reason === null) {
                    continue;
                  }
                }
              }
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } catch {
            // Not valid JSON, forward as-is
            res.write(line + '\n');
          }
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        res.write(buffer + '\n');
      }
    } catch (e) {
      console.error(`[LLM-PROXY] stream error: ${e.message}`);
    } finally {
      res.end();
    }
  } catch (e) {
    console.error(`[LLM-PROXY] fetch error: ${e.message}`);
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
});

// Paths
const INKOS_HOME = process.env.INKOS_HOME || join(homedir(), '.inkos');

// Ensure base directory exists
ensureDirSync(INKOS_HOME);

// 启动时清理全局 .env 中的过时代理/推理模型配置，避免覆盖用户当前的正确配置
try {
  const globalEnvPath = join(INKOS_HOME, '.env');
  if (existsSync(globalEnvPath)) {
    const gEnv = readEnv(globalEnvPath);
    let dirty = false;
    if (gEnv.INKOS_LLM_PROXY_TARGET) { delete gEnv.INKOS_LLM_PROXY_TARGET; dirty = true; }
    if (gEnv.INKOS_LLM_BASE_URL && (gEnv.INKOS_LLM_BASE_URL.includes('localhost') || gEnv.INKOS_LLM_BASE_URL.includes('llm-proxy'))) {
      delete gEnv.INKOS_LLM_BASE_URL; dirty = true;
    }
    if (gEnv.INKOS_LLM_MODEL && (gEnv.INKOS_LLM_MODEL.includes('reasoner') || gEnv.INKOS_LLM_MODEL.includes('thinking'))) {
      delete gEnv.INKOS_LLM_MODEL; dirty = true;
    }
    if (dirty) {
      writeEnv(globalEnvPath, gEnv);
      console.log('[INIT] 已清理全局 .env 中的过时代理/推理模型配置');
    }
  }
} catch (e) { console.warn('[INIT] 全局 .env 清理失败:', e.message); }

// Helper: 将用户侧 provider 名称映射为 inkos-core schema 接受的值
// inkos-core ProjectConfigSchema 只接受 'anthropic' | 'openai' | 'custom'
function mapProviderForCli(provider) {
  const p = (provider || '').toLowerCase();
  if (p === 'anthropic') return 'anthropic';
  if (p === 'openai') return 'openai';
  if (p === 'deepseek') return 'custom';
  if (p === 'moonshot') return 'custom';
  if (p === 'zhipu' || p === 'glm' || p === 'chatglm') return 'custom';
  if (p === 'qwen' || p === 'dashscope' || p === 'alibaba') return 'custom';
  return 'custom';
}

function mapProviderToService(provider) {
  const p = (provider || '').toLowerCase();
  if (p === 'deepseek') return 'deepseek';
  if (p === 'moonshot') return 'moonshot';
  if (p === 'zhipu' || p === 'glm' || p === 'chatglm') return 'zhipu';
  if (p === 'qwen' || p === 'dashscope' || p === 'alibaba') return 'qwen';
  if (p === 'siliconflow') return 'siliconflow';
  if (p === 'minimax') return 'minimax';
  if (p === 'openrouter') return 'openrouter';
  if (p === 'openai') return 'openai';
  if (p === 'anthropic') return 'anthropic';
  return '';
}

// Helper: 获取用户实际项目存储路径（优先使用自定义路径，否则回退默认路径）
function getEffectiveProjectsDir(userId) {
  const userEnvFile = getUserEnvFile(userId);
  const env = readEnv(userEnvFile);
  if (env.INKOS_PROJECTS_DIR && existsSync(env.INKOS_PROJECTS_DIR)) {
    return env.INKOS_PROJECTS_DIR;
  }
  return getUserProjectsDir(userId);
}

// Helper: 获取用户的 LLM 环境变量（解密 API Key），用于注入子进程
function getUserLlmEnv(userEnvFile) {
  const env = readEnv(userEnvFile);
  const provider = env.INKOS_LLM_PROVIDER || '';
  const result = {
    INKOS_LLM_API_KEY: decryptApiKey(env.INKOS_LLM_API_KEY || ''),
    INKOS_LLM_BASE_URL: env.INKOS_LLM_BASE_URL || '',
    INKOS_LLM_MODEL: env.INKOS_LLM_MODEL || '',
    INKOS_LLM_PROVIDER: mapProviderForCli(provider),
  };
  const service = mapProviderToService(provider);
  if (service) result.INKOS_LLM_SERVICE = service;
  return result;
}

// Helper to run inkos commands using spawn for better arg handling on Windows
function runInkos(commandString, cwd, extraEnv = {}) {
  const normalizedCwd = resolve(cwd);
  console.log(`[EXECUTING] npx inkos ${commandString} IN ${normalizedCwd}`);
  
  // Parse command string into arguments array (simple split for now, enough for current use)
  // handles basic quoted strings
  const args = ['inkos'];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = regex.exec(commandString)) !== null) {
    args.push(match[1] || match[2] || match[0]);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('node', [INKOS_CLI_PATH, ...args.slice(1)], { 
      cwd: normalizedCwd, 
      shell: false,
      env: { 
        ...process.env, 
        ...extraEnv,
        INKOS_HOME,
        INKOS_PROJECT_PATH: normalizedCwd // Explicitly tell CLI where we are
      } 
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`[EXEC ERROR] npx ${args.join(' ')}: exit ${code}`);
        if (stdout) console.log(`[EXEC STDOUT] ${stdout}`);
        if (stderr) console.error(`[EXEC STDERR] ${stderr}`);
        reject(new Error(stdout || stderr || `Process exited with code ${code}`));
      } else {
        if (stderr) console.warn(`[EXEC STDERR] ${stderr}`);
        resolve({ stdout, stderr });
      }
    });

    child.on('error', (err) => {
      console.error(`[SPAWN ERROR] ${err.message}`);
      reject(err);
    });
  });
}

// Helper: 读取 JSON 文件并自动剥离 UTF-8 BOM（Windows 某些工具写文件会带 BOM，导致 JSON.parse 失败）
function readJsonSafe(filePath) {
  const raw = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// Helper to read .env file
function readEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const env = {};
  content.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  });
  return env;
}

// Helper to write .env file
function writeEnv(filePath, data) {
  const lines = Object.entries(data).map(([k, v]) => `${k}=${v}`);
  writeFileSync(filePath, lines.join('\n') + '\n');
}

// Helper to get book info
function getBookInfo(bookPath) {
  // Try book.json first (new format)
  const bookJson = join(bookPath, 'book.json');
  if (existsSync(bookJson)) {
    try {
      return readJsonSafe(bookJson);
    } catch {
      // continue
    }
  }
  
  // Fallback to book_info.json (old format)
  const infoFile = join(bookPath, 'book_info.json');
  if (existsSync(infoFile)) {
    try {
      return readJsonSafe(infoFile);
    } catch {
      // continue
    }
  }
  
  return null;
}

// API Routes

// Get all books
app.get('/api/books', (req, res) => {
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  try {
    if (!existsSync(userProjectsDir)) {
      return res.json({ books: [] });
    }

    const books = [];
    const dirs = readdirSync(userProjectsDir);
    
    for (const dir of dirs) {
      const bookPath = join(userProjectsDir, dir);
      if (!statSync(bookPath).isDirectory()) continue;
      
      const booksDir = join(bookPath, 'books');
      if (!existsSync(booksDir)) continue;
      
      const bookDirs = readdirSync(booksDir);
      for (const bookDir of bookDirs) {
        const bookPathFull = join(booksDir, bookDir);
        if (!statSync(bookPathFull).isDirectory()) continue;
        
        const info = getBookInfo(bookPathFull);
        if (info) {
          // Count chapters
          const chaptersDir = join(bookPathFull, 'chapters');
          let chapterCount = 0;
          let wordCount = 0;
          
          if (existsSync(chaptersDir)) {
            const chapters = readdirSync(chaptersDir).filter(f => f.endsWith('.md'));
            chapterCount = chapters.length;
            
            chapters.forEach(ch => {
              const content = readFileSync(join(chaptersDir, ch), 'utf-8');
              wordCount += content.length;
            });
          }
          
          books.push({
            id: info.id || bookDir,
            title: info.title || bookDir,
            genre: info.genre || 'xuanhuan',
            chapterCount,
            wordCount,
            path: bookPathFull
          });
        }
      }
    }
    
    res.json({ books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create book
app.post('/api/books', async (req, res) => {
  const { title, genre, chapterWords, targetChapters, brief } = req.body;
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  const userEnvFile = getUserEnvFile(req.user.id);
  
  try {
    const projectName = 'default';
    const projectPath = join(userProjectsDir, projectName);
    const inkosConfigPath = join(projectPath, 'inkos.json');

    // 确保项目目录和 inkos.json 存在，完全手动创建，不依赖 CLI 子进程
    if (!existsSync(projectPath)) ensureDirSync(projectPath);
    
    if (!existsSync(inkosConfigPath)) {
      const defaultConfig = {
        name: "default",
        version: "0.1.0",
        language: "zh",
        llm: {
          provider: "openai",
          service: "custom",
          baseUrl: "",
          model: "",
          apiFormat: "chat",
          stream: true
        },
        notify: [],
        inputGovernanceMode: "v2"
      };
      writeFileSync(inkosConfigPath, JSON.stringify(defaultConfig, null, 2));
      console.log('[BOOKS] 手动初始化 inkos.json 完成');
    } else {
      try {
        const existingCfg = readJsonSafe(inkosConfigPath);
        let needsWrite = false;
        if (!existingCfg.name) { existingCfg.name = 'default'; needsWrite = true; }
        if (existingCfg.version !== '0.1.0') { existingCfg.version = '0.1.0'; needsWrite = true; }
        if (!existingCfg.language) { existingCfg.language = 'zh'; needsWrite = true; }
        if (existingCfg.llm && existingCfg.llm.configSource === 'studio') {
          delete existingCfg.llm.configSource;
          needsWrite = true;
        }
        if (existingCfg.project) { delete existingCfg.project; needsWrite = true; }
        writeFileSync(inkosConfigPath, JSON.stringify(existingCfg, null, 2), 'utf-8');
        if (needsWrite) console.log('[BOOKS] 已修复 inkos.json 格式（移除 configSource=studio，恢复 env 兼容）');
      } catch (e) { console.warn('[BOOKS] inkos.json 修复失败:', e.message); }
    }
    
    // 手动创建书籍目录结构，绕过在 Windows 上报错的 'inkos book create' CLI
    const booksDir = join(projectPath, 'books');
    ensureDirSync(booksDir);
    
    const bookId = `book_${Date.now()}`;
    const bookPath = join(booksDir, bookId);
    ensureDirSync(bookPath);
    ensureDirSync(join(bookPath, 'chapters'));
    
    // 写入书籍配置 book.json
    const bookConfig = {
      id: bookId,
      title: title || "无标题",
      genre: genre || "xuanhuan",
      chapterWords: parseInt(chapterWords) || 3000,
      targetChapters: parseInt(targetChapters) || 200,
      platform: "tomato",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "planning"
    };
    writeFileSync(join(bookPath, 'book.json'), JSON.stringify(bookConfig, null, 2));
    
    // 如果有简介，写入 brief.md
    if (brief) {
      writeFileSync(join(bookPath, 'brief.md'), brief);
    }
    
    res.json({ success: true, message: '书籍创建成功' });
  } catch (e) {
    console.error(`[API ERROR] /api/books: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Delete book
app.delete('/api/books/:id', async (req, res) => {
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  try {
    const bookDir = findBookDir(req.params.id, userProjectsDir);
    if (!bookDir) {
      return res.status(404).json({ error: '书籍不存在' });
    }
    const { rmSync } = await import('fs');
    rmSync(bookDir, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Share / Export Book
app.get('/api/books/:id/share', async (req, res) => {
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  try {
    const bookDir = findBookDir(req.params.id, userProjectsDir);
    if (!bookDir) {
      return res.status(404).json({ error: '书籍不存在' });
    }
    
    // Read book title to be used as zip filename
    let title = 'book';
    const bookJsonPath = join(bookDir, 'book.json');
    if (existsSync(bookJsonPath)) {
      try {
        const info = JSON.parse(readFileSync(bookJsonPath, 'utf-8'));
        if (info.title) title = info.title;
      } catch (e) {}
    }
    
    const zip = new AdmZip();
    zip.addLocalFolder(bookDir);
    const zipBuffer = zip.toBuffer();
    
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.zip"`);
    res.set('Content-Type', 'application/zip');
    res.send(zipBuffer);
  } catch (e) {
    console.error(`[API ERROR] /api/books/:id/share: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Import Book
app.post('/api/books/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未上传任何文件' });
  }
  
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  const projectName = 'default';
  const projectPath = join(userProjectsDir, projectName);
  const booksDir = join(projectPath, 'books');
  
  try {
    // Make sure project and books directories exist
    if (!existsSync(booksDir)) {
      ensureDirSync(booksDir);
    }
    
    const zip = new AdmZip(req.file.buffer);
    const zipEntries = zip.getEntries();
    
    // Validate if it's a valid book (must have book.json at root level of zip or inside a wrapper folder)
    let bookJsonEntry = null;
    let wrapperFolder = '';
    
    for (const entry of zipEntries) {
      if (entry.entryName === 'book.json') {
        bookJsonEntry = entry;
        wrapperFolder = '';
        break;
      } else if (entry.entryName.endsWith('/book.json') && entry.entryName.split('/').length === 2) {
        bookJsonEntry = entry;
        wrapperFolder = entry.entryName.split('/')[0] + '/';
        break;
      }
    }
    
    if (!bookJsonEntry) {
      return res.status(400).json({ error: '无效的书籍包：找不到 book.json' });
    }
    
    // Read book metadata to get/generate an ID
    const bookJsonContent = bookJsonEntry.getData().toString('utf8');
    let bookInfo;
    try {
      bookInfo = JSON.parse(bookJsonContent);
    } catch (e) {
      return res.status(400).json({ error: '解析书籍数据失败' });
    }
    
    // Create new book directory using logic or random string to avoid collision
    const newBookId = bookInfo.id || `imported_${Date.now()}`;
    const targetBookDir = join(booksDir, newBookId);
    
    if (existsSync(targetBookDir)) {
      return res.status(400).json({ error: '具有相同引用的书记已存在' });
    }
    
    ensureDirSync(targetBookDir);
    
    // Extract everything to the target book directory
    if (wrapperFolder === '') {
       zip.extractAllTo(targetBookDir, true);
    } else {
       // If there is a wrapper folder, we need to extract only contents without the folder
       // AdmZip doesn't support strip-components natively easily, so iterate
       zipEntries.forEach(entry => {
         if (entry.entryName.startsWith(wrapperFolder)) {
           const relativePath = entry.entryName.substring(wrapperFolder.length);
           if (relativePath) {
              if (entry.isDirectory) {
                 ensureDirSync(join(targetBookDir, relativePath));
              } else {
                 const destPath = join(targetBookDir, relativePath);
                 const destDir = dirname(destPath);
                 if (!existsSync(destDir)) ensureDirSync(destDir);
                 writeFileSync(destPath, entry.getData());
              }
           }
         }
       });
    }
    
    res.json({ success: true, message: '书籍导入成功' });
  } catch (e) {
    console.error(`[API ERROR] /api/books/import: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Helper to find book directory
function findBookDir(bookId, projectsDir) {
  const projectPath = join(projectsDir, 'default');
  const booksDir = join(projectPath, 'books');
  
  if (!existsSync(booksDir)) return null;
  
  const dirs = readdirSync(booksDir);
  for (const dir of dirs) {
    const dirPath = join(booksDir, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    
    const bookJson = join(dirPath, 'book.json');
    if (existsSync(bookJson)) {
      try {
        const info = JSON.parse(readFileSync(bookJson, 'utf-8'));
        if (info.id === bookId) {
          return dirPath;
        }
      } catch { /* continue */ }
    }
    
    // Also check if directory name matches
    if (dir === bookId) {
      return dirPath;
    }
  }
  
  return null;
}

// Get chapters
app.get('/api/books/:id/chapters', (req, res) => {
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  try {
    const bookDir = findBookDir(req.params.id, userProjectsDir);
    if (!bookDir) {
      return res.json({ chapters: [] });
    }
    
    const chaptersDir = join(bookDir, 'chapters');
    if (!existsSync(chaptersDir)) {
      return res.json({ chapters: [] });
    }
    
    // Try to read index.json first
    const indexFile = join(chaptersDir, 'index.json');
    if (existsSync(indexFile)) {
      try {
        const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
        const chapters = index.map(ch => {
          // Find matching file
          const files = readdirSync(chaptersDir).filter(f => f.endsWith('.md'));
          const filename = files.find(f => f.startsWith(String(ch.number).padStart(4, '0'))) || `${String(ch.number).padStart(4, '0')}_${ch.title}.md`;
          
          return {
            filename,
            title: ch.title,
            chapterNum: ch.number,
            wordCount: ch.wordCount || 0,
            status: ch.status,
            audited: ch.status === 'approved' || (ch.auditIssues && ch.auditIssues.length === 0)
          };
        });
        
        return res.json({ chapters });
      } catch { /* fallback to file scan */ }
    }
    
    // Fallback: scan files
    const files = readdirSync(chaptersDir).filter(f => f.endsWith('.md')).sort();
    const chapters = files.map(file => {
      const content = readFileSync(join(chaptersDir, file), 'utf-8');
      const lines = content.split('\n');
      let title = '';
      
      for (const line of lines) {
        if (line.startsWith('#')) {
          title = line.replace(/^#+\s*/, '').trim();
          break;
        }
        if (line.trim()) {
          title = line.trim();
          break;
        }
      }
      
      const match = file.match(/^(\d+)_/);
      const chapterNum = match ? parseInt(match[1]) : 0;
      
      return {
        filename: file,
        title: title || file.replace('.md', ''),
        chapterNum,
        wordCount: content.length,
        audited: false
      };
    });
    
    res.json({ chapters });
  } catch (e) {
    res.json({ chapters: [] });
  }
});

// Get single chapter content
app.get('/api/books/:id/chapter/:filename', (req, res) => {
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  try {
    const bookDir = findBookDir(req.params.id, userProjectsDir);
    if (!bookDir) {
      return res.status(404).json({ error: 'Book not found' });
    }
    
    const chaptersDir = join(bookDir, 'chapters');
    const chapterFile = join(chaptersDir, req.params.filename);
    
    if (!existsSync(chapterFile)) {
      return res.status(404).json({ error: 'Chapter not found' });
    }
    
    const content = readFileSync(chapterFile, 'utf-8');
    const lines = content.split('\n');
    let title = '';
    
    for (const line of lines) {
      if (line.startsWith('#')) {
        title = line.replace(/^#+\s*/, '').trim();
        break;
      }
    }
    
    res.json({ 
      filename: req.params.filename,
      title: title || req.params.filename,
      content 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Store active writing processes
const activeProcesses = new Map();

// Get writing status (active books)
app.get('/api/writing-status', (req, res) => {
  res.json({ active: Array.from(activeProcesses.keys()) });
});

// Write next chapter with streaming progress
app.get('/api/books/:id/write', async (req, res) => {
  const { context, words, count: rawCount } = req.query;
  const count = parseInt(rawCount) || 1;
  const bookId = req.params.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  const existingProcess = activeProcesses.get(bookId);
  if (existingProcess) {
    existingProcess.subscribers.push(res);
    sendEvent({ type: 'start', message: '💡 已重新连接到写作进程...', targetChapters: existingProcess.targetChapters, currentChapters: existingProcess.beforeFiles });
    if (existingProcess.previewContent) {
      sendEvent({ type: 'content_update', content: existingProcess.previewContent, totalLength: existingProcess.output.length, filename: '' });
    }
    existingProcess.logs.slice(-15).forEach(log => {
      sendEvent({ type: 'status', message: log });
    });
    req.on('close', () => {
      existingProcess.subscribers = existingProcess.subscribers.filter(s => s !== res);
    });
    return;
  }
  
  let child = null;
  let progressInterval = null;
  let heartbeatInterval = null;
  
  const cleanup = () => {
    if (progressInterval) clearInterval(progressInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    activeProcesses.delete(bookId);
  };
  
  try {
    const userProjectsDir = getEffectiveProjectsDir(req.user.id);
    const userEnvFile = getUserEnvFile(req.user.id);
    const projectPath = join(userProjectsDir, 'default');
    const bookDir = findBookDir(bookId, userProjectsDir);
    
    if (!bookDir) {
      sendEvent({ type: 'error', message: '书籍不存在' });
      return res.end();
    }
    
    // === 前置校验：API Key ===
    const llmEnvCheck = getUserLlmEnv(userEnvFile);
    if (!llmEnvCheck.INKOS_LLM_API_KEY) {
      sendEvent({ type: 'error', message: '❌ 请先在设置页面配置 API Key 后再开始写作' });
      return res.end();
    }

    // 写作前确保 inkos.json 格式正确（去 BOM + 字段修正）
    const inkosConfigPath = join(projectPath, 'inkos.json');
    if (existsSync(inkosConfigPath)) {
      try {
        const cfg = readJsonSafe(inkosConfigPath);
        let needsWrite = false;
        if (!cfg.name) { cfg.name = 'default'; needsWrite = true; }
        if (cfg.version !== '0.1.0') { cfg.version = '0.1.0'; needsWrite = true; }
        if (!cfg.language) { cfg.language = 'zh'; needsWrite = true; }
        if (cfg.llm && cfg.llm.configSource === 'studio') {
          delete cfg.llm.configSource;
          needsWrite = true;
          console.log('[WRITE] 移除 inkos.json configSource=studio，恢复 env 兼容');
        }
        if (cfg.project) { delete cfg.project; needsWrite = true; }
        // 始终重写以确保去除 BOM
        writeFileSync(inkosConfigPath, JSON.stringify(cfg, null, 2), 'utf-8');
        if (needsWrite) console.log('[WRITE] 已修正 inkos.json');
      } catch (e) { console.warn('[WRITE] inkos.json 修复失败:', e.message); }
    }
    
    const chaptersDir = join(bookDir, 'chapters');
    if (!existsSync(chaptersDir)) {
      ensureDirSync(chaptersDir);
    }
    
    // Get current chapter count
    const beforeFiles = existsSync(chaptersDir) 
      ? readdirSync(chaptersDir).filter(f => f.endsWith('.md')).length 
      : 0;
    
    sendEvent({ type: 'start', message: '准备开始写作...', currentChapters: beforeFiles, targetChapters: count });
    
    // Get book title for status display
    let bookTitle = bookId;
    const bookInfo = getBookInfo(bookDir);
    if (bookInfo && bookInfo.title) bookTitle = bookInfo.title;
    
    // Clear any stale lock files
    const lockFile = join(bookDir, '.write.lock');
    if (existsSync(lockFile)) {
      try {
        const lockContent = readFileSync(lockFile, 'utf-8');
        const lockData = JSON.parse(lockContent);
        if (Date.now() - lockData.ts > 300000) {
          unlinkSync(lockFile);
          sendEvent({ type: 'status', message: '清除旧锁文件...' });
        }
      } catch {
        try { unlinkSync(lockFile); } catch {}
      }
    }
    
    // Build command
    let cmd = `write next ${bookId}`;
    
    // Inject quality guidelines to reduce post-write audit failures
    const qualityRules = [
      '【写作铁律 - 违反任何一条都会导致整章被退回重写，务必逐条检查】',
      '',
      '★★★ 最高优先级（error级，必须100%遵守）：',
      '1. 全文不得出现任何破折号「——」！这是最严格的红线！需要解释、补充时用逗号断开，或改写句式。再次强调：一个破折号都不能有！',
      '2. 不得使用「不是……而是……」句式，用"并非""实则""其实"等改写',
      '',
      '★★ 高优先级（warning级但极易触发）：',
      '3. "仿佛"全章只能出现0-1次，多余的必须用"好似""宛如""犹如""恍若""好比"轮换，绝不重复使用同一个替代词',
      '4. "猛地"全章只能出现0-1次，用"骤然""倏地""霍然""陡然"替代',
      '5. 转折/惊讶类词汇（仿佛、猛地、忽然、突然、竟然、居然）全章合计不超过2次',
      '6. "不过""然而""但是"等转折词，同一个转折词全章最多用2次，不同转折词交替使用，避免公式化',
      '7. 不得连续3句以上包含"了"字，写完每段后自查是否有连续"了"字',
      '8. "似乎""可能""或许""大概""好像"这类模糊词，每千字不超过2个',
      '',
      '★ 一般规则：',
      '9. 不要用"显然""毫无疑问""不言而喻"等说教词',
      '10. 不要写"接下来就是""让我们""故事到了这里"等编剧旁白',
      '11. 避免连续3句以上用相同词语/结构开头',
      '12. 长短句交替，句式多变，体现文学性',
    ].join('\n');
    
    // Combine quality rules + user context
    const fullContext = context 
      ? `${qualityRules}。\n\n【用户补充指令】${context}`
      : qualityRules;
    
    // Write context to file to avoid shell escaping issues
    const contextFile = join(bookDir, '.write-context.md');
    writeFileSync(contextFile, fullContext);
    
    // Build args array to safely handle paths with spaces
    const { spawn } = await import('child_process');
    // 在云端直接使用 npx 调用，不再使用硬编码的 AppData 路径
    const spawnArgs = ['inkos', 'write', 'next', bookId, '--context-file', contextFile];
    if (words) spawnArgs.push('--words', words);
    spawnArgs.push('--count', String(count));
    // 注意：不使用 --json，因为 Windows 下 process.exit(1) 在 stdout flush 前执行会丢失错误信息
    // 改为从 stderr 捕获 [ERROR] 前缀的错误日志（更可靠）
    
    // Start writing process
    // 在 Windows 环境下直接使用 node 运行 dist 文件，解决 npx 权限和路径问题
    // 禁用 shell: true 以避免 Windows 路径解析错误（特别是带空格或特殊字符的情况）
    child = spawn('node', [INKOS_CLI_PATH, ...spawnArgs.slice(1)], {
      cwd: projectPath,
      env: { 
        ...process.env, 
        ...getUserLlmEnv(userEnvFile),
        INKOS_HOME,
        INKOS_PROJECT_PATH: projectPath
      },
      shell: false
    });
    
    // 注册代理目标（用于推理模型代理）
    const userEnvData = readEnv(userEnvFile);
    const decryptedKey = decryptApiKey(userEnvData.INKOS_LLM_API_KEY || '');
    if (userEnvData.INKOS_LLM_PROXY_TARGET && decryptedKey) {
      proxyTargets.set(decryptedKey, userEnvData.INKOS_LLM_PROXY_TARGET);
    }
    
    // Store process for potential cancellation and reconnection
    const processInfo = { 
      child, bookDir, chaptersDir, beforeFiles, 
      output: '', previewContent: '', logs: [], 
      subscribers: [res], targetChapters: count,
      userId: req.user.id, userEnvFile, decryptedKey
    };
    activeProcesses.set(bookId, processInfo);
    
    const broadcast = (data) => {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      processInfo.subscribers.forEach(s => {
        try { s.write(payload); } catch { /* ignore */ }
      });
    };
    
    // Initial progress event
    const actualFirstCh = beforeFiles + 1;
    broadcast({ type: 'progress', chapter: actualFirstCh, message: `开始创作第${actualFirstCh}章... (本次还剩${count}章)` });
    
    let lastChapterCount = beforeFiles;
    let currentChapter = 0;
    // lastContentLength removed as we don't poll the file for live updates anymore

    
    // ====== Auto-fix chapter after write ======
    async function autoFixChapter(filePath, chapterNum) {
      try {
        let content = readFileSync(filePath, 'utf-8');
        let fixes = [];
        
        // === Round 1: Regex-based mechanical fixes ===
        // Fix dashes (error level — highest priority)
        if (content.includes('——')) {
          const dashCount = (content.match(/——/g) || []).length;
          content = content.replace(/——/g, '，');
          fixes.push(`破折号「——」×${dashCount} → 逗号`);
        }
        
        // Fix 「不是……而是……」pattern
        const buShiPattern = /不是([^，。！？\n]{1,20})而是/g;
        if (buShiPattern.test(content)) {
          content = content.replace(/不是([^，。！？\n]{1,20})而是/g, '并非$1实则');
          fixes.push('「不是…而是…」→「并非…实则…」');
        }
        
        // If round 1 made changes, save immediately
        if (fixes.length > 0) {
          writeFileSync(filePath, content, 'utf-8');
          broadcast({ type: 'status', message: `🔧 第${chapterNum}章机械修复: ${fixes.join(', ')}` });
        }
        
        // === Round 2: 纯机械修复 ===
        // 替换词典（每个词按顺序轮换使用）
        const mechReplacements = {
          '仿佛': ['好似', '宛如', '犹如', '恍若', '好比'],
          '猛地': ['骤然', '倏地', '霍然', '陡然', '猝然'],
          '显然': ['显而易见', '不难看出', '明显', '可以看出', '清楚地'],
          '毫无疑问': ['毋庸置疑', '无可否认', '确实', '的确如此'],
          '不言而喻': ['不难理解', '自然明了', '可想而知'],
          '似乎': ['好似', '看来', '约莫', '大抵'],
          '可能': ['或许', '大约', '也许', '未必不是'],
          '或许': ['说不定', '也未可知', '大概', '到底'],
          '大概': ['约莫', '想必', '应该是', '差不多'],
          '好像': ['宛如', '仿若', '犹似', '像是'],
        };
        const mechCounters = {};
        
        function mechReplace(word, count, maxCount) {
          // 保留前 maxCount 次不动，替换超出的那些
          let kept = 0;
          return content.replace(new RegExp(word, 'g'), (match) => {
            kept++;
            if (kept <= maxCount) return match;
            const synonyms = mechReplacements[word] || [];
            if (!mechCounters[word]) mechCounters[word] = 0;
            const rep = synonyms[mechCounters[word] % synonyms.length] || match;
            mechCounters[word]++;
            return rep;
          });
        }
        
        const r2Fixes = [];
        
        // 高频词：仿佛/猛地 上限1，显然/毫无疑问/不言而喻 上限0
        const freqWords = { '仿佛': 1, '猛地': 1, '显然': 0, '毫无疑问': 0, '不言而喻': 0 };
        for (const [word, maxCount] of Object.entries(freqWords)) {
          const matches = content.match(new RegExp(word, 'g'));
          if (matches && matches.length > maxCount) {
            content = mechReplace(word, matches.length, maxCount);
            r2Fixes.push(`"${word}"×${matches.length}→保留${maxCount}次，其余轮换替换`);
          }
        }
        
        // 套话词密度超限时，轮换替换超出部分
        const fuzzyWords = ['似乎', '可能', '或许', '大概', '好像'];
        let fuzzyCount = 0;
        for (const w of fuzzyWords) { fuzzyCount += (content.match(new RegExp(w, 'g')) || []).length; }
        const fuzzyDensity = fuzzyCount / (content.length / 1000);
        if (fuzzyDensity > 3) {
          // 允许每千字最多3个套话词，替换多出来的
          const allowedTotal = Math.floor(content.length / 1000 * 3);
          let replaced = 0;
          for (const w of fuzzyWords) {
            const wMatches = content.match(new RegExp(w, 'g')) || [];
            if (wMatches.length > 0) {
              let localKept = 0;
              content = content.replace(new RegExp(w, 'g'), (match) => {
                if (replaced >= (fuzzyCount - allowedTotal)) return match;
                localKept++;
                const synonyms = mechReplacements[w] || [];
                if (!mechCounters[w]) mechCounters[w] = 0;
                const rep = synonyms[mechCounters[w] % synonyms.length] || match;
                mechCounters[w]++;
                replaced++;
                return rep;
              });
            }
          }
          r2Fixes.push(`套话词密度${fuzzyDensity.toFixed(1)}/千字→机械替换${replaced}处`);
        }
        
        if (r2Fixes.length > 0) {
          writeFileSync(filePath, content, 'utf-8');
          broadcast({ type: 'status', message: `🔧 第${chapterNum}章Round2机械修复: ${r2Fixes.join(', ')}` });
        } else {
          broadcast({ type: 'status', message: `✅ 第${chapterNum}章检查通过，无需修复` });
        }
      } catch (e) {
        console.error(`[AUTO-FIX] Error fixing chapter ${chapterNum}: ${e.message}`);
      }
    }
    
    // Monitor progress by checking files
    progressInterval = setInterval(async () => {
      if (!existsSync(chaptersDir)) return;
      
      const currentFiles = readdirSync(chaptersDir).filter(f => f.endsWith('.md'));
      const newCount = currentFiles.length;
      
      if (newCount > lastChapterCount) {
        currentChapter = newCount - beforeFiles;
        const actualCh = newCount;
        const remainingCh = Math.max(0, count - currentChapter);
        const newFile = currentFiles.sort().pop();
        const filePath = join(chaptersDir, newFile);
        
        try {
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          let title = newFile;
          for (const line of lines) {
            if (line.startsWith('#')) {
              title = line.replace(/^#+\s*/, '').trim();
              break;
            }
          }
          
          broadcast({ 
            type: 'chapter_complete', 
            chapter: currentChapter,
            actualChapter: actualCh,
            title,
            wordCount: content.length,
            message: `第${actualCh}章《${title}》已完成，共${content.length}字`
          });
          
          // Auto-fix the completed chapter
          autoFixChapter(filePath, actualCh);
        } catch { /* ignore */ }
        
        lastChapterCount = newCount;
        
        // If more chapters are to be written this session, announce the next one
        const writtenThisSession = newCount - beforeFiles;
        if (count > writtenThisSession) {
          const nextCh = newCount + 1;
          const remaining = count - writtenThisSession;
          
          // Give the UI a moment, then emit progress for the next chapter
          setTimeout(() => {
            processInfo.previewContent = '';
            broadcast({ type: 'content_clear' });
            broadcast({ type: 'progress', chapter: nextCh, message: `开始创作第${nextCh}章... (本次还剩${remaining}章)` });
          }, 1000);
        }
      }
    }, 2000);
    
    // Note: live content streaming is handled purely by the child process stdout listener above.
    
    // Send periodic heartbeats with current status
    heartbeatInterval = setInterval(() => {
      const actualCh = lastChapterCount + 1;
      const writtenThisSession = lastChapterCount - beforeFiles;
      const remainingCh = Math.max(0, count - writtenThisSession);
      broadcast({ type: 'heartbeat', message: `正在创建第 ${actualCh} 章，本次任务还有 ${remainingCh} 章待创建` });
    }, 5000);
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      processInfo.output += text;
      
      const nonJsonLines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('{'));
      if (nonJsonLines.length > 0) {
        const chunk = nonJsonLines.join('\n');
        processInfo.previewContent += chunk;
        broadcast({ type: 'content_update', content: chunk, totalLength: processInfo.output.length, filename: '' });
      }
      
      try {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('{')) {
            const json = JSON.parse(line);
            if (json.status) {
              processInfo.logs.push(json.status);
              broadcast({ type: 'status', message: json.status });
            }
            if (json.chapter) {
              const actualCh = beforeFiles + json.chapter;
              const remainingCh = Math.max(0, count - json.chapter);
              broadcast({ type: 'progress', chapter: actualCh, message: `开始创作第${actualCh}章... (本次还剩${remainingCh}章)` });
            }
            // CLI 在 --json 模式下将错误写入 stdout，此处捕获并广播给 UI
            if (json.error) {
              const errMsg = String(json.error);
              processInfo.logs.push(errMsg);
              broadcast({ type: 'status', message: `❌ ${errMsg}` });
              console.error(`[CLI JSON ERROR] ${errMsg}`);
            }
          }
        }
      } catch { /* not JSON, ignore */ }
    });
    
    processInfo.stderr = '';
    child.stderr.on('data', (data) => {
      const msg = data.toString();
      processInfo.stderr += msg;
      console.error(`[CLI STDERR] ${msg}`);
      // Push specific error markers to UI for faster feedback
      if (msg.includes('Error:') || msg.includes('FAILED')) {
        broadcast({ type: 'status', message: `⚠️ ${msg.trim()}` });
      }
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        broadcast({ 
          type: 'complete', 
          message: '写作完成！',
          output: processInfo.output.slice(-500)
        });
      } else if (code === null) {
        broadcast({ 
          type: 'cancelled', 
          message: '写作已取消'
        });
      } else {
        // 从 stderr 提取真实错误（非 --json 模式，错误通过 logError 写入 stderr）
        const stderrLines = (processInfo.stderr || '').split('\n').filter(Boolean);
        const errorLine = stderrLines.find(l => l.includes('[ERROR]') || l.includes('Error:') || l.includes('error:'))
          || stderrLines[stderrLines.length - 1]
          || '';
        
        // 去掉 [ERROR] 前缀，提取核心错误信息
        const cleanError = errorLine
          .replace(/^\[ERROR\]\s*Failed to write chapter:\s*/i, '')
          .replace(/^\[ERROR\]\s*/i, '')
          .trim() || '进程运行失败';
        
        broadcast({ 
          type: 'error', 
          message: `写作过程出错: ${cleanError} (码: ${code})`,
          output: processInfo.output.slice(-500)
        });
      }
      // Note: we do not end all subscribers' response objects cleanly (they might close naturally),
      // or we can end them manually.
      processInfo.subscribers.forEach(s => {
        try { s.end(); } catch {}
      });
      // 清理代理目标注册
      if (processInfo.decryptedKey) proxyTargets.delete(processInfo.decryptedKey);
      cleanup();
    });
    
    child.on('error', (err) => {
      broadcast({ type: 'error', message: err.message });
      processInfo.subscribers.forEach(s => {
        try { s.end(); } catch {}
      });
      cleanup();
    });
    
  } catch (e) {
    cleanup();
    sendEvent({ type: 'error', message: e.message });
    res.end();
  }
});

// Stop writing
app.post('/api/books/:id/stop', (req, res) => {
  const bookId = req.params.id;
  const processInfo = activeProcesses.get(bookId);
  
  if (!processInfo) {
    return res.json({ success: false, message: '没有正在进行的写作' });
  }
  
  try {
    const { child, bookDir, chaptersDir, beforeFiles } = processInfo;
    
    // Kill the process
    child.kill('SIGTERM');
    
    // Delete the newly created chapter files (if any)
    setTimeout(() => {
      try {
        if (existsSync(chaptersDir)) {
          const currentFiles = readdirSync(chaptersDir)
            .filter(f => f.endsWith('.md'))
            .map(f => ({ name: f, mtime: statSync(join(chaptersDir, f)).mtimeMs }))
            .sort((a, b) => a.mtime - b.mtime)  // sort by modification time ascending
            .map(f => f.name);
          const newFiles = currentFiles.slice(beforeFiles);
          
          for (const file of newFiles) {
            unlinkSync(join(chaptersDir, file));
          }
          
          // Also update index.json if it exists
          const indexFile = join(chaptersDir, 'index.json');
          if (existsSync(indexFile)) {
            const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
            const updatedIndex = index.slice(0, beforeFiles);
            writeFileSync(indexFile, JSON.stringify(updatedIndex, null, 2));
          }
        }
        
        // Delete lock file
        const lockFile = join(bookDir, '.write.lock');
        if (existsSync(lockFile)) {
          unlinkSync(lockFile);
        }
      } catch (e) {
        console.error('Error cleaning up:', e);
      }
    }, 1000);
    
    activeProcesses.delete(bookId);
    res.json({ success: true, message: '写作已停止，新创作的章节已删除' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Draft chapter
app.get('/api/books/:id/draft', async (req, res) => {
  const { context, words } = req.query;
  const bookId = req.params.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  
  try {
    const userProjectsDir = getEffectiveProjectsDir(req.user.id);
    const userEnvFile = getUserEnvFile(req.user.id);
    const projectPath = join(userProjectsDir, 'default');
    const bookDir = findBookDir(bookId, userProjectsDir);
    
    const args = ['draft', bookId];
    
    if (context) {
      const contextFile = join(bookDir || projectPath, '.draft-context.md');
      writeFileSync(contextFile, context);
      args.push('--context-file', contextFile);
    }
    if (words) args.push('--words', words);
    args.push('--json');
    
    sendEvent({ type: 'start', message: '开始写草稿...' });
    
    const { spawn } = await import('child_process');
    const child = spawn('node', [INKOS_CLI_PATH, 'draft', ...args.slice(1)], {
      cwd: projectPath,
      env: { 
        ...process.env, 
        ...getUserLlmEnv(userEnvFile),
        INKOS_HOME,
        INKOS_PROJECT_PATH: projectPath
      },
      shell: false
    });
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      const nonJsonLines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('{'));
      if (nonJsonLines.length > 0) {
        sendEvent({ type: 'content_update', content: nonJsonLines.join('\n'), totalLength: nonJsonLines.join('').length, filename: '' });
      }
      try {
        text.split('\n').forEach(line => {
          if (line.trim().startsWith('{')) {
            const json = JSON.parse(line);
            if (json.status) sendEvent({ type: 'status', message: json.status });
          }
        });
      } catch { /* not JSON, ignore */ }
    });
    
    child.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        sendEvent({ type: 'error', message: msg });
      }
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        sendEvent({ type: 'complete', message: '草稿完成！' });
      } else if (code !== null) {
        sendEvent({ type: 'error', message: `草稿失败 (退出码: ${code})` });
      }
      res.end();
    });
    
    child.on('error', (err) => {
      sendEvent({ type: 'error', message: err.message });
      res.end();
    });
    
  } catch (e) {
    sendEvent({ type: 'error', message: `错误: ${e.message}` });
    res.end();
  }
});

// Audit chapter
app.post('/api/books/:id/audit', async (req, res) => {
  const { chapter } = req.body;
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  const userEnvFile = getUserEnvFile(req.user.id);
  
  try {
    const projectPath = join(userProjectsDir, 'default');
    const { stdout } = await runInkos(`audit ${req.params.id} ${chapter} --json`, projectPath, getUserLlmEnv(userEnvFile));
    
    try {
      const data = JSON.parse(stdout);
      res.json({ success: true, result: data });
    } catch {
      res.json({ success: true, output: stdout });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get config
app.get('/api/config', (req, res) => {
  const userEnvFile = getUserEnvFile(req.user.id);
  const env = readEnv(userEnvFile);
  // Return the real base URL (not the proxy), so the user sees the actual setting
  const realBaseUrl = env.INKOS_LLM_PROXY_TARGET || env.INKOS_LLM_BASE_URL || '';
  // 解密 API Key 用于前端掩码显示
  const decryptedKey = decryptApiKey(env.INKOS_LLM_API_KEY || '');
  res.json({
    provider: env.INKOS_LLM_PROVIDER || '',
    baseUrl: realBaseUrl,
    apiKey: decryptedKey,
    model: env.INKOS_LLM_MODEL || '',
    projectsDir: getEffectiveProjectsDir(req.user.id)
  });
});

// Save config
app.post('/api/config', (req, res) => {
  const { provider, baseUrl, apiKey, model, projectsDir } = req.body;
  const userEnvFile = getUserEnvFile(req.user.id);
  
  const env = readEnv(userEnvFile);
  if (provider !== undefined) env.INKOS_LLM_PROVIDER = provider;
  if (apiKey !== undefined && apiKey !== '') env.INKOS_LLM_API_KEY = encryptApiKey(apiKey);
  if (model !== undefined) env.INKOS_LLM_MODEL = model;
  
  if (projectsDir !== undefined && projectsDir.trim()) {
    env.INKOS_PROJECTS_DIR = projectsDir.trim();
    if (!existsSync(projectsDir.trim())) {
      ensureDirSync(projectsDir.trim());
    }
  }
  
  // Auto-detect reasoning model and route through local proxy
  const isReasoningModel = model && (model.includes('reasoner') || model.includes('thinking') || model.includes('r1'));
  
  if (baseUrl !== undefined) {
    if (isReasoningModel) {
      // Save real URL as proxy target, point inkos to local proxy
      env.INKOS_LLM_PROXY_TARGET = baseUrl;
      env.INKOS_LLM_BASE_URL = `http://localhost:${PORT}/llm-proxy`;
      console.log(`[CONFIG] Reasoning model detected (${model}), routing through local proxy`);
    } else {
      // Normal model: direct connection
      env.INKOS_LLM_BASE_URL = baseUrl;
      delete env.INKOS_LLM_PROXY_TARGET;
    }
  }
  
  writeEnv(userEnvFile, env);
  res.json({ success: true, proxyEnabled: isReasoningModel });
});

// Open folder in system file manager
app.post('/api/open-folder', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: '路径不能为空' });
  }
  if (!existsSync(folderPath)) {
    return res.status(400).json({ error: '路径不存在' });
  }
  try {
    const cmd = process.platform === 'win32'
      ? `explorer "${folderPath}"`
      : process.platform === 'darwin'
        ? `open "${folderPath}"`
        : `xdg-open "${folderPath}"`;
    exec(cmd, (err) => {
      if (err) {
        return res.status(500).json({ error: '打开文件夹失败: ' + err.message });
      }
      res.json({ success: true });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Migrate projects data to new directory
app.post('/api/migrate-projects', (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ error: '新旧路径不能为空' });
  }
  if (oldPath === newPath) {
    return res.json({ success: true, message: '路径相同，无需迁移' });
  }
  if (!existsSync(oldPath)) {
    return res.json({ success: true, message: '旧路径不存在，跳过迁移' });
  }
  try {
    if (!existsSync(newPath)) {
      ensureDirSync(newPath);
    }
    const items = readdirSync(oldPath);
    let migratedCount = 0;
    for (const item of items) {
      const src = join(oldPath, item);
      const dst = join(newPath, item);
      if (existsSync(dst)) continue;
      renameSync(src, dst);
      migratedCount++;
    }
    res.json({ success: true, message: `已迁移 ${migratedCount} 个项目`, migratedCount });
  } catch (e) {
    try {
      const items = readdirSync(oldPath);
      let migratedCount = 0;
      for (const item of items) {
        const src = join(oldPath, item);
        const dst = join(newPath, item);
        if (existsSync(dst)) continue;
        try {
          renameSync(src, dst);
          migratedCount++;
        } catch (renameErr) {
          if (renameErr.code === 'EXDEV') {
            execSync(`xcopy "${src}" "${dst}" /E /I /H /Y`);
            rmSync(src, { recursive: true, force: true });
            migratedCount++;
          }
        }
      }
      res.json({ success: true, message: `已迁移 ${migratedCount} 个项目`, migratedCount });
    } catch (fallbackErr) {
      res.status(500).json({ error: '迁移失败: ' + fallbackErr.message });
    }
  }
});

// Context history storage (per-user)
function getContextHistory(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveContextHistory(filePath, history) {
  writeFileSync(filePath, JSON.stringify(history, null, 2));
}

// Get context history
app.get('/api/context/history', (req, res) => {
  const ctxFile = getUserContextHistoryFile(req.user.id);
  const bookId = req.query.bookId;
  let history = getContextHistory(ctxFile);
  
  if (bookId) {
    history = history.filter(h => h.bookId === bookId);
  }
  
  res.json({ history });
});

// Save context
app.post('/api/context/save', (req, res) => {
  const ctxFile = getUserContextHistoryFile(req.user.id);
  const { bookId, name, content } = req.body;
  
  if (!name || !content) {
    return res.status(400).json({ error: '名称和内容不能为空' });
  }
  
  const history = getContextHistory(ctxFile);
  
  const entry = {
    id: Date.now().toString(),
    bookId: bookId || 'global',
    name,
    content,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  history.unshift(entry);
  
  // Keep only last 50 entries
  if (history.length > 50) {
    history.length = 50;
  }
  
  saveContextHistory(ctxFile, history);
  res.json({ success: true, entry });
});

// Delete context
app.delete('/api/context/:id', (req, res) => {
  const ctxFile = getUserContextHistoryFile(req.user.id);
  let history = getContextHistory(ctxFile);
  history = history.filter(h => h.id !== req.params.id);
  saveContextHistory(ctxFile, history);
  res.json({ success: true });
});

// Execute terminal command
app.post('/api/terminal', async (req, res) => {
  const { command } = req.body;
  const userProjectsDir = getEffectiveProjectsDir(req.user.id);
  const userEnvFile = getUserEnvFile(req.user.id);
  
  try {
    const projectPath = join(userProjectsDir, 'default');
    const { stdout, stderr } = await runInkos(command, projectPath, getUserLlmEnv(userEnvFile));
    res.json({ output: stdout || stderr });
  } catch (e) {
    res.json({ output: `错误: ${e.message}` });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// 定期清理过期游客数据被移除 (EXE环境不需要)

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🦞 InkOS Studio Is Running!
   Port: ${PORT}
   Mode: Cloud Ready
  `);
});
