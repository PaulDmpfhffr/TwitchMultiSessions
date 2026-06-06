// --- État local ---
let proxies = []
let statusPollInterval = null
let screenshotInterval = null
let currentSessions = []
let isRunning = false
let screenshotDelay = 5000

// --- DOM ---
const urlInput       = document.getElementById('url-input')
const sessionSlider  = document.getElementById('session-count')
const countDisplay   = document.getElementById('count-display')
const ramWarning     = document.getElementById('ram-warning')
const btnStart       = document.getElementById('btn-start')
const btnStop        = document.getElementById('btn-stop')
const actionMsg      = document.getElementById('action-message')
const proxyList      = document.getElementById('proxy-list')
const sessionList    = document.getElementById('session-list')
const screenshotGrid = document.getElementById('screenshot-grid')
const globalStatus   = document.getElementById('global-status')
const btnAddProxy    = document.getElementById('btn-add-proxy')
const discretToggle      = document.getElementById('discret-toggle')
const screenshotSlider   = document.getElementById('screenshot-interval')
const intervalDisplay    = document.getElementById('interval-display')

// --- Init ---
async function init() {
  const config = await apiFetch('/api/config')
  if (!config) return

  proxies = config.proxies || []
  if (config.lastUrl)          urlInput.value = config.lastUrl
  if (config.lastSessionCount) sessionSlider.value = config.lastSessionCount
  if (config.discret)          discretToggle.checked = config.discret
  if (config.screenshotDelay) {
    screenshotDelay = config.screenshotDelay
    screenshotSlider.value = config.screenshotDelay / 1000
    intervalDisplay.textContent = `${config.screenshotDelay / 1000}s`
  }

  updateCountDisplay()
  renderProxies()
  startStatusPoll()
}

// --- Slider ---
sessionSlider.addEventListener('input', () => {
  updateCountDisplay()
})

function updateCountDisplay() {
  const val = parseInt(sessionSlider.value)
  countDisplay.textContent = val
  ramWarning.classList.toggle('hidden', val < 7)
}

// --- Proxys ---
function renderProxies() {
  proxyList.innerHTML = ''
  proxies.forEach((proxy, i) => {
    const row = document.createElement('div')
    row.className = 'proxy-row'
    row.dataset.id = proxy.id

    row.innerHTML = `
      <div class="proxy-row__num">${i + 1}</div>
      <div class="proxy-row__inputs">
        <input
          type="text"
          class="proxy-label-input"
          value="${escHtml(proxy.label)}"
          placeholder="Nom de la connexion"
          data-field="label"
        />
        <input
          type="text"
          class="proxy-addr-input"
          value="${escHtml(proxy.address)}"
          placeholder="${i === 0 ? 'Vide = connexion directe' : 'socks5://ip:port  ou  socks5://user:pass@ip:port'}"
          data-field="address"
          ${i === 0 ? '' : ''}
        />
      </div>
      <div class="proxy-row__actions">
        <label class="toggle" title="${proxy.active ? 'Actif' : 'Inactif'}">
          <input type="checkbox" class="proxy-active" ${proxy.active ? 'checked' : ''} />
          <span class="toggle__slider"></span>
        </label>
        ${proxies.length > 1 ? `<button class="btn--remove" title="Supprimer">×</button>` : ''}
      </div>
    `

    // Listeners
    row.querySelectorAll('input[data-field]').forEach(input => {
      input.addEventListener('change', () => updateProxy(proxy.id, input.dataset.field, input.value))
    })

    row.querySelector('.proxy-active').addEventListener('change', e => {
      updateProxy(proxy.id, 'active', e.target.checked)
    })

    const removeBtn = row.querySelector('.btn--remove')
    if (removeBtn) {
      removeBtn.addEventListener('click', () => removeProxy(proxy.id))
    }

    proxyList.appendChild(row)
  })
}

function updateProxy(id, field, value) {
  const proxy = proxies.find(p => p.id === id)
  if (!proxy) return
  proxy[field] = value
  saveConfig()
}

function removeProxy(id) {
  proxies = proxies.filter(p => p.id !== id)
  renderProxies()
  saveConfig()
}

btnAddProxy.addEventListener('click', () => {
  const newId = proxies.length > 0 ? Math.max(...proxies.map(p => p.id)) + 1 : 1
  proxies.push({ id: newId, label: `Proxy ${newId}`, address: '', active: true })
  renderProxies()
  saveConfig()
})

function saveConfig() {
  apiFetch('/api/config', 'POST', {
    proxies,
    lastUrl: urlInput.value,
    lastSessionCount: parseInt(sessionSlider.value),
    discret: discretToggle.checked,
    screenshotDelay,
  })
}

urlInput.addEventListener('change', saveConfig)
sessionSlider.addEventListener('change', saveConfig)
discretToggle.addEventListener('change', saveConfig)

screenshotSlider.addEventListener('input', () => {
  const val = parseInt(screenshotSlider.value)
  intervalDisplay.textContent = `${val}s`
  screenshotDelay = val * 1000
  restartScreenshotPoll()
  saveConfig()
})

// --- Démarrer / Arrêter ---
btnStart.addEventListener('click', async () => {
  const url = urlInput.value.trim()
  if (!url || !url.includes('twitch.tv')) {
    showMessage('Collez une URL Twitch valide (ex: https://twitch.tv/nom)', true)
    return
  }

  const sessionCount = parseInt(sessionSlider.value)
  const activeProxies = proxies.filter(p => p.active).map(p => p.address || null)
  const discret = discretToggle.checked

  setRunning(true)
  showMessage(`Lancement de ${sessionCount} session(s)…`)

  const res = await apiFetch('/api/start', 'POST', { url, sessionCount, proxies: activeProxies, discret })
  if (!res) {
    setRunning(false)
    return
  }

  showMessage(res.message)
})

