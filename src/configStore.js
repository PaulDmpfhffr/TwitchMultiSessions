const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')

const DEFAULT_CONFIG = {
  proxies: [
    { id: 1, label: 'Connexion directe (Box)', address: '', active: true },
    { id: 2, label: 'Proxy 2', address: '', active: false },
    { id: 3, label: 'Proxy 3', address: '', active: false },
    { id: 4, label: 'Proxy 4', address: '', active: false },
    { id: 5, label: 'Proxy 5', address: '', active: false },
  ],
  lastUrl: '',
  lastSessionCount: 2,
  throttleKbps: 500,
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    save(DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return DEFAULT_CONFIG
  }
}

function save(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

function update(partial) {
  const current = load()
  const updated = { ...current, ...partial }
  save(updated)
  return updated
}

module.exports = { load, save, update }
