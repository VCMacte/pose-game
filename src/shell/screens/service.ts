/**
 * Служебный экран — отладка и обслуживание, для взрослого.
 *
 * Здесь живёт то, что в настройки забега не вынесено: журнал, замер задержки
 * тракта, версия сборки и отладочные переключатели источника позы.
 *
 * Разбор: `docs/menu-and-settings.md`, `docs/log-and-storage.md`,
 * `docs/audio-and-latency.md`, `docs/offline-and-build.md`.
 */

import { button, choice, el, group } from '../dom'
import type { Settings } from '../../adapters/settings'

export type ServiceInfo = {
  /** Сводка журнала: сессий, событий, размер. */
  log: { sessions: number; events: number; bytes: number; broken: boolean }
  /** Последний замер задержки, если он был. */
  latency: { medianMs: number; spreadMs: number } | null
  build: { version: string; date: string; modelCached: boolean }
}

export type ServiceOpts = {
  settings: Settings
  info: ServiceInfo
  onBack(): void
  onMeasureLatency(): void
  onShareLog(): void
  onClearLog(): void
  onRecalibrate(): void
  /**
   * Текущий отладочный выбор и его запись. Приходит снаружи, а не живёт в
   * экране: экран перерисовывается целиком, и состояние внутри него пропадало
   * бы при каждой перерисовке — переключатель выглядел бы работающим и не
   * работал.
   */
  debug: Debug
  onDebug(patch: Partial<Debug>): void
  refresh(): void
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

/** Отладочные значения источника позы — те же, что понимает `?pipeline=`. */
export const DEBUG_PIPELINES = ['авто', 'stream', 'bitmap', 'main'] as const
export const DEBUG_SOURCES = ['камера', 'фейк'] as const

export type Debug = {
  source: (typeof DEBUG_SOURCES)[number]
  pipeline: (typeof DEBUG_PIPELINES)[number]
}

export function serviceScreen(o: ServiceOpts): HTMLElement {
  const i = o.info

  return el('div', { class: 'screen service' }, [
    el('div', { class: 'top' }, [button('← Назад', o.onBack, { 'data-test': 'back' })]),
    el('h1', { text: 'Служебный экран' }),

    group('Журнал', [
      el('div', {
        text: i.log.broken
          ? 'Журнал выключен: хранилище недоступно'
          : `Сессий ${i.log.sessions}, событий ${i.log.events}, ${mb(i.log.bytes)} МБ из 25`,
      }),
      button('СОХРАНИТЬ И ПОДЕЛИТЬСЯ', o.onShareLog, { 'data-test': 'share-log' }),
      button('Очистить журнал', o.onClearLog, { 'data-test': 'clear-log' }),
    ]),

    group('Задержка тракта', [
      el('div', {
        text: i.latency
          ? `Измерено: ${i.latency.medianMs} мс, разброс ${i.latency.spreadMs} мс`
          : 'Ещё не мерили',
      }),
      button('ИЗМЕРИТЬ ЗАДЕРЖКУ', o.onMeasureLatency, { 'data-test': 'measure-latency' }),
      /*
       * Измеренное число — ОТПРАВНАЯ ТОЧКА, а не производная настройка: это
       * задержка ЗВУКА, и видеопуть совпадает с ней только пока телевизор
       * держит A/V-синхронизацию. Поэтому сдвиг остаётся ручным, в настройках
       * забега, и подставляется сюда подсказкой, а не присваиванием.
       */
      el('small', { text: 'Сдвиг на задержку настраивается вручную в настройках забега' }),
    ]),

    group('Версия', [
      el('div', { text: `Сборка ${i.build.version} от ${i.build.date}` }),
      el('div', { text: i.build.modelCached ? 'Модель позы в кэше' : 'Модель позы НЕ в кэше' }),
    ]),

    group('Отладка', [
      el('h3', { text: 'Источник позы' }),
      choice('debug-source', DEBUG_SOURCES, o.debug.source, String, (v) => {
        o.onDebug({ source: v })
        o.refresh()
      }),
      el('h3', { text: 'Конвейер' }),
      choice('debug-pipeline', DEBUG_PIPELINES, o.debug.pipeline, String, (v) => {
        o.onDebug({ pipeline: v })
        o.refresh()
      }),
      button('Пересдать калибровку', o.onRecalibrate, { 'data-test': 'recalibrate' }),
    ]),
  ])
}
