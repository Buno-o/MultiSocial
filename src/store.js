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
  pauseOnSwitch: true,
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
