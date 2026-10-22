/**
 * Замер задержки тракта трансляции звуковой петлёй.
 *
 * Звук выходит ТОЛЬКО из телевизора (при зеркалировании динамики телефона
 * молчат), поэтому тракт замыкается на одном устройстве: игра проигрывает чирп,
 * микрофон телефона слышит его из динамиков телевизора, разница «отправил →
 * услышал» и есть задержка.
 *
 * **Измеряется задержка ЗВУКА.** Видеопуть совпадает с ней, пока телевизор
 * держит A/V-синхронизацию, а в неигровом режиме телевизоры часто задерживают
 * картинку сильнее. Поэтому число отсюда — отправная точка, а настройка «сдвиг
 * на задержку» остаётся ручной подкруткой ПОВЕРХ него.
 *
 * Разбор: `docs/audio-and-latency.md`.
 */

import { latencyMeasured } from './log/events'
import { withTimeout } from './promise'
import { write } from './log/store'

export const LATENCY = Object.freeze({
  /**
   * Длина чирпа. Короче — хуже корреляция (меньше энергии в полезном
   * сигнале), длиннее — заметнее на слух и дольше весь замер.
   */
  chirpMs: 60,

  /** Свип от низа к верху: именно рост частоты и делает сдвиг однозначным. */
  f0: 800,
  f1: 3200,

  /** Выстрелов в серии по умолчанию. Медиана по десятку устойчива к выбросу. */
  shots: 12,

  /** Докуда искать сдвиг. Тракт Miracast держится в сотнях миллисекунд. */
  maxLagMs: 1200,

  /**
   * Сколько длится запись одного выстрела: чирп плюс весь диапазон поиска.
   */
  recordMs: 1500,

  /**
   * Порог нормированной корреляции, ниже которого ответ считается НЕ найденным.
   *
   * Нормировка здесь и важна: сравнивается форма, а не громкость, поэтому
   * громкий шум порог не проходит, а тихий, но настоящий чирп — проходит.
   * Случайное число вместо отказа уехало бы в настройку сдвига и сломало бы
   * судейство молча.
   */
  minScore: 0.25,

  /** Доля выстрелов серии, которую надо услышать, чтобы медиана была медианой. */
  minHeardFrac: 0.4,

  /**
   * Насколько выстрел вправе отличаться от медианы, чтобы считаться СОГЛАСНЫМ
   * с ней. Согласных не больше половины — замер отклоняется.
   *
   * Согласие, а не полный разброс, и причина конкретная. Один выброс при
   * сошедшейся серии — обычное дело (телевизор на миг ушёл в буферизацию), и
   * медиана ровно для него и взята; порог по полному разбросу забраковал бы
   * именно такой — исправный — замер. А вот серия, разбежавшаяся целиком,
   * медианой не описывается вовсе: в живом замере 22.10.2026 вышло
   * `medianMs: 1166` при разбросе 544 и `ok: true`, и это число уехало бы в
   * настройку сдвига как измеренное.
   *
   * Сто миллисекунд — потому что настройка сдвига идёт ступенями по 150 мс
   * (`OPTIONS.latencyMs`): замер, не выбирающий ступень, выбирать её и не
   * должен.
   */
  agreeMs: 100,
})

/**
 * Линейный свип с мягкими краями.
 *
 * Чирп, а не щелчок: щелчок ловится порогом громкости, а порог в жилой комнате
 * срабатывает на хлопок двери. Нота тоже не годится — она коррелирует сама с
 * собой на каждом периоде, и сдвиг из такой корреляции неоднозначен.
 *
 * Края сведены к нулю окном: резкий старт сам по себе щелчок, он слышен и
 * размазывает корреляционный пик.
 */
export function makeChirp(sampleRate: number, ms = LATENCY.chirpMs): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate)
  const out = new Float32Array(n)
  const dur = n / sampleRate
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // Мгновенная частота растёт линейно, значит фаза — квадратична.
    const phase = 2 * Math.PI * (LATENCY.f0 * t + ((LATENCY.f1 - LATENCY.f0) / (2 * dur)) * t * t)
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1))
    out[i] = Math.sin(phase) * window
  }
  return out
}

/** Энергия куска записи — знаменатель нормировки. */
function energy(a: Float32Array, from: number, len: number): number {
  let s = 0
  for (let i = 0; i < len; i++) {
    const v = a[from + i]
    s += v * v
  }
  return s
}

