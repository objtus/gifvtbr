# リップシンク改善計画

**対象**: gifvtbr v0.5（Electron 版）  
**作成日**: 2026-03-06  
**更新日**: 2026-03-06（v0.5 実装に合わせて改訂）  
**方針**: 音素解析などの高コスト実装は行わない。既存の音量データを活用し、低コストで表現力を高める

---

## 1. 現状の整理

### 現在の実装（v0.5）

```
[音量計算]
analyser.getByteTimeDomainData(timeData)   // 時間域サンプル 2048点
rawRms = sqrt( mean( ((sample - 128) / 128)² ) ) × 100  // 0〜100%（RMS）

[EMAスムージング]
_smoothedAvg = _smoothedAvg × audioSmoothing + rawRms × (1 − audioSmoothing)
// audioSmoothing=0.3 → 旧値30%・新値70%（比較的応答が速い設定）

[閾値判定]
_smoothedAvg >= audioShout(30)     → S.shouting=true,  S.talking=true  → 口_叫
_smoothedAvg >= audioThreshold(5)  → S.shouting=false, S.talking=true  → 口_開
それ以外                           → S.shouting=false
                                     talking が true なら mouthCloseDelay 後に false → 口_閉
```

> **v0.3 からの変更点**  
> - 計算ソース: FFT bin 0〜59 の平均値 → **時間域 RMS（0〜100%）**  
> - 閾値の単位: FFT bin 値（0〜255相当） → **RMS %（0〜100）**  
> - デフォルト値: audioThreshold 12 → **5** / audioShout 60 → **30**  
> - EMAスムージング（施策A相当）: **実装済み**（`audioSmoothing` パラメータ）

### 問題点

| 問題 | 原因 | 対応施策 |
|---|---|---|
| 閾値付近で口がカクカクする（緩和済みだが残存） | スムージング後も単純閾値比較のため、境界付近のばたつきが残る | 施策B（ヒステリシス） |
| 声の強弱が口の動きに反映されない | 音量を「閉・開・叫」の3段階に圧縮している | 施策C（口の状態追加） |
| 静かな発話と大きな発話で口の形が同じ | 口ステートが3種類しかない | 施策C |

---

## 2. 改善施策

優先度順に記載する。施策は独立しており、順番に実装できる。

---

### 施策A: スムージング ✅ 実装済み

v0.5 で `audioSmoothing` パラメータとして実装済み。

#### 現在の実装

```javascript
// cfg 内
audioSmoothing: 0.3,   // 旧値の重み（0=即時応答 / 大きいほど短い音に鈍感）

// tickAudio 内
_smoothedAvg = _smoothedAvg * cfg.audioSmoothing + rawRms * (1 - cfg.audioSmoothing);
```

> **計画との差分**  
> - 計画では `lipsyncSmooth`（新値の重み α）として定義していたが、実装では `audioSmoothing`（**旧値**の重み）として定義されており、方向が逆
> - 計画の `lipsyncSmooth=0.4`（応答性重視）≒ 実装の `audioSmoothing=0.6` に相当
> - 実装のデフォルト `audioSmoothing=0.3` は計画の `lipsyncSmooth=0.7` に相当（かなりスムーズ寄り）
> - UI は リップシンクタブの「スムージング」スライダーとして実装済み

#### 残課題

単純な EMA のみのため、キーボード打鍵のような短い衝撃音のスパイクが突き抜けることがある。施策Bと組み合わせることで解消できる。

---

### 施策B: ヒステリシス（優先度：高 / 実装コスト：小）

#### 目的

閾値をまたぐ瞬間のチャタリング（口のカクカク）を防ぐ。上がるときと下がるときで判定閾値を変える。

#### 現状の補完

`mouthCloseDelay`（デフォルト 180ms）が「声が止まってからすぐに口が閉じない」動作を提供しており、下降方向の遅延として機能している。ただし上昇方向（声が出た瞬間に口が開くまで）のヒステリシスがなく、境界付近では口が小刻みに開閉する。

#### 実装

