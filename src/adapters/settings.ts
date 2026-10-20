/**
 * Настройки забега: перечень допустимых значений и их хранение.
 *
 * **Настройки читаются живо.** Смена строгости или силуэта действует со
 * следующего раунда, без перезапуска забега: иначе взрослый, подкручивающий
 * строгость рядом с играющим ребёнком, вынужден обрывать забег. Поэтому здесь
 * нет снимка — есть `get`, который зовут каждый раунд.
 *
 * Хранилище приходит зависимостью: его отказ (приватный режим, исчерпанная
 * квота) обязан давать «игра играется, настройки живут сеанс», а не исключение
 * наружу. Телефон на штативе, консоли нет.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */

import { strictness } from '../core/config'
import { cutouts } from '../core/poses'
import type { Toggles } from '../core/poses'
import { POSE_TAGS } from '../core/types'
import type { PoseTag } from '../core/types'
import type { Timings } from '../core/round'

/**
 * Допустимые значения каждой настройки.
 *
 * **Порог голосования и длина окна судейства здесь ОТСУТСТВУЮТ намеренно.** Это
 * не вкусовые параметры, а следствия измеренной частоты кадров: предлагать
 * взрослому подкрутить то, что он не может измерить, значит предлагать ему
 * сломать судейство. Их место — отладка.
 * → `docs/judging.md`
 */
export const OPTIONS = Object.freeze({
  durationSec: Object.freeze([60, 90, 120] as const),
  tier: Object.freeze([1, 2, 3] as const),
  previewMs: Object.freeze([1500, 2000, 2500, 3000] as const),
  wallMs: Object.freeze([1500, 2000, 2500, 3000] as const),
  verdictMs: Object.freeze([500, 800, 1200] as const),
  latencyMs: Object.freeze([0, 150, 250, 400] as const),
  strictness: Object.freeze(['soft', 'normal', 'strict'] as const),
  silhouette: Object.freeze([false, true] as const),
  cameraPreview: Object.freeze(['on', 'field', 'off'] as const),
  volume: Object.freeze([0, 0.25, 0.5, 0.75, 1] as const),
})

/**
 * Такт по ступени — ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ, которое взрослый вправе перебить.
 *
 * Ступень 1 даёт самый медленный такт, 3 — самый быстрый: ребёнку на первой
 * ступени нужно больше времени и на разглядывание позы, и на её принятие.
 */
const TIER_TACT = Object.freeze({
  1: { previewMs: 3000, wallMs: 3000 },
  2: { previewMs: 2500, wallMs: 2500 },
  3: { previewMs: 2000, wallMs: 2000 },
} as const)

export type SettingsShape = {
  durationSec: (typeof OPTIONS.durationSec)[number]
  tier: (typeof OPTIONS.tier)[number]
  /** `null` — «по ступени»: такт берётся из `TIER_TACT`. */
  previewMs: (typeof OPTIONS.previewMs)[number] | null
  wallMs: (typeof OPTIONS.wallMs)[number] | null
  verdictMs: (typeof OPTIONS.verdictMs)[number]
  latencyMs: (typeof OPTIONS.latencyMs)[number]
  strictness: (typeof OPTIONS.strictness)[number]
  silhouette: boolean
  cameraPreview: (typeof OPTIONS.cameraPreview)[number]
  volume: (typeof OPTIONS.volume)[number]
}

export type SettingsKey = keyof SettingsShape

const DEFAULTS: SettingsShape = Object.freeze({
  durationSec: 90,
  tier: 1,
  previewMs: null,
  wallMs: null,
  verdictMs: 800,
  latencyMs: 250,
  strictness: 'normal',
  silhouette: false,
  cameraPreview: 'field',
  volume: 0.75,
})

const KEY = 'pose-game.settings'

/** Значение допустимо? `null` допустим только у перебиваемого такта. */
function allowed<K extends SettingsKey>(k: K, v: unknown): v is SettingsShape[K] {
  if ((k === 'previewMs' || k === 'wallMs') && v === null) return true
  const list = OPTIONS[k as keyof typeof OPTIONS] as readonly unknown[] | undefined
  if (!list) return false
  return list.includes(v)
}

export type Settings = {
  get<K extends SettingsKey>(k: K): SettingsShape[K]
  /** `false` — значение вне перечня, прежнее осталось. */
  set<K extends SettingsKey>(k: K, v: SettingsShape[K]): boolean
  /** Тумблеры словаря как их ждёт ядро. Выключенный тег приходит как `false`. */
  toggles(): Toggles
  /** `false` — тумблер заблокирован: он уронил бы пул ниже трёх поз. */
  setToggle(tag: PoseTag, on: boolean): boolean
  /** Множитель строгости для ядра. */
  strict(): number
  /** Хранилище отказало: настройки живут только этот сеанс. */
  readonly broken: boolean
}

