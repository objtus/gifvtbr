# gifvtbr 機能拡張計画書 vol.2

**対象**: gifvtbr（Phase 2 Electron版）  
**作成日**: 2026-03-09  
**前提**: リップシンク改善（スムージング・ヒステリシス・5段階口・帯域分割）は実装済み

---

## 1. ワンショットアクション

### 1-1. 設計思想

現在の差分スロットは「状態」（切替・維持するもの）。ワンショットアクションはそれとは別の「イベント」（トリガーして終わるもの）として独立したレーンを設ける。

```
ベースレイヤー          通常時
差分スロット（状態）    ベースへのパッチ。維持する
ワンショット（イベント） ベースor差分へのパッチ。再生して終わる、または明示的に止める
```

### 1-2. 描画上の位置づけ

ワンショット再生中は通常の差分描画の上に各レイヤーを上書きする。差分の状態はそのままで、ワンショットだけ一時的に乗って終わったら元に戻る。

**描画優先順位（ワンショット再生中）:**

```
1. ワンショットに画像が登録されているレイヤー  → ワンショットの画像
2. 引き継ぎ元差分のパッチがあるレイヤー        → 差分の画像
3. それ以外                                     → ベースの画像
```

### 1-3. 各レイヤーの扱い

差分スロットでは手・目・口は状態ごとにバリエーションを持つが、ワンショットでは再生中は1枚で固定する。

| レイヤー | ワンショット中の挙動 |
|---|---|
| body_torso / body_head / extra / bg / fg | 登録画像で上書き（未登録は引き継ぎ元） |
| hand_r / hand_l | 1枚で固定（マウス・KB状態を無視） |
| eyes | 1枚で固定（自動まばたき停止） |
| mouth | 1枚で固定（リップシンク停止） |

ワンショット終了後は自動まばたき・リップシンクを通常に戻す。

### 1-4. ループとスパン

```
ループ回数: 0 = 無限ループ / N = N回再生
スパン:     各ループ間の待機時間(ms)（0で間を置かず連続再生）
```

動作イメージ:

```
[再生] → [終了] → [スパン待機] → [再生] → [終了] → ...

無限ループ(loop=0)の場合:
  → ショートカットキー or ローカルAPIで明示的に止めるまで継続
  → 停止時: 再生前の状態（差分 or ベース）に戻る
```

### 1-5. データ構造

```javascript
const actions = [
  {
    label: 'わらい',
    inheritVariant: 2,    // 引き継ぎ元差分スロットのインデックス（-1でベース）
    loop: 3,              // ループ回数（0 = 無限ループ）
    span: 500,            // ループ間の待機時間(ms)
    shortcutKey: 'F1',    // ショートカットキー（任意、未設定は空文字）
    patches: {
      // 登録のないレイヤーは引き継ぎ元（差分orベース）の画像をそのまま使う
      body_torso: { src: 'data:image/gif;base64,...' },
      body_head:  { src: 'data:image/gif;base64,...' },
      hand_r:     { src: 'data:image/png;base64,...' },  // 状態問わず1枚で固定
      eyes:       { src: 'data:image/gif;base64,...' },  // まばたき無視して固定
      mouth:      { src: 'data:image/gif;base64,...' },  // リップシンク無視して固定
    }
  },
  // ...
];

// ランタイム状態
let activeAction = -1;      // 再生中のアクションインデックス（-1=なし）
let actionLoopCount = 0;    // 現在のループ回数カウント
let preActionVariant = -1;  // アクション再生前の差分状態（終了時に復元用）
```

### 1-6. 再生・停止ロジック

```
playAction(index, overrideLoop, overrideSpan):
  1. preActionVariant = activeVariant を保存
  2. activeAction = index
  3. まばたき・リップシンクを一時停止
  4. GifPlayer で各レイヤーのGIFを再生開始
  5. 再生終了後:
       actionLoopCount++
       loop が 0（無限）        → span 待機後に再再生
       actionLoopCount < loop   → span 待機後に再再生
       actionLoopCount >= loop  → stopAction()

stopAction(returnTo):
  1. activeAction = -1
  2. actionLoopCount = 0
  3. returnTo が指定されていれば setVariant(returnTo)
     指定なし → setVariant(preActionVariant)  // 再生前の状態に戻る
  4. まばたき・リップシンクを再開
```

### 1-7. 停止時の戻り先（優先順位）

```
1. APIで stop?variant=N を指定した場合    → その差分に移行
2. stopAction(N) で明示的に指定した場合   → その差分に移行
3. デフォルト                             → 再生前の状態（preActionVariant）に戻る
```

### 1-8. ショートカットキー

差分スロット（`Ctrl+1〜9`）と体系を揃えつつ競合しないキーを使う。

```
Ctrl+Alt+1〜8   ワンショット1〜8に対応
0               再生中のワンショットを停止（既存の「ベースに戻る」キーと共用）
```

- F1〜F8は他ウィンドウとの競合リスクがあるため採用しない
- テンキー入手後は `Numpad 1〜8`（修飾キーなし）もデュアル対応する予定

### 1-9. 設定UI

差分スロットタブに近い構造で「ワンショット」タブを新設する。

