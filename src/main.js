// MultiSocial — processo principal
const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, dialog, shell,
  session, nativeImage, Notification, clipboard, net, powerMonitor
} = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const SERVICES = require('./services');
const store = require('./store');

// ---------------------------------------------------------------------------
// Inicialização básica
// ---------------------------------------------------------------------------
app.setName('MultiSocial');
const cfg = store.init(app.getPath('userData'));
if (!cfg.hwAccel) app.disableHardwareAcceleration();
// Microfone no Windows: por padrão o Chromium captura em modo "RAW", que pula o processamento
// do driver/Windows (redução de ruído do Realtek, Conexant, Waves etc.). Isso deixa um chiado
// que o Gravador do Windows não tem. Desligando o RAW, o app recebe o mesmo áudio tratado.
if (cfg.micDriverProcessing !== false) app.commandLine.appendSwitch('disable-features', 'WASAPIRawAudioCapture');
app.setAppUserModelId('com.buno.multisocial');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// User agent de Chrome "puro" (WhatsApp Web e outros bloqueiam o UA do Electron)
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = UA;
// UA de Firefox para login do Google (o Google bloqueia login em apps com UA de Chrome embutido)
const FF_VER = 140 + Math.max(0, Math.floor((Date.now() - Date.UTC(2025, 5, 24)) / (28 * 864e5)));
const FF_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FF_VER}.0) Gecko/20100101 Firefox/${FF_VER}.0`;
const UPDATE_REPO = 'Buno-o/MultiSocial';

const ASSETS = path.join(__dirname, 'assets');
const ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const WEB_PRELOAD = path.join(__dirname, 'preload-web.js');
const TAB_H = 40;   // altura da barra de abas
const FIND_H = 40;  // altura da barra de busca

const THEMES = {
  dark:  { bar: '#14161d', symbol: '#e8e8ee', bg: '#0e1016' },
  light: { bar: '#e9ecf2', symbol: '#1d2230', bg: '#f5f6fa' }
};

let win = null;
let tray = null;
let quitting = false;
let tabs = [];            // { id, type:'service'|'settings', serviceId, view, title, favicon, badge, loading, muted, audible }
let activeId = 'home';
let nextTabId = 1;
let findOpen = false;
let fullscreenTab = null;
const closedStack = [];
const pendingSaveAs = new Set();
const downloads = [];
let dlCounter = 0;

// ---------------------------------------------------------------------------
// Log de diagnóstico (%APPDATA%\MultiSocial\logs\multisocial.log)
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'multisocial.log');
function log(...args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}
log('--- MultiSocial', app.getVersion(), 'Electron', process.versions.electron, 'Chrome', process.versions.chrome, process.platform, require('os').release());
app.on('child-process-gone', (_e, d) => {
  log('processo filho encerrou', d);
  if (d && d.type === 'GPU') {
    setTimeout(() => { for (const t of tabs) t.shown = false; try { layout(); } catch {} }, 1500);
  }
});
process.on('uncaughtException', (e) => log('erro não tratado', String(e && e.stack || e)));

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function allServices() {
  return [...SERVICES, ...(store.get('custom') || [])];
}
function getService(id) {
  return allServices().find((s) => s.id === id);
}
// ---- domínios: o que é "da rede" e o que deve abrir no navegador padrão
const MULTI_TLD = new Set(['com', 'net', 'org', 'co', 'gov', 'edu', 'ac', 'or', 'ne']);
function baseDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = parts.length;
  if (parts[n - 1].length === 2 && MULTI_TLD.has(parts[n - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
// páginas de login de terceiros que precisam continuar dentro do app
const AUTH_HOSTS = ['accounts.google.com', 'accounts.youtube.com', 'appleid.apple.com', 'login.live.com',
  'login.microsoftonline.com', 'account.live.com', 'auth.openai.com', 'challenges.cloudflare.com', 'github.com'];
const AUTH_PATHS = [['facebook.com', '/dialog/'], ['facebook.com', '/login'], ['x.com', '/i/oauth2'], ['twitter.com', '/i/oauth2'],
  ['discord.com', '/oauth2'], ['google.com', '/signin'], ['google.com', '/o/oauth2']];
function serviceDomains(serviceId) {
  const svc = getService(serviceId);
  if (!svc) return [];
  const list = new Set((svc.domains || []).map((d) => d.toLowerCase()));
  try { list.add(baseDomain(new URL(svc.url).hostname)); } catch {}
  return [...list];
}
function isInternal(serviceId, url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (!/^https?:$/.test(u.protocol)) return true;
  const host = u.hostname.toLowerCase();
  if (AUTH_HOSTS.includes(host)) return true;
  const base = baseDomain(host);
  if (AUTH_PATHS.some(([d, p]) => base === d && u.pathname.startsWith(p))) return true;
  return serviceDomains(serviceId).some((d) => host === d || host.endsWith('.' + d));
}
// desembrulha links "l.facebook.com/l.php?u=...", "google.com/url?q=..." etc.
function unwrapLink(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (/^(l|lm)\.(facebook|instagram|messenger)\.com$/.test(h) || (/(^|\.)google\.[a-z.]+$/.test(h) && u.pathname === '/url') ||
        (/youtube\.com$/.test(h) && u.pathname === '/redirect') || h === 'out.reddit.com' || h === 'href.li') {
      const t = u.searchParams.get('u') || u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('target');
      if (t && /^https?:/i.test(t)) return t;
    }
  } catch {}
  return url;
}
// Domínios "largos" usados por vários serviços: só contam pelo endereço exato (ex.: mail.google.com, gemini.google.com)
const SHARED_BASES = new Set(['google.com', 'microsoft.com', 'live.com', 'bing.com']);
// Qual rede cadastrada no app é dona deste link? (null = site externo)
function ownerOf(url, fromServiceId) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const base = baseDomain(host);
  let best = null;
  let bestScore = 0;
  for (const svc of allServices()) {
    let score = 0;
    let ph = '';
    try { ph = new URL(svc.url).hostname.toLowerCase(); } catch { continue; }
    const pbase = baseDomain(ph);
    if (host === ph || host.endsWith('.' + ph)) score = 3;
    else if (base === pbase && !SHARED_BASES.has(base)) score = 2;
    else if (serviceDomains(svc.id).some((d) => !SHARED_BASES.has(d) && (host === d || host.endsWith('.' + d)))) score = 1; // domínios alternativos (youtu.be, twitter.com, t.me...)
    if (score > bestScore || (score === bestScore && score > 0 && svc.id === fromServiceId)) { best = svc.id; bestScore = score; }
  }
  return best;
}
// Abre um link que saiu de uma rede: rede cadastrada -> nova aba no app; externo -> navegador padrão
function routeLink(url, fromServiceId, afterId, background) {
  const real = unwrapLink(url);
  const owner = ownerOf(real, fromServiceId);
  if (owner) {
    const t = createServiceTab(owner, real, { activate: !background, afterId });
    if (t && background) ensureView(t);
    return 'app';
  }
  openInBrowser(real);
  return 'browser';
}

function openInBrowser(url) {
  const t = unwrapLink(url);
  shell.openExternal(t).catch(() => {});
}
function tabUrl(t) {
  if (t.view && !t.view.webContents.isDestroyed()) {
    const u = t.view.webContents.getURL();
    if (/^https?:/i.test(u)) return u;
  }
  return t.url || '';
}

// Cada rede usa uma pasta própria. Ao "Sair da conta", a rede passa a usar uma pasta nova
// (nova geração) e a antiga é apagada do disco — sem ir para a Lixeira.
const PARTITIONS_DIR = path.join(app.getPath('userData'), 'Partitions');
function partitionName(serviceId) {
  const g = (store.get('gen') || {})[serviceId] || 0;
  return g ? `ms-${serviceId}-g${g}` : `ms-${serviceId}`;
}
function wipeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {}
  return !fs.existsSync(dir);
}
function wipePending() {
  const pending = store.get('pendingWipe') || [];
  const left = pending.filter((name) => !wipeDir(path.join(PARTITIONS_DIR, name)));
  store.set('pendingWipe', left);
  if (pending.length) log('dados apagados do disco:', pending.length - left.length, 'pendentes:', left.length);
}
function getSession(serviceId) {
  const ses = session.fromPartition(`persist:${partitionName(serviceId)}`);
  setupSession(ses, serviceId);
  return ses;
}
function downloadDir() {
  const d = store.get('downloadDir') || path.join(app.getPath('downloads'), 'MultiSocial');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function uniquePath(dir, name) {
  name = (name || 'arquivo').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}
function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png'), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}
function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
}
function tabByWc(wc) {
  return tabs.find((t) => t.view && t.view.webContents === wc);
}
function activeTab() {
  return tabs.find((t) => t.id === activeId);
}
function activeWc() {
  const t = activeTab();
  return t && t.view ? t.view.webContents : null;
}

// ---------------------------------------------------------------------------
// Sessões (uma por rede = login separado e persistente)
// ---------------------------------------------------------------------------
// Permitidas sem perguntar (inofensivas)
const ALLOWED_PERMS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'mediaKeySystem', 'speaker-selection']);
// Perguntam ao usuário (resposta lembrada por rede)
const ASK_PERMS = {
  media: 'usar sua câmera e/ou microfone',
  'display-capture': 'gravar/compartilhar a sua tela',
  'clipboard-read': 'ler a sua área de transferência',
  geolocation: 'saber a sua localização'
};
function permKey(perm, details) {
  if (perm !== 'media') return perm;
  const t = (details && details.mediaTypes) || [];
  return t.includes('video') ? 'media-video' : 'media-audio';
}
const permQueue = new Map();
async function askPermission(serviceId, perm, details) {
  const key = permKey(perm, details);
  const saved = ((store.get('perms') || {})[serviceId] || {})[key];
  if (saved === true || saved === false) return saved;
  const qk = serviceId + '|' + key;
  if (permQueue.has(qk)) return permQueue.get(qk);
  const p = (async () => {
    const svc = getService(serviceId);
    const what = key === 'media-video' ? 'usar sua câmera e microfone' : key === 'media-audio' ? 'usar seu microfone' : ASK_PERMS[perm];
    log('pedido de permissão', serviceId, key);
    // a pergunta trava a janela até ser respondida: garante que ela apareça na frente
    showMain();
    try { win.moveTop(); } catch {}
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Permissão',
      message: `${svc ? svc.name : 'Este site'} quer ${what}.`,
      detail: details && details.requestingUrl ? `Site: ${new URL(details.requestingUrl).hostname}` : '',
      buttons: ['Permitir', 'Bloquear'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: 'Lembrar minha escolha para esta rede',
      checkboxChecked: true,
      noLink: true
    });
    const ok = r.response === 0;
    if (r.checkboxChecked) {
      const all = store.get('perms') || {};
      all[serviceId] = { ...(all[serviceId] || {}), [key]: ok };
      store.set('perms', all);
    }
    return ok;
  })();
  permQueue.set(qk, p);
  try { return await p; } finally { permQueue.delete(qk); }
}
function stripClientHints(headers, ua) {
  for (const k of Object.keys(headers)) if (/^sec-ch-ua/i.test(k)) delete headers[k];
  headers['User-Agent'] = ua;
  return headers;
}
function setupSession(ses, serviceId) {
  if (ses.__ms) return;
  ses.__ms = true;
  const svc = getService(serviceId);
  if (svc && svc.ua === 'firefox') {
    // sessão inteira se passa por Firefox (Gmail / Google)
    ses.setUserAgent(FF_UA);
    ses.webRequest.onBeforeSendHeaders((d, cb) => cb({ requestHeaders: stripClientHints(d.requestHeaders, FF_UA) }));
  } else {
    ses.setUserAgent(UA);
    // "Entrar com Google" dentro de outras redes
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (d, cb) =>
      cb({ requestHeaders: stripClientHints(d.requestHeaders, FF_UA) }));
  }
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (perm === 'notifications') return cb(!!store.get('notifications'));
    if (ALLOWED_PERMS.has(perm)) return cb(true);
    if (ASK_PERMS[perm]) { askPermission(serviceId, perm, details).then(cb, () => cb(false)); return; }
    cb(false);
  });
  ses.setPermissionCheckHandler((_wc, perm, _origin, details) => {
    if (perm === 'notifications') return !!store.get('notifications');
    if (ALLOWED_PERMS.has(perm)) return true;
    if (ASK_PERMS[perm]) {
      const saved = (store.get('perms') || {})[serviceId] || {};
      // "ainda não decidido" conta como disponível para o site tentar; o pedido real abre a pergunta
      if (perm === 'media') return saved['media-video'] !== false || saved['media-audio'] !== false;
      return saved[perm] !== false;
    }
    return false;
  });
  // Compartilhar tela (Discord, Meet...): só depois de o usuário permitir
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    if (!(await askPermission(serviceId, 'display-capture'))) return cb({});
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb(sources[0] ? { video: sources[0] } : {});
  });
  try { ses.setSpellCheckerLanguages(['pt-BR', 'en-US']); } catch {}
  ses.on('will-download', onWillDownload);
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function onWillDownload(_e, item) {
  const url = item.getURL();
  const ask = pendingSaveAs.has(url) || store.get('askDownload');
  pendingSaveAs.delete(url);
  const name = item.getFilename();
  if (ask) {
    item.setSaveDialogOptions({ title: 'Salvar como', defaultPath: path.join(downloadDir(), name) });
  } else {
    item.setSavePath(uniquePath(downloadDir(), name));
  }
  const d = { id: ++dlCounter, name, received: 0, total: item.getTotalBytes(), state: 'progressing', path: '', item };
  downloads.unshift(d);
  if (downloads.length > 15) downloads.pop();
  item.on('updated', (_ev, state) => {
    d.state = state;
    d.received = item.getReceivedBytes();
    d.total = item.getTotalBytes();
    if (item.getSavePath()) d.name = path.basename(item.getSavePath());
    sendDownloads();
  });
  item.once('done', (_ev, state) => {
    d.state = state;
    d.path = item.getSavePath();
    d.name = d.path ? path.basename(d.path) : d.name;
    d.item = null;
    sendDownloads();
    if (state === 'completed') {
      notify('Download concluído', d.name, () => shell.showItemInFolder(d.path));
    } else if (state === 'interrupted') {
      notify('Download falhou', d.name);
    }
  });
  sendDownloads();
}
function sendDownloads() {
  const active = downloads.filter((d) => d.state === 'progressing');
  let progress = -1;
  if (active.length) {
    const tot = active.reduce((a, d) => a + (d.total || 0), 0);
    const rec = active.reduce((a, d) => a + (d.received || 0), 0);
    progress = tot > 0 ? rec / tot : 2; // 2 = indeterminado
  }
  if (win && !win.isDestroyed()) win.setProgressBar(progress < 0 ? -1 : (progress > 1 ? 2 : progress));
  send('downloads', { active: active.length, progress, count: downloads.length });
}
function downloadsMenu() {
  const items = downloads.length
    ? downloads.map((d) => {
      let label = d.name;
      if (d.state === 'progressing') {
        const pct = d.total ? Math.round((d.received / d.total) * 100) + '%' : '…';
        label = `⏳ ${d.name}  (${pct})`;
      } else if (d.state === 'completed') label = `✔ ${d.name}`;
      else label = `✖ ${d.name}`;
      return {
        label,
        submenu: [
          { label: 'Abrir', enabled: d.state === 'completed', click: () => shell.openPath(d.path) },
          { label: 'Mostrar na pasta', enabled: d.state === 'completed', click: () => shell.showItemInFolder(d.path) },
          { label: 'Cancelar', enabled: d.state === 'progressing' && !!d.item, click: () => d.item && d.item.cancel() }
        ]
      };
    })
    : [{ label: 'Nenhum download ainda', enabled: false }];
  items.push({ type: 'separator' });
  items.push({ label: 'Abrir pasta de downloads', click: () => shell.openPath(downloadDir()) });
  items.push({
    label: 'Limpar lista', enabled: downloads.some((d) => d.state !== 'progressing'), click: () => {
      for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
      sendDownloads();
    }
  });
  Menu.buildFromTemplate(items).popup({ window: win });
}
function saveUrlAs(wc, url) {
  pendingSaveAs.add(url);
  wc.downloadURL(url);
}

// ---------------------------------------------------------------------------
// Janela principal
// ---------------------------------------------------------------------------
function createMainWindow() {
  const theme = THEMES[store.get('theme')] || THEMES.dark;
  const b = store.get('windowBounds') || { width: 1280, height: 820 };
  win = new BrowserWindow({
    ...b,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'MultiSocial',
    icon: ICON,
    backgroundColor: theme.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: theme.bar, symbolColor: theme.symbol, height: TAB_H },
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true
    }
  });
  if (store.get('maximized')) win.maximize();
  applyTaskbarIdentity();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.removeMenu();

  const startHidden = process.argv.includes('--hidden') || store.get('startMinimized');
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  win.on('resize', layout);
  // janela minimizada ou na bandeja também conta como "segundo plano"
  win.on('minimize', () => { pauseIfNotBg(activeTab()); if (hasPin() && store.get('lockOnHide')) lockApp(); });
  win.on('hide', () => { pauseIfNotBg(activeTab()); if (hasPin() && store.get('lockOnHide')) lockApp(); });
  // ao voltar da bandeja/minimizado, força o redesenho da aba atual
  const redraw = () => { const t = activeTab(); if (t) t.shown = false; layout(); };
  win.on('show', redraw);
  win.on('restore', redraw);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', () => {
    if (fullscreenTab) {
      const t = fullscreenTab; fullscreenTab = null;
      try { t.view.webContents.executeJavaScript('document.fullscreenElement && document.exitFullscreen()'); } catch {}
    }
    send('fullscreen', false);
    layout();
  });
  win.on('focus', () => {
    win.flashFrame(false);
    const at = activeTab();
    if (at && at.view && !locked) { try { at.view.webContents.invalidate(); } catch {} }
    if (locked) { focusPinField(); return; }
    const wc = activeWc();
    if (wc && !findOpen) wc.focus();
  });
  win.on('show', () => { if (locked) focusPinField(); });
  win.on('restore', () => { if (locked) focusPinField(); });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    store.set('maximized', win.isMaximized());
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) store.set('windowBounds', win.getBounds());
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);

  win.webContents.on('before-input-event', (e, input) => {
    if (handleShortcut(input)) e.preventDefault();
  });

  win.on('close', async (e) => {
    saveBounds();
    if (quitting) return;
    e.preventDefault();
    let action = store.get('closeAction');
    if (!action) {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'MultiSocial',
        message: 'Deseja minimizar o MultiSocial para a bandeja do sistema?',
        detail: 'Minimizado na bandeja, o MultiSocial continua aberto em segundo plano e você segue recebendo as notificações das suas redes.\n\nEssa pergunta só aparece agora. Você pode mudar isso depois em Configurações.',
        buttons: ['Minimizar para a bandeja', 'Fechar o programa', 'Cancelar'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (r.response === 2) return;
      action = r.response === 0 ? 'tray' : 'quit';
      store.set('closeAction', action);
      sendConfig();
    }
    if (action === 'tray') {
      win.hide();
      if (!store.get('trayBalloonShown') && tray && process.platform === 'win32') {
        store.set('trayBalloonShown', true);
        try {
          tray.displayBalloon({
            title: 'MultiSocial continua aberto',
            content: 'Clique no ícone da bandeja para voltar. Para sair, clique com o botão direito > Sair.',
            iconType: 'info'
          });
        } catch {}
      }
    } else {
      quitApp();
    }
  });
}

// Faz o ícone fixado na barra de tarefas e a janela aberta serem o MESMO ícone.
// No portátil, o .exe que roda é uma cópia temporária; aqui dizemos ao Windows qual .exe relançar.
function applyTaskbarIdentity() {
  if (process.platform !== 'win32') return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    win.setAppDetails({
      appId: 'com.buno.multisocial',
      appIconPath: exe,
      appIconIndex: 0,
      relaunchCommand: `"${exe}"`,
      relaunchDisplayName: 'MultiSocial'
    });
  } catch (e) { log('setAppDetails falhou', String(e)); }
  // atalho no Menu Iniciar com o mesmo ID (o instalador já cria o dele)
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    try {
      const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'MultiSocial.lnk');
      const opts = { target: exe, appUserModelId: 'com.buno.multisocial', icon: exe, iconIndex: 0, description: 'MultiSocial' };
      let same = false;
      try { const cur = shell.readShortcutLink(lnk); same = cur.target === exe && cur.appUserModelId === 'com.buno.multisocial'; } catch {}
      if (!same) shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', opts);
    } catch (e) { log('atalho do Menu Iniciar falhou', String(e)); }
  }
}

// Bloqueado: o foco do teclado vai direto para o campo do PIN (é só digitar e dar Enter)
function focusPinField() {
  if (!win || win.isDestroyed()) return;
  // Só foca com a janela em primeiro plano: focar uma janela em segundo plano faz o Windows
  // destacar o ícone na barra de tarefas pedindo atenção.
  const doIt = () => {
    if (!locked || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) return;
    win.webContents.focus();
    send('lock:focus');
  };
  doIt();
  setTimeout(doIt, 120);
}

function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  saveTabs();
  store.saveNow();
  app.quit();
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = fullscreenTab ? 0 : TAB_H + (findOpen ? FIND_H : 0);
  for (const t of tabs) {
    if (!t.view) continue;
    if (t.id === activeId && !locked) {
      const mob = isMobile(t.serviceId) && !fullscreenTab;
      const vw = mob ? Math.min(w, 430) : w;
      const bounds = { x: Math.floor((w - vw) / 2), y: top, width: vw, height: Math.max(0, h - top) };
      if (!t.shown) {
        // Contorno de bug do Electron: uma aba que ficou oculta pode voltar em branco
        // até a janela ser redimensionada. Mostramos com 1px a menos e corrigimos em seguida.
        t.shown = true;
        t.view.setBounds({ ...bounds, height: Math.max(0, bounds.height - 1) });
        t.view.setVisible(true);
        setTimeout(() => {
          if (t.view && activeId === t.id && !t.view.webContents.isDestroyed()) {
            layout();
            try { t.view.webContents.invalidate(); } catch {}
          }
        }, 30);
      } else {
        t.view.setBounds(bounds);
        t.view.setVisible(true);
      }
    } else {
      t.view.setVisible(false);
      t.shown = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------
function tabInfo(t) {
  const svc = t.serviceId ? getService(t.serviceId) : null;
  return {
    id: t.id,
    type: t.type,
    serviceId: t.serviceId,
    name: t.type === 'settings' ? 'Configurações' : (svc ? svc.name : 'Aba'),
    title: t.title || '',
    favicon: t.favicon || (t.serviceId && serviceIcon(t.serviceId)) || '',
    badge: t.badge || 0,
    loading: !!t.loading,
    muted: !!t.muted,
    audible: !!t.audible,
    url: t.type === 'service' ? tabUrl(t) : '',
    canBack: t.view ? t.view.webContents.navigationHistory.canGoBack() : false,
    canForward: t.view ? t.view.webContents.navigationHistory.canGoForward() : false,
    suspended: t.type === 'service' && !t.view,
    mobile: t.type === 'service' && isMobile(t.serviceId),
    color: svc ? svc.color : null,
    glyph: svc ? svc.glyph : '',
    dark: svc ? !!svc.dark : false
  };
}

let sendTabsTimer = null;
function sendTabs() {
  clearTimeout(sendTabsTimer);
  sendTabsTimer = setTimeout(() => {
    send('tabs', { active: activeId, tabs: tabs.map(tabInfo) });
    updateBadges();
    saveTabs();
  }, 16);
}

function saveTabs() {
  store.set('lastTabs', tabs.filter((t) => t.type === 'service').map((t) => ({
    serviceId: t.serviceId,
    url: tabUrl(t)
  })));
}

function createServiceTab(serviceId, url, opts = {}) {
  const svc = getService(serviceId);
  if (!svc) return null;
  const tab = { id: nextTabId++, type: 'service', serviceId, view: null, url: url || svc.url, title: svc.name, favicon: '', badge: 0, loading: false, lastActive: Date.now() };
  const idx = opts.afterId ? tabs.findIndex((t) => t.id === opts.afterId) + 1 : tabs.length;
  tabs.splice(idx > 0 ? idx : tabs.length, 0, tab);
  // lazy: só cria a página quando a aba for aberta (economiza RAM e acelera a abertura do app)
  if (!opts.lazy || opts.activate !== false) ensureView(tab);
  if (opts.activate !== false) activateTab(tab.id);
  else { layout(); sendTabs(); }
  return tab;
}

function ensureView(tab) {
  if (tab.view) return tab.view;
  const svc = getService(tab.serviceId);
  const serviceId = tab.serviceId;
  const ses = getSession(serviceId);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: WEB_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true
    }
  });
  view.setBackgroundColor('#ffffff');
  tab.view = view;
  tab.loading = true;
  tab.shown = false;
  view.setVisible(false);
  win.contentView.addChildView(view);
  wireWebContents(view.webContents, { serviceId, tab });
  applyUserAgent(view.webContents, serviceId);

  view.webContents.on('did-finish-load', () => {
    const zoom = (store.get('zoom') || {})[serviceId];
    if (zoom) view.webContents.setZoomFactor(zoom);
  });
  view.webContents.loadURL(tab.url || svc.url).catch(() => {});
  return view;
}

// Aba que ficou muito tempo escondida: confere se a página ainda responde; se não, recria
async function healthCheck(tab) {
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (wc.isCrashed()) { recreateTab(tab, true); return; }
  const ok = await Promise.race([
    wc.executeJavaScript('1').then(() => true).catch(() => false),
    new Promise((r) => setTimeout(() => r(false), 4000))
  ]);
  if (!ok && tab.view && tab.view.webContents === wc) {
    log('aba não respondeu ao voltar, recriando', tab.serviceId);
    recreateTab(tab, true);
  } else if (ok && tab.id === activeId) {
    tab.shown = false;
    layout();
  }
}

// Fecha e recria a página da aba do zero (corrige página travada ou em branco)
function recreateTab(tab, hung) {
  if (!tab || tab.type !== 'service') return;
  tab.url = tabUrl(tab);
  if (tab.view) {
    const v = tab.view;
    tab.view = null;
    try { win.contentView.removeChildView(v); } catch {}
    // página travada: derruba o processo dela na hora (fechar normalmente esperaria a página responder)
    if (hung) { try { v.webContents.forcefullyCrashRenderer(); } catch {} }
    try { v.webContents.close(); } catch {}
  }
  log('aba recriada', tab.serviceId);
  ensureView(tab);
  layout();
  sendTabs();
}

// Suspende a aba: fecha a página (libera a RAM) mas mantém a aba na barra
function suspendTab(tab) {
  if (!tab.view || tab.id === activeId) return;
  tab.url = tabUrl(tab);
  const v = tab.view;
  tab.view = null;
  tab.loading = false;
  tab.audible = false;
  try { win.contentView.removeChildView(v); } catch {}
  try { v.webContents.close(); } catch {}
  log('aba suspensa', tab.serviceId);
  sendTabs();
}
function keepAlive(serviceId) {
  const o = (store.get('alive') || {})[serviceId];
  if (o === true || o === false) return o;
  const svc = getService(serviceId);
  return !!(svc && svc.alive);
}
function hibernateTick() {
  const min = Number(store.get('suspendMinutes')) || 0;
  if (!min) return;
  const now = Date.now();
  for (const t of tabs) {
    if (t.type !== 'service' || !t.view || t.id === activeId) continue;
    if (keepAlive(t.serviceId) || t.audible) continue;
    if (now - (t.lastActive || now) > min * 60000) suspendTab(t);
  }
}

// ---- modo celular
function isMobile(serviceId) { return !!(store.get('mobile') || {})[serviceId]; }
const MOBILE_UA = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Mobile Safari/537.36`;
function applyUserAgent(wc, serviceId) {
  const svc = getService(serviceId);
  wc.setUserAgent(isMobile(serviceId) ? MOBILE_UA : (svc && svc.ua === 'firefox' ? FF_UA : UA));
}
function toggleMobile(serviceId) {
  if (!serviceId) return;
  const m = { ...(store.get('mobile') || {}) };
  m[serviceId] = !m[serviceId];
  if (!m[serviceId]) delete m[serviceId];
  store.set('mobile', m);
  for (const t of tabs.filter((x) => x.serviceId === serviceId && x.view)) {
    applyUserAgent(t.view.webContents, serviceId);
    t.view.webContents.reload();
  }
  layout();
  sendTabs();
}

