/* global ms */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let services = [];
let config = {};
let tabState = { active: 'home', tabs: [] };
let selectedIdx = -1;

// ------------------------------------------------------------------ Ícones
// ---- Logos: tenta várias fontes ao mesmo tempo e fica com a melhor (maior) que carregar
const iconCache = new Map();    // id -> url escolhida
const iconPending = new Map();  // id -> Promise
function iconCandidates(svc) {
  const list = [];
  const add = (u, min) => { if (u && !list.some((x) => x.u === u)) list.push({ u, min }); };
  add(config.iconBest && config.iconBest[svc.id], 16);   // melhor escolhida antes
  add(svc.icon, 16);                                     // logo fixa / buscada (personalizados)
  add(config.icons && config.icons[svc.id], 16);         // logo buscada no próprio site
  add(config.favicons && config.favicons[svc.id], 16);   // logo que aparece na aba
  let host = '';
  try { host = new URL(svc.url).hostname; } catch {}
  const parts = host.split('.');
  const base = parts.length > 2 ? parts.slice(-2).join('.') : host;
  for (const h of [...new Set([host, base])].filter(Boolean)) {
    add(`https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://${h}&size=128`, 24);
    add(`https://www.google.com/s2/favicons?domain=${h}&sz=128`, 24);
    add(`https://icons.duckduckgo.com/ip3/${h}.ico`, 16);
  }
  return list;
}
function probeImage(u, timeout = 6000) {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const done = (w) => { clearTimeout(t); img.onload = img.onerror = null; resolve(w); };
    const t = setTimeout(() => done(0), timeout);
    img.onload = () => done(img.naturalWidth || 0);
    img.onerror = () => done(0);
    img.src = u;
  });
}
function resolveIcon(svc) {
  if (iconCache.has(svc.id)) return Promise.resolve(iconCache.get(svc.id));
  if (iconPending.has(svc.id)) return iconPending.get(svc.id);
  const cands = iconCandidates(svc);
  const p = Promise.all(cands.map((c) => probeImage(c.u))).then((sizes) => {
    let best = null;
    let bestScore = -1;
    cands.forEach((c, i) => {
      const w = sizes[i];
      if (w < c.min) return;
      const score = Math.min(w, 128) - i * 3;   // maior resolução vence; empate fica com a fonte mais confiável
      if (score > bestScore) { bestScore = score; best = c.u; }
    });
    iconCache.set(svc.id, best);
    iconPending.delete(svc.id);
    if (best && (!config.iconBest || config.iconBest[svc.id] !== best)) ms.send('ui:icon-chosen', svc.id, best);
    return best;
  });
  iconPending.set(svc.id, p);
  return p;
}
function applyIconImage(icon, url) {
  if (!url) return;
  let img = icon.querySelector('img');
  if (!img) { img = new Image(); img.referrerPolicy = 'no-referrer'; icon.appendChild(img); }
  img.onload = () => icon.classList.add('fav-ok');
  img.src = url;
}
function makeIcon(svc, size) {
  const c = svc.color || ['#6c5ce7', '#4834d4'];
  const icon = el('div', 'icon' + (svc.dark ? ' dark-glyph' : ''));
  icon.style.background = `linear-gradient(145deg, ${c[0]}, ${c[1]})`;
  if (size) { icon.style.setProperty('--icon', size + 'px'); }
  const g = el('span', 'glyph');
  g.textContent = svc.glyph || svc.name.slice(0, 1);
  icon.appendChild(g);
  if (iconCache.has(svc.id)) applyIconImage(icon, iconCache.get(svc.id));
  else resolveIcon(svc).then((u) => applyIconImage(icon, u));
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
  d.addEventListener('dragend', (e) => {
    const wasDrag = dragId;
    dragId = null;
    d.classList.remove('dragging');
    document.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
    // não foi solto em outra aba: se saiu da barra de abas, vira janela independente
    if (wasDrag != null && e.dataTransfer.dropEffect === 'none' && (e.screenX || e.screenY)) {
      ms.send('ui:detach-tab', wasDrag, e.screenX, e.screenY);
    }
  });
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
  d.classList.toggle('suspended', !!t.suspended);
  const shortcut = i + 2 <= 8 ? `Ctrl+${i + 2}` : (i === tabState.tabs.length - 1 ? 'Ctrl+9' : '');
  d.title = `${t.name}${t.title && t.title !== t.name ? ' — ' + t.title : ''}${shortcut ? '  (' + shortcut + ')' : ''}${t.suspended ? '\nSuspensa para economizar memória — clique para carregar' : ''}`;
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
  const mb = $('#mobile-btn');
  mb.disabled = !isWeb;
  mb.classList.toggle('on', !!(isWeb && active.mobile));
  mb.title = isWeb ? (active.mobile ? `Sair do modo celular (${active.name})` : `Modo celular neste site (${active.name})`) : 'Modo celular (abra um site primeiro)';
  $('#web-bg').classList.toggle('mobile', !!(isWeb && active.mobile));
  setClockRunning(tabState.active === 'home');
  document.title = active ? `${active.name} — MultiSocial` : 'MultiSocial';
  renderHomeBadges();
}

