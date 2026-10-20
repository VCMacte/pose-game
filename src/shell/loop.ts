/**
 * Два независимых такта: кадры камеры и кадры экрана.
 *
 * **Кадр камеры НЕ рисует, кадр экрана НЕ трогает трекер.** Это главный
 * инвариант покадрового пути, и он проверяется тестом. Склеенные такты дают
 * ровно ту болезнь, от которой лестница конвейеров и спасает: 11 Гц поз
 * превращаются в 11 Гц картинки, а стена едет рывками. Обратная склейка хуже:
 * рендер начинает ждать инференс, и просадка GPU останавливает мир.
 *
 * Поэтому здесь:
 *
 * - `onSample` только КЛАДЁТ кадр в буфер и считает статистику;
 * - `frame(t)` забирает накопленное, продвигает мир и рисует.
 *
 * Разбор: `docs/camera-and-pose.md`, `docs/render-and-layout.md`.
 */

import type { Frame } from '../core/types'
import { health } from '../adapters/log/events'
import { write } from '../adapters/log/store'

/** Раз в сколько писать сводку здоровья в журнал. */
const HEALTH_MS = 1000

/** Что продвижение мира успело насчитать за кадр — для сводки `health`. */
export type StepCounts = { valid: number; lost: number }

export type LoopOpts = {
  /**
   * Продвинуть мир накопленными кадрами и нарисовать его. Возвращает, сколько
   * кадров присутствие признало годными и сколько потеряло: эти числа знает
   * только ядро, и выдумывать их здесь было бы враньём в журнал.
   */
  step(t: number, frames: Frame[]): StepCounts | void
}

export type Loop = {
  /**
   * Кадр камеры. Только буфер и счётчики: ни рендера, ни продвижения мира.
   * Зовётся из `onSample` источника позы.
   */
  sample(f: Frame): void
  /**
   * Сводка от источника позы (`beat`): задержки инференса и отбросы. Приходит
   * оттуда, а не считается здесь, потому что инференс идёт в воркере и главный
   * поток о его длительности знает только по сообщению.
   */
  noteBeat(b: { p50: number; p95: number; dropped: number }): void
  /**
   * Кадр экрана. Забирает накопленные кадры и отдаёт их `step`. Зовётся из
   * `requestAnimationFrame`.
   */
  frame(t: number): void
  /** Сколько кадров сейчас ждут в буфере — для отладки. */
  pending(): number
}

export function makeLoop(opts: LoopOpts): Loop {
  let buf: Frame[] = []
  let draws = 0
  let valid = 0
  let lost = 0
  let drops = 0
  let p50 = 0
  let p95 = 0
  let lastHealth = 0
  let started = false

  return {
    sample: (f) => {
      /*
       * Буфер, а не «последний кадр»: судейство голосует по ВСЕМ кадрам окна, и
       * выброшенный кадр — это выброшенный голос. Потолка здесь нет намеренно:
       * его роль играет `frame`, который забирает буфер целиком каждый кадр
       * экрана. Рендер идёт в 38–40 fps против 11 Гц поз, так что в буфере
       * лежит один-два кадра, а не очередь.
       */
      buf.push(f)
    },
    noteBeat: (b) => {
      p50 = b.p50
      p95 = b.p95
      drops += b.dropped
    },
    frame: (t) => {
      if (!started) {
        started = true
        lastHealth = t
      }
      const frames = buf
      buf = []
      draws++

      const got = opts.step(t, frames)
      if (got) {
        valid += got.valid
        lost += got.lost
      }

      if (t - lastHealth >= HEALTH_MS) {
        const sec = (t - lastHealth) / 1000
        write(
          health({
            fps: Math.round(draws / sec),
            inferP50: p50,
            inferP95: p95,
            drops,
            valid,
            lost,
          }),
        )
        draws = 0
        valid = 0
        lost = 0
        drops = 0
        lastHealth = t
      }
    },
    pending: () => buf.length,
  }
}
