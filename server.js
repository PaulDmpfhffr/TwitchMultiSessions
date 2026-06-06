const express = require('express')
const path = require('path')
const configStore = require('./src/configStore')
const sessionManager = require('./src/sessionManager')

const app = express()
const PORT = 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// --- Config ---

app.get('/api/config', (req, res) => {
  res.json(configStore.load())
})

app.post('/api/config', (req, res) => {
  const updated = configStore.update(req.body)
  res.json(updated)
})

// --- Sessions ---

app.post('/api/start', async (req, res) => {
  const { url, sessionCount, proxies, discret } = req.body

  if (!url || !url.includes('twitch.tv')) {
    return res.status(400).json({ error: 'URL Twitch invalide.' })
  }

  const count = Math.min(Math.max(1, parseInt(sessionCount) || 1), 10)

  configStore.update({ lastUrl: url, lastSessionCount: count, discret: !!discret })

  sessionManager.startSessions({ url, sessionCount: count, proxies: proxies || [], discret: !!discret })
    .catch(err => console.error('[/api/start]', err.message))

  res.json({ ok: true, message: `Lancement de ${count} session(s)…` })
})

app.post('/api/stop', async (req, res) => {
  await sessionManager.stopSessions()
  res.json({ ok: true, message: 'Toutes les sessions ont été arrêtées.' })
})

app.get('/api/status', (req, res) => {
  res.json(sessionManager.getStatus())
})

app.get('/api/session/:id/screenshot', async (req, res) => {
  const page = sessionManager.getPage(parseInt(req.params.id))
  if (!page) return res.status(404).end()
  try {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 40 })
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.send(buffer)
  } catch {
    res.status(500).end()
  }
})

// --- Démarrage ---

app.listen(PORT, () => {
  console.log(`\n  MVL démarré → http://localhost:${PORT}\n`)
})
