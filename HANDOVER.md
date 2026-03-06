# gifvtbr 開発引き継ぎ資料

**作成日**: 2026-03-05  
**更新日**: 2026-03-06  
**現在バージョン**: v0.5（Electron アプリ）  
**次フェーズ**: Phase 3 — 品質・UX 向上  
**引き継ぎ先**: Cursor / Claude Sonnet 4.6

---

## 1. プロジェクト概要

PNGtuber Plus より豊かな表現を持つ、配信アバター用 Electron アプリ。  
OBS のウィンドウキャプチャ（透過ウィンドウ）または OBS ブラウザソース（ローカル HTTP）で配信画面に合成して使う。

### コンセプト上の重要な判断

| 判断 | 内容 | 理由 |
|---|---|---|
| Electron アプリ | HTML/JS をそのまま活用しつつデスクトップネイティブ機能を追加 | グローバルホットキー・ネイティブファイルI/O・OBS マイク制限の回避 |
| パッチ式差分 | 差分は「差し替えるレイヤーだけ」を指定 | フルセット差分より素材数が激減する |
| 手レイヤー分離 | 右手(hand_r)・左手(hand_l) を独立レイヤー | 重ね合わせで「両手同時使用」パターンが自動成立 |
| 下端固定呼吸 | translateY ではなく scaleY + 下端固定で描画 | 飛び跳ね感をなくし足元が安定して見える |
| GIF 手動再生 | `<img>` ではなく gifuct-js でフレーム展開 | `<img>` は GIF を自動ループするため単発再生ができない |
| 2 段階 FPS | アニメステップ FPS と レンダー FPS を独立 | リミテッドアニメ表現を維持しつつ、まばたき・口パクの反応速度を確保 |
| body_head を mouth/eyes の下に | Z 順を逆転（v0.4 は body_head が最上位） | 素材に透明くり抜きが不要になり、作成難易度が下がる |

---

## 2. 現在のファイル構成

```
gifvtbr/
├── package.json           ← v0.5.0、依存: electron / gifuct-js / uiohook-napi
├── main.js                ← Electron メインプロセス
├── preload.js             ← contextBridge（セキュリティ境界）
├── renderer/
│   ├── index.html         ← 設定 UI（7タブ構成）
│   ├── renderer.js        ← レンダリング・アニメエンジン（972行）
│   └── style.css          ← スタイルシート
├── gifvtbr-project.json   ← 保存済みプロジェクトサンプル
├── gifvtbr-v04.html       ← 旧バージョン成果物（参照用）
├── start.bat              ← 起動バッチ
├── SPEC.md                ← 設計仕様書（v0.5 対応済み）
├── HANDOVER.md            ← この資料
├── package-lock.json
└── node_modules/
```

---

## 3. 現在のアーキテクチャ（v0.5）

### 3-1. レイヤー構成（Z 順・下から上）

```
0. bg          背景           追従なし・揺らぎあり
1. body_torso  胴体           torso 追従遅延・揺らぎあり
2. hand_r      右手           hand 追従遅延（-1 で固定）
3. hand_l      左手           同上
4. body_head   頭部           head 追従遅延  ← 目・口より下（v0.4 から変更）
5. mouth       口             head 追従遅延・リップシンク切替
6. eyes        目             head 追従遅延・まばたき切替
7. extra       アクセサリ     torso 追従遅延  ← 目・口より上（v0.4 から変更）
8. fg          前景           追従なし・揺らぎあり
```

> **v0.4 からの変更**: body_head が最上位から Z=4 に移動。目・口は body_head の上に直接描画される。  
> 素材側で目・口の透明くり抜きは**不要**になった。

### 3-2. 状態管理（グローバル `S` オブジェクト）

```javascript
const S = {
  talking:       boolean,  // 口が開く
  shouting:      boolean,  // 叫び口
  blinkFrame:    0|1|2,    // 0=開, 1=半, 2=閉
  isMouseActive: boolean,  // hand_r を mouse 差分に切替
  isKbActive:    boolean,  // hand_l を keyboard 差分に切替
};
```

### 3-3. 設定オブジェクト（`cfg`）

