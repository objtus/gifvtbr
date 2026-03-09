# gifvtbr 開発引き継ぎ資料

**作成日**: 2026-03-05
**更新日**: 2026-03-06
**現在バージョン**: v0.6（Electron アプリ）
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
| 手を頭部の前面に | Z順: body_head → hand_r/l → mouth/eyes | 手が顔の前に出る自然な重なりを実現 |
| アクションは差分を上書きしない | inheritVariant 廃止、activeVariants を維持したまま再生 | 差分で設定した髪型等がアクション中も崩れない |

---

## 2. 現在のファイル構成

```
gifvtbr/
├── package.json           ← v0.5.0、依存: electron / gifuct-js / uiohook-napi
├── main.js                ← Electron メインプロセス・ローカル HTTP サーバー
├── preload.js             ← contextBridge（セキュリティ境界）
├── renderer/
│   ├── index.html         ← 設定 UI（8タブ構成）
│   ├── renderer.js        ← レンダリング・アニメエンジン（約1480行）
│   └── style.css          ← スタイルシート
├── gifvtbr-project.json   ← 保存済みプロジェクトサンプル
├── gifvtbr-v04.html       ← 旧バージョン成果物（参照用）
├── start.bat              ← 起動バッチ
├── SPEC.md                ← 設計仕様書（v0.6 対応済み）
├── HANDOVER.md            ← この資料
├── EXTENSIONPLAN.md       ← Phase 3 以降の拡張計画
├── Lipsyncplan.md         ← リップシンク改善計画（施策 A〜D 実装済み）
├── README.md              ← 簡易説明
├── package-lock.json
└── node_modules/
```

---

## 3. 現在のアーキテクチャ（v0.6）

### 3-1. レイヤー構成（Z 順・下から上）

```
0. bg          背景           追従なし
1. body_torso  胴体           torso 追従遅延
2. body_head   頭部           head 追従遅延   ← 手より下（手が顔の前面に出る）
3. hand_r      右手           hand 追従遅延
4. hand_l      左手           hand 追従遅延
5. mouth       口             head 追従遅延・リップシンク切替
6. eyes        目             head 追従遅延・まばたき切替  ← 手より上（常に前面）
7. extra       アクセサリ     torso 追従遅延
8. fg          前景           追従なし
```

### 3-2. 状態管理（グローバル `S` オブジェクト）

```javascript
const S = {
  talking:       boolean,  // 口が開く
  shouting:      boolean,  // 叫び口
  mouthLevel:    0〜4,     // 現在の口レベル（lipsyncLevels インデックス）
  mouthShape:    null|'sibilant'|'rounded',  // 帯域分割時の特殊口形状
  blinkFrame:    0|1|2,    // 0=開, 1=半, 2=閉
  isMouseActive: boolean,  // hand_r を mouse 差分に切替
  isKbActive:    boolean,  // hand_l を keyboard 差分に切替
};
```

### 3-3. 設定オブジェクト（`cfg`）

```javascript
const cfg = {
  // リップシンク
  lipsyncLevels:   [0,5,15,30,60], // [閉,小,開,大,叫] の下限閾値（RMS%）
  mouthCloseDelay: 180,
  audioSmoothing:  0.3,
  // 帯域分割
  bandSplit:          false,
  sibilantThreshold:  15,
  roundedThreshold:   10,
  // 差分スタックモード
  stackMode: false,
  // まばたき
  blinkMode: '2', blinkInterval: 4, blinkJitter: 0.4, blinkFrameMs: 50,
  // 呼吸・バウンス
  breathAmp: 0.012, breathPeriod: 3.5,
  bounceAmp: 5,     bouncePeriod: 220,
  // 入力
  keyboardMs: 2000, mouseMs: 1500, mouseMoveThrottle: 0,
  // 追従遅延
  torsoFollowDelay: 0, headFollowDelay: 30, handFollowDelay: 60,
  // 描画
  targetFps: 30, responseFps: 60,
  // GIF 揺らぎ
  gifWobbleAmp: 1.2, gifWobblePeriod: 2.8,
  // ローカル API
  localApiEnabled: false, localApiPort: 3000,
};
```

### 3-4. 主要モジュールの説明

#### resolveLayer（差分スタック解決）

```javascript
function resolveLayer(layer, state) {
  const pid = `${layer}-${state}`;
  // activeVariants を末尾（高優先）から順に検索
  for (let i = activeVariants.length - 1; i >= 0; i--) {
    const vi = activeVariants[i];
    const p = variants[vi].patches[pid];
    if (p?.img) {
      const lp = GIF_LOOPERS[`patch-${vi}-${pid}`];
      if (lp?.isReady()) return lp.getCanvas();
      return p.img;
    }
  }
  const key = `${layer}__${state}`;
  const lp = GIF_LOOPERS[key];
  if (lp?.isReady()) return lp.getCanvas();
  return BASE[layer][state];
}
```

`activeVariants` は配列（スタック）。末尾が最高優先度。`getActiveVariant()` でスタック先頭インデックスを取得できる。

#### 差分スタック管理

```javascript
// スタックに追加 or 取り除く（スタックモード用）
function toggleStackVariant(idx)

// スタックを [idx] の単一要素にリセット（通常モード用）
function setVariant(idx)

// cfg.stackMode に応じて上記を分岐
function toggleVariant(idx)

// 共通ヘルパー
function _syncBlinkGif()        // スタック上位から blinkgif を優先してロード
function _updateVariantBadges() // バッジ表示（スタック内の全スロットにバッジ）
function _stackLabel()          // "差分1 + 差分3" 形式のトースト文字列
```

#### GifPlayer / createGifLooper

