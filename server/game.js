/**
 * Banana Bonanza Alpha - authoritative game server
 * Modes:
 *  - guard (gorilla guards stash; you raid/defend vs minions)
 *  - comp  (competitive race to bank bananas; golden banana overtime)
 * Networking:
 *  - Same-host WebSocket at /ws
 *  - Server authoritative simulation ~30Hz tick, ~12Hz broadcast
 */
const { nanoid } = require('nanoid');

/** ------------------------ Tunables / Constants --------------------------- **/
const TICK_HZ = 30;             // simulation Hz
const SEND_HZ = 12;             // broadcast Hz
const ROUND_SECONDS = 180;      // 3:00
const FEVER_LAST = 30;          // last 0:30
const OVERTIME_GRACE = 3;       // seconds before sudden banana spawns
const TILE = 16;                // 16x16 tiles
const MAP_W = 44;               // width in tiles
const MAP_H = 28;               // height in tiles
const PLAYER_SPEED = 2.0;       // base px/tick
const CARRY_SLOW_PER = 0.06;    // slow per carried banana
const MUD_FACTOR = 0.55;
const VINE_FACTOR = 1.25;
const WATER_FACTOR = 0.35;
const TACKLE_CD = 0.9;
const TACKLE_STUN = 0.35;
const TACKLE_SPEED = 4.1;
const BAIT_TIME = 3.2;
const BRIDGE_MAX = 6;           // crossings to collapse (intact->cracked->gone)
const BOT_COUNT_COMP = 2;       // filler bots in competitive if needed
const GOAL_BANANAS = 50;

const MINION_WAVE_EVERY = 18;   // seconds
const CROCS_EVERY = 7.5;        // seconds
const CROCS_LUNGE_TIME = 0.35;  // seconds

const GORILLA_BASE_SPEED = 1.8;
const GORILLA_ENRAGE = 1.25;

/** ------------------------ Utility helpers -------------------------------- **/
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist2 = (a, b) => { const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy; }
const now = () => Date.now();

/** ------------------------ Map / Tiles ------------------------------------ **/
/**
 * ASCII map legend (44x28):
 *  '#' = temple wall (solid)
 *  '.' = ground
 *  ',' = mud (slow)
 *  '~' = water (slow + crocs)
 *  '=' = bridge (degrading)
 *  'v' = vine path (speed)
 *  'S' = Gorilla stash
 *  'B' = Player bank (spawn)
 *  'C' = central pile (competitive)
 *  'g' = gorilla patrol marker
 */
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

const tileAt = (x, y) => {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return '#';
  return MAP_ASCII[y][x];
};
const isSolid = (t) => t === '#';
const isWater = (t) => t === '~';
const isMud   = (t) => t === ',';
const isVine  = (t) => t === 'v';
const isBridge= (t) => t === '=';
const isGround= (t) => t === '.' || t === 'S' || t === 'B' || t === 'C' || t === 'g';

function findFirst(ch) {
  for (let y=0;y<MAP_H;y++){
    const x = MAP_ASCII[y].indexOf(ch);
    if (x !== -1) return {x, y};
  }
  return null;
}
const GORILLA_STASH = gridToPx(findFirst('S'));
const PLAYER_BANK   = gridToPx(findFirst('B'));
const COMP_PILE     = gridToPx(findFirst('C'));
const GORILLA_PATROL= gridToPx(findFirst('g'));

function gridToPx(g){ return { x: g.x*TILE + TILE/2, y: g.y*TILE + TILE/2 }; }
function pxToGrid(p){ return { x: Math.floor(p.x/TILE), y: Math.floor(p.y/TILE) }; }

/** BFS for AI pathing (4-neighborhood) */
function bfsPath(fromPx, toPx, passableFn) {
  const from = pxToGrid(fromPx), to = pxToGrid(toPx);
  const key = (x,y)=>`${x},${y}`;
  const q = [from];
  const seen = new Set([key(from.x,from.y)]);
  const prev = new Map();
  while(q.length){
    const n = q.shift();
    if (n.x===to.x && n.y===to.y) break;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx,dy] of dirs){
      const nx=n.x+dx, ny=n.y+dy;
      const t=tileAt(nx,ny);
      if (!passableFn(t)) continue;
      const k=key(nx,ny);
      if (!seen.has(k)){
        seen.add(k); prev.set(k,n);
        q.push({x:nx,y:ny});
      }
    }
  }
  // reconstruct
  const path = [];
  let cur = to;
  const k2 = key(cur.x,cur.y);
  if (!prev.has(k2) && !(cur.x===from.x && cur.y===from.y)) return []; // no path
  while (!(cur.x===from.x && cur.y===from.y)){
    path.push(cur);
    cur = prev.get(key(cur.x,cur.y));
    if (!cur) break;
  }
  path.reverse();
  return path.map(g => ({ x: g.x*TILE+TILE/2, y: g.y*TILE+TILE/2 }));
}

