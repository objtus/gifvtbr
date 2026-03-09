# gifvtbr 設計仕様書

**バージョン**: v0.6
**最終更新**: 2026-03-06
**形式**: Electron デスクトップアプリ
**動作環境**: Windows / macOS（electron-builder でパッケージング）

---

## 1. プロジェクト概要

### 目的

既存の PNGtuber ツール（PNGtuber Plus 等）に比べ、以下の点で豊かな表現を実現する配信アバターエンジン。

- キーボード・マウス操作状態を左右の手レイヤーに反映する
- GIF アニメ素材とスタティック画像を自由に混在させられる
- 差分（表情・衣装）をショートカットキーでリアルタイム切替できる
- 複数差分を重ね合わせる「スタックモード」を持つ
- ワンショットアクションで独立したアニメーションイベントを再生できる
- ローカル HTTP API で外部ツール（OBS 等）から制御できる
- Electron アプリとして動作し、OBS のウィンドウキャプチャ or ブラウザソースで配信画面に合成できる

### 設計方針

| 方針 | 理由 |
|---|---|
| Electron アプリ | グローバルホットキー・ネイティブファイルI/O・OBS マイク制限の回避 |
| 全描画を Canvas 2D で実装 | 外部ライブラリ依存を最小化。gifuct-js のみ preload 経由で利用 |
| cfg オブジェクトを唯一の設定源 | UI スライダーは `cfg` を変更し、`syncCfgToUI()` で逆同期する |
| パッチ式差分 | 差分はベースへの上書きパッチとして定義。変えたいレイヤーだけ登録すれば成立する |
| 下端固定呼吸アニメ | `translateY` での上下移動をやめ `scaleY + 下端固定描画` に変更。足元が地面に置かれたように見える |
| GIF 手動再生 | `<img>` タグは GIF を自動ループするため単発まばたきができない。gifuct-js でフレーム展開し手動制御する |
| 2 段階 FPS 制御 | アニメステップ FPS（呼吸・GIF 揺らぎ）と レンダー FPS（まばたき・口パク）を独立させることで、リミテッドアニメ表現を維持しつつ入力ポーズの反応速度を確保する |

---

## 2. レイヤー構成

### 2-1. レイヤー一覧（Z順・下から上）

| Z順 | レイヤーID | ステート | 説明 | 呼吸追従 | 揺らぎseed |
|---|---|---|---|---|---|
| 0 | `bg` | `default` | 背景 | なし（sY=1固定） | 7.1 |
| 1 | `body_torso` | `default` | 胴体（衣装・下半身） | torso系 | 1.0 |
| 2 | `body_head` | `default` | 頭部（顔輪郭・髪・首） | head系 | 2.1 |
| 3 | `hand_r` | `default` / `mouse` | 右手 | hand系 | 3.3 |
| 4 | `hand_l` | `default` / `keyboard` | 左手 | hand系 | 3.3 |
| 5 | `mouth` | `closed` / `small` / `open` / `wide` / `shout` / `sibilant` / `rounded` | 口 | head系 | 2.1 |
| 6 | `eyes` | `open` / `half` / `closed` / `blinkgif` | 目 | head系 | 2.1 |
| 7 | `extra` | `default` | アクセサリ・装飾品 | torso系 | 5.5 |
| 8 | `fg` | `default` | 前景（最前面） | なし（sY=1固定） | 9.9 |

### 2-2. 素材制作上の注意

- `body_head`（Z=2）は `hand_r`/`hand_l`（Z=3/4）より**下**に描画される。手が顔の前面に重なる表現に適している
- `mouth`・`eyes`（Z=5/6）は手より**上**に描画される。口・目は透過PNGで顔の該当部分だけを描くことを推奨
- `extra`（Z=7）は目・口より**前面**に描画される。アクセサリや装飾が顔パーツを隠したい場合に使用できる
- `hand_r` と `hand_l` は同じ揺らぎ seed を使っているため、両手が同位相で揺れる

### 2-3. 手レイヤーの自動合成ロジック

```
右手画像 = isMouseActive ? (hand_r.mouse || hand_r.default) : hand_r.default
左手画像 = isKbActive   ? (hand_l.keyboard || hand_l.default) : hand_l.default
```