/**
 * Сдвиг «отправил → услышал» в миллисекундах, либо `NaN`, если чирпа в записи
 * нет.
 *
 * `NaN`, а не нуль и не случайный максимум: нуль читался бы как «тракт без
 * задержки» — то есть как честный замер, — и уехал бы в настройку сдвига.
 * Вызывающий обязан проверить `Number.isFinite`.
 *
 * Корреляция НОРМИРОВАННАЯ: сравнивается форма сигнала, а не громкость.
 * Поэтому шум вдвое громче чирпа пик не перебивает, а громкий шум без чирпа
 * порога не проходит вовсе.
 */
export function correlate(sent: Float32Array, heard: Float32Array, sampleRate: number): number {
  const n = sent.length
  if (n === 0 || heard.length < n) return Number.NaN

  const sentEnergy = energy(sent, 0, n)
  if (sentEnergy <= 0) return Number.NaN

  const maxLag = Math.min(heard.length - n, Math.round((LATENCY.maxLagMs / 1000) * sampleRate))
  let bestScore = -Infinity
  let bestLag = -1

  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0
    for (let i = 0; i < n; i++) dot += sent[i] * heard[lag + i]
    const e = energy(heard, lag, n)
    if (e <= 0) continue
    // Косинус между куском записи и чирпом: от 0 до 1 по модулю.
    const score = Math.abs(dot) / Math.sqrt(sentEnergy * e)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }

  if (bestLag < 0 || bestScore < LATENCY.minScore) return Number.NaN
  return (bestLag / sampleRate) * 1000
}

/** Петля «проиграть и записать». Приходит зависимостью: WebAudio в node нет. */
export type Loopback = {
  sampleRate: number
  /** Один выстрел: проиграть чирп и вернуть записанное с микрофона. */
  shoot(chirp: Float32Array): Promise<Float32Array>
}

