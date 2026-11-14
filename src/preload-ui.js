const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ms', {
  invoke: (ch, ...args) => ipcRenderer.invoke(ch, ...args),
  send: (ch, ...args) => ipcRenderer.send(ch, ...args),
  on: (ch, fn) => {
    const h = (_e, ...args) => fn(...args);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  }
});
