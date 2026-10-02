'use strict';
/* ============================================================
   CEM DJ móvil: consola de 2 decks para celular y tablet (con los colores del CEM).
   Arriba las ondas de los dos decks, después los decks A y B, el mezclador (EQ, volúmenes, vúmetros,
   crossfader, automix) y al final la biblioteca con las listas.
   Canciones y listas guardadas en el propio equipo (IndexedDB), nivelación de volumen (LUFS),
   BPM + SYNC, "sin voz" rápido.
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmt = (s) => { if (!isFinite(s) || s == null) return '–:––'; s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
  play: svg('M8 5v14l11-7z'),
  pause: svg('M6 5h4v14H6zM14 5h4v14h-4z'),
  plus: svg('M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z'),
  more: svg('M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'),
  moon: svg('M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z'),
  sun: svg('M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z'),
  settings: svg('M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z'),
};

/* ---------------- Base de datos local (canciones) ---------------- */
const DB = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open('cem-dj-movil', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('songs', mode);
      const rq = fn(t.objectStore('songs'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return { all: () => tx('readonly', (s) => s.getAll()), put: (o) => tx('readwrite', (s) => s.put(o)), del: (id) => tx('readwrite', (s) => s.delete(id)) };
})();

/* ---------------- Etiquetas: título, artista y carátula del archivo ----------------
   MP3 (ID3v2.2 / 2.3 / 2.4), M4A/AAC/ALAC (MP4), FLAC y OGG/Opus. */
const td = (label, b) => { try { return new TextDecoder(label).decode(b); } catch { return ''; } };
const imgType = (mime, data) => (/^image\/(png|jpe?g|webp|gif)$/i.test(mime) ? mime.toLowerCase().replace('jpg', 'jpeg') : data[0] === 0x89 ? 'image/png' : 'image/jpeg');
async function readTags(blob) {
  try {
    const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const s4 = (o) => String.fromCharCode(h[o], h[o + 1], h[o + 2], h[o + 3]);
    if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return await readId3(blob, h);
    if (s4(4) === 'ftyp') return await readMp4(blob);
    if (s4(0) === 'fLaC') return await readFlac(blob);
    if (s4(0) === 'OggS') return await readOgg(blob);
  } catch {}
  return {};
}

// ---- MP3: ID3v2 ----
const unsync = (b) => { const o = []; for (let i = 0; i < b.length; i++) { o.push(b[i]); if (b[i] === 0xff && b[i + 1] === 0x00) i++; } return new Uint8Array(o); };
async function readId3(blob, head) {
  const out = {}, ver = head[3], flags = head[5];
  const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
  let buf = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 16 * 1024 * 1024)).arrayBuffer());
  if (ver < 4 && flags & 0x80) buf = unsync(buf); // desincronización de todo el tag (v2.2 / v2.3)
  const sync = (o) => (buf[o] << 21) | (buf[o + 1] << 14) | (buf[o + 2] << 7) | buf[o + 3];
  const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  const idLen = ver === 2 ? 3 : 4, hdLen = ver === 2 ? 6 : 10;
  let p = 0;
  if (ver > 2 && flags & 0x40) p += ver === 4 ? sync(0) : u32(0) + 4;
  while (p + hdLen <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id) || id.length !== idLen) break;
    const fs = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5] : ver === 4 ? sync(p + 4) : u32(p + 4);
    const ff = ver === 2 ? 0 : (buf[p + 8] << 8) | buf[p + 9];
    if (fs <= 0 || p + hdLen + fs > buf.length) break;
    let body = buf.subarray(p + hdLen, p + hdLen + fs);
    p += hdLen + fs;
    if (ver === 4) { if (ff & 0x0001) body = body.subarray(4); if (ff & 0x0002) body = unsync(body); }
    if (ver === 3 && ff & 0x0080) continue; // comprimido (raro): se ignora
    if (id === 'TIT2' || id === 'TT2') out.title = out.title || id3Text(body);
    else if (id === 'TPE1' || id === 'TP1') out.artist = out.artist || id3Text(body);
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) out.cover = id3Pic(body, id === 'PIC');
  }
  return out;
}
function id3Text(b) {
  const label = ['windows-1252', 'utf-16', 'utf-16be', 'utf-8'][b[0]] || 'utf-8';
  return td(label, b.subarray(1)).replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
}
function id3Pic(b, v22) {
  const enc = b[0];
  let i = 1, mime;
  if (v22) { mime = 'image/' + String.fromCharCode(b[1], b[2], b[3]).toLowerCase(); i = 4; } // PIC: formato de 3 letras
  else { while (i < b.length && b[i] !== 0) i++; mime = String.fromCharCode(...b.subarray(1, i)); i++; }
  i++; // tipo de imagen
  if (enc === 0 || enc === 3) { while (i < b.length && b[i] !== 0) i++; i++; }
  else { while (i + 1 < b.length && !(b[i] === 0 && b[i + 1] === 0)) i += 2; i += 2; }
  const data = b.subarray(i);
  if (data.length < 100) return null;
  return new Blob([data], { type: imgType(mime, data) });
}

// ---- M4A / MP4: moov > udta > meta > ilst ----
async function readMp4(blob) {
  const out = {};
  const hdr = async (pos) => {
    const b = new Uint8Array(await blob.slice(pos, pos + 16).arrayBuffer());
    if (b.length < 8) return null;
    let size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, hl = 8;
    const type = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (size === 1) { size = Number(new DataView(b.buffer).getBigUint64(8)); hl = 16; } else if (size === 0) size = blob.size - pos;
    return { type, size, hl };
  };
  let pos = 0, moov = null;
  while (pos + 8 <= blob.size) { const a = await hdr(pos); if (!a || a.size < 8) break; if (a.type === 'moov') { moov = a; break; } pos += a.size; }
  if (!moov || moov.size > 64 * 1024 * 1024) return out;
  const m = new Uint8Array(await blob.slice(pos + moov.hl, pos + moov.size).arrayBuffer());
  const dv = new DataView(m.buffer);
  const kids = (s, e) => { const r = []; while (s + 8 <= e) { const sz = dv.getUint32(s); const t = String.fromCharCode(m[s + 4], m[s + 5], m[s + 6], m[s + 7]); if (sz < 8 || s + sz > e) break; r.push({ t, s, e: s + sz }); s += sz; } return r; };
  const find = (list, t) => list.find((x) => x.t === t);
  const udta = find(kids(0, m.length), 'udta'); if (!udta) return out;
  const meta = find(kids(udta.s + 8, udta.e), 'meta'); if (!meta) return out;
  const ilst = find(kids(meta.s + 12, meta.e), 'ilst'); if (!ilst) return out;
  for (const it of kids(ilst.s + 8, ilst.e)) {
    const data = find(kids(it.s + 8, it.e), 'data'); if (!data) continue;
    const kind = dv.getUint32(data.s + 8) & 0xffffff, val = m.subarray(data.s + 16, data.e);
    if (it.t === '©nam') out.title = td('utf-8', val).trim();
    else if (it.t === '©ART') out.artist = td('utf-8', val).trim();
    else if (it.t === 'covr' && !out.cover && val.length > 100) out.cover = new Blob([val.slice()], { type: kind === 14 ? 'image/png' : imgType('', val) });
  }
  return out;
}