btnStop.addEventListener('click', async () => {
  showMessage('Arrêt en cours…')
  const res = await apiFetch('/api/stop', 'POST', {})
  if (res) showMessage(res.message)
  setRunning(false)
  currentSessions = []
  stopScreenshotPoll()
  renderSessionList([])
  setGlobalStatus('idle')
})

function setRunning(running) {
  isRunning = running
  btnStart.disabled = running
  btnStop.disabled = !running
}

// --- Statut sessions ---
function startStatusPoll() {
  if (statusPollInterval) clearInterval(statusPollInterval)
  statusPollInterval = setInterval(pollStatus, 2500)
  pollStatus()
}

async function pollStatus() {
  const sessions = await apiFetch('/api/status')
  if (!sessions) return
  currentSessions = sessions
  renderSessionList(sessions)
  updateGlobalStatus(sessions)
}

function renderSessionList(sessions) {
  if (!sessions.length) {
    sessionList.innerHTML = '<p class="empty-state">Aucune session en cours.</p>'
    screenshotGrid.innerHTML = '<p class="empty-state">Les aperçus apparaîtront au lancement.</p>'
    stopScreenshotPoll()
    return
  }

  const existingIds = [...sessionList.querySelectorAll('.session-card')].map(el => el.dataset.id)
  const newIds = sessions.map(s => String(s.id))
  const idsChanged = JSON.stringify(existingIds) !== JSON.stringify(newIds)

  // Session cards — format simple
  if (idsChanged) {
    sessionList.innerHTML = sessions.map(s => `
      <div class="session-card" data-id="${s.id}">
        <div class="session-card__num">#${s.id}</div>
        <div class="session-card__info">
          <div class="session-card__proxy">${escHtml(s.proxy)}</div>
          ${s.error ? `<div class="session-card__error">${escHtml(s.error)}</div>` : ''}
        </div>
        <span class="badge badge--${s.status}" id="badge-${s.id}">${labelStatus(s.status)}</span>
      </div>
    `).join('')
  } else {
    sessions.forEach(s => {
      const badge = document.getElementById(`badge-${s.id}`)
      if (badge) { badge.className = `badge badge--${s.status}`; badge.textContent = labelStatus(s.status) }
    })
  }

  // Grille de thumbnails
  if (idsChanged) {
    screenshotGrid.innerHTML = sessions.map(s => `
      <div class="screenshot-thumb" id="thumb-${s.id}">
        <div class="screenshot-thumb__placeholder" id="thumb-placeholder-${s.id}">
          #${s.id}
        </div>
        <img id="screenshot-${s.id}" alt="" style="display:none" />
        <div class="screenshot-thumb__label">#${s.id}</div>
      </div>
    `).join('')
    restartScreenshotPoll()
  }
}

// --- Screenshots ---
function restartScreenshotPoll() {
  stopScreenshotPoll()
  if (!currentSessions.length) return
  refreshScreenshots()
  screenshotInterval = setInterval(refreshScreenshots, screenshotDelay)
}

function stopScreenshotPoll() {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null }
}

async function refreshScreenshots() {
  for (const session of currentSessions) {
    if (session.status !== 'active') continue
    const img = document.getElementById(`screenshot-${session.id}`)
    const placeholder = document.getElementById(`thumb-placeholder-${session.id}`)
    if (!img) continue

    const newSrc = `/api/session/${session.id}/screenshot?t=${Date.now()}`
    const tempImg = new Image()
    tempImg.onload = () => {
      img.src = newSrc
      img.style.display = 'block'
      if (placeholder) placeholder.style.display = 'none'
    }
    tempImg.onerror = () => {
      img.style.display = 'none'
      if (placeholder) placeholder.style.display = ''
    }
    tempImg.src = newSrc
  }
}

function updateGlobalStatus(sessions) {
  if (!sessions.length) {
    setGlobalStatus('idle')
    if (isRunning) setRunning(false)
    return
  }

  const hasActive   = sessions.some(s => s.status === 'active')
  const hasLoading  = sessions.some(s => s.status === 'loading' || s.status === 'launching')
  const allError    = sessions.every(s => s.status === 'error' || s.status === 'closed')

  if (allError)       setGlobalStatus('error')
  else if (hasActive) setGlobalStatus('active')
  else if (hasLoading) setGlobalStatus('loading')
}

function setGlobalStatus(status) {
  globalStatus.className = `badge badge--${status}`
  globalStatus.textContent = {
    idle:      'Inactif',
    launching: 'Lancement…',
    loading:   'Chargement…',
    active:    'Actif',
    error:     'Erreur',
    closed:    'Fermé',
  }[status] || status
}

// --- Helpers ---
function showMessage(text, isError = false) {
  actionMsg.textContent = text
  actionMsg.className = `action-message${isError ? ' error' : ''}`
  if (isError) setTimeout(() => actionMsg.classList.add('hidden'), 4000)
}

function labelStatus(status) {
  return {
    launching: 'Lancement',
    loading:   'Chargement',
    active:    'Actif',
    error:     'Erreur',
    closed:    'Fermé',
  }[status] || status
}

async function apiFetch(url, method = 'GET', body = null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } }
    if (body !== null) opts.body = JSON.stringify(body)
    const res = await fetch(url, opts)
    const data = await res.json()
    if (!res.ok) {
      showMessage(data.error || 'Erreur serveur', true)
      return null
    }
    return data
  } catch {
    showMessage('Impossible de contacter le serveur local.', true)
    return null
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// --- Start ---
init()
