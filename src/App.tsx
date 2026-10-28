import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CATEGORIES, TOPICS, topicKey, type Category, type Topic } from './data/topics'

const COVERED_STORAGE = 'uncached:covered'
const SELECTED_STORAGE = 'uncached:categories'
const SPIN_MS = 1500
const FIRST_TICK_MS = 45
const TICK_GROWTH = 1.12

const TOPIC_BY_KEY = new Map(TOPICS.map((t) => [topicKey(t), t]))

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the app still works in-memory.
  }
}

function loadCovered(): string[] {
  const parsed = readJson(COVERED_STORAGE)
  if (!Array.isArray(parsed)) return []
  // Drop keys for topics that were renamed or removed from the data file.
  const valid = parsed.filter((k): k is string => typeof k === 'string' && TOPIC_BY_KEY.has(k))
  return [...new Set(valid)]
}

function loadSelected(): Category[] {
  const parsed = readJson(SELECTED_STORAGE)
  if (!Array.isArray(parsed)) return [...CATEGORIES]
  const valid = CATEGORIES.filter((c) => parsed.includes(c))
  return valid.length ? valid : [...CATEGORIES]
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

/** Tick intervals that start fast and stretch out until they add up to roughly SPIN_MS. */
function reelSchedule(): number[] {
  const out: number[] = []
  let total = 0
  let interval = FIRST_TICK_MS
  while (total + interval < SPIN_MS) {
    out.push(interval)
    total += interval
    interval *= TICK_GROWTH
  }
  return out
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

type Phase = 'idle' | 'spinning' | 'landed'

interface ReelFrame {
  text: string
  ms: number
  id: number
}

export default function App() {
  const [selected, setSelected] = useState<Category[]>(loadSelected)
  const [covered, setCovered] = useState<string[]>(loadCovered)
  const [phase, setPhase] = useState<Phase>('idle')
  const [current, setCurrent] = useState<Topic | null>(null)
  const [reel, setReel] = useState<ReelFrame | null>(null)
  const [landCount, setLandCount] = useState(0)
  const [announce, setAnnounce] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const timers = useRef<number[]>([])
  const spinning = phase === 'spinning'

  useEffect(() => writeJson(COVERED_STORAGE, covered), [covered])
  useEffect(() => writeJson(SELECTED_STORAGE, selected), [selected])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const coveredSet = useMemo(() => new Set(covered), [covered])
  const allSelected = selected.length === CATEGORIES.length

  const remainingByCategory = useMemo(() => {
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
    for (const t of TOPICS) if (!coveredSet.has(topicKey(t))) counts[t.category]++
    return counts
  }, [coveredSet])

  const remaining = selected.reduce((sum, c) => sum + remainingByCategory[c], 0)
  const exhausted = remaining === 0

  const land = useCallback((topic: Topic) => {
    const key = topicKey(topic)
    setCurrent(topic)
    setPhase('landed')
    setReel(null)
    setLandCount((n) => n + 1)
    setCovered((prev) => [...prev.filter((k) => k !== key), key])
    setAnnounce(`${topic.title}. ${topic.category}. ${topic.hook}`)
  }, [])

  /**
   * Pick a topic from the selected categories, skipping covered ones.
   * `skip` is the topic being rerolled: it is un-covered and excluded from this one draw.
   */
  const spin = useCallback(
    (skip?: Topic) => {
      if (spinning) return
      const skipKey = skip ? topicKey(skip) : null
      const candidates = TOPICS.filter((t) => {
        const key = topicKey(t)
        return selectedSet.has(t.category) && key !== skipKey && !coveredSet.has(key)
      })
      if (!candidates.length) return

      if (skipKey) setCovered((prev) => prev.filter((k) => k !== skipKey))
      setConfirmReset(false)
      const winner = pickRandom(candidates)

      if (prefersReducedMotion()) {
        land(winner)
        return
      }

      // Decoys come from every topic in the selection so the reel stays lively even when few remain.
      const decoys = TOPICS.filter((t) => selectedSet.has(t.category) && t !== winner)
      const schedule = reelSchedule()
      timers.current.forEach(clearTimeout)
      timers.current = []
      setPhase('spinning')
      setAnnounce('')

      let at = 0
      let last: Topic | null = null
      schedule.forEach((ms, i) => {
        const isFinal = i === schedule.length - 1
        let topic = winner
        if (!isFinal && decoys.length) {
          do topic = pickRandom(decoys)
          while (decoys.length > 1 && topic === last)
        }
        last = topic
        const text = topic.title
        timers.current.push(window.setTimeout(() => setReel({ text, ms, id: i }), at))
        at += ms
      })
      timers.current.push(window.setTimeout(() => land(winner), at))
    },
    [spinning, selectedSet, coveredSet, land],
  )

  const reroll = useCallback(() => {
    if (current && phase === 'landed') spin(current)
  }, [current, phase, spin])

  // Space spins. Keyboard users who tabbed onto a control keep its native Space behavior.
  // Mouse clicks don't move focus onto buttons, so clicking a chip and then pressing
  // Space still spins instead of toggling that chip again.
  const spinRef = useRef(spin)
  spinRef.current = spin
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')) return
      e.preventDefault()
      spinRef.current()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('button')) return
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [])

  const toggleCategory = (c: Category) => {
    setSelected((prev) => {
      // From "All", tapping one category narrows straight to it.
      if (prev.length === CATEGORIES.length) return [c]
      const next = prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
      return next.length ? CATEGORIES.filter((x) => next.includes(x)) : [...CATEGORIES]
    })
  }

  const resetHistory = () => {
    setCovered([])
    setConfirmReset(false)
  }

  const history = useMemo(
    () => [...covered].reverse().map((k) => TOPIC_BY_KEY.get(k)!).filter(Boolean),
    [covered],
  )

  const progress = covered.length / TOPICS.length

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <h1 className="wordmark">Uncached</h1>
          <p className="tagline">spin · explain · discuss</p>
        </div>
        <p className="counter">
          <span className="counter-num">{covered.length}</span>
          <span className="counter-sep"> / </span>
          <span>{TOPICS.length}</span>
          <span className="counter-label"> explored</span>
        </p>
      </header>
      <div className="progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      <nav className="filters" aria-label="Categories">
        <ul className="chips">
          <li>
            <button
              type="button"
              className="chip"
              aria-pressed={allSelected}
              onClick={() => setSelected([...CATEGORIES])}
            >
              All
            </button>
          </li>
          {CATEGORIES.map((c) => (
            <li key={c}>
              <button
                type="button"
                className="chip"
                aria-pressed={!allSelected && selectedSet.has(c)}
                aria-label={`${c}, ${remainingByCategory[c]} left`}
                onClick={() => toggleCategory(c)}
              >
                {c}
                <span className="chip-count" aria-hidden="true">
                  {remainingByCategory[c]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="stage-wrap">
        <section className={`stage stage--${phase}`} aria-label="Topic">
          <span className="crop crop--tl" aria-hidden="true" />
          <span className="crop crop--tr" aria-hidden="true" />
          <span className="crop crop--bl" aria-hidden="true" />
          <span className="crop crop--br" aria-hidden="true" />

          <div className="reel" aria-hidden={phase === 'spinning'}>
            {phase === 'idle' && <p className="placeholder">What are we talking about today?</p>}
            {phase === 'spinning' && reel && (
              <p
                key={reel.id}
                className="title title--tick"
                style={{ '--tick-ms': `${Math.min(reel.ms, 160)}ms` } as CSSProperties}
              >
                {reel.text}
              </p>
            )}
            {phase === 'landed' && current && (
              <h2 key={landCount} className="title title--landed">
                {current.title}
              </h2>
            )}
          </div>

          <div className="meta" data-visible={phase === 'landed'}>
            {current && (
              <>
                <span className="tag">{current.category}</span>
                <p className="hook">{current.hook}</p>
              </>
            )}
          </div>
        </section>

        <div className="controls">
          <button
            type="button"
            className="btn-spin"
            onClick={() => spin()}
            disabled={spinning || exhausted}
            aria-keyshortcuts="Space"
          >
            <span>{spinning ? 'Spinning' : 'Spin'}</span>
            <kbd className="kbd">space</kbd>
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={reroll}
            disabled={phase !== 'landed' || exhausted}
          >
            Reroll
          </button>
        </div>

        <p className="status" role="status">
          {exhausted ? (
            <>
              Everything in this selection is explored. Pick more categories or{' '}
              <button type="button" className="link" onClick={resetHistory}>
                reset history
              </button>
              .
            </>
          ) : (
            <>
              {remaining} left in {allSelected ? 'all categories' : selected.join(', ')}
            </>
          )}
        </p>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>
      </main>

      <footer className="history">
        <div className="history-bar">
          <button
            type="button"
            className="link"
            aria-expanded={historyOpen}
            aria-controls="history-list"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {historyOpen ? 'Hide' : 'Show'} covered ({covered.length})
          </button>
          {covered.length > 0 &&
            (confirmReset ? (
              <span className="confirm">
                Clear all {covered.length}?
                <button type="button" className="link link--danger" onClick={resetHistory}>
                  Yes, reset
                </button>
                <button type="button" className="link" onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="link" onClick={() => setConfirmReset(true)}>
                Reset history
              </button>
            ))}
        </div>
        {historyOpen && (
          <div id="history-list">
            {history.length ? (
              <ol className="history-list">
                {history.map((t) => (
                  <li key={topicKey(t)}>
                    <span className="history-title">{t.title}</span>
                    <span className="history-cat">{t.category}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="history-empty">Nothing covered yet. Spin to start.</p>
            )}
          </div>
        )}
      </footer>
    </div>
  )
}
