// Preload injetado nas páginas das redes sociais.
// Faz o clique numa notificação trazer o MultiSocial para frente na aba certa.
const { ipcRenderer, webFrame } = require('electron');

let flags = {};
try { flags = ipcRenderer.sendSync('web:flags') || {}; } catch (e) {}

// Qualidade do microfone: desliga a supressão de ruído / ganho automático do navegador,
// que deixavam a voz picotada e "abafada" (mensagens de voz do WhatsApp, Discord etc.).
if (flags.mic && flags.mic !== 'site') {
  const ovr = flags.mic === 'studio'
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : flags.mic === 'balanced'
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      : { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  try {
    webFrame.executeJavaScript(`(() => {
      try {
        const OVR = ${JSON.stringify(ovr)};
        const fix = (c) => {
          if (!c || !c.audio) return c;
          const a = (typeof c.audio === 'object') ? Object.assign({}, c.audio) : {};
          Object.assign(a, OVR);
          if (a.channelCount == null) a.channelCount = 1;
          return Object.assign({}, c, { audio: a });
        };
        const md = navigator.mediaDevices;
        if (md && md.getUserMedia && !md.__msMic) {
          const orig = md.getUserMedia.bind(md);
          md.getUserMedia = (c) => orig(fix(c));
          md.__msMic = true;
        }
        const ApplyOrig = window.MediaStreamTrack && MediaStreamTrack.prototype.applyConstraints;
        if (ApplyOrig && !MediaStreamTrack.prototype.__msMic) {
          MediaStreamTrack.prototype.applyConstraints = function (c) {
            return ApplyOrig.call(this, this.kind === 'audio' ? Object.assign({}, c || {}, OVR) : c);
          };
          MediaStreamTrack.prototype.__msMic = true;
        }
      } catch (e) {}
    })();`);
  } catch (e) { /* ignora */ }
}

// Bloqueia chaves de acesso (passkeys/WebAuthn): evita o popup "Segurança do Windows"
// pedindo pendrive/chave USB e faz Google e outros sites irem direto para a senha.
if (flags.disablePasskeys) {
  try {
    webFrame.executeJavaScript(`(() => {
      try {
        const deny = () => Promise.reject(new DOMException('Chaves de acesso desativadas no MultiSocial', 'NotAllowedError'));
        if (navigator.credentials) {
          const get = navigator.credentials.get.bind(navigator.credentials);
          const create = navigator.credentials.create.bind(navigator.credentials);
          navigator.credentials.get = (o) => (o && o.publicKey) ? deny() : get(o);
          navigator.credentials.create = (o) => (o && o.publicKey) ? deny() : create(o);
        }
        try { delete window.PublicKeyCredential; } catch (e) {}
        try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch (e) {}
      } catch (e) {}
    })();`);
  } catch (e) { /* ignora */ }
}

try {
  webFrame.executeJavaScript(`(() => {
    try {
      const N = window.Notification;
      if (!N || N.__ms) return;
      class MSNotification extends N {
        constructor(title, opts) {
          super(title, opts);
          this.addEventListener('click', () => window.postMessage({ __ms: 'notif-click' }, '*'));
        }
      }
      MSNotification.requestPermission = N.requestPermission.bind(N);
      Object.defineProperty(MSNotification, 'permission', { get: () => N.permission });
      MSNotification.__ms = true;
      window.Notification = MSNotification;
    } catch (e) {}
  })();`);
} catch (e) { /* ignora */ }

window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__ms === 'notif-click') {
    ipcRenderer.send('web:notif-click');
  }
  if (e.source === window && e.data && e.data.__ms === 'rec-status') {
    ipcRenderer.send('web:rec-status', e.data.state);
  }
});