マウス差分は右手だけ、キーボード差分は左手だけを用意すれば、両方同時使用時は自動で成立する。

---

## 3. データ構造

### 3-1. BASE オブジェクト（ベース画像ストア）

```javascript
const BASE = {
  bg:          { default: Image|null },
  body_torso:  { default: Image|null },
  body_head:   { default: Image|null },
  hand_r:      { default: Image|null, mouse: Image|null },
  hand_l:      { default: Image|null, keyboard: Image|null },
  eyes:        { open: Image|null, half: Image|null, closed: Image|null, blinkgif: Image|null },
  mouth:       { closed: Image|null, small: Image|null, open: Image|null,
                 wide: Image|null, shout: Image|null, sibilant: Image|null, rounded: Image|null },
  extra:       { default: Image|null },
  fg:          { default: Image|null },
};
```

`BASE_SRCS` は保存用の DataURL キャッシュ。キー形式は `"layer__state"`（アンダースコア2つ）。

### 3-2. variants オブジェクト（差分スロット）

```javascript
const VARIANT_SLOT_COUNT = 12;  // スロット数（Ctrl+1〜9 / Ctrl+↑←→ の計12個）

const variants = Array.from({ length: VARIANT_SLOT_COUNT }, (_, i) => ({
  label: `差分${i+1}`,   // 表示名（トーストに使用）
  patches: {
    "eyes-open": { img: Image, src: "data:image/png;base64,..." },
    // キー形式は "layer-state"（ハイフン1つ）
  },
  open: false,           // 設定パネルの折りたたみ状態
}));

// スタック（末尾が最高優先度）。スタックモード OFF 時は最大1要素
let activeVariants = [];

// スタック末尾（最高優先度）のインデックスを返す（空なら -1）
function getActiveVariant() { return activeVariants.length > 0 ? activeVariants[activeVariants.length-1] : -1; }
```

#### 差分スタックモード

`cfg.stackMode` が `true` のとき、差分ショートカット（Ctrl+1〜9 等）が「スタックに追加/取り除く」動作になる。

```
stackMode OFF → toggleVariant(idx) → setVariant(idx)          （単一切替・同一キーで解除）
stackMode ON  → toggleVariant(idx) → toggleStackVariant(idx)  （追加・同一キーで取り除く）
```

`resolveLayer` はスタックを末尾から順に検索し、最初にパッチが見つかったものを優先する。

#### PATCHABLE（差分に登録できるレイヤー一覧）

| パッチ ID | ラベル |
|---|---|
| `body_torso-default` | ボディ(胴体) |
| `body_head-default` | ボディ(頭部) |
| `eyes-open` | 目_開 |
| `eyes-half` | 目_半 |
| `eyes-closed` | 目_閉 |
| `eyes-blinkgif` | まばたきGIF |
| `mouth-closed` | 口_閉 |
| `mouth-small` | 口_小 |
| `mouth-open` | 口_開 |
| `mouth-wide` | 口_大 |
| `mouth-shout` | 口_叫 |
| `mouth-sibilant` | 口_歯擦（帯域分割モード用・任意） |
| `mouth-rounded` | 口_丸（帯域分割モード用・任意） |
| `hand_r-default` | 右手_通常 |
| `hand_r-mouse` | 右手_マウス |
| `hand_l-default` | 左手_通常 |
| `hand_l-keyboard` | 左手_KB |
| `extra-default` | アクセサリ |
| `fg-default` | 前景 |

### 3-3. S オブジェクト（ランタイム状態）

```javascript
const S = {
  talking:       false,  // 発話中
  shouting:      false,  // 叫び中
  mouthLevel:    0,      // 現在の口レベル（0〜4、lipsyncLevels のインデックス）
  mouthShape:    null,   // 帯域分割時の特殊口形状 'sibilant' | 'rounded' | null
  blinkFrame:    0,      // 0=開, 1=半開, 2=閉
  isMouseActive: false,  // マウスアクティブ → hand_r.mouse 表示
  isKbActive:    false,  // キーボードアクティブ → hand_l.keyboard 表示
};
```

