// The names and descriptions a listing may show. An official entry takes the
// names of other languages from the plugin.json of its release, and its
// English name from plugins/<id>.json. Any other entry shows only the names
// its entry holds: a name its plugin.json gives that the entry does not hold,
// English or not, waits for a maintainer (.github/workflows/review-names.yml),
// since a name in any language can claim to be official. Descriptions are not
// reviewed, but one claiming to be an official Nginx UI plugin is left out.

// Locale keys of catalog texts, as entry.schema.json accepts them.
const LOCALE = /^[a-z]{2,3}(_[A-Z]{2})?$/

// What no name may hold, whatever the language: words claiming to be
// official unless negated, and characters that do not show, such as bidi
// overrides and zero width spaces, which make a name read otherwise than it
// looks in a review.
const RESERVED = [
  { pattern: /[\p{Cc}\p{Cf}\u2028\u2029]/u, word: 'an invisible character' },
  { pattern: /\bofficial\b/i, word: 'official' },
  { pattern: /(?<!非)官方/, word: '官方' },
  { pattern: /(?<!非)公式/, word: '公式' },
  { pattern: /オフィシャル/, word: 'オフィシャル' },
  { pattern: /(?<!비)공식/, word: '공식' },
]

/** What a name holds that no name may, empty when it holds nothing such. */
export function reservedWord(name) {
  return RESERVED.find(({ pattern }) => pattern.test(name ?? ''))?.word ?? ''
}

// A description may say "the official Cloudflare API", so it is only left out
// when one sentence names Nginx UI and claims to be official, or when it holds
// characters that do not show. Line breaks are fine in a description.
const NGINX_UI = /nginx[\s_-]*ui/i
const OFFICIAL = /\bofficial(?:ly)?\b|(?<!非)官方|(?<!非)公式|オフィシャル|(?<!비)공식/i
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u

/** Why a description may not be listed, empty when it may. */
export function descriptionProblem(text) {
  if (INVISIBLE.test(text ?? ''))
    return 'an invisible character'
  const claims = (text ?? '').split(/[.!?。！？\n]+/).some(sentence => NGINX_UI.test(sentence) && OFFICIAL.test(sentence))
  return claims ? 'a claim to be official' : ''
}

/** The names of a manifest by language, English, empty names and unknown
 * locale keys left out. */
export function manifestNames(manifest) {
  const names = {}
  for (const [locale, text] of Object.entries(manifest?.i18n ?? {})) {
    if (locale !== 'en' && LOCALE.test(locale) && typeof text?.name === 'string' && text.name.trim())
      names[locale] = text.name.trim()
  }
  return names
}

/**
 * The names of a manifest, English included, an entry does not hold:
 * { names, blocked }, names by language for review and blocked by language as
 * { name, word } for the ones holding what no name may. Undefined when there
 * are none.
 */
export function pendingNames(entryNames, manifest) {
  const names = {}
  const blocked = {}
  const english = typeof manifest?.name === 'string' && manifest.name.trim() ? { en: manifest.name.trim() } : {}
  for (const [locale, name] of Object.entries({ ...english, ...manifestNames(manifest) })) {
    if (entryNames?.[locale] === name)
      continue
    const word = reservedWord(name)
    if (word)
      blocked[locale] = { name, word }
    else
      names[locale] = name
  }
  return Object.keys(names).length + Object.keys(blocked).length > 0 ? { names, blocked } : undefined
}
