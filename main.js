'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let win;
let uIOhook;
let localApiServer = null;

// ══════════════════════════════════════════
//  永続化ユーティリティ（userData フォルダへ保存）
// ══════════════════════════════════════════
function userDataPath(filename) {
  return path.join(app.getPath('userData'), filename);
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(userDataPath(filename), 'utf-8')); }
  catch { return null; }
}

function writeJson(filename, obj) {
  try { fs.writeFileSync(userDataPath(filename), JSON.stringify(obj, null, 2), 'utf-8'); }
  catch (e) { console.warn('設定の保存に失敗:', e.message); }
}

// ══════════════════════════════════════════
//  ウィンドウ生成（前回の位置・サイズを復元）
// ══════════════════════════════════════════
function createWindow() {
  const saved = readJson('window-state.json');
  const DEFAULT = { width: 800, height: 600 };
  const bounds = saved || DEFAULT;

  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,  // preload で require('gifuct-js') 等を使うために必要
    },
  });

  // ウィンドウが移動・リサイズされたらデバウンスして保存
  let _saveBoundsTimer = null;
  const saveBounds = () => {
    clearTimeout(_saveBoundsTimer);
    _saveBoundsTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        writeJson('window-state.json', win.getBounds());
      }
    }, 500);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F12 で DevTools をトグル（エラー調査用）
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });

  // 開発時のみ DevTools を開く
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

// ══════════════════════════════════════════
//  プロジェクト保存 IPC
// ══════════════════════════════════════════
ipcMain.handle('save-project', async (_event, jsonStr) => {
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'プロジェクトを保存',
    defaultPath: 'gifvtbr-project.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { ok: false };
  fs.writeFileSync(filePath, jsonStr, 'utf-8');
  return { ok: true };
});

// ══════════════════════════════════════════
//  プロジェクト読込 IPC
// ══════════════════════════════════════════
ipcMain.handle('load-project', async () => {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'プロジェクトを開く',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (!filePaths || !filePaths[0]) return null;
  return fs.readFileSync(filePaths[0], 'utf-8');
});

// ══════════════════════════════════════════
//  アプリ設定 IPC（cfg の自動保存・復元）
// ══════════════════════════════════════════
ipcMain.handle('save-app-settings', (_event, jsonStr) => {
  try { writeJson('app-settings.json', JSON.parse(jsonStr)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-app-settings', () => {
  return readJson('app-settings.json');
});

// ══════════════════════════════════════════
//  前回プロジェクト IPC（起動時自動復元用）
// ══════════════════════════════════════════
ipcMain.handle('save-last-project', (_event, jsonStr) => {
  try { fs.writeFileSync(userDataPath('last-project.json'), jsonStr, 'utf-8'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-last-project', () => {
  try { return fs.readFileSync(userDataPath('last-project.json'), 'utf-8'); }
  catch { return null; }
});

// ══════════════════════════════════════════
//  ウィンドウ制御 IPC
// ══════════════════════════════════════════
ipcMain.handle('set-always-on-top', (_event, flag) => {
  win.setAlwaysOnTop(flag);
});

// ══════════════════════════════════════════
//  アプリ終了 IPC
// ══════════════════════════════════════════
ipcMain.handle('quit-app', () => {
  app.quit();
});

// ══════════════════════════════════════════
//  グローバルホットキー（uiohook-napi）
// ══════════════════════════════════════════
function startGlobalHotkey() {
  try {
    const { uIOhook: hook } = require('uiohook-napi');
    uIOhook = hook;

    // キーボード: keycode と Ctrl 修飾キーをレンダラーに送信
    uIOhook.on('keydown', (e) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('global-keydown', { keycode: e.keycode, ctrlKey: e.ctrlKey, altKey: e.altKey });
      }
    });

    // マウス移動: 設定値（mouseMs）をそのまま反映するためスロットリングなしで送信
    uIOhook.on('mousemove', () => {
      if (win && !win.isDestroyed()) win.webContents.send('global-mouse-active');
    });

    // マウスクリック: 即送信
    uIOhook.on('mousedown', () => {
      if (win && !win.isDestroyed()) win.webContents.send('global-mouse-active');
    });

    uIOhook.start();
  } catch (err) {
    console.warn('uiohook-napi の起動に失敗しました（グローバルホットキーは無効）:', err.message);
  }
}

// ══════════════════════════════════════════
//  ローカルAPI（localhost HTTP サーバー）
//  Node.js 標準 http のみ使用（express 不要）
// ══════════════════════════════════════════
ipcMain.handle('start-local-api', (_event, port) => {
  stopLocalApi();
  const http = require('http');
  localApiServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const segments = url.pathname.replace(/^\//, '').split('/');
    const type = segments[0];
    const target = segments[1];
    console.log(`[LocalAPI] ${req.method} ${req.url}  →  type="${type}" target="${target}"`);

    let cmd = null;
    if (type === 'variant') {
      const setMode = url.searchParams.has('set');
      cmd = { type: 'variant', target, params: { set: setMode } };
    } else if (type === 'action') {
      const loop = url.searchParams.get('loop');
      const span = url.searchParams.get('span');
      cmd = { type: 'action', target,
        params: { loop: loop!=null?parseInt(loop):undefined, span: span!=null?parseInt(span):undefined } };
    } else if (type === 'status') {
      cmd = { type: 'status' };
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (!cmd) {
      console.warn(`[LocalAPI] 404: unknown type "${type}"`);
      res.writeHead(404); res.end(JSON.stringify({ok:false,error:'not found'})); return;
    }
    console.log(`[LocalAPI] cmd built:`, JSON.stringify(cmd));
    if (cmd.type === 'status') {
      win.webContents.executeJavaScript(
        'JSON.stringify({activeVariants,activeVariant:getActiveVariant(),activeAction,isPlaying:activeAction>=0})'
      ).then(json => {
        console.log(`[LocalAPI] status response:`, json);
        res.writeHead(200); res.end(json);
      }).catch((e) => {
        console.warn(`[LocalAPI] status error:`, e);
        res.writeHead(500); res.end(JSON.stringify({ok:false}));
      });
    } else {
      console.log(`[LocalAPI] sending IPC "local-api-command"`, JSON.stringify(cmd));
      win.webContents.send('local-api-command', cmd);
      res.writeHead(200); res.end(JSON.stringify({ok:true}));
    }
  });
  localApiServer.on('error', (e) => console.error('[LocalAPI] server error:', e.message));
  localApiServer.listen(port, '127.0.0.1', () => {
    console.log(`[LocalAPI] listening on http://127.0.0.1:${port}`);
  });
  return { ok: true };
});

ipcMain.handle('stop-local-api', () => { stopLocalApi(); return { ok: true }; });

function stopLocalApi() {
  if (localApiServer) { try { localApiServer.close(); } catch (_) {} localApiServer = null; }
}

// ══════════════════════════════════════════
//  アプリライフサイクル
// ══════════════════════════════════════════
app.whenReady().then(() => {
  createWindow();
  startGlobalHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (uIOhook) { try { uIOhook.stop(); } catch (_) {} }
  stopLocalApi();
  app.quit();
});
