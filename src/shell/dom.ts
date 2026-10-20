/**
 * Мелкая помощь по DOM. Ровно столько, чтобы экраны читались как разметка, а
 * не как череда `createElement`.
 *
 * Фреймворка нет намеренно: экранов три, перерисовываются они целиком и редко
 * (покадровый путь идёт по Canvas, а не по DOM), и React здесь платил бы
 * килобайтами и кадрами за задачу, которой нет.
 */

type Attrs = Record<string, string | number | boolean | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  kids: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k === 'text') {
      node.textContent = String(v)
      continue
    }
    if (v === true) {
      node.setAttribute(k, '')
      continue
    }
    node.setAttribute(k, String(v))
  }
  for (const kid of kids) node.append(kid)
  return node
}

/** Кнопка с обработчиком. `test` — метка для тестов, не для вёрстки. */
export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = el('button', { type: 'button', ...attrs }, [label])
  b.addEventListener('click', onClick)
  return b
}

/**
 * Ряд взаимоисключающих кнопок — так в этой игре выбирается ВСЁ.
 *
 * Выпадающих списков нет: ребёнок 7 лет и взрослый в полуметре от штатива
 * нажимают крупную кнопку, а не ищут пункт в списке.
 */
export function choice<T>(
  test: string,
  values: readonly T[],
  current: T,
  label: (v: T) => string,
  pick: (v: T) => void,
): HTMLElement {
  return el(
    'div',
    { class: 'choice', 'data-test': test },
    values.map((v) =>
      button(label(v), () => pick(v), {
        class: v === current ? 'on' : '',
        'aria-pressed': v === current,
      }),
    ),
  )
}

/** Заголовок группы настроек. */
export const group = (title: string, kids: Array<Node | string>): HTMLElement =>
  el('section', { class: 'group' }, [el('h2', { text: title }), ...kids])
