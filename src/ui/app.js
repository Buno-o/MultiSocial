/* global ms */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let services = [];
let config = {};
let tabState = { active: 'home', tabs: [] };
let selectedIdx = -1;

// ------------------------------------------------------------------ Ícones
function faviconFor(svc) {
  // retorna [url, tamanho mínimo aceito]
  if (svc.icon) return [svc.icon, 1];                                   // logo buscada do site (personalizados)
  if (config.favicons && config.favicons[svc.id]) return [config.favicons[svc.id], 1]; // logo que aparece na aba
  try { return [`https://www.google.com/s2/favicons?domain=${new URL(svc.url).hostname}&sz=128`, 24]; } catch { return ['', 0]; }
}
function makeIcon(svc, size) {
  const c = svc.color || ['#6c5ce7', '#4834d4'];
  const icon = el('div', 'icon' + (svc.dark ? ' dark-glyph' : ''));
  icon.style.background = `linear-gradient(145deg, ${c[0]}, ${c[1]})`;
  if (size) { icon.style.setProperty('--icon', size + 'px'); }
  const g = el('span', 'glyph');
  g.textContent = svc.glyph || svc.name.slice(0, 1);
  icon.appendChild(g);
  const [src, min] = faviconFor(svc);
  if (src) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const fallback = svc.icon && config.favicons && config.favicons[svc.id] !== svc.icon ? config.favicons[svc.id] : null;
    img.onload = () => { if (img.naturalWidth >= min) icon.classList.add('fav-ok'); };
    img.onerror = () => { if (fallback && img.src !== fallback) img.src = fallback; };
    img.src = src;
    icon.appendChild(img);
  }
  return icon;
}
function tabFav(t) {
  const f = el('div', 'fav');
  const c = t.color || ['#6c7cff', '#4a5be0'];
  if (t.type === 'settings') {
    f.innerHTML = '<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--muted)"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>';
    return f;
  }
  if (t.favicon) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.src = t.favicon;
    img.onerror = () => { f.innerHTML = ''; f.style.background = `linear-gradient(145deg, ${c[0]}, ${c[1]})`; f.appendChild(el('span', '', esc((t.glyph || t.name || '?').slice(0, 2)))); };
    f.appendChild(img);
  } else {
    f.style.background = `linear-gradient(145deg, ${c[0]}, ${c[1]})`;
    if (t.dark) f.style.color = '#111';
    f.appendChild(el('span', '', esc((t.glyph || t.name || '?').slice(0, 2))));
  }
  return f;
}

// ------------------------------------------------------------------ Abas
// Os elementos das abas são reaproveitados entre atualizações: recriar a barra
// a cada evento fazia o clique no (x) e o arrastar se perderem.
let dragId = null;
const tabEls = new Map();