```javascript
const cfg = {
  // 音声（RMS ベース、単位は 0〜100%）
  audioThreshold: 5,      // 発話閾値
  audioShout:     30,     // 叫び閾値
  mouthCloseDelay:180,    // 発話停止後の口閉じ遅延(ms)
  audioSmoothing: 0.3,    // EMAスムージング（0=即時応答）
  // まばたき
  blinkMode:     '2',     // '2'|'3'|'gif'
  blinkInterval:  4,      // 間隔(s)
  blinkJitter:    0.4,    // ランダム揺れ（0〜1）
  blinkFrameMs:   50,     // 1フレーム長(ms)
  // 呼吸
  breathAmp:      0.012,  // 振幅（×6して scaleY 変化量に）
  breathPeriod:   3.5,    // 周期(s)
  // バウンス
  bounceAmp:      5,      // 振幅(px)
  bouncePeriod:   220,    // 周期(ms)
  // 入力
  keyboardMs:     2000,   // キーボードアクティブ持続(ms)
  mouseMs:        1500,   // マウスアクティブ持続(ms)
  mouseMoveThrottle: 0,   // マウス IPC スロットリング(ms)
  // 追従遅延
  torsoFollowDelay: 0,    // 胴体(ms)
  headFollowDelay:  30,   // 頭部(ms)
  handFollowDelay:  60,   // 手(ms) / -1=固定
  // 描画
  targetFps:      30,     // アニメステップFPS（呼吸・GIF揺らぎ）
  responseFps:    60,     // レンダーFPS（まばたき・口パク・入力ポーズ）
  // GIF 揺らぎ
  gifWobbleAmp:   1.2,    // 揺らぎ振幅(px)
  gifWobblePeriod:2.8,    // 揺らぎ周期(s)
};
```

### 3-4. 主要モジュールの説明

#### GifPlayer（GIF 単発再生エンジン）
まばたき `blinkgif` モード専用。`window.electronAPI.decodeGif()` で ArrayBuffer → フレーム配列に変換し、オフスクリーン Canvas に順次描画する。  
`play(onEnd)` で単発再生開始。最終フレーム後に `onEnd()` コールバックを呼ぶ（次のまばたきスケジューリングに使用）。

```javascript
GifPlayer.load(url)        // GIF を読み込みフレーム展開
GifPlayer.play(callback)   // 単発再生開始
GifPlayer.getCanvas()      // 現在フレームのオフスクリーン Canvas（再生中でない場合は null）
GifPlayer.isReady()        // フレーム展開済みか
GifPlayer.isPlaying()      // 再生中か
```

#### createGifLooper（GIF ループ再生エンジン）
ベースレイヤーおよび差分パッチの GIF 素材用。ロードと同時に自走ループを開始し、`getCanvas()` で常に現在フレームの Canvas を返す。

```javascript
const looper = createGifLooper();
await looper.load(url);     // ロードとループ開始
looper.getCanvas();         // 現在フレームの Canvas
looper.stop();              // ループ停止・破棄
looper.isReady();           // 再生中か
```

#### GIF_LOOPERS（ルックアップテーブル）
ベースキー `"layer__state"` とパッチキー `"patch-{vi}-{layer}-{state}"` をインデックスとして GifLooper インスタンスを管理。`resolveLayer()` がこのテーブルを参照して GIF を優先的に返す。

#### 追従遅延バッファ（delayBuf）
`torso` / `head` / `hand` の3系統をリングバッファで管理。  
毎フレーム `pushBuf(key, {sY, bY}, now)` で現在の呼吸値を積み、  
`readBuf(key, delayMs, fallback)` で `performance.now() - delayMs` 時点の値を取得して描画に使う。

#### resolveLayer（差分合成）
```javascript
function resolveLayer(layer, state) {
  if (activeVariant >= 0) {
    const pid = `${layer}-${state}`;
    const p = variants[activeVariant].patches[pid];
    if (p?.img) {
      // 差分 GIF ループがあればそちらを優先
      const lp = GIF_LOOPERS[`patch-${activeVariant}-${pid}`];
      if (lp?.isReady()) return lp.getCanvas();
      return p.img;
    }
  }
  // ベース GIF ループがあればそちらを優先
  const key = `${layer}__${state}`;
  const lp = GIF_LOOPERS[key];
  if (lp?.isReady()) return lp.getCanvas();
  return BASE[layer][state];
}
```

差分はパッチ ID が `"layer-state"` のキーで `variants[i].patches` に格納される。  
未登録のレイヤーはベースそのままになるため、変えたいレイヤーだけ登録すればよい。

---

## 4. 未実装・未解決の課題

### 高優先度

| 課題 | 詳細 |
|---|---|
| プロジェクト JSON 肥大化 | 画像を Base64 で埋め込んでいるため大きな素材だと数十MB超になる。画像をファイルとして分離保存する方式に変更することで解消できる（Phase 3 候補）。 |

### 中優先度

| 課題 | 詳細 |
|---|---|
| body_head の Z 順固定 | 現状 eyes・mouth より下面に描画される。素材によっては eyes/mouth を body_head より後ろに出したいケースがある。レイヤーの Z 順をユーザーが設定できるようにする検討が必要。 |
| GIF 揺らぎと FPS の相互作用 | targetFps を低く設定すると GIF 揺らぎの滑らかさも下がる。揺らぎは常に 60fps 相当で計算して FPS キャップとは分離する設計変更の検討。 |