```
ワンショット1
  [名前入力]  [引き継ぎ: ベース▼]  [ループ: 3回]  [スパン: 500ms]  [キー: F1▼]
  └─ ボディ胴体  [ファイル選択]  [サムネ]  [✕]
  └─ ボディ頭部  [ファイル選択]  [サムネ]  [✕]
  └─ 右手        [ファイル選択]  [サムネ]  [✕]  ※再生中はマウス状態を無視
  └─ 左手        [ファイル選択]  [サムネ]  [✕]  ※再生中はKB状態を無視
  └─ 目          [ファイル選択]  [サムネ]  [✕]  ※再生中はまばたき停止
  └─ 口          [ファイル選択]  [サムネ]  [✕]  ※再生中はリップシンク停止
  └─ アクセサリ  [ファイル選択]  [サムネ]  [✕]
  [▶ テスト再生]  [■ 停止]
```

ループ回数0は「∞」と表示する。

---

## 2. ローカルAPI

### 2-1. 設計思想

Electronアプリ内でNode.jsの `http` モジュール（標準ライブラリ、追加インストール不要）を使い `localhost` の特定ポートをListenする。外部には公開しないローカル専用のため、セキュリティ上の懸念はほぼない。

```javascript
// main.js に追加（express不要）
const http = require('http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // ルーティング処理
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(cfg.localApiPort);
```

### 2-2. エンドポイント設計

**差分系（状態）**

```
GET /variant/{0〜7}    差分スロット指定
GET /variant/reset     ベースに戻す（/variant/-1 でも可）
GET /variant/next      次のスロットに進む（ローテーション）
GET /variant/prev      前のスロットに戻す
```

**ワンショット系（イベント）**

```
GET /action/{index}                       インデックス指定で再生（デフォルト設定）
GET /action/{name}                        名前指定で再生
GET /action/{index}?loop=5&span=2000      ループ回数・スパンをAPIから上書き
GET /action/{index}?loop=0               無限ループで起動
GET /action/stop                          再生中のアクションを停止（再生前の状態に戻る）
GET /action/stop?variant=2               停止して指定差分に移行
```

**ステータス取得**

```
GET /status    現在の状態をJSONで返す
```

```json
{
  "activeVariant": 2,
  "activeAction": -1,
  "isPlaying": false
}
```

### 2-3. URLパラメータによる上書き

アクション自体のデフォルト値を使いつつ、APIから呼ぶときだけ変えられる。

```
/action/わらい                → action.loop=3, action.span=500 で再生
/action/わらい?loop=10        → ループだけ上書き、spanはデフォルト
/action/わらい?loop=0         → 無限ループで起動
/action/わらい?loop=5&span=1000 → 両方上書き
```

### 2-4. 主な連携用途

| 連携先 | 用途 | 方法 |
|---|---|---|
| コメントビューワー | 特定コメントで表情切替・アクション再生 | プラグインからHTTP送信 |
| コメントビューワー | `!わらい` コマンドで視聴者がアクション起動 | プラグインからHTTP送信 |
| StreamDeck | ボタン1つで差分切替・アクション再生 | URLアクションで直接叩く |
| OBSシーン切替 | シーンに連動して差分を自動変更 | OBSのLua/Pythonスクリプト |
| 自作ダッシュボード | ブラウザからコントロールパネルを操作 | `/status` + 各エンドポイント |
| 外部配信ツール | Lumiastream・Mix It Up等からイベント連携 | HTTP送信 |

### 2-5. cfg・設定UI

```javascript
// cfg に追加
localApiPort:    3000,
localApiEnabled: true,
```

設定パネルに「ローカルAPI」セクションを追加する（プロジェクトタブ or 専用タブ）。

```
ローカルAPI
  [有効/無効トグル]
  ポート番号: [3000]
  状態: ● 待機中 / ● 停止中
  エンドポイント一覧（折りたたみ）
```

---

## 3. プロジェクトJSONへの追加

```json
{
  "version": "0.5",
  "cfg": {
    "localApiPort": 3000,
    "localApiEnabled": true
  },
  "variants": [ "..." ],
  "actions": [
    {
      "label": "わらい",
      "inheritVariant": 2,
      "loop": 3,
      "span": 500,
      "shortcutKey": "F1",
      "patches": {
        "body_head": { "src": "data:image/gif;base64,..." },
        "eyes":      { "src": "data:image/gif;base64,..." }
      }
    }
  ]
}
```

---

## 4. 実装順序と工数見積もり

ワンショットを先に実装し、ローカルAPIはその後に追加する。ローカルAPIはワンショットが動いていないと `/action` 系エンドポイントが意味をなさないため。

| 順序 | 施策 | 工数目安 | 備考 |
|---|---|---|---|
| 1 | ワンショット データ構造・描画 | 3〜4時間 | GifPlayerの使い回しで描画は比較的軽い |
| 2 | ワンショット ループ・スパン制御 | 1〜2時間 | 1の延長 |
| 3 | ワンショット 設定UI | 2〜3時間 | 差分スロットUIに近い構造で流用できる |
| 4 | ローカルAPI | 2〜3時間 | main.jsへの追加、electron IPC経由でレンダラーに転送 |