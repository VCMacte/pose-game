import { CONFIG } from './config'
import type { Geometry } from './geometry'
import type { Calibration } from './types'

/**
 * Калибровка: одна стадия, пять секунд стоя в нейтрали, лицом к камере.
 * Полное обоснование — docs/calibration.md.
 *
 * Читаются ТОЛЬКО углы конечностей (docs/judging.md), и они от роста не
 * зависят — в отличие от предшественника (`run-game`), где судилось смещение
 * тела и нужна была пятистадийная калибровка под размах роста. Здесь хватает
 * масштаба (`S0`) и нейтрали, собранных ОДНОЙ стадией.
 *
 * **Медиана, а не среднее.** Один выброс в серии — обычное дело: ребёнок
 * дёрнулся, трекер на кадр потерял бедро. Среднее такой выброс втягивает,
 * медиана нет.
 *
 * **Время приходит аргументом** (`push(g, t)`, `isStale(cal, now, …)`):
 * `performance.now()` внутри ядра сломал бы replay журнала из node — а это
 * единственный способ разобрать спорный раунд, не переигрывая его с ребёнком.
 */

/** Чего калибратору не хватает, чтобы отдать калибровку. */
export type CalibrationNeed = { need: 'more' | 'steady' }

type Sample = {
  t: number
  S: number
  shoulderWidth: number
  cx: number
  shoulderY: number
  hipY: number
}

export type Calibrator = {
  /** Копит один отсчёт стадии. Кадры, негодные для геометрии, сюда не доходят — их отбраковывает `geometry()`. */
  push(g: Geometry, t: number): void
  /**
   * Срок (`durationMs`) и минимум отсчётов (`minSamples`) не набраны →
   * `{ need: 'more' }`. Срок набран, но центр качался выше `steadyCx` →
   * `{ need: 'steady' }` — ребёнок шевелился, а не «мало данных». Иначе —
   * медианная калибровка по ВСЕМ накопленным отсчётам стадии.
   */
  done(): Calibration | CalibrationNeed
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * `aspect` и `cameraId` — не отсчёты, а контекст стадии: он известен заранее
 * (дорожка камеры уже открыта) и не меняется внутри одной калибровки. Они
 * идут в конструктор, а не в каждый `push()`, и попадают в готовую
 * `Calibration` как есть — `isStale()` ниже сравнивает их со свежими
 * значениями, чтобы поймать смену камеры или отношения сторон кадра.
 */
export function makeCalibrator(aspect: number, cameraId?: string): Calibrator {
  const samples: Sample[] = []

  return {
    push(g, t) {
      samples.push({
        t,
        S: g.S,
        shoulderWidth: g.shoulderRatio * g.S,
        cx: g.cx,
        shoulderY: g.shoulderMid.y,
        hipY: g.hipMid.y,
      })
    },

    done() {
      if (samples.length === 0) return { need: 'more' }

      const elapsed = samples[samples.length - 1].t - samples[0].t
      if (elapsed < CONFIG.calibration.durationMs || samples.length < CONFIG.calibration.minSamples) {
        return { need: 'more' }
      }

      const cxs = samples.map((s) => s.cx)
      const spread = Math.max(...cxs) - Math.min(...cxs)
      if (spread > CONFIG.calibration.steadyCx) return { need: 'steady' }

      return {
        S0: median(samples.map((s) => s.S)),
        shoulderWidth: median(samples.map((s) => s.shoulderWidth)),
        neutralX: median(cxs),
        neutralShoulderY: median(samples.map((s) => s.shoulderY)),
        neutralHipY: median(samples.map((s) => s.hipY)),
        aspect,
        at: samples[samples.length - 1].t,
        cameraId,
      }
    },
  }
}

/**
 * Три повода устаревания, в порядке проверки — первый же сработавший решает:
 * смена камеры, смена отношения сторон кадра, срок (`maxAgeMs`).
 *
 * Отношение сторон — не для порядка: без поправки на него углы врут на
 * десятки градусов (`geometry()`), и калибровка, снятая при другом `aspect`,
 * хуже отсутствующей — судит увереннее, чем видит.
 */
export function isStale(cal: Calibration, now: number, aspect: number, cameraId: string): boolean {
  if (cal.cameraId !== cameraId) return true
  if (cal.aspect !== aspect) return true
  if (now - cal.at > CONFIG.calibration.maxAgeMs) return true
  return false
}
