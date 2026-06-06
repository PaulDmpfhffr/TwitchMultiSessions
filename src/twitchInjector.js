// Script injecté dans chaque page Twitch avant le chargement.
// S'exécute dans le contexte du navigateur, pas Node.js.
const TWITCH_INIT_SCRIPT = `
(function () {
  const TARGET_QUALITY = '160p'
  const PLAYER_VOLUME = 0.01
  const MAX_ATTEMPTS = 40
  let attempts = 0
  let playerFound = false

  // Réduit le rendu visuel de la vidéo au minimum (économise GPU).
  // Le stream continue de tourner : le viewer est toujours compté.
  function minimizeVideoRendering() {
    const style = document.createElement('style')
    style.textContent = \`
      [data-a-target="video-player"] video {
        width: 2px !important;
        height: 2px !important;
        position: absolute !important;
        opacity: 0.01 !important;
      }
    \`
    document.head.appendChild(style)
  }

  function applySettings(player) {
    try {
      const qualities = player.getQualities()
      if (!qualities || !qualities.length) return

      // Préfère 160p, sinon prend la qualité la plus basse disponible
      const low = qualities.find(q => q.group === TARGET_QUALITY)
        || qualities.reduce((a, b) => {
            const aH = parseInt(a.name) || 9999
            const bH = parseInt(b.name) || 9999
            return bH < aH ? b : a
          })

      player.setQuality(low.group)
      player.setVolume(PLAYER_VOLUME)
      player.setMuted(false)
      playerFound = true
    } catch (e) {}
  }

  function findPlayerInFiber(el) {
    const reactKey = Object.keys(el).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    )
    if (!reactKey) return null

    let fiber = el[reactKey]
    let depth = 0
    while (fiber && depth < 80) {
      const props = fiber.memoizedProps || fiber.pendingProps
      if (props && props.mediaPlayerInstance) return props.mediaPlayerInstance
      fiber = fiber.return
      depth++
    }
    return null
  }

  function waitForPlayer() {
    attempts++
    if (attempts > MAX_ATTEMPTS) return

    const playerEl = document.querySelector('[data-a-target="video-player"]')
    if (!playerEl) { setTimeout(waitForPlayer, 1000); return }

    const player = findPlayerInFiber(playerEl)
    if (!player) { setTimeout(waitForPlayer, 1000); return }

    applySettings(player)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      minimizeVideoRendering()
      waitForPlayer()
    })
  } else {
    minimizeVideoRendering()
    waitForPlayer()
  }
})()
`

// Watchdog : surveille et corrige la qualité toutes les 15s
// (Twitch peut remettre à "auto" après un changement de qualité réseau)
const TWITCH_QUALITY_WATCHDOG = `
(function() {
  const TARGET_QUALITY = '160p'
  const PLAYER_VOLUME = 0.01

  function findPlayer() {
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
      if (props && props.mediaPlayerInstance) return props.mediaPlayerInstance
      fiber = fiber.return
      depth++
    }
    return null
  }

  setInterval(() => {
    const player = findPlayer()
    if (!player) return
    try {
      const qualities = player.getQualities()
      if (!qualities || !qualities.length) return

      const low = qualities.find(q => q.group === TARGET_QUALITY)
        || qualities.reduce((a, b) => {
            const aH = parseInt(a.name) || 9999
            const bH = parseInt(b.name) || 9999
            return bH < aH ? b : a
          })

      if (player.getQuality() !== low.group) player.setQuality(low.group)
      if (Math.abs(player.getVolume() - PLAYER_VOLUME) > 0.05) player.setVolume(PLAYER_VOLUME)
      if (player.getMuted()) player.setMuted(false)
    } catch (e) {}
  }, 15000)
})()
`

module.exports = { TWITCH_INIT_SCRIPT, TWITCH_QUALITY_WATCHDOG }