### 低優先度（Phase 3 相当）

| 課題 | 詳細 |
|---|---|
| GIF Disposal 完全対応 | disposalType >= 2 での clearRect は実装済み。disposalType=1（前フレームを維持）の正確な処理は未実装。 |
| リップシンク精度 | 現在は音量の RMS 判定のみ。音素解析（WebAssembly + 音響モデル）で口形状を複数段階に対応させると表現力が上がる。 |
| 揺れ物物理 | 髪・アクセサリに慣性ベースの物理シミュレーション。 |
| WebGL 移行 | Canvas 2D → WebGL/PixiJS で高FPS・シェーダーエフェクト（発光・揺らぎ等）を実現。 |

---

## 5. Phase 3 実装候補

### 5-1. プロジェクトファイル分離保存

現在の JSON 単一ファイル（Base64 埋め込み）を、画像ファイル分離保存方式に変更する。

```
gifvtbr-project/
├── project.json    ← cfg・variants のラベルとファイル参照のみ（画像なし）
├── base/
│   ├── bg__default.png
│   ├── eyes__open.png
│   └── ...
└── patches/
    ├── 0__eyes-open.png
    └── ...
```

`main.js` 側で `dialog.showSaveDialog({ properties: ['createDirectory'] })` を使ってフォルダ選択し、`fs.mkdirSync` + `fs.writeFileSync` で各ファイルを書き出す。  
読み込み時は `project.json` のパスを基準に相対パスで画像を `fs.readFileSync` → DataURL に変換して `applyProject()` に渡す。

### 5-2. レイヤー Z 順カスタマイズ

`cfg.layerOrder: string[]` を追加し、`render()` 内でこの配列順に描画する。設定パネルにドラッグ並び替え UI を追加。

### 5-3. 差分スロット数の動的変更

`VARIANT_SLOT_COUNT` を固定値ではなく `cfg` のパラメータにし、スロット追加ボタンで増やせるようにする。ショートカットキーのマッピングも動的に生成する。

---

## 6. Cursor への引き継ぎ時の注意事項

### コンテキストとして渡すべきもの

1. **この資料（HANDOVER.md）**
2. **SPEC.md** — 設計仕様の全詳細
3. **renderer/renderer.js** — エンジン本体
4. **renderer/index.html** — UI 構造
5. **main.js / preload.js** — Electron 側

### コーディング上の注意

- `cfg` オブジェクトは設定の唯一の真実の源（Single Source of Truth）。UI スライダーは `cfg` を変更し、`syncCfgToUI()` で逆方向（cfg から UI）に同期する。
- `resolveLayer(layer, state)` を必ず使うこと。直接 `BASE[layer][state]` を参照すると差分・GIF ループが無視される。
- `drawBreath()` の第3引数 `sY` と第4引数 `offY` は**遅延バッファから読んだ値**を渡すこと。現在値を直接渡すと追従遅延が効かない。
- まばたき GIF の `play()` コールバックが `scheduleBlink()` を呼ぶ設計になっている。GIF 再生中に別の `doBlink()` が呼ばれないよう注意。
- `render(now, animNow)` の2引数を使い分けること。まばたき・口パクは `now`（実時刻）、呼吸・GIF 揺らぎは `animNow`（コマ送り時刻）。
- GIF をベースレイヤーに登録した場合、`GIF_LOOPERS["layer__state"]` に対応するループ再生インスタンスが存在する。削除・差し替え時は `clearGifLooper(key)` を忘れずに呼ぶ。
- `uiohook-napi` はネイティブモジュール。`main.js` では try/catch で囲み、起動失敗時もアプリが落ちないようにしている。

---

## 7. バージョン履歴

| バージョン | 主な変更 |
|---|---|
| v0.1 | 基本 PNGtuber アプリ（別セッションで作成） |
| v0.2 | 手レイヤー分離（hand_r/hand_l）、パッチ式差分システム 8 スロット |
| v0.3 | キーボード検知バグ修正、body_head/body_torso 分離、FPS 制限、呼吸アニメ修正（下端固定） |
| v0.4 | GIF 単発再生（gifuct-js）、プロジェクト JSON 保存・読込、GIF ループ揺らぎ |
| v0.5 | Electron 化 Phase 2 完了。グローバルホットキー・ネイティブファイル I/O・前回プロジェクト自動復元。差分スロット 8→12。ショートカット Ctrl+修飾キー方式。FPS 2 段階化。リップシンク RMS + EMA 化。GIF ループ再生エンジン追加。Z 順変更（body_head 下層化・extra 上層化）。マイクデバイス選択対応 |
