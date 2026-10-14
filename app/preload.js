'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('maps', {
  run: (req) => ipcRenderer.invoke('run', req),
  copy: (text) => ipcRenderer.invoke('copy', text)
})
