/**
 * Ориентация экрана и полный экран: забег горизонтальный, меню портретное.
 *
 * Задаётся ПОЭКРАННО, а не манифестом. В манифесте ориентации нет намеренно:
 * Chrome запекает манифест в WebAPK при установке, и жёсткий `landscape`
 * сделал бы портрет недоступным навсегда — а меню ребёнок держит в руке.
 *
 * **Порядок и сроки здесь перенесены из `run-game`** — того же телефона, той
 * же трансляции на телевизор, и там они оплачены живыми прогонами:
 *
 * - `lock()` на Android без полноэкранного режима просто ОТКАЗЫВАЕТ, поэтому
 *   полный экран просится первым;
 * - ориентация просится ДАЖЕ если полный экран отказал: кнопка «Назад» не даёт
 *   жеста, `requestFullscreen()` без жеста отклоняется, и забег открывался бы
 *   вертикальной вёрсткой;
 * - у установленного приложения полный экран — РЕЖИМ ОКНА, а не состояние, и
 *   просить его там нечего;
 * - любое из этих обещаний может не завершиться никогда — отсюда сроки.
 *
 * **Wake lock здесь отсутствует намеренно**, а не забыт: на этом телефоне он
 * экран не держит, и это измерено в `run-game` — во вкладке и в установленном
 * приложении, при взятой блокировке и без единого отпускания.
 * → `docs/render-and-layout.md`
 */

import { withTimeout } from './promise'

/**
 * Ориентация по экрану — ОДНОЙ таблицей.
 *
 * Запасной план `run-game`, если поэкранная смена окажется на устройстве
 * ненадёжной: сделать всё горизонтальным. Это правка одной таблицы, а не
 * семи мест в коде, — ровно для этого она и собрана здесь.
 */
export const ORIENTATION = Object.freeze({
  menu: 'portrait',
  run: 'landscape',
  settings: 'portrait',
  service: 'portrait',
} as const)

/** Сроки ожидания привилегированных обещаний, те же, что в `run-game`. */
export const ORIENTATION_TIMEOUTS = Object.freeze({ fullscreenMs: 3000, lockMs: 1500 })

/** Чем закрепляют ориентацию. Подменяется в тестах: в node этого нет. */
export type OrientationDeps = {
  lock(want: 'portrait' | 'landscape'): Promise<void>
  /** Полный экран: без него Chrome замок не разрешает. */
  fullscreen(): Promise<void>
  /**
   * Запущено ли как установленное приложение. Тогда полный экран — режим
   * окна, и запрашивать его не нужно (и нечем: жеста нет).
   */
  installed: boolean
}

export type LockResult = {
  locked: boolean
  /** Почему не вышло. Есть только при `locked: false`. */
  why?: string
}

const says = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Запущено ли как УСТАНОВЛЕННОЕ приложение, а не вкладка браузера.
 *
 * Живёт здесь и в единственном экземпляре: от этого ответа зависит и просьба
 * о полном экране (у приложения это режим окна), и запись о сессии в журнал.
 * Две копии одного `matchMedia` однажды разошлись бы условием.
 */
export const installedApp = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen)').matches

/** Браузерные зависимости. Отсутствие API — такой же отказ, как и запрет. */
export function browserOrientation(): OrientationDeps {
  return {
    installed: installedApp(),
    lock: async (want) => {
      /*
       * `lock` описан в Screen Orientation API, но не в тех `lib.dom`, с
       * которыми собирается проект: типизируется здесь, а не приводится к
       * `any` — отсутствие метода проверяется в рантайме строкой ниже.
       */
      type Lockable = { lock?: (o: string) => Promise<void> }
      const so = typeof screen === 'undefined' ? null : (screen.orientation as Lockable | undefined)
      if (!so || typeof so.lock !== 'function') throw new Error('замок ориентации не поддерживается')
      await so.lock(want)
    },
    fullscreen: async () => {
      const el = typeof document === 'undefined' ? null : document.documentElement
      if (!el || typeof el.requestFullscreen !== 'function') throw new Error('полный экран не поддерживается')
      if (document.fullscreenElement) return
      await el.requestFullscreen({ navigationUI: 'hide' })
    },
  }
}

/**
 * Закрепить ориентацию: сначала полный экран, потом замок.
 *
 * Отказ полного экрана проглатывается НАМЕРЕННО — замок просится в любом
 * случае. Исход замка отдаётся значением, а не исключением: на iOS его нет
 * вовсе, и игра обязана играться и там.
 */
export async function lockOrientation(
  want: 'portrait' | 'landscape',
  deps: OrientationDeps,
  timeouts: { fullscreenMs?: number; lockMs?: number } = {},
): Promise<LockResult> {
  const fullscreenMs = timeouts.fullscreenMs ?? ORIENTATION_TIMEOUTS.fullscreenMs
  const lockMs = timeouts.lockMs ?? ORIENTATION_TIMEOUTS.lockMs

  if (!deps.installed) {
    try {
      await withTimeout(deps.fullscreen(), fullscreenMs, 'полный экран')
    } catch {
      // Молча: отказ полного экрана сам по себе не беда, а замок всё равно
      // просится — иначе возврат кнопкой «Назад» открывал бы забег портретом.
    }
  }

  try {
    await withTimeout(deps.lock(want), lockMs, 'замок ориентации')
    return { locked: true }
  } catch (e) {
    return { locked: false, why: says(e) }
  }
}
