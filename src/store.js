// Configurações persistentes em %APPDATA%/MultiSocial/config.json
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  closeAction: null,          // null = perguntar | 'tray' | 'quit'
  trayBalloonShown: false,
  restoreTabs: true,
  lastTabs: [],
  startWithWindows: false,
  startMinimized: false,
  notifications: true,
  flashTaskbar: true,
  downloadDir: '',
  askDownload: false,
  hidden: [],                 // redes ocultas no início
  dock: ['whatsapp', 'instagram', 'gmail', 'telegram', 'youtube'],
  custom: [],                 // sites personalizados {id,name,url,color,glyph}
  favicons: {},
  theme: 'dark',              // 'dark' | 'light'
  iconSize: 'medium',         // 'small' | 'medium' | 'large'
  hwAccel: true,
  order: [],                  // ordem dos ícones no início (drag & drop)
  externalLinks: true,        // links para outros sites abrem no navegador padrão
  suspendMinutes: 15,         // suspende abas inativas (0 = nunca) para economizar RAM
  lazyTabs: true,             // abas restauradas só carregam quando abertas
  alive: {},                  // por rede: true = nunca suspender
  mobile: {},                 // por rede: true = modo celular
  icons: {},                  // logos buscadas dos sites
  iconBest: {},               // melhor logo escolhida entre várias fontes
  iconsFetchedAt: 0,
  faviconsV: 0,
  gen: {},                    // geração da pasta de dados de cada rede (muda ao sair da conta)
  pendingWipe: [],            // pastas a apagar na próxima abertura
  pinHash: '',                // PIN (scrypt)
  pinSalt: '',
  lockOnStart: true,
  lockOnHide: false,
  autoLockMinutes: 0,
  bgPlay: {},                 // por rede: true = continua tocando em 2º plano (sobrepõe o padrão)
  disablePasskeys: true,      // bloqueia popup de chave de acesso/pendrive
  perms: {},                  // permissões lembradas por rede        // pausar vídeos ao trocar de aba
  autoUpdateCheck: true,
  skipVersion: '',
  lastUpdateCheck: 0,
  zoom: {},
  windowBounds: null,
  maximized: false
};

let file = null;
let data = null;
let timer = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'config.json');
  try {
    data = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    data = Object.assign({}, DEFAULTS);
  }
  return data;
}

function saveNow() {
  clearTimeout(timer);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.error('config save failed', e); }
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 300);
}

module.exports = {
  init,
  get: (k) => data[k],
  set: (k, v) => { data[k] = v; save(); },
  all: () => data,
  saveNow
};
