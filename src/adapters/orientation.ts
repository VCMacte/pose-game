/**
 * Замок ориентации экрана: забег горизонтальный, меню портретное.
 *
 * Ориентация задаётся ПОЭКРАННО, а не манифестом: манифест задал бы одну на
 * всё приложение, а меню ребёнок читает с телефона в руках, забег же уходит на
 * телевизор 16:9. Прежде она только объявлялась (`app.orientation()`) и не
 * действовала ничем: в живом прогоне 22.10.2026 телефон держали портретом, и
 * камера честно отдала 360×640 — экран забега при этом считал себя
 * горизонтальным.
 *
 * **Браузер приходит зависимостью, и отказ здесь — НОРМА, а не исключение.**
 * `screen.orientation.lock()` не разрешён странице вне полного экрана, а на
 * iOS не разрешён вовсе. Игра обязана играться и там, поэтому исход
 * возвращается значением: оболочка попросит взрослого повернуть телефон сама.
 *
 * Разбор: `docs/render-and-layout.md`.
 */

/** Чем закрепляют ориентацию. Подменяется в тестах: в node этого нет. */
export type OrientationDeps = {
  lock(want: 'portrait' | 'landscape'): Promise<void>
  /** Полный экран: без него Chrome замок не разрешает. */
  fullscreen(): Promise<void>
}

export type LockResult = {
  locked: boolean
  /** Почему не вышло. Есть только при `locked: false`. */
  why?: string
}

const says = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Браузерные зависимости по умолчанию. Отсутствие API — такой же отказ, как и
 * запрет: обе ветки ведут к «повернуть телефон руками», а не к исключению.
 */
export function browserOrientation(): OrientationDeps {
  return {
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
      await el.requestFullscreen()
    },
  }
}

/**
 * Закрепить ориентацию, при надобности уйдя в полный экран.
 *
 * Полный экран просится ПОСЛЕ первого отказа замка, а не вместо него: в
 * установленном приложении (`display: fullscreen`) замок проходит сразу, и
 * лишний `requestFullscreen` там только отобрал бы жест. Во вкладке первый
 * отказ как раз и означает «сначала полный экран».
 */
export async function lockOrientation(
  want: 'portrait' | 'landscape',
  deps: OrientationDeps,
): Promise<LockResult> {
  try {
    await deps.lock(want)
    return { locked: true }
  } catch (first) {
    try {
      await deps.fullscreen()
    } catch (e) {
      return { locked: false, why: `${says(first)}; полный экран: ${says(e)}` }
    }
    try {
      await deps.lock(want)
      return { locked: true }
    } catch (e) {
      return { locked: false, why: says(e) }
    }
  }
}