// ---------------------------------------------------------------------------
// Botões flutuantes de Voltar (canto superior esquerdo) e Avançar (canto superior direito).
// Aparecem só quando o mouse chega perto do canto, com animação rápida.
// Usa Shadow DOM fechado + estilos via CSSOM (não é afetado pelo CSS nem pelo CSP do site).
// ---------------------------------------------------------------------------
(() => {
  let nav = { back: false, forward: false };
  let host = null;
  let btnBack = null;
  let btnFwd = null;
  let shownB = false;
  let shownF = false;
  const ZONE_X = 110; // distância do canto (px) que faz o botão aparecer
  const ZONE_Y = 80;

  function makeBtn(side, d, title) {
    const b = document.createElement('div');
    const s = b.style;
    s.position = 'fixed';
    s.top = '10px';
    s[side] = '10px';
    s.width = '30px';
    s.height = '30px';
    s.borderRadius = '50%';
    s.background = 'rgba(20,22,29,.82)';
    s.border = '1px solid rgba(255,255,255,.12)';
    s.boxShadow = '0 4px 14px rgba(0,0,0,.35)';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.cursor = 'pointer';
    s.opacity = '0';
    s.transform = 'translateY(10px) scale(.85)';
    s.transition = 'opacity 80ms ease-out, transform 120ms cubic-bezier(.2,.9,.3,1.5), background 80ms';
    s.pointerEvents = 'none';
    s.zIndex = '2147483647';
    s.boxSizing = 'border-box';
    b.title = title;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#fff');
    svg.setAttribute('stroke-width', '2.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    b.appendChild(svg);
    b.addEventListener('mouseenter', () => { s.background = 'rgba(108,124,255,.95)'; });
    b.addEventListener('mouseleave', () => { s.background = 'rgba(20,22,29,.82)'; });
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    b.addEventListener('pointerdown', stop, true);
    b.addEventListener('mousedown', stop, true);
    b.addEventListener('click', (e) => { stop(e); ipcRenderer.send('web:nav', side === 'left' ? 'back' : 'forward'); }, true);
    return b;
  }

  function ensure() {
    if (!document.documentElement) return false;
    if (!host) {
      host = document.createElement('ms-nav');
      host.style.all = 'initial';
      host.style.position = 'fixed';
      host.style.top = '0';
      host.style.left = '0';
      host.style.width = '0';
      host.style.height = '0';
      host.style.zIndex = '2147483647';
      const root = host.attachShadow({ mode: 'closed' });
      btnBack = makeBtn('left', 'M15 18l-6-6 6-6', 'Voltar (Alt+←)');
      btnFwd = makeBtn('right', 'M9 18l6-6-6-6', 'Avançar (Alt+→)');
      root.append(btnBack, btnFwd);
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    return true;
  }

  function show(b, on) {
    const s = b.style;
    s.opacity = on ? '1' : '0';
    s.transform = on ? 'translateY(0) scale(1)' : 'translateY(10px) scale(.85)';
    s.pointerEvents = on ? 'auto' : 'none';
  }

  function update(nearL, nearR) {
    const fs = !!document.fullscreenElement;
    const b = nearL && nav.back && !fs;
    const f = nearR && nav.forward && !fs;
    if (b === shownB && f === shownF) return;
    if ((b || f) && !ensure()) return;
    shownB = b; shownF = f;
    if (btnBack) show(btnBack, b);
    if (btnFwd) show(btnFwd, f);
  }

  ipcRenderer.on('ms:nav', (_e, s) => { nav = s || nav; if (!nav.back && shownB) update(false, shownF); if (!nav.forward && shownF) update(shownB, false); });

  window.addEventListener('mousemove', (e) => {
    const nearTop = e.clientY < ZONE_Y;
    update(nearTop && e.clientX < ZONE_X, nearTop && e.clientX > window.innerWidth - ZONE_X);
  }, { passive: true, capture: true });
  document.addEventListener('mouseleave', () => update(false, false), { passive: true });
  window.addEventListener('blur', () => update(false, false));
})();

// ---------------------------------------------------------------------------
// Barra de mídia do MultiSocial: linha do tempo + volume sobre os vídeos de sites que não têm
// (Instagram, Threads...). Aparece ao passar o mouse no vídeo, acompanha o tamanho e a posição
// dele (rolagem, janela redimensionada, modo celular) e some sozinha.
// Shadow DOM fechado + estilos via CSSOM: o CSS e o CSP do site não interferem.
// ---------------------------------------------------------------------------
(() => {
  if (!flags.mediaBar) return;
  const ACCENT = '#6c7cff';
  const H = 36;               // altura da barra
  let host = null;
  let bar = null;
  const ui = {};
  let cur = null;             // vídeo atual
  let visible = false;
  let overBar = false;
  let dragging = null;        // 'seek' | 'vol'
  let hideTimer = 0;
  let raf = 0;
  let lastVol = 1;

  const css = (el, o) => { Object.assign(el.style, o); return el; };

  // ---- som escolhido na barra. Alguns sites (Instagram) reaplicam o "mudo" deles toda vez que o
  // vídeo volta a tocar; aqui a escolha feita na barra vale até a pessoa usar o botão do próprio site.
  let soundChoice = null;     // { muted, volume }
  let ourChangeAt = 0;
  let playAt = 0;
  const watched = new WeakSet();
  function setSound(v, muted, volume) {
    ourChangeAt = performance.now();
    if (volume != null) v.volume = volume;
    v.muted = muted;
    soundChoice = { muted, volume: v.volume };
  }
  function reapply(v) {
    if (!soundChoice || !v) return;
    if (v.muted !== soundChoice.muted || Math.abs(v.volume - soundChoice.volume) > 0.01) {
      ourChangeAt = performance.now();
      v.volume = soundChoice.volume;
      v.muted = soundChoice.muted;
    }
  }
  function watch(v) {
    if (watched.has(v)) return;
    watched.add(v);
    const onPlay = () => {
      playAt = performance.now();
      setTimeout(() => reapply(v), 30);
      setTimeout(() => reapply(v), 250);
      setTimeout(() => reapply(v), 700);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('playing', onPlay);
    v.addEventListener('volumechange', () => {
      const now = performance.now();
      if (now - ourChangeAt < 150 || !soundChoice) return;
      if (now - playAt < 900) { reapply(v); return; }    // o site mutou sozinho ao voltar a tocar
      soundChoice = { muted: v.muted, volume: v.volume }; // a pessoa usou o botão do próprio site
    });
  }
  const mk = (tag, o) => css(document.createElement(tag), o || {});
  const svgIcon = (paths, size = 16) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#fff'); s.setAttribute('stroke-width', '2.2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      if (d.endsWith('z') && d.startsWith('M8')) p.setAttribute('fill', '#fff');
      s.appendChild(p);
    }
    return s;
  };
  const ICON = {
    play: ['M8 5.5v13l11-6.5z'],
    pause: ['M9 5v14', 'M15 5v14'],
    vol: ['M11 5L6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
    volLow: ['M11 5L6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7'],
    mute: ['M11 5L6 9H2v6h4l5 4z', 'M22 9l-6 6', 'M16 9l6 6']
  };
  const fmt = (t) => {
    if (!isFinite(t) || t < 0) return '0:00';
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };
  const stop = (e) => { e.stopPropagation(); };

  function iconBtn(name, title, onClick) {
    const b = mk('div', { width: '28px', height: '28px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flex: 'none', transition: 'background 80ms' });
    b.title = title;
    b.appendChild(svgIcon(ICON[name]));
    b.__icon = name;
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.14)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', (e) => { e.preventDefault(); stop(e); onClick(); });
    return b;
  }
  // só troca o desenho quando o ícone muda: trocar a cada quadro fazia o clique se perder
  function setIcon(btn, name) {
    if (btn.__icon === name) return;
    btn.__icon = name;
    btn.replaceChildren(svgIcon(ICON[name]));
  }

  function track(kind) {
    // área clicável alta, trilho fino que engrossa no hover
    const area = mk('div', { position: 'relative', height: '20px', display: 'flex', alignItems: 'center', cursor: 'pointer', flex: kind === 'seek' ? '1 1 auto' : 'none', width: kind === 'vol' ? '64px' : 'auto', minWidth: kind === 'seek' ? '40px' : '0' });
    const rail = mk('div', { position: 'relative', width: '100%', height: '4px', borderRadius: '3px', background: 'rgba(255,255,255,.22)', transition: 'height 90ms' });
    const buf = mk('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0%', borderRadius: '3px', background: 'rgba(255,255,255,.28)' });
    const fill = mk('div', { position: 'absolute', left: '0', top: '0', bottom: '0', width: '0%', borderRadius: '3px', background: ACCENT });
    const knob = mk('div', { position: 'absolute', top: '50%', left: '0%', width: '12px', height: '12px', marginLeft: '-6px', marginTop: '-6px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.5)', transform: 'scale(0)', transition: 'transform 90ms' });
    rail.append(buf, fill, knob);
    area.appendChild(rail);
    area.addEventListener('mouseenter', () => { rail.style.height = '6px'; knob.style.transform = 'scale(1)'; });
    area.addEventListener('mouseleave', () => { if (dragging !== kind) { rail.style.height = '4px'; knob.style.transform = 'scale(0)'; } });
    const ratioAt = (x) => { const r = rail.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / (r.width || 1))); };
    const apply = (x) => {
      if (!cur) return;
      const k = ratioAt(x);
      if (kind === 'seek') { if (isFinite(cur.duration) && cur.duration > 0) cur.currentTime = k * cur.duration; }
      else { setSound(cur, k === 0, k); if (k > 0) lastVol = k; }
      refresh();
    };
    area.addEventListener('pointerdown', (e) => {
      e.preventDefault(); stop(e);
      dragging = kind;
      area.setPointerCapture(e.pointerId);
      apply(e.clientX);
    });
    area.addEventListener('pointermove', (e) => { if (dragging === kind) apply(e.clientX); });
    const end = (e) => {
      if (dragging !== kind) return;
      dragging = null;
      try { area.releasePointerCapture(e.pointerId); } catch {}
      rail.style.height = '4px'; knob.style.transform = 'scale(0)';
    };
    area.addEventListener('pointerup', end);
    area.addEventListener('pointercancel', end);
    area.addEventListener('click', stop);
    // dica de tempo ao passar o mouse na linha do tempo
    if (kind === 'seek') {
      const tip = mk('div', { position: 'absolute', bottom: '22px', padding: '2px 6px', borderRadius: '6px', background: 'rgba(0,0,0,.85)', color: '#fff', font: '600 11px "Segoe UI", system-ui, sans-serif', transform: 'translateX(-50%)', pointerEvents: 'none', opacity: '0', transition: 'opacity 80ms', whiteSpace: 'nowrap' });
      area.appendChild(tip);
      area.addEventListener('mousemove', (e) => {
        if (!cur || !isFinite(cur.duration)) return;
        const r = rail.getBoundingClientRect();
        const k = ratioAt(e.clientX);
        tip.textContent = fmt(k * cur.duration);
        tip.style.left = (k * r.width) + 'px';
        tip.style.opacity = '1';
      });
      area.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
    }
    return { area, rail, buf, fill, knob };
  }

  function build() {
    host = document.createElement('ms-media');
    css(host, { all: 'initial', position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483646' });
    const root = host.attachShadow({ mode: 'closed' });
    bar = mk('div', {
      position: 'fixed', left: '0', top: '0', height: H + 'px', display: 'flex', alignItems: 'center', gap: '6px',
      padding: '0 8px', boxSizing: 'border-box', borderRadius: '12px',
      background: 'rgba(14,16,22,.78)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,255,255,.10)', boxShadow: '0 6px 20px rgba(0,0,0,.35)',
      color: '#fff', font: '500 12px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif', userSelect: 'none',
      opacity: '0', transform: 'translateY(8px)', transition: 'opacity 110ms ease-out, transform 140ms cubic-bezier(.2,.9,.3,1.3)',
      pointerEvents: 'none'
    });
    ui.play = iconBtn('play', 'Reproduzir / pausar', () => { if (!cur) return; if (cur.paused) cur.play().catch(() => {}); else cur.pause(); refresh(); });
    ui.time = mk('div', { flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: '.92', minWidth: '0', whiteSpace: 'nowrap' });
    ui.seek = track('seek');
    ui.live = mk('div', { flex: '1 1 auto', display: 'none', alignItems: 'center', gap: '6px', fontWeight: '700', fontSize: '11px', letterSpacing: '.04em' });
    const dot = mk('span', { width: '8px', height: '8px', borderRadius: '50%', background: '#ff3b4f', display: 'inline-block' });
    ui.live.append(dot, document.createTextNode('AO VIVO'));
    ui.mute = iconBtn('vol', 'Mudo (clique)', () => {
      if (!cur) return;
      if (cur.muted || cur.volume === 0) setSound(cur, false, cur.volume === 0 ? (lastVol || 0.6) : null);
      else { lastVol = cur.volume; setSound(cur, true, null); }
      refresh();
    });
    ui.vol = track('vol');
    bar.append(ui.play, ui.time, ui.seek.area, ui.live, ui.mute, ui.vol.area);
    for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'contextmenu', 'wheel']) {
      bar.addEventListener(ev, stop);
    }
    // rolar a roda do mouse em cima da barra = volume
    bar.addEventListener('wheel', (e) => {
      if (!cur) return;
      e.preventDefault();
      setSound(cur, false, Math.min(1, Math.max(0, cur.volume + (e.deltaY < 0 ? 0.05 : -0.05))));
      refresh();
    }, { passive: false });
    bar.addEventListener('mouseenter', () => { overBar = true; clearTimeout(hideTimer); });
    bar.addEventListener('mouseleave', () => { overBar = false; scheduleHide(); });
    root.appendChild(bar);
  }

  function ensureHost() {
    if (!document.documentElement) return false;
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
    return true;
  }

  function refresh() {
    if (!cur || !bar) return;
    const live = !isFinite(cur.duration) || cur.duration === 0;
    setIcon(ui.play, cur.paused ? 'play' : 'pause');
    const vol = cur.muted ? 0 : cur.volume;
    setIcon(ui.mute, vol === 0 ? 'mute' : vol < 0.5 ? 'volLow' : 'vol');
    ui.vol.fill.style.width = (vol * 100) + '%';
    ui.vol.knob.style.left = (vol * 100) + '%';
    ui.seek.area.style.display = live ? 'none' : 'flex';
    ui.live.style.display = live ? 'flex' : 'none';
    if (!live) {
      const k = cur.currentTime / cur.duration;
      ui.seek.fill.style.width = (k * 100) + '%';
      ui.seek.knob.style.left = (k * 100) + '%';
      let b = 0;
      try { for (let i = 0; i < cur.buffered.length; i++) if (cur.buffered.start(i) <= cur.currentTime) b = Math.max(b, cur.buffered.end(i)); } catch {}
      ui.seek.buf.style.width = Math.min(100, (b / cur.duration) * 100) + '%';
      ui.time.textContent = fmt(cur.currentTime) + ' / ' + fmt(cur.duration);
    } else {
      ui.time.textContent = fmt(cur.currentTime);
    }
  }

  // posição e tamanho acompanham o vídeo
  let obst = { v: null, t: 0, bottom: 0, w: 0, lift: 0 };
  const CLICKABLE = 'button,[role="button"],a[href],input,select,[aria-label],[tabindex]:not([tabindex="-1"])';
  function siteButtonsLift(r, left, right, bottom) {
    let minTop = Infinity;
    const limit = r.top + r.height * 0.5;   // só considera o que está na metade de baixo do vídeo
    const ys = [bottom - 6, bottom - H / 2, bottom - H + 4];
    for (let x = left + 6; x <= right - 2; x += 18) {
      for (const y of ys) {
        let list;
        try { list = document.elementsFromPoint(x, y); } catch { continue; }
        for (const el of list) {
          if (el === host) continue;               // a nossa barra
          if (el === cur || el === document.body || el === document.documentElement) break;
          const b = el.closest ? el.closest(CLICKABLE) : null;
          if (b && !b.contains(cur)) {
            const br = b.getBoundingClientRect();
            if (br.width > 6 && br.width < 220 && br.height < 120 && br.top > limit) minTop = Math.min(minTop, br.top);
            break;
          }
        }
      }
    }
    return minTop === Infinity ? 0 : Math.max(0, bottom - minTop + 6);
  }

  // ---- o site já tem linha do tempo/volume para este vídeo? (verificado vídeo a vídeo, em qualquer site)
  const tlCache = new WeakMap();
  const TL_SEL = 'input[type="range"],progress,[role="slider"],[role="progressbar"],[aria-valuenow]';
  // Uma vez que o site mostrou uma linha do tempo DE VERDADE (um slider que dá para arrastar)
  // em algum vídeo da página, ele tem player próprio: a barra do app não aparece mais nessa página.
  // Sites como o X só mostram os controles ao passar o mouse, e sem isso as duas barras brigavam.
  let pageHasOwnPlayer = false;
  const ownControls = new WeakSet();
  // vr = retângulo do vídeo; depth = quantos níveis acima do vídeo está o container analisado
  function looksLikeTimeline(el, vr, depth) {
    const r = el.getBoundingClientRect();
    const seek = el.matches('[role="slider"],input[type="range"]');
    let ok = false;
    if (r.width >= 50 && r.width >= 2.5 * r.height) {
      // tem que estar SOBRE o vídeo (ou logo abaixo dele), não em outro vídeo da página
      ok = r.left < vr.right && r.right > vr.left && r.top >= vr.top - 10 && r.bottom <= vr.bottom + 90;
    } else if (r.width === 0 && r.height === 0 && seek) {
      ok = depth <= 3; // escondida até o hover: só conta se estiver bem perto do vídeo
    }
    if (ok && seek) pageHasOwnPlayer = true;
    return ok;
  }
  function scanForTimeline(root, vr, depth) {
    for (const el of root.querySelectorAll(TL_SEL)) if (looksLikeTimeline(el, vr, depth)) return true;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) for (const x of el.shadowRoot.querySelectorAll(TL_SEL)) if (looksLikeTimeline(x, vr, depth)) return true;
    }
    return false;
  }
  function hasOwnTimeline(v, fresh) {
    if (pageHasOwnPlayer || ownControls.has(v)) return true;
    const now = performance.now();
    const c = tlCache.get(v);
    if (!fresh && c && now - c.t < 1500) return c.has;
    const vr = v.getBoundingClientRect();
    let has = false;
    let node = v.parentElement;
    for (let i = 0; i < 6 && node && !has; i++, node = node.parentElement) {
      const nr = node.getBoundingClientRect();
      if (nr.width > vr.width * 1.6 + 60 || nr.height > vr.height * 1.6 + 120) break; // já saiu do player
      has = scanForTimeline(node, vr, i + 1);
    }
    if (!has) { const rn = v.getRootNode(); if (rn && rn !== document && rn.host) has = scanForTimeline(rn, vr, 1); }
    tlCache.set(v, { t: now, has });
    if (has) ownControls.add(v);
    return has;
  }

  function place() {
    if (!cur || !bar) return false;
    if (!cur.isConnected || document.fullscreenElement) return false;
    const r = cur.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(r.left, 0) + 8;
    const right = Math.min(r.right, vw) - 8;
    const bottom = Math.min(r.bottom, vh) - 8;
    const width = right - left;
    if (width < 120 || bottom - Math.max(r.top, 0) < H + 16) return false;
    // sobe a barra se houver botões do próprio site na faixa de baixo do vídeo
    const now = performance.now();
    if (obst.v !== cur || now - obst.t > 500 || Math.abs(obst.bottom - bottom) > 2 || Math.abs(obst.w - width) > 2) {
      const lift = siteButtonsLift(r, left, right, bottom);
      const keep = visible && obst.v === cur ? Math.max(obst.lift, lift) : lift;
      obst = { v: cur, t: now, bottom, w: width, lift: keep };
    }
    const barBottom = bottom - obst.lift;
    bar.style.left = left + 'px';
    bar.style.top = (barBottom - H) + 'px';
    bar.style.width = width + 'px';
    // layout responsivo: some o que não cabe
    ui.time.style.display = width < 300 ? 'none' : 'block';
    ui.vol.area.style.display = width < 230 ? 'none' : 'flex';
    ui.vol.area.style.width = width > 520 ? '84px' : '64px';
    return true;
  }

  function loop() {
    raf = 0;
    if (!visible) return;
    if (cur && !flags.mediaAll && !dragging && hasOwnTimeline(cur)) { hide(true); return; }
    if (cur && cur.paused && !dragging && lastMouse) {
      const v = videoAt(lastMouse.x, lastMouse.y);
      if (v && v !== cur && !v.paused) { cur = v; watch(v); reapply(v); }
    }
    if (!place()) { hide(true); return; }
    refresh();
    raf = requestAnimationFrame(loop);
  }

  function show() {
    if (!ensureHost() || !place()) return;
    if (!visible) {
      visible = true;
      css(bar, { opacity: '1', transform: 'translateY(0)', pointerEvents: 'auto' });
    }
    refresh();
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function hide(now) {
    if (!visible || !bar) return;
    if (!now && (overBar || dragging)) return;
    visible = false;
    css(bar, { opacity: '0', transform: 'translateY(8px)', pointerEvents: 'none' });
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hide(false), 2200);
  }

  // Escolhe o vídeo que a pessoa está VENDO debaixo do mouse. O Instagram deixa vários vídeos
  // empilhados (o reel atual + os próximos já carregados, às vezes escondidos): vence o que está
  // visível e tocando, e entre iguais o maior.
  function isShown(v) {
    for (let el = v, i = 0; el && el.nodeType === 1 && i < 12; el = el.parentElement, i++) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.15) return false;
    }
    return true;
  }
  function videoAt(x, y) {
    let best = null;
    for (const v of document.querySelectorAll('video')) {
      if (v.controls) continue; // o vídeo já mostra os controles do navegador
      const r = v.getBoundingClientRect();
      if (r.width < 140 || r.height < 90) continue;
      if (!(x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) continue;
      if (!isShown(v)) continue;
      if (!flags.mediaAll && hasOwnTimeline(v)) continue; // o site já tem linha do tempo para este vídeo
      let score = 0;
      if (!v.paused && !v.ended) score += 1000;              // tocando agora
      if (v.readyState >= 2) score += 300;                    // tem imagem carregada
      if (v.currentTime > 0) score += 100;                    // já começou
      if (v === cur) score += 50;                             // evita ficar trocando à toa
      score += Math.min(r.width * r.height, 2000000) / 10000; // maior vence entre iguais
      if (!best || score > best.score) best = { v, score };
    }
    return best ? best.v : null;
  }

  let lastMouse = null;
  let pendingVideo = null;
  let pendingTimer = 0;
  window.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (dragging) return;
    const v = videoAt(e.clientX, e.clientY);
    if (v) {
      if (visible && v === cur) { show(); scheduleHide(); return; }
      // vídeo novo (ou barra escondida): espera 350 ms e confere de novo se o site mostrou controles próprios
      if (pendingVideo !== v) {
        pendingVideo = v;
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          const pv = pendingVideo;
          pendingVideo = null;
          if (!pv || !pv.isConnected || !lastMouse) return;
          if (!flags.mediaAll && hasOwnTimeline(pv, true)) return;
          if (videoAt(lastMouse.x, lastMouse.y) !== pv) return;
          if (pv !== cur) { cur = pv; lastVol = pv.volume || lastVol; watch(pv); reapply(pv); obst = { v: null, t: 0, bottom: 0, w: 0, lift: 0 }; }
          show();
          scheduleHide();
        }, 350);
      }
    } else {
      pendingVideo = null;
      clearTimeout(pendingTimer);
      if (!overBar && visible) scheduleHide();
    }
  }, { passive: true, capture: true });
  document.addEventListener('mouseleave', () => { if (!dragging) hide(false); }, { passive: true });
  window.addEventListener('blur', () => { if (!dragging) hide(true); });
})();