### 3-4. cfg オブジェクト（設定）

```javascript
const cfg = {
  // リップシンク
  lipsyncLevels:   [0,5,15,30,60], // [閉,小,開,大,叫] の下限閾値（RMS%）
  mouthCloseDelay: 180,   // 発話停止後の口閉じ遅延(ms)
  audioSmoothing:  0.3,   // EMAスムージング係数（0=即時応答）

  // 帯域分割リップシンク
  bandSplit:          false, // true=中域RMS主軸 / false=全域RMS
  sibilantThreshold:  15,    // 高域/中域比率の歯擦音判定閾値（bandSplit有効時）
  roundedThreshold:   10,    // 低域/中域比率の丸口判定閾値（bandSplit有効時）

  // 差分スタックモード
  stackMode: false,  // true=重ね合わせ / false=単一切替

  // まばたき
  blinkMode:       '2',   // '2'=2枚切替 / '3'=3枚切替 / 'gif'=GIF単発再生
  blinkInterval:   4,     // まばたき間隔(s)
  blinkJitter:     0.4,   // 間隔ランダム幅（0〜1）
  blinkFrameMs:    50,    // 2枚/3枚モード時の1フレーム長(ms)

  // 呼吸アニメ
  breathAmp:       0.012, // 振幅係数（実際の scaleY 変化量 = breathAmp × 6）
  breathPeriod:    3.5,   // 周期(s)

  // 発話バウンス
  bounceAmp:       5,     // 振幅(px)
  bouncePeriod:    220,   // 周期(ms)

  // 入力検知
  keyboardMs:      2000,  // キーボードアクティブ持続時間(ms)
  mouseMs:         1500,  // マウスアクティブ持続時間(ms)
  mouseMoveThrottle: 0,   // グローバルマウスIPC最小間隔(ms)。高ポーリングマウスは8〜16推奨

  // 追従遅延
  torsoFollowDelay: 0,    // 胴体系レイヤーの遅延(ms)
  headFollowDelay:  30,   // 頭部系レイヤーの遅延(ms)
  handFollowDelay:  60,   // 手レイヤーの遅延(ms) / -1=追従なし（固定）

  // 描画
  targetFps:       30,    // アニメステップFPS（呼吸・バウンス・GIF揺らぎ）
  responseFps:     60,    // レンダーFPS（まばたき・口パク・入力ポーズ描画頻度）

  // GIF ループ揺らぎ
  gifWobbleAmp:    1.2,   // 揺らぎ振幅(px)
  gifWobblePeriod: 2.8,   // 揺らぎ周期(s)

  // ローカル API
  localApiEnabled: false, // HTTP サーバー有効化
  localApiPort:    3000,  // ポート番号
};
```

### 3-5. actions オブジェクト（ワンショットアクション）

```javascript
const ACTION_SLOT_COUNT = 8;  // スロット数（Ctrl+Alt+1〜8）

const actions = Array.from({ length: ACTION_SLOT_COUNT }, (_, i) => ({
  label: `アクション${i+1}`,
  loop:  1,     // ループ回数（0=無限）
  span:  0,     // span ms 経過後に強制停止（0=無効）
  patches: {
    // キーはレイヤー名（'eyes'等）。ステート不問で1枚固定
    eyes: { img: Image, src: "data:image/gif;base64,..." },
  },
  open: false,  // UI折りたたみ状態
}));

let activeAction    = -1;   // 再生中のアクションインデックス（-1=なし）
let actionLoopCount = 0;    // 現在のループ回数
let preActionVariants = []; // アクション開始前の activeVariants スナップショット（終了時に復元）
```

- アクション再生中も `activeVariants` は変更されない（差分スタックを維持したまま重なる）
- アクションパッチがないレイヤーは通常の `resolveLayer` / まばたき / リップシンクが継続する
- `resolveActionLayer(layer)` がアクションパッチを優先的に返す

### 3-6. プロジェクト JSON スキーマ（v0.6）