- `GifPlayer` — まばたき `blinkgif` 専用の単発再生エンジン
- `createGifLooper()` — ベースレイヤー・差分パッチの GIF ループ再生エンジン
- `createActionPlayer()` — アクションパッチ専用の GIF ループ再生エンジン（`createGifLooper` と同等だがインスタンス管理が `ACTION_PLAYERS` で行われる）

#### ワンショットアクション

差分スロット（状態維持）とは独立した「イベントレーン」。アクション再生中も `activeVariants` は変更されない。

```
triggerAction(idx)  → 同インデックスで再生中なら stopAction、それ以外なら playAction
playAction(index)   → preActionVariants にスナップショット保存 → doActionLoop
stopAction()        → GIF プレイヤー停止 → preActionVariants でスタック復元
```

ショートカット: `Ctrl+Alt+1〜8`

#### ローカル HTTP API

`main.js` で `http` モジュールによる HTTP サーバーを起動。コマンドは IPC 経由でレンダラーへ転送。

```
GET /variant/{index|name|next|prev|reset}
GET /action/{index|name|stop}?loop=N&span=N
GET /status
```

`/variant/数値` や `/variant/名前` は `toggleVariant` を呼ぶため、`cfg.stackMode` の状態が反映される。

---

## 4. 未実装・未解決の課題

### 高優先度

| 課題 | 詳細 |
|---|---|
| プロジェクト JSON 肥大化 | 画像を Base64 で埋め込んでいるため大きな素材だと数十MB超になる。画像をファイルとして分離保存する方式に変更することで解消できる（Phase 3 候補）。 |

### 中優先度

| 課題 | 詳細 |
|---|---|
| GIF 揺らぎと FPS の相互作用 | targetFps を低く設定すると GIF 揺らぎの滑らかさも下がる。揺らぎは常に 60fps 相当で計算して FPS キャップとは分離する設計変更の検討。 |

### 低優先度（Phase 3 相当）

| 課題 | 詳細 |
|---|---|
| GIF Disposal 完全対応 | disposalType >= 2 での clearRect は実装済み。disposalType=1（前フレームを維持）の正確な処理は未実装。 |
| リップシンク精度 | 現在は RMS + 帯域比率判定。音素解析（WebAssembly + 音響モデル）で口形状をさらに精緻化できる。 |
| 揺れ物物理 | 髪・アクセサリに慣性ベースの物理シミュレーション。 |
| WebGL 移行 | Canvas 2D → WebGL/PixiJS で高FPS・シェーダーエフェクト（発光・揺らぎ等）を実現。 |

---

## 5. Phase 3 実装候補

### 5-1. プロジェクトファイル分離保存

現在の JSON 単一ファイル（Base64 埋め込み）を、画像ファイル分離保存方式に変更する。

```
gifvtbr-project/
├── project.json    ← cfg・variants のラベルとファイル参照のみ
├── base/
│   ├── bg__default.png
│   └── ...
└── patches/
    ├── 0__eyes-open.png
    └── ...
```

### 5-2. 差分スロット数の動的変更

`VARIANT_SLOT_COUNT` を `cfg` のパラメータにし、スロット追加ボタンで増やせるようにする。

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
- `activeVariants`（配列）が差分スタック。`getActiveVariant()` でスタック先頭を取得。**`activeVariant` という変数は存在しない**（v0.6 で廃止）。
- `drawBreath()` の第3引数 `sY` と第4引数 `offY` は**遅延バッファから読んだ値**を渡すこと。
- まばたき GIF の `play()` コールバックが `scheduleBlink()` を呼ぶ設計になっている。GIF 再生中に別の `doBlink()` が呼ばれないよう注意。
- `render(now, animNow)` の2引数を使い分けること。まばたき・口パクは `now`（実時刻）、呼吸・GIF 揺らぎは `animNow`（コマ送り時刻）。
- GIF をベースレイヤーに登録した場合、`GIF_LOOPERS["layer__state"]` に対応するループ再生インスタンスが存在する。削除・差し替え時は `clearGifLooper(key)` を忘れずに呼ぶ。
- `uiohook-napi` はネイティブモジュール。`main.js` では try/catch で囲み、起動失敗時もアプリが落ちないようにしている。
- アクションは差分スタックを変更しない。`playAction` 内で `activeVariants` を書き換えてはいけない（`inheritVariant` は v0.6 で廃止）。

---

## 7. バージョン履歴

| バージョン | 主な変更 |
|---|---|
| v0.1 | 基本 PNGtuber アプリ（別セッションで作成） |
| v0.2 | 手レイヤー分離（hand_r/hand_l）、パッチ式差分システム 8 スロット |
| v0.3 | キーボード検知バグ修正、body_head/body_torso 分離、FPS 制限、呼吸アニメ修正（下端固定） |
| v0.4 | GIF 単発再生（gifuct-js）、プロジェクト JSON 保存・読込、GIF ループ揺らぎ |
| v0.5 | Electron 化 Phase 2 完了。グローバルホットキー・ネイティブファイル I/O・前回プロジェクト自動復元。差分スロット 8→12。ショートカット Ctrl+修飾キー方式。FPS 2 段階化。リップシンク RMS + EMA 化。GIF ループ再生エンジン追加。Z 順変更。マイクデバイス選択対応 |
| v0.6 | リップシンク 5段階化 + 帯域分割（sibilant/rounded）。ワンショットアクション（8スロット・Ctrl+Alt+1〜8）。ローカル HTTP API。差分スタックモード（activeVariants[]）。レイヤー Z 順調整（body_head を手の下に）。アクション inheritVariant 廃止。ローカル API で toggleVariant 使用（stackMode 反映） |
