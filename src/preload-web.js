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
