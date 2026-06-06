const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')
const { TWITCH_INIT_SCRIPT, TWITCH_QUALITY_WATCHDOG } = require('./twitchInjector')

const TMP_DIR = path.join(__dirname, '..', 'tmp')

// Parse une adresse proxy et extrait les credentials si présents.
// Supporte : socks5://ip:port, http://ip:port, socks5://user:pass@ip:port
function parseProxy(address) {
  try {
    const url = new URL(address)
    const proxy = { server: `${url.protocol}//${url.host}` }
    if (url.username) proxy.username = decodeURIComponent(url.username)
    if (url.password) proxy.password = decodeURIComponent(url.password)
    return proxy
  } catch {
    // Pas une URL valide → on passe la chaîne telle quelle à Playwright
    return { server: address }
  }
}

// État en mémoire des sessions actives
const sessions = new Map() // id → { context, page, status, proxy, startedAt }

function getStatus() {
  const result = []
  for (const [id, session] of sessions.entries()) {
    result.push({
      id,
      status: session.status,
      proxy: session.proxy || 'Connexion directe',
      startedAt: session.startedAt,
      error: session.error || null,
    })
  }
  return result
}

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })
}

function sessionDir(id) {
  return path.join(TMP_DIR, `session-${id}`)
}

// Colonnes de 2 fenêtres, empilées en bas à droite de l'écran principal.
// Supposons un écran 1920×1080 ; les fenêtres compactes font 420×260.
const COMPACT_W = 420
const COMPACT_H = 260
const COMPACT_MARGIN = 8
const SCREEN_W = 1920
const SCREEN_H = 1080

function compactPosition(id) {
  const col = (id - 1) % 2
  const row = Math.floor((id - 1) / 2)
  const x = SCREEN_W - (COMPACT_W + COMPACT_MARGIN) * (2 - col)
  const y = SCREEN_H - (COMPACT_H + COMPACT_MARGIN) * (row + 1)
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

async function startSessions({ url, sessionCount, proxies, discret = false, throttleKbps = 0 }) {
  if (sessions.size > 0) throw new Error('Des sessions sont déjà actives. Arrêtez-les d\'abord.')

  ensureTmpDir()

  const launches = []
  for (let i = 0; i < sessionCount; i++) {
    launches.push(launchSession(i + 1, url, proxies[i] || null, discret, throttleKbps))
  }

  Promise.allSettled(launches)
}

async function setCdpThrottle(context, page, kbps) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: Math.round(kbps * 1000 / 8),
    uploadThroughput: Math.round(kbps * 100 / 8),
    latency: 20,
  })
}

// Détecte le bitrate réel de la qualité active via l'API React du player,
// puis applique un throttle à 1.5× ce bitrate (marge de buffering).
// Si la détection échoue, utilise fallbackKbps.
async function applyAdaptiveThrottle(context, page, maxKbps, fallbackKbps) {
  if (!maxKbps || maxKbps <= 0) return

  let streamKbps = null

  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      streamKbps = await page.evaluate(() => {
        const playerEl = document.querySelector('[data-a-target="video-player"]')
        if (!playerEl) return null
        const reactKey = Object.keys(playerEl).find(
          k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        )
        if (!reactKey) return null
        let fiber = playerEl[reactKey]
        let depth = 0
        while (fiber && depth < 80) {
          const props = fiber.memoizedProps || fiber.pendingProps
          if (props && props.mediaPlayerInstance) {
            try {
              const qualities = props.mediaPlayerInstance.getQualities()
              if (!qualities || !qualities.length) return null
              const currentGroup = props.mediaPlayerInstance.getQuality()
              const active = qualities.find(q => q.group === currentGroup) || qualities[qualities.length - 1]
              const bps = active.bitrate || active.bandwidth || null
              return bps ? Math.round(bps / 1000) : null
            } catch { return null }
          }
          fiber = fiber.return
          depth++
        }
        return null
      })
    } catch { /* page fermée entre-temps */ }

    if (streamKbps) break
  }

  if (!streamKbps) {
    console.log(`[throttle] Détection échouée, fallback ${fallbackKbps} kbps`)
    await setCdpThrottle(context, page, fallbackKbps).catch(() => {})
    return
  }

  // Ne jamais descendre sous 1.2× le bitrate du stream (évite le buffering)
  const safeMin = Math.round(streamKbps * 1.2)
  const target  = Math.max(safeMin, Math.round(streamKbps * 1.5))
  // Respecte le plafond utilisateur, mais jamais en dessous du safe minimum
  const final   = Math.max(safeMin, Math.min(maxKbps, target))

  console.log(`[throttle] Stream ${streamKbps} kbps → throttle appliqué à ${final} kbps`)
  await setCdpThrottle(context, page, final).catch(() => {})
}

