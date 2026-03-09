'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { parseGIF, decompressFrames } = require('gifuct-js');

contextBridge.exposeInMainWorld('electronAPI', {
  // プロジェクト保存（ネイティブ保存ダイアログ）
  saveProject: (jsonStr) => ipcRenderer.invoke('save-project', jsonStr),

  // プロジェクト読込（ネイティブ開くダイアログ）
  loadProject: () => ipcRenderer.invoke('load-project'),

  // グローバルキーダウン受信（{ keycode, ctrlKey } を渡す）
  onGlobalKeydown: (callback) => {
    ipcRenderer.on('global-keydown', (_event, e) => callback(e));
  },

  // グローバルマウスアクティブ受信
  onGlobalMouseActive: (callback) => {
    ipcRenderer.on('global-mouse-active', () => callback());
  },

  // アプリ設定の保存（cfg を JSON 文字列で渡す）
  saveAppSettings: (jsonStr) => ipcRenderer.invoke('save-app-settings', jsonStr),

  // アプリ設定の読み込み（cfg オブジェクト or null を返す）
  loadAppSettings: () => ipcRenderer.invoke('load-app-settings'),

  // alwaysOnTop の切り替え（配信中↔設定中）
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('set-always-on-top', flag),

  // アプリ終了
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // 前回プロジェクトの自動保存・復元
  saveLastProject: (jsonStr) => ipcRenderer.invoke('save-last-project', jsonStr),
  loadLastProject: () => ipcRenderer.invoke('load-last-project'),

  // ローカルAPI 制御
  startLocalApi: (port) => ipcRenderer.invoke('start-local-api', port),
  stopLocalApi:  () => ipcRenderer.invoke('stop-local-api'),
  onLocalApiCommand: (callback) => {
    ipcRenderer.on('local-api-command', (_event, cmd) => callback(cmd));
  },

  // GIF デコード（ArrayBuffer → フレーム配列）
  // data: URL は renderer 側で ArrayBuffer に変換してから渡す
  decodeGif: (buffer) => {
    const parsed = parseGIF(buffer);
    const raw = decompressFrames(parsed, true);
    return {
      width:  parsed.lsd.width,
      height: parsed.lsd.height,
      frames: raw.map(f => ({
        patch:       new Uint8ClampedArray(f.patch),
        dims:        { top: f.dims.top, left: f.dims.left, width: f.dims.width, height: f.dims.height },
        delay:       f.delay || 80,   // gifuct-js が既に ms 変換済み（centiseconds × 10）
        disposalType: f.disposalType || 0,
      })),
    };
  },
});
