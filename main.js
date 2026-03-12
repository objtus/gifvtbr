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
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gifvtbr Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f11;color:#e2d9ff;font-family:'Segoe UI',sans-serif;font-size:13px;padding:16px;min-height:100vh}
header{display:flex;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08)}
header h1{font-size:14px;font-weight:700;color:#a78bfa;letter-spacing:.03em}
#active-bar{font-size:11px;color:#6b7280}
#active-label{color:#c4b5fd;font-weight:600}
section{margin-bottom:20px}
section h2{font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
.grid{display:flex;flex-wrap:wrap;gap:6px}
.btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#c4b5fd;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:12px;transition:all .15s;white-space:nowrap}
.btn:hover{background:rgba(167,139,250,.18);border-color:rgba(167,139,250,.5)}
.btn.active{background:rgba(167,139,250,.3);border-color:#a78bfa;color:#fff;font-weight:600}
.btn.reset{color:#f87171;border-color:rgba(248,113,113,.3)}
.btn.reset:hover{background:rgba(248,113,113,.12)}
.btn.act{color:#86efac;border-color:rgba(134,239,172,.25)}
.btn.act:hover{background:rgba(134,239,172,.12)}
.empty{font-size:11px;color:#4b5563;font-style:italic}
.active-var{cursor:pointer;border-radius:4px;padding:1px 3px;transition:background .12s,color .12s}
.active-var:hover{background:rgba(248,113,113,.2);color:#f87171;text-decoration:line-through}
</style></head><body>
<header>
  <h1>🎭 gifvtbr</h1>
  <div id="active-bar">active: <span id="active-label">–</span></div>
</header>
<section>
  <h2>差分スロット</h2>
  <div class="grid" id="vgrid"><span class="empty">読み込み中...</span></div>
</section>
<section>
  <h2>ワンショットアクション</h2>
  <div class="grid" id="agrid"><span class="empty">読み込み中...</span></div>
</section>
<script>
let vdata=[],adata=[];
async function init(){
  try{
    const d=await fetch('/info').then(r=>r.json());
    vdata=d.variants; adata=d.actions;
    buildVariants(); buildActions();
    tick(); setInterval(tick,1200);
  }catch(e){ document.getElementById('vgrid').innerHTML='<span class="empty">API未接続</span>'; }
}
function buildVariants(){
  const g=document.getElementById('vgrid'); g.innerHTML='';
  const rb=mkbtn('× ベース','btn reset',()=>api('/variant/reset'));
  g.appendChild(rb);
  vdata.forEach(v=>{
    const lbl=v.label||('差分'+(v.i+1));
    g.appendChild(mkbtn(lbl,'btn',()=>api('/variant/'+encodeURIComponent(lbl)),{id:'v'+v.i}));
  });
}
function buildActions(){
  const g=document.getElementById('agrid'); g.innerHTML='';
  if(!adata.length){g.innerHTML='<span class="empty">なし</span>';return;}
  adata.forEach(a=>{
    const lbl=a.label||('アクション'+(a.i+1));
    g.appendChild(mkbtn('▷ '+lbl,'btn act',()=>api('/action/'+encodeURIComponent(lbl))));
  });
}
function mkbtn(text,cls,onClick,attrs={}){
  const b=document.createElement('button');
  b.className=cls; b.textContent=text; b.onclick=onClick;
  Object.keys(attrs).forEach(k=>b.setAttribute(k,attrs[k]));
  return b;
}
async function api(path){ try{ await fetch(path); tick(); }catch(e){} }
async function tick(){
  try{
    const d=await fetch('/status').then(r=>r.json());
    document.querySelectorAll('[id^="v"]').forEach(b=>b.classList.remove('active'));
    const av=d.activeVariants||[];
    av.forEach(i=>{ const b=document.getElementById('v'+i); if(b) b.classList.add('active'); });
    const bar=document.getElementById('active-label');
    if(av.length>0){
      bar.innerHTML='';
      av.forEach((i,idx)=>{
        if(idx>0){ const sep=document.createElement('span'); sep.textContent=' + '; sep.style.color='#6b7280'; bar.appendChild(sep); }
        const v=vdata.find(v=>v.i===i);
        const lbl=v?.label||('差分'+(i+1));
        const sp=document.createElement('span');
        sp.className='active-var'; sp.textContent=lbl; sp.title='クリックで解除';
        sp.onclick=()=>api('/variant/'+encodeURIComponent(lbl)+'?unset');
        bar.appendChild(sp);
      });
    } else {
      bar.textContent='ベース';
    }
  }catch(e){}
}
init();
</script>
</body></html>`;

ipcMain.handle('start-local-api', (_event, port) => {
  stopLocalApi();
  const http = require('http');
  localApiServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const segments = url.pathname.replace(/^\//, '').split('/');
    const type = segments[0];
    const target = segments[1];
    console.log(`[LocalAPI] ${req.method} ${req.url}  →  type="${type}" target="${target}"`);

    res.setHeader('Access-Control-Allow-Origin', '*');

    // ダッシュボード
    if (type === 'dashboard' || url.pathname === '/' || url.pathname === '') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200); res.end(DASHBOARD_HTML); return;
    }
    // 情報エンドポイント（差分・アクションのラベル一覧）
    if (type === 'info') {
      res.setHeader('Content-Type', 'application/json');
      win.webContents.executeJavaScript(
        'JSON.stringify({variants:variants.map((v,i)=>({i,label:v.label})),actions:actions.map((a,i)=>({i,label:a.label}))})'
      ).then(json => { res.writeHead(200); res.end(json); })
       .catch(() => { res.writeHead(500); res.end(JSON.stringify({ok:false})); });
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    let cmd = null;
    if (type === 'variant') {
      const setMode   = url.searchParams.has('set');
      const unsetMode = url.searchParams.has('unset');
      cmd = { type: 'variant', target, params: { set: setMode, unset: unsetMode } };
    } else if (type === 'action') {
      const loop = url.searchParams.get('loop');
      const span = url.searchParams.get('span');
      cmd = { type: 'action', target,
        params: { loop: loop!=null?parseInt(loop):undefined, span: span!=null?parseInt(span):undefined } };
    } else if (type === 'status') {
      cmd = { type: 'status' };
    }

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