function createTabEl(id) {
  const d = el('div', 'tab');
  d.draggable = true;
  d.dataset.id = id;
  d.favBox = el('div', 'fav-box');
  d.labelEl = el('span', 'label');
  d.audioEl = el('span', 'audio');
  d.badgeEl = el('span', 'badge');
  d.closeEl = el('button', 'close', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>');
  d.closeEl.title = 'Fechar (Ctrl+W)';
  d.append(d.favBox, d.labelEl, d.audioEl, d.badgeEl, d.closeEl);

  d.closeEl.addEventListener('mousedown', (e) => e.stopPropagation());
  d.closeEl.addEventListener('click', (e) => { e.stopPropagation(); ms.send('ui:close-tab', id); });
  d.addEventListener('mousedown', (e) => { if (e.button === 0) ms.send('ui:activate', id); });
  d.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); ms.send('ui:close-tab', id); } });
  d.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  d.addEventListener('contextmenu', (e) => { e.preventDefault(); ms.send('ui:tab-menu', id); });

  d.addEventListener('dragstart', (e) => { dragId = id; d.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  d.addEventListener('dragend', () => { dragId = null; d.classList.remove('dragging'); document.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before')); });
  d.addEventListener('dragover', (e) => { if (dragId == null || dragId === id) return; e.preventDefault(); d.classList.add('drop-before'); });
  d.addEventListener('dragleave', () => d.classList.remove('drop-before'));
  d.addEventListener('drop', (e) => {
    e.preventDefault();
    d.classList.remove('drop-before');
    if (dragId == null || dragId === id) return;
    const ids = tabState.tabs.map((x) => x.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(id), 0, dragId);
    ms.send('ui:reorder', ids);
  });
  return d;
}

function updateTabEl(d, t, i) {
  d.classList.toggle('active', t.id === tabState.active);
  d.classList.toggle('loading', !!t.loading);
  const shortcut = i + 2 <= 8 ? `Ctrl+${i + 2}` : (i === tabState.tabs.length - 1 ? 'Ctrl+9' : '');
  d.title = `${t.name}${t.title && t.title !== t.name ? ' — ' + t.title : ''}${shortcut ? '  (' + shortcut + ')' : ''}`;
  const favKey = `${t.type}|${t.favicon}|${t.glyph}`;
  if (d.favKey !== favKey) { d.favKey = favKey; d.favBox.replaceChildren(tabFav(t)); }
  if (d.labelEl.textContent !== t.name) d.labelEl.textContent = t.name;
  const audio = t.muted ? 'muted' : (t.audible ? 'on' : '');
  if (d.audioKey !== audio) {
    d.audioKey = audio;
    d.audioEl.innerHTML = audio === 'muted'
      ? '<svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/></svg>'
      : audio === 'on' ? '<svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>' : '';
    d.audioEl.style.display = audio ? '' : 'none';
  }
  d.badgeEl.textContent = t.badge ? (t.badge > 99 ? '99+' : t.badge) : '';
  d.badgeEl.style.display = t.badge ? '' : 'none';
}

function renderTabs() {
  const box = $('#tabs');
  const seen = new Set();
  tabState.tabs.forEach((t, i) => {
    let d = tabEls.get(t.id);
    if (!d) { d = createTabEl(t.id); tabEls.set(t.id, d); }
    updateTabEl(d, t, i);
    if (box.children[i] !== d) box.insertBefore(d, box.children[i] || null);
    seen.add(t.id);
  });
  for (const [id, d] of tabEls) if (!seen.has(id)) { d.remove(); tabEls.delete(id); }
  box.ondragover = (e) => { if (dragId != null) e.preventDefault(); };
  box.ondrop = (e) => {
    if (e.target !== box || dragId == null) return;
    const ids = tabState.tabs.map((x) => x.id).filter((x) => x !== dragId);
    ids.push(dragId);
    ms.send('ui:reorder', ids);
  };

  const active = tabState.tabs.find((t) => t.id === tabState.active);
  $('#home-tab').classList.toggle('active', tabState.active === 'home');
  $('#home').classList.toggle('hidden', tabState.active !== 'home');
  $('#settings').classList.toggle('hidden', !(active && active.type === 'settings'));
  $('#web-bg').classList.toggle('hidden', !(active && active.type === 'service'));
  const isWeb = !!(active && active.type === 'service');
  $('#nav').classList.toggle('hidden', !isWeb);
  if (isWeb) {
    $('[data-nav=back]').disabled = !active.canBack;
    $('[data-nav=forward]').disabled = !active.canForward;
  }
  document.title = active ? `${active.name} — MultiSocial` : 'MultiSocial';
  renderHomeBadges();
}

// ------------------------------------------------------------------ Início
function visibleServices() {
  const hidden = new Set(config.hidden || []);
  return services.filter((s) => !hidden.has(s.id));
}
function filteredServices() {
  const q = $('#search').value.trim().toLowerCase();
  const list = visibleServices();
  return q ? list.filter((s) => s.name.toLowerCase().includes(q) || s.id.includes(q)) : list;
}
function openFromHome(svc, e) {
  const newTab = e && (e.ctrlKey || e.button === 1);
  ms.send('ui:open-service', svc.id, { newTab, background: e && e.button === 1 });
}
function appTile(svc, inDock) {
  const a = el('div', 'app');
  a.dataset.id = svc.id;
  a.title = svc.name;
  a.style.animationDelay = inDock ? '0s' : `${Math.random() * 0.12}s`;
  a.appendChild(makeIcon(svc));
  a.appendChild(el('div', 'name', esc(svc.name)));
  a.addEventListener('click', (e) => openFromHome(svc, e));
  a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openFromHome(svc, e); } });
  a.addEventListener('contextmenu', (e) => { e.preventDefault(); ms.send('ui:home-menu', svc.id); });
  return a;
}
function renderHome() {
  const grid = $('#grid');
  grid.className = 'grid ' + (config.iconSize || 'medium');
  grid.innerHTML = '';
  const list = filteredServices();
  list.forEach((svc, i) => {
    const t = appTile(svc);
    if (i === selectedIdx) t.classList.add('selected');
    grid.appendChild(t);
  });
  if (!$('#search').value) {
    const add = el('div', 'app add');
    add.innerHTML = '<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></div><div class="name">Adicionar</div>';
    add.title = 'Adicionar site personalizado';
    add.addEventListener('click', showAddModal);
    grid.appendChild(add);
  }
  const dock = $('#dock');
  dock.innerHTML = '';
  for (const id of config.dock || []) {
    const s = services.find((x) => x.id === id);
    if (s) dock.appendChild(appTile(s, true));
  }
  renderHomeBadges();
}
function renderHomeBadges() {
  const counts = {};
  const open = new Set();
  for (const t of tabState.tabs) {
    if (!t.serviceId) continue;
    open.add(t.serviceId);
    counts[t.serviceId] = (counts[t.serviceId] || 0) + (t.badge || 0);
  }
  document.querySelectorAll('.app[data-id]').forEach((a) => {
    a.querySelectorAll('.badge, .open-dot').forEach((n) => n.remove());
    const id = a.dataset.id;
    if (counts[id]) a.appendChild(el('span', 'badge', counts[id] > 99 ? '99+' : counts[id]));
    if (open.has(id) && !a.closest('.dock')) a.appendChild(el('span', 'open-dot'));
  });
}
function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const txt = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#date').textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