現在の `tickAudio` 内の閾値判定部分を以下に置き換える。

```javascript
// cfg に追加
hystDown: 0.7,   // 下降時の閾値係数（audioThreshold × hystDown を下回るまで talking を維持）
                 // 推奨範囲: 0.4〜0.9（小さいほど境界帯が広くなり安定する）

// tickAudio 内（_smoothedAvg 計算後）
if (_smoothedAvg >= cfg.audioShout) {
  // 叫び: 口閉じタイマーをキャンセルして即座に反応
  clearTimeout(mouthTimer); mouthTimer = null;
  S.shouting = true; S.talking = true;

} else if (_smoothedAvg >= cfg.audioThreshold) {
  // 発話: 口閉じタイマーをキャンセルして即座に反応
  clearTimeout(mouthTimer); mouthTimer = null;
  S.shouting = false; S.talking = true;

} else if (_smoothedAvg < cfg.audioThreshold * cfg.hystDown) {
  // ヒステリシス帯より下に入った場合のみ口閉じスケジュール
  S.shouting = false;
  if (S.talking && mouthTimer === null) {
    mouthTimer = setTimeout(() => { S.talking = false; mouthTimer = null; }, cfg.mouthCloseDelay);
  }
}
// audioThreshold × hystDown 〜 audioThreshold の間はいずれの状態も変えない（ヒステリシス帯）
```

#### 設定UI（リップシンクタブに追加）

| パラメータ | cfg キー | HTML ID | 範囲 | デフォルト |
|---|---|---|---|---|
| ヒステリシス | `hystDown` | `hyst-down` | 0.1〜1.0 | 0.7 |

---

### 施策C: 口の状態を増やす（優先度：中 / 実装コスト：中）

#### 目的

「閉・開・叫」の3段階を「閉・小・中・大・叫」の5段階に増やし、音量の強弱を口の開き具合に反映する。

#### 素材要件

| ステートID | 表示名 | 音量レベル | 必須 |
|---|---|---|---|
| `mouth.closed` | 口_閉 | 無音 | ○（既存） |
| `mouth.small` | 口_小 | 小声 | 任意 |
| `mouth.open` | 口_開（中） | 通常発話 | ○（既存） |
| `mouth.wide` | 口_大 | 大声 | 任意 |
| `mouth.shout` | 口_叫 | 叫び | ○（既存） |

`small` と `wide` は任意登録。未登録の場合は隣の段階にフォールバックする。

#### フォールバックロジック

```javascript
function resolveMouth(level) {
  // level: 0=closed, 1=small, 2=open, 3=wide, 4=shout
  const states = ['closed', 'small', 'open', 'wide', 'shout'];
  for (let i = level; i >= 0; i--) {
    const img = resolveLayer('mouth', states[i]);
    if (img) return img;
  }
  return null;
}
```

#### 閾値設定

5段階の境界値を cfg で管理する。既存の `audioThreshold` / `audioShout` はこの配列に統合するか互換維持する。

```javascript
// cfg に追加（単位は RMS %、0〜100）
lipsyncLevels: [0, 5, 15, 30, 60],
// index: 0=closed境界, 1=small境界, 2=open境界, 3=wide境界, 4=shout境界
// 現在の audioThreshold=5 → index[1]、audioShout=30 → index[4] に相当
```

設定 UI はリップシンクタブに「段階設定」セクションとしてスライダー5本（または範囲スライダー）を追加。

#### BASE への追加

```javascript
mouth: {
  closed: null,
  small:  null,   // 追加（任意）
  open:   null,
  wide:   null,   // 追加（任意）
  shout:  null,
}
```

#### PATCHABLE への追加

```javascript
{ id:'mouth-small', label:'口_小', layer:'mouth', state:'small' },
{ id:'mouth-wide',  label:'口_大', layer:'mouth', state:'wide'  },
```

差分スロットの各パッチ行にも `口_小` `口_大` が登録できるようになる。

---

### 施策D: 帯域分割（優先度：低 / 実装コスト：小）

#### 目的