// ---- abrir uma nova guia no navegador padrão do sistema
function openBrowserNewTab() {
  const fallback = () => shell.openExternal('https://www.google.com/').catch(() => {});
  if (process.platform !== 'win32') return fallback();
  execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { windowsHide: true }, (err, out) => {
    const progId = !err && (/ProgId\s+REG_SZ\s+(\S+)/i.exec(out) || [])[1];
    if (!progId) return fallback();
    execFile('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], { windowsHide: true }, (e2, o2) => {
      const cmd = !e2 && ((/REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(o2) || [])[1] || '').trim();
      const exe = cmd && ((/^"([^"]+)"/.exec(cmd) || [])[1] || cmd.split(/\s+/)[0]);
      if (!exe || !fs.existsSync(exe)) return fallback();
      const name = path.basename(exe).toLowerCase();
      let args = [];
      if (name.includes('firefox') || name.includes('librewolf') || name.includes('waterfox') || name.includes('zen')) args = ['-new-tab', 'about:newtab'];
      else if (name.includes('msedge')) args = ['edge://newtab'];
      else if (/chrome|brave|vivaldi|chromium|thorium|yandex|cent/.test(name)) args = ['chrome://newtab'];
      try {
        spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
      } catch { fallback(); }
    });
  });
}

