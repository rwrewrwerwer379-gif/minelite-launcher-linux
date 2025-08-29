const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  chooseInstanceDir: () => ipcRenderer.invoke('choose-instance-dir'),
  chooseJavaPath: () => ipcRenderer.invoke('choose-java-path'),
  saveUserSettings: (data) => ipcRenderer.invoke('save-user-settings', data),
  launch: (data) => ipcRenderer.invoke('launch', data),
  stop: () => ipcRenderer.invoke('stop'),
  listPopularMods: () => ipcRenderer.invoke('mods:list-popular'),
  downloadMod: (payload) => ipcRenderer.invoke('mods:download', payload),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openModsDir: () => ipcRenderer.invoke('open-mods-dir'),
  javaAutoSelect: (version) => ipcRenderer.invoke('java:auto-select', version),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  listVersions: () => ipcRenderer.invoke('versions:list'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onLaunched: (cb) => ipcRenderer.on('launched', cb),
  onStopped: (cb) => ipcRenderer.on('stopped', (_e, code) => cb(code)),
  // Comments API
  listComments: () => ipcRenderer.invoke('comments:list'),
  addComment: (payload) => ipcRenderer.invoke('comments:add', payload),
  deleteComment: (id) => ipcRenderer.invoke('comments:delete', id),
});
