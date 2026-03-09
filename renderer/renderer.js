'use strict';

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const cfg = {
  mouthCloseDelay:180, audioSmoothing:0.3,
  lipsyncLevels:[0,5,15,30,60], // [closed,small,open,wide,shout] の下限閾値（RMS %）
  stackMode:false,               // 差分スタックモード（true=重ね合わせ、false=単一切替）
  bandSplit:false,               // 帯域分割モード（true=中域RMS主軸、false=全域RMS）
  sibilantThreshold:15,          // 歯擦音判定閾値（bandSplit有効時のみ）
  roundedThreshold:10,           // 丸口判定閾値（bandSplit有効時のみ）
  localApiPort:3000, localApiEnabled:false,
  blinkMode:'2', blinkInterval:4, blinkJitter:.4, blinkFrameMs:50,
  breathAmp:.012, breathPeriod:3.5,
  bounceAmp:5, bouncePeriod:220,
  keyboardMs:2000, mouseMs:1500, mouseMoveThrottle:0,
  handFollowDelay:60, torsoFollowDelay:0, headFollowDelay:30,
  targetFps:30,      // アニメステップFPS（呼吸・バウンス・GIF揺らぎ）
  responseFps:60,    // レンダーFPS（まばたき・口パク・入力ポーズの描画更新レート）
  gifWobbleAmp:1.2, gifWobblePeriod:2.8,
};

// ══════════════════════════════════════════
//  GIF単発再生エンジン（まばたき blinkgif 用）
//  フレームデコードは preload 経由の gifuct-js を使用
// ══════════════════════════════════════════
const GifPlayer = (() => {
  let frames=[], cursor=-1, frameTimer=null, offCanvas=null, offCtx=null;

  async function load(url) {
    if(!window.electronAPI?.decodeGif) return;
    // blob URL は fetch、data URL は base64 直接デコードで ArrayBuffer 取得
    let ab;
    if(url.startsWith('data:')){
      const b64=url.split(',')[1];
      const bin=atob(b64);
      const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      ab=bytes.buffer;
    } else {
      ab=await fetch(url).then(r=>r.arrayBuffer());
    }
    const result=window.electronAPI.decodeGif(ab);
    offCanvas=document.createElement('canvas');
    offCanvas.width=result.width; offCanvas.height=result.height;
    offCtx=offCanvas.getContext('2d');
    frames=result.frames; cursor=-1;
  }

  function play(onEnd) {
    if(!frames.length) return;
    clearTimeout(frameTimer); cursor=0; step(onEnd);
  }
  function step(onEnd) {
    if(cursor<0||cursor>=frames.length){ cursor=-1; if(onEnd)onEnd(); return; }
    const f=frames[cursor];
    if(f.disposalType>=2) offCtx.clearRect(0,0,offCanvas.width,offCanvas.height);
    offCtx.putImageData(new ImageData(f.patch,f.dims.width,f.dims.height),f.dims.left,f.dims.top);
    frameTimer=setTimeout(()=>{ cursor++; step(onEnd); }, f.delay||80);
  }

  return {
    load, play,
    getCanvas:()=>(offCanvas&&cursor>=0)?offCanvas:null,
    isReady:()=>frames.length>0,
    isPlaying:()=>cursor>=0,
  };
})();

// ══════════════════════════════════════════
//  アクション用単発再生エンジン（ワンショット各レイヤー用）
//  GifPlayer と同一ロジックをファクトリ関数として分離
//  各レイヤーに独立したインスタンスを持てる
// ══════════════════════════════════════════
function createActionPlayer(){
  let frames=[], cursor=-1, frameTimer=null, canvas=null, offCtx=null;

  async function load(url){
    if(!window.electronAPI?.decodeGif) return;
    let ab;
    if(url.startsWith('data:')){
      const b64=url.split(',')[1];
      const bin=atob(b64);
      const bytes=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      ab=bytes.buffer;
    } else {
      ab=await fetch(url).then(r=>r.arrayBuffer());
    }
    const result=window.electronAPI.decodeGif(ab);
    canvas=document.createElement('canvas');
    canvas.width=result.width; canvas.height=result.height;
    offCtx=canvas.getContext('2d');
    frames=result.frames; cursor=-1;
  }

  function play(onEnd){
    if(!frames.length){ if(onEnd)onEnd(); return; }
    clearTimeout(frameTimer); cursor=0; step(onEnd);
  }
  function step(onEnd){
    if(cursor<0||cursor>=frames.length){ cursor=-1; if(onEnd)onEnd(); return; }
    const f=frames[cursor];
    if(f.disposalType>=2) offCtx.clearRect(0,0,canvas.width,canvas.height);
    offCtx.putImageData(new ImageData(f.patch,f.dims.width,f.dims.height),f.dims.left,f.dims.top);
    frameTimer=setTimeout(()=>{ cursor++; step(onEnd); }, f.delay||80);
  }

  return {
    load, play,
    stop(){ clearTimeout(frameTimer); cursor=-1; },
    getCanvas(){ return (canvas&&cursor>=0)?canvas:null; },
    isReady(){ return frames.length>0; },
    isPlaying(){ return cursor>=0; },
  };
}

// ══════════════════════════════════════════
//  GIF ループ再生エンジン（ベースレイヤー・差分パッチ用）
//  GifPlayer と同じく preload 経由の gifuct-js を使用し、
//  オフスクリーン canvas でフレームを自走させる
// ══════════════════════════════════════════
function isGifFile(file){ return file&&(file.type==='image/gif'||file.name?.toLowerCase().endsWith('.gif')); }
function isGifSrc(src){ return typeof src==='string'&&src.startsWith('data:image/gif'); }

async function _urlToArrayBuffer(url){
  if(url.startsWith('data:')){
    const b64=url.split(',')[1];
    const bin=atob(b64);
    const bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return bytes.buffer;
  }
  return fetch(url).then(r=>r.arrayBuffer());
}

function createGifLooper(){
  let frames=[], cursor=0, timer=null, canvas=null, offCtx=null;

  // step() 自体を try/catch で包む
  // → setTimeout コールバック内のエラーも捕捉してアニメーションを継続
  function step(){
    if(!frames.length || !canvas) return;
    const f=frames[cursor];
    try {
      if(f.disposalType>=2) offCtx.clearRect(0,0,canvas.width,canvas.height);
      offCtx.putImageData(new ImageData(f.patch,f.dims.width,f.dims.height),f.dims.left,f.dims.top);
    } catch(e){
      console.error('[GIF step error] frame',cursor,
        'patch.length=',f.patch?.length,
        'dims=',f.dims, e);
    }
    cursor=(cursor+1)%frames.length;
    timer=setTimeout(step, f.delay||80);
  }

  return {
    async load(url){
      clearTimeout(timer); frames=[]; canvas=null;
      if(!window.electronAPI?.decodeGif){
        console.error('[GIF] window.electronAPI.decodeGif が見つかりません');
        return;
      }
      try {
        const ab=await _urlToArrayBuffer(url);
        console.log('[GIF] ArrayBuffer 取得完了, size=', ab.byteLength);
        const result=window.electronAPI.decodeGif(ab);
        console.log('[GIF] デコード完了 width=',result.width,' height=',result.height,' frames=',result.frames.length);
        canvas=document.createElement('canvas');
        canvas.width=result.width; canvas.height=result.height;
        offCtx=canvas.getContext('2d');
        frames=result.frames; cursor=0;
        step();
      } catch(e){
        console.error('[GIF loop load error]', e);
        frames=[]; canvas=null;
      }
    },
    stop(){ clearTimeout(timer); frames=[]; canvas=null; },
    getCanvas(){ return (canvas&&frames.length)?canvas:null; },
    isReady(){ return frames.length>0; },
  };
}

const GIF_LOOPERS={};

function setGifLooper(key, url){
  GIF_LOOPERS[key]?.stop();
  const looper=createGifLooper();
  GIF_LOOPERS[key]=looper;
  looper.load(url).catch(e=>console.warn('GIF looper load error:',e));
}
function clearGifLooper(key){
  GIF_LOOPERS[key]?.stop();
  delete GIF_LOOPERS[key];
}

// ══════════════════════════════════════════
//  BASE IMAGES
// ══════════════════════════════════════════
const BASE = {
  bg:{default:null}, body_torso:{default:null}, body_head:{default:null},
  hand_r:{default:null,mouse:null}, hand_l:{default:null,keyboard:null},
  eyes:{open:null,half:null,closed:null,blinkgif:null},
  mouth:{closed:null,small:null,open:null,wide:null,shout:null,sibilant:null,rounded:null},
  extra_t1:{default:null}, extra_t2:{default:null}, extra_t3:{default:null},
  extra_h1:{default:null}, extra_h2:{default:null}, extra_h3:{default:null},
  fg:{default:null},
};
const BASE_SRCS = {}; // key="layer__state" → dataURL（保存用）

// input[type=file] は JS からファイルを設定できないため、
// 読み込み済み状態を示すバッジを input の直後に挿入して視覚的に区別する
function setFileLoadedBadge(input){
  if(!input) return;
  if(input.nextElementSibling?.classList.contains('file-loaded-badge')) return; // 重複防止
  const badge=document.createElement('span');
  badge.className='file-loaded-badge';
  badge.textContent='✓ 読込済';
  input.after(badge);
}

