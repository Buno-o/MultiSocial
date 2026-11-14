// MultiSocial — processo principal
const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, dialog, shell,
  session, nativeImage, Notification, clipboard, net
} = require('electron');
const { spawn } = require('child_process');
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
// Utilidades
// ---------------------------------------------------------------------------
function allServices() {
  return [...SERVICES, ...(store.get('custom') || [])];
}
function getService(id) {
  return allServices().find((s) => s.id === id);
}
function getSession(serviceId) {
  const ses = session.fromPartition(`persist:ms-${serviceId}`);
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
const ALLOWED_PERMS = new Set([
  'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen',
  'pointerLock', 'mediaKeySystem', 'speaker-selection', 'window-management', 'display-capture'
]);
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
  const allow = (perm) => {
    if (perm === 'notifications') return !!store.get('notifications');
    return ALLOWED_PERMS.has(perm);
  };
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allow(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => allow(perm));
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
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.removeMenu();

  const startHidden = process.argv.includes('--hidden') || store.get('startMinimized');
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  win.on('resize', layout);
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
    const wc = activeWc();
    if (wc && !findOpen) wc.focus();
  });

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
    if (t.id === activeId) {
      t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
      t.view.setVisible(true);
    } else {
      t.view.setVisible(false);
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
    favicon: t.favicon || (t.serviceId && store.get('favicons')[t.serviceId]) || (svc && svc.icon) || '',
    badge: t.badge || 0,
    loading: !!t.loading,
    muted: !!t.muted,
    audible: !!t.audible,
    url: t.view ? t.view.webContents.getURL() : '',
    canBack: t.view ? t.view.webContents.navigationHistory.canGoBack() : false,
    canForward: t.view ? t.view.webContents.navigationHistory.canGoForward() : false,
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
    url: t.view && /^https?:/i.test(t.view.webContents.getURL()) ? t.view.webContents.getURL() : ''
  })));
}

function createServiceTab(serviceId, url, opts = {}) {
  const svc = getService(serviceId);
  if (!svc) return null;
  const ses = getSession(serviceId);
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: WEB_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false
    }
  });
  view.setBackgroundColor('#ffffff');
  const tab = { id: nextTabId++, type: 'service', serviceId, view, title: svc.name, favicon: '', badge: 0, loading: true };
  const idx = opts.afterId ? tabs.findIndex((t) => t.id === opts.afterId) + 1 : tabs.length;
  tabs.splice(idx > 0 ? idx : tabs.length, 0, tab);

  view.setVisible(false);
  win.contentView.addChildView(view);
  wireWebContents(view.webContents, { serviceId, tab });

  const zoom = (store.get('zoom') || {})[serviceId];
  view.webContents.on('did-finish-load', () => { if (zoom) view.webContents.setZoomFactor(zoom); });
  view.webContents.loadURL(url || svc.url).catch(() => {});

  if (opts.activate !== false) activateTab(tab.id);
  else { layout(); sendTabs(); }
  return tab;
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

function activateTab(id) {
  if (id !== 'home' && !tabs.find((t) => t.id === id)) id = 'home';
  const prev = activeTab();
  if (prev && prev.view && prev.id !== id && store.get('pauseOnSwitch')) pauseVideos(prev.view.webContents);
  if (findOpen) closeFind();
  activeId = id;
  layout();
  const t = activeTab();
  if (t && t.view) t.view.webContents.focus();
  else if (win) win.webContents.focus();
  sendTabs();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const t = tabs[idx];
  if (t.type === 'service') {
    const u = t.view.webContents.getURL();
    closedStack.push({ serviceId: t.serviceId, url: /^https?:/i.test(u) ? u : '' });
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

function moveTabToWindow(t) {
  if (!t || !t.view) return;
  const url = t.view.webContents.getURL();
  const sid = t.serviceId;
  closeTab(t.id);
  closedStack.pop();
  openWindow(url, sid);
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
    alwaysOnTop: !!opts.mini,
    autoHideMenuBar: true,
    icon: ICON,
    title: svc ? svc.name : 'MultiSocial',
    backgroundColor: '#ffffff',
    webPreferences: { session: ses, preload: WEB_PRELOAD, contextIsolation: true, sandbox: true, spellcheck: true }
  });
  w.removeMenu();
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
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, width: 620, height: 760 } };
    }
    if (tab) createServiceTab(ctx.serviceId, url, { activate: disposition !== 'background-tab', afterId: tab.id });
    else openWindow(url, ctx.serviceId);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    child.removeMenu();
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
      if (favs && favs.length) {
        tab.favicon = favs[0];
        const f = store.get('favicons') || {};
        if (f[tab.serviceId] !== favs[0]) { f[tab.serviceId] = favs[0]; store.set('favicons', f); sendConfig(); }
        sendTabs();
      }
    });
    wc.on('did-start-loading', () => { tab.loading = true; sendTabs(); });
    wc.on('did-stop-loading', () => { tab.loading = false; sendTabs(); });
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
      if (d.reason !== 'clean-exit') setTimeout(() => { try { wc.reload(); } catch {} }, 1500);
    });
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
  const wc = t.view.webContents;
  const svc = getService(t.serviceId);
  Menu.buildFromTemplate([
    { label: 'Recarregar', click: () => wc.reload() },
    { label: 'Duplicar aba', click: () => createServiceTab(t.serviceId, wc.getURL(), { afterId: t.id }) },
    { label: 'Voltar ao início da rede', click: () => wc.loadURL(svc.url) },
    { type: 'separator' },
    { label: 'Abrir em nova janela', click: () => moveTabToWindow(t) },
    { label: 'Mini janela flutuante (sempre no topo)', click: () => openWindow(wc.getURL(), t.serviceId, { mini: true }) },
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

async function logout(serviceId) {
  const svc = getService(serviceId);
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Sair da conta',
    message: `Sair da conta do ${svc ? svc.name : serviceId}?`,
    detail: 'Todos os dados de login, cookies e cache desta rede serão apagados deste computador.',
    buttons: ['Sair da conta', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (r.response !== 0) return;
  const ses = getSession(serviceId);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache().catch(() => {});
  for (const t of tabs.filter((x) => x.serviceId === serviceId)) t.view.webContents.loadURL(svc.url);
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
// Configurações
// ---------------------------------------------------------------------------
function publicConfig() {
  const c = { ...store.all() };
  delete c.lastTabs;
  delete c.windowBounds;
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
    'askDownload', 'hidden', 'dock', 'theme', 'iconSize', 'hwAccel', 'downloadDir', 'pauseOnSwitch', 'autoUpdateCheck'];
  if (!allowed.includes(key)) return;
  store.set(key, value);
  if (key === 'startWithWindows') applyStartup();
  if (key === 'theme') applyTheme();
  if (key === 'hwAccel') {
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
      type: 'warning', message: 'Sair de TODAS as contas e limpar todos os dados?',
      detail: 'Logins, cookies e cache de todas as redes serão apagados.', buttons: ['Limpar tudo', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (r.response !== 0) return;
    for (const s of allServices()) {
      const ses = getSession(s.id);
      await ses.clearStorageData();
      await ses.clearCache();
    }
    for (const t of tabs.filter((x) => x.view)) t.view.webContents.loadURL(getService(t.serviceId).url);
  });
  ipcMain.on('ui:check-updates', () => checkForUpdates(true));
  ipcMain.on('ui:external', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

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

  if (store.get('restoreTabs')) {
    const last = store.get('lastTabs') || [];
    for (const t of last) {
      if (getService(t.serviceId)) createServiceTab(t.serviceId, t.url || undefined, { activate: false });
    }
  }
  activateTab('home');
});