/** ------------------------ Core data types -------------------------------- **/
class Player {
  constructor(id, name) {
    this.id = id;
    this.name = name || ('Monkey-' + id.slice(0,4));
    this.x = PLAYER_BANK.x; this.y = PLAYER_BANK.y;
    this.vx = 0; this.vy = 0;
    this.ready = false;
    this.banked = 0;
    this.carry = 0;
    this.stunUntil = 0;
    this.lastTackle = -999;
    this.isBot = false;
    this.anim = { state:'idle', t:0 };
    this.lastInputAt = now();
    this.holdingE = false;
    this.holdStart = 0;
    this.invulnUntil = 0;
  }
}

class Gorilla {
  constructor() {
    this.x = GORILLA_PATROL.x; this.y = GORILLA_PATROL.y;
    this.state = 'patrol'; // 'patrol'|'charge'|'grabthrow'|'roar'
    this.target = {x:this.x, y:this.y};
    this.enraged = false;
    this.baitTarget = null;
    this.stateUntil = 0;
  }
}
class Minion {
  constructor(kind, x, y){
    this.kind = kind; // 'baby'|'thief'
    this.x = x; this.y = y;
    this.stunUntil = 0;
    this.target = null;
    this.carry = 0;
    this.dead = false;
  }
}
class Banana {
  constructor(x,y, value=1, kind='normal'){
    this.x=x; this.y=y; this.value=value; this.kind=kind; // 'normal'|'golden'|'bait'
    this.vx = (Math.random()*2-1)*0.7;
    this.vy = (Math.random()*2-1)*0.7;
    this.bounceT = 0;
  }
}

/** ------------------------ Room ------------------------------------------- **/
class Room {
  constructor(mode='guard') {
    this.id = nanoid(8);
    this.mode = mode; // 'guard' or 'comp'
    this.players = new Map(); // id -> Player
    this.sockets = new Map(); // id -> ws
    this.createdAt = now();
    this.startedAt = 0;
    this.endsAt = 0;
    this.state = 'waiting'; // waiting|running|overtime|ended
    this.lastSend = 0;
    this.gorilla = new Gorilla();
    this.minions = [];
    this.bananas = [];
    this.bridgeUse = new Map(); // "x,y" -> count; >= BRIDGE_MAX+1 == collapsed
    this.lastWaveAt = 0;
    this.lastCrocAt = 0;
    this.crocEvents = []; // {x,y,until}
    this.centerPile = 80; // comp pile count
    this.inviteUrl = null;
    this.overtimeSpawned = false;
    this.targetScore = 50;
  }

  passableTile(t){
    if (isSolid(t)) return false;
    if (isWater(t)) return false; // water blocked (use bridges/vines)
    return true;
  }

  addSocket(id, ws){ this.sockets.set(id, ws); }
  addPlayer(p, ws){ this.players.set(p.id, p); this.addSocket(p.id, ws); }
  removePlayer(id){ this.players.delete(id); this.sockets.delete(id); }

  startIfReady(){
    if (this.state !== 'waiting') return;
    const cnt = this.players.size;
    if (this.mode==='guard' && cnt>=1) this.start();
    else if (this.mode==='comp' && cnt>=2) this.start();
  }

