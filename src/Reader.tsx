import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { loadArticle, type Article } from './content/articles'
import type { Topic } from './data/topics'

interface Props {
  topic: Topic
  path: string
  onClose: () => void
  /** Closes the reader and starts a new spin; omitted when nothing is left to spin. */
  onSpinAnother?: () => void
}

type State = { status: 'loading' } | { status: 'ready'; article: Article } | { status: 'error' }

const formatDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Reader({ topic, path, onClose, onSpinAnother }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [activeId, setActiveId] = useState<string | null>(null)
  const progressRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    const p = loadArticle(path)
    if (!p) {
      setState({ status: 'error' })
      return
    }
    p.then(
      (article) => live && setState({ status: 'ready', article }),
      () => live && setState({ status: 'error' }),
    )
    return () => {
      live = false
    }
  }, [path])

  useEffect(() => {
    window.scrollTo(0, 0)
    const prev = document.title
    document.title = `${topic.title} · Uncached`
    return () => {
      document.title = prev
    }
  }, [topic])

  // Reading progress bar, written straight to the DOM to avoid re-rendering on every scroll event.
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement
      const max = el.scrollHeight - el.clientHeight
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${max > 0 ? el.scrollTop / max : 0})`
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [state])

  // Highlight the section currently in view in the table of contents.
  useEffect(() => {
    if (state.status !== 'ready' || !bodyRef.current) return
    const headings = [...bodyRef.current.querySelectorAll<HTMLElement>('h2[id], h3[id]')]
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: '0px 0px -70% 0px' },
    )
    headings.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [state])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // In-page anchors (#section) would otherwise replace the #/read/... route, so scroll to them by hand.
  const onAnchorClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!href || !href.startsWith('#') || href.startsWith('#/')) return
    e.preventDefault()
    const target = document.getElementById(decodeURIComponent(href.slice(1)))
    if (!target) return
    if (target instanceof HTMLDetailsElement) target.open = true
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    setActiveId(target.id)
  }

  const article = state.status === 'ready' ? state.article : null

  return (
    <div className="reader">
      <div className="reader-bar">
        <button type="button" className="reader-back" onClick={onClose}>
          <span aria-hidden="true">←</span> Back to spin
        </button>
        <span className="reader-bar-title" aria-hidden="true">
          {topic.title}
        </span>
        <kbd className="kbd reader-esc">esc</kbd>
        <span className="reader-progress" aria-hidden="true">
          <span ref={progressRef} />
        </span>
      </div>

      <header className="reader-head">
        <span className="tag">{topic.category}</span>
        <h1 className="reader-title">{topic.title}</h1>
        <p className="reader-summary">{article?.summary || topic.hook}</p>
        {article && (
          <p className="reader-meta">
            {article.minutes} min read
            {article.updated && <> · Updated {formatDate(article.updated)}</>}
          </p>
        )}
      </header>

      {state.status === 'loading' && <p className="reader-status">Loading the deep dive…</p>}
      {state.status === 'error' && (
        <p className="reader-status">
          There’s no deep dive for this topic yet.{' '}
          <button type="button" className="link" onClick={onClose}>
            Back to spin
          </button>
        </p>
      )}

      {article && (
        <div className="reader-layout" onClick={onAnchorClick}>
          {article.toc.length > 2 && (
            <nav className="toc" aria-label="On this page">
              <p className="toc-label">On this page</p>
              <ol>
                {article.toc.map((h) => (
                  <li key={h.id} className={`toc-${h.depth}`}>
                    <a href={`#${h.id}`} aria-current={activeId === h.id ? 'location' : undefined}>
                      {h.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <article ref={bodyRef} className="prose" dangerouslySetInnerHTML={{ __html: article.html }} />
        </div>
      )}

      {article && (
        <footer className="reader-foot">
          {onSpinAnother ? (
            <button type="button" className="btn-spin" onClick={onSpinAnother}>
              Spin another
            </button>
          ) : (
            <button type="button" className="btn-ghost" onClick={onClose}>
              Back to spin
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