全帯域の RMS ではなく、周波数帯ごとの音量を個別に扱うことで声の質感を捉える。施策C と組み合わせると効果が出やすい。

#### 現在の状況

v0.5 の `tickAudio` では `getByteFrequencyData(freqData)` と `getByteTimeDomainData(timeData)` の両方を取得している。`freqData` はビジュアライザーバー表示のみに使われており、リップシンク判定には未使用。この `freqData` を活用すれば追加コストなしで帯域分割が実現できる。

#### 実装

```javascript
// tickAudio 内の freqData を活用（fftSize=2048, frequencyBinCount=1024）
// サンプリングレート 48kHz の場合、1bin ≈ 23Hz
// 以下は bin インデックスの目安（マイク・環境依存）
const low  = average(freqData,  0,  20);  // 〜460Hz: 低域（母音の芯・基音）
const mid  = average(freqData, 20,  80);  // 460Hz〜1840Hz: 中域（通常発話の主成分）
const high = average(freqData, 80, 150);  // 1840Hz〜3450Hz: 高域（歯擦音・サ行）

function average(arr, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i];
  return s / (to - from) / 255 * 100;  // 0〜100% に正規化
}
```

#### 活用例

- **口の開き判定**: `mid` を主軸にする（声の実体が最も乗る帯域）
- **歯擦音検出**: `high` が一定以上かつ `mid` が低い → 「い」「す」のような口形状（施策C の `small` 相当）に切り替える
- **低音検出**: `low` が高い → 「うー」のような丸い口形状への対応（将来の拡張）

---

## 3. 実装順序と工数見積もり

| 順序 | 施策 | ステータス | 工数目安 | 効果 |
|---|---|---|---|---|
| — | A: スムージング | ✅ 実装済み | — | 動きの滑らかさが改善（実装済み） |
| 1 | B: ヒステリシス | 未実装 | 30分 | カクカクがなくなる |
| 2 | C: 口の状態追加 | 未実装 | 2〜3時間 | 表現の幅が大きく広がる |
| 3 | D: 帯域分割 | 未実装 | 1時間 | Cと組み合わせて質感向上 |

B は既存コードへの数行追加で完結する。C 以降は素材側の追加も必要になる。

---

## 4. cfg・UI 変更まとめ

### cfg フィールドの状態

```javascript
// ── 実装済み ──
audioThreshold:  5,      // 発話判定閾値（RMS %）
audioShout:      30,     // 叫び判定閾値（RMS %）
mouthCloseDelay: 180,    // 発話停止後の口閉じ遅延(ms)
audioSmoothing:  0.3,    // EMAスムージング（旧値の重み）

// ── 施策B で追加 ──
hystDown: 0.7,           // ヒステリシス係数（0.4〜0.9 推奨）

// ── 施策C で追加（audioThreshold / audioShout と置き換えまたは併存） ──
lipsyncLevels: [0, 5, 15, 30, 60],   // 5段階の下限閾値（RMS %）
```

### BASE への追加ステート（施策C）

```javascript
mouth: {
  closed: null,
  small:  null,   // 追加（任意）
  open:   null,
  wide:   null,   // 追加（任意）
  shout:  null,
}
```

### PATCHABLE への追加（施策C）

```javascript
{ id:'mouth-small', label:'口_小', layer:'mouth', state:'small' },
{ id:'mouth-wide',  label:'口_大', layer:'mouth', state:'wide'  },
```

### リップシンクタブ UI への追加

| 追加箇所 | 施策 | 内容 |
|---|---|---|
| 音量閾値セクション | B | ヒステリシス係数スライダー (`hyst-down`) |
| 新セクション「口の段階設定」 | C | 5段階の下限閾値スライダー × 5本（またはマルチハンドルスライダー） |

---

## 5. 実装しないこと（スコープ外）

- 音素解析（WebAssembly + 音響モデル）
- 母音分類（あいうえお判定）
- 顔の向きや視線との連動
- 機械学習を使ったリップシンク

これらは精度は高いが実装コストが大きく、現在の用途（配信アバター）では費用対効果が低い。
