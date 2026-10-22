/**
 * Точка входа: поднять оболочку над настоящим браузером и подать ей настоящие
 * адаптеры.
 *
 * Логики здесь нет и не должно быть — логика, которую видно лишь в браузере,
 * непроверяема. Здесь только подстановка: что в тестах подменяется, то в бою
 * подаётся отсюда.
 */

import { createAudio } from './adapters/audio'
import { clear, save, status } from './adapters/log/store'
import { buildInfo, checkVendor } from './adapters/sw'
import { startApp } from './shell/app'

const root = document.getElementById('app')

if (root) {
  /** Сводка журнала и целостность вендора — для служебного экрана. */
  let logInfo = { sessions: 0, events: 0, bytes: 0, broken: false }
  let modelCached = false

  startApp(root, {
    audio: createAudio(),

    /**
     * Замер задержки тракта. Микрофон и арифметика грузятся ДИНАМИЧЕСКИ:
     * на экране забега они не нужны, а разрешение на микрофон спрашивается
     * только здесь и только по нажатию кнопки.
     */
    measureLatency: async () => {
      const [{ measurePipelineLatency }, { micLoopback }] = await Promise.all([
        import('./adapters/latency'),
        import('./adapters/mic'),
      ])
      /*
       * Отказ НЕ глотается здесь, и это правка по проверке в браузере.
       * Прежде он превращался в `null`, а служебный экран показывал «Ещё не
       * мерили» — то есть врал о замере, который был и не удался. Отказ ловит
       * оболочка и ПОКАЗЫВАЕТ его причину; уборка микрофона и запись в журнал
       * живут внутри `measurePipelineLatency`.
       */
      return await measurePipelineLatency({ openMic: () => micLoopback() })
    },

    saveLog: async () => {
      await save()
      logInfo = await summary()
    },

    clearLog: async () => {
      await clear()
      logInfo = await summary()
    },

    serviceInfo: () => ({
      log: logInfo,
      latency: null,
      build: { ...buildInfo(), modelCached },
    }),

    /*
     * Сброс офлайн-кэша и перезагрузка. Перезагрузка обязательна: снять одни
     * кэши мало — страницей до конца её жизни продолжает управлять прежний
     * worker, и кнопка выглядела бы не сработавшей.
     */
    refreshCache: async () => {
      const { dropCaches } = await import('./adapters/sw')
      await dropCaches()
      location.reload()
    },
  })

  /*
   * Сводка журнала и целостность вендора спрашиваются ПОСЛЕ старта и без
   * ожидания: обе ходят в хранилище, а меню обязано открыться сразу.
   */
  void summary().then((s) => {
    logInfo = s
  })
  void checkVendor(typeof caches === 'undefined' ? null : caches).then((r) => {
    modelCached = r.ok
  })

  /*
   * Регистрация service worker — ПОСЛЕ запуска приложения и без ожидания:
   * офлайн это запас на следующий раз, а не условие сегодняшнего запуска.
   * Отказ регистрации (нет https, выключены service worker'ы) игру не задевает.
   *
   * В dev worker не регистрируется вовсе: иначе закэшированная сборка
   * перебивала бы правки, и каждая из них требовала бы сброса данных.
   */
  if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
    /*
     * Адрес и область worker'а — от БАЗОВОГО пути сборки, а не от корня: на
     * GitHub Pages проект живёт по `/<имя-репозитория>/`, и корневой `/sw.js`
     * там не только не существует, но и не имел бы права управлять страницей
     * (область worker'а не может быть шире его собственного каталога).
     */
    const base = import.meta.env.BASE_URL
    void navigator.serviceWorker.register(`${base}sw.js`, { type: 'module', scope: base }).catch(() => {
      // Офлайна не будет; из сети игра идёт.
    })
  }
}

/** Сводка журнала в том виде, какой ждёт служебный экран. */
async function summary(): Promise<{
  sessions: number
  events: number
  bytes: number
  broken: boolean
}> {
  const s = await status()
  return { sessions: s.sessions, events: s.events, bytes: s.bytes, broken: s.broken }
}