```json
{
  "version": "0.6",
  "cfg": { /* cfg オブジェクトの全フィールド */ },
  "baseImages": {
    "bg__default":         "data:image/png;base64,...",
    "eyes__blinkgif":      "data:image/gif;base64,..."
  },
  "variants": [
    {
      "label": "困り顔",
      "patches": {
        "eyes-open": { "src": "data:image/png;base64,..." }
      }
    }
  ],
  "actions": [
    {
      "label": "まばたき",
      "loop": 1,
      "span": 0,
      "patches": {
        "eyes": { "src": "data:image/gif;base64,..." }
      }
    }
  ]
}
```

キー形式: `baseImages` は `"layer__state"`（アンダースコア2つ）、`variants.patches` は `"layer-state"`（ハイフン1つ）、`actions.patches` はレイヤー名のみ（ステートなし）。

---

## 4. エンジン詳細

### 4-1. 2段階 FPS レンダーループ

```
requestAnimationFrame(renderLoop)
  ├─ now - lastFrameTime < 1000/responseFps - 1 → スキップ（canvas 描画をしない）
  └─ それ以外 → 描画フレーム
       ├─ now - _lastAnimTick >= 1000/targetFps - 1 → _animNow = now（アニメ時刻を進める）
       └─ render(now, _animNow) を呼ぶ
```

- `responseFps`: canvas を描き直す最大頻度。まばたき・口パク・手ポーズの反応速度に直結
- `targetFps`: 呼吸・バウンス・GIF 揺らぎの「コマ送り速度」。低く設定するとリミテッドアニメ表現になる

`render()` は `now`（実時刻）と `animNow`（コマ送り時刻）の2引数を受け取る。
まばたき・口パクは `now` で判定し、呼吸・GIF 揺らぎは `animNow` で計算することで、FPS設定が入力応答に影響しない。

### 4-2. 呼吸アニメーション

**scaleY 計算:**
```
t = (1 - cos(animNow/1000 × 2π/breathPeriod)) / 2
sY = 1.0 - t × breathAmp × 6
```

**バウンス（発話中のみ）:**
```
amp = shouting ? bounceAmp × 1.5 : bounceAmp
bY = -|sin(animNow/bouncePeriod × π)| × amp
```

**下端固定描画（drawBreath）:**
```
bottom = cy + dh/2 + offY
描画y  = bottom - dh × sY
描画h  = dh × sY
```

### 4-3. GIF ループ揺らぎ（gifWobble）

```javascript
function gifWobble(animNow, seed) {
  const a = cfg.gifWobbleAmp;
  const p = cfg.gifWobblePeriod * 1000;
  return {
    x: sin(animNow/p × 2π + seed) × a + sin(animNow/(p×1.7) × 2π + seed×2.3) × a×0.4,
    y: sin(animNow/(p×1.3) × 2π + seed×1.1) × a + sin(animNow/(p×0.8) × 2π + seed×3.1) × a×0.3,
  };
}
```

複数の異なる周期のサイン波を重ねて非周期的なゆらぎを生成。各レイヤーに異なる `seed` を渡すことで位相がずれる。

### 4-4. 追従遅延バッファ

3系統（`torso`・`head`・`hand`）でそれぞれ独立したリングバッファを持つ。

```
毎フレーム: pushBuf(key, {sY, bY}, now)
            └─ 800ms以上古いエントリを削除
描画時:     readBuf(key, delayMs, fallback)
            └─ performance.now() - delayMs 時点のエントリを後ろから線形探索
```

手の `handFollowDelay = -1` にすると遅延バッファをバイパスして固定配置になる（`drawNormal` を使用）。

### 4-5. GIF 単発再生エンジン（GifPlayer）

まばたき `blinkgif` モード専用。`preload.js` 経由の `gifuct-js` でフレームをデコードし、オフスクリーン Canvas でフレームを進める。

```
GifPlayer.load(url)       → blob/data URL から ArrayBuffer → electronAPI.decodeGif → フレーム展開
GifPlayer.play(onEnd)     → 単発再生。最終フレーム後に onEnd() を呼ぶ
GifPlayer.getCanvas()     → 現在フレームのオフスクリーン Canvas（再生中でない場合は null）
GifPlayer.isReady()       → フレーム展開済みか
GifPlayer.isPlaying()     → 再生中か
```

