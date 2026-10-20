/**
 * Настройки забега — экран взрослого.
 *
 * **Порог голосования и длина окна судейства здесь отсутствуют.** Это не
 * вкусовые параметры, а следствия измеренной частоты кадров: предлагать их
 * подкрутить значит предлагать сломать судейство. Их место — отладка.
 * → `docs/judging.md`
 *
 * **Настройки читаются живо:** смена строгости или силуэта действует со
 * следующего раунда, без перезапуска забега.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */

import { OPTIONS, toggleBlocked } from '../../adapters/settings'
import type { Settings } from '../../adapters/settings'
import { POSE_TAGS } from '../../core/types'
import type { PoseTag } from '../../core/types'
import { button, choice, el, group } from '../dom'

const TAG_NAME: Record<PoseTag, string> = {
  crouch: 'Присед',
  lean: 'Наклоны',
  asymmetric: 'Асимметричные руки',
  profile: 'Профильные позы',
  'one-leg': 'Опора на одной ноге',
}

const STRICT_NAME = { soft: 'мягко', normal: 'норма', strict: 'строго' } as const
const PREVIEW_NAME = { on: 'вкл', field: 'поле', off: 'выкл' } as const

/** Секунды из миллисекунд, человеческим видом: `2.5`, а не `2500`. */
const sec = (ms: number): string => String(ms / 1000)

export type SettingsOpts = {
  settings: Settings
  onBack(): void
  /**
   * Служебный экран. Отдельной кнопкой, потому что иначе он НЕДОСТИЖИМ: вход
   * к взрослому ведёт сюда, а отсюда дальше дороги не было вовсе — журнал,
   * замер задержки и отладка существовали, но нажать их было негде.
   */
  onService(): void
  refresh(): void
}

export function settingsScreen(o: SettingsOpts): HTMLElement {
  const s = o.settings
  const re = o.refresh

  return el('div', { class: 'screen settings' }, [
    el('div', { class: 'top' }, [
      button('← Назад', o.onBack, { 'data-test': 'back' }),
      button('Служебный экран', o.onService, { 'data-test': 'to-service' }),
    ]),
    el('h1', { text: 'Настройки забега' }),

    group('Такт', [
      el('h3', { text: 'Превью' }),
      /*
       * `null` — «по ступени»: такт ступени и есть значение по умолчанию, а
       * перебивка не навсегда. Без этого пункта вернуть такт ступени было бы
       * нечем, и перебитый однажды такт застрял бы до переустановки игры.
       */
      choice(
        'previewMs',
        [null, ...OPTIONS.previewMs] as const,
        s.get('previewMs'),
        (v) => (v === null ? 'по ступени' : sec(v)),
        (v) => {
          s.set('previewMs', v)
          re()
        },
      ),
      el('h3', { text: 'Ход стены' }),
      choice(
        'wallMs',
        [null, ...OPTIONS.wallMs] as const,
        s.get('wallMs'),
        (v) => (v === null ? 'по ступени' : sec(v)),
        (v) => {
          s.set('wallMs', v)
          re()
        },
      ),
      el('h3', { text: 'Пауза после приговора' }),
      choice('verdictMs', OPTIONS.verdictMs, s.get('verdictMs'), sec, (v) => {
        s.set('verdictMs', v)
        re()
      }),
    ]),

    group('Помощь', [
      el('h3', { text: 'Силуэт поверх выреза' }),
      choice(
        'silhouette',
        OPTIONS.silhouette,
        s.get('silhouette'),
        (v) => (v ? 'вкл' : 'выкл'),
        (v) => {
          s.set('silhouette', v)
          re()
        },
      ),
      el('h3', { text: 'Превью камеры в забеге' }),
      choice(
        'cameraPreview',
        OPTIONS.cameraPreview,
        s.get('cameraPreview'),
        (v) => PREVIEW_NAME[v],
        (v) => {
          s.set('cameraPreview', v)
          re()
        },
      ),
    ]),

    group('Судейство', [
      el('h3', { text: 'Строгость' }),
      choice(
        'strictness',
        OPTIONS.strictness,
        s.get('strictness'),
        (v) => STRICT_NAME[v],
        (v) => {
          s.set('strictness', v)
          re()
        },
      ),
      el('h3', { text: 'Сдвиг на задержку, мс' }),
      choice('latencyMs', OPTIONS.latencyMs, s.get('latencyMs'), String, (v) => {
        s.set('latencyMs', v)
        re()
      }),
    ]),

    group(
      'Словарь',
      POSE_TAGS.map((tag) => {
        const on = s.toggles()[tag] !== false
        const blocked = toggleBlocked(s, tag)
        /*
         * Заблокированный тумблер показан ОТКЛЮЧЁННЫМ и с пояснением. Тумблер,
         * который нажимается и ничего не делает, выглядит сломанным, а
         * пустеющий пул ломает выбор следующей позы — он чистая функция и
         * состояния «поз не осталось» не имеет.
         */
        return button(
          `${TAG_NAME[tag]}: ${on ? 'вкл' : 'выкл'}`,
          () => {
            s.setToggle(tag, !on)
            re()
          },
          {
            'data-test': `toggle-${tag}`,
            disabled: blocked,
            title: blocked ? 'Выключить нельзя: в наборе осталось бы меньше трёх поз' : '',
            'aria-pressed': on,
          },
        )
      }),
    ),

    group('Звук', [
      el('h3', { text: 'Громкость' }),
      choice('volume', OPTIONS.volume, s.get('volume'), (v) => `${Math.round(v * 100)}%`, (v) => {
        s.set('volume', v)
        re()
      }),
    ]),
  ])
}
