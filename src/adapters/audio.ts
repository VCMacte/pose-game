/**
 * Звук: короткие мотивы по исходу раунда.
 *
 * **Звук идёт только из телевизора.** При зеркалировании динамики телефона
 * молчат, весь звук уходит в тракт вместе с картинкой и задержан так же.
 * Поэтому звук НЕ используется как опережающая подсказка: приём `run-game`
 * («звук с динамика телефона возвращает четверть секунды») здесь не работает и
 * работать не может — разбор разворота в `docs/concept-and-plan.md`.
 *
 * `AudioContext` приходит зависимостью: в node его нет, а мотивы — мой код, не
 * чужой синтезатор.
 *
 * Разбор: `docs/audio-and-latency.md`.
 */

/** Нота мотива: частота и когда она звучит от начала мотива. */
type Note = { f: number; at: number; ms: number }

const NOTE_MS = 110

/** Мотивы. Направление важнее высоты: ребёнок 7 лет слышит его сразу. */
const MOTIFS = Object.freeze({
  /** Старт превью — одна нота-подсказка. */
  cue: [{ f: 880, at: 0, ms: NOTE_MS }],
  /** Успех — три ноты ВВЕРХ. */
  hit: [
    { f: 660, at: 0, ms: NOTE_MS },
    { f: 880, at: NOTE_MS, ms: NOTE_MS },
    { f: 1320, at: NOTE_MS * 2, ms: NOTE_MS * 1.6 },
  ],
  /** Провал — три ноты ВНИЗ. */
  miss: [
    { f: 660, at: 0, ms: NOTE_MS },
    { f: 495, at: NOTE_MS, ms: NOTE_MS },
    { f: 330, at: NOTE_MS * 2, ms: NOTE_MS * 1.6 },
  ],
  /**
   * Несудимый раунд — короткий нейтральный, и НЕ похожий на провал: тот же
   * инвариант, что у цвета стены. Ребёнок не должен услышать провал за раунд,
   * которого игра не судила.
   */
  neutral: [
    { f: 520, at: 0, ms: NOTE_MS * 0.8 },
    { f: 520, at: NOTE_MS, ms: NOTE_MS * 0.8 },
  ],
} as Record<string, Note[]>)

export type Audio = {
  cue(): void
  hit(): void
  miss(): void
  neutral(): void
  /** Громкость в `[0, 1]`; что угодно вне полосы подрезается. */
  setVolume(v: number): void
}

export type AudioOpts = {
  /** Готовый контекст, либо `null`, когда WebAudio в этом браузере нет. */
  ctx?: AudioContext | null
  volume?: number
}

function defaultCtx(): AudioContext | null {
  const C = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  if (!C) return null
  try {
    return new C()
  } catch {
    return null
  }
}

/**
 * Звук игры.
 *
 * Нет WebAudio (или контекст не создался) — игра играется МОЛЧА, и ни один
 * вызов не бросает. Телефон на штативе: беззвучная игра хуже звучащей, но
 * несравнимо лучше упавшей, а консоли, в которую можно было бы пожаловаться,
 * здесь нет.
 */
export function createAudio(opts: AudioOpts = {}): Audio {
  const ctx = opts.ctx === undefined ? defaultCtx() : opts.ctx
  let volume = clamp(opts.volume ?? 0.6)

  function play(motif: Note[]): void {
    if (!ctx) return
    try {
      // Автоматическая политика браузера держит контекст усыплённым до первого
      // жеста; будить его здесь, а не падать молча.
      if (ctx.state === 'suspended') void ctx.resume()

      const t0 = ctx.currentTime
      for (const n of motif) {
        const gain = ctx.createGain()
        gain.connect(ctx.destination)
        const start = t0 + n.at / 1000
        const end = start + n.ms / 1000
        /*
         * Громкость выставляется ДО `start()`: поддельный контекст в тесте
         * запоминает её именно в этот момент, да и на живом WebAudio нота,
         * запущенная раньше назначения усиления, щёлкает.
         */
        gain.gain.setValueAtTime(volume, start)
        // Спад к концу ноты: обрыв на полной громкости слышен щелчком.
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.01), end)

        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = n.f
        osc.connect(gain)
        osc.start(start)
        osc.stop(end)
      }
    } catch {
      // Звук — не та вещь, из-за которой игра вправе встать.
    }
  }

  return {
    cue: () => play(MOTIFS.cue),
    hit: () => play(MOTIFS.hit),
    miss: () => play(MOTIFS.miss),
    neutral: () => play(MOTIFS.neutral),
    setVolume: (v) => {
      volume = clamp(v)
    },
  }
}

/** Нечисловая громкость — не повод на неё делить: это молчание. */
function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}
