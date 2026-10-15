'use strict'
const path = require('path')
const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')

const worker = PearRuntime.run(path.join(__dirname, 'worker.js'))
worker.stdout.on('data', (data) => process.stdout.write(data))
worker.stderr.on('data', (data) => process.stderr.write(data))
const pipe = new FramedStream(worker)

const pending = new Map()
let seq = 0

pipe.on('data', (data) => {
  // a malformed frame, or a reply for an id already settled, must not throw out of this handler:
  // uncaught here takes the Electron main process down
  let msg
  try {
    msg = JSON.parse(data.toString())
  } catch {
    return
  }
  const { id, ok, result, error } = msg
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  if (ok) p.resolve(result)
  else p.reject(new Error(error))
})

pipe.on('close', () => {
  for (const p of pending.values()) p.reject(new Error('worker closed'))
  pending.clear()
})

function request (msg) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    pipe.write(JSON.stringify({ ...msg, id }))
  })
}

ipcMain.handle('run', (e, req) => request({ ...req, op: 'run' }).then((r) => {
  for (const l of r.lines) console.log(l)
  return r
}))
ipcMain.handle('copy', (e, text) => clipboard.writeText(text))

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 700,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  return win.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', async () => {
  try {
    await request({ op: 'close' })
  } catch (err) {
    console.error(err.message)
  } finally {
    pipe.destroy()
    app.quit()
  }
})