### 4-6. GIF ループ再生エンジン（createGifLooper / GIF_LOOPERS）

ベースレイヤーおよび差分パッチの GIF 用のループ再生エンジン。

```javascript
// ベースレイヤー
GIF_LOOPERS["layer__state"]       // 例: "eyes__open"
// 差分パッチ
GIF_LOOPERS["patch-{vi}-{pid}"]   // 例: "patch-0-eyes-open"
// アクションパッチ（createActionPlayer インスタンス）
ACTION_PLAYERS["{ai}-{layer}"]    // 例: "0-eyes"
```

`resolveLayer()` は対応キーの GifLooper を確認し、再生中であれば Canvas を返す。

### 4-7. 差分解決（resolveLayer）

```javascript
function resolveLayer(layer, state) {
  const pid = `${layer}-${state}`;
  // activeVariants を末尾（高優先）から順に検索
  for (let i = activeVariants.length - 1; i >= 0; i--) {
    const vi = activeVariants[i];
    const p = variants[vi].patches[pid];
    if (p?.img) {
      const lp = GIF_LOOPERS[`patch-${vi}-${pid}`];
      if (lp?.isReady()) return lp.getCanvas();  // 差分 GIF ループ
      return p.img;                               // 差分静止画
    }
  }
  const key = `${layer}__${state}`;
  const lp = GIF_LOOPERS[key];
  if (lp?.isReady()) return lp.getCanvas();       // ベース GIF ループ
  return BASE[layer][state];                      // ベース静止画
}
```

描画コード内では常に `resolveLayer()` を経由し、`BASE[layer][state]` を直接参照しない。

アクションが再生中のレイヤーは `resolveActionLayer(layer)` が優先して呼ばれる（`render()` 内でチェック）。

### 4-8. まばたきロジック

```
scheduleBlink()
  └─ setTimeout(doBlink, (interval ± jitter×interval) × 1000)

doBlink()
  ├─ [gif モード] GifPlayer.play(scheduleBlink)
  ├─ [3枚モード] blinkFrame: 0→1→2→1→0
  └─ [2枚モード] blinkFrame: 0→2→0
```

差分切替時（`setVariant` / `toggleStackVariant` / `stopAction`）では `_syncBlinkGif()` を呼ぶ。`_syncBlinkGif` はスタック上位から `eyes-blinkgif` パッチを優先して GifPlayer をリロードする。

### 4-9. リップシンク

Web Audio API の FFT で時間域データを取得し **RMS** で音量を 0〜100% に変換、**EMA スムージング**を掛けてから 5段階レベル判定する。

```
rawRms = sqrt( mean( ((sample - 128) / 128)² ) ) × 100

_smoothedAvg = _smoothedAvg × audioSmoothing + rawRms × (1 - audioSmoothing)

lipsyncLevels = [0, 5, 15, 30, 60]  // 各レベルの下限閾値
mouthLevel = 最後に _smoothedAvg >= lipsyncLevels[i] を満たす i
```

口の表示（通常モード）:
- level 0 → `mouth.closed`
- level 1 → `mouth.small`（なければ `mouth.closed`）
- level 2 → `mouth.open`
- level 3 → `mouth.wide`（なければ `mouth.open`）
- level 4 → `mouth.shout`（なければ `mouth.open`）

#### 帯域分割モード（`cfg.bandSplit = true`）

FFT データから低域・中域・高域の RMS を計算し、比率で特殊口形状を判定する。

```
bandH（高域 RMS）/ bandM（中域 RMS）> sibilantThreshold → S.mouthShape = 'sibilant'（歯擦音）
bandL（低域 RMS）/ bandM（中域 RMS）> roundedThreshold → S.mouthShape = 'rounded'（丸口）
それ以外 → S.mouthShape = null（通常レベル判定）
```

`sibilant` / `rounded` 画像が未設定の場合は通常レベル判定にフォールバックする。

### 4-10. ワンショットアクション

差分スロット（状態の維持）とは独立した「イベントレーン」。

