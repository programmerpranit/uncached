import { Marked, type Tokens } from 'marked'
import type { Topic } from '../data/topics'

/**
 * Deep-dive articles live as Markdown in src/content/articles/<category-slug>/<title-slug>.md.
 * The glob is lazy, so each article is its own chunk and only downloads when someone opens it.
 */
const LOADERS = import.meta.glob<string>('./articles/*/*.md', { query: '?raw', import: 'default' })

/**
 * Figures live in src/content/figures and are referenced from Markdown as /figures/<topic>/<name>.svg.
 * Bundling them gives cache-busting URLs. A sibling <name>.mobile.svg, if present, is a portrait
 * layout served to narrow screens, where the wide desktop figure would shrink to unreadable text.
 */
const FIGURES = import.meta.glob<string>('./figures/**/*.{svg,png,jpg,jpeg,webp,gif}', {
  query: '?url',
  import: 'default',
  eager: true,
})

const MOBILE_FIGURE_QUERY = '(max-width: 700px)'

function resolveFigure(href: string): { src: string; mobile: string | null } {
  if (/^[a-z]+:/i.test(href)) return { src: href, mobile: null }
  const key = `./${href.replace(/^\/+/, '')}`
  const mobileKey = key.replace(/(\.[a-z]+)$/i, '.mobile$1')
  return { src: FIGURES[key] ?? href, mobile: mobileKey !== key ? (FIGURES[mobileKey] ?? null) : null }
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const articlePath = (t: Topic) => `${slugify(t.category)}/${slugify(t.title)}`

const loaderFor = (path: string) => LOADERS[`./articles/${path}.md`]

export const hasArticle = (t: Topic) => Boolean(loaderFor(articlePath(t)))

export interface TocEntry {
  id: string
  text: string
  depth: 2 | 3
}

export interface Article {
  summary: string
  updated: string | null
  minutes: number
  html: string
  toc: TocEntry[]
}

/** Minimal `key: value` frontmatter between leading `---` fences. */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: raw.slice(match[0].length) }
}

const CALLOUTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  WARNING: 'Watch out',
  KEY: 'Key idea',
  EXAMPLE: 'Example',
}

// Captions are Markdown too (inline only), e.g. `*italic*` or `code`.
const inline = new Marked({ gfm: true })

const FAQ_HEADING = /^(faq|frequently asked questions)$/i

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function render(body: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = []
  const used = new Map<string, number>()
  let figureNo = 0
  let inFaq = false

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const text = inner.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/&quot;/g, '"')
        let id = slugify(text) || 'section'
        const n = used.get(id) ?? 0
        used.set(id, n + 1)
        if (n) id = `${id}-${n}`
        if (depth === 2) inFaq = FAQ_HEADING.test(text.trim())
        // FAQ questions become collapsible entries (see wrapFaq) and stay out of the table of contents.
        if (inFaq && depth === 3) return `<h3 class="faq-q" id="${id}">${inner}</h3>\n`
        if (depth === 2 || depth === 3) toc.push({ id, text, depth })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`
      },
      // A paragraph that holds only an image becomes a numbered <figure>; the image title is its caption.
      paragraph({ tokens }) {
        const only = tokens.filter((t) => !(t.type === 'text' && !t.raw.trim()))
        if (only.length === 1 && only[0].type === 'image') {
          const img = only[0] as Tokens.Image
          figureNo++
          const caption = img.title
            ? `<figcaption><span class="fig-no">Fig. ${figureNo}</span> ${inline.parseInline(img.title, { async: false })}</figcaption>`
            : ''
          const { src, mobile } = resolveFigure(img.href)
          const imgTag = `<img src="${escapeAttr(src)}" alt="${escapeAttr(img.text)}" loading="lazy" decoding="async" />`
          const media = mobile
            ? `<picture><source media="${MOBILE_FIGURE_QUERY}" srcset="${escapeAttr(mobile)}" />${imgTag}</picture>`
            : imgTag
          return `<figure${mobile ? ' class="has-mobile"' : ''}>${media}${caption}</figure>\n`
        }
        return `<p>${this.parser.parseInline(tokens)}</p>\n`
      },
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens)
        const m = /^<p>\[!(\w+)\]\s*/.exec(inner)
        if (m && CALLOUTS[m[1]]) {
          const kind = m[1].toLowerCase()
          return `<aside class="callout callout--${kind}"><p class="callout-label">${CALLOUTS[m[1]]}</p><p>${inner.slice(m[0].length)}</aside>\n`
        }
        return `<blockquote>${inner}</blockquote>\n`
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href)
        const t = title ? ` title="${escapeAttr(title)}"` : ''
        return external
          ? `<a href="${escapeAttr(href)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`
          : `<a href="${escapeAttr(href)}"${t}>${inner}</a>`
      },
      table(token) {
        // Default table markup, wrapped so wide tables scroll inside the column instead of the page.
        const head = token.header.map((c, i) => cell(this.parser.parseInline(c.tokens), 'th', token.align[i])).join('')
        const rows = token.rows
          .map((r) => `<tr>${r.map((c, i) => cell(this.parser.parseInline(c.tokens), 'td', token.align[i])).join('')}</tr>`)
          .join('\n')
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`
      },
    },
  })

  return { html: wrapFaq(marked.parse(body, { async: false }) as string), toc }
}

/**
 * Turns the FAQ section's `### Question` + answer pairs into <details> disclosures,
 * so readers can scan the questions and open only the ones they care about.
 */
function wrapFaq(html: string): string {
  const start = html.search(/<h2 id="(faq|frequently-asked-questions)[^"]*"/)
  if (start < 0) return html
  const bodyStart = html.indexOf('</h2>', start) + '</h2>'.length
  const next = html.indexOf('<h2 ', bodyStart)
  const end = next < 0 ? html.length : next
  const section = html.slice(bodyStart, end)
  const parts = section.split(/(?=<h3 class="faq-q")/)
  const intro = parts[0].startsWith('<h3 class="faq-q"') ? '' : parts.shift()!
  const items = parts
    .map((part) => {
      const m = /^<h3 class="faq-q" id="([^"]+)">([\s\S]*?)<\/h3>\n?/.exec(part)
      if (!m) return part
      return `<details class="faq" id="${m[1]}"><summary>${m[2]}</summary><div class="faq-a">${part.slice(m[0].length)}</div></details>\n`
    })
    .join('')
  return `${html.slice(0, bodyStart)}\n${intro}<div class="faq-list">${items}</div>\n${html.slice(end)}`
}

function cell(content: string, tag: 'th' | 'td', align: 'left' | 'right' | 'center' | null) {
  return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${content}</${tag}>`
}

const cache = new Map<string, Promise<Article>>()

export function loadArticle(path: string): Promise<Article> | null {
  const loader = loaderFor(path)
  if (!loader) return null
  let p = cache.get(path)
  if (!p) {
    p = loader().then((raw) => {
      const { meta, body } = splitFrontmatter(raw)
      const words = body.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length
      return { summary: meta.summary ?? '', updated: meta.updated ?? null, minutes: Math.max(1, Math.round(words / 220)), ...render(body) }
    })
    p.catch(() => cache.delete(path))
    cache.set(path, p)
  }
  return p
}
