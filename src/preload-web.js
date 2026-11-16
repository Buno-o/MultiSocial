// Preload injetado nas páginas das redes sociais.
// Faz o clique numa notificação trazer o MultiSocial para frente na aba certa.
const { ipcRenderer, webFrame } = require('electron');

let flags = {};
try { flags = ipcRenderer.sendSync('web:flags') || {}; } catch (e) {}

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