export type LatencyResult = {
  /** Медиана серии. Медиана, а не среднее: один выброс — обычное дело. */
  medianMs: number
  /** Разброс серии. Большой разброс сам по себе диагноз. */
  spreadMs: number
  /** Все услышанные выстрелы: по ним видно, ровный тракт или совпала медиана. */
  shots: number[]
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Серия выстрелов, медиана и разброс.
 *
 * Бросает в двух случаях, и оба — отказ вместо числа, которое выглядит как
 * замер: услышано слишком мало (медиана по одному выстрелу — не медиана) и
 * выстрелы разбежались (медиана не опирается ни на что, см. `agreeMs`).
 *
 * **Записанный звук нигде не остаётся** — ни в ответе, ни в журнале, только
 * корреляция в памяти. Игра про ребёнка в его комнате, и запись из неё не
 * уходит; в тексте запроса разрешения это сказано, и здесь это соблюдено.
 */
export async function measureLatency(opts: {
  shots?: number
  loopback: Loopback
}): Promise<LatencyResult> {
  /*
   * Минимум ДВА выстрела, а не один: медиана по одному выстрелу — не медиана, и
   * `need` ниже всё равно требует двух. `Math.max(1, …)` пускал сюда `shots: 1`,
   * и такой замер отказывал всегда, даже на идеальной петле.
   */
  const shots = Math.max(2, opts.shots ?? LATENCY.shots)
  const { loopback } = opts
  const chirp = makeChirp(loopback.sampleRate)

  const heard: number[] = []
  for (let i = 0; i < shots; i++) {
    const rec = await loopback.shoot(chirp)
    const ms = correlate(chirp, rec, loopback.sampleRate)
    if (Number.isFinite(ms)) heard.push(Math.round(ms))
  }

  const need = Math.max(2, Math.ceil(shots * LATENCY.minHeardFrac))
  if (heard.length < need) {
    const message = `услышано ${heard.length} из ${shots} выстрелов, нужно ${need}`
    write(latencyMeasured({ ok: false, shots: shots, heard: heard.length, message }))
    throw new Error(`замер не удался: ${message}`)
  }

  const medianMs = Math.round(median(heard))
  const spreadMs = Math.max(...heard) - Math.min(...heard)

  /*
   * Медиана обязана НА ЧТО-ТО опираться. Серия, разбежавшаяся целиком, даёт
   * медиану-середину мусора, и `ok: true` на такой превращает её в замер —
   * см. `LATENCY.agreeMs`.
   */
  const agreed = heard.filter((ms) => Math.abs(ms - medianMs) <= LATENCY.agreeMs).length
  if (agreed * 2 <= heard.length) {
    const message = `выстрелы разбежались: согласны с медианой ${agreed} из ${heard.length}, разброс ${spreadMs} мс`
    write(latencyMeasured({ ok: false, shots, heard: heard.length, medianMs, spreadMs, message }))
    throw new Error(`замер не удался: ${message}`)
  }

  write(latencyMeasured({ ok: true, shots, heard: heard.length, medianMs, spreadMs }))
  return { medianMs, spreadMs, shots: heard }
}

/** Микрофонная петля, которую надо отпустить после замера. */
export type ClosableLoopback = Loopback & { close(): Promise<void> }

/**
 * Замер целиком: открыть микрофон, отстрелять серию, отпустить микрофон.
 *
 * **Отказ уходит НАРУЖУ, а не превращается в «не мерили».** Это и есть причина
 * существования обёртки: сборка жила в `src/main.ts` — точке входа, которую
 * проверить нечем, — и глотала отказ, возвращая `null`. Служебный экран на
 * этом показывал «Ещё не мерили» ровно там, где мерили и не услышали, то есть
 * врал в единственном месте, которое и заведено для диагностики. Поймано
 * проверкой в браузере, не тестом; поэтому логика переехала сюда, где её
 * видно.
 *
 * Микрофон отпускается в ЛЮБОМ исходе: иначе индикатор записи горит дальше.
 */
/**
 * Сколько ждать всю серию.
 *
 * Запись — лишь половина времени выстрела: вторая уходит в корреляцию, а она
 * ищет сдвиг по всему диапазону `maxLagMs` на каждом выстреле, в главном
 * потоке. Измерено в браузере: двенадцать выстрелов заняли около сорока
 * секунд при чистой записи в восемнадцать. Прежний запас считался от одной
 * `recordMs` и был КОРОЧЕ измеренного — то есть сторож отменял бы исправный
 * замер. Найдено код-ревью.
 *
 * Число выстрелов поднимается до двух так же, как в `measureLatency`: иначе
 * `shots: 1` получал бюджет одного выстрела на серию из двух.
 */
export const seriesBudgetMs = (shots: number): number => Math.max(2, shots) * LATENCY.recordMs * 4

export async function measurePipelineLatency(deps: {
  openMic: () => Promise<ClosableLoopback>
  shots?: number
  /** Срок на разрешение микрофона. */
  micMs?: number
  /** Срок на всю серию выстрелов. */
  totalMs?: number
}): Promise<LatencyResult> {
  /*
   * СРОКИ, и они не перестраховка. «Любое обещание разрешений может не
   * завершиться никогда» — измеренное правило `run-game`, где без сроков
   * приложение вставало на экране загрузки. Здесь это поймано проверкой в
   * браузере: нажатие кнопки не дало НИ ОДНОГО исхода за полминуты, и
   * служебный экран всё это время показывал «Ещё не мерили» — то есть то же
   * самое, что и до нажатия.
   *
   * Повиснуть способны оба конца: разрешение микрофона и сама петля (запись
   * идёт через устаревший `ScriptProcessor`, и молчащий узел ответа не даёт).
   * Поэтому срок у каждого свой. Двадцать секунд на разрешение — число
   * `run-game`; на серию берётся время всех выстрелов с запасом вдвое.
   */
  const micMs = deps.micMs ?? 20_000
  const shots = deps.shots ?? LATENCY.shots
  const totalMs = deps.totalMs ?? seriesBudgetMs(shots)

  /*
   * Срок отклоняет ОЖИДАНИЕ, но не отменяет `getUserMedia`: взрослый способен
   * нажать «Разрешить» позже срока, и тогда дорожка приезжает к никому. Такую
   * петлю надо закрыть вслед, иначе индикатор записи горит до закрытия
   * страницы — ровно то, что обещано не делать. Найдено код-ревью.
   */
  const opening = deps.openMic()
  let loopback: ClosableLoopback
  try {
    loopback = await withTimeout(opening, micMs, 'микрофон')
  } catch (e) {
    void opening.then(
      (late) => late.close(),
      () => {},
    )
    throw e
  }

  try {
    return await withTimeout(measureLatency({ loopback, shots }), totalMs, 'замер задержки')
  } finally {
    await loopback.close()
  }
}
