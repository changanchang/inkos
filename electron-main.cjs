// electron-main.cjs
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const net = require('net');

// 寻找空闲端口的辅助函数
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// 主题颜色映射
const THEME_COLORS = {
  dark: {
    color: '#0f111a',
    symbolColor: '#a78bfa',
  },
  light: {
    color: '#f0f2f8',
    symbolColor: '#4f46e5',
  }
};

let mainWindow;

async function createWindow() {
  // 1. 获取一个空闲端口号
  const port = await getFreePort();
  
  // 2. 将端口号设置为环境变量，供 server.js 读取
  process.env.PORT = port;

  console.log(`[Electron] Starting internal backend on port ${port}...`);
  // 3. 动态引入后端的 ES Module (因为 server.js 是 type="module")
  try {
    const serverPath = path.join(__dirname, 'src', 'server.js');
    import(require('url').pathToFileURL(serverPath).href);
  } catch (err) {
    console.error('Failed to load server.js:', err);
  }

  // 4. 创建原生的桌面窗口
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#0f111a'
  });

  // 设置特殊的 User-Agent 供前端识别
  mainWindow.webContents.userAgent += ' InkOS-Desktop/1.0.3';

  // 取消默认的菜单栏
  mainWindow.setMenuBarVisibility(false);

  // 5. 等待 800ms 确保本地服务器完全开启后加载
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${port}`);
  }, 800);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('window-maximize-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('window-maximize-changed', false);
  });
}

// IPC：窗口控制
ipcMain.on('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on('window-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle('window-is-maximized', () => {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
});

// IPC：在系统文件管理器中打开并选中指定文件夹
ipcMain.handle('open-folder', async (event, folderPath) => {
  const fs = require('fs');
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { success: false, error: '路径不存在' };
  }
  try {
    await shell.openPath(folderPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC：弹出文件夹选择对话框
ipcMain.handle('select-folder', async (event, defaultPath) => {
  const fs = require('fs');
  const properties = ['openDirectory', 'createDirectory'];
  const options = { properties };
  if (defaultPath && fs.existsSync(defaultPath)) {
    options.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