async function launchSession(id, url, proxyAddress, discret, throttleKbps) {
  const userData = sessionDir(id)

  sessions.set(id, {
    context: null,
    page: null,
    status: 'launching',
    proxy: proxyAddress,
    startedAt: new Date().toISOString(),
    error: null,
  })

  const pos = discret ? compactPosition(id) : { x: 100 + (id - 1) * 30, y: 50 + (id - 1) * 30 }
  const winSize = discret ? `--window-size=${COMPACT_W},${COMPACT_H}` : '--window-size=1000,680'

  try {
    const contextOptions = {
      headless: false,
      userDataDir: userData,
      viewport: discret ? { width: COMPACT_W, height: COMPACT_H } : { width: 1000, height: 680 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--renderer-process-limit=1',
        '--mute-audio',
        winSize,
        `--window-position=${pos.x},${pos.y}`,
      ],
    }

    if (proxyAddress) {
      contextOptions.proxy = parseProxy(proxyAddress)
    }

    const context = await chromium.launchPersistentContext(userData, contextOptions)

    // Injecte les scripts d'optimisation sur chaque nouvelle page
    await context.addInitScript(TWITCH_INIT_SCRIPT)

    const page = await context.newPage()

    // Lance le watchdog une fois la page chargée
    page.on('load', async () => {
      try {
        await page.evaluate(TWITCH_QUALITY_WATCHDOG)
      } catch (_) {}
    })

    page.on('close', () => {
      const s = sessions.get(id)
      if (s) s.status = 'closed'
    })

    context.on('close', () => {
      sessions.delete(id)
    })

    const session = sessions.get(id)
    session.context = context
    session.page = page
    session.status = 'loading'

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    session.status = 'active'

    // Throttle adaptatif : détecte le bitrate de la qualité active, puis applique la limite.
    // Lancé en arrière-plan pour ne pas bloquer le statut "active".
    if (throttleKbps > 0) {
      applyAdaptiveThrottle(context, page, throttleKbps, throttleKbps)
        .catch(e => console.error(`[Session ${id}] Throttle :`, e.message))
    }

  } catch (err) {
    const session = sessions.get(id)
    if (session) {
      session.status = 'error'
      session.error = err.message
    }
    console.error(`[Session ${id}] Erreur :`, err.message)
  }
}

async function stopSessions() {
  const closingTasks = []

  for (const [id, session] of sessions.entries()) {
    if (session.context) {
      closingTasks.push(
        session.context.close().catch(e => console.error(`[Session ${id}] Erreur fermeture :`, e.message))
      )
    }
  }

  await Promise.allSettled(closingTasks)
  sessions.clear()

  // Nettoie les dossiers temporaires
  cleanTmp()
}

function cleanTmp() {
  if (!fs.existsSync(TMP_DIR)) return
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch (e) {
    console.error('[cleanTmp] Erreur nettoyage :', e.message)
  }
}

function getPage(id) {
  const session = sessions.get(id)
  if (!session || !session.page || session.status !== 'active') return null
  return session.page
}

async function focusSession(id) {
  const session = sessions.get(id)
  if (!session?.page) return false
  await session.page.bringToFront()
  return true
}

// Retourne true si le stream n'a qu'une qualité Source (pas de transcodage).
// Utilisé pour afficher un avertissement dans le dashboard quand le throttle est activé.
async function isSourceOnly() {
  for (const [, session] of sessions.entries()) {
    if (session.status !== 'active' || !session.page) continue
    try {
      return await session.page.evaluate(() => {
        const playerEl = document.querySelector('[data-a-target="video-player"]')
        if (!playerEl) return null
        const reactKey = Object.keys(playerEl).find(
          k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        )
        if (!reactKey) return null
        let fiber = playerEl[reactKey]
        let depth = 0
        while (fiber && depth < 80) {
          const props = fiber.memoizedProps || fiber.pendingProps
          if (props && props.mediaPlayerInstance) {
            const qualities = props.mediaPlayerInstance.getQualities()
            if (!qualities || !qualities.length) return null
            return qualities.length === 1 || qualities.every(q => q.group === 'chunked' || !parseInt(q.name))
          }
          fiber = fiber.return
          depth++
        }
        return null
      })
    } catch {}
  }
  return null
}

async function getViewerCount() {
  for (const [, session] of sessions.entries()) {
    if (session.status !== 'active' || !session.page) continue
    try {
      const count = await session.page.evaluate(() => {
        const el = document.querySelector('[data-a-target="animated-channel-viewers-count"]')
        if (!el) return null
        const text = el.querySelector('span')?.textContent ?? el.textContent
        // Supprime séparateurs de milliers (espace, virgule) puis parse
        const num = parseInt(text.replace(/[\s,]/g, ''))
        return isNaN(num) ? null : num
      })
      if (count !== null) return count
    } catch {}
  }
  return null
}

module.exports = { startSessions, stopSessions, getStatus, getPage, focusSession, getViewerCount, isSourceOnly }