// ------------------------------------------------------------------ Início
function orderedServices() {
  const order = config.order || [];
  const pos = new Map(order.map((id, i) => [id, i]));
  return services
    .map((s, i) => ({ s, k: pos.has(s.id) ? pos.get(s.id) : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s);
}
function visibleServices() {
  const hidden = new Set(config.hidden || []);
  return orderedServices().filter((s) => !hidden.has(s.id));
}

// ---- arrastar e soltar ícones (reordenar o início e o dock)
let dragSvc = null;      // { id, from: 'grid' | 'dock' }
function clearDropMarks() {
  document.querySelectorAll('.drop-left, .drop-right, .drag-src').forEach((n) => n.classList.remove('drop-left', 'drop-right', 'drag-src'));
  $('#dock').classList.remove('drop-target');
}
function enableDrag(a, svc, from) {
  a.draggable = true;
  a.addEventListener('dragstart', (e) => {
    if ($('#search').value) { e.preventDefault(); return; }
    dragSvc = { id: svc.id, from };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', svc.id);
    requestAnimationFrame(() => a.classList.add('drag-src'));
  });
  a.addEventListener('dragend', () => { dragSvc = null; clearDropMarks(); });
  a.addEventListener('dragover', (e) => {
    if (!dragSvc || dragSvc.id === svc.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = a.getBoundingClientRect();
    const right = e.clientX > r.left + r.width / 2;
    a.classList.toggle('drop-right', right);
    a.classList.toggle('drop-left', !right);
  });
  a.addEventListener('dragleave', () => a.classList.remove('drop-left', 'drop-right'));
  a.addEventListener('drop', (e) => {
    if (!dragSvc || dragSvc.id === svc.id) return;
    e.preventDefault();
    e.stopPropagation();
    const right = a.classList.contains('drop-right');
    const src = dragSvc;
    clearDropMarks();
    if (from === 'dock') {
      // soltou dentro do dock: fixa/reordena no dock
      const d = (config.dock || []).filter((x) => x !== src.id);
      let i = d.indexOf(svc.id) + (right ? 1 : 0);
      d.splice(i, 0, src.id);
      ms.invoke('ui:set-config', 'dock', d.slice(0, 7));
    } else {
      if (src.from === 'dock') { // tirou do dock e soltou no início: remove do dock
        ms.invoke('ui:set-config', 'dock', (config.dock || []).filter((x) => x !== src.id));
        return;
      }
      const ids = orderedServices().map((x) => x.id).filter((x) => x !== src.id);
      const i = ids.indexOf(svc.id) + (right ? 1 : 0);
      ids.splice(i, 0, src.id);
      config.order = ids;
      renderHome();
      ms.invoke('ui:set-config', 'order', ids);
    }
  });
}
// soltar no espaço vazio do dock = fixar no dock / no espaço do início = tirar do dock
$('#dock').addEventListener('dragover', (e) => { if (dragSvc) { e.preventDefault(); $('#dock').classList.add('drop-target'); } });
$('#dock').addEventListener('dragleave', (e) => { if (!$('#dock').contains(e.relatedTarget)) $('#dock').classList.remove('drop-target'); });
$('#dock').addEventListener('drop', (e) => {
  if (!dragSvc) return;
  e.preventDefault();
  const src = dragSvc;
  clearDropMarks();
  const d = (config.dock || []).filter((x) => x !== src.id);
  d.push(src.id);
  ms.invoke('ui:set-config', 'dock', d.slice(0, 7));
});
$('#home').addEventListener('dragover', (e) => { if (dragSvc && dragSvc.from === 'dock') e.preventDefault(); });
$('#home').addEventListener('drop', (e) => {
  if (!dragSvc || dragSvc.from !== 'dock') return;
  e.preventDefault();
  const src = dragSvc;
  clearDropMarks();
  ms.invoke('ui:set-config', 'dock', (config.dock || []).filter((x) => x !== src.id));
});
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
  a.style.animationDelay = inDock || homeRendered ? '0s' : `${Math.random() * 0.12}s`;
  if (homeRendered && !inDock) a.style.animation = 'none';
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
    enableDrag(t, svc, 'grid');
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
    if (s) { const t = appTile(s, true); enableDrag(t, s, 'dock'); dock.appendChild(t); }
  }
  homeRendered = true;
  renderHomeBadges();
}
let homeRendered = false;
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
let clockTimer = null;
function setClockRunning(on) {
  if (on && !clockTimer) { tickClock(); clockTimer = setInterval(tickClock, 1000); }
  if (!on && clockTimer) { clearInterval(clockTimer); clockTimer = null; }
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
const NUM_KEYS = new Set(['suspendMinutes', 'autoLockMinutes']);
const SETTING_KEYS = ['mediaBar', 'micMode', 'micDriverProcessing', 'externalLinks', 'suspendMinutes', 'lazyTabs', 'lockOnStart', 'lockOnHide', 'autoLockMinutes', 'disablePasskeys', 'autoUpdateCheck', 'closeAction', 'startWithWindows', 'startMinimized', 'restoreTabs', 'notifications', 'flashTaskbar', 'askDownload', 'theme', 'iconSize', 'hwAccel'];
function renderSettings() {
  for (const k of SETTING_KEYS) {
    const input = document.getElementById('set-' + k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = config[k] !== false && config[k] != null ? !!config[k] : false;
    else input.value = config[k] == null ? '' : config[k];
  }
  $('#dl-dir').textContent = config.resolvedDownloadDir || '';
  const list = $('#svc-list');
  list.innerHTML = '';
  const hidden = new Set(config.hidden || []);
  $('#pin-status').textContent = config.hasPin ? 'PIN definido. Clique no cadeado (barra superior) para bloquear.' : 'Nenhum PIN definido.';
  $('#pin-set').textContent = config.hasPin ? 'Alterar PIN' : 'Definir PIN';
  $('#pin-remove').classList.toggle('hidden', !config.hasPin);
  $('#lock-btn').classList.toggle('on', !!config.hasPin);
  $('#lock-btn').title = config.hasPin ? 'Bloquear agora' : 'Bloquear com PIN (definir PIN)';
  for (const s of orderedServices()) {
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
    const alVal = (config.alive || {})[s.id];
    const alWrap = el('label', 'mini-sw');
    alWrap.title = 'Sempre ativa: nunca suspender para economizar RAM (mantém notificações)';
    const al = el('input', 'switch');
    al.type = 'checkbox';
    al.checked = alVal === true || alVal === false ? alVal : !!s.alive;
    al.onchange = () => ms.invoke('ui:set-config', 'alive', { ...(config.alive || {}), [s.id]: al.checked });
    alWrap.append(el('span', '', 'Ativa'), al);
    row.appendChild(alWrap);
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
    if (NUM_KEYS.has(k)) v = Number(v) || 0;
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

// ------------------------------------------------------------------ Memória
async function refreshMemory() {
  const r = await ms.invoke('ui:memory');
  const parts = r.perTab.map((t) => `${t.name}: ${t.suspended ? 'suspensa' : t.mb + ' MB'}`);
  $('#mem-info').textContent = `Total do app: ${r.total} MB` + (parts.length ? ` · ${parts.join(' · ')}` : '');
}
$('#mem-refresh').onclick = refreshMemory;

// ------------------------------------------------------------------ PIN
function showPinModal() {
  const back = el('div', 'modal-back');
  back.innerHTML = `
    <form class="modal">
      <h3>${config.hasPin ? 'Alterar PIN' : 'Definir PIN'}</h3>
      <div class="custom-fields">
        ${config.hasPin ? '<input type="password" name="cur" inputmode="numeric" maxlength="8" placeholder="PIN atual" autocomplete="off">' : ''}
        <input type="password" name="pin" inputmode="numeric" maxlength="8" placeholder="Novo PIN (4 a 8 números)" autocomplete="off" required>
        <input type="password" name="pin2" inputmode="numeric" maxlength="8" placeholder="Confirmar novo PIN" autocomplete="off" required>
      </div>
      <small class="error"></small>
      <div class="actions"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">Salvar</button></div>
    </form>`;
  document.body.appendChild(back);
  const f = back.querySelector('form');
  (f.cur || f.pin).focus();
  back.querySelector('[data-cancel]').onclick = () => back.remove();
  f.addEventListener('keydown', (e) => { if (e.key === 'Escape') back.remove(); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = back.querySelector('.error');
    if (f.pin.value !== f.pin2.value) { err.textContent = 'Os PINs não conferem.'; return; }
    const r = await ms.invoke('ui:set-pin', f.cur ? f.cur.value : '', f.pin.value);
    if (!r.ok) { err.textContent = r.error; return; }
    back.remove();
  });
}
async function removePin() {
  const back = el('div', 'modal-back');
  back.innerHTML = `<form class="modal"><h3>Remover PIN</h3><div class="custom-fields"><input type="password" name="cur" inputmode="numeric" maxlength="8" placeholder="PIN atual" autocomplete="off" required></div>
    <small class="error"></small><div class="actions"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn danger">Remover</button></div></form>`;
  document.body.appendChild(back);
  const f = back.querySelector('form');
  f.cur.focus();
  back.querySelector('[data-cancel]').onclick = () => back.remove();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await ms.invoke('ui:set-pin', f.cur.value, null);
    if (!r.ok) { back.querySelector('.error').textContent = r.error; return; }
    back.remove();
  });
}
$('#pin-set').onclick = showPinModal;
$('#pin-remove').onclick = removePin;
ms.on('pin:setup', () => { ms.send('ui:open-settings'); setTimeout(showPinModal, 120); });

function setLocked(on) {
  $('#lockscreen').classList.toggle('hidden', !on);
  document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  if (on) { $('#unlock-pin').value = ''; $('#unlock-error').textContent = ''; setTimeout(() => $('#unlock-pin').focus(), 50); }
}
ms.on('lock', setLocked);
const focusPin = () => {
  if ($('#lockscreen').classList.contains('hidden')) return;
  const i = $('#unlock-pin');
  i.focus();
  i.select();
};
ms.on('lock:focus', focusPin);
window.addEventListener('focus', focusPin);
document.addEventListener('visibilitychange', () => { if (!document.hidden) focusPin(); });
$('#unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await ms.invoke('ui:unlock', $('#unlock-pin').value);
  if (r.ok) return;
  const card = document.querySelector('.lock-card');
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  $('#unlock-pin').value = '';
  $('#unlock-error').textContent = r.wait ? `Muitas tentativas. Aguarde ${r.wait}s.` : 'PIN incorreto.';
});
$('#lockscreen').addEventListener('mousedown', () => setTimeout(() => $('#unlock-pin').focus(), 0));

// ------------------------------------------------------------------ Barra superior
$('#browser-btn').addEventListener('click', () => ms.send('ui:open-browser'));
$('#mobile-btn').addEventListener('click', () => ms.send('ui:toggle-mobile'));
$('#lock-btn').addEventListener('click', () => ms.send('ui:lock'));
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
  setClockRunning(tabState.active === 'home');
  if (init.locked) setLocked(true);
})();