function loadBase(layer, state, input) {
  const file=input.files[0]; if(!file) return;
  const url=URL.createObjectURL(file);
  const img=new Image(); img.src=url;
  BASE[layer][state]=img;
  const key=`${layer}__${state}`;
  // blinkgif 以外の GIF はループ再生エンジンを起動（blob URL を直接渡す）
  if(state!=='blinkgif' && isGifFile(file)){
    setGifLooper(key, url);
  } else {
    clearGifLooper(key);
  }
  // DataURL 化して保存用に保持
  const fr=new FileReader();
  fr.onload=e=>{ BASE_SRCS[key]=e.target.result; };
  fr.readAsDataURL(file);
  const th=document.getElementById(`th-${layer}-${state}`);
  if(th){ th.src=url; th.classList.add('has'); }
  setFileLoadedBadge(input);
  if(layer==='eyes'&&state==='blinkgif')
    GifPlayer.load(url).catch(e=>console.warn('GIF:',e));
}

// ══════════════════════════════════════════
//  VARIANT（パッチ式差分）
// ══════════════════════════════════════════
const PATCHABLE=[
  {id:'body_torso-default',label:'ボディ(胴体)',layer:'body_torso',state:'default'},
  {id:'body_head-default', label:'ボディ(頭部)',layer:'body_head', state:'default'},
  {id:'eyes-open',         label:'目_開',       layer:'eyes',      state:'open'},
  {id:'eyes-half',         label:'目_半',       layer:'eyes',      state:'half'},
  {id:'eyes-closed',       label:'目_閉',       layer:'eyes',      state:'closed'},
  {id:'eyes-blinkgif',     label:'まばたきGIF', layer:'eyes',      state:'blinkgif'},
  {id:'mouth-closed',      label:'口_閉',       layer:'mouth',     state:'closed'},
  {id:'mouth-small',       label:'口_小',       layer:'mouth',     state:'small'},
  {id:'mouth-open',        label:'口_開',       layer:'mouth',     state:'open'},
  {id:'mouth-wide',        label:'口_大',       layer:'mouth',     state:'wide'},
  {id:'mouth-shout',       label:'口_叫',       layer:'mouth',     state:'shout'},
  {id:'mouth-sibilant',    label:'口_歯擦',     layer:'mouth',     state:'sibilant'},
  {id:'mouth-rounded',     label:'口_丸',       layer:'mouth',     state:'rounded'},
  {id:'hand_r-default',    label:'右手_通常',   layer:'hand_r',    state:'default'},
  {id:'hand_r-mouse',      label:'右手_マウス', layer:'hand_r',    state:'mouse'},
  {id:'hand_l-default',    label:'左手_通常',   layer:'hand_l',    state:'default'},
  {id:'hand_l-keyboard',   label:'左手_KB',     layer:'hand_l',    state:'keyboard'},
  {id:'extra_t1-default',  label:'胴体アクセサリ1', layer:'extra_t1', state:'default'},
  {id:'extra_t2-default',  label:'胴体アクセサリ2', layer:'extra_t2', state:'default'},
  {id:'extra_t3-default',  label:'胴体アクセサリ3', layer:'extra_t3', state:'default'},
  {id:'extra_h1-default',  label:'頭部アクセサリ1', layer:'extra_h1', state:'default'},
  {id:'extra_h2-default',  label:'頭部アクセサリ2', layer:'extra_h2', state:'default'},
  {id:'extra_h3-default',  label:'頭部アクセサリ3', layer:'extra_h3', state:'default'},
  {id:'fg-default',        label:'前景',            layer:'fg',       state:'default'},
];

// ショートカットキーの表示ラベル（スロットインデックス対応）
// スロット 0-8: Ctrl+1〜9、スロット 9-11: Ctrl+↑←→
const VARIANT_KEYS=['1','2','3','4','5','6','7','8','9','↑','←','→'];
const VARIANT_SLOT_COUNT=12;

const variants=Array.from({length:VARIANT_SLOT_COUNT},(_,i)=>({label:`差分${i+1}`,patches:{},open:false}));
let activeVariants=[];  // スタック。末尾が最高優先度（単一モード時は最大1要素）

function resolveLayer(layer,state){
  const pid=`${layer}-${state}`;
  // activeVariants を末尾（高優先）から順に検索
  for(let i=activeVariants.length-1;i>=0;i--){
    const vi=activeVariants[i];
    const p=variants[vi].patches[pid];
    if(p?.img){
      const lp=GIF_LOOPERS[`patch-${vi}-${pid}`];
      if(lp?.isReady()) return lp.getCanvas();
      return p.img;
    }
  }
  const key=`${layer}__${state}`;
  const lp=GIF_LOOPERS[key];
  if(lp?.isReady()) return lp.getCanvas();
  return BASE[layer][state];
}

// ══════════════════════════════════════════
//  ワンショットアクション データ構造
//  差分スロット（状態の維持）と独立した「イベントレーン」
// ══════════════════════════════════════════
const ACTION_LAYERS=['bg','body_torso','body_head','hand_r','hand_l','mouth','eyes',
  'extra_t1','extra_t2','extra_t3','extra_h1','extra_h2','extra_h3','fg'];
const ACTION_SLOT_COUNT=8;
const actions=Array.from({length:ACTION_SLOT_COUNT},(_,i)=>({
  label:`アクション${i+1}`, loop:1, span:0, patches:{}
}));
// patches キーはレイヤー名（'eyes' 等）。差分スロットの 'eyes-open' 形式と異なりステート問わず1枚固定
let activeAction=-1, actionLoopCount=0, preActionVariants=[], actionSpanTimer=null;
const ACTION_PLAYERS={}; // key: `${ai}-${layer}` → createActionPlayer インスタンス

// アクション再生中に指定レイヤーの画像を返す（非アクティブ時は null）
function resolveActionLayer(layer){
  if(activeAction<0) return null;
  const p=actions[activeAction].patches[layer];
  if(!p?.img) return null;
  const pl=ACTION_PLAYERS[`${activeAction}-${layer}`];
  return pl?.getCanvas()||p.img;
}

// ══════════════════════════════════════════
//  口レベル解決（5段階フォールバック付き）
//  level: 0=closed 1=small 2=open 3=wide 4=shout
//  未登録ステートは level を下げながらフォールバック
// ══════════════════════════════════════════
function resolveMouth(level){
  const states=['closed','small','open','wide','shout'];
  for(let i=level;i>=0;i--){
    const img=resolveLayer('mouth',states[i]);
    if(img) return img;
  }
  return null;
}

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
const S={talking:false,shouting:false,blinkFrame:0,isMouseActive:false,isKbActive:false,mouthLevel:0,mouthShape:null};

// ══════════════════════════════════════════
//  CANVAS
// ══════════════════════════════════════════
const canvas=document.getElementById('c');
const ctx=canvas.getContext('2d');
let W=innerWidth,H=innerHeight;
canvas.width=W; canvas.height=H;
addEventListener('resize',()=>{ W=innerWidth; H=innerHeight; canvas.width=W; canvas.height=H; });

// ══════════════════════════════════════════
//  2層 FPS レンダーループ
//  responseFps: canvas 描画頻度（まばたき・口パク・入力ポーズ）
//  targetFps  : アニメ時刻の進行ステップ（呼吸・バウンス・GIF揺らぎ）
// ══════════════════════════════════════════
let lastFrameTime=0;
let _lastAnimTick=0;
let _animNow=0; // アニメ計算に使う「コマ送り時刻」

function renderLoop(now){
  requestAnimationFrame(renderLoop);
  // 描画頻度は responseFps でキャップ
  if(now-lastFrameTime < 1000/cfg.responseFps-1) return;
  lastFrameTime=now;
  // アニメ時刻は targetFps ステップでのみ進める
  if(now-_lastAnimTick >= 1000/cfg.targetFps-1){
    _lastAnimTick=now;
    _animNow=now;
  }
  render(now, _animNow);
}
requestAnimationFrame(renderLoop);

// ══════════════════════════════════════════
//  アニメ計算
// ══════════════════════════════════════════
function breathScaleY(now){
  const t=(1-Math.cos((now/1000)*(Math.PI*2/cfg.breathPeriod)))/2;
  return 1.0-t*cfg.breathAmp*6;
}
function bounceOffsetY(now){
  if(!S.talking&&!S.shouting) return 0;
  const amp=S.shouting?cfg.bounceAmp*1.5:cfg.bounceAmp;
  return -Math.abs(Math.sin((now/cfg.bouncePeriod)*Math.PI))*amp;
}

// GIFループ揺らぎ：複数低周波サインで自然なゆらぎ
function gifWobble(now,seed){
  const a=cfg.gifWobbleAmp, p=cfg.gifWobblePeriod*1000;
  return {
    x: Math.sin((now/p)*Math.PI*2+seed)*a + Math.sin((now/(p*1.7))*Math.PI*2+seed*2.3)*a*0.4,
    y: Math.sin((now/(p*1.3))*Math.PI*2+seed*1.1)*a + Math.sin((now/(p*0.8))*Math.PI*2+seed*3.1)*a*0.3,
  };
}

// ══════════════════════════════════════════
//  追従遅延バッファ
// ══════════════════════════════════════════
const delayBuf={torso:[],head:[],hand:[]};
function pushBuf(key,val,now){
  delayBuf[key].push({v:val,ts:now});
  while(delayBuf[key].length>1&&delayBuf[key][0].ts<now-800) delayBuf[key].shift();
}
function readBuf(key,delayMs,fb){
  if(delayMs<=0) return fb;
  const buf=delayBuf[key]; if(!buf.length) return fb;
  const t=performance.now()-delayMs;
  for(let i=buf.length-1;i>=0;i--) if(buf[i].ts<=t) return buf[i].v;
  return buf[0].v;
}