// ---- FLAC: bloques VORBIS_COMMENT y PICTURE ----
function vorbisComments(b, out) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 0; const vl = dv.getUint32(p, true); p += 4 + vl;
  const n = dv.getUint32(p, true); p += 4;
  for (let k = 0; k < n && p + 4 <= b.length; k++) {
    const l = dv.getUint32(p, true); p += 4;
    const c = td('utf-8', b.subarray(p, p + l)); p += l;
    const eq = c.indexOf('='); if (eq < 0) continue;
    const key = c.slice(0, eq).toUpperCase(), val = c.slice(eq + 1);
    if (key === 'TITLE' && !out.title) out.title = val.trim();
    else if (key === 'ARTIST' && !out.artist) out.artist = val.trim();
    else if (key === 'METADATA_BLOCK_PICTURE' && !out.cover) { try { out.cover = flacPic(Uint8Array.from(atob(val.trim()), (ch) => ch.charCodeAt(0))); } catch {} }
  }
}
function flacPic(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 4; const ml = dv.getUint32(p); p += 4;
  const mime = String.fromCharCode(...b.subarray(p, p + ml)); p += ml;
  const dl = dv.getUint32(p); p += 4 + dl + 16;
  const len = dv.getUint32(p); p += 4;
  const data = b.subarray(p, p + len);
  return data.length > 100 ? new Blob([data.slice()], { type: imgType(mime, data) }) : null;
}
async function readFlac(blob) {
  const out = {};
  let pos = 4;
  for (let n = 0; n < 64 && pos + 4 <= blob.size; n++) {
    const h = new Uint8Array(await blob.slice(pos, pos + 4).arrayBuffer());
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || (type === 6 && !out.cover)) {
      const b = new Uint8Array(await blob.slice(pos + 4, pos + 4 + len).arrayBuffer());
      if (type === 4) vorbisComments(b, out); else out.cover = flacPic(b);
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

// ---- OGG / Opus: se juntan las primeras páginas y se leen los comentarios ----
async function readOgg(blob) {
  const out = {};
  const b = new Uint8Array(await blob.slice(0, Math.min(blob.size, 12 * 1024 * 1024)).arrayBuffer());
  const parts = []; let p = 0, tot = 0;
  while (p + 27 <= b.length && b[p] === 0x4f && b[p + 1] === 0x67 && b[p + 2] === 0x67 && b[p + 3] === 0x53) {
    const segs = b[p + 26]; let len = 0;
    for (let i = 0; i < segs; i++) len += b[p + 27 + i];
    const s = p + 27 + segs; parts.push(b.subarray(s, s + len)); tot += len; p = s + len;
    if (parts.length > 400) break;
  }
  const all = new Uint8Array(tot); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
  // el paquete de comentarios empieza con "\x03vorbis" (Vorbis) u "OpusTags" (Opus)
  const find = (sig) => { outer: for (let i = 0; i + sig.length < all.length; i++) { for (let j = 0; j < sig.length; j++) if (all[i + j] !== sig.charCodeAt(j)) continue outer; return i + sig.length; } return -1; };
  let start = find('OpusTags'); if (start < 0) start = find('\x03vorbis');
  if (start >= 0) { try { vorbisComments(all.subarray(start), out); } catch {} }
  return out;
}

/* ---------------- Ajustes ---------------- */
const S = Object.assign({ mixSecs: 8, level: true, automix: true, master: 90 }, store.get('cem.dj', {}));
const saveS = () => store.set('cem.dj', S);

/* ---------------- Audio: grafo general ---------------- */
let AC = null, master, limiter;
function ensureAudio() {
  if (AC) return AC;
  AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  master = AC.createGain(); master.gain.value = S.master / 100;
  limiter = AC.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1;
  master.connect(limiter).connect(AC.destination);
  decks.forEach((d) => d.build());
  applyXf();
  return AC;
}

// "Sin voz" rápido: se cancela lo que está al centro (voz) y se conservan los graves
function karaokeChain(c, input, sum) {
  const dry = c.createGain(); input.connect(dry).connect(sum);
  const wet = c.createGain(); wet.gain.value = 0;
  const split = c.createChannelSplitter(2); input.connect(split);
  const sL = c.createGain(); sL.gain.value = 0.7; const sR = c.createGain(); sR.gain.value = -0.7;
  split.connect(sL, 0); split.connect(sR, 1);
  const side = c.createGain(); sL.connect(side); sR.connect(side);
  const mL = c.createGain(); mL.gain.value = 0.5; const mR = c.createGain(); mR.gain.value = 0.5;
  split.connect(mL, 0); split.connect(mR, 1);
  const mid = c.createGain(); mL.connect(mid); mR.connect(mid);
  const b1 = c.createBiquadFilter(); b1.type = 'lowpass'; b1.frequency.value = 110; b1.Q.value = 0.707;
  const b2 = c.createBiquadFilter(); b2.type = 'lowpass'; b2.frequency.value = 110; b2.Q.value = 0.707;
  mid.connect(b1).connect(b2);
  const mono = c.createGain(); mono.channelCount = 2; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
  side.connect(mono); b2.connect(mono);
  mono.connect(wet).connect(sum);
  return { dry, wet };
}

/* ---------------- Biblioteca (estado) ---------------- */
const songs = new Map();                 // id -> canción
let lists = store.get('cem.lists', []);  // [{id,name,ids:[]}]
let view = 'all';                        // 'all' o id de lista
const saveLists = () => store.set('cem.lists', lists);
const arts = new Map();                  // id -> url de carátula
const artUrl = (s) => { if (!s || !s.cover) return 'logo.jpg'; if (!arts.has(s.id)) arts.set(s.id, URL.createObjectURL(s.cover)); return arts.get(s.id); };

/* ---------------- Barritas del mezclador ---------------- */
// Doble toque (o doble clic) sobre una barrita la vuelve a su valor normal
function bindSlider(el, reset, apply) {
  let last = 0;
  el.addEventListener('input', () => apply(+el.value));
  const back = () => { el.value = reset; apply(reset); };
  el.addEventListener('dblclick', back);
  el.addEventListener('pointerup', () => { const now = performance.now(); if (now - last < 320) { back(); last = 0; } else last = now; });
}

/* ---------------- Deck ---------------- */
const PITCH = 12;          // rango del tempo: ±12 %
const JOG_SECS = 1.8;      // segundos que avanza una vuelta del disco
class Deck {
  constructor(k, idx) {
    this.k = k; this.idx = idx; this.el = $('#deck' + k);
    this.audio = new Audio(); this.audio.preload = 'auto';
    try { this.audio.preservesPitch = true; this.audio.webkitPreservesPitch = true; } catch {}
    this.song = null; this.url = null; this.queue = null; this.qi = -1;
    this.cue = 0; this.pitch = 0; this.synced = false; this.noVoice = false; this.prepared = false;
    this.eq = { high: 0, mid: 0, low: 0 }; this.vol = 1; this.vu = 0;
    this.el.innerHTML = `
      <div class="d-head"><span class="tag">${k}</span><span class="onair"></span><span class="d-rem">–:––</span></div>
      <div class="d-mid">
        <div class="disc" aria-label="Disco del deck ${k}: gíralo para mover la canción"><div class="disc-rot"><div class="disc-art"></div><i class="disc-dot"></i></div></div>
        <div class="d-bpm"><b class="bpm">–––</b><small>BPM</small><span class="pct">0,0 %</span></div>
      </div>
      <div class="d-title">Elige una canción</div>
      <div class="d-artist"></div>
      <div class="d-time"><span class="el">0:00</span><span class="du">–:––</span></div>
      <div class="d-btns">
        <button class="pill cue" aria-label="Punto de inicio (CUE) del deck ${k}">CUE</button>
        <button class="pill on play" aria-label="Reproducir o pausar el deck ${k}">${ICON.play}</button>
        <button class="pill sync" aria-label="Igualar el tempo del deck ${k} con el otro deck">SYNC</button>
      </div>`;
    const q = (s) => this.el.querySelector(s);
    this.ui = { rem: q('.d-rem'), onair: q('.onair'), disc: q('.disc'), rot: q('.disc-rot'), art: q('.disc-art'), bpm: q('.bpm'), pct: q('.pct'), title: q('.d-title'), artist: q('.d-artist'), el: q('.el'), du: q('.du'), cue: q('.cue'), play: q('.play'), sync: q('.sync') };
    this.ui.art.style.backgroundImage = 'url(logo.jpg)';
    this.ui.play.onclick = () => this.toggle();
    this.ui.cue.onclick = () => this.cuePress();
    this.ui.sync.onclick = () => this.sync();
    this.bindJog();
    this.audio.addEventListener('play', () => this.onState());
    this.audio.addEventListener('pause', () => this.onState());
    this.audio.addEventListener('ended', () => onDeckEnded(this));
    this.audio.addEventListener('loadedmetadata', () => { if (this.song && !this.song.dur) this.song.dur = this.audio.duration; });
    this.audio.addEventListener('error', () => { if (this.song) toast('No se pudo reproducir «' + this.song.title + '». Prueba con otro formato (MP3 o M4A).', 4500); });
  }

  build() {
    if (this.built) return; this.built = true;
    const c = AC;
    this.srcNode = c.createMediaElementSource(this.audio);
    this.norm = c.createGain();
    const sum = c.createGain();
    this.srcNode.connect(this.norm);
    this.kar = karaokeChain(c, this.norm, sum);
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 250;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 1;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.fader = c.createGain();
    this.xf = c.createGain();
    this.an = c.createAnalyser(); this.an.fftSize = 1024; this.anBuf = new Float32Array(this.an.fftSize);
    sum.connect(this.low).connect(this.mid).connect(this.high).connect(this.fader).connect(this.xf).connect(master);
    this.fader.connect(this.an);
    this.applyEq(); this.applyVol(); this.setNoVoice(this.noVoice, true); this.applyNorm();
  }
  // Ecualización automática: la que calculó el análisis de la canción (0 si no hace falta corregir nada)
  eqBase(b) { return this.song && this.song.eqAuto ? this.song.eqAuto[b] || 0 : 0; }
  applyEq() {
    if (!this.built) return;
    const t = AC.currentTime;
    for (const b of ['low', 'mid', 'high']) { const g = this[b].gain; g.cancelScheduledValues(t); g.setTargetAtTime(this.eqBase(b), t, 0.05); }
  }
  applyVol() { if (this.built) this.fader.gain.setTargetAtTime(this.vol * this.vol, AC.currentTime, 0.02); }
  applyNorm() {
    if (!this.built) return;
    const s = this.song; let g = 1;
    if (s && S.level && s.lufs != null) {
      let db = Math.max(-12, Math.min(9, -14 - s.lufs));
      if (s.peak > 0) db = Math.min(db, -20 * Math.log10(s.peak) - 0.5); // que no se pase de 0 dB
      g = Math.pow(10, db / 20);
    }
    this.norm.gain.setTargetAtTime(g, AC.currentTime, 0.05);
  }
  setNoVoice(on, silent) {
    this.noVoice = on;
    $$(`.voz[data-d="${this.idx}"]`).forEach((b) => b.classList.toggle('on', on));
    if (this.kar) {
      const t = AC.currentTime;
      this.kar.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.04);
      this.kar.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.04);
    }
    if (on && !silent) toast('«Sin voz» rápido: quita lo que está al centro. Funciona mejor en unas canciones que en otras.', 3500);
  }

  load(song, queue = null, qi = -1, manual = false) {
    ensureAudio();
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio.pause();
    this.song = song; this.queue = queue; this.qi = qi; this.cue = 0; this.prepared = manual;
    this.url = URL.createObjectURL(song.blob);
    this.audio.src = this.url; this.audio.load();
    this.synced = false; this.setPitch(0);
    this.ui.art.style.backgroundImage = `url(${artUrl(song)})`;
    this.ui.title.textContent = song.title;
    this.ui.artist.textContent = song.artist || '';
    this.ui.cue.classList.remove('armed');
    this.applyNorm(); if (!mix) this.applyEq();
    this.onState();
    if (needsAnalysis(song)) analyzeSoon(song, true);
    renderLib();
  }
  unload() {
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.song = null; this.url = null; this.queue = null; this.prepared = false;
    this.ui.art.style.backgroundImage = 'url(logo.jpg)';
    this.ui.title.textContent = 'Elige una canción'; this.ui.artist.textContent = '';
    this.setPitch(0); this.onState();
  }

  async play() {
    if (!this.song) return toast('Elige una canción para el deck ' + this.k + ' en la biblioteca.');
    ensureAudio();
    if (AC.state !== 'running') { try { await AC.resume(); } catch {} }
    this.prepared = false;
    try { await this.audio.play(); } catch {}
  }
  pause() { this.audio.pause(); }
  toggle() { if (this.audio.paused) this.play(); else this.pause(); }

  // CUE: en pausa marca el punto de inicio; sonando vuelve a ese punto y se detiene
  cuePress() {
    if (!this.song) return;
    if (!this.audio.paused) { this.pause(); this.audio.currentTime = this.cue; }
    else if (Math.abs(this.audio.currentTime - this.cue) > 0.05) { this.cue = this.audio.currentTime; this.ui.cue.classList.toggle('armed', this.cue > 0.05); toast('Punto de inicio marcado en ' + fmt(this.cue) + ' (deck ' + this.k + ')', 1800); }
    else this.audio.currentTime = this.cue;
  }

  setPitch(p) {
    this.pitch = clamp(Math.round(p * 10) / 10, -PITCH, PITCH);
    this.audio.playbackRate = 1 + this.pitch / 100;
    this.ui.sync.classList.toggle('on', this.synced);
    this.showBpm();
  }
  bpmNow() { return this.song && this.song.bpm ? this.song.bpm * this.audio.playbackRate : 0; }
  showBpm() {
    const s = this.song;
    this.ui.bpm.textContent = s && s.bpm ? this.bpmNow().toFixed(1).replace('.', ',') : s && needsAnalysis(s) ? '…' : '–––';
    this.ui.pct.textContent = (this.pitch > 0 ? '+' : '') + this.pitch.toFixed(1).replace('.', ',') + ' %';
  }

  // SYNC: iguala el tempo con el otro deck y, si este deck no se está escuchando, también alinea los golpes
  sync() {
    const o = decks[1 - this.idx];
    if (this.synced) { this.synced = false; this.setPitch(0); return; }
    if (!this.song || !o.song) return toast('Carga una canción en cada deck para sincronizar.');
    if (!this.song.bpm || !o.song.bpm) return toast('Todavía se está midiendo el BPM. Prueba en unos segundos.');
    const target = o.bpmNow(), base = target / this.song.bpm;
    const r = [base, base / 2, base * 2].sort((a, b) => Math.abs(Math.log(a)) - Math.abs(Math.log(b)))[0];
    if (Math.abs(r - 1) * 100 > PITCH) return toast('Los tempos son muy distintos para sincronizar (más de ' + PITCH + ' %).');
    this.synced = true; this.setPitch((r - 1) * 100);
    if (gainOf(this) < 0.2) alignBeats(this, o);
  }

  bindJog() {
    const d = this.ui.disc; let a0 = 0;
    const ang = (e) => { const r = d.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
    d.addEventListener('pointerdown', (e) => { if (!this.song) return; d.setPointerCapture(e.pointerId); a0 = ang(e); e.preventDefault(); });
    d.addEventListener('pointermove', (e) => {
      if (!d.hasPointerCapture(e.pointerId)) return;
      const a = ang(e); let da = a - a0; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; a0 = a;
      const dur = this.audio.duration || 0;
      if (dur) this.audio.currentTime = clamp(this.audio.currentTime + (da / (2 * Math.PI)) * JOG_SECS, 0, dur - 0.05);
    });
  }
  onState() {
    const playing = !!this.song && !this.audio.paused;
    this.el.classList.toggle('playing', playing);
    this.ui.play.innerHTML = playing ? ICON.pause : ICON.play;
    this.ui.cue.disabled = this.ui.sync.disabled = !this.song;
    this.showBpm();
    if (playing) setMediaSession();
    updateWakeLock();
    renderMarks();
  }

  tick() {
    const a = this.audio, d = a.duration, t = a.currentTime;
    const has = !!this.song;
    this.ui.el.textContent = has ? fmt(t) : '0:00';
    this.ui.du.textContent = has ? fmt(d || this.song.dur) : '–:––';
    const rem = d && isFinite(d) ? (d - t) / a.playbackRate : null;
    this.ui.rem.textContent = has && rem != null ? '−' + fmt(rem) : '–:––';
    this.el.classList.toggle('ending', has && !a.paused && rem != null && rem < 20);
    this.ui.rot.style.transform = `rotate(${(t * 200) % 360}deg)`;
    const live = has && !a.paused && gainOf(this) > 0.1;
    this.el.classList.toggle('live', live);
    this.ui.onair.textContent = !has ? '' : live ? 'Sonando' : a.ended ? 'Terminado' : a.paused ? 'Preparado' : 'Sonando bajo';
    // vúmetro
    let lvl = 0;
    if (this.an && !a.paused) {
      this.an.getFloatTimeDomainData(this.anBuf);
      let pk = 0; for (let i = 0; i < this.anBuf.length; i++) { const v = Math.abs(this.anBuf[i]); if (v > pk) pk = v; }
      lvl = pk > 0 ? clamp(1 + (20 * Math.log10(pk)) / 48, 0, 1) : 0;
    }
    this.vu = Math.max(lvl, this.vu - 0.025);
    const vu = $('#vu' + this.idx + ' i'); if (vu) vu.style.width = (1 - this.vu) * 100 + '%';
  }
}

const decks = [new Deck('A', 0), new Deck('B', 1)];
const deckLive = () => decks[xf < 0.5 ? 0 : 1];

/* ---------------- Mezclador ---------------- */
let xf = 0, mix = null, mixTimer = 0;
const gainsFor = (x) => [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
function gainOf(d) { return gainsFor(xf)[d.idx] * (d.vol > 0 ? 1 : 0); }
function applyXf() {
  $('#xfade').value = Math.round(xf * 1000);
  $('#mixBtn').textContent = xf < 0.5 ? 'Mezclar A → B' : 'Mezclar B → A';
  if (!AC) return;
  const g = gainsFor(xf), t = AC.currentTime;
  decks.forEach((d, i) => { if (d.xf) { d.xf.gain.cancelScheduledValues(t); d.xf.gain.setValueAtTime(g[i], t); } });
}
// Pasa el crossfader de un lado al otro en `secs` segundos; la curva queda programada en el audio,
// así sigue funcionando aunque la pantalla esté apagada.
function mixTo(to, secs, from) {
  ensureAudio(); cancelMix();
  if (!(secs > 0.05)) { xf = to; applyXf(); if (from) from.pause(); renderMarks(); return; }
  const x0 = xf, N = 64, t0 = AC.currentTime;
  const ga = new Float32Array(N), gb = new Float32Array(N);
  for (let k = 0; k < N; k++) { const g = gainsFor(x0 + ((to - x0) * k) / (N - 1)); ga[k] = g[0]; gb[k] = g[1]; }
  [ga, gb].forEach((curve, i) => { const p = decks[i].xf.gain; p.cancelScheduledValues(t0); p.setValueCurveAtTime(curve, t0, secs); });
  // Cambio de graves: mientras dura la mezcla, la canción que entra llega sin graves y en la mitad
  // se pasan los graves de una a la otra, para que los bajos de las dos no se encimen.
  if (from && from !== decks[to] && secs >= 2) {
    const inc = decks[to], cut = -14, edge = (k, a, b) => Math.max(0, Math.min(1, (k - a) / (b - a)));
    const ci = new Float32Array(N), co = new Float32Array(N);
    for (let k = 0; k < N; k++) { const f = edge(k / (N - 1), 0.42, 0.58); ci[k] = inc.eqBase('low') + cut * (1 - f); co[k] = from.eqBase('low') + cut * f; }
    [[inc, ci], [from, co]].forEach(([d, c]) => { const g = d.low.gain; g.cancelScheduledValues(t0); g.setValueCurveAtTime(c, t0, secs); });
  }
  mix = { t0, secs, x0, to, from };
  $('#mixBtn').disabled = true;
  clearTimeout(mixTimer); mixTimer = setTimeout(tickMix, secs * 1000 + 80);
}
function tickMix() {
  if (!mix) return;
  const k = Math.min(1, (AC.currentTime - mix.t0) / mix.secs);
  xf = mix.x0 + (mix.to - mix.x0) * k;
  $('#xfade').value = Math.round(xf * 1000);
  if (k >= 1) {
    const m = mix; mix = null; xf = m.to; $('#mixBtn').disabled = false; applyXf(); decks.forEach((d) => d.applyEq());
    if (m.from && m.from !== decks[m.to]) m.from.pause();
    renderMarks();
  }
}
function cancelMix() {
  if (!mix) return;
  const k = Math.min(1, (AC.currentTime - mix.t0) / mix.secs);
  xf = mix.x0 + (mix.to - mix.x0) * k; mix = null; clearTimeout(mixTimer);
  $('#mixBtn').disabled = false; applyXf(); decks.forEach((d) => d.applyEq());
}
$('#xfade').oninput = (e) => { ensureAudio(); cancelMix(); xf = e.target.value / 1000; applyXf(); renderMarks(); };
$('#mixBtn').onclick = () => {
  const to = xf < 0.5 ? 1 : 0, dTo = decks[to], dFrom = decks[1 - to];
  if (!dTo.song) return toast('Carga una canción en el deck ' + dTo.k + ' primero.');
  if (dTo.audio.paused) dTo.play();
  mixTo(to, S.mixSecs, dFrom.audio.paused ? null : dFrom);
};

// Alinear golpes: deja el deck `d` en la misma fase del compás que el deck `o`
function beatIndex(beats, t) { let lo = 0, hi = beats.length - 1; if (hi < 1 || t < beats[0]) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (beats[m] <= t) lo = m; else hi = m - 1; } return lo < beats.length - 1 ? lo : -1; }
function alignBeats(d, o) {
  const bd = d.song.beats, bo = o.song.beats;
  if (!bd || !bo || bd.length < 4 || bo.length < 4) return;
  const io = beatIndex(bo, o.audio.currentTime), id = beatIndex(bd, d.audio.currentTime);
  if (io < 0 || id < 0) return;
  const ph = (o.audio.currentTime - bo[io]) / (bo[io + 1] - bo[io]);
  d.audio.currentTime = bd[id] + ph * (bd[id + 1] - bd[id]);
}

/* ---------------- Automix ---------------- */
function nextFor(d) {
  if (!d.queue) return null;
  for (let i = d.qi + 1; i < d.queue.length; i++) { const s = songs.get(d.queue[i]); if (s) return { s, i }; }
  return null;
}
// Qué entra después: lo que esté preparado en el otro deck o, si no hay, la siguiente de la lista
function upNext() {
  const d = deckLive(), o = decks[1 - d.idx];
  if (!d.song) return null;
  if (o.song && o.prepared) return { s: o.song, ready: true };
  const n = nextFor(d); return n ? { s: n.s, i: n.i } : null;
}
function startAutoNext(d, secs) {
  const o = decks[1 - d.idx], n = upNext();
  if (!n) return false;
  if (!n.ready) o.load(n.s, d.queue, n.i);
  else o.audio.currentTime = o.cue;
  o.play();
  mixTo(o.idx, secs, d);
  toast('Automix: entra «' + n.s.title + '» en el deck ' + o.k, 2600);
  return true;
}
let lastLive = -1;
function autoCheck() {
  tickMix();
  if (deckLive().idx !== lastLive) { lastLive = deckLive().idx; renderMarks(); }
  if (!S.automix || mix) return;
  const d = deckLive(), o = decks[1 - d.idx];
  if (!d.song || d.audio.paused || (o.song && !o.audio.paused)) return;
  const dur = d.audio.duration; if (!dur || !isFinite(dur)) return;
  const rem = (dur - d.audio.currentTime) / d.audio.playbackRate;
  if (rem <= S.mixSecs + 0.3 && dur > S.mixSecs * 2.2) startAutoNext(d, S.mixSecs);
}
function onDeckEnded(d) {
  d.onState();
  if (S.automix && !mix && d === deckLive()) startAutoNext(d, 0);
}
setInterval(autoCheck, 250); // sigue funcionando con la pantalla apagada mientras suena música

/* ---------------- Ondas ---------------- */
const WAVE_RATE = 50;   // columnas de onda por segundo de audio
const SPAN = 8;         // segundos visibles en las ondas de arriba
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement), g = (n) => cs.getPropertyValue(n).trim();
  C = { bg: g('--wave-bg'), played: g('--wave-played'), rest: g('--wave-rest'), head: g('--wave-head'), muted: g('--muted'), line: g('--inset-border'), gold: g('--gold') };
}
function fitCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}
// Deck que va adelante en la onda: el que más se escucha; si no suena ninguno, el del lado del crossfader
function waveOrder() {
  const on = decks.filter((d) => d.song && !d.audio.paused);
  let f;
  if (on.length === 2) f = gainOf(on[0]) >= gainOf(on[1]) ? on[0] : on[1];
  else if (on.length === 1) f = on[0];
  else f = deckLive().song ? deckLive() : decks.find((d) => d.song) || decks[0];
  return [f, decks[1 - f.idx]];
}
function drawLane(x, d, W, H, dpr, front) {
  const s = d.song, mid = W / 2, pps = W / SPAN, yc = H / 2, half = H / 2 - 4 * dpr, step = Math.max(2, Math.round(dpr * 1.5));
  if (!s || !s.amp) {
    if (front) {
      x.fillStyle = C.muted; x.font = `${12 * dpr}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(!s ? 'Elige una canción para el deck ' + d.k : needsAnalysis(s) ? 'Preparando la onda…' : 'Sin onda para esta canción', mid, yc);
    }
    return;
  }
  const t = d.audio.currentTime, k = front ? 1 : 0.62;
  if (front && s.beats) {
    x.fillStyle = C.line;
    const a = t - SPAN / 2, b = t + SPAN / 2;
    for (let i = 0; i < s.beats.length; i++) { const bt = s.beats[i]; if (bt < a) continue; if (bt > b) break; x.fillRect(Math.round(mid + (bt - t) * pps), 2 * dpr, dpr, H - 4 * dpr); }
  }
  const layers = front ? [[s.amp, C.rest], [s.low, C.played]] : [[s.amp, C.rest]];
  x.globalAlpha = front ? 1 : 0.4;
  for (const [arr, col] of layers) {
    x.fillStyle = col;
    for (let px = 0; px < W; px += step) {
      const i = Math.floor((t + (px - mid) / pps) * WAVE_RATE);
      if (i < 0 || i >= arr.length) continue;
      const h = Math.max(dpr, (arr[i] / 255) * half * k);
      x.fillRect(px, yc - h, step - (step > 2 ? 1 : 0), h * 2);
    }
  }
  x.globalAlpha = 1;
  if (front && d.cue > 0.05) { const cx = mid + (d.cue - t) * pps; if (cx > 0 && cx < W) { x.fillStyle = C.gold; x.beginPath(); x.moveTo(cx - 5 * dpr, 0); x.lineTo(cx + 5 * dpr, 0); x.lineTo(cx, 7 * dpr); x.fill(); } }
}
let tagShown = '';
function drawWaves() {
  const cv = $('#waveCv'), dpr = fitCanvas(cv), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
  const [f, b] = waveOrder();
  drawLane(x, b, W, H, dpr, false);   // atrás, tenue
  drawLane(x, f, W, H, dpr, true);    // adelante
  // lo ya reproducido queda más tenue
  x.globalAlpha = 0.45; x.fillStyle = C.bg; x.fillRect(0, 0, W / 2, H); x.globalAlpha = 1;
  x.fillStyle = C.head; x.fillRect(Math.round(W / 2 - dpr), 0, Math.max(2, Math.round(dpr * 1.5)), H);
  const tag = f.k + (b.song ? b.k : '');
  if (tag !== tagShown) { tagShown = tag; $('#tagFront').textContent = f.k; $('#tagBack').textContent = b.k + ' atrás'; $('#tagBack').hidden = !b.song; }
}
function loop() { decks.forEach((d) => d.tick()); drawWaves(); requestAnimationFrame(loop); }

/* ---------------- Barritas y botones del mezclador ---------------- */
$$('.mixer input[data-vol]').forEach((el) => {
  const d = decks[+el.dataset.d];
  bindSlider(el, 100, (v) => { d.vol = v / 100; d.applyVol(); });
});
$('#masterR').value = S.master;
bindSlider($('#masterR'), 90, (v) => { S.master = v; if (master) master.gain.setTargetAtTime(v / 100, AC.currentTime, 0.02); saveS(); });
$$('.voz').forEach((b) => { b.onclick = () => { const d = decks[+b.dataset.d]; d.setNoVoice(!d.noVoice); }; });
$('#mixSecs').value = String(S.mixSecs);
$('#mixSecs').onchange = (e) => { S.mixSecs = +e.target.value; saveS(); };
function setAutomix(on) { S.automix = on; $('#autoChk').checked = on; saveS(); renderMarks(); }
$('#autoChk').onchange = (e) => setAutomix(e.target.checked);

/* ---------------- Pantalla encendida y controles del sistema ---------------- */
let wake = null;
async function updateWakeLock() {
  const any = decks.some((d) => d.song && !d.audio.paused);
  try {
    if (any && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!any && wake) { await wake.release(); wake = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });
function setMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const d = deckLive().song ? deckLive() : decks.find((x) => x.song && !x.audio.paused);
  if (!d || !d.song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: d.song.title, artist: d.song.artist || 'CEM DJ', artwork: [{ src: new URL(artUrl(d.song), location.href).href, sizes: '512x512' }] });
    navigator.mediaSession.setActionHandler('play', () => deckLive().play());
    navigator.mediaSession.setActionHandler('pause', () => decks.forEach((x) => x.pause()));
  } catch {}
}

/* ---------------- Análisis (duración, volumen, BPM, golpes y onda) ---------------- */
const AV = 3; // versión del análisis: las canciones viejas se vuelven a analizar para tener onda y BPM
const needsAnalysis = (s) => s.av !== AV;
function probeDuration(blob) {
  return new Promise((res) => {
    const a = new Audio(), u = URL.createObjectURL(blob);
    const done = (v) => { URL.revokeObjectURL(u); res(v); };
    a.preload = 'metadata'; a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0); a.onerror = () => done(0);
    setTimeout(() => done(0), 8000); a.src = u;
  });
}
const analysisQueue = []; let analyzing = false;
function analyzeSoon(song, urgent) {
  if (!needsAnalysis(song)) return;
  const i = analysisQueue.indexOf(song);
  if (i >= 0) { if (!urgent) return; analysisQueue.splice(i, 1); }
  if (urgent) analysisQueue.unshift(song); else analysisQueue.push(song);
  pumpAnalysis();
}
async function pumpAnalysis() {
  if (analyzing) return; analyzing = true;
  while (analysisQueue.length) {
    const s = analysisQueue.shift();
    if (!songs.has(s.id)) continue;
    try { await analyzeSong(s); } catch {}
    s.av = AV;
    DB.put(dbRecord(s)).catch(() => {});
    decks.forEach((d) => { if (d.song === s) { d.applyNorm(); d.showBpm(); if (!mix) d.applyEq(); } });
    renderLib();
    await new Promise((r) => setTimeout(r, 30));
  }
  analyzing = false;
}
async function analyzeSong(s) {
  if (!s.dur) s.dur = await probeDuration(s.blob);
  if (!s.dur || s.dur > 20 * 60) return; // muy largas: se reproducen sin analizar
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Off(1, 1, 22050); // 22 kHz: gasta menos memoria y alcanza para volumen, ritmo y onda
  const buf = await ctx.decodeAudioData(await s.blob.arrayBuffer());
  const m = measureLoudness(buf);
  if (m) { s.lufs = m.lufs; s.peak = m.peak; }
  const on = computeOnset(buf);
  const r = on ? bpmFromOnset(on) : null;
  if (r && r.bpm > 0) { s.bpm = r.bpm; s.beats = trackBeats(on, r.bpm); }
  Object.assign(s, buildWave(buf));
  s.eqAuto = autoEq(buf);
}
// Onda resumida: amplitud total y de graves (hasta ~180 Hz), 50 columnas por segundo
function buildWave(buf) {
  const sr = buf.sampleRate, hop = Math.round(sr / WAVE_RATE), n = Math.floor(buf.length / hop);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const a = 1 - Math.exp((-2 * Math.PI * 180) / sr);
  const amp = new Float32Array(n), low = new Float32Array(n);
  let lp = 0, top = 1e-6;
  for (let c = 0; c < n; c++) {
    let ma = 0, ml = 0;
    for (let i = c * hop, e = i + hop; i < e; i++) {
      const v = (L[i] + R[i]) * 0.5; lp += a * (v - lp);
      const av = v < 0 ? -v : v, al = lp < 0 ? -lp : lp;
      if (av > ma) ma = av; if (al > ml) ml = al;
    }
    amp[c] = ma; low[c] = ml; if (ma > top) top = ma;
  }
  const q = (f) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Math.min(255, Math.round((f[i] / top) * 255)); return o; };
  return { amp: q(amp), low: q(low) };
}
// Ecualización automática: compara cuánto hay de graves (< ~200 Hz) y de agudos (> ~5 kHz) con una mezcla
// equilibrada. Solo corrige si la diferencia es grande, y como mucho ±3 dB, para no cambiar el carácter de la canción.
function autoEq(buf) {
  const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const aL = 1 - Math.exp((-2 * Math.PI * 200) / sr), aH = 1 - Math.exp((-2 * Math.PI * 5000) / sr);
  let lp = 0, lp5 = 0, eT = 0, eL = 0, eH = 0;
  for (let i = 0; i < L.length; i++) {
    const v = (L[i] + R[i]) * 0.5;
    lp += aL * (v - lp); lp5 += aH * (v - lp5);
    const hi = v - lp5;
    eT += v * v; eL += lp * lp; eH += hi * hi;
  }
  if (eT < 1e-9) return { low: 0, mid: 0, high: 0 };
  const db = (x) => 10 * Math.log10(Math.max(x, 1e-12) / eT);
  // valores de referencia medidos en grabaciones reales; zona sin corrección de ±5 dB
  const fix = (rel, target) => { const d = target - rel; return Math.abs(d) > 5 ? Math.round(Math.max(-3, Math.min(3, d * 0.5)) * 2) / 2 : 0; };
  return { low: fix(db(eL), -4.5), mid: 0, high: fix(db(eH), -23) };
}
const TAGV = 2; // versión del lector de etiquetas: las canciones viejas se vuelven a leer para sacar la carátula
const dbRecord = (s) => ({ tagv: s.tagv || 0, id: s.id, blob: s.blob, name: s.name, size: s.size, title: s.title, artist: s.artist, cover: s.cover || null, dur: s.dur || 0, bpm: s.bpm || 0, beats: s.beats || null, amp: s.amp || null, low: s.low || null, lufs: s.lufs ?? null, peak: s.peak || 0, eqAuto: s.eqAuto || null, av: s.av || 0, analyzed: s.av === AV });

// Canciones guardadas con una versión anterior: se vuelve a leer la carátula (y el título si venía del nombre del archivo)
async function rescanTags() {
  let changed = false;
  for (const s of [...songs.values()]) {
    if (s.tagv === TAGV || !songs.has(s.id)) continue;
    const t = await readTags(s.blob);
    const base = (s.name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    if (t.cover && !s.cover) { s.cover = t.cover; changed = true; }
    if (t.title && s.title === base) { s.title = t.title; changed = true; }
    if (t.artist && !s.artist) { s.artist = t.artist; changed = true; }
    s.tagv = TAGV;
    DB.put(dbRecord(s)).catch(() => {});
    decks.forEach((d) => { if (d.song === s) { d.ui.art.style.backgroundImage = `url(${artUrl(s)})`; d.ui.title.textContent = s.title; d.ui.artist.textContent = s.artist || ''; } });
  }
  if (changed) renderLib();
}

/* ---------------- Agregar canciones ---------------- */
const pickFiles = () => $('#fileIn').click();
$('#addBtn2').onclick = pickFiles;
$('#fileIn').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  let added = 0, dup = 0;
  for (const f of files) {
    if (f.type && !f.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f.name)) continue;
    let s = [...songs.values()].find((x) => x.name === f.name && x.size === f.size);
    if (s) { dup++; if (view !== 'all') addToList(view, s.id, true); continue; }
    const tags = await readTags(f);
    const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    s = { id: uid(), blob: f, name: f.name, size: f.size, title: tags.title || base, artist: tags.artist || '', cover: tags.cover || null, dur: 0, av: 0, tagv: TAGV };
    songs.set(s.id, s); added++;
    try { await DB.put(dbRecord(s)); } catch { toast('No hay espacio para guardar «' + s.title + '». Se podrá usar solo en esta sesión.', 4500); }
    if (view !== 'all') addToList(view, s.id, true);
    analyzeSoon(s);
  }
  renderLib();
  toast(added ? `${added} canción(es) agregada(s)` + (dup ? ` · ${dup} ya estaban` : '') : dup ? 'Esas canciones ya estaban agregadas.' : 'No se encontraron archivos de audio.');
};

/* ---------------- Hojas (menús y preguntas) ---------------- */
const sheet = $('#sheet');
function openSheet({ title, text, input, buttons }) {
  return new Promise((resolve) => {
    $('#sheetTitle').textContent = title;
    const tx = $('#sheetText'); tx.hidden = !text; tx.textContent = text || '';
    const inp = $('#sheetInput'); inp.hidden = input == null; inp.value = ''; inp.placeholder = input || '';
    const box = $('#sheetBtns'); box.innerHTML = '';
    let result = null;
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = 'pill' + (b.primary ? ' on' : ''); el.textContent = b.label;
      el.onclick = () => { result = { value: b.value, text: inp.value.trim() }; sheet.close(); };
      box.appendChild(el);
    }
    sheet.onclose = () => resolve(result);
    sheet.showModal();
    if (input != null) setTimeout(() => inp.focus(), 50);
  });
}
const askNewList = async () => {
  const r = await openSheet({ title: 'Nueva lista', input: 'Nombre de la lista', buttons: [{ label: 'Crear', value: 'ok', primary: true }, { label: 'Cancelar', value: 'no' }] });
  if (!r || r.value !== 'ok' || !r.text) return null;
  const l = { id: uid(), name: r.text.slice(0, 40), ids: [] }; lists.push(l); saveLists(); return l;
};

/* ---------------- Listas ---------------- */
function addToList(listId, songId, quiet) {
  const l = lists.find((x) => x.id === listId); if (!l) return;
  if (l.ids.includes(songId)) { if (!quiet) toast('Esa canción ya está en «' + l.name + '».'); return; }
  l.ids.push(songId); saveLists(); if (!quiet) toast('Agregada a «' + l.name + '»');
}
async function chooseListFor(songId) {
  const btns = lists.map((l) => ({ label: l.name, value: l.id }));
  btns.push({ label: '＋ Nueva lista…', value: '__new', primary: true }, { label: 'Cancelar', value: '__no' });
  const r = await openSheet({ title: 'Agregar a una lista', buttons: btns });
  if (!r || r.value === '__no') return;
  let id = r.value;
  if (id === '__new') { const l = await askNewList(); if (!l) return; id = l.id; }
  addToList(id, songId); renderLib();
}
async function songMenu(s) {
  const inList = view !== 'all' ? lists.find((l) => l.id === view) : null;
  const buttons = [{ label: 'Agregar a una lista…', value: 'list', primary: true }];
  if (inList) buttons.push({ label: 'Quitar de «' + inList.name + '»', value: 'rm' });
  buttons.push({ label: 'Eliminar de la biblioteca', value: 'del' }, { label: 'Cancelar', value: 'no' });
  const r = await openSheet({ title: s.title, text: s.artist || '', buttons });
  if (!r) return;
  if (r.value === 'list') chooseListFor(s.id);
  else if (r.value === 'rm') { inList.ids = inList.ids.filter((i) => i !== s.id); saveLists(); renderLib(); }
  else if (r.value === 'del') {
    const c = await openSheet({ title: '¿Eliminar «' + s.title + '»?', text: 'Se borra de la biblioteca y de todas las listas, solo en este equipo. El archivo original no se toca.', buttons: [{ label: 'Eliminar', value: 'yes', primary: true }, { label: 'Cancelar', value: 'no' }] });
    if (c && c.value === 'yes') {
      decks.forEach((d) => { if (d.song === s) d.unload(); });
      songs.delete(s.id); lists.forEach((l) => { l.ids = l.ids.filter((i) => i !== s.id); }); saveLists();
      if (arts.has(s.id)) { URL.revokeObjectURL(arts.get(s.id)); arts.delete(s.id); }
      DB.del(s.id).catch(() => {}); renderLib();
    }
  }
}

/* ---------------- Pintar la biblioteca ---------------- */
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function viewSongs() {
  if (view === 'all') return [...songs.values()].sort((a, b) => a.title.localeCompare(b.title, 'es'));
  const l = lists.find((x) => x.id === view); return l ? l.ids.map((i) => songs.get(i)).filter(Boolean) : [];
}
function renderLib() {
  if (view !== 'all' && !lists.some((l) => l.id === view)) view = 'all';
  const chips = $('#chips'); chips.innerHTML = '';
  const mk = (label, id) => { const c = document.createElement('button'); c.className = 'chip' + (view === id ? ' on' : ''); c.textContent = label; c.onclick = () => { view = id; renderLib(); }; chips.appendChild(c); };
  mk('Todas (' + songs.size + ')', 'all'); lists.forEach((l) => mk(l.name + ' (' + l.ids.filter((i) => songs.has(i)).length + ')', l.id));
  const nl = document.createElement('button'); nl.className = 'chip'; nl.textContent = '＋ Lista';
  nl.onclick = async () => { const l = await askNewList(); if (l) { view = l.id; renderLib(); } };
  chips.appendChild(nl);

  const list = lists.find((l) => l.id === view);
  const qText = $('#search').value.trim(), q = norm(qText);
  $('#libTitle').textContent = list ? list.name : 'Biblioteca';
  const all = viewSongs(), allIds = all.map((s) => s.id);
  const arr = q ? all.filter((s) => norm(s.title + ' ' + s.artist).includes(q)) : all;
  const rows = $('#rows'); rows.innerHTML = '';
  if (!arr.length) {
    rows.innerHTML = `<div class="empty">${songs.size ? (list && !qText ? 'Esta lista está vacía. Toca ⋯ en una canción de «Todas» para agregarla, o agrega canciones nuevas.' : 'No hay resultados.') : 'Agrega canciones de este equipo para empezar.<br><button class="pill on" id="emptyAdd">Agregar canciones</button>'}</div>`;
    const b = $('#emptyAdd'); if (b) b.onclick = pickFiles;
  }
  const frag = document.createDocumentFragment();
  arr.forEach((s) => {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.id = s.id;
    row.innerHTML = `<img class="th" alt="" loading="lazy"><div class="tx"><div class="nm"></div><div class="sub"></div></div>
      ${list && !qText ? '<button class="ibtn mv" data-a="up" aria-label="Subir">▲</button><button class="ibtn mv" data-a="dn" aria-label="Bajar">▼</button>' : ''}
      <button class="pill ld" data-a="A" aria-label="Cargar en el deck A">A</button><button class="pill ld" data-a="B" aria-label="Cargar en el deck B">B</button>
      <button class="ibtn" data-a="more" aria-label="Más opciones">${ICON.more}</button>`;
    row.querySelector('.th').src = artUrl(s);
    row.querySelector('.nm').textContent = s.title;
    row.querySelector('.sub').textContent = [fmt(s.dur), s.bpm ? Math.round(s.bpm) + ' BPM' : needsAnalysis(s) ? 'analizando…' : '', s.artist].filter(Boolean).join(' · ');
    row.querySelector('.tx').onclick = () => loadFromView(pickDeck(), s, allIds);
    row.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation(); const a = b.dataset.a;
        if (a === 'A' || a === 'B') loadFromView(decks[a === 'A' ? 0 : 1], s, allIds);
        else if (a === 'more') songMenu(s);
        else if (list) { const j = list.ids.indexOf(s.id), k = a === 'up' ? j - 1 : j + 1; if (k >= 0 && k < list.ids.length) { [list.ids[j], list.ids[k]] = [list.ids[k], list.ids[j]]; saveLists(); decks.forEach((d) => { if (d.queue && d.queue.length === list.ids.length) { d.queue = list.ids.slice(); d.qi = d.queue.indexOf(d.song && d.song.id); } }); renderLib(); } }
      };
    });
    frag.appendChild(row);
  });
  rows.appendChild(frag);
  const total = [...songs.values()].reduce((n, s) => n + (s.size || 0), 0);
  $('#libNote').textContent = songs.size ? `${songs.size} canciones guardadas en este equipo · ${(total / 1048576).toFixed(0)} MB` + (list && qText ? ' · para reordenar, borra la búsqueda' : '') : '';
  renderMarks();
}
// Marca en la lista qué está en cada deck y qué entra después con el automix
function renderMarks() {
  const nx = S.automix ? upNext() : null;
  $$('#rows .row').forEach((r) => {
    const id = r.dataset.id;
    r.classList.toggle('cur', decks.some((d) => d.song && d.song.id === id && !d.audio.paused));
    r.querySelectorAll('.ld').forEach((b) => b.classList.toggle('on', !!(decks[b.dataset.a === 'A' ? 0 : 1].song && decks[b.dataset.a === 'A' ? 0 : 1].song.id === id)));
    const nm = r.querySelector('.nm'), tag = nm.querySelector('.nexttag');
    const isNext = !!(nx && nx.s.id === id);
    if (isNext && !tag) { const t = document.createElement('span'); t.className = 'nexttag'; t.textContent = 'Sigue'; nm.prepend(t); }
    else if (!isNext && tag) tag.remove();
  });
}
// Deck para una canción tocada en la lista: el que esté libre o en pausa, nunca el que suena
function pickDeck() {
  const live = deckLive();
  return decks.find((d) => !d.song) || (live.audio.paused && !decks[1 - live.idx].audio.paused ? live : decks[1 - live.idx]);
}
function loadFromView(deck, s, ids) {
  const go = () => { deck.load(s, ids, ids.indexOf(s.id), true); toast('«' + s.title + '» cargada en el deck ' + deck.k, 1800); };
  if (deck.song && !deck.audio.paused) {
    openSheet({ title: 'El deck ' + deck.k + ' está sonando', text: '¿Cambiar «' + deck.song.title + '» por «' + s.title + '»?', buttons: [{ label: 'Sí, cambiar', value: 'y', primary: true }, { label: 'Cancelar', value: 'n' }] })
      .then((r) => { if (r && r.value === 'y') go(); });
    return;
  }
  go();
}
$('#search').oninput = renderLib;

/* ---------------- Solo vertical ---------------- */
// En la app instalada se traba la pantalla en vertical; en el navegador, si el celular está acostado se pide girarlo.
const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
function lockPortrait() { try { const o = screen.orientation; if (o && o.lock) o.lock('portrait').catch(() => {}); } catch {} }
function checkOrientation() {
  const o = screen.orientation && screen.orientation.type;
  const land = o ? o.startsWith('landscape') : Math.abs(window.orientation || 0) === 90;
  document.documentElement.classList.toggle('landscape-phone', isPhone() && land);
}
if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', checkOrientation);
window.addEventListener('orientationchange', checkOrientation);
window.addEventListener('resize', checkOrientation);
document.addEventListener('pointerdown', lockPortrait, { once: true });

/* ---------------- Recordar los decks (por si la página se recarga) ---------------- */
function saveSession() {
  store.set('cem.session', {
    xf: mix ? mix.to : xf,
    decks: decks.map((d) => Object.assign({ vol: d.vol, eq: d.eq, noVoice: d.noVoice },
      d.song ? { id: d.song.id, t: d.audio.currentTime, cue: d.cue, pitch: d.pitch, synced: d.synced, queue: d.queue, qi: d.qi, prepared: d.prepared || d.audio.paused } : {})),
  });
}
function restoreSession() {
  const ss = store.get('cem.session', null);
  if (!ss || !Array.isArray(ss.decks)) return;
  ss.decks.forEach((st, i) => {
    const d = decks[i]; if (!d || !st) return;
    if (st.vol != null) { d.vol = clamp(+st.vol, 0, 1); const el = $(`.mixer input[data-d="${i}"][data-vol]`); if (el) el.value = Math.round(d.vol * 100); }
    if (st.noVoice) d.setNoVoice(true, true);
    const s = st.id && songs.get(st.id);
    if (!s) return;
    d.load(s, Array.isArray(st.queue) ? st.queue : null, st.qi ?? -1, !!st.prepared);
    d.cue = +st.cue || 0; d.ui.cue.classList.toggle('armed', d.cue > 0.05);
    d.synced = !!st.synced; d.setPitch(+st.pitch || 0);
    const t = +st.t || 0;
    if (t > 0) d.audio.addEventListener('loadedmetadata', () => { d.audio.currentTime = Math.min(t, Math.max(0, (d.audio.duration || t) - 0.5)); }, { once: true });
  });
  xf = clamp(+ss.xf || 0, 0, 1); applyXf();
  if (decks.some((d) => d.song)) toast('Los decks quedaron como estaban. Toca ▶ para seguir.', 3500);
}
setInterval(saveSession, 2000);
window.addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });
// Si hay música sonando, el navegador pide confirmación antes de recargar o cerrar la página
window.addEventListener('beforeunload', (e) => { saveSession(); if (decks.some((d) => d.song && !d.audio.paused)) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------- Ajustes, tema e instalación ---------------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('cem.theme', t); } catch {}
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = t === 'dark' ? '#1a1710' : '#ffffff';
  const b = $('#themeBtn'); b.innerHTML = t === 'dark' ? ICON.sun : ICON.moon; b.setAttribute('aria-label', t === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
  readColors();
}
$('#themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

(async function start() {
  $('#addBtn2').innerHTML = ICON.plus + ' Agregar';
  applyTheme(document.documentElement.dataset.theme);
  setAutomix(S.automix);
  applyXf(); loop();
  try {
    for (const r of await DB.all()) songs.set(r.id, Object.assign({ bpm: 0, av: 0 }, r));
  } catch { toast('Este navegador no permite guardar canciones; solo funcionarán durante esta sesión.', 5000); }
  renderLib();
  songs.forEach((s) => { if (needsAnalysis(s)) analyzeSoon(s); });
  restoreSession();
  checkOrientation(); lockPortrait();
  rescanTags();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