export type SettingsOpts = {
  /** `localStorage`, либо `null`, когда его нет. */
  store?: Storage | null
}

function defaultStore(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    // Доступ к самому свойству умеет бросать при заблокированных cookie.
    return null
  }
}

export function makeSettings(opts: SettingsOpts = {}): Settings {
  const store = opts.store === undefined ? defaultStore() : opts.store
  let broken = false

  const values: SettingsShape = { ...DEFAULTS }
  /** Выключенные теги словаря. Включённые в множестве не лежат. */
  const off = new Set<PoseTag>()

  /*
   * Чтение из хранилища — ПРОСЕИВАНИЕ, а не доверие. Хранилище переживает
   * обновления игры, и перечень значений мог с тех пор измениться: негодное
   * значение оттуда так же негодно, как опечатка в служебном экране.
   */
  try {
    const raw = store?.getItem(KEY)
    if (raw) {
      const got = JSON.parse(raw) as Record<string, unknown>
      for (const k of Object.keys(values) as SettingsKey[]) {
        const v = got[k]
        if (v !== undefined && allowed(k, v)) {
          ;(values as Record<string, unknown>)[k] = v
        }
      }
      const tags = got['off']
      if (Array.isArray(tags)) {
        for (const t of tags) if (POSE_TAGS.includes(t as PoseTag)) off.add(t as PoseTag)
      }
    }
  } catch {
    // Мусор в хранилище или отказ чтения — берутся значения по умолчанию.
    broken = true
  }

  const toggles = (): Toggles => {
    const out: Toggles = {}
    for (const t of off) out[t] = false
    return out
  }

  const save = (): void => {
    if (!store) return
    try {
      store.setItem(KEY, JSON.stringify({ ...values, off: [...off] }))
    } catch {
      /*
       * Квота кончилась или приватный режим. Игра играется, настройки живут
       * сеанс: исключение наружу здесь стоило бы забега.
       */
      broken = true
    }
  }

  const self: Settings = {
    get: (k) => values[k],
    set: (k, v) => {
      if (!allowed(k, v)) return false
      values[k] = v
      /*
       * Смена ступени МОЖЕТ сделать уже выключенный тег недопустимым: ступень 1
       * с выключенным симметричным набором — пустой пул. Поэтому выключения,
       * которые на новой ступени роняют пул, снимаются здесь же, а не ждут
       * первого раунда, где их некому поправить.
       */
      if (k === 'tier') {
        // Пересобираем выключения ОТ ПУСТОГО: оставляем ровно те, что на новой
        // ступени ещё допустимы. Проверять их все вместе нельзя — тогда один
        // недопустимый снял бы и допустимые.
        const keep = new Set<PoseTag>()
        for (const t of off) {
          const probe: Toggles = {}
          for (const q of keep) probe[q] = false
          probe[t] = false
          if (cutouts(values.tier, probe).length >= 3) keep.add(t)
        }
        off.clear()
        for (const t of keep) off.add(t)
      }
      save()
      return true
    },
    toggles,
    setToggle: (tag, on) => {
      if (on) {
        off.delete(tag)
        save()
        return true
      }
      /*
       * Выключение, роняющее пул ниже трёх поз, НЕ происходит. Так выбор
       * следующей позы остаётся чистой функцией и не обзаводится состоянием
       * «пул опустел» — а именно в нём игра либо падает, либо выдаёт одну позу
       * подряд.
       */
      const probe = toggles()
      probe[tag] = false
      if (cutouts(values.tier, probe).length < 3) return false
      off.add(tag)
      save()
      return true
    },
    strict: () => strictness(values.strictness),
    get broken() {
      return broken
    },
  }

  return self
}

/** Заблокирован ли тумблер: его выключение уронило бы пул ниже трёх поз. */
export function toggleBlocked(s: Settings, tag: PoseTag): boolean {
  const probe = s.toggles()
  if (probe[tag] === false) return false
  probe[tag] = false
  return cutouts(s.get('tier'), probe).length < 3
}

/**
 * Такт для ядра: значения ступени, перебитые настройками взрослого.
 *
 * Отдельная функция, а не поле: такт читается живо, как и всё остальное, и
 * снимок здесь означал бы, что настройка такта выглядит работающей и не
 * работает.
 */
export function timingsFor(s: Settings): Timings {
  const tact = TIER_TACT[s.get('tier')]
  return {
    previewMs: s.get('previewMs') ?? tact.previewMs,
    wallMs: s.get('wallMs') ?? tact.wallMs,
    latencyMs: s.get('latencyMs'),
    verdictMs: s.get('verdictMs'),
  }
}