// ---- logo de cada rede (busca a logo no próprio site; evita ficar com a logo do Google)
function serviceIcon(serviceId) {
  const svc = getService(serviceId);
  if (!svc) return '';
  return (store.get('iconBest') || {})[serviceId] || svc.icon || (store.get('icons') || {})[serviceId] || (store.get('favicons') || {})[serviceId] || '';
}
async function refreshServiceIcons(force) {
  const week = 7 * 864e5;
  if (!force && Date.now() - (store.get('iconsFetchedAt') || 0) < week) {
    const icons = store.get('icons') || {};
    if (SERVICES.every((s) => s.icon || icons[s.id])) return;
  }
  const icons = { ...(store.get('icons') || {}) };
  for (const s of SERVICES) {
    if (s.icon || (!force && icons[s.id])) continue;
    const r = await fetchSiteIconChecked(s.url, s.id);
    if (r) { icons[s.id] = r; store.set('icons', { ...icons }); sendConfig(); }
  }
  store.set('iconsFetchedAt', Date.now());
}

function openSettingsTab() {
  let t = tabs.find((x) => x.type === 'settings');
  if (!t) {
    t = { id: nextTabId++, type: 'settings', title: 'Configurações' };
    tabs.push(t);
  }
  activateTab(t.id);
}

function openService(serviceId, opts = {}) {
  if (!opts.newTab) {
    const existing = tabs.find((t) => t.serviceId === serviceId);
    if (existing) { activateTab(existing.id); return; }
  }
  createServiceTab(serviceId, opts.url, { activate: !opts.background });
}

function pauseVideos(wc) {
  const code = `document.querySelectorAll('video').forEach((v) => { if (!v.paused && document.pictureInPictureElement !== v) v.pause(); })`;
  try {
    for (const f of wc.mainFrame.framesInSubtree) f.executeJavaScript(code).catch(() => {});
  } catch {}
}

function bgAllowed(serviceId) {
  const o = (store.get('bgPlay') || {})[serviceId];
  if (o === true || o === false) return o;
  const svc = getService(serviceId);
  return !!(svc && svc.bg);
}
function setBgPlay(serviceId, value) {
  store.set('bgPlay', { ...(store.get('bgPlay') || {}), [serviceId]: !!value });
  sendConfig();
}
function pauseIfNotBg(t) {
  if (t && t.view && !bgAllowed(t.serviceId)) pauseVideos(t.view.webContents);
}

function activateTab(id) {
  if (id !== 'home' && !tabs.find((t) => t.id === id)) id = 'home';
  const prev = activeTab();
  if (prev && prev.id !== id) { pauseIfNotBg(prev); prev.lastActive = Date.now(); }
  const next = tabs.find((t) => t.id === id);
  if (next && next.type === 'service') {
    const hiddenFor = Date.now() - (next.lastActive || Date.now());
    next.lastActive = Date.now();
    const existed = !!next.view;
    ensureView(next);
    if (existed && hiddenFor > 3 * 60000) healthCheck(next);
  }
  if (findOpen) closeFind();
  activeId = id;
  layout();
  const t = activeTab();
  if (t && t.view && t.view.webContents.isCrashed()) { log('aba travada ao ativar, recarregando', t.serviceId); t.view.webContents.reload(); }
  if (t && t.view && !locked) t.view.webContents.focus();
  else if (win) win.webContents.focus();
  sendTabs();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const t = tabs[idx];
  if (t.type === 'service') {
    closedStack.push({ serviceId: t.serviceId, url: tabUrl(t) });
    if (closedStack.length > 20) closedStack.shift();
  }
  tabs.splice(idx, 1);
  if (t.view) {
    win.contentView.removeChildView(t.view);
    try { t.view.webContents.close(); } catch {}
  }
  if (fullscreenTab === t) { fullscreenTab = null; win.setFullScreen(false); }
  if (activeId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    activateTab(next ? next.id : 'home');
  } else sendTabs();
}

function reopenClosed() {
  const c = closedStack.pop();
  if (c) createServiceTab(c.serviceId, c.url || undefined);
}

function cycleTab(dir) {
  const ids = ['home', ...tabs.map((t) => t.id)];
  const i = ids.indexOf(activeId);
  activateTab(ids[(i + dir + ids.length) % ids.length]);
}

function goToIndex(n) {
  // Ctrl+1 = início, Ctrl+2.. = abas, Ctrl+9 = última aba
  if (n === 1) return activateTab('home');
  if (n === 9) return activateTab(tabs.length ? tabs[tabs.length - 1].id : 'home');
  const t = tabs[n - 2];
  if (t) activateTab(t.id);
}

function moveTabToWindow(t, pos) {
  if (!t || t.type !== 'service') return;
  const url = tabUrl(t);
  const sid = t.serviceId;
  closeTab(t.id);
  closedStack.pop();
  openWindow(url, sid, pos ? { x: Math.round(pos.x - 120), y: Math.round(pos.y - 16) } : {});
}