```
triggerAction(idx)
  ├─ 同インデックスが再生中 → stopAction()
  └─ それ以外 → playAction(idx)

playAction(index)
  ├─ preActionVariants = activeVariants.slice()  ← 現在スタックをスナップショット
  ├─ GIF パッチを持つレイヤーは createActionPlayer でループ開始
  ├─ doActionLoop() でループカウント管理
  └─ span > 0 なら actionSpanTimer で強制停止

stopAction(returnTo?)
  ├─ 全アクション GIF プレイヤーを停止
  └─ preActionVariants または returnTo でスタックを復元
```

`render()` 内では `resolveActionLayer(layer)` を最初にチェックし、アクションパッチがあればそれを使用、なければ通常のリップシンク・まばたき・差分ロジックが継続する。

アクションは再生中も `activeVariants` を変更しないため、差分で設定した髪型・衣装はアクション中も維持される。

### 4-11. ローカル HTTP API

`main.js` 内の Node.js `http` モジュールで `localhost:cfg.localApiPort` に HTTP サーバーを起動し、コマンドを IPC 経由でレンダラーに転送する。

#### エンドポイント一覧

| メソッド | パス | 動作 |
|---|---|---|
| GET | `/variant/{index\|name\|next\|prev\|reset}` | 差分を切替（index/name は toggleVariant → stackMode 反映） |
| GET | `/action/{index\|name\|stop}` | アクションをトリガー/停止 |
| GET | `/status` | 現在の状態を JSON で返す（`activeVariants`・`activeVariant`・`activeAction` を含む） |

- `/variant/0` 等（数値・名前）は `toggleVariant` を呼ぶため stackMode ON 時はスタック操作になる
- `/variant/next`・`/variant/prev`・`/variant/reset` は常に `setVariant` を呼ぶ
- クエリパラメータ: `/action/0?loop=3&span=5000` でループ数・スパンを一時上書きできる

#### `?set` パラメータ（冪等適用）

`/variant/{index|name}` に `?set` を付けると、トグル（解除）をせず**適用のみ**を行う。

| 状況 | `?set` なし（トグル） | `?set` あり（冪等適用） |
|---|---|---|
| 未適用 → アクセス | 適用 | 適用 |
| 適用済み → アクセス | **解除** | **何もしない** |

```
GET /variant/smile          # 未適用なら適用、適用済みなら解除
GET /variant/smile?set      # 未適用なら適用、適用済みなら何もしない
```

stackMode との組み合わせ:
- stackMode OFF: 未適用なら `setVariant(idx)`（他の差分は置き換わる）
- stackMode ON: スタックに含まれていなければ追加、含まれていれば何もしない

> `?set` は `next`・`prev`・`reset` には適用されない（無視される）。

### 4-12. 入力検知

```
[ローカル] document.keydown（設定パネルフォーカス中のみ有効）
  └─ S.isKbActive = true、keyboardMs ms 後にリセット

[グローバル] uiohook-napi → main.js → IPC → renderer（OBS フォーカス中も有効）
  └─ e.ctrlKey / e.altKey を IPC ペイロードに含める
```

#### ショートカット一覧

| キー | 動作 |
|---|---|
| `S` | 設定パネルを開く（ローカルのみ） |
| `Ctrl+1〜9` | 差分スロット 0〜8（stackMode OFF: 切替、ON: スタック追加/取り除き） |
| `Ctrl+↑` | 差分スロット 9 |
| `Ctrl+←` | 差分スロット 10 |
| `Ctrl+→` | 差分スロット 11 |
| `Ctrl+0` / `Ctrl+↓` | ベース状態にリセット（全スタッククリア） |
| `Ctrl+Alt+1〜8` | ワンショットアクション 0〜7 をトリガー/停止 |

---

## 5. 設定パネル UI

### 5-1. タブ構成

