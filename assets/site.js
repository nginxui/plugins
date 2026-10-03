// Loaded in the head of every page. The front page follows the language of the
// browser until a language is chosen in the menu, then it keeps that one. The
// theme follows the system until the button picks one. A card opens the details
// of its plugin over the list, with the address of the plugin page. The pages
// work without it: no search field or category filter, no theme button, no
// redirect, and a card leads to the plugin page. A screenshot opens larger
// over the page, or as the image itself without it.
(() => {
  const LOCALES = ['en', 'zh_CN', 'zh_TW', 'ja_JP']
  const THEMES = ['light', 'dark']
  const pathOf = locale => locale === 'en' ? '/' : `/${locale}/`

  function stored(key, allowed) {
    try {
      const value = localStorage.getItem(key)
      return allowed.includes(value) ? value : null
    }
    catch {
      return null
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, value)
    }
    catch {}
  }

  const calm = matchMedia('(prefers-reduced-motion: reduce)')

  // Set before the body renders so a chosen theme never flashes the other one.
  const root = document.documentElement
  const theme = stored('theme', THEMES)
  if (theme)
    root.dataset.theme = theme

  function browserLocale() {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const lang = String(tag).toLowerCase()
      if (/^zh-(tw|hk|mo|hant)/.test(lang))
        return 'zh_TW'
      if (lang.startsWith('zh'))
        return 'zh_CN'
      if (lang.startsWith('ja'))
        return 'ja_JP'
      if (lang.startsWith('en'))
        return 'en'
    }
    return 'en'
  }

  // Only the front page redirects, a link to a language page keeps it.
  const current = root.dataset.locale
  const chosen = stored('locale', LOCALES)
  if (current === 'en' && location.pathname === '/') {
    const wanted = chosen ?? browserLocale()
    if (wanted !== current) {
      location.replace(pathOf(wanted) + location.search + location.hash)
      return
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setUpTheme()
    setUpLanguages()
    setUpSearch()
    setUpDetails()
    setUpLightbox()
    showLocalTimes()
  })

  function setUpTheme() {
    const button = document.querySelector('.theme')
    if (!button)
      return
    const system = matchMedia('(prefers-color-scheme: dark)')
    const isDark = () => (root.dataset.theme ?? (system.matches ? 'dark' : 'light')) === 'dark'
    const show = () => button.setAttribute('aria-pressed', String(isDark()))
    show()
    button.hidden = false
    system.addEventListener('change', show)
    button.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark'
      const apply = () => {
        root.dataset.theme = next
        store('theme', next)
        show()
      }
      // The page fades from one theme to the other where the browser can.
      if (document.startViewTransition && !calm.matches)
        document.startViewTransition(apply)
      else
        apply()
    })
  }

  function setUpLanguages() {
    const menu = document.querySelector('details.languages')
    if (!menu)
      return
    menu.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-locale]')
      if (link)
        store('locale', link.dataset.locale)
    })
    document.addEventListener('click', (event) => {
      if (menu.open && !menu.contains(event.target))
        menu.open = false
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false
        menu.querySelector('summary').focus()
      }
    })
  }

  // Filters the plugin cards by the words typed into the search field and the
  // category picked above them.
  function setUpSearch() {
    const search = document.querySelector('.search')
    const filter = document.querySelector('.category-filter')
    const buttons = filter ? [...filter.querySelectorAll('button')] : []
    const cards = [...document.querySelectorAll('.plugin')]
    const empty = document.querySelector('.empty')
    let category = ''

    function apply() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
      let shown = 0
      for (const card of cards) {
        const match = words.every(word => card.dataset.search.includes(word))
          && (!category || card.dataset.categories.split(' ').includes(category))
        if (match && card.hidden && !calm.matches)
          card.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' })
        card.hidden = !match
        if (match)
          shown++
      }
      empty.hidden = shown > 0
    }

    if (search) {
      search.hidden = false
      search.addEventListener('input', apply)
    }
    if (filter && search) {
      filter.hidden = false
      for (const button of buttons) {
        button.addEventListener('click', () => {
          category = button.dataset.category
          for (const other of buttons)
            other.setAttribute('aria-pressed', String(other === button))
          apply()
        })
      }
    }

    // The provider list of a DNS plugin filters by name as well.
    for (const field of document.querySelectorAll('.provider-search')) {
      const items = [...field.nextElementSibling.children]
      field.hidden = false
      field.addEventListener('input', () => {
        const words = field.value.toLowerCase().split(/\s+/).filter(Boolean)
        for (const item of items)
          item.hidden = !words.every(word => item.textContent.toLowerCase().includes(word))
      })
    }
  }

  function setUpDetails() {
    let opened = null

    function open(id, push) {
      const dialog = document.getElementById(`detail-${id}`)
      if (!dialog)
        return false
      if (opened && opened !== dialog)
        opened.close()
      if (!dialog.open)
        dialog.showModal()
      dialog.querySelector('.detail-sheet').scrollTop = 0
      opened = dialog
      if (push)
        history.pushState({ plugin: id }, '', document.querySelector(`[data-plugin="${CSS.escape(id)}"]`).href)
      return true
    }

    for (const dialog of document.querySelectorAll('.detail-dialog')) {
      dialog.querySelector('.close').addEventListener('click', () => dialog.close())
      // A click on the blurred backdrop lands on the dialog itself.
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog)
          dialog.close()
      })
      dialog.addEventListener('close', () => {
        if (opened !== dialog)
          return
        opened = null
        if (history.state?.plugin)
          history.back()
      })
    }

    document.addEventListener('click', (event) => {
      const link = event.target.closest('.plugin-link')
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return
      if (open(link.dataset.plugin, true))
        event.preventDefault()
    })

    // The whole card opens the details, its title stays the link.
    for (const card of document.querySelectorAll('.plugin')) {
      card.addEventListener('click', (event) => {
        if (!event.target.closest('a, button, summary, input') && !getSelection().toString())
          card.querySelector('.plugin-link').click()
      })
    }

    addEventListener('popstate', (event) => {
      const id = event.state?.plugin
      if (id) {
        open(id, false)
      }
      else if (opened) {
        const dialog = opened
        opened = null
        dialog.close()
      }
    })

  }

  function setUpLightbox() {
    const box = document.querySelector('.lightbox')
    if (!box)
      return
    const image = box.querySelector('img')
    const caption = box.querySelector('.lightbox-caption')
    const count = box.querySelector('.lightbox-count')
    const steps = box.querySelectorAll('.lightbox-step')
    let shots = []
    let index = 0

    // The image of the shot the theme shows, the light one when it has no dark one.
    const shown = shot => [...shot.querySelectorAll('img')].find(img => getComputedStyle(img).display !== 'none') ?? shot.querySelector('img')

    function show(i, direction = 0) {
      index = (i + shots.length) % shots.length
      const img = shown(shots[index])
      image.src = img.currentSrc || img.src
      if (direction && !calm.matches)
        image.animate([{ opacity: 0, transform: `translateX(${direction * 48}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' })
      image.alt = img.alt
      caption.textContent = img.alt
      count.textContent = shots.length > 1 ? `${index + 1} / ${shots.length}` : ''
    }

    document.addEventListener('click', (event) => {
      const shot = event.target.closest('.shot')
      if (!shot || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return
      event.preventDefault()
      shots = [...shot.closest('.shots').querySelectorAll('.shot')]
      for (const step of steps)
        step.hidden = shots.length < 2
      show(shots.indexOf(shot))
      box.showModal()
    })

    box.querySelector('.lightbox-close').addEventListener('click', () => box.close())
    box.querySelector('.lightbox-previous').addEventListener('click', () => show(index - 1, -1))
    box.querySelector('.lightbox-next').addEventListener('click', () => show(index + 1, 1))
    // A click beside the image closes, like a click on the backdrop.
    box.addEventListener('click', (event) => {
      if (event.target === box || event.target.tagName === 'FIGURE')
        box.close()
    })
    box.addEventListener('keydown', (event) => {
      if (shots.length > 1 && event.key === 'ArrowLeft')
        show(index - 1, -1)
      if (shots.length > 1 && event.key === 'ArrowRight')
        show(index + 1, 1)
    })
    let touchX = null
    box.addEventListener('touchstart', (event) => {
      touchX = event.touches.length === 1 ? event.touches[0].clientX : null
    }, { passive: true })
    box.addEventListener('touchend', (event) => {
      if (touchX === null || shots.length < 2)
        return
      const dx = event.changedTouches[0].clientX - touchX
      touchX = null
      if (Math.abs(dx) > 50)
        show(dx > 0 ? index - 1 : index + 1, dx > 0 ? -1 : 1)
    })
    // The image stays while the lightbox fades out.
    box.addEventListener('close', () => {
      setTimeout(() => {
        if (!box.open)
          image.removeAttribute('src')
      }, 300)
    })
  }

  // The page carries UTC, shown here in the time zone of the browser.
  function showLocalTimes() {
    const lang = root.lang || undefined
    for (const time of document.querySelectorAll('time.local-time')) {
      const date = new Date(time.dateTime)
      if (Number.isNaN(date.getTime()))
        continue
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date).map(part => [part.type, part.value]))
      const zone = new Intl.DateTimeFormat(lang, { timeZoneName: 'short' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? ''
      time.textContent = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`.trim()
      time.title = Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  }
})()