// Aba arrastada e solta fora da barra de abas (ou fora da janela): vira uma janela independente
function detachTab(id, screenX, screenY) {
  const t = tabs.find((x) => x.id === id);
  if (!t || t.type !== 'service') return;
  const b = win.getBounds();
  const inside = screenX >= b.x && screenX <= b.x + b.width && screenY >= b.y && screenY <= b.y + b.height;
  const inTabBar = inside && screenY <= b.y + TAB_H + 14;
  if (inTabBar) return;
  log('aba destacada em janela', t.serviceId);
  moveTabToWindow(t, { x: screenX, y: screenY });
}

// ---------------------------------------------------------------------------
// Badges / bandeja
// ---------------------------------------------------------------------------
let lastBadgeTotal = 0;
let overlayImg = null;
function updateBadges() {
  const total = tabs.reduce((a, t) => a + (t.badge || 0), 0);
  if (tray) tray.setToolTip(total ? `MultiSocial — ${total} não lida(s)` : 'MultiSocial');
  if (win && process.platform === 'win32') {
    if (!overlayImg) overlayImg = nativeImage.createFromPath(path.join(ASSETS, 'badge.png'));
    win.setOverlayIcon(total ? overlayImg : null, total ? `${total} não lidas` : '');
  }
  if (total > lastBadgeTotal && win && !win.isFocused() && store.get('flashTaskbar')) win.flashFrame(true);
  lastBadgeTotal = total;
  rebuildTrayMenu();
}

function parseBadge(title) {
  const m = /\((\d+)\+?\)/.exec(title || '');
  return m ? parseInt(m[1], 10) : 0;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setToolTip('MultiSocial');
  tray.on('click', () => {
    if (win.isVisible() && win.isFocused()) win.hide();
    else showMain();
  });
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const open = tabs.filter((t) => t.type === 'service').map((t) => {
    const s = getService(t.serviceId);
    return { label: `${s ? s.name : 'Aba'}${t.badge ? `  (${t.badge})` : ''}`, click: () => { showMain(); activateTab(t.id); } };
  });
  const tpl = [
    { label: 'Abrir MultiSocial', click: showMain },
    { type: 'separator' },
    ...(open.length ? [...open, { type: 'separator' }] : []),
    ...(hasPin() ? [{ label: locked ? 'Bloqueado' : 'Bloquear agora', enabled: !locked, click: lockApp }] : []),
    { label: 'Configurações', click: () => { showMain(); openSettingsTab(); } },
    { label: 'Verificar atualizações', click: () => { showMain(); checkForUpdates(true); } },
    { label: 'Sair', click: quitApp }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(tpl));
}

// ---------------------------------------------------------------------------
// Janelas extras (nova janela / mini janela flutuante)
// ---------------------------------------------------------------------------
function openWindow(url, serviceId, opts = {}) {
  const ses = getSession(serviceId);
  const svc = getService(serviceId);
  const w = new BrowserWindow({
    width: opts.mini ? 520 : 1100,
    height: opts.mini ? 330 : 800,
    ...(Number.isFinite(opts.x) && Number.isFinite(opts.y) ? { x: opts.x, y: opts.y } : {}),
    alwaysOnTop: !!opts.mini,
    autoHideMenuBar: true,
    icon: ICON,
    title: svc ? svc.name : 'MultiSocial',
    backgroundColor: '#ffffff',
    webPreferences: { session: ses, preload: WEB_PRELOAD, contextIsolation: true, sandbox: true, spellcheck: true }
  });
  w.removeMenu();
  w.__serviceId = serviceId;
  if (opts.mini) w.setAlwaysOnTop(true, 'floating');
  wireWebContents(w.webContents, { serviceId, win: w });
  w.loadURL(url).catch(() => {});
  return w;
}

// ---------------------------------------------------------------------------
// Ligações comuns de cada página web (abas e janelas extras)
// ---------------------------------------------------------------------------
function wireWebContents(wc, ctx) {
  const { tab } = ctx;

  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https?:|^about:blank/i.test(url)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    // pop-ups de login (OAuth etc.) continuam como janela filha
    if (disposition === 'new-window' && (isInternal(ctx.serviceId, url) || /^about:blank/i.test(url))) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, width: 620, height: 760 } };
    }
    if (store.get('externalLinks') !== false) {
      routeLink(url, ctx.serviceId, tab ? tab.id : undefined, disposition === 'background-tab');
      return { action: 'deny' };
    }
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, width: 620, height: 760 } };
    }
    if (tab) createServiceTab(ctx.serviceId, url, { activate: disposition !== 'background-tab', afterId: tab.id });
    else openWindow(url, ctx.serviceId);
    return { action: 'deny' };
  });
  // link para fora da rede (mesma aba): outra rede do app -> nova aba no app; site externo -> navegador padrão
  const leaving = (e, url, isMainFrame) => {
    if (isMainFrame === false || store.get('externalLinks') === false) return;
    if (!/^https?:/i.test(url)) return;
    if (isInternal(ctx.serviceId, url)) {
      const real = unwrapLink(url);
      if (real !== url && !isInternal(ctx.serviceId, real)) { e.preventDefault(); routeLink(real, ctx.serviceId, tab ? tab.id : undefined); }
      return;
    }
    e.preventDefault();
    routeLink(url, ctx.serviceId, tab ? tab.id : undefined);
  };
  wc.on('will-navigate', (e) => leaving(e, e.url, e.isMainFrame));
  wc.on('will-redirect', (e) => { if (e.isMainFrame && !e.isSameDocument) leaving(e, e.url, true); });
  const pushNav = () => {
    try { wc.send('ms:nav', { back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward() }); } catch {}
  };
  wc.on('did-navigate', pushNav);
  wc.on('did-navigate-in-page', pushNav);
  wc.on('dom-ready', pushNav);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('will-navigate', (e, url) => {
    if (!/^(https?:|about:|data:text\/html)/i.test(url)) {
      e.preventDefault();
      if (/^(mailto:|tel:|magnet:|zoommtg:|msteams:|spotify:|steam:|discord:|tg:|whatsapp:)/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  wc.on('did-create-window', (child) => {
    child.removeMenu();
    child.__serviceId = ctx.serviceId;
    wireWebContents(child.webContents, { serviceId: ctx.serviceId, win: child });
  });

  wc.on('before-input-event', (e, input) => {
    if (handleShortcut(input, ctx)) e.preventDefault();
  });

  wc.on('context-menu', (_e, params) => showWebContextMenu(wc, params, ctx));

  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3 || !/^https?:/i.test(url)) return; // -3 = carregamento cancelado
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(url, desc))).catch(() => {});
  });

  wc.on('found-in-page', (_e, r) => send('find:result', { active: r.activeMatchOrdinal, matches: r.matches }));

  if (tab) {
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      tab.badge = parseBadge(title);
      sendTabs();
    });
    wc.on('page-favicon-updated', (_e, favs) => {
      // só guarda a logo se a página for da própria rede (evita a logo do Google na tela de login)
      if (favs && favs.length && isInternal(tab.serviceId, wc.getURL()) && !AUTH_HOSTS.includes((() => { try { return new URL(wc.getURL()).hostname; } catch { return ''; } })())) {
        tab.favicon = favs[0];
        const f = store.get('favicons') || {};
        if (f[tab.serviceId] !== favs[0]) { f[tab.serviceId] = favs[0]; store.set('favicons', f); sendConfig(); }
        sendTabs();
      }
    });
    wc.on('did-start-loading', () => { tab.loading = true; tab.loadStart = Date.now(); sendTabs(); });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      tab.loadStart = 0;
      tab.stuckRetries = 0;
      sendTabs();
      // ao terminar de carregar a aba visível, força um redesenho (contorno do bug de tela em branco)
      if (tab.id === activeId && !locked) { tab.shown = false; layout(); }
    });
    wc.on('did-navigate', sendTabs);
    wc.on('did-navigate-in-page', sendTabs);
    wc.on('audio-state-changed', (e) => { tab.audible = e.audible; sendTabs(); });
    wc.on('enter-html-full-screen', () => {
      fullscreenTab = tab;
      if (!win.isFullScreen()) win.setFullScreen(true);
      send('fullscreen', true);
      layout();
    });
    wc.on('leave-html-full-screen', () => {
      fullscreenTab = null;
      if (win.isFullScreen()) win.setFullScreen(false);
      send('fullscreen', false);
      layout();
    });
    wc.on('render-process-gone', (_e, d) => {
      log('página travou', tab.serviceId, d, wc.getURL());
      if (d.reason === 'clean-exit') return;
      const now = Date.now();
      tab.crashes = (tab.crashes || []).filter((x) => now - x < 60000);
      tab.crashes.push(now);
      tab.lastCrash = d.reason;
      if (tab.crashes.length >= 3) {
        // evita ficar recarregando sem parar: mostra uma tela com o motivo
        const url = /^https?:/i.test(wc.getURL()) ? wc.getURL() : (getService(tab.serviceId) || {}).url;
        wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(crashPage(url, d))).catch(() => {});
      } else {
        setTimeout(() => { try { wc.reload(); } catch {} }, 1500);
      }
    });
    wc.on('unresponsive', () => {
      log('página não responde', tab.serviceId, wc.getURL());
      tab.unresponsiveSince = Date.now();
      setTimeout(() => {
        if (!tab.unresponsiveSince || !tab.view || tab.view.webContents !== wc) return;
        log('página continua travada: recriando a aba', tab.serviceId);
        tab.unresponsiveSince = 0;
        if (tab.id === activeId) recreateTab(tab, true);
        else { try { wc.forcefullyCrashRenderer(); } catch {} suspendTab(tab); }
      }, 5000);
    });
    wc.on('responsive', () => { tab.unresponsiveSince = 0; });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && code !== -3) log('falha ao carregar', tab.serviceId, code, desc, url); });
    wc.on('zoom-changed', (_e, dir) => setZoom(wc, dir === 'in' ? 0.1 : -0.1, tab.serviceId));
  }
}

