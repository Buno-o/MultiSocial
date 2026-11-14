// Preload injetado nas páginas das redes sociais.
// Faz o clique numa notificação trazer o MultiSocial para frente na aba certa.
const { ipcRenderer, webFrame } = require('electron');

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