  start(){
    this.state = 'running';
    const t = now();
    this.startedAt = t;
    this.endsAt = t + ROUND_SECONDS*1000;
    this.lastWaveAt = t;
    this.lastCrocAt = t;

    for (const p of this.players.values()){
      if (this.mode==='guard'){
        p.x = PLAYER_BANK.x; p.y = PLAYER_BANK.y;
      } else {
        p.x = PLAYER_BANK.x + (Math.random()*40-20);
        p.y = PLAYER_BANK.y + (Math.random()*40-20);
      }
      p.banked = 0; p.carry = 0;
      p.stunUntil = 0; p.lastTackle = -999; p.invulnUntil = 0;
    }
    this.gorilla = new Gorilla();
    this.minions = [];
    this.bananas = [];
    this.crocEvents = [];
    this.bridgeUse = new Map();
    this.centerPile = 80;
  }

  end(winnerId = null){ this.state = 'ended'; this.winnerId = winnerId; }
}

/** ------------------------ Game Server ------------------------------------ **/
function createGameServer(wss){
  const rooms = new Map(); // roomId -> Room
  const clientIndex = new Map(); // ws -> {id, roomId}

  function createRoom(mode){ const r = new Room(mode); rooms.set(r.id, r); return r; }
  function joinRoomById(mode, roomId){ const r = rooms.get(roomId); return (r && r.mode===mode && (r.state==='waiting'||r.state==='running')) ? r : null; }
  function anyWaitingRoom(mode){ for (const r of rooms.values()) if (r.mode===mode && r.state==='waiting') return r; return null; }
  function addBot(room){
    const id = nanoid(6);
    const p = new Player(id, 'CPU-Monkey');
    p.isBot = true;
    p.x = PLAYER_BANK.x + Math.random()*20-10;
    p.y = PLAYER_BANK.y + Math.random()*20-10;
    room.players.set(p.id, p);
  }

  /** ------------------- Network ----------------------------------------- **/
  wss.on('connection', (ws, req) => {
    const id = nanoid(8);
    clientIndex.set(ws, { id, roomId: null });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.t === 'hello') { ws.send(JSON.stringify({ t:'hello', id, ok:true })); return; }
      if (msg.t === 'camp-enter') { ws.send(JSON.stringify({ t:'camp', ok:true })); return; }

      if (msg.t === 'select-mode') {
        const mode = msg.mode === 'competitive' ? 'comp' : 'guard';
        let room = null;
        if (msg.roomId) room = joinRoomById(mode, msg.roomId);
        if (!room) room = anyWaitingRoom(mode);
        if (!room) room = createRoom(mode);

        const name = (msg.name && String(msg.name).slice(0,16)) || '';
        const p = new Player(clientIndex.get(ws).id, name);
        room.addPlayer(p, ws);
        clientIndex.set(ws, { id: p.id, roomId: room.id });

        // Build invite link
        try {
          const origin = new URL((req.headers['origin'] || `http://${req.headers['host']}`));
          const base = `${origin.protocol}//${origin.host}`;
          room.inviteUrl = `${base}/?mode=${room.mode==='comp'?'competitive':'gorilla'}&room=${room.id}`;
        } catch {
          room.inviteUrl = `/?mode=${room.mode==='comp'?'competitive':'gorilla'}&room=${room.id}`;
        }

        // Fill with bots
        if (room.mode==='comp'){
          let total = room.players.size;
          while (total < 2) { addBot(room); total++; }
          for (let i=0;i<2;i++) addBot(room);
        } else {
          if (room.players.size===1 && Math.random()<0.6) addBot(room);
        }

        room.startIfReady();
        ws.send(JSON.stringify({ t:'joined', roomId: room.id, inviteUrl: room.inviteUrl, mode: room.mode }));
        return;
      }

      if (msg.t === 'input') {
        const ci = clientIndex.get(ws); if (!ci) return;
        const room = rooms.get(ci.roomId); if (!room) return;
        const p = room.players.get(ci.id); if (!p) return;
        p.lastInputAt = now();
        p.input = msg; // {up,down,left,right,e,space,q}
        return;
      }
    });

    ws.on('close', () => {
      const ci = clientIndex.get(ws);
      if (!ci) return;
      const { roomId, id } = ci;
      clientIndex.delete(ws);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.removePlayer(id);
      if (room.players.size===0) {
        setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.players.size===0) rooms.delete(roomId);
        }, 1000);
      }
    });
  });

  /** ------------------- Simulation Loop --------------------------------- **/
  const dt = 1000 / TICK_HZ;
  const sendDt = 1000 / SEND_HZ;

  setInterval(() => {
    const t = now();
    for (const room of rooms.values()){
      stepRoom(room, t, dt/1000);
      if (t - room.lastSend >= sendDt) {
        room.lastSend = t;
        broadcastRoom(room);
      }
    }
  }, dt);

  function broadcastRoom(room){
    const payload = {
      t:'state',
      roomId: room.id,
      mode: room.mode,
      state: room.state,
      timeLeft: Math.max(0, Math.ceil((room.endsAt - now())/1000)),
      target: room.targetScore,
      inviteUrl: room.inviteUrl,
      gorilla: { x: room.gorilla.x, y: room.gorilla.y, state: room.gorilla.state, enraged: room.gorilla.enraged },
      bananas: room.bananas.map(b => ({x:b.x,y:b.y,kind:b.kind,value:b.value})),
      crocs: room.crocEvents.map(c => ({x:c.x,y:c.y,until:c.until})),
      minions: room.minions.filter(m=>!m.dead).map(m => ({
        kind: m.kind, x:m.x, y:m.y, stun: m.stunUntil>now(), carry:m.carry
      })),
      players: Array.from(room.players.values()).map(p => ({
        id: p.id, name: p.name, x: p.x, y: p.y, banked: p.banked, carry: p.carry, stun: p.stunUntil>now(), bot: p.isBot
      })),
      bridges: Array.from(room.bridgeUse.entries()).map(([k,v])=>({k,v})),
      centerPile: room.mode==='comp' ? room.centerPile : undefined
    };
    for (const ws of room.sockets.values()){
      if (ws.readyState===1) ws.send(JSON.stringify(payload));
    }
  }

  /** ------------------- Room Step --------------------------------------- **/
  function stepRoom(room, t, dt){
    if (room.state==='running' && t >= room.endsAt) {
      const leader = leaderId(room);
      const tied = isTied(room);
      if (tied) { room.state='overtime'; room.overtimeStart=t; room.overtimeSpawned=false; }
      else room.end(leader);
    } else if (room.state==='overtime'){
      if (!room.overtimeSpawned && (t - room.overtimeStart) > OVERTIME_GRACE*1000){
        room.overtimeSpawned = true;
        const target = (room.mode==='comp' ? COMP_PILE : GORILLA_STASH);
        room.bananas.push(new Banana(target.x, target.y, 100, 'golden'));
      }
    }

    if (room.state==='running'){
      const left = (room.endsAt - t) / 1000;
      room.gorilla.enraged = left <= FEVER_LAST;
    } else room.gorilla.enraged = false;

    if (room.state==='running') {
      if ((t - room.lastWaveAt) > MINION_WAVE_EVERY*1000){ room.lastWaveAt = t; spawnWave(room); }
      if ((t - room.lastCrocAt) > CROCS_EVERY*1000){ room.lastCrocAt = t; triggerCroc(room); }
    }

    for (const p of room.players.values()){
      if (p.isBot) botThink(room, p, dt, t);
      stepPlayer(room, p, dt, t);
    }

    stepGorilla(room, dt, t);
    for (const m of room.minions) stepMinion(room, m, dt, t);
    room.minions = room.minions.filter(m=>!m.dead);

    for (const b of room.bananas){ b.x += b.vx; b.y += b.vy; b.vx *= 0.92; b.vy *= 0.92; b.bounceT += dt; }

    if (room.state==='overtime'){
      const lead = leaderId(room);
      const tied = isTied(room);
      if (!tied && lead) room.end(lead);
    }
  }

  function leaderId(room){
    let lead=null, best=-1;
    for (const p of room.players.values()){ if (p.banked>best){ best=p.banked; lead=p.id; } }
    if (room.state==='running'){ for (const p of room.players.values()){ if (p.banked >= room.targetScore) return p.id; } }
    return lead;
  }
  function isTied(room){ const vals = Array.from(room.players.values()).map(p=>p.banked); return new Set(vals).size<=1; }

  /** ------------------- Entities Step ----------------------------------- **/
  function stepPlayer(room, p, dt, t){
    const inpt = p.input || {};

    if (p.stunUntil > t) { p.vx *= 0.8; p.vy *= 0.8; }
    else {
      const dx = (inpt.right?1:0) - (inpt.left?1:0);
      const dy = (inpt.down?1:0) - (inpt.up?1:0);
      let spd = PLAYER_SPEED * (1 / (1 + p.carry*CARRY_SLOW_PER));
      const tile = tileAt(...Object.values(pxToGrid(p)));
      if (isMud(tile))   spd *= MUD_FACTOR;
      if (isVine(tile))  spd *= VINE_FACTOR;
      if (isWater(tile)) spd *= WATER_FACTOR;

      if (inpt.space && (t - p.lastTackle) > TACKLE_CD*1000){
        p.lastTackle = t;
        const mag = Math.max(0.0001, Math.hypot(dx,dy));
        const ddx = mag>0 ? dx/mag : 0;
        const ddy = mag>0 ? dy/mag : -1;
        p.vx += ddx*TACKLE_SPEED; p.vy += ddy*TACKLE_SPEED;
        tackleHit(room, p);
      } else {
        p.vx += dx * spd * 0.4; p.vy += dy * spd * 0.4;
      }
    }

    p.vx *= 0.86; p.vy *= 0.86;
    const nx = p.x + p.vx, ny = p.y + p.vy;

    const gNext = pxToGrid({x:nx,y:ny});
    const tNext = tileAt(gNext.x, gNext.y);
    if (isSolid(tNext) || (isWater(tNext) && !isBridge(tNext) && !isVine(tNext))) {
      p.vx *= 0.2; p.vy *= 0.2;
    } else {
      p.x = nx; p.y = ny;
      if (isBridge(tNext)){
        const key = `${gNext.x},${gNext.y}`;
        const n = (room.bridgeUse.get(key) || 0) + 1;
        room.bridgeUse.set(key, n);
        if (n >= BRIDGE_MAX) room.bridgeUse.set(key, BRIDGE_MAX+1); // collapsed
      }
    }

    const bk = `${gNext.x},${gNext.y}`;
    if ((room.bridgeUse.get(bk)||0) >= BRIDGE_MAX+1) { p.x -= p.vx*2; p.y -= p.vy*2; p.vx=0; p.vy=0; }

    for (const c of room.crocEvents){
      if (t < c.until){
        if (Math.hypot(p.x - c.x, p.y - c.y) < TILE) {
          if (p.invulnUntil < t){
            dropBananas(room, p, Math.max(1, Math.ceil(p.carry/2)));
            p.stunUntil = t + 300; p.invulnUntil = t + 800;
          }
        }
      }
    }

    const nearBank = Math.hypot(p.x - PLAYER_BANK.x, p.y - PLAYER_BANK.y) < TILE*1.4;
    const nearStash= Math.hypot(p.x - GORILLA_STASH.x, p.y - GORILLA_STASH.y) < TILE*1.4;
    const nearPile = Math.hypot(p.x - COMP_PILE.x, p.y - COMP_PILE.y) < TILE*1.4;

    if (inpt.e) {
      if (!p.holdingE) { p.holdingE = true; p.holdStart = t; }
      const held = (t - p.holdStart)/600;
      if (held >= 1) {
        p.holdStart = t;
        if (room.mode==='guard') {
          if (nearStash) {
            const val = (room.endsAt - t <= FEVER_LAST*1000) ? 2 : 1;
            p.carry += val;
          } else if (nearBank && p.carry>0) { p.banked += p.carry; p.carry = 0; }
        } else {
          if (nearPile && room.centerPile>0){ const take = Math.min(2, room.centerPile); room.centerPile -= take; p.carry += take; }
          else if (nearBank && p.carry>0){ p.banked += p.carry; p.carry = 0; }
        }
      }
    } else p.holdingE = false;

    if (inpt.q && !p.qDownPrev){
      const aimx = p.vx, aimy = p.vy;
      const mag = Math.max(0.001, Math.hypot(aimx, aimy));
      const dirx = mag>0.001 ? aimx/mag : 0;
      const diry = mag>0.001 ? aimy/mag : -1;
      const bx = p.x + dirx * TILE*2;
      const by = p.y + diry * TILE*2;
      room.bananas.push(new Banana(bx,by, 0, 'bait'));
      room.gorilla.baitTarget = {x:bx, y:by, until: t + BAIT_TIME*1000};
    }
    p.qDownPrev = !!inpt.q;

    if (room.state==='running' && p.banked >= room.targetScore) room.end(p.id);
  }

  function tackleHit(room, p){
    const t = now();
    for (const m of room.minions){
      if (m.dead) continue;
      if (Math.hypot(m.x - p.x, m.y - p.y) < TILE*1.1){
        m.stunUntil = t + TACKLE_STUN*1000;
        if (m.carry>0){ for (let i=0;i<m.carry;i++) room.bananas.push(new Banana(m.x, m.y, 1)); m.carry=0; }
      }
    }
    if (room.mode==='comp'){
      for (const o of room.players.values()){
        if (o.id===p.id) continue;
        if (Math.hypot(o.x - p.x, o.y - p.y) < TILE*1.1){
          o.stunUntil = t + TACKLE_STUN*1000;
          if (o.carry>0){ dropBananas(room, o, o.carry); o.carry=0; }
        }
      }
    }
  }

  function dropBananas(room, entity, count){ for (let i=0;i<count;i++) room.bananas.push(new Banana(entity.x+(Math.random()*6-3), entity.y+(Math.random()*6-3), 1)); }

  function stepGorilla(room, dt, t){
    const g = room.gorilla;
    const spd = (GORILLA_BASE_SPEED * (g.enraged?GORILLA_ENRAGE:1));

    let target = null;
    if (g.baitTarget && t < g.baitTarget.until) target = {x:g.baitTarget.x, y:g.baitTarget.y};
    else {
      g.baitTarget = null;
      let best = Infinity, bestP = null;
      for (const p of room.players.values()){
        const dStash = Math.hypot(p.x - GORILLA_STASH.x, p.y - GORILLA_STASH.y);
        const d = Math.hypot(p.x - g.x, p.y - g.y);
        if (dStash < TILE*8 && d < best){ best=d; bestP=p; }
      }
      target = bestP ? {x: bestP.x, y: bestP.y}
                     : {x: GORILLA_STASH.x + Math.sin(t*0.001)*24, y: GORILLA_STASH.y + Math.cos(t*0.001)*24};
    }

    const path = bfsPath({x:g.x,y:g.y}, target, (tch)=> !isSolid(tch) && !isWater(tch));
    const goal = path[0] || target;
    const dx = goal.x - g.x, dy = goal.y - g.y;
    const mag = Math.max(0.0001, Math.hypot(dx,dy));
    g.x += (dx/mag) * spd; g.y += (dy/mag) * spd;

    if (g.enraged && Math.random()<0.005){ g.state='roar'; g.stateUntil = t + 600; }
    if (g.state==='roar' && t>g.stateUntil) g.state='patrol';

    for (const p of room.players.values()){
      if (Math.hypot(p.x-g.x,p.y-g.y) < TILE*0.9 && p.invulnUntil < t){
        const bx = PLAYER_BANK.x - p.x, by = PLAYER_BANK.y - p.y;
        const m = Math.max(0.001, Math.hypot(bx,by));
        p.vx = (bx/m)*4.8; p.vy=(by/m)*4.8;
        p.stunUntil = t + 500; p.invulnUntil = t + 800;
        if (p.carry>0) { dropBananas(room, p, p.carry); p.carry=0; }
      }
    }
  }

  function stepMinion(room, m, dt, t){
    if (m.stunUntil > t) return;
    if (!m.target || Math.random()<0.02){
      if (m.kind==='baby'){
        let best=Infinity, trg=null;
        for (const p of room.players.values()){ const d = Math.hypot(p.x-m.x,p.y-m.y); if (d<best){best=d; trg=p;} }
        m.target = trg ? {x: trg.x, y: trg.y} : GORILLA_STASH;
      } else {
        if (m.carry>0) m.target = {x: GORILLA_STASH.x, y: GORILLA_STASH.y};
        else m.target = {x: PLAYER_BANK.x, y: PLAYER_BANK.y};
      }
    }

    const path = bfsPath({x:m.x,y:m.y}, m.target, (tch)=> !isSolid(tch) && !isWater(tch));
    const goal = path[0] || m.target;
    const dx = goal.x - m.x, dy = goal.y - m.y;
    const mag = Math.max(0.001, Math.hypot(dx,dy));
    const spd = (m.kind==='baby'?1.4:2.2);
    m.x += (dx/mag)*spd; m.y += (dy/mag)*spd;

    if (m.kind==='baby'){
      for (const p of room.players.values()){
        if (Math.hypot(p.x - m.x, p.y - m.y) < TILE*0.9){
          p.stunUntil = t + TACKLE_STUN*1000;
          if (p.carry>0){ dropBananas(room, p, Math.ceil(p.carry/2)); p.carry=0; }
        }
      }
    }
    if (m.kind==='thief'){
      if (Math.hypot(m.x - PLAYER_BANK.x, m.y - PLAYER_BANK.y) < TILE){
        const victim = leaderObject(room);
        if (victim && victim.banked>0){ const s = Math.min(3, victim.banked); victim.banked -= s; m.carry += s; }
      }
      if (Math.hypot(m.x - GORILLA_STASH.x, m.y - GORILLA_STASH.y) < TILE && m.carry>0){ m.dead = true; }
    }
  }

  function leaderObject(room){ let best=-1, obj=null; for (const p of room.players.values()){ if (p.banked>best){best=p.banked; obj=p;} } return obj; }

  function spawnWave(room){
    const spots = [ gridToPx({x: 6, y: 2}), gridToPx({x: MAP_W-7, y: 2}), gridToPx({x: 6, y: 9}), gridToPx({x: MAP_W-7, y: 9}), ];
    const s1 = spots[Math.floor(Math.random()*spots.length)];
    const s2 = spots[Math.floor(Math.random()*spots.length)];
    room.minions.push(new Minion('baby', s1.x, s1.y));
    room.minions.push(new Minion('thief', s2.x, s2.y));
  }

  function triggerCroc(room){
    const candidates = [];
    for (let y=0;y<MAP_H;y++){
      for (let x=0;x<MAP_W;x++){
        const t = tileAt(x,y);
        if (!isWater(t)) continue;
        const nb = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx,dy] of nb){
          const t2 = tileAt(x+dx,y+dy);
          if (isGround(t2) || isVine(t2) || isBridge(t2)){
            candidates.push({x,y, dx,dy});
          }
        }
      }
    }
    if (!candidates.length) return;
    const c = candidates[Math.floor(Math.random()*candidates.length)];
    const px = (c.x + 0.5 + c.dx*0.6)*TILE;
    const py = (c.y + 0.5 + c.dy*0.6)*TILE;
    room.crocEvents.push({x:px, y:py, until: now() + CROCS_LUNGE_TIME*1000});
    room.crocEvents = room.crocEvents.filter(e => e.until > now());
  }

  /** ------------------- Bots -------------------------------------------- **/
  function botThink(room, p, dt, t){
    if (!p.botState) p.botState = { want:'collect' };
    const nearBank = Math.hypot(p.x - PLAYER_BANK.x, p.y - PLAYER_BANK.y) < TILE*1.4;
    if (room.mode==='guard'){
      if (p.carry >= 6) p.botState.want = 'bank';
      if (p.carry===0) p.botState.want = 'collect';
      const dir = dirTo(p, (p.botState.want==='collect'?GORILLA_STASH:PLAYER_BANK));
      p.input = { up:false,down:false,left:false,right:false };
      p.input[dir] = true;
      p.input.e = ((p.botState.want==='collect' && Math.hypot(p.x - GORILLA_STASH.x, p.y - GORILLA_STASH.y) < TILE*1.4) || (p.botState.want==='bank' && nearBank));
      p.input.q = Math.random()<0.01;
      p.input.space = Math.random()<0.02;
    } else {
      if (p.carry >= 6) p.botState.want = 'bank';
      if (p.carry===0) p.botState.want = 'collect';
      const target = (p.botState.want==='collect' ? COMP_PILE : PLAYER_BANK);
      const dir = dirTo(p, target);
      p.input = { up:false,down:false,left:false,right:false };
      p.input[dir] = true;
      p.input.e = ((p.botState.want==='collect' && Math.hypot(p.x - COMP_PILE.x, p.y - COMP_PILE.y) < TILE*1.4) || (p.botState.want==='bank' && nearBank));
      p.input.q = Math.random()<0.01;
      p.input.space = Math.random()<0.02;
    }
  }

  function dirTo(p, t){ const dx=t.x-p.x, dy=t.y-p.y; return (Math.abs(dx)>Math.abs(dy)) ? (dx>0?'right':'left') : (dy>0?'down':'up'); }

  return {};
}

module.exports = createGameServer;