$('#search').addEventListener('input', () => { selectedIdx = $('#search').value ? 0 : -1; renderHome(); });
$('#search').addEventListener('keydown', (e) => {
  const list = filteredServices();
  if (e.key === 'Enter' && list.length) {
    const svc = list[Math.max(0, selectedIdx)];
    openFromHome(svc, e);
    $('#search').value = '';
    selectedIdx = -1;
    renderHome();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    selectedIdx = Math.min(list.length - 1, selectedIdx + 1); renderHome(); e.preventDefault();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    selectedIdx = Math.max(0, selectedIdx - 1); renderHome(); e.preventDefault();
  } else if (e.key === 'Escape') {
    $('#search').value = ''; selectedIdx = -1; renderHome();
  }
});

// ------------------------------------------------------------------ Site personalizado
async function addCustom(name, url, color, errEl) {
  const r = await ms.invoke('ui:add-custom', { name, url, color });
  if (!r.ok) { errEl.textContent = r.error; return false; }
  errEl.textContent = '';
  return true;
}
function showAddModal() {
  const back = el('div', 'modal-back');
  back.innerHTML = `
    <form class="modal">
      <h3>Adicionar site personalizado</h3>
      <div class="custom-fields">
        <input type="text" name="name" placeholder="Nome (ex.: Gmail)" maxlength="24">
        <input type="text" name="url" placeholder="Endereço (ex.: mail.google.com)" required>
        <label style="display:flex;align-items:center;gap:8px;color:var(--muted)">Cor do ícone <input type="color" name="color" value="#6c5ce7"></label>
      </div>
      <small class="error"></small>
      <div class="actions"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Adicionar</button></div>
    </form>`;
  document.body.appendChild(back);
  const f = back.querySelector('form');
  f.name.focus();
  back.addEventListener('mousedown', (e) => { if (e.target === back) back.remove(); });
  back.querySelector('[data-cancel]').onclick = () => back.remove();
  f.addEventListener('keydown', (e) => { if (e.key === 'Escape') back.remove(); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await addCustom(f.name.value, f.url.value, f.color.value, back.querySelector('.error'))) back.remove();
  });
}

// ------------------------------------------------------------------ Configurações
const SETTING_KEYS = ['disablePasskeys', 'autoUpdateCheck', 'closeAction', 'startWithWindows', 'startMinimized', 'restoreTabs', 'notifications', 'flashTaskbar', 'askDownload', 'theme', 'iconSize', 'hwAccel'];
function renderSettings() {
  for (const k of SETTING_KEYS) {
    const input = document.getElementById('set-' + k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!config[k];
    else input.value = config[k] == null ? '' : config[k];
  }
  $('#dl-dir').textContent = config.resolvedDownloadDir || '';
  const list = $('#svc-list');
  list.innerHTML = '';
  const hidden = new Set(config.hidden || []);
  for (const s of services) {
    const row = el('div', 'svc-item');
    row.appendChild(makeIcon(s, 30));
    row.appendChild(el('span', 'n', esc(s.name)));
    const bgVal = (config.bgPlay || {})[s.id];
    const bgWrap = el('label', 'mini-sw');
    bgWrap.title = 'Continuar reproduzindo em segundo plano';
    const bg = el('input', 'switch');
    bg.type = 'checkbox';
    bg.checked = bgVal === true || bgVal === false ? bgVal : !!s.bg;
    bg.onchange = () => ms.invoke('ui:set-config', 'bgPlay', { ...(config.bgPlay || {}), [s.id]: bg.checked });
    bgWrap.append(el('span', '', '2º plano'), bg);
    row.appendChild(bgWrap);
    const out = el('button', 'btn small', 'Sair');
    out.title = 'Sair da conta desta rede';
    out.onclick = () => ms.send('ui:logout', s.id);
    row.appendChild(out);
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = !hidden.has(s.id);
    sw.title = 'Mostrar no início';
    const swWrap = el('label', 'mini-sw');
    swWrap.title = 'Mostrar no início';
    sw.onchange = () => {
      const h = new Set(config.hidden || []);
      if (sw.checked) h.delete(s.id); else h.add(s.id);
      ms.invoke('ui:set-config', 'hidden', [...h]);
    };
    swWrap.append(el('span', '', 'Início'), sw);
    row.appendChild(swWrap);
    list.appendChild(row);
  }
}
for (const k of SETTING_KEYS) {
  const input = document.getElementById('set-' + k);
  if (!input) continue;
  input.addEventListener('change', () => {
    let v = input.type === 'checkbox' ? input.checked : input.value;
    if (k === 'closeAction' && v === '') v = null;
    ms.invoke('ui:set-config', k, v);
  });
}
$('#dl-change').onclick = () => ms.invoke('ui:pick-download-dir');
$('#dl-open').onclick = () => ms.send('ui:open-download-dir');
$('#clear-all').onclick = () => ms.send('ui:clear-all');
$('#open-logs').onclick = () => ms.send('ui:open-logs');
$('#reset-perms').onclick = () => ms.send('ui:reset-perms');
$('#check-updates').onclick = () => ms.send('ui:check-updates');
ms.on('update:status', (st) => {
  const b = $('#check-updates');
  b.disabled = st !== 'idle';
  b.textContent = st === 'checking' ? 'Verificando…' : st === 'downloading' ? 'Baixando…' : 'Verificar agora';
});
ms.on('update:progress', (p) => { $('#check-updates').textContent = `Baixando… ${Math.round(p * 100)}%`; });
$('#custom-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await addCustom($('#custom-name').value, $('#custom-url').value, $('#custom-color').value, $('#custom-error'))) {
    $('#custom-name').value = ''; $('#custom-url').value = '';
  }
});