function errorPage(url, desc) {
  const u = String(url).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15;url=${u}">
<title>Sem conexão</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0e1016;color:#e8e8ee;font-family:"Segoe UI",sans-serif;text-align:center}
.c{max-width:440px;padding:24px}h1{font-weight:600;font-size:22px}p{color:#8d93a8;line-height:1.5}a{display:inline-block;margin-top:10px;padding:10px 22px;border-radius:10px;background:#6c7cff;color:#fff;text-decoration:none;font-weight:600}
small{display:block;margin-top:18px;color:#5d6378;font-size:12px}</style></head><body><div class="c">
<div style="font-size:46px">📡</div><h1>Não foi possível carregar a página</h1>
<p>Verifique sua conexão com a internet. O MultiSocial tenta de novo sozinho a cada 15 segundos.</p>
<a href="${u}">Tentar novamente</a><small>${String(desc || '').replace(/[<>&]/g, '')}</small></div></body></html>`;
}

function crashPage(url, d) {
  const u = String(url || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>A página travou</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0e1016;color:#e8e8ee;font-family:"Segoe UI",sans-serif;text-align:center}
.c{max-width:480px;padding:24px}h1{font-weight:600;font-size:22px}p{color:#8d93a8;line-height:1.5}a{display:inline-block;margin-top:10px;padding:10px 22px;border-radius:10px;background:#6c7cff;color:#fff;text-decoration:none;font-weight:600}
code{display:block;margin-top:18px;color:#ff8a95;font-size:12px}</style></head><body><div class="c">
<div style="font-size:46px">💥</div><h1>Esta página travou várias vezes</h1>
<p>O MultiSocial parou de recarregar automaticamente para não ficar em loop. Se continuar, desative a "Aceleração por hardware" em Configurações &gt; Avançado e envie o log (Configurações &gt; Avançado &gt; Abrir pasta de logs).</p>
<a href="${u}">Tentar novamente</a><code>motivo: ${String(d.reason).replace(/[<>&]/g, '')} · código: ${Number(d.exitCode) || 0}</code></div></body></html>`;
}

function setZoom(wc, delta, serviceId, reset) {
  let z = reset ? 1 : Math.min(3, Math.max(0.3, Math.round((wc.getZoomFactor() + delta) * 10) / 10));
  wc.setZoomFactor(z);
  if (serviceId) {
    const all = store.get('zoom') || {};
    all[serviceId] = z;
    store.set('zoom', all);
  }
}

// ---------------------------------------------------------------------------
// Atalhos de teclado
// ---------------------------------------------------------------------------
function handleShortcut(input, ctx = null) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  if (locked) {
    // bloqueado: só deixa digitar o PIN na tela de bloqueio
    if (ctx) return true;
    return ctrl || input.alt || /^F\d+$/.test(input.key || '');
  }
  const shift = input.shift;
  const alt = input.alt;
  const key = (input.key || '').toLowerCase();
  const code = input.code || '';
  const isMainCtx = !ctx || !!ctx.tab;
  const wc = ctx ? (ctx.tab ? ctx.tab.view.webContents : (ctx.win ? ctx.win.webContents : null)) : activeWc();

  // Atalhos que valem em qualquer janela web
  if (wc) {
    if ((ctrl && key === 'r' && !shift) || key === 'f5' && !ctrl) { wc.reload(); return true; }
    if ((ctrl && shift && key === 'r') || (ctrl && key === 'f5')) { wc.reloadIgnoringCache(); return true; }
    if (alt && key === 'arrowleft') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return true; }
    if (alt && key === 'arrowright') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return true; }
    if (ctrl && (key === '=' || key === '+' || code === 'NumpadAdd')) { setZoom(wc, 0.1, ctx && ctx.tab ? ctx.tab.serviceId : null); return true; }
    if (ctrl && (key === '-' || code === 'NumpadSubtract')) { setZoom(wc, -0.1, ctx && ctx.tab ? ctx.tab.serviceId : null); return true; }
    if (ctrl && (key === '0' || code === 'Numpad0') && !/^Digit[1-9]/.test(code)) { setZoom(wc, 0, ctx && ctx.tab ? ctx.tab.serviceId : null, true); return true; }
    if (key === 'f12' || (ctrl && shift && key === 'i')) { wc.toggleDevTools(); return true; }
  }
  if (!isMainCtx) {
    if (key === 'f11' && ctx.win) { ctx.win.setFullScreen(!ctx.win.isFullScreen()); return true; }
    if (ctrl && key === 'w' && ctx.win) { ctx.win.close(); return true; }
    return false;
  }

  // Atalhos da janela principal
  const dm = /^(Digit|Numpad)([1-9])$/.exec(code);
  if (ctrl && !alt && !shift && dm) { goToIndex(parseInt(dm[2], 10)); return true; }
  if (ctrl && key === 'tab') { cycleTab(shift ? -1 : 1); return true; }
  if (ctrl && key === 'pagedown') { cycleTab(1); return true; }
  if (ctrl && key === 'pageup') { cycleTab(-1); return true; }
  if (ctrl && key === 'w' || ctrl && key === 'f4') { if (activeId !== 'home') closeTab(activeId); return true; }
  if (ctrl && shift && key === 't') { reopenClosed(); return true; }
  if (ctrl && key === 't') { activateTab('home'); send('focus-search'); return true; }
  if (ctrl && key === ',') { openSettingsTab(); return true; }
  if (ctrl && key === 'f') { if (activeWc()) openFind(); return true; }
  if (key === 'escape' && findOpen) { closeFind(); return true; }
  if (ctrl && shift && key === 'n') { const t = activeTab(); if (t && t.view) openWindow(t.view.webContents.getURL(), t.serviceId); return true; }
  if (ctrl && shift && key === 'm') { const t = activeTab(); if (t && t.view) openWindow(t.view.webContents.getURL(), t.serviceId, { mini: true }); return true; }
  if (ctrl && shift && key === 's') { const t = activeTab(); if (t && t.view) screenshot(t.view.webContents, t.serviceId); return true; }
  if (key === 'f11') { win.setFullScreen(!win.isFullScreen()); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Buscar na página
// ---------------------------------------------------------------------------
function openFind() {
  findOpen = true;
  layout();
  send('find:open');
  win.webContents.focus();
}
function closeFind() {
  const wc = activeWc();
  if (wc) { try { wc.stopFindInPage('clearSelection'); } catch {} }
  findOpen = false;
  send('find:close');
  layout();
  if (wc) wc.focus();
}

// ---------------------------------------------------------------------------
// Captura de tela
// ---------------------------------------------------------------------------
async function screenshot(wc, serviceId, toClipboard = false) {
  try {
    const img = await wc.capturePage();
    if (toClipboard) {
      clipboard.writeImage(img);
      notify('Captura copiada', 'A imagem da página foi copiada para a área de transferência.');
      return;
    }
    const dir = path.join(app.getPath('pictures'), 'MultiSocial');
    fs.mkdirSync(dir, { recursive: true });
    const file = uniquePath(dir, `${serviceId || 'pagina'}_${stamp()}.png`);
    fs.writeFileSync(file, img.toPNG());
    notify('Captura salva', path.basename(file), () => shell.showItemInFolder(file));
  } catch (e) {
    dialog.showErrorBox('MultiSocial', 'Não foi possível capturar a página.');
  }
}

// ---------------------------------------------------------------------------
// Scripts injetados (vídeo / imagem sob o cursor)
// ---------------------------------------------------------------------------
function probeAt(X, Y) {
  document.querySelectorAll('[data-ms-target]').forEach((e) => e.removeAttribute('data-ms-target'));
  const els = document.elementsFromPoint(X, Y);
  let v = null, img = null, bg = null;
  for (const el of els) {
    if (!v && el.tagName === 'VIDEO') v = el;
    if (!img && el.tagName === 'IMG' && (el.currentSrc || el.src)) img = el;
    if (!img && !bg) {
      const b = getComputedStyle(el).backgroundImage;
      const m = b && /url\(["']?(.*?)["']?\)/.exec(b);
      if (m && /^https?:/.test(m[1])) bg = m[1];
    }
  }
  if (!v) {
    for (const el of document.querySelectorAll('video')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && X >= r.left && X <= r.right && Y >= r.top && Y <= r.bottom) { v = el; break; }
    }
  }
  if (v) v.setAttribute('data-ms-target', '1');
  return {
    video: v ? {
      src: v.currentSrc || v.src || '',
      loop: v.loop, controls: v.controls, muted: v.muted, paused: v.paused,
      pip: document.pictureInPictureElement === v
    } : null,
    img: img ? (img.currentSrc || img.src) : (bg || null)
  };
}

async function videoPip() {
  const v = document.querySelector('[data-ms-target]');
  if (!v) return 'novideo';
  try {
    v.disablePictureInPicture = false;
    v.removeAttribute('disablepictureinpicture');
    if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
    return 'ok';
  } catch (e) { return 'erro:' + e.message; }
}

function videoToggle(prop) {
  const v = document.querySelector('[data-ms-target]');
  if (!v) return;
  if (prop === 'paused') { v.paused ? v.play() : v.pause(); return; }
  v[prop] = !v[prop];
}

function videoSpeed(rate) {
  const v = document.querySelector('[data-ms-target]');
  if (v) v.playbackRate = rate;
}

function videoRecord() {
  const v = document.querySelector('[data-ms-target]');
  if (!v) return 'novideo';
  if (window.__msRec) { window.__msRec.stop(); return 'stopped'; }
  let stream;
  try { stream = v.captureStream(); } catch (e) { return 'tainted'; }
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) return 'unsupported';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  const chunks = [];
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#e5243b;color:#fff;font:600 13px "Segoe UI",sans-serif;padding:9px 16px;border-radius:22px;box-shadow:0 6px 18px rgba(0,0,0,.45);cursor:pointer;user-select:none';
  badge.textContent = '● Gravando vídeo — clique aqui para parar e salvar';
  badge.onclick = () => rec.stop();
  document.documentElement.appendChild(badge);
  const onEnd = () => { if (rec.state !== 'inactive') rec.stop(); };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    badge.remove();
    window.__msRec = null;
    v.removeEventListener('ended', onEnd);
    const blob = new Blob(chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'video_' + Date.now() + '.webm';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
  };
  v.addEventListener('ended', onEnd);
  v.loop = false;
  try { v.currentTime = 0; } catch (e) {}
  rec.start(1000);
  v.play().catch(() => {});
  window.__msRec = rec;
  return 'started';
}

const js = (fn, ...args) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;

async function copyImageFromUrl(wc, url, x, y) {
  try {
    const res = await wc.session.fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) { clipboard.writeImage(img); return; }
  } catch {}
  try { wc.copyImageAt(x, y); } catch {}
}

