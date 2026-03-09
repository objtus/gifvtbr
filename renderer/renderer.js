'use strict';

// ══════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════
const cfg = {
  mouthCloseDelay:180, audioSmoothing:0.3,
  lipsyncLevels:[0,5,15,30,60], // [closed,small,open,wide,shout] の下限閾値（RMS %）
  bandSplit:false,               // 帯域分割モード（true=中域RMS主軸、false=全域RMS）
  sibilantThreshold:15,          // 歯擦音判定閾値（bandSplit有効時のみ）
  roundedThreshold:10,           // 丸口判定閾値（bandSplit有効時のみ）
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
  extra:{default:null}, fg:{default:null},
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
  {id:'extra-default',     label:'アクセサリ',  layer:'extra',     state:'default'},
  {id:'fg-default',        label:'前景',        layer:'fg',        state:'default'},
];

// ショートカットキーの表示ラベル（スロットインデックス対応）
// スロット 0-8: Ctrl+1〜9、スロット 9-11: Ctrl+↑←→
const VARIANT_KEYS=['1','2','3','4','5','6','7','8','9','↑','←','→'];
const VARIANT_SLOT_COUNT=12;

const variants=Array.from({length:VARIANT_SLOT_COUNT},(_,i)=>({label:`差分${i+1}`,patches:{},open:false}));
let activeVariant=-1;

function resolveLayer(layer,state){
  if(activeVariant>=0){
    const pid=`${layer}-${state}`;
    const p=variants[activeVariant].patches[pid];
    if(p?.img){
      const lp=GIF_LOOPERS[`patch-${activeVariant}-${pid}`];
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

  // 背景（揺らぎは animNow でコマ送り）
  const bgImg=resolveLayer('bg','default');
  if(bgImg) drawBreath(bgImg,cx,cy,1,0,gifWobble(animNow,7.1));

  // 胴体
  const torsoImg=resolveLayer('body_torso','default');
  if(torsoImg) drawBreath(torsoImg,cx,cy,tV.sY,tV.bY,gifWobble(animNow,1.0));

  // 手（入力ポーズは常に最新の状態を反映）
  const rImg=S.isMouseActive?(resolveLayer('hand_r','mouse')||resolveLayer('hand_r','default')):resolveLayer('hand_r','default');
  const lImg=S.isKbActive?(resolveLayer('hand_l','keyboard')||resolveLayer('hand_l','default')):resolveLayer('hand_l','default');
  if(cfg.handFollowDelay<0){
    if(rImg) drawNormal(rImg,cx,cy);
    if(lImg) drawNormal(lImg,cx,cy);
  } else {
    const hw=gifWobble(animNow,3.3);
    if(rImg) drawBreath(rImg,cx,cy,handV.sY,handV.bY,hw);
    if(lImg) drawBreath(lImg,cx,cy,handV.sY,handV.bY,hw);
  }

  // 頭部（口・目より先に描いて顔パーツが上に重なるようにする）
  const headImg=resolveLayer('body_head','default');
  if(headImg) drawBreath(headImg,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // 口（形状オーバーライド優先。未登録時は mouthLevel フォールバック）
  let mImg=null;
  if(cfg.bandSplit && S.mouthShape)
    mImg=resolveLayer('mouth',S.mouthShape)||resolveMouth(S.mouthLevel);
  else
    mImg=resolveMouth(S.mouthLevel);
  if(mImg) drawBreath(mImg,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // 目（まばたき状態は常に最新、GIF再生フレームも随時反映）
  let eyeSrc=null;
  if(cfg.blinkMode==='gif'&&GifPlayer.isPlaying()) eyeSrc=GifPlayer.getCanvas();
  else { const k=S.blinkFrame===2?'closed':S.blinkFrame===1?'half':'open'; eyeSrc=resolveLayer('eyes',k)||resolveLayer('eyes','open'); }
  if(eyeSrc) drawBreath(eyeSrc,cx,cy,hV.sY,hV.bY,gifWobble(animNow,2.1));

  // アクセサリ（目・口の上、前景の下）
  const exImg=resolveLayer('extra','default');
  if(exImg) drawBreath(exImg,cx,cy,tV.sY,tV.bY,gifWobble(animNow,5.5));

  // 前景
  const fgImg=resolveLayer('fg','default');
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
  if(activeVariant>=0){
    ctx.fillStyle='rgba(124,58,237,.7)'; roundRect(ctx,-r*.6,r*.55,r*1.2,r*.25,r*.05); ctx.fill();
    ctx.fillStyle='white'; ctx.font=`bold ${r*.1}px 'Segoe UI'`;
    ctx.textAlign='center'; ctx.fillText(variants[activeVariant].label,0,r*.69); ctx.textAlign='left';
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
  // Ctrl+数字 / Ctrl+矢印: 差分スロット切替
  if(!e.ctrlKey) return;
  e.preventDefault();
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
// 同じスロットを再度押したらベースに戻るトグル動作
function toggleVariant(idx){
  setVariant(activeVariant===idx?-1:idx);
}

let toastTimer;
function showToast(msg){
  const t=document.getElementById('expr-toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2500);
}
function setVariant(idx){
  activeVariant=idx;
  // GIFモードのまばたきは差分切替時に対応するまばたきGIFを再ロード
  if(cfg.blinkMode==='gif'){
    const varSrc=idx>=0 ? variants[idx].patches['eyes-blinkgif']?.src : null;
    const baseSrc=BASE_SRCS['eyes__blinkgif'];
    const src=varSrc||baseSrc;
    if(src) GifPlayer.load(src).catch(()=>{});
  }
  showToast(idx>=0?variants[idx].label:'ベース');
  document.querySelectorAll('.variant-header').forEach((h,i)=>{
    h.querySelector('.variant-active-badge')?.classList.toggle('show',i===idx);
  });
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
      <div class="variant-active-badge ${activeVariant===vi?'show':''}">● ACTIVE</div>
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
    if(state==='blinkgif' && activeVariant===vi && cfg.blinkMode==='gif')
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
//  プロジェクト保存 / 読込
// ══════════════════════════════════════════
async function exportProject(){
  showToast('保存中…');
  const proj={
    version:'0.4', cfg:{...cfg},
    baseImages: {...BASE_SRCS},
    variants: variants.map(v=>({
      label:v.label,
      patches: Object.fromEntries(
        Object.entries(v.patches).filter(([,p])=>p?.src).map(([k,p])=>[k,{src:p.src}])
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
  activeVariant=-1;
  syncCfgToUI(); buildVariantList();
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

const TAB_NAMES=['layers','variants','blink','audio','anim','input','project'];
function switchTab(name){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',TAB_NAMES[i]===name));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id==='tab-'+name));
  if(name==='variants') buildVariantList();
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
})();