| タブ名 | ID | 内容 |
|---|---|---|
| 🧩 ベースレイヤー | `tab-layers` | 全レイヤーの画像ファイル登録 |
| 🎭 差分スロット | `tab-variants` | 12スロットのパッチ式差分管理・スタックモードトグル |
| ⚡ ワンショット | `tab-actions` | 8スロットのアクション管理（ループ・スパン・レイヤーパッチ） |
| 👁️ まばたき | `tab-blink` | モード・間隔・ジッタ・フレーム長 |
| 🎤 リップシンク | `tab-audio` | マイクデバイス・閾値・スムージング・帯域分割設定 |
| 🌬️ アニメーション | `tab-anim` | アニメFPS・レンダーFPS・呼吸・バウンス・追従遅延 |
| ⌨️ 入力検知 | `tab-input` | KB/マウスアクティブ持続時間・IPC スロットリング・状態プレビュー |
| 💾 プロジェクト | `tab-project` | JSON 保存・読込・GIF 揺らぎ設定・ローカルAPI設定 |

### 5-2. HUD 要素

| 要素 | 説明 |
|---|---|
| `#vvis` | 周波数スペクトル（7バー） |
| `#mic-dot` | マイク ON/OFF インジケーター |
| `#mic-bar` | 音量メーター（rawRms ベース） |
| `#input-status` | 現在の入力状態（⌨️/🖱️/⌨️🖱️/–） |
| `#expr-toast` | 差分切替時のトースト通知（スタック時は "差分1 + 差分3" 形式） |

### 5-3. プレビューモード

画像が1枚も登録されていない場合、`drawDemo()` で Canvas 上にベクターキャラクターを描画してデモを行う。登録後は即座に実画像描画に切り替わる（`hasAnyImage()` で判定）。

---

## 6. Electron 機能

### 6-1. ウィンドウ設定

```javascript
new BrowserWindow({
  transparent: true,    // OBS クロマキー不要の透過ウィンドウ
  frame: false,
  alwaysOnTop: true,    // 配信中は常に最前面
  resizable: true,
})
```

設定パネルを開くと `alwaysOnTop` を解除（ウィンドウ移動しやすいように）、閉じると復元する。

### 6-2. 永続化ファイル（userData フォルダ）

| ファイル | 内容 |
|---|---|
| `window-state.json` | ウィンドウ位置・サイズ（移動/リサイズのたびに 500ms デバウンスで保存） |
| `app-settings.json` | `cfg` オブジェクト（設定パネルを閉じるたびに自動保存） |
| `last-project.json` | 前回のプロジェクト全体（保存/読込操作のたびに更新） |

起動時の復元順序：
1. `last-project.json` があれば `applyProject()` で画像・差分・アクション・cfg を一括復元
2. なければ `app-settings.json` から `cfg` のみ復元

### 6-3. IPC ハンドラー一覧

| チャネル | 方向 | 内容 |
|---|---|---|
| `save-project` | renderer → main | ネイティブ保存ダイアログで JSON を書き出す |
| `load-project` | renderer → main | ネイティブ開くダイアログで JSON を読み込む |
| `save-app-settings` | renderer → main | cfg を app-settings.json に保存 |
| `load-app-settings` | renderer → main | app-settings.json から cfg を返す |
| `save-last-project` | renderer → main | last-project.json にプロジェクトを保存 |
| `load-last-project` | renderer → main | last-project.json を返す |
| `set-always-on-top` | renderer → main | ウィンドウの alwaysOnTop を切替 |
| `quit-app` | renderer → main | アプリを終了 |
| `global-keydown` | main → renderer | uiohook-napi のキーダウンイベントを転送（ctrlKey/altKey を含む） |
| `global-mouse-active` | main → renderer | uiohook-napi のマウスイベントを転送 |
| `start-local-api` | renderer → main | ローカル HTTP サーバーを起動 |
| `stop-local-api` | renderer → main | ローカル HTTP サーバーを停止 |
| `local-api-command` | main → renderer | HTTP リクエストを解析したコマンドを転送 |

### 6-4. preload.js（contextBridge）

`window.electronAPI` として以下を公開：