// ---------------------------------------------------------------------------
// Menu do botão direito
// ---------------------------------------------------------------------------
async function showWebContextMenu(wc, params, ctx) {
  const zoom = wc.getZoomFactor() || 1;
  let probe = {};
  if (params.frame === wc.mainFrame || !params.frame || params.frame.parent === null) {
    try {
      probe = (await wc.executeJavaScript(js(probeAt, params.x / zoom, params.y / zoom), true)) || {};
    } catch { probe = {}; }
  }
  const serviceId = ctx.serviceId;
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };

  // Ortografia
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!params.dictionarySuggestions.length) t.push({ label: 'Sem sugestões', enabled: false });
    t.push({ label: 'Adicionar ao dicionário', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    sep();
  }

  // Link
  if (params.linkURL) {
    const link = params.linkURL;
    if (ctx.tab) {
      t.push({ label: 'Abrir link em nova aba', click: () => createServiceTab(serviceId, link, { activate: true, afterId: ctx.tab.id }) });
    }
    t.push({ label: 'Abrir link em nova janela', click: () => openWindow(link, serviceId) });
    t.push({ label: 'Abrir link em mini janela flutuante', click: () => openWindow(link, serviceId, { mini: true }) });
    t.push({ label: 'Abrir link no navegador padrão', click: () => shell.openExternal(link) });
    t.push({ label: 'Copiar endereço do link', click: () => clipboard.writeText(link) });
    t.push({ label: 'Salvar link como…', click: () => saveUrlAs(wc, link) });
    sep();
  }

  // Imagem
  const imgUrl = (params.mediaType === 'image' && params.srcURL) ? params.srcURL : probe.img;
  if (imgUrl && !probe.video) {
    if (ctx.tab) t.push({ label: 'Abrir imagem em nova aba', click: () => createServiceTab(serviceId, imgUrl, { afterId: ctx.tab.id }) });
    t.push({ label: 'Salvar imagem como…', click: () => saveUrlAs(wc, imgUrl) });
    t.push({ label: 'Salvar imagem (rápido)', click: () => wc.downloadURL(imgUrl) });
    t.push({ label: 'Copiar imagem', click: () => copyImageFromUrl(wc, imgUrl, params.x, params.y) });
    t.push({ label: 'Copiar endereço da imagem', click: () => clipboard.writeText(imgUrl) });
    sep();
  }

  // Vídeo / áudio
  const v = probe.video;
  if (v || params.mediaType === 'video' || params.mediaType === 'audio') {
    const src = (v && v.src) || params.srcURL || '';
    const direct = /^https?:/i.test(src);
    if (v) {
      t.push({
        label: v.pip ? 'Sair do Picture-in-Picture' : 'Picture-in-Picture (PiP)',
        click: async () => {
          const r = await wc.executeJavaScript(js(videoPip), true).catch(() => 'erro');
          if (r !== 'ok') dialog.showMessageBox(ctx.win || win, { type: 'info', message: 'Este site não permitiu abrir o vídeo em Picture-in-Picture.' });
        }
      });
      t.push({ label: v.paused ? 'Reproduzir' : 'Pausar', click: () => wc.executeJavaScript(js(videoToggle, 'paused'), true) });
      t.push({ label: 'Repetir (loop)', type: 'checkbox', checked: !!v.loop, click: () => wc.executeJavaScript(js(videoToggle, 'loop'), true) });
      t.push({ label: 'Mostrar controles', type: 'checkbox', checked: !!v.controls, click: () => wc.executeJavaScript(js(videoToggle, 'controls'), true) });
      t.push({ label: 'Mudo', type: 'checkbox', checked: !!v.muted, click: () => wc.executeJavaScript(js(videoToggle, 'muted'), true) });
      t.push({
        label: 'Velocidade',
        submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({ label: r === 1 ? 'Normal' : `${r}x`, click: () => wc.executeJavaScript(js(videoSpeed, r), true) }))
      });
    }
    if (direct) {
      t.push({ label: 'Salvar vídeo como…', click: () => saveUrlAs(wc, src) });
      t.push({ label: 'Copiar endereço do vídeo', click: () => clipboard.writeText(src) });
    }
    if (v) {
      t.push({
        label: direct ? 'Gravar vídeo (tempo real)' : 'Salvar vídeo (gravar em tempo real)',
        click: async () => {
          const r = await wc.executeJavaScript(js(videoRecord), true).catch(() => 'erro');
          if (r === 'tainted' || r === 'erro' || r === 'unsupported') {
            dialog.showMessageBox(ctx.win || win, {
              type: 'warning',
              message: 'Não foi possível gravar este vídeo.',
              detail: 'O site protege este vídeo contra captura. Tente "Salvar vídeo como…" quando a opção aparecer.'
            });
          } else if (r === 'started') {
            notify('Gravando vídeo', 'O vídeo foi reiniciado e está sendo gravado. Ele será salvo ao terminar, ou clique no aviso vermelho para parar.');
          }
        }
      });
    }
    sep();
  }

  // Texto selecionado
  if (params.selectionText && !params.isEditable) {
    const s = params.selectionText.trim();
    t.push({ label: 'Copiar', role: 'copy' });
    t.push({
      label: `Pesquisar no Google: "${s.length > 28 ? s.slice(0, 28) + '…' : s}"`,
      click: () => shell.openExternal('https://www.google.com/search?q=' + encodeURIComponent(s))
    });
    if (/^https?:\/\/\S+$/.test(s)) t.push({ label: 'Abrir endereço selecionado', click: () => ctx.tab ? createServiceTab(serviceId, s, { afterId: ctx.tab.id }) : openWindow(s, serviceId) });
    sep();
  }

  // Campo editável
  if (params.isEditable) {
    const f = params.editFlags;
    t.push({ label: 'Desfazer', role: 'undo', enabled: f.canUndo });
    t.push({ label: 'Refazer', role: 'redo', enabled: f.canRedo });
    sep();
    t.push({ label: 'Recortar', role: 'cut', enabled: f.canCut });
    t.push({ label: 'Copiar', role: 'copy', enabled: f.canCopy });
    t.push({ label: 'Colar', role: 'paste', enabled: f.canPaste });
    t.push({ label: 'Colar sem formatação', role: 'pasteAndMatchStyle', enabled: f.canPaste });
    t.push({ label: 'Selecionar tudo', role: 'selectAll', enabled: f.canSelectAll });
    sep();
  }

  // Página
  const nav = wc.navigationHistory;
  t.push({ label: 'Voltar', accelerator: 'Alt+Left', enabled: nav.canGoBack(), click: () => nav.goBack() });
  t.push({ label: 'Avançar', accelerator: 'Alt+Right', enabled: nav.canGoForward(), click: () => nav.goForward() });
  t.push({ label: 'Recarregar', accelerator: 'Ctrl+R', click: () => wc.reload() });
  sep();
  if (ctx.tab) {
    t.push({ label: 'Abrir esta aba em nova janela', accelerator: 'Ctrl+Shift+N', click: () => moveTabToWindow(ctx.tab) });
  } else if (ctx.win && getService(serviceId)) {
    t.push({
      label: 'Voltar para o MultiSocial (como aba)', click: () => {
        const u = wc.getURL();
        createServiceTab(serviceId, /^https?:/i.test(u) ? u : undefined, { activate: true });
        showMain();
        ctx.win.close();
      }
    });
  }
  t.push({ label: 'Mini janela flutuante (sempre no topo)', accelerator: 'Ctrl+Shift+M', click: () => openWindow(wc.getURL(), serviceId, { mini: true }) });
  t.push({ label: 'Silenciar página', type: 'checkbox', checked: wc.isAudioMuted(), click: () => { wc.setAudioMuted(!wc.isAudioMuted()); if (ctx.tab) { ctx.tab.muted = wc.isAudioMuted(); sendTabs(); } } });
  t.push({
    label: 'Captura de tela',
    submenu: [
      { label: 'Salvar em Imagens\\MultiSocial', accelerator: 'Ctrl+Shift+S', click: () => screenshot(wc, serviceId) },
      { label: 'Copiar para a área de transferência', click: () => screenshot(wc, serviceId, true) }
    ]
  });
  t.push({
    label: `Zoom (${Math.round(zoom * 100)}%)`,
    submenu: [
      { label: 'Aumentar', accelerator: 'Ctrl+=', click: () => setZoom(wc, 0.1, ctx.tab ? serviceId : null) },
      { label: 'Diminuir', accelerator: 'Ctrl+-', click: () => setZoom(wc, -0.1, ctx.tab ? serviceId : null) },
      { label: 'Restaurar (100%)', accelerator: 'Ctrl+0', click: () => setZoom(wc, 0, ctx.tab ? serviceId : null, true) }
    ]
  });
  t.push({ label: 'Copiar endereço da página', click: () => clipboard.writeText(wc.getURL()) });
  t.push({ label: 'Abrir página no navegador padrão', click: () => shell.openExternal(wc.getURL()) });
  sep();
  t.push({ label: 'Inspecionar elemento', accelerator: 'F12', click: () => wc.inspectElement(params.x, params.y) });

  Menu.buildFromTemplate(t).popup({ window: ctx.win || win });
}

// ---------------------------------------------------------------------------
// Menus nativos usados pela interface (aba / ícone do início)
// ---------------------------------------------------------------------------
function tabMenu(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.type === 'settings') {
    Menu.buildFromTemplate([{ label: 'Fechar', click: () => closeTab(id) }]).popup({ window: win });
    return;
  }
  const wc = ensureView(t).webContents;
  const svc = getService(t.serviceId);
  const mem = memoryOf(wc);
  Menu.buildFromTemplate([
    { label: mem ? `Memória: ${mem} MB` : 'Memória: —', enabled: false },
    { type: 'separator' },
    { label: 'Recarregar', click: () => wc.reload() },
    { label: 'Recriar aba (corrige página travada/em branco)', click: () => recreateTab(t) },
    { label: 'Duplicar aba', click: () => createServiceTab(t.serviceId, wc.getURL(), { afterId: t.id }) },
    { label: 'Voltar ao início da rede', click: () => wc.loadURL(svc.url) },
    { type: 'separator' },
    { label: 'Abrir em nova janela', click: () => moveTabToWindow(t) },
    { label: 'Mini janela flutuante (sempre no topo)', click: () => openWindow(wc.getURL(), t.serviceId, { mini: true }) },
    { label: 'Continuar reproduzindo em segundo plano', type: 'checkbox', checked: bgAllowed(t.serviceId), click: (mi) => setBgPlay(t.serviceId, mi.checked) },
    { label: 'Sempre ativa (não suspender para economizar RAM)', type: 'checkbox', checked: keepAlive(t.serviceId), click: (mi) => { store.set('alive', { ...(store.get('alive') || {}), [t.serviceId]: mi.checked }); sendConfig(); } },
    { label: 'Modo celular', type: 'checkbox', checked: isMobile(t.serviceId), click: () => toggleMobile(t.serviceId) },
    { label: t.muted ? 'Reativar som da aba' : 'Silenciar aba', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); t.muted = wc.isAudioMuted(); sendTabs(); } },
    { type: 'separator' },
    { label: `Sair da conta (${svc ? svc.name : ''})`, click: () => logout(t.serviceId) },
    { type: 'separator' },
    { label: 'Fechar', accelerator: 'Ctrl+W', click: () => closeTab(id) },
    { label: 'Fechar outras abas', enabled: tabs.length > 1, click: () => tabs.filter((x) => x.id !== id).forEach((x) => closeTab(x.id)) },
    { label: 'Fechar abas à direita', enabled: tabs.findIndex((x) => x.id === id) < tabs.length - 1, click: () => tabs.slice(tabs.findIndex((x) => x.id === id) + 1).forEach((x) => closeTab(x.id)) },
    { label: 'Reabrir aba fechada', accelerator: 'Ctrl+Shift+T', enabled: closedStack.length > 0, click: reopenClosed }
  ]).popup({ window: win });
}

function homeMenu(serviceId) {
  const svc = getService(serviceId);
  if (!svc) return;
  const dock = store.get('dock') || [];
  const inDock = dock.includes(serviceId);
  const isCustom = serviceId.startsWith('custom-');
  Menu.buildFromTemplate([
    { label: 'Abrir', click: () => openService(serviceId) },
    { label: 'Abrir em nova aba', click: () => openService(serviceId, { newTab: true }) },
    { label: 'Abrir em nova janela', click: () => openWindow(svc.url, serviceId) },
    { label: 'Abrir em mini janela flutuante', click: () => openWindow(svc.url, serviceId, { mini: true }) },
    { type: 'separator' },
    { label: 'Continuar reproduzindo em segundo plano', type: 'checkbox', checked: bgAllowed(serviceId), click: (mi) => setBgPlay(serviceId, mi.checked) },
    {
      label: inDock ? 'Remover do dock' : 'Fixar no dock', click: () => {
        const d = (store.get('dock') || []).filter((x) => x !== serviceId);
        if (!inDock) d.push(serviceId);
        store.set('dock', d.slice(0, 6));
        sendConfig();
      }
    },
    {
      label: 'Ocultar do início', click: () => {
        const h = new Set(store.get('hidden') || []);
        h.add(serviceId);
        store.set('hidden', [...h]);
        sendConfig();
      }
    },
    ...(isCustom ? [{ label: 'Excluir site personalizado', click: () => removeCustom(serviceId) }] : []),
    { type: 'separator' },
    { label: 'Sair da conta', click: () => logout(serviceId) }
  ]).popup({ window: win });
}

