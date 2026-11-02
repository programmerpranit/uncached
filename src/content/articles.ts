import { Marked, type Tokens } from 'marked'
import type { Topic } from '../data/topics'

/**
 * Deep-dive articles live as Markdown in src/content/articles/<category-slug>/<title-slug>.md.
 * The glob is lazy, so each article is its own chunk and only downloads when someone opens it.
 */
const LOADERS = import.meta.glob<string>('./articles/*/*.md', { query: '?raw', import: 'default' })

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

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function render(body: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = []
  const used = new Map<string, number>()
  let figureNo = 0

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
          return `<figure><img src="${escapeAttr(img.href)}" alt="${escapeAttr(img.text)}" loading="lazy" decoding="async" />${caption}</figure>\n`
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

  return { html: marked.parse(body, { async: false }) as string, toc }
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