```javascript
window.electronAPI = {
  saveProject(jsonStr),          // IPC invoke
  loadProject(),                 // IPC invoke
  saveAppSettings(jsonStr),      // IPC invoke
  loadAppSettings(),             // IPC invoke
  saveLastProject(jsonStr),      // IPC invoke
  loadLastProject(),             // IPC invoke
  setAlwaysOnTop(flag),          // IPC invoke
  quitApp(),                     // IPC invoke
  startLocalApi(port),           // IPC invoke
  stopLocalApi(),                // IPC invoke
  onGlobalKeydown(callback),     // IPC on
  onGlobalMouseActive(callback), // IPC on
  onLocalApiCommand(callback),   // IPC on
  decodeGif(arrayBuffer),        // gifuct-js を preload 内で実行してフレームを返す
}
```

---

## 7. プロジェクト保存・読込

### 保存（exportProject）

1. `BASE_SRCS` にはファイル読み込み時点で DataURL が蓄積されている
2. `variants[].patches[].src` も DataURL（`setPatch` 内で `FileReader` 変換済み）
3. `actions[].patches[].src` も DataURL（`loadActionPatch` 内で変換済み）
4. これらを JSON に集めて `electronAPI.saveProject()` → ネイティブ保存ダイアログ
5. 保存成功後に `electronAPI.saveLastProject()` で前回プロジェクトとしても記録

### 読込（importProject / applyProject）

1. `electronAPI.loadProject()` でネイティブダイアログ → JSON 文字列
2. `applyProject()` が処理
   - `cfg` を `Object.assign` で上書き
   - `baseImages` の各エントリを `Image` オブジェクトに復元
   - GIF 素材は `setGifLooper()` でループ再生を開始
   - `variants` を復元（パッチ画像も `Image` に変換、GIF は GifLooper 起動）
   - `actions` を復元（GIF パッチは `createActionPlayer` インスタンスを生成）
   - `syncCfgToUI()` で UI を `cfg` の値に同期
   - `buildVariantList()` / `buildActionList()` で各スロット UI を再構築
3. 読込後も `saveLastProject()` で前回プロジェクトを更新

---

## 8. 既知の課題・制限

| 優先度 | 課題 | 詳細 |
|---|---|---|
| 高 | プロジェクト JSON 肥大化 | Base64 埋め込みのため素材が多いと数十MB超になる。画像をファイルとして分離保存する方式への変更が望ましい |
| 中 | GIF 揺らぎと FPS の干渉 | targetFps を低く設定すると揺らぎの滑らかさも低下する。揺らぎを常に 60fps 相当で計算して FPS キャップとは分離する設計変更の検討が必要 |
| 低 | GIF Disposal の完全対応 | disposalType >= 2 での clearRect は実装済み。disposalType=1（前フレームに重ねる）の処理は未実装 |

---

## 9. バージョン履歴

| バージョン | 変更内容 |
|---|---|
| v0.1 | 初期プロトタイプ（音声反応・まばたき・呼吸・単一ボディレイヤー） |
| v0.2 | 手レイヤー分離（hand_r/hand_l）、パッチ式差分システム（8スロット）、差分 UI |
| v0.3 | キーボード検知バグ修正、body_head/body_torso 分離、FPS 制限スライダー、呼吸アニメ修正（下端固定 scaleY 化）、追従遅延バッファ（3系統） |
| v0.4 | GIF 単発再生（gifuct-js）、GIF ループ揺らぎ、プロジェクト JSON 保存・読込、プロジェクトタブ追加 |
| v0.5 | Electron 化（グローバルホットキー・ネイティブファイル I/O・alwaysOnTop・ウィンドウ位置永続化・前回プロジェクト自動復元）、差分スロット 8→12、ショートカット Ctrl+修飾キー方式、FPS 制御 2 段階化、リップシンク RMS + EMA 化、GIF ループ再生エンジン追加、Z 順変更（body_head 下層化・extra 上層化）、マイクデバイス選択 |
| v0.6 | リップシンク 5段階化（lipsyncLevels）、帯域分割モード（bandSplit / sibilant / rounded）、ワンショットアクション（8スロット・Ctrl+Alt+1〜8・ループ/スパン制御）、ローカル HTTP API（localhost 外部制御）、差分スタックモード（activeVariants[]・複数差分重ね合わせ）、レイヤー Z 順調整（body_head を手の下に）、アクション inheritVariant 廃止（現在の差分スタックを維持したまま再生） |
