import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, delimiter } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import {
  verifyPassword, encryptApiKey, decryptApiKey,
  findUserByEmail, createUser, getUserProjectsDir, getUserEnvFile, getUserContextHistoryFile,
  createSession, getSession, deleteSession, parseCookies, requireAuth
} from './auth.js';
import multer from 'multer';
import AdmZip from 'adm-zip';

// Config multer for zip imports (use memory storage for processing directly)
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4567;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

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
    res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
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
  res.setHeader('Set-Cookie', `inkos_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`);
  res.json({ success: true, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['inkos_session'];
  if (token) deleteSession(token);
  res.setHeader('Set-Cookie', 'inkos_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ success: true });
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
      console.error(`[LLM-PROXY] upstream error ${upstream.status}: ${errText}`);
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
if (!existsSync(INKOS_HOME)) mkdirSync(INKOS_HOME, { recursive: true });

// Helper: 获取用户的 LLM 环境变量（解密 API Key），用于注入子进程
function getUserLlmEnv(userEnvFile) {
  const env = readEnv(userEnvFile);
  return {
    INKOS_LLM_API_KEY: decryptApiKey(env.INKOS_LLM_API_KEY || ''),
    INKOS_LLM_BASE_URL: env.INKOS_LLM_BASE_URL || '',
    INKOS_LLM_MODEL: env.INKOS_LLM_MODEL || '',
    INKOS_LLM_PROVIDER: env.INKOS_LLM_PROVIDER || '',
  };
}

// Helper to run inkos commands
function runInkos(command, cwd, extraEnv = {}) {
  console.log(`[EXECUTING] npx inkos ${command} IN ${cwd}`);
  return new Promise((resolve, reject) => {
    // 环境变量中不再硬编码 PATH，依靠云端环境默认 PATH
    exec(`npx inkos ${command}`, { 
      cwd, 
      env: { 
        ...process.env, 
        ...extraEnv 
      } 
    }, (error, stdout, stderr) => {
      if (error && !stdout) {
        console.error(`[EXEC ERROR] inkos ${command}: ${error.message}`);
        reject(error);
      } else {
        if (stderr) console.warn(`[EXEC STDERR] inkos ${command}: ${stderr}`);
        resolve({ stdout, stderr });
      }
    });
  });
}

// Helper to read .env file
function readEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
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
      return JSON.parse(readFileSync(bookJson, 'utf-8'));
    } catch {
      // continue
    }
  }
  
  // Fallback to book_info.json (old format)
  const infoFile = join(bookPath, 'book_info.json');
  if (existsSync(infoFile)) {
    try {
      return JSON.parse(readFileSync(infoFile, 'utf-8'));
    } catch {
      // continue
    }
  }
  
  return null;
}

// API Routes

// Get all books
app.get('/api/books', (req, res) => {
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
  const userEnvFile = getUserEnvFile(req.user.id);
  
  try {
    // Create project if not exists
    const projectName = 'default';
    const projectPath = join(userProjectsDir, projectName);
    
    if (!existsSync(projectPath)) {
      await runInkos(`init ${projectName}`, userProjectsDir, getUserLlmEnv(userEnvFile));
    }
    
    // Create book
    let cmd = `book create --title "${title}" --genre ${genre}`;
    if (chapterWords) cmd += ` --chapter-words ${chapterWords}`;
    if (targetChapters) cmd += ` --target-chapters ${targetChapters}`;
    if (brief) {
      const briefFile = join(projectPath, 'brief.md');
      writeFileSync(briefFile, brief);
      cmd += ` --context-file "${briefFile}"`;
    }
    
    await runInkos(cmd, projectPath, getUserLlmEnv(userEnvFile));
    
    res.json({ success: true, message: '书籍创建成功' });
  } catch (e) {
    console.error(`[API ERROR] /api/books: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Delete book
app.delete('/api/books/:id', async (req, res) => {
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
  
  const userProjectsDir = getUserProjectsDir(req.user.id);
  const projectName = 'default';
  const projectPath = join(userProjectsDir, projectName);
  const booksDir = join(projectPath, 'books');
  
  try {
    // Make sure project and books directories exist
    if (!existsSync(booksDir)) {
      mkdirSync(booksDir, { recursive: true });
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
    
    mkdirSync(targetBookDir, { recursive: true });
    
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
                 mkdirSync(join(targetBookDir, relativePath), { recursive: true });
              } else {
                 const destPath = join(targetBookDir, relativePath);
                 const destDir = dirname(destPath);
                 if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
    const userProjectsDir = getUserProjectsDir(req.user.id);
    const userEnvFile = getUserEnvFile(req.user.id);
    const projectPath = join(userProjectsDir, 'default');
    const bookDir = findBookDir(bookId, userProjectsDir);
    
    if (!bookDir) {
      sendEvent({ type: 'error', message: '书籍不存在' });
      return res.end();
    }
    
    const chaptersDir = join(bookDir, 'chapters');
    if (!existsSync(chaptersDir)) {
      mkdirSync(chaptersDir, { recursive: true });
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
    spawnArgs.push('--json');
    
    // Start writing process
    // 云端使用 npx 确保兼容性
    child = spawn('npx', spawnArgs, {
      cwd: projectPath,
      env: { ...process.env, ...getUserLlmEnv(userEnvFile) },
      shell: process.platform === 'win32'
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
          }
        }
      } catch { /* not JSON, ignore */ }
    });
    
    child.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        broadcast({ type: 'error', message: msg });
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
        broadcast({ 
          type: 'error', 
          message: `写作过程出错 (退出码: ${code})`,
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
    const userProjectsDir = getUserProjectsDir(req.user.id);
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
    const child = spawn('npx', ['inkos', ...args], {
      cwd: projectPath,
      env: { ...process.env, ...getUserLlmEnv(userEnvFile) },
      shell: process.platform === 'win32'
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
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
    projectsDir: getUserProjectsDir(req.user.id)
  });
});

// Save config
app.post('/api/config', (req, res) => {
  const { provider, baseUrl, apiKey, model } = req.body;
  const userEnvFile = getUserEnvFile(req.user.id);
  
  const env = readEnv(userEnvFile);
  if (provider !== undefined) env.INKOS_LLM_PROVIDER = provider;
  if (apiKey !== undefined) env.INKOS_LLM_API_KEY = encryptApiKey(apiKey);
  if (model !== undefined) env.INKOS_LLM_MODEL = model;
  
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
  const userProjectsDir = getUserProjectsDir(req.user.id);
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

// 定期清理过期游客数据 (每小时执行)
setInterval(() => {
  const GUESTS_DIR = join(INKOS_HOME, 'temp_guests');
  if (!existsSync(GUESTS_DIR)) return;

  try {
    const { rmSync } = await import('fs');
    const dirs = readdirSync(GUESTS_DIR);
    const now = Date.now();
    const MAX_AGE = 2 * 3600 * 1000; // 2小时

    dirs.forEach(dir => {
      const dirPath = join(GUESTS_DIR, dir);
      const stats = statSync(dirPath);
      if (now - stats.mtimeMs > MAX_AGE) {
        console.log(`[CLEANUP] 删除过期游客目录: ${dir}`);
        rmSync(dirPath, { recursive: true, force: true });
      }
    });
  } catch (e) {
    console.error(`[CLEANUP ERROR] ${e.message}`);
  }
}, 3600 * 1000);

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🦞 InkOS Studio Is Running!
   Port: ${PORT}
   Mode: Cloud Ready
  `);
});