// ══════════════════════════════════════════
//  描画ヘルパー（下端固定scaleY）
// ══════════════════════════════════════════
function hasAnyImage(){
  return Object.values(BASE).some(g=>Object.values(g).some(v=>v?.complete&&v?.naturalWidth>0));
}
function drawBreath(src,cx,cy,sY,offY,wb){
  if(!src) return;
  const iw=src.naturalWidth||src.width, ih=src.naturalHeight||src.height;
  if(!iw||!ih) return;
  const sc=Math.min(W*0.92/iw,H*0.92/ih);
  const dw=iw*sc,dh=ih*sc;
  const bottom=cy+dh/2+(offY||0);
  ctx.drawImage(src,cx-dw/2+(wb?.x||0),bottom-dh*sY+(wb?.y||0),dw,dh*sY);
}
function drawNormal(src,cx,cy){
  if(!src) return;
  const iw=src.naturalWidth||src.width,ih=src.naturalHeight||src.height;
  if(!iw||!ih) return;
  const sc=Math.min(W*0.92/iw,H*0.92/ih);
  ctx.drawImage(src,cx-iw*sc/2,cy-ih*sc/2,iw*sc,ih*sc);
}

// ══════════════════════════════════════════
//  RENDER
//  now     : 実時刻（まばたき・口パク・手ポーズの描画に使用）
//  animNow : コマ送り時刻（呼吸・バウンス・GIF揺らぎに使用）
// ══════════════════════════════════════════
function render(now, animNow){
  ctx.clearRect(0,0,W,H);
  const cx=W/2,cy=H/2;
  // 呼吸・バウンスは animNow（コマ送り）で計算
  const sY=breathScaleY(animNow), bY=bounceOffsetY(animNow);
  // 遅延バッファは実時刻 now でタイムスタンプを刻む（readBuf が performance.now() 基準のため）
  pushBuf('torso',{sY,bY},now); pushBuf('head',{sY,bY},now); pushBuf('hand',{sY,bY},now);
  const tV=readBuf('torso',cfg.torsoFollowDelay,{sY,bY});
  const hV=readBuf('head', cfg.headFollowDelay, {sY,bY});
  const handV=readBuf('hand',cfg.handFollowDelay,{sY,bY});

  if(!hasAnyImage()){ drawDemo(cx,cy,sY,bY); return; }

  // 背景（アクションオーバーライド優先）
  const bgImg=resolveActionLayer('bg')||resolveLayer('bg','default');
  if(bgImg) drawBreath(bgImg,cx,cy,1,0,gifWobble(animNow,7.1));

  // 胴体（アクションオーバーライド優先）
  const torsoImg=resolveActionLayer('body_torso')||resolveLayer('body_torso','default');
  if(torsoImg) drawBreath(torsoImg,cx,cy,tV.sY,tV.bY,gifWobble(animNow,1.0));

  // 頭部（アクションオーバーライド優先）
  const headImg=resolveActionLayer('body_head')||resolveLayer('body_head','default');
  if(headImg) drawBreath(headImg,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // 手（頭部の前面・アクション中はマウス・KB 状態を無視して1枚固定）
  const rAction=resolveActionLayer('hand_r');
  const lAction=resolveActionLayer('hand_l');
  const rImg=rAction||(S.isMouseActive?(resolveLayer('hand_r','mouse')||resolveLayer('hand_r','default')):resolveLayer('hand_r','default'));
  const lImg=lAction||(S.isKbActive?(resolveLayer('hand_l','keyboard')||resolveLayer('hand_l','default')):resolveLayer('hand_l','default'));
  if(cfg.handFollowDelay<0){
    if(rImg) drawNormal(rImg,cx,cy);
    if(lImg) drawNormal(lImg,cx,cy);
  } else {
    const hw=gifWobble(animNow,3.3);
    if(rImg) drawBreath(rImg,cx,cy,handV.sY,handV.bY,hw);
    if(lImg) drawBreath(lImg,cx,cy,handV.sY,handV.bY,hw);
  }

  // 口（アクション中はリップシンク停止・1枚固定）
  let mImg=resolveActionLayer('mouth');
  if(!mImg){
    if(cfg.bandSplit && S.mouthShape)
      mImg=resolveLayer('mouth',S.mouthShape)||resolveMouth(S.mouthLevel);
    else
      mImg=resolveMouth(S.mouthLevel);
  }
  if(mImg) drawBreath(mImg,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // 目（アクション中はまばたき停止・1枚固定）
  const eyeAction=resolveActionLayer('eyes');
  let eyeSrc=eyeAction;
  if(!eyeAction){
    if(cfg.blinkMode==='gif'&&GifPlayer.isPlaying()) eyeSrc=GifPlayer.getCanvas();
    else { const k=S.blinkFrame===2?'closed':S.blinkFrame===1?'half':'open'; eyeSrc=resolveLayer('eyes',k)||resolveLayer('eyes','open'); }
  }
  if(eyeSrc) drawBreath(eyeSrc,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // 胴体系アクセサリ（torso 追従）
  const exT1=resolveActionLayer('extra_t1')||resolveLayer('extra_t1','default');
  if(exT1) drawBreath(exT1,cx,cy,tV.sY,tV.bY,gifWobble(animNow,5.5));
  const exT2=resolveActionLayer('extra_t2')||resolveLayer('extra_t2','default');
  if(exT2) drawBreath(exT2,cx,cy,tV.sY,tV.bY,gifWobble(animNow,5.7));
  const exT3=resolveActionLayer('extra_t3')||resolveLayer('extra_t3','default');
  if(exT3) drawBreath(exT3,cx,cy,tV.sY,tV.bY,gifWobble(animNow,5.9));

  // 頭部系アクセサリ（head 追従）
  const exH1=resolveActionLayer('extra_h1')||resolveLayer('extra_h1','default');
  if(exH1) drawBreath(exH1,cx,cy,hV.sY,hV.bY,gifWobble(animNow,6.1));
  const exH2=resolveActionLayer('extra_h2')||resolveLayer('extra_h2','default');
  if(exH2) drawBreath(exH2,cx,cy,hV.sY,hV.bY,gifWobble(animNow,6.3));
  const exH3=resolveActionLayer('extra_h3')||resolveLayer('extra_h3','default');
  if(exH3) drawBreath(exH3,cx,cy,hV.sY,hV.bY,gifWobble(animNow,6.5));

  // 前景（アクションオーバーライド優先）
  const fgImg=resolveActionLayer('fg')||resolveLayer('fg','default');
  if(fgImg) drawBreath(fgImg,cx,cy,1,0,gifWobble(animNow,9.9));
}

// ══════════════════════════════════════════
//  DEMO DRAW
// ══════════════════════════════════════════
function drawDemo(cx,cy,sY,bY){
  const r=Math.min(W,H)*0.22;
  ctx.save();
  ctx.translate(cx,cy+r*1.4+bY); ctx.scale(1,sY); ctx.translate(0,-r*1.4);
  // 体
  const bg2=ctx.createRadialGradient(0,r*.8,r*.1,0,r*.8,r*1.2);
  bg2.addColorStop(0,'#5b21b6'); bg2.addColorStop(1,'#3b0764');
  ctx.fillStyle=bg2; ctx.beginPath(); ctx.ellipse(0,r*.82,r*.68,r*.52,0,0,Math.PI*2); ctx.fill();
  // 右手
  const rCol=S.isMouseActive?'#f9a8d4':'#ddd6fe';
  ctx.fillStyle=rCol; ctx.beginPath(); ctx.ellipse(r*.78,r*.65,r*.16,r*.2,0.3,0,Math.PI*2); ctx.fill();
  if(S.isMouseActive){
    ctx.fillStyle='#1e1b4b'; ctx.strokeStyle=rCol; ctx.lineWidth=r*.02;
    ctx.beginPath(); ctx.ellipse(r*.78,r*.62,r*.1,r*.14,0,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle='rgba(249,168,212,.5)'; ctx.lineWidth=r*.015;
    ctx.beginPath(); ctx.moveTo(r*.78,r*.55); ctx.lineTo(r*.78,r*.69); ctx.stroke();
  }
  // 左手
  const lCol=S.isKbActive?'#93c5fd':'#ddd6fe';
  ctx.fillStyle=lCol; ctx.beginPath(); ctx.ellipse(-r*.78,r*.65,r*.16,r*.2,-0.3,0,Math.PI*2); ctx.fill();
  if(S.isKbActive){
    ctx.fillStyle='#1e1b4b'; ctx.strokeStyle=lCol; ctx.lineWidth=r*.02;
    ctx.beginPath(); roundRect(ctx,-r*.9,r*.6,r*.25,r*.16,r*.03); ctx.fill(); ctx.stroke();
    ctx.fillStyle=lCol;
    for(let ri=0;ri<2;ri++) for(let ci=0;ci<3;ci++){ ctx.beginPath(); ctx.rect(-r*.87+ci*r*.07,r*.63+ri*r*.05,r*.04,r*.03); ctx.fill(); }
  }
  // 頭
  const hg=ctx.createRadialGradient(-r*.1,-r*.1,r*.05,-r*.1,-r*.1,r);
  hg.addColorStop(0,'#f0e6ff'); hg.addColorStop(1,'#c4b5fd');
  ctx.fillStyle=hg; ctx.beginPath(); ctx.ellipse(0,0,r*.84,r*.88,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#ddd6fe';
  ctx.beginPath(); ctx.ellipse(-r*.86,r*.05,r*.14,r*.2,-0.15,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(r*.86,r*.05,r*.14,r*.2,0.15,0,Math.PI*2); ctx.fill();
  // 目
  const ey=-r*.08,lx=-r*.32,rx=r*.32;
  if(S.blinkFrame===2){
    ctx.strokeStyle='#1e1b4b'; ctx.lineWidth=r*.025;
    ctx.beginPath(); ctx.moveTo(lx-r*.14,ey); ctx.quadraticCurveTo(lx,ey+r*.09,lx+r*.14,ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rx-r*.14,ey); ctx.quadraticCurveTo(rx,ey+r*.09,rx+r*.14,ey); ctx.stroke();
  } else if(S.blinkFrame===1){
    ctx.fillStyle='#1e1b4b';
    ctx.beginPath(); ctx.ellipse(lx,ey,r*.12,r*.07,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(rx,ey,r*.12,r*.07,0,0,Math.PI*2); ctx.fill();
  } else {
    ctx.fillStyle='#1e1b4b';
    ctx.beginPath(); ctx.ellipse(lx,ey,r*.12,r*.13,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(rx,ey,r*.12,r*.13,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#7c3aed';
    ctx.beginPath(); ctx.arc(lx+r*.02,ey-r*.02,r*.055,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(rx+r*.02,ey-r*.02,r*.055,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='white';
    ctx.beginPath(); ctx.arc(lx+r*.055,ey-r*.055,r*.028,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(rx+r*.055,ey-r*.055,r*.028,0,Math.PI*2); ctx.fill();
  }
  // 差分インジケーター
  if(activeVariants.length>0){
    ctx.fillStyle='rgba(124,58,237,.7)'; roundRect(ctx,-r*.6,r*.55,r*1.2,r*.25,r*.05); ctx.fill();
    ctx.fillStyle='white'; ctx.font=`bold ${r*.1}px 'Segoe UI'`;
    ctx.textAlign='center'; ctx.fillText(_stackLabel(),0,r*.69); ctx.textAlign='left';
  }
  // 口
  const my=r*.42;
  if(S.shouting){
    ctx.fillStyle='#1e1b4b'; ctx.beginPath(); ctx.ellipse(0,my,r*.22,r*.18,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#6d28d9'; ctx.beginPath(); ctx.ellipse(0,my+r*.02,r*.14,r*.1,0,0,Math.PI*2); ctx.fill();
  } else if(S.talking){
    ctx.fillStyle='#1e1b4b'; ctx.beginPath(); ctx.ellipse(0,my,r*.18,r*.11,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ec4899'; ctx.beginPath(); ctx.ellipse(0,my+r*.02,r*.1,r*.06,0,0,Math.PI*2); ctx.fill();
  } else {
    ctx.strokeStyle='#1e1b4b'; ctx.lineWidth=r*.025;
    ctx.beginPath(); ctx.moveTo(-r*.2,my); ctx.quadraticCurveTo(0,my+r*.14,r*.2,my); ctx.stroke();
    ctx.fillStyle='rgba(249,168,212,.45)'; ctx.beginPath(); ctx.ellipse(0,my+r*.06,r*.15,r*.06,0,0,Math.PI*2); ctx.fill();
  }
  ctx.fillStyle='rgba(249,168,212,.38)';
  ctx.beginPath(); ctx.ellipse(-r*.5,r*.28,r*.19,r*.11,0,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(r*.5,r*.28,r*.19,r*.11,0,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function roundRect(ctx,x,y,w,h,r2){
  ctx.beginPath(); ctx.moveTo(x+r2,y); ctx.lineTo(x+w-r2,y);
  ctx.arcTo(x+w,y,x+w,y+r2,r2); ctx.lineTo(x+w,y+h-r2);
  ctx.arcTo(x+w,y+h,x+w-r2,y+h,r2); ctx.lineTo(x+r2,y+h);
  ctx.arcTo(x,y+h,x,y+h-r2,r2); ctx.lineTo(x,y+r2);
  ctx.arcTo(x,y,x+r2,y,r2); ctx.closePath();
}

// ══════════════════════════════════════════
//  AUDIO
// ══════════════════════════════════════════
let analyser,freqData,timeData,mouthTimer=null,_audioCtx,_audioStream,_smoothedAvg=0,_smoothedMid=0,_targetMouthLevel=0;

// 周波数域の指定 bin 範囲を 0〜100% に正規化して返す
function _freqBandAvg(from,to){
  if(!freqData) return 0;
  let s=0; for(let i=from;i<to;i++) s+=freqData[i];
  return s/(to-from)/255*100;
}

// 口レベルを適用する（上昇は即時、下降は mouthCloseDelay で遅延）
function _applyMouthLevel(level){
  if(level>S.mouthLevel){
    clearTimeout(mouthTimer); mouthTimer=null;
    _targetMouthLevel=level; S.mouthLevel=level;
  } else if(level<S.mouthLevel){
    _targetMouthLevel=level;
    if(mouthTimer===null){
      mouthTimer=setTimeout(()=>{ S.mouthLevel=_targetMouthLevel; mouthTimer=null; },cfg.mouthCloseDelay);
    }
  } else {
    // 同レベル: 下降待ちタイマーがあればキャンセル（音量が回復した）
    if(mouthTimer!==null){ clearTimeout(mouthTimer); mouthTimer=null; }
  }
  S.talking=S.mouthLevel>=1;
  S.shouting=S.mouthLevel>=4;
}

async function initAudio(deviceId){
  // 既存のストリームとコンテキストを解放
  if(_audioStream){ _audioStream.getTracks().forEach(t=>t.stop()); _audioStream=null; }
  if(_audioCtx){ try{ await _audioCtx.close(); }catch(_){} _audioCtx=null; }
  analyser=null;

  const statusEl=document.getElementById('mic-device-status');
  try{
    const constraints={
      audio: deviceId ? {deviceId:{exact:deviceId}} : true,
      video: false,
    };
    _audioStream=await navigator.mediaDevices.getUserMedia(constraints);
    _audioCtx=new AudioContext();
    analyser=_audioCtx.createAnalyser();
    analyser.fftSize=2048;  // 時間領域RMSに十分なサンプル数
    freqData=new Uint8Array(analyser.frequencyBinCount); // 周波数域（ビジュアライザー用）
    timeData=new Uint8Array(analyser.fftSize);           // 時間域（RMS計算用）
    _audioCtx.createMediaStreamSource(_audioStream).connect(analyser);
    document.getElementById('mic-dot').classList.add('on');

    // 許可取得後にデバイス名が取れるので一覧を更新
    await enumerateAudioDevices(deviceId||_audioStream.getAudioTracks()[0]?.getSettings()?.deviceId);
    if(statusEl) statusEl.textContent='✓ マイク接続中';
  }catch(e){
    console.warn('mic:',e);
    document.getElementById('mic-dot').classList.remove('on');
    if(statusEl) statusEl.textContent='✗ マイクへのアクセスに失敗しました';
  }
}

async function enumerateAudioDevices(selectDeviceId){
  const sel=document.getElementById('mic-device');
  if(!sel) return;
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    const inputs=devices.filter(d=>d.kind==='audioinput');
    sel.innerHTML=inputs.map((d,i)=>{
      const label=d.label||`マイク ${i+1}`;
      const val=d.deviceId;
      return `<option value="${val}">${label}</option>`;
    }).join('');
    if(selectDeviceId) sel.value=selectDeviceId;
  }catch(e){ console.warn('enumerate:',e); }
}

function tickAudio(){
  requestAnimationFrame(tickAudio);
  if(!analyser) return;

  // 周波数域データ（ビジュアライザー用）
  analyser.getByteFrequencyData(freqData);
  // 時間域データ（RMS計算用）— Audacityと同じ振幅ベース計測
  analyser.getByteTimeDomainData(timeData);

  // RMS計算: 0.0〜1.0 → 0〜100% に変換
  let sumSq=0;
  for(let i=0;i<timeData.length;i++){
    const s=(timeData[i]-128)/128; // -1〜+1 に正規化
    sumSq+=s*s;
  }
  const rawRms=Math.sqrt(sumSq/timeData.length)*100; // 0〜100%

  // EMAスムージング（キーボード打鍵など短い音のスパイクを緩衝する）
  _smoothedAvg=_smoothedAvg*cfg.audioSmoothing+rawRms*(1-cfg.audioSmoothing);

  // HUD バー（配信画面用）
  document.getElementById('mic-fill').style.width=Math.min(rawRms,100)+'%';
  document.querySelectorAll('.vbar').forEach((b,i)=>{ b.style.height=(freqData[i*16+4]/255*16+2)+'px'; });

  // 設定パネル内リアルタイムメーター（スムージング後の値を表示して実際の検出と一致させる）
  const lvFill=document.getElementById('audio-level-fill');
  if(lvFill) lvFill.style.width=Math.min(_smoothedAvg,100)+'%';
  // 4段階の境界マーカー（lipsyncLevels[1]〜[4]）
  const lvls=cfg.lipsyncLevels;
  const tMark=document.getElementById('threshold-marker');
  if(tMark) tMark.style.left=Math.min(lvls[1],100)+'%';
  const m2=document.getElementById('level2-marker');
  if(m2) m2.style.left=Math.min(lvls[2],100)+'%';
  const m3=document.getElementById('level3-marker');
  if(m3) m3.style.left=Math.min(lvls[3],100)+'%';
  const sMark=document.getElementById('shout-marker');
  if(sMark) sMark.style.left=Math.min(lvls[4],100)+'%';

  // 口レベルと形状を決定して適用
  let signal, bandH=0, bandL=0;
  S.mouthShape=null;
  if(cfg.bandSplit){
    const mid=_freqBandAvg(20,80);
    _smoothedMid=_smoothedMid*cfg.audioSmoothing+mid*(1-cfg.audioSmoothing);
    bandH=_freqBandAvg(80,150); // 高域（歯擦音）
    bandL=_freqBandAvg(0,20);   // 低域（丸口）
    signal=_smoothedMid;
    // 歯擦音: 高域強・中域弱 → signal を small(1) 以上に保証
    if(bandH>=cfg.sibilantThreshold && signal<lvls[2]) signal=Math.max(signal,lvls[1]);
  } else {
    signal=_smoothedAvg;
  }
  // 5段階レベル判定（上位から順に比較）
  let newLevel=0;
  for(let i=lvls.length-1;i>=1;i--){ if(signal>=lvls[i]){ newLevel=i; break; } }
  // 形状オーバーライド判定（bandSplit ON かつ発話中のみ）
  if(cfg.bandSplit && newLevel>=1){
    if(bandH>=cfg.sibilantThreshold && newLevel<=2)
      S.mouthShape='sibilant'; // 歯擦音: 高域突出・small〜open 音量帯
    else if(bandL>=cfg.roundedThreshold && bandH<cfg.sibilantThreshold && newLevel<=3)
      S.mouthShape='rounded';  // 丸口: 低域優位・叫び未満
  }
  _applyMouthLevel(newLevel);
}
initAudio();
tickAudio();
const vvis=document.getElementById('vvis');
for(let i=0;i<7;i++){const d=document.createElement('div');d.className='vbar';vvis.appendChild(d);}

// ══════════════════════════════════════════
//  BLINK（GIFモード対応）
// ══════════════════════════════════════════
let blinkTimer;
function scheduleBlink(){
  const j=(Math.random()*2-1)*cfg.blinkInterval*cfg.blinkJitter;
  blinkTimer=setTimeout(doBlink,(cfg.blinkInterval+j)*1000);
}
function doBlink(){
  if(cfg.blinkMode==='gif'&&GifPlayer.isReady()){ GifPlayer.play(()=>scheduleBlink()); return; }
  const f=cfg.blinkFrameMs;
  if(cfg.blinkMode==='3'){
    S.blinkFrame=1;
    setTimeout(()=>{ S.blinkFrame=2; setTimeout(()=>{ S.blinkFrame=1; setTimeout(()=>{ S.blinkFrame=0; scheduleBlink(); },f); },f*1.2); },f*.8);
  } else { S.blinkFrame=2; setTimeout(()=>{ S.blinkFrame=0; scheduleBlink(); },f*2); }
}
scheduleBlink();

// ══════════════════════════════════════════
//  INPUT WATCHER
// ══════════════════════════════════════════
let kbTimer,msTimer;
function updateInput(){
  document.getElementById('status-rhand').textContent=S.isMouseActive?'マウス使用中 🖱️':'通常';
  document.getElementById('status-lhand').textContent=S.isKbActive?'KB使用中 ⌨️':'通常';
  const both=S.isMouseActive&&S.isKbActive;
  document.getElementById('status-both').textContent=both?'両手使用中 ✓':'–';
  document.getElementById('input-status').textContent=both?'⌨️🖱️':S.isMouseActive?'🖱️':S.isKbActive?'⌨️':'–';
}
document.addEventListener('keydown',e=>{
  S.isKbActive=true; clearTimeout(kbTimer);
  kbTimer=setTimeout(()=>{ S.isKbActive=false; updateInput(); },cfg.keyboardMs);
  updateInput();
  if(document.getElementById('panel').classList.contains('open')) return;
  // S: 設定パネルを開く（修飾キーなし）
  if(e.key==='s'||e.key==='S'){ openPanel(); return; }
  if(!e.ctrlKey) return;
  e.preventDefault();
  // Ctrl+Alt+1〜8: ワンショットアクション
  if(e.altKey){
    const n=parseInt(e.key);
    if(n>=1&&n<=8){ triggerAction(n-1); return; }
    return;
  }
  // Ctrl+数字 / Ctrl+矢印: 差分スロット切替
  const n=parseInt(e.key);
  if(n>=1&&n<=9){ toggleVariant(n-1); return; }  // Ctrl+1〜9 → スロット0〜8
  if(e.key==='0'){ setVariant(-1); return; }       // Ctrl+0 → ベース
  if(e.key==='ArrowUp')   { toggleVariant(9);  return; }
  if(e.key==='ArrowDown') { setVariant(-1);    return; } // ↓ はベースに戻す
  if(e.key==='ArrowLeft') { toggleVariant(10); return; }
  if(e.key==='ArrowRight'){ toggleVariant(11); return; }
});
['mousemove','mousedown'].forEach(ev=>{
  document.addEventListener(ev,()=>{
    S.isMouseActive=true; clearTimeout(msTimer);
    msTimer=setTimeout(()=>{ S.isMouseActive=false; updateInput(); },cfg.mouseMs);
    updateInput();
  });
});

// ══════════════════════════════════════════
//  VARIANT管理
// ══════════════════════════════════════════

// スタックの最高優先度インデックスを返す（スタックが空なら -1）
function getActiveVariant(){ return activeVariants.length>0 ? activeVariants[activeVariants.length-1] : -1; }

// GIFまばたき：スタック上位から blinkgif がある差分を優先
function _syncBlinkGif(){
  if(cfg.blinkMode!=='gif') return;
  for(let i=activeVariants.length-1;i>=0;i--){
    const src=variants[activeVariants[i]].patches['eyes-blinkgif']?.src;
    if(src){ GifPlayer.load(src).catch(()=>{}); return; }
  }
  const baseSrc=BASE_SRCS['eyes__blinkgif'];
  if(baseSrc) GifPlayer.load(baseSrc).catch(()=>{});
}

// バッジ更新：スタックに含まれる全スロットにバッジを表示
function _updateVariantBadges(){
  document.querySelectorAll('.variant-header').forEach((h,i)=>{
    h.querySelector('.variant-active-badge')?.classList.toggle('show',activeVariants.includes(i));
  });
}

// トースト表示用ラベル
function _stackLabel(){
  if(!activeVariants.length) return 'ベース';
  return activeVariants.map(i=>variants[i].label).join(' + ');
}

// 同じスロットを再度押したらベースに戻るトグル動作
function toggleVariant(idx){
  if(cfg.stackMode) toggleStackVariant(idx);
  else setVariant(getActiveVariant()===idx?-1:idx);
}

// スタックモード：スタックに追加 or 取り除く
function toggleStackVariant(idx){
  const pos=activeVariants.indexOf(idx);
  if(pos>=0) activeVariants.splice(pos,1);
  else       activeVariants.push(idx);
  _syncBlinkGif();
  _updateVariantBadges();
  showToast(_stackLabel());
}

let toastTimer;
function showToast(msg){
  const t=document.getElementById('expr-toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}
function setVariant(idx){
  activeVariants = idx<0 ? [] : [idx];
  _syncBlinkGif();
  _updateVariantBadges();
  showToast(_stackLabel());
}
function buildVariantList(){
  const list=document.getElementById('variant-list'); list.innerHTML='';
  variants.forEach((v,vi)=>{
    const card=document.createElement('div'); card.className='variant-card';
    const hdr=document.createElement('div'); hdr.className='variant-header';
    hdr.innerHTML=`
      <div class="variant-key" title="Ctrl+${VARIANT_KEYS[vi]}">${VARIANT_KEYS[vi]}</div>
      <input class="variant-name-input" type="text" value="${v.label}"
        onclick="event.stopPropagation()" oninput="variants[${vi}].label=this.value">
      <div class="variant-active-badge ${activeVariants.includes(vi)?'show':''}">● ACTIVE</div>
      <button class="btn-ghost btn-sm" onclick="event.stopPropagation();setVariant(${vi})">適用</button>
      <button class="btn-ghost btn-sm" onclick="event.stopPropagation();setVariant(-1)" style="opacity:.6">解除</button>`;
    const body=document.createElement('div');
    body.className='variant-body'+(v.open?' open':'');
    hdr.addEventListener('click',()=>{ v.open=!v.open; body.classList.toggle('open',v.open); });
    const note=document.createElement('p');
    note.style.cssText='font-size:10px;color:#6b7280;margin-bottom:10px;line-height:1.5';
    note.textContent='差し替えたいレイヤーだけ登録。未登録はベースのまま。';
    body.appendChild(note);
    const grid=document.createElement('div'); grid.className='patch-grid';
    PATCHABLE.forEach(p=>{
      const row=document.createElement('div'); row.className='patch-row';
      const hp=!!v.patches[p.id]?.img;
      row.innerHTML=`<label>${p.label}</label>
        <input type="file" accept="image/*,.gif" onchange="setPatch(${vi},'${p.id}','${p.layer}','${p.state}',this)">
        <img class="patch-thumb ${hp?'has':''}" id="pt-${vi}-${p.id}" ${hp?`src="${v.patches[p.id].src}"`:''}> 
        <button class="patch-clear" onclick="clearPatch(${vi},'${p.id}')">✕</button>`;
      grid.appendChild(row);
    });
    body.appendChild(grid); card.appendChild(hdr); card.appendChild(body); list.appendChild(card);
  });
}
function setPatch(vi,pid,layer,state,input){
  const file=input.files[0]; if(!file) return;
  const url=URL.createObjectURL(file);
  const img=new Image(); img.src=url;
  const patchKey=`patch-${vi}-${pid}`;
  if(isGifFile(file)) setGifLooper(patchKey, url);
  else clearGifLooper(patchKey);
  const fr=new FileReader();
  fr.onload=e=>{
    variants[vi].patches[pid]={img,src:e.target.result};
    // アクティブな差分のまばたきGIFが更新されたら GifPlayer に即反映
    if(state==='blinkgif' && activeVariants.includes(vi) && cfg.blinkMode==='gif')
      GifPlayer.load(e.target.result).catch(()=>{});
  };
  fr.readAsDataURL(file);
  variants[vi].patches[pid]={img,src:url}; // 即時表示用
  const th=document.getElementById(`pt-${vi}-${pid}`);
  if(th){ th.src=url; th.classList.add('has'); }
}
function clearPatch(vi,pid){
  variants[vi].patches[pid]=null;
  clearGifLooper(`patch-${vi}-${pid}`);
  const th=document.getElementById(`pt-${vi}-${pid}`);
  if(th){ th.src=''; th.classList.remove('has'); }
}

// ══════════════════════════════════════════
//  ワンショットアクション UI 管理
// ══════════════════════════════════════════
const ACTION_LAYER_LABELS={
  bg:'背景', body_torso:'ボディ(胴体)', body_head:'ボディ(頭部)',
  hand_r:'右手', hand_l:'左手', eyes:'目', mouth:'口',
  extra_t1:'胴体アクセサリ1', extra_t2:'胴体アクセサリ2', extra_t3:'胴体アクセサリ3',
  extra_h1:'頭部アクセサリ1', extra_h2:'頭部アクセサリ2', extra_h3:'頭部アクセサリ3',
  fg:'前景',
};
const ACTION_LAYER_NOTES={
  hand_r:'マウス状態を無視', hand_l:'KB状態を無視',
  eyes:'まばたき停止', mouth:'リップシンク停止',
};

function loadActionPatch(ai, layer, input){
  const file=input.files[0]; if(!file) return;
  const url=URL.createObjectURL(file);
  const img=new Image(); img.src=url;
  if(!actions[ai].patches[layer]) actions[ai].patches[layer]={};
  actions[ai].patches[layer].img=img;
  // GIF の場合はアクションプレイヤーを生成してロード
  const key=`${ai}-${layer}`;
  if(isGifFile(file)){
    const pl=createActionPlayer();
    ACTION_PLAYERS[key]=pl;
    pl.load(url).catch(e=>console.warn('action player load:',e));
  } else {
    ACTION_PLAYERS[key]?.stop();
    delete ACTION_PLAYERS[key];
  }
  const fr=new FileReader();
  fr.onload=e=>{ actions[ai].patches[layer].src=e.target.result; };
  fr.readAsDataURL(file);
  const th=document.getElementById(`th-action-${ai}-${layer}`);
  if(th){ th.src=url; th.classList.add('has'); }
  setFileLoadedBadge(input);
}

function clearActionPatch(ai, layer){
  delete actions[ai].patches[layer];
  ACTION_PLAYERS[`${ai}-${layer}`]?.stop();
  delete ACTION_PLAYERS[`${ai}-${layer}`];
  const th=document.getElementById(`th-action-${ai}-${layer}`);
  if(th){ th.src=''; th.classList.remove('has'); }
}

function buildActionList(){
  const list=document.getElementById('action-list'); if(!list) return;
  list.innerHTML='';
  actions.forEach((a,ai)=>{
    const card=document.createElement('div'); card.className='variant-card';
    const hdr=document.createElement('div'); hdr.className='variant-header';
    hdr.innerHTML=`
      <div class="variant-key" title="Ctrl+Alt+${ai+1}">${ai+1}</div>
      <input class="variant-name-input" type="text" value="${a.label}"
        onclick="event.stopPropagation()" oninput="actions[${ai}].label=this.value">
      <div class="variant-active-badge action-active-badge ${activeAction===ai?'show':''}">● ACTIVE</div>
      <button class="btn-ghost btn-sm" onclick="event.stopPropagation();triggerAction(${ai})">▶ テスト</button>
      <button class="btn-ghost btn-sm" onclick="event.stopPropagation();stopAction()" style="opacity:.6">■ 停止</button>`;
    const body=document.createElement('div');
    body.className='variant-body'+(a.open?' open':'');
    hdr.addEventListener('click',()=>{ a.open=!a.open; body.classList.toggle('open',a.open); });

    // 設定行: ループ / スパン
    const cfg_row=document.createElement('div');
    cfg_row.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center;font-size:11px';
    cfg_row.innerHTML=`
      <label style="color:#94a3b8">ループ:
        <input type="number" min="0" value="${a.loop}" style="width:48px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:2px 4px;margin-left:4px"
          oninput="actions[${ai}].loop=parseInt(this.value)||0">
        <span style="color:#64748b">回（0=∞）</span>
      </label>
      <label style="color:#94a3b8">スパン:
        <input type="number" min="0" value="${a.span}" style="width:56px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:2px 4px;margin-left:4px"
          oninput="actions[${ai}].span=parseInt(this.value)||0">
        <span style="color:#64748b">ms</span>
      </label>`;
    body.appendChild(cfg_row);

    // レイヤー行
    const grid=document.createElement('div'); grid.className='patch-grid';
    ACTION_LAYERS.forEach(layer=>{
      const row=document.createElement('div'); row.className='patch-row';
      const hp=!!a.patches[layer]?.img;
      const note=ACTION_LAYER_NOTES[layer]?`<span style="font-size:10px;color:#64748b;margin-left:4px">※${ACTION_LAYER_NOTES[layer]}</span>`:'';
      row.innerHTML=`<label>${ACTION_LAYER_LABELS[layer]}${note}</label>
        <input type="file" accept="image/*,.gif" onchange="loadActionPatch(${ai},'${layer}',this)">
        <img class="patch-thumb ${hp?'has':''}" id="th-action-${ai}-${layer}" ${hp?`src="${a.patches[layer].src}"`:''}> 
        <button class="patch-clear" onclick="clearActionPatch(${ai},'${layer}')">✕</button>`;
      grid.appendChild(row);
    });
    body.appendChild(grid);
    card.appendChild(hdr); card.appendChild(body); list.appendChild(card);
  });
}

// ══════════════════════════════════════════
//  ワンショットアクション 再生制御
// ══════════════════════════════════════════

// GIF を持つレイヤーを全て同時再生し、全終了後に onComplete を呼ぶ
// GIF なしレイヤーのみのアクション（静止画）は即完了とする
function playActionOnce(ai, onComplete){
  const action=actions[ai];
  const gifLayers=ACTION_LAYERS.filter(l=>{
    const p=action.patches[l];
    return p?.img && isGifSrc(p.src||'');
  });
  if(!gifLayers.length){ onComplete(); return; }
  let remaining=gifLayers.length;
  gifLayers.forEach(layer=>{
    const key=`${ai}-${layer}`;
    const pl=ACTION_PLAYERS[key];
    if(pl?.isReady()){
      pl.play(()=>{ if(--remaining===0) onComplete(); });
    } else {
      if(--remaining===0) onComplete();
    }
  });
}

function doActionLoop(){
  if(activeAction<0) return;
  console.log('[action] doActionLoop: activeAction='+activeAction+' loopCount='+actionLoopCount);
  playActionOnce(activeAction, ()=>{
    if(activeAction<0) return;
    actionLoopCount++;
    const a=actions[activeAction];
    const more=(a.loop===0)||(actionLoopCount<a.loop);
    console.log('[action] loop complete: count='+actionLoopCount+'/'+a.loop+' more='+more+' span='+a.span);
    if(more) actionSpanTimer=setTimeout(doActionLoop, a.span);
    else stopAction();
  });
}

function playAction(index){
  const savedVariants=activeVariants.slice();
  if(activeAction>=0) stopAction(savedVariants);
  preActionVariants=savedVariants;
  activeAction=index;
  actionLoopCount=0;
  clearTimeout(blinkTimer);
  const a=actions[index];
  const patchCount=Object.keys(a.patches).length;
  console.log('[action] playAction: index='+index+' label="'+a.label+'"'
    +' loop='+a.loop+' span='+a.span+' patches='+patchCount);
  updateActionBadges();
  doActionLoop();
}

function stopAction(returnTo){
  clearTimeout(actionSpanTimer);
  actionSpanTimer=null;
  if(activeAction>=0){
    console.log('[action] stopAction: activeAction='+activeAction+' returnTo='+JSON.stringify(returnTo));
    ACTION_LAYERS.forEach(l=>{ ACTION_PLAYERS[`${activeAction}-${l}`]?.stop(); });
  }
  const prev=preActionVariants.slice();
  activeAction=-1;
  actionLoopCount=0;
  // 配列で渡された場合はスタックごと復元
  const restoreTo = returnTo!==undefined ? returnTo : prev;
  if(Array.isArray(restoreTo)){
    activeVariants = restoreTo.slice();
    _syncBlinkGif();
    _updateVariantBadges();
    showToast(_stackLabel());
  } else {
    setVariant(restoreTo);
  }
  updateActionBadges();
  scheduleBlink();
}

// 同インデックスなら停止、別インデックスなら再生（差分スロットと同じトグル動作）
function triggerAction(idx){
  if(activeAction===idx) stopAction();
  else playAction(idx);
}

function updateActionBadges(){
  document.querySelectorAll('.action-active-badge').forEach((b,i)=>{
    b.classList.toggle('show', i===activeAction);
  });
}

// ══════════════════════════════════════════
//  プロジェクト保存 / 読込
// ══════════════════════════════════════════
async function exportProject(){
  showToast('保存中…');
  const proj={
    version:'0.6', cfg:{...cfg},
    baseImages: {...BASE_SRCS},
    variants: variants.map(v=>({
      label:v.label,
      patches: Object.fromEntries(
        Object.entries(v.patches).filter(([,p])=>p?.src).map(([k,p])=>[k,{src:p.src}])
      ),
    })),
    actions: actions.map(a=>({
      label:a.label, loop:a.loop, span:a.span,
      patches: Object.fromEntries(
        Object.entries(a.patches).filter(([,p])=>p?.src).map(([l,p])=>[l,{src:p.src}])
      ),
    })),
  };
  const jsonStr=JSON.stringify(proj,null,2);
  if(window.electronAPI){
    // Electron: ネイティブ保存ダイアログ
    const result=await window.electronAPI.saveProject(jsonStr);
    if(result?.ok){
      showToast('💾 保存しました');
      window.electronAPI.saveLastProject(jsonStr); // 前回プロジェクトとして記録
    }
  } else {
    // ブラウザ: Blob ダウンロード（フォールバック）
    const blob=new Blob([jsonStr],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='gifvtbr-project.json'; a.click();
    setTimeout(()=>showToast('💾 保存しました'),300);
  }
}

async function importProject(input){
  let raw;
  if(window.electronAPI){
    // Electron: ネイティブ開くダイアログ
    raw=await window.electronAPI.loadProject();
    if(!raw) return;
  } else {
    // ブラウザ: FileReader（フォールバック）
    const file=input?.files[0]; if(!file) return;
    raw=await new Promise((res,rej)=>{
      const fr=new FileReader();
      fr.onload=e=>res(e.target.result);
      fr.onerror=rej;
      fr.readAsText(file);
    });
  }
  try{
    applyProject(JSON.parse(raw));
    if(window.electronAPI) window.electronAPI.saveLastProject(raw); // 前回プロジェクトとして記録
  }catch(err){ alert('読み込みエラー: '+err.message); }
}

function applyProject(proj){
  if(proj.cfg) Object.assign(cfg,proj.cfg);
  // 旧プロジェクト（audioThreshold/audioShout）から lipsyncLevels への移行
  if(proj.cfg?.audioThreshold!=null && proj.cfg?.lipsyncLevels==null){
    const t=proj.cfg.audioThreshold||5, s=proj.cfg.audioShout||30;
    cfg.lipsyncLevels=[0, t, Math.round((t*2+s)/3), Math.round((t+s*2)/3), s];
  }
  // 旧プロジェクト（extra__default）から extra_t1__default へのマイグレーション
  if(proj.baseImages?.['extra__default'] && !proj.baseImages?.['extra_t1__default'])
    proj.baseImages['extra_t1__default']=proj.baseImages['extra__default'];
  (proj.variants||[]).forEach(v=>{
    if(v.patches?.['extra-default'] && !v.patches?.['extra_t1-default'])
      v.patches['extra_t1-default']=v.patches['extra-default'];
  });
  // ベース画像復元
  Object.entries(proj.baseImages||{}).forEach(([key,dataUrl])=>{
    const [layer,state]=key.split('__');
    if(!BASE[layer]) return;
    const img=new Image(); img.src=dataUrl;
    BASE[layer][state]=img; BASE_SRCS[key]=dataUrl;
    // blinkgif 以外の GIF はループ再生を復元（data URL を渡す）
    if(state!=='blinkgif' && isGifSrc(dataUrl)) setGifLooper(key, dataUrl);
    else clearGifLooper(key);
    const th=document.getElementById(`th-${layer}-${state}`);
    if(th){
      th.src=dataUrl; th.classList.add('has');
      const fi=th.closest('.row')?.querySelector('input[type=file]');
      setFileLoadedBadge(fi);
    }
    if(layer==='eyes'&&state==='blinkgif') GifPlayer.load(dataUrl).catch(()=>{});
  });
  // variant復元
  (proj.variants||[]).forEach((sv,vi)=>{
    if(!variants[vi]) return;
    variants[vi].label=sv.label||variants[vi].label;
    variants[vi].patches={};
    Object.entries(sv.patches||{}).forEach(([pid,pd])=>{
      if(!pd?.src) return;
      const img=new Image(); img.src=pd.src;
      variants[vi].patches[pid]={img,src:pd.src};
      // GIF パッチのループ再生を復元
      const patchKey=`patch-${vi}-${pid}`;
      if(isGifSrc(pd.src)) setGifLooper(patchKey, pd.src);
      else clearGifLooper(patchKey);
    });
  });
  // アクション復元
  (proj.actions||[]).forEach((pa,ai)=>{
    if(!actions[ai]) return;
    actions[ai].label=pa.label||actions[ai].label;
    actions[ai].loop=pa.loop??1;
    actions[ai].span=pa.span??0;
    actions[ai].patches={};
    Object.entries(pa.patches||{}).forEach(([layer,pd])=>{
      if(!pd?.src) return;
      const img=new Image(); img.src=pd.src;
      actions[ai].patches[layer]={img,src:pd.src};
      if(isGifSrc(pd.src)){
        const pl=createActionPlayer();
        ACTION_PLAYERS[`${ai}-${layer}`]=pl;
        pl.load(pd.src).catch(e=>console.warn('action restore:',e));
      }
    });
  });
  activeVariants=[];
  activeAction=-1;
  syncCfgToUI(); buildVariantList(); buildActionList();
  showToast('📂 読み込みました');
}

function syncCfgToUI(){
  const el=id=>document.getElementById(id);
  const sv=(id,v)=>{ if(el(id)) el(id).value=v; };
  const st=(id,v)=>{ if(el(id)) el(id).textContent=v; };
  sv('aud-smoothing',Math.round(cfg.audioSmoothing*100)); st('v-sm',Math.round(cfg.audioSmoothing*100)+'%');
  sv('aud-delay',cfg.mouthCloseDelay);     st('v-ad',cfg.mouthCloseDelay);
  (cfg.lipsyncLevels||[]).forEach((v,i)=>{ if(i>=1){ sv(`ls-level-${i}`,v); st(`v-ls${i}`,v); } });
  if(el('band-split')) el('band-split').checked=!!cfg.bandSplit;
  sv('sibilant-threshold',cfg.sibilantThreshold); st('v-sib',cfg.sibilantThreshold);
  sv('rounded-threshold',cfg.roundedThreshold);   st('v-rnd',cfg.roundedThreshold);
  sv('breath-amp',Math.round(cfg.breathAmp*1000)); st('v-ba',Math.round(cfg.breathAmp*1000));
  sv('breath-period',Math.round(cfg.breathPeriod*10)); st('v-bp',cfg.breathPeriod.toFixed(1));
  sv('bounce-amp',cfg.bounceAmp);          st('v-boa',cfg.bounceAmp);
  sv('bounce-period',cfg.bouncePeriod);    st('v-bop',cfg.bouncePeriod);
  sv('torso-delay',cfg.torsoFollowDelay);  st('v-td',cfg.torsoFollowDelay);
  sv('head-delay',cfg.headFollowDelay);    st('v-hd2',cfg.headFollowDelay);
  sv('hand-delay',cfg.handFollowDelay);    st('v-hd',cfg.handFollowDelay);
  sv('hand-delay-l',cfg.handFollowDelay);  st('v-hd-l',cfg.handFollowDelay);
  sv('blink-interval',cfg.blinkInterval);  st('v-bi',cfg.blinkInterval);
  sv('blink-jitter',Math.round(cfg.blinkJitter*100)); st('v-bj',cfg.blinkJitter.toFixed(2));
  sv('blink-frame',cfg.blinkFrameMs);      st('v-bf',cfg.blinkFrameMs);
  sv('kb-timeout',cfg.keyboardMs);         st('v-kb',cfg.keyboardMs);
  sv('ms-timeout',cfg.mouseMs);            st('v-ms',cfg.mouseMs);
  sv('ms-throttle',cfg.mouseMoveThrottle); st('v-mst',cfg.mouseMoveThrottle);
  if(el('blink-mode')) el('blink-mode').value=cfg.blinkMode;
  setAnimFps(cfg.targetFps);
  sv('response-fps',cfg.responseFps); st('v-rfps',cfg.responseFps+'fps');
  sv('wobble-amp',Math.round(cfg.gifWobbleAmp*10));   st('v-wa',cfg.gifWobbleAmp.toFixed(1));
  sv('wobble-period',Math.round(cfg.gifWobblePeriod*10)); st('v-wp',cfg.gifWobblePeriod.toFixed(1));
  // スタックモード
  if(el('stack-mode')) el('stack-mode').checked=!!cfg.stackMode;
  // ローカルAPI
  if(el('local-api-enabled')) el('local-api-enabled').checked=!!cfg.localApiEnabled;
  sv('local-api-port',cfg.localApiPort);
  updateLocalApiStatus();
}

function startOrRestartLocalApi(){
  if(!window.electronAPI?.startLocalApi) return;
  console.log('[LocalAPI] starting on port', cfg.localApiPort);
  window.electronAPI.startLocalApi(cfg.localApiPort).then(r=>{
    console.log('[LocalAPI] start result:', r);
    updateLocalApiStatus();
  });
}
function stopLocalApiRenderer(){
  if(!window.electronAPI?.stopLocalApi) return;
  window.electronAPI.stopLocalApi().then(()=>updateLocalApiStatus());
}
function updateLocalApiStatus(){
  const dot=document.getElementById('local-api-status-dot');
  const txt=document.getElementById('local-api-status-text');
  if(!dot||!txt) return;
  const on=!!cfg.localApiEnabled;
  dot.style.color=on?'#4ade80':'#6b7280';
  txt.textContent=on?`待機中 (port ${cfg.localApiPort})`:'停止中';
}

// ══════════════════════════════════════════
//  PANEL / TAB
// ══════════════════════════════════════════
function quitApp(){
  if(window.electronAPI) window.electronAPI.quitApp();
}
document.getElementById('gear-btn').onclick=openPanel;
function openPanel(){
  buildVariantList();
  document.getElementById('panel').classList.add('open');
  // 設定中: alwaysOnTop を外してウィンドウを自由に移動できるようにする
  if(window.electronAPI) window.electronAPI.setAlwaysOnTop(false);
}
function closePanel(){
  document.getElementById('panel').classList.remove('open');
  // 配信中: alwaysOnTop を復元
  if(window.electronAPI) window.electronAPI.setAlwaysOnTop(true);
  // cfg をアプリ設定として自動保存
  if(window.electronAPI) window.electronAPI.saveAppSettings(JSON.stringify(cfg));
}

function setAnimFps(v){
  cfg.targetFps=v;
  const sl=document.getElementById('fps-slider'), lb=document.getElementById('v-fps');
  if(sl) sl.value=v; if(lb) lb.textContent=v+'fps';
}

const TAB_NAMES=['layers','variants','actions','blink','audio','anim','input','project'];
function switchTab(name){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',TAB_NAMES[i]===name));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id==='tab-'+name));
  if(name==='variants') buildVariantList();
  if(name==='actions')  buildActionList();
}

// ══════════════════════════════════════════
//  Electron 環境初期化
// ══════════════════════════════════════════
(async function initElectron(){
  if(!window.electronAPI) return;

  // ── 前回プロジェクトと設定を並行ロード ──
  const [lastProjRaw, savedCfg] = await Promise.all([
    window.electronAPI.loadLastProject(),
    window.electronAPI.loadAppSettings(),
  ]);

  // 前回プロジェクトがあれば復元（画像・差分・cfg を一括復元）
  if(lastProjRaw){
    try{
      applyProject(JSON.parse(lastProjRaw));
    }catch(e){
      console.warn('前回プロジェクト復元失敗:', e.message);
      // フォールバック: cfg のみ復元
      if(savedCfg){ Object.assign(cfg, savedCfg); syncCfgToUI(); }
    }
  } else if(savedCfg){
    // プロジェクトなし: cfg のみ復元
    Object.assign(cfg, savedCfg);
    syncCfgToUI();
  }

  // インポートUIをElectron用ボタンに切り替え
  const browserRow=document.getElementById('import-row-browser');
  const electronRow=document.getElementById('import-row-electron');
  if(browserRow) browserRow.style.display='none';
  if(electronRow) electronRow.style.display='flex';
  // 終了ボタンを表示
  const quitBtn=document.getElementById('quit-btn');
  if(quitBtn) quitBtn.style.display='';
  // ドラッグバーのヒントテキストを設定
  const hint=document.getElementById('drag-hint-text');
  if(hint) hint.textContent='（このバーをドラッグで移動）';

  // グローバルホットキー受信（OBSにフォーカスがある状態でも動作）
  // uiohook-napiのkeycodeをキー文字列にマップ
  // 参照: https://github.com/kwhat/uiohook-napi?tab=readme-ov-file#key-codes
  // ─── グローバルキーボード ───
  // キーボードアクティブ検知（他アプリ操作中も hand_l を切り替える）
  // ショートカットは Ctrl+数字 / Ctrl+矢印 のみ（誤作動防止）
  // Ctrl+数字: キーコード → スロットインデックス（0=ベースリセット用、1-9=スロット0-8）
  const NUM_MAP={ 11:0, 2:1, 3:2, 4:3, 5:4, 6:5, 7:6, 8:7, 9:8, 10:9 };
  // Ctrl+矢印: キーコード → スロットインデックス（スロット9-11）
  const ARR_MAP={ 57416:9, 57419:10, 57421:11 }; // ↑←→（↓はベース戻しのため別処理）

  window.electronAPI.onGlobalKeydown((e)=>{
    // キーボードアクティブ状態を更新（全キー対象）
    S.isKbActive=true; clearTimeout(kbTimer);
    kbTimer=setTimeout(()=>{ S.isKbActive=false; updateInput(); },cfg.keyboardMs);
    updateInput();

    // ショートカットは Ctrl が必要かつパネルが閉じている時のみ
    if(!e.ctrlKey) return;
    if(document.getElementById('panel').classList.contains('open')) return;

    // Ctrl+Alt+1〜8: ワンショットアクション（keycodes 2〜9 = キー1〜8）
    if(e.altKey){
      const numSlot=NUM_MAP[e.keycode];
      if(numSlot>=1&&numSlot<=8){ triggerAction(numSlot-1); return; }
      return;
    }

    const numSlot=NUM_MAP[e.keycode];
    if(numSlot!==undefined){
      if(numSlot===0) setVariant(-1);           // Ctrl+0 → ベース
      else toggleVariant(numSlot-1);            // Ctrl+1〜9 → スロット0〜8
      return;
    }
    if(e.keycode===57424){ setVariant(-1); return; }            // Ctrl+↓ → ベースに戻す
    const arrSlot=ARR_MAP[e.keycode];
    if(arrSlot!==undefined){ toggleVariant(arrSlot); return; } // Ctrl+↑←→ → スロット9〜11
  });

  // ─── グローバルマウス ───
  // cfg.mouseMoveThrottle ms 未満のイベントは捨てる（0 = 全処理）
  let _lastMouseIpc=0;
  window.electronAPI.onGlobalMouseActive(()=>{
    const now=Date.now();
    if(cfg.mouseMoveThrottle>0 && now-_lastMouseIpc < cfg.mouseMoveThrottle) return;
    _lastMouseIpc=now;
    S.isMouseActive=true; clearTimeout(msTimer);
    msTimer=setTimeout(()=>{ S.isMouseActive=false; updateInput(); },cfg.mouseMs);
    updateInput();
  });

  // ─── ローカルAPI コマンド受信 ───
  window.electronAPI.onLocalApiCommand((cmd)=>{
    console.log('[LocalAPI renderer] received cmd:', JSON.stringify(cmd));
    if(cmd.type==='variant'){
      const t=cmd.target;
      if(t==='reset'||t==='-1'){
        console.log('[LocalAPI renderer] setVariant(-1)');
        setVariant(-1);
      } else if(t==='next'){
        const cur=getActiveVariant();
        const next=cur<VARIANT_SLOT_COUNT-1?cur+1:0;
        console.log('[LocalAPI renderer] next →', next);
        setVariant(next);
      } else if(t==='prev'){
        const cur=getActiveVariant();
        const prev=cur<=0?VARIANT_SLOT_COUNT-1:cur-1;
        console.log('[LocalAPI renderer] prev →', prev);
        setVariant(prev);
      } else {
        const useSet  =!!cmd.params?.set;
        const useUnset=!!cmd.params?.unset;
        const n=parseInt(t);
        let idx;
        if(!isNaN(n)){
          idx=n<0?-1:Math.min(n,VARIANT_SLOT_COUNT-1);
        } else {
          idx=variants.findIndex(v=>v.label===t);
          if(idx<0){
            console.warn('[LocalAPI renderer] variant name "'+t+'" not found. registered labels:',
              variants.map((v,i)=>`[${i}]"${v.label}"`).join(', '));
          }
        }
        if(idx>=0){
          if(useSet){
            // ?set: 適用済みなら何もしない、未適用なら適用（トグル解除しない）
            const alreadyActive=activeVariants.includes(idx);
            console.log('[LocalAPI renderer] ?set idx='+idx+' alreadyActive='+alreadyActive+' stackMode='+cfg.stackMode);
            if(!alreadyActive){
              if(cfg.stackMode) toggleStackVariant(idx);
              else              setVariant(idx);
            }
          } else if(useUnset){
            // ?unset: 適用中なら解除、未適用なら何もしない（?set の逆）
            const alreadyActive=activeVariants.includes(idx);
            console.log('[LocalAPI renderer] ?unset idx='+idx+' alreadyActive='+alreadyActive+' stackMode='+cfg.stackMode);
            if(alreadyActive){
              if(cfg.stackMode) toggleStackVariant(idx);  // スタックから取り除く
              else              setVariant(-1);            // ベースにリセット
            }
          } else {
            console.log('[LocalAPI renderer] toggleVariant idx='+idx+' stackMode='+cfg.stackMode);
            toggleVariant(idx);
          }
        }
      }
    } else if(cmd.type==='action'){
      const t=cmd.target;
      if(t==='stop'){
        console.log('[LocalAPI renderer] stopAction');
        stopAction(cmd.params?.variant!=null?parseInt(cmd.params.variant):undefined);
        return;
      }
      let idx=-1;
      const n=parseInt(t);
      if(!isNaN(n)) idx=n;
      else idx=actions.findIndex(a=>a.label===t);
      if(idx<0){
        console.warn('[LocalAPI renderer] action name "'+t+'" not found. registered labels:',
          actions.map((a,i)=>`[${i}]"${a.label}"`).join(', '));
        return;
      }
      if(idx>=ACTION_SLOT_COUNT){
        console.warn('[LocalAPI renderer] action idx out of range:', idx);
        return;
      }
      console.log('[LocalAPI renderer] action target="'+t+'" → idx:', idx, '("'+actions[idx].label+'")');
      // loop / span をAPIパラメータで一時的に上書きして再生
      const savedLoop=actions[idx].loop, savedSpan=actions[idx].span;
      if(cmd.params?.loop!=null) actions[idx].loop=cmd.params.loop;
      if(cmd.params?.span!=null) actions[idx].span=cmd.params.span;
      console.log('[LocalAPI renderer] playAction('+idx+') loop='+actions[idx].loop+' span='+actions[idx].span);
      playAction(idx);
      // 再生開始後にデフォルト値に戻す（次回のデフォルト再生に影響させない）
      actions[idx].loop=savedLoop; actions[idx].span=savedSpan;
    } else {
      console.warn('[LocalAPI renderer] unknown cmd type:', cmd.type);
    }
  });

  // ローカルAPI を設定に従って起動
  if(cfg.localApiEnabled) startOrRestartLocalApi();
})();
