/* Banana Bonanza (Alpha) - Client
 * - Canvas pixel renderer (nearest-neighbor, integer snap)
 * - Jungle camp matchmaking + invite
 * - Gorilla Guard & Competitive modes
 * - Juicy FX: screenshake, hit flash, dust, sparkles, squash
 * - Procedural pixel sprites (no external assets)
 */
(() => {
  const TILE = 16;
  const VIEW_W = 960, VIEW_H = 576;
  const BRIDGE_MAX = 6;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;

  const hud = {
    root: document.getElementById('hud'),
    timer: document.getElementById('timer'),
    score: document.getElementById('score'),
    target: document.getElementById('target'),
    pile: document.getElementById('pile'),
    status: document.getElementById('status'),
  };
  const campPanel = document.getElementById('camp-overlay');
  const btnEnterCamp = document.getElementById('btnEnterCamp');
  const invitePanel = document.getElementById('invite');
  const inviteLinkInput = document.getElementById('inviteLink');

  const urlParams = new URLSearchParams(location.search);
  const invitedRoom = urlParams.get('room');
  const invitedMode = urlParams.get('mode');
  const requestedMode = invitedMode === 'competitive' ? 'competitive' : 'gorilla';

  const WS_URL = ((location.protocol==='https:')?'wss://':'ws://') + location.host + '/ws';
  const socket = new WebSocket(WS_URL);
  let myId = null, roomId = null;

  const Net = { send(obj){ if (socket.readyState===1) socket.send(JSON.stringify(obj)); } };

  socket.addEventListener('open', () => { Net.send({ t:'hello', client:'banana-bonanza', v:1 }); });

  const game = { mode:'guard', state:null };
  const anim = { t:0, scoreShown:0, scoreTarget:0, shakeX:0, shakeY:0, flash:0 };

  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t==='hello'){ myId = msg.id; return; }
    if (msg.t==='camp'){ return; }
    if (msg.t==='joined'){
      roomId = msg.roomId;
      if (msg.inviteUrl){ invitePanel.classList.remove('hidden'); inviteLinkInput.value = msg.inviteUrl; }
      game.mode = msg.mode;
      return;
    }
    if (msg.t==='state'){
      game.state = msg;
      hud.root.classList.remove('hidden');
      hud.timer.textContent = formatTime(msg.timeLeft ?? 0);
      hud.target.textContent = 'Target: ' + (msg.target ?? 50);
      if (msg.mode==='comp'){ hud.pile.classList.remove('hidden'); hud.pile.textContent = 'Center: ' + (msg.centerPile ?? 0); }
      else { hud.pile.classList.add('hidden'); }
      const me = (msg.players||[]).find(p=>p.id===myId);
      if (me) anim.scoreTarget = me.banked;
    }
  });

  const keys = {};
  const keyMap = { 'KeyW':'up','KeyA':'left','KeyS':'down','KeyD':'right','Space':'space','KeyE':'e','KeyQ':'q' };
  addEventListener('keydown', (e)=>{ const k=keyMap[e.code]; if(k){keys[k]=true; e.preventDefault();} });
  addEventListener('keyup',   (e)=>{ const k=keyMap[e.code]; if(k){keys[k]=false; e.preventDefault();} });

  setInterval(()=>{ if (roomId) Net.send({ t:'input', up:!!keys.up,down:!!keys.down,left:!!keys.left,right:!!keys.right,space:!!keys.space,e:!!keys.e,q:!!keys.q }); }, 60);

  btnEnterCamp.addEventListener('click', () => { campPanel.classList.add('hidden'); Net.send({ t:'camp-enter' }); scene='camp'; });
  if (invitedRoom){ campPanel.classList.add('hidden'); Net.send({ t:'select-mode', mode: requestedMode, roomId: invitedRoom, name: suggestName() }); scene='game'; }
  else { campPanel.classList.remove('hidden'); }

  // --- Audio (tiny WebAudio synth) ---
  const audio = (() => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let bgmGain = ctx.createGain(); bgmGain.gain.value = 0.06; bgmGain.connect(ctx.destination);
    let sfxGain = ctx.createGain(); sfxGain.gain.value = 0.18; sfxGain.connect(ctx.destination);

    function startBgm(){
      const o1 = ctx.createOscillator(); const g1 = ctx.createGain();
      o1.type='sawtooth'; o1.frequency.value=90; g1.gain.value=0.02; o1.connect(g1).connect(bgmGain); o1.start();
      const o2 = ctx.createOscillator(); const g2 = ctx.createGain();
      o2.type='sine'; o2.frequency.value=55; g2.gain.value=0.03; o2.connect(g2).connect(bgmGain); o2.start();
      const tick = () => {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator(), gn=ctx.createGain();
        osc.type='square'; osc.frequency.value=800; gn.gain.setValueAtTime(0.0,t); gn.gain.linearRampToValueAtTime(0.04,t+0.005); gn.gain.exponentialRampToValueAtTime(0.0001,t+0.08);
        osc.connect(gn).connect(bgmGain); osc.start(t); osc.stop(t+0.09);
      };
      setInterval(tick, 1000);
      startBgm.duck = (amt=0.4, ms=500) => {
        const t = ctx.currentTime, g = bgmGain.gain, base = 0.06;
        g.cancelScheduledValues(t); g.setValueAtTime(base, t); g.linearRampToValueAtTime(base*(1-amt), t+0.1); g.linearRampToValueAtTime(base, t + ms/1000);
      };
    }
    startBgm();

    function roar(){
      const t=ctx.currentTime;
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate*0.5, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i=0;i<data.length;i++){ data[i] = (Math.random()*2-1) * (1 - i/data.length); }
      noise.buffer = buf;
      const gn = ctx.createGain(); gn.gain.value = 0.25;
      const filter = ctx.createBiquadFilter(); filter.type='lowpass'; filter.frequency.value=350;
      noise.connect(filter).connect(gn).connect(sfxGain); noise.start(t); noise.stop(t+0.5);
      if (startBgm.duck) startBgm.duck(0.6, 650);
    }
    return { roar };
  })();

  // --- Sprites (procedural pixel art) ---
  const Spr = (() => {
    const palette = { dark:'#0b120a', mid:'#2e3c24', light:'#9ad451', sand:'#c2a86a', water:'#2b6fb0', water2:'#1d5a90', mud:'#6a4a2a', vine:'#3fa04a', banana:'#ffe85a', banana2:'#ffd12a' };
    function makeCanvas(w,h){ const cvs=document.createElement('canvas'); cvs.width=w; cvs.height=h; const c=cvs.getContext('2d',{alpha:true}); c.imageSmoothingEnabled=false; return [cvs,c]; }

    const tileAtlas = (() => {
      const atlas = {};
      function drawGrass(c){ c.fillStyle='#20301a'; c.fillRect(0,0,16,16); for (let i=0;i<28;i++){ c.fillStyle=Math.random()<0.6?'#2c4422':'#36552a'; c.fillRect((Math.random()*16)|0,(Math.random()*16)|0,1,1); } }
      function drawStone(c){ c.fillStyle='#3a3a3a'; c.fillRect(0,0,16,16); c.fillStyle='#2e2e2e'; for (let i=0;i<8;i++) c.fillRect((Math.random()*16)|0,(Math.random()*16)|0,2,1); }
      function drawMud(c){ c.fillStyle=palette.mud; c.fillRect(0,0,16,16); c.fillStyle='#7b5b36'; for (let i=0;i<14;i++) c.fillRect((Math.random()*16)|0,(Math.random()*16)|0,1,1); }
      function drawWater(c,t){ const g=c.createLinearGradient(0,0,0,16); g.addColorStop(0,palette.water); g.addColorStop(1,palette.water2); c.fillStyle=g; c.fillRect(0,0,16,16); c.globalAlpha=0.15; c.fillStyle='#fff'; for (let i=0;i<6;i++) c.fillRect((i*3+t)%16, (i*2+t*0.7)%16, 2,1); c.globalAlpha=1; }
      function drawBridge(c,phase){ drawWater(c,0); c.fillStyle='#6b4a2a'; c.fillRect(0,7,16,2); if (phase>=1){ c.fillStyle='#3a2614'; c.fillRect(0,7,16,1); } if (phase>=2){ c.fillStyle='#2a1a0c'; c.fillRect(0,8,16,1); } if (phase>=3){ c.clearRect(2,7,4,2); c.clearRect(10,7,4,2);} }
      function drawVine(c,t){ drawGrass(c); c.strokeStyle=palette.vine; c.lineWidth=2; c.beginPath(); c.moveTo(2, 3+t%3-1); c.quadraticCurveTo(8, 8, 14, 12-t%3+1); c.stroke(); }

      for (let i=0;i<4;i++){ const [cv,c]=makeCanvas(16,16); drawGrass(c); atlas['.g'+i]=cv; }
      for (let i=0;i<4;i++){ const [cv,c]=makeCanvas(16,16); drawStone(c); atlas['#'+i]=cv; }
      for (let i=0;i<4;i++){ const [cv,c]=makeCanvas(16,16); drawMud(c); atlas[','+i]=cv; }
      for (let i=0;i<4;i++){ const [cv,c]=makeCanvas(16,16); drawWater(c,i); atlas['~'+i]=cv; }
      for (let i=0;i<4;i++){ const [cv,c]=makeCanvas(16,16); drawVine(c,i); atlas['v'+i]=cv; }
      for (let ph=0;ph<4;ph++){ const [cv,c]=makeCanvas(16,16); drawBridge(c,ph); atlas['='+ph]=cv; }
      for (const mark of ['S','B','C','g']){ const [cv,c]=makeCanvas(16,16); drawStone(c); c.fillStyle=mark==='S'?'#ffd12a': mark==='B'?'#9ad451': mark==='C'?'#f49430':'#cccccc'; c.fillRect(5,5,6,6); atlas[mark]=cv; }
      return atlas;
    })();

    function sprite24(){ const cv=document.createElement('canvas'); cv.width=24; cv.height=24; const c=cv.getContext('2d'); c.imageSmoothingEnabled=false; return [cv,c]; }
    function drawMonkey(c, t, opts){ const carry=opts.carry||0, stunned=opts.stunned, action=opts.action||'idle'; const base='#6a4f2a', dark='#3e2a16', face='#c09763'; const bob=(action==='run'||action==='carry')?Math.sin(t*18)*1.2:Math.sin(t*6)*0.6; c.fillStyle='rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(12, 20, 8, 3, 0,0,Math.PI*2); c.fill(); c.fillStyle=dark; c.fillRect(8+Math.sin(t*18),17,3,5); c.fillRect(13-Math.sin(t*18),17,3,5); c.fillStyle=base; c.fillRect(7,8+bob,10,10); c.fillStyle=face; c.fillRect(9,10+bob,6,6); c.fillStyle=base; c.fillRect(5+(Math.cos(t*18)*1.2),10+bob,3,6); c.fillRect(16-(Math.cos(t*18)*1.2),10+bob,3,6); c.fillStyle=base; c.fillRect(8,3+bob,10,8); c.fillStyle=face; c.fillRect(10,6+bob,6,3); c.fillStyle='#000'; c.fillRect(11,5+bob,1,1); c.fillRect(15,5+bob,1,1); if (carry>0){ c.fillStyle='#ffe85a'; c.fillRect(6,12+bob,4,4); c.fillRect(16,12+bob,4,4); c.fillStyle='#ad8d1a'; c.fillRect(6,12+bob,1,4); c.fillRect(19,12+bob,1,4); } if (stunned){ c.fillStyle='#fff'; c.fillRect(6,1,2,2); c.fillRect(18,2,2,2);} }
    function drawGorilla(c, t, enraged){ const base='#4a3a2a', dark='#2b1e14', face='#c0a070'; const bob=Math.sin(t*10)*0.8; c.fillStyle='rgba(0,0,0,0.25)'; c.beginPath(); c.ellipse(12, 22, 9, 4, 0,0,Math.PI*2); c.fill(); c.fillStyle=dark; c.fillRect(7,17,5,6); c.fillRect(13,17,5,6); c.fillStyle=base; c.fillRect(6,8+bob,14,10); c.fillStyle=face; c.fillRect(9,10+bob,8,6); c.fillStyle=base; c.fillRect(4,10+bob,4,8); c.fillRect(18,10+bob,4,8); c.fillStyle=base; c.fillRect(8,3+bob,10,6); c.fillStyle=face; c.fillRect(10,5+bob,6,3); c.fillStyle='#000'; c.fillRect(12,4+bob,2,1); c.fillRect(14,4+bob,2,1); if (enraged){ c.fillStyle='#f45b2a'; c.fillRect(12,4+bob,2,1); c.fillRect(14,4+bob,2,1);} }
    function drawBanana(c, t, kind){ const wig=Math.sin(t*18)*0.6; c.fillStyle=kind==='golden'?'#ffd700':palette.banana; c.fillRect(7,8+wig,6,3); c.fillStyle=kind==='golden'?'#ffeb6a':palette.banana2; c.fillRect(8,8+wig,4,2); c.fillStyle='#6a4a2a'; c.fillRect(6,8+wig,1,1); c.fillRect(13,10+wig,1,1); }
    return { tileAtlas, sprite24, drawMonkey, drawGorilla, drawBanana };
  })();

  function formatTime(s){ const m=Math.floor(s/60), ss=Math.floor(s%60); return `${m}:${ss<10?'0':''}${ss}`; }
  function withShake(fn){ const sx=Math.round(anim.shakeX), sy=Math.round(anim.shakeY); ctx.save(); ctx.translate(sx, sy); fn(); ctx.restore(); anim.shakeX*=0.9; anim.shakeY*=0.9; }
  function pixelText(txt,x,y){ ctx.save(); ctx.fillStyle='#e6ff9a'; ctx.font='900 10px monospace'; ctx.fillText(String(txt), x, y); ctx.restore(); }

  // --- Camp scene ---
  let scene='menu';
  const camp = { t:0, monkey:{x:VIEW_W/2, y:VIEW_H-80}, zones:[ {name:'Solo (Gorilla Guard)',mode:'gorilla',x:VIEW_W*0.25,y:VIEW_H*0.35}, {name:'Co-op (Guard)',mode:'gorilla',x:VIEW_W*0.5,y:VIEW_H*0.30}, {name:'Competitive',mode:'competitive',x:VIEW_W*0.75,y:VIEW_H*0.35}, {name:'Campfire (Invite Link)',mode:'invite',x:VIEW_W*0.5,y:VIEW_H*0.55} ] };

  function drawCamp(dt){
    camp.t += dt;
    ctx.fillStyle='#10200f'; ctx.fillRect(0,0,VIEW_W,VIEW_H);
    ctx.fillStyle='#3c3322'; ctx.fillRect(VIEW_W*0.2, VIEW_H*0.28, VIEW_W*0.6, 16);
    ctx.fillRect(VIEW_W*0.48, VIEW_H*0.28, 16, VIEW_H*0.33);
    const fx=VIEW_W*0.5, fy=VIEW_H*0.55;
    ctx.fillStyle='#6a3a1a'; ctx.fillRect(fx-6, fy+10, 12, 8);
    ctx.fillStyle='#f1b020'; ctx.beginPath(); ctx.arc(fx, fy, 14+Math.sin(camp.t*5)*2, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#dffd9f'; ctx.font='900 14px monospace';
    for (const z of camp.zones){ ctx.fillText(z.name, z.x-80, z.y-14); ctx.fillStyle='#2e502e'; ctx.fillRect(z.x-10, z.y-10, 20, 20); ctx.fillStyle='#9ad451'; ctx.fillRect(z.x-8, z.y-8, 16, 16); ctx.fillStyle='#dffd9f'; }

    const dx=(keys.right?1:0)-(keys.left?1:0), dy=(keys.down?1:0)-(keys.up?1:0);
    const spd=2.0;
    camp.monkey.x = clamp(camp.monkey.x + dx*spd, 20, VIEW_W-20);
    camp.monkey.y = clamp(camp.monkey.y + dy*spd, VIEW_H*0.25, VIEW_H-20);

    const [cv,c] = Spr.sprite24(); Spr.drawMonkey(c, camp.t, { action:(dx||dy)?'run':'idle', carry:0, stunned:false }); ctx.drawImage(cv, Math.round(camp.monkey.x-12), Math.round(camp.monkey.y-20));

    for (const z of camp.zones){
      const d = Math.hypot(camp.monkey.x - z.x, camp.monkey.y - z.y);
      if (d<26 && keys.e){
        if (z.mode==='invite'){ if (!roomId){ Net.send({ t:'select-mode', mode: requestedMode, name: suggestName() }); scene='game'; } else { invitePanel.classList.remove('hidden'); } }
        else { Net.send({ t:'select-mode', mode: z.mode, name: suggestName() }); scene='game'; }
      }
    }
  }

  // --- Game render ---
  function renderGame(dt){
    ctx.fillStyle='#0b140a'; ctx.fillRect(0,0,VIEW_W,VIEW_H);
    const s = game.state;
    if (!s){ drawCamp(0); return; }

    if (s.gorilla && s.gorilla.state==='roar'){ audio.roar(); anim.shakeX += (Math.random()*4-2); anim.shakeY += (Math.random()*4-2); }

    const t = performance.now()/1000;
    const animIdx = (Math.floor(t*6))%4;

    for (let y=0;y<28;y++){
      for (let x=0;x<44;x++){
        const base = mapCharAt(x,y);
        let drawKey = base;
        if (base==='='){
          const key = `${x},${y}`;
          const rec = (s.bridges||[]).find(b=>b.k===key);
          const uses = rec ? rec.v : 0;
          let ph = 0;
          if (uses >= BRIDGE_MAX+1) ph = 3;
          else if (uses >= Math.floor(BRIDGE_MAX*0.66)) ph = 2;
          else if (uses >= Math.floor(BRIDGE_MAX*0.33)) ph = 1;
          drawKey = '='+ph;
        } else if (base==='~') drawKey='~'+animIdx;
        else if (base===',') drawKey=','+animIdx;
        else if (base==='v') drawKey='v'+animIdx;
        else if (base==='#') drawKey='#'+animIdx;
        else if (base==='.') drawKey='.g'+animIdx;
        const tile = Spr.tileAtlas[drawKey] || Spr.tileAtlas['.g0'];
        ctx.drawImage(tile, x*16, y*16);
      }
    }

    withShake(() => {
      for (const b of (s.bananas||[])){ const [cv,c]=Spr.sprite24(); Spr.drawBanana(c, t, b.kind); ctx.drawImage(cv, Math.round(b.x-12), Math.round(b.y-12)); }
      for (const cEv of (s.crocs||[])){ const timeLeft = (cEv.until - Date.now())/1000; if (timeLeft>0){ ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(cEv.x, cEv.y, 10+Math.sin(t*60), 0, Math.PI*2); ctx.stroke(); } }
      for (const m of (s.minions||[])){ const [cv,c]=Spr.sprite24(); if (m.kind==='baby'){ Spr.drawGorilla(c, t, false);} else { Spr.drawMonkey(c, t, {action:'run', carry:m.carry, stunned:m.stun}); } ctx.drawImage(cv, Math.round(m.x-12), Math.round(m.y-20)); }
      if (s.gorilla){ const [cv,c]=Spr.sprite24(); Spr.drawGorilla(c, t, s.gorilla.enraged); ctx.drawImage(cv, Math.round(s.gorilla.x-12), Math.round(s.gorilla.y-22)); }
      for (const p of (s.players||[])){ const [cv,c]=Spr.sprite24(); Spr.drawMonkey(c, t, { action:(p.carry>0?'carry':'run'), carry:p.carry, stunned:p.stun }); ctx.drawImage(cv, Math.round(p.x-12), Math.round(p.y-20)); pixelText(p.name||'Monkey', Math.round(p.x-16), Math.round(p.y-28)); }
    });

    anim.scoreShown += (anim.scoreTarget - anim.scoreShown) * 0.15;
    hud.score.textContent = Math.round(anim.scoreShown);
    hud.status.textContent = (s.state==='overtime') ? 'OVERTIME: Sudden Banana!' : (s.timeLeft<=30 ? 'BANANA FEVER (x2 at stash)' : '');
    if (anim.flash>0){ ctx.fillStyle=`rgba(255,255,255,${anim.flash})`; ctx.fillRect(0,0,VIEW_W,VIEW_H); anim.flash*=0.9; }
  }

  const MAP_ASCII = [
"############################################",
"#....................~~~~~.................#",
"#.....vvv...........~~~~~.........vvv......#",
"#.....vvv......====.~~~~~.====....vvv......#",
"#.....vvv......====.~~~~~.====....vvv......#",
"#...............~~~.~~~~~.~~~..............#",
"#....,,,,...........~~~~~...........,,,,...#",
"#....,,,,...........~~~~~...........,,,,...#",
"#....,,,,...........~~~~~...........,,,,...#",
"#....................~~~~~.................#",
"#.............g............................#",
"#...........#####..................#####...#",
"#...........# S #..................#   #...#",
"#...........#   #..................# C #...#",
"#...........#####..................#####...#",
"#..........................................#",
"#..====....................B...............#",
"#..====....................................#",
"#..........................................#",
"#.....vvv.........................vvv......#",
"#.....vvv.........................vvv......#",
"#.....vvv.........................vvv......#",
"#..........................................#",
"#....,,,,.........................,,,,.....#",
"#....,,,,.........................,,,,.....#",
"#....,,,,.........................,,,,.....#",
"#..........................................#",
"############################################",
];
  function mapCharAt(x,y){ if (x<0||y<0||y>=MAP_ASCII.length||x>=MAP_ASCII[0].length) return '#'; return MAP_ASCII[y][x]; }
  function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
  function suggestName(){ const animals=['Macaque','Capuchin','Bonobo','Langur','Howler','Tamarin','Colobus']; return animals[Math.floor(Math.random()*animals.length)] + '-' + Math.floor(Math.random()*90+10); }

  let last = performance.now();
  function frame(ts){ const dt=Math.min(0.033,(ts-last)/1000); last=ts; anim.t+=dt; if (scene==='camp') drawCamp(dt); else renderGame(dt); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
})();