// Apaga TUDO de uma rede: cookies, logins, armazenamento local, IndexedDB, cache, service workers,
// e depois apaga a pasta do disco (sem passar pela Lixeira).
async function wipeService(serviceId) {
  const svc = getService(serviceId);
  const oldName = partitionName(serviceId);
  const oldSes = session.fromPartition(`persist:${oldName}`);
  // fecha janelas extras dessa rede
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && w.__serviceId === serviceId) { try { w.destroy(); } catch {} }
  // fecha as páginas das abas dessa rede (as abas continuam na barra)
  const affected = tabs.filter((x) => x.serviceId === serviceId);
  for (const t of affected) {
    t.url = svc ? svc.url : t.url;
    t.badge = 0;
    t.favicon = '';
    if (t.view) {
      const v = t.view;
      t.view = null;
      try { win.contentView.removeChildView(v); } catch {}
      try { v.webContents.close(); } catch {}
    }
  }
  try { await oldSes.clearStorageData(); } catch {}
  try { await oldSes.clearCache(); } catch {}
  try { await oldSes.clearAuthCache(); } catch {}
  try { await oldSes.clearCodeCaches({}); } catch {}
  try { await oldSes.clearHostResolverCache(); } catch {}
  try { for (const w of await oldSes.listWordsInSpellCheckerDictionary()) oldSes.removeWordFromSpellCheckerDictionary(w); } catch {}
  try { await oldSes.cookies.flushStore(); } catch {}
  // próxima geração = pasta nova e vazia
  const gen = { ...(store.get('gen') || {}) };
  gen[serviceId] = (gen[serviceId] || 0) + 1;
  store.set('gen', gen);
  // tenta apagar a pasta agora; o que estiver em uso é apagado na próxima abertura do app
  // a sessão antiga ainda pode gravar arquivos vazios ao fechar o app: apaga de novo na próxima abertura
  wipeDir(path.join(PARTITIONS_DIR, oldName));
  store.set('pendingWipe', [...new Set([...(store.get('pendingWipe') || []), oldName])]);
  // remove dados ligados à rede guardados nas configurações
  for (const k of ['favicons', 'perms', 'zoom']) {
    const o = { ...(store.get(k) || {}) };
    delete o[serviceId];
    store.set(k, o);
  }
  store.saveNow();
  // reabre as abas já com a sessão nova (deslogada)
  for (const t of affected) if (t.id === activeId) ensureView(t);
  layout();
  sendTabs();
  sendConfig();
  log('dados da rede apagados', serviceId);
}

async function logout(serviceId) {
  const svc = getService(serviceId);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Sair da conta',
    message: `Sair da conta do ${svc ? svc.name : serviceId}?`,
    detail: 'Todos os dados desta rede (login, cookies, mensagens em cache, armazenamento local e cache) serão apagados permanentemente deste computador, sem passar pela Lixeira.',
    buttons: ['Sair da conta', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (r.response !== 0) return;
  await wipeService(serviceId);
}

function removeCustom(serviceId) {
  for (const t of tabs.filter((x) => x.serviceId === serviceId)) closeTab(t.id);
  store.set('custom', (store.get('custom') || []).filter((c) => c.id !== serviceId));
  store.set('dock', (store.get('dock') || []).filter((x) => x !== serviceId));
  sendConfig();
}

// ---------------------------------------------------------------------------
// Logo de sites personalizados
// ---------------------------------------------------------------------------
async function fetchSiteIcon(url) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA } });
    const base = res.url || url;
    const html = (await res.text()).slice(0, 400000);
    let best = null;
    let bestScore = -1;
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const rel = (/\brel\s*=\s*["']?([^"'>]+)/i.exec(tag) || [])[1] || '';
      if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
      const href = (/\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1];
      if (!href) continue;
      const size = parseInt((/\bsizes\s*=\s*["']?(\d+)/i.exec(tag) || [])[1] || '0', 10);
      let score = size || (/apple-touch/i.test(rel) ? 180 : 32);
      if (/\.svg(\?|$)/i.test(href)) score = Math.max(score, 150);
      if (score > 512) score = 100; // ícones gigantes costumam ser imagens de compartilhamento
      if (score > bestScore) {
        bestScore = score;
        try { best = new URL(href.replace(/&amp;/g, '&'), base).href; } catch {}
      }
    }
    return best || new URL('/favicon.ico', base).href;
  } catch {
    try { return new URL('/favicon.ico', url).href; } catch { return ''; }
  }
}

async function fetchSiteIconChecked(url, serviceId) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA } });
    if (!isInternal(serviceId, res.url || url) || AUTH_HOSTS.includes(new URL(res.url || url).hostname)) return '';
  } catch { return ''; }
  return fetchSiteIcon(url);
}

async function fillCustomIcon(id) {
  const c = (store.get('custom') || []).find((x) => x.id === id);
  if (!c) return;
  const icon = await fetchSiteIcon(c.url);
  if (!icon) return;
  store.set('custom', (store.get('custom') || []).map((x) => (x.id === id ? { ...x, icon } : x)));
  sendConfig();
  sendTabs();
}