function applyConfig() {
  document.body.className = config.theme === 'light' ? 'theme-light' : 'theme-dark';
  renderHome();
  renderSettings();
}

// ------------------------------------------------------------------ Barra superior
$('#home-tab').addEventListener('click', () => ms.send('ui:activate', 'home'));
$('#new-tab').addEventListener('click', () => { ms.send('ui:activate', 'home'); setTimeout(() => $('#search').focus(), 30); });
$('#settings-btn').addEventListener('click', () => ms.send('ui:open-settings'));
$('#dl-btn').addEventListener('click', () => ms.send('ui:downloads-menu'));
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => ms.send('ui:nav', b.dataset.nav)));

// ------------------------------------------------------------------ Buscar na página
const findInput = $('#find-input');
let lastFind = '';
findInput.addEventListener('input', () => {
  lastFind = findInput.value;
  ms.send('ui:find', lastFind, { findNext: false });
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (lastFind) ms.send('ui:find', lastFind, { forward: !e.shiftKey, findNext: true }); }
  if (e.key === 'Escape') ms.send('ui:find-close');
});
$('#find-next').onclick = () => lastFind && ms.send('ui:find', lastFind, { forward: true, findNext: true });
$('#find-prev').onclick = () => lastFind && ms.send('ui:find', lastFind, { forward: false, findNext: true });
$('#find-close').onclick = () => ms.send('ui:find-close');

// ------------------------------------------------------------------ Eventos do processo principal
ms.on('tabs', (s) => { tabState = s; renderTabs(); });
ms.on('config', (d) => { config = d.config; services = d.services; applyConfig(); });
ms.on('focus-search', () => setTimeout(() => $('#search').focus(), 30));
ms.on('find:open', () => { $('#findbar').classList.remove('hidden'); findInput.focus(); findInput.select(); if (findInput.value) ms.send('ui:find', findInput.value, { findNext: false }); });
ms.on('find:close', () => { $('#findbar').classList.add('hidden'); $('#find-count').textContent = '0/0'; });
ms.on('find:result', (r) => { $('#find-count').textContent = `${r.active || 0}/${r.matches || 0}`; });
ms.on('downloads', (d) => {
  const b = $('#dl-btn');
  b.classList.toggle('active', d.active > 0);
  b.classList.toggle('indeterminate', d.progress > 1);
  const circle = b.querySelector('.ring circle');
  const p = d.progress >= 0 && d.progress <= 1 ? d.progress : 0;
  circle.style.strokeDashoffset = String(94.25 * (1 - p));
  b.title = d.active ? `Downloads (${d.active} em andamento)` : 'Downloads';
});

(async () => {
  const init = await ms.invoke('ui:init');
  config = init.config;
  services = init.services;
  tabState = init.tabs;
  $('#version').textContent = 'v' + init.version;
  $('#cur-version').textContent = 'Versão instalada: ' + init.version;
  applyConfig();
  renderTabs();
  tickClock();
  setInterval(tickClock, 1000);
})();