// ---------------------------------------------------------------------------
// Atualizações (GitHub Releases)
// ---------------------------------------------------------------------------
function cmpVer(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

let updateBusy = false;
async function checkForUpdates(manual = false) {
  if (updateBusy) return;
  updateBusy = true;
  send('update:status', 'checking');
  try {
    const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'MultiSocial-Updater', Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) {
      if (manual) dialog.showMessageBox(win, { type: 'info', message: 'Nenhuma versão publicada ainda.', detail: `Você está na versão ${app.getVersion()}.` });
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    store.set('lastUpdateCheck', Date.now());
    if (!latest || cmpVer(latest, app.getVersion()) <= 0) {
      if (manual) dialog.showMessageBox(win, { type: 'info', message: 'O MultiSocial está atualizado.', detail: `Você já está na versão mais recente (${app.getVersion()}).` });
      return;
    }
    if (!manual && store.get('skipVersion') === latest) return;

    const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    const assets = rel.assets || [];
    const asset = portable
      ? assets.find((a) => /portable.*\.exe$/i.test(a.name))
      : assets.find((a) => /setup.*\.exe$/i.test(a.name));
    const canInstall = !!asset && app.isPackaged && process.platform === 'win32';
    const notes = String(rel.body || '').trim().slice(0, 900) || 'Sem notas de versão.';
    const buttons = canInstall
      ? ['Atualizar agora', 'Ver no GitHub', 'Depois', 'Pular esta versão']
      : ['Ver no GitHub', 'Depois', 'Pular esta versão'];
    showMain();
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Atualização disponível',
      message: `MultiSocial ${latest} está disponível!`,
      detail: `Você está na versão ${app.getVersion()}.\n\nNovidades:\n${notes}`,
      buttons,
      defaultId: 0,
      cancelId: buttons.indexOf('Depois'),
      noLink: true
    });
    const choice = buttons[r.response];
    if (choice === 'Atualizar agora') await installUpdate(asset, portable);
    else if (choice === 'Ver no GitHub') shell.openExternal(rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`);
    else if (choice === 'Pular esta versão') store.set('skipVersion', latest);
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: 'error', message: 'Não foi possível verificar atualizações.', detail: String(e.message || e) });
  } finally {
    updateBusy = false;
    send('update:status', 'idle');
  }
}

async function installUpdate(asset, portable) {
  if (!/^https:\/\/github\.com\/Buno-o\/MultiSocial\/releases\/download\//i.test(asset.browser_download_url || '')) {
    dialog.showMessageBox(win, { type: 'error', message: 'Endereço de atualização inválido.' });
    return;
  }
  const dir = path.join(app.getPath('temp'), 'MultiSocial-update');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  send('update:status', 'downloading');
  try {
    const res = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'MultiSocial-Updater' } });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const total = asset.size || parseInt(res.headers.get('content-length') || '0', 10);
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (total) { win.setProgressBar(got / total); send('update:progress', got / total); }
    }
    await new Promise((r, j) => { out.end(r); out.on('error', j); });
    win.setProgressBar(-1);
    if (total && fs.statSync(file).size !== total) throw new Error('Download incompleto.');
  } catch (e) {
    win.setProgressBar(-1);
    dialog.showMessageBox(win, { type: 'error', message: 'Falha ao baixar a atualização.', detail: String(e.message || e) });
    return;
  }

  if (portable) {
    // troca o .exe portátil depois que o app fechar e abre a nova versão
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    const script = path.join(dir, 'atualizar.cmd');
    fs.writeFileSync(script, [
      '@echo off',
      'chcp 65001 >nul',
      `set "NEW=${file}"`,
      `set "OLD=${target}"`,
      'set /a n=0',
      ':loop',
      'set /a n+=1',
      'if %n% gtr 90 goto fail',
      'timeout /t 1 /nobreak >nul',
      'move /y "%NEW%" "%OLD%" >nul 2>&1 || goto loop',
      'start "" "%OLD%"',
      'goto end',
      ':fail',
      'start "" "%NEW%"',
      ':end',
      'del "%~f0"'
    ].join('\r\n'), 'utf8');
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  }
  quitApp();
}

// ---------------------------------------------------------------------------
// Memória
// ---------------------------------------------------------------------------
function memoryOf(wc) {
  try {
    const pid = wc.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    return m ? Math.round(m.memory.workingSetSize / 1024) : 0;
  } catch { return 0; }
}
function memoryReport() {
  const metrics = app.getAppMetrics();
  const total = Math.round(metrics.reduce((a, m) => a + (m.memory.workingSetSize || 0), 0) / 1024);
  const perTab = tabs.filter((t) => t.type === 'service').map((t) => ({
    name: (getService(t.serviceId) || {}).name || t.serviceId,
    mb: t.view ? memoryOf(t.view.webContents) : 0,
    suspended: !t.view
  }));
  return { total, perTab };
}

// ---------------------------------------------------------------------------
// Bloqueio por PIN
// ---------------------------------------------------------------------------
let locked = false;
let pinFails = 0;
let pinBlockedUntil = 0;
const hiddenByLock = new Set();
function hasPin() { return !!store.get('pinHash'); }
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32).toString('hex'); }
function checkPin(pin) {
  if (!hasPin()) return true;
  const a = Buffer.from(hashPin(pin, store.get('pinSalt')), 'hex');
  const b = Buffer.from(store.get('pinHash'), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function lockApp() {
  if (!hasPin()) { showMain(); send('pin:setup'); return; }
  if (locked) return;
  locked = true;
  if (findOpen) closeFind();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== win && w.isVisible()) { hiddenByLock.add(w); w.hide(); }
  }
  layout();
  send('lock', true);
  focusPinField();
  rebuildTrayMenu();
  log('app bloqueado');
}
function unlockApp(pin) {
  const now = Date.now();
  if (now < pinBlockedUntil) return { ok: false, wait: Math.ceil((pinBlockedUntil - now) / 1000) };
  if (!checkPin(pin)) {
    pinFails++;
    if (pinFails >= 5) { pinBlockedUntil = now + Math.min(300, 30 * (pinFails - 4)) * 1000; }
    return { ok: false, wait: pinBlockedUntil > now ? Math.ceil((pinBlockedUntil - now) / 1000) : 0 };
  }
  pinFails = 0;
  locked = false;
  for (const w of hiddenByLock) if (!w.isDestroyed()) w.show();
  hiddenByLock.clear();
  layout();
  send('lock', false);
  const wc = activeWc();
  if (wc) wc.focus();
  rebuildTrayMenu();
  return { ok: true };
}
function setPin(current, next) {
  if (hasPin() && !checkPin(current)) return { ok: false, error: 'PIN atual incorreto.' };
  if (next === null) {
    store.set('pinHash', ''); store.set('pinSalt', '');
    sendConfig();
    return { ok: true };
  }
  if (!/^\d{4,8}$/.test(String(next))) return { ok: false, error: 'O PIN deve ter de 4 a 8 números.' };
  const salt = crypto.randomBytes(16).toString('hex');
  store.set('pinSalt', salt);
  store.set('pinHash', hashPin(next, salt));
  sendConfig();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
function publicConfig() {
  const c = { ...store.all() };
  delete c.lastTabs;
  delete c.windowBounds;
  delete c.pinHash;
  delete c.pinSalt;
  c.hasPin = hasPin();
  c.resolvedDownloadDir = downloadDir();
  return c;
}
function sendConfig() {
  send('config', { config: publicConfig(), services: allServices() });
}

function applyStartup() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!store.get('startWithWindows'),
      path: exe,
      args: ['--hidden']
    });
  } catch {}
}

function applyTheme() {
  const th = THEMES[store.get('theme')] || THEMES.dark;
  try { win.setTitleBarOverlay({ color: th.bar, symbolColor: th.symbol, height: TAB_H }); } catch {}
  win.setBackgroundColor(th.bg);
}

async function setConfig(key, value) {
  const allowed = ['closeAction', 'restoreTabs', 'startWithWindows', 'startMinimized', 'notifications', 'flashTaskbar',
    'askDownload', 'hidden', 'dock', 'theme', 'iconSize', 'hwAccel', 'downloadDir', 'autoUpdateCheck', 'disablePasskeys', 'bgPlay',
    'order', 'mediaBar', 'micMode', 'micDriverProcessing', 'externalLinks', 'suspendMinutes', 'lazyTabs', 'alive', 'lockOnStart', 'lockOnHide', 'autoLockMinutes'];
  if (!allowed.includes(key)) return;
  store.set(key, value);
  if (key === 'startWithWindows') applyStartup();
  if (key === 'theme') applyTheme();
  if (key === 'hwAccel' || key === 'micDriverProcessing') {
    const r = await dialog.showMessageBox(win, {
      type: 'info', message: 'Reiniciar o MultiSocial para aplicar?', buttons: ['Reiniciar agora', 'Depois'], defaultId: 0, noLink: true
    });
    if (r.response === 0) { saveTabs(); store.saveNow(); app.relaunch(); quitting = true; app.exit(0); }
  }
  sendConfig();
}

// ---------------------------------------------------------------------------
// IPC com a interface
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('ui:init', () => ({
    locked,
    config: publicConfig(),
    services: allServices(),
    tabs: { active: activeId, tabs: tabs.map(tabInfo) },
    version: app.getVersion()
  }));
  ipcMain.on('ui:open-service', (_e, id, opts) => openService(id, opts || {}));
  ipcMain.on('ui:activate', (_e, id) => activateTab(id));
  ipcMain.on('ui:close-tab', (_e, id) => closeTab(id));
  ipcMain.on('ui:reorder', (_e, ids) => {
    const map = new Map(tabs.map((t) => [t.id, t]));
    const next = ids.map((i) => map.get(i)).filter(Boolean);
    if (next.length === tabs.length) { tabs = next; sendTabs(); }
  });
  ipcMain.on('ui:tab-menu', (_e, id) => tabMenu(id));
  ipcMain.on('ui:home-menu', (_e, id) => homeMenu(id));
  ipcMain.on('ui:downloads-menu', () => downloadsMenu());
  ipcMain.on('ui:open-settings', () => openSettingsTab());
  ipcMain.on('ui:nav', (_e, action) => {
    const wc = activeWc();
    if (!wc) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
  });
  ipcMain.handle('ui:set-config', (_e, key, value) => setConfig(key, value));
  ipcMain.handle('ui:pick-download-dir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pasta de downloads', defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) { store.set('downloadDir', r.filePaths[0]); sendConfig(); }
  });
  ipcMain.on('ui:icon-chosen', (_e, id, url) => {
    if (!getService(id) || !/^https:\/\//i.test(String(url))) return;
    store.set('iconBest', { ...(store.get('iconBest') || {}), [id]: String(url) });
    sendTabs();
  });
  ipcMain.on('ui:detach-tab', (_e, id, x, y) => detachTab(id, x, y));
  ipcMain.on('ui:open-browser', () => openBrowserNewTab());
  ipcMain.on('ui:toggle-mobile', () => { const t = activeTab(); if (t && t.type === 'service') toggleMobile(t.serviceId); });
  ipcMain.on('ui:lock', () => lockApp());
  ipcMain.handle('ui:unlock', (_e, pin) => unlockApp(pin));
  ipcMain.handle('ui:set-pin', (_e, current, next) => setPin(current, next));
  ipcMain.handle('ui:memory', () => memoryReport());
  ipcMain.on('web:nav', (e, dir) => {
    const wc = e.sender;
    if (dir === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (dir === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  ipcMain.on('ui:open-logs', () => { fs.mkdirSync(LOG_DIR, { recursive: true }); shell.openPath(LOG_DIR); });
  ipcMain.on('ui:open-download-dir', () => shell.openPath(downloadDir()));
  ipcMain.on('ui:logout', (_e, id) => logout(id));
  ipcMain.handle('ui:add-custom', (_e, { name, url, color }) => {
    let u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { new URL(u); } catch { return { ok: false, error: 'Endereço inválido.' }; }
    const n = String(name || '').trim() || new URL(u).hostname.replace(/^www\./, '');
    const c = {
      id: 'custom-' + Date.now().toString(36),
      name: n.slice(0, 24),
      url: u,
      color: [color || '#6C5CE7', color || '#4834D4'],
      glyph: n.slice(0, 2)
    };
    store.set('custom', [...(store.get('custom') || []), c]);
    sendConfig();
    fillCustomIcon(c.id);
    return { ok: true };
  });
  ipcMain.on('ui:find', (_e, text, opts) => {
    const wc = activeWc();
    if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); send('find:result', { active: 0, matches: 0 }); return; }
    wc.findInPage(text, opts || {});
  });
  ipcMain.on('ui:find-close', () => closeFind());
  ipcMain.on('ui:clear-all', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', message: 'Sair de TODAS as contas e apagar todos os dados?',
      detail: 'Serão apagados permanentemente deste computador (sem passar pela Lixeira): logins, cookies, armazenamento local, cache, '
        + 'permissões, zoom, logos salvas, abas salvas, dicionário pessoal e o log de diagnóstico de TODAS as redes.\n\nO app reinicia ao terminar.',
      buttons: ['Apagar tudo', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (r.response !== 0) return;
    for (const t of [...tabs]) closeTab(t.id);
    closedStack.length = 0;
    for (const s of allServices()) {
      // só mexe nas redes que já têm dados no disco (evita criar pastas à toa)
      if (fs.existsSync(path.join(PARTITIONS_DIR, partitionName(s.id)))) await wipeService(s.id);
    }
    // qualquer outra pasta de sessão que tenha sobrado (versões antigas, sites removidos)
    try {
      for (const name of fs.readdirSync(PARTITIONS_DIR)) {
        if (!wipeDir(path.join(PARTITIONS_DIR, name))) store.set('pendingWipe', [...new Set([...(store.get('pendingWipe') || []), name])]);
      }
    } catch {}
    try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch {}
    for (const k of ['favicons', 'perms', 'zoom', 'icons', 'iconBest']) store.set(k, {});
    store.set('lastTabs', []);
    store.set('iconsFetchedAt', 0);
    downloads.length = 0;
    try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch {}
    store.saveNow();
    // reinicia para soltar os arquivos em uso; o que sobrou é apagado na abertura
    app.relaunch();
    quitting = true;
    app.exit(0);
  });
  ipcMain.on('ui:check-updates', () => checkForUpdates(true));
  ipcMain.on('ui:external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

  ipcMain.on('web:flags', (e) => {
    const t = tabByWc(e.sender);
    let sid = t ? t.serviceId : null;
    if (!sid) { try { const w = BrowserWindow.fromWebContents(e.sender); sid = w && w.__serviceId; } catch {} }
    const svc = sid ? getService(sid) : null;
    const mode = store.get('mediaBar') || 'auto';
    // auto = em todos os sites, só nos vídeos que não têm linha do tempo própria (verificado vídeo a vídeo)
    const mediaBar = mode !== 'off';
    const mediaAll = mode === 'all';
    e.returnValue = { disablePasskeys: store.get('disablePasskeys') !== false, mic: store.get('micMode') || 'natural', mediaBar, mediaAll, service: svc ? svc.id : '' };
  });
  ipcMain.on('ui:reset-perms', () => { store.set('perms', {}); dialog.showMessageBox(win, { type: 'info', message: 'Permissões redefinidas.', detail: 'Os sites vão perguntar de novo antes de usar câmera, microfone, tela ou área de transferência.' }); });
  ipcMain.on('web:notif-click', (e) => {
    const t = tabByWc(e.sender);
    showMain();
    if (t) activateTab(t.id);
  });
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------
app.on('second-instance', () => showMain());
app.on('before-quit', () => { quitting = true; saveTabs(); store.saveNow(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

app.whenReady().then(() => {
  wipePending();
  Menu.setApplicationMenu(null);
  registerIpc();
  createMainWindow();
  createTray();
  applyStartup();

  // sites personalizados antigos sem logo
  for (const c of store.get('custom') || []) if (!c.icon) fillCustomIcon(c.id);

  // atualizações: ao iniciar e a cada 6 horas
  if (app.isPackaged) {
    setTimeout(() => { if (store.get('autoUpdateCheck')) checkForUpdates(false); }, 10000);
    setInterval(() => { if (store.get('autoUpdateCheck')) checkForUpdates(false); }, 6 * 3600 * 1000);
  }

  // logos antigas podiam ter ficado com a logo do Google (tela de login): limpa uma vez
  if ((store.get('faviconsV') || 0) < 2) { store.set('favicons', {}); store.set('faviconsV', 2); }
  setTimeout(() => refreshServiceIcons(false).catch(() => {}), 4000);

  // trava ao iniciar
  if (hasPin() && store.get('lockOnStart')) { locked = true; }

  if (store.get('restoreTabs')) {
    const last = store.get('lastTabs') || [];
    for (const t of last) {
      if (!getService(t.serviceId)) continue;
      // mensageiros carregam já (notificações); o resto só quando abrir a aba
      const lazy = store.get('lazyTabs') !== false && !keepAlive(t.serviceId);
      createServiceTab(t.serviceId, t.url || undefined, { activate: false, lazy });
    }
  }

  setInterval(hibernateTick, 60000);
  // vigia: se a aba visível ficar mais de 30s "carregando", recarrega (até 2 vezes)
  setInterval(() => {
    const t = activeTab();
    if (!t || !t.view || !t.loading || !t.loadStart || locked) return;
    if (Date.now() - t.loadStart > 30000 && (t.stuckRetries || 0) < 2) {
      t.stuckRetries = (t.stuckRetries || 0) + 1;
      log('aba travada carregando, recarregando', t.serviceId, t.stuckRetries);
      try { t.view.webContents.reloadIgnoringCache(); } catch {}
    }
  }, 5000);
  // PC voltou da suspensão / rede voltou: recarrega abas que ficaram na tela de erro
  const recoverAll = (why) => {
    log('recuperando abas:', why);
    for (const t of tabs) {
      if (!t.view) continue;
      const u = t.view.webContents.getURL();
      if (u.startsWith('data:') || t.view.webContents.isCrashed()) {
        try { t.view.webContents.loadURL(tabUrl(t) || (getService(t.serviceId) || {}).url); } catch {}
      }
    }
    const at = activeTab(); if (at) at.shown = false; layout();
  };
  powerMonitor.on('resume', () => setTimeout(() => recoverAll('PC retomou da suspensão'), 3000));
  powerMonitor.on('unlock-screen', () => recoverAll('tela do Windows desbloqueada'));
  // bloqueio automático por inatividade do PC
  setInterval(() => {
    const min = Number(store.get('autoLockMinutes')) || 0;
    if (!min || !hasPin() || locked) return;
    try { if (powerMonitor.getSystemIdleTime() >= min * 60) lockApp(); } catch {}
  }, 30000);
  activateTab('home');
});

