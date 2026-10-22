import { expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { geometry, type Geometry } from '../../src/core/geometry'
import {
  newPresenceState,
  pauseRequested,
  presence,
  resumeReady,
  type PresenceState,
} from '../../src/core/presence'
import { stick, type StickDesc } from '../../src/fake/stick'

const ASPECT = 16 / 9

const g = (desc: Partial<StickDesc>): Geometry => {
  const got = geometry(stick({ aspect: ASPECT, ...desc }), ASPECT)
  if (got === null) throw new Error('фикстура теста негодна: geometry вернула null')
  return got
}

/** Состояние с уже заведённым доверенным торсом: так выглядит идущий забег. */
const trusting = (cx: number, S: number): PresenceState => {
  const st = newPresenceState()
  st.trustedCx = cx
  st.trustedS = S
  return st
}

// --- порог за порогом ------------------------------------------------------

test('пороги присутствия лежат в CONFIG одним блоком', () => {
  expect(CONFIG.presence.jump.cx).toBe(0.25)
  expect(CONFIG.presence.jump.torsoGrowth).toBe(3)
  expect(CONFIG.presence.scale.torsoMax).toBe(0.45)
  expect(CONFIG.presence.scale.shoulderMin).toBe(0.03)
  expect(CONFIG.presence.edge.margin).toBe(0.15)
  expect(CONFIG.presence.pauseMs).toBe(700)
  expect(CONFIG.presence.resumeMs).toBe(500)
})

/*
 * ИЗМЕРЕННЫЕ на телефоне отношения плеч к торсу. Фронтальная стойка живого
 * человека читается ЗАМЕТНО ниже синтетической (0.86 у `stick`): два живых
 * журнала 22.10.2026 дали 0.57 (кадр 360×640) и 0.68 (кадр 640×360), оба при
 * `vis: 1.00` и игроке лицом к камере. Прежний порог `front: 0.70` отвергал и
 * то, и другое — забег запирался на автопаузе `orientation` навсегда.
 *
 * Тот же урок измерен в `run-game`: «плечи к торсу 0.18–0.44 при пороге 0.45 и
 * физически верных 0.86». Два проекта, один вывод: геометрическая оценка этого
 * отношения завышена, и жить порог обязан по измерению.
 */
const ЖИВЫЕ_ФРОНТ = [0.57, 0.68] as const

/** Геометрия с заданным отношением плеч к торсу: остальное — нейтраль. */
const withRatio = (ratio: number): Geometry => ({ ...g({}), shoulderRatio: ratio })

test('ИЗМЕРЕННАЯ фронтальная стойка проходит присутствие', () => {
  for (const ratio of ЖИВЫЕ_ФРОНТ) {
    const st = trusting(0.5, withRatio(ratio).S)
    const r = presence(withRatio(ratio), 0, st, 'front')
    expect(r.ok, `отношение ${ratio} обязано читаться как фронт`).toBe(true)
  }
})

test('между фронтом и профилем остаётся мёртвая зона', () => {
  // Иначе профиль, прочитанный как фронт, зачёл бы позу, которой не было.
  expect(CONFIG.orientation.profile).toBeLessThan(CONFIG.orientation.front)
  const middle = (CONFIG.orientation.profile + CONFIG.orientation.front) / 2
  const st = trusting(0.5, withRatio(middle).S)
  expect(presence(withRatio(middle), 0, st, 'front').ok).toBe(false)
  expect(presence(withRatio(middle), 0, st, 'profile').ok).toBe(false)
})

test('g === null даёт why: none', () => {
  const st = trusting(0.5, 0.22)
  expect(presence(null, 0, st, 'front')).toEqual({ ok: false, why: 'none' })
})

test('нормальная стойка в центре кадра — присутствие подтверждено', () => {
  const st = newPresenceState()
  const gm = g({})
  expect(presence(gm, 0, st, 'front')).toEqual({ ok: true, gm })
})

// --- порядок причин --------------------------------------------------------

/**
 * Порядок проверяется ОЧИСТКОЙ ПО ОДНОЙ: кадр нарушает сразу всё, и каждый
 * следующий шаг снимает ровно одно нарушение. Если бы проверки шли в другом
 * порядке, на каждом шаге возвращалась бы не та причина. Наличие причины
 * по отдельности этого не ловит вовсе.
 */
test('порядок причин: lowvis → jump → scale → orientation → edge', () => {
  // Кадр-нарушитель: не видно (0.2 < 0.5), прыжок центра (0.1 против 0.5),
  // слишком близко (торс 0.5 > 0.45), профиль во фронтальном раунде, у края.
  const bad = { x: 0.1, torso: 0.5, orientation: 'profile' as const, visibility: 0.2 }

  expect(presence(g(bad), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'lowvis',
  })

  // 1. Видимость в норме — всплывает прыжок.
  expect(presence(g({ ...bad, visibility: 1 }), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'jump',
  })

  // 2. Доверенный центр и торс там же, где кадр — всплывает масштаб.
  expect(presence(g({ ...bad, visibility: 1 }), 0, trusting(0.1, 0.5), 'front')).toEqual({
    ok: false,
    why: 'scale',
  })

  // 3. Торс в полосе — всплывает ориентация.
  expect(
    presence(g({ ...bad, visibility: 1, torso: 0.22 }), 0, trusting(0.1, 0.22), 'front'),
  ).toEqual({ ok: false, why: 'orientation' })

  // 4. Ориентация та, которую ждёт поза — остаётся край кадра.
  expect(
    presence(
      g({ ...bad, visibility: 1, torso: 0.22, orientation: 'front' }),
      0,
      trusting(0.1, 0.22),
      'front',
    ),
  ).toEqual({ ok: false, why: 'edge' })

  // 5. Снято и это — присутствие подтверждено.
  expect(
    presence(
      g({ ...bad, visibility: 1, torso: 0.22, orientation: 'front', x: 0.5 }),
      0,
      trusting(0.5, 0.22),
      'front',
    ),
  ).toMatchObject({ ok: true })
})

test('каждая причина очистки срабатывает и в одиночку — очистка не вакуумна', () => {
  expect(presence(g({ visibility: 0.2 }), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'lowvis',
  })
  expect(presence(g({ x: 0.1 }), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'jump',
  })
  expect(presence(g({ torso: 0.5 }), 0, trusting(0.5, 0.5), 'front')).toEqual({
    ok: false,
    why: 'scale',
  })
  expect(presence(g({ orientation: 'profile' }), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'orientation',
  })
  expect(presence(g({ x: 0.1 }), 0, trusting(0.1, 0.22), 'front')).toEqual({
    ok: false,
    why: 'edge',
  })
})

// --- jump: защита от второго человека в кадре ------------------------------

test('вошедший в кадр второй человек даёт jump — по скачку центра', () => {
  const st = trusting(0.5, 0.22)
  expect(presence(g({ x: 0.8 }), 0, st, 'front')).toEqual({ ok: false, why: 'jump' })
})

test('вошедший в кадр второй человек даёт jump — по росту торса втрое', () => {
  const st = trusting(0.5, 0.12)
  // Торс 0.4 — больше 3 × 0.12; центр на месте, значит сработал рост.
  expect(presence(g({ torso: 0.4 }), 0, st, 'front')).toEqual({ ok: false, why: 'jump' })
})

test('вошедший в кадр человек ДАЛЬШЕ от камеры даёт jump — по убыли торса втрое', () => {
  // Типичный случай: кто-то проходит по фону дальше ребёнка. Торс — треть
  // доверенного, центр сдвинут лишь на ~0.2 ширины кадра (меньше порога
  // прыжка 0.25) — то есть виновата именно убыль размера, а не скачок центра.
  const st = trusting(0.5, 0.3)
  expect(presence(g({ x: 0.3, torso: 0.3 / 3.5 }), 0, st, 'front')).toEqual({
    ok: false,
    why: 'jump',
  })
})

test('шаг игрока в сторону меньше порога — не подмена', () => {
  const st = trusting(0.5, 0.22)
  expect(presence(g({ x: 0.68 }), 0, st, 'front')).toMatchObject({ ok: true })
  expect(st.trustedCx).toBeCloseTo(0.68, 6)
})

test('сравнение идёт с последним доверенным торсом, не с предыдущим кадром', () => {
  const st = trusting(0.5, 0.22)

  // Первый чужой кадр далеко от доверенного центра — отказ.
  expect(presence(g({ x: 0.9 }), 0, st, 'front')).toEqual({ ok: false, why: 'jump' })
  // Второй отличается от ПЕРВОГО на 0.05 — с предыдущим кадром он прошёл бы.
  expect(presence(g({ x: 0.85 }), 33, st, 'front')).toEqual({ ok: false, why: 'jump' })
  // И третий: подмена, растянутая по кадрам, не отмывается.
  expect(presence(g({ x: 0.8 }), 66, st, 'front')).toEqual({ ok: false, why: 'jump' })

  // Доверенные значения не сдвинулись ни на один из отвергнутых кадров.
  expect(st.trustedCx).toBeCloseTo(0.5, 6)
  expect(st.trustedS).toBeCloseTo(0.22, 6)
})

test('доверенный торс не обновляется на кадрах с любым отказом, не только с jump', () => {
  const st = trusting(0.5, 0.22)
  for (const bad of [
    { visibility: 0.2 },
    { torso: 0.5 },
    { orientation: 'profile' as const },
    { x: 0.05 },
  ]) {
    presence(g(bad), 0, st, 'front')
    expect(st.trustedCx).toBeCloseTo(0.5, 6)
    expect(st.trustedS).toBeCloseTo(0.22, 6)
  }
})

test('первый кадр забега доверять нечему — jump не проверяется', () => {
  const st = newPresenceState()
  expect(presence(g({ x: 0.8, torso: 0.4 }), 0, st, 'front')).toMatchObject({ ok: true })
  expect(st.trustedCx).toBeCloseTo(0.8, 6)
  expect(st.trustedS).toBeCloseTo(0.4, 6)
})

test('доверие живёт только пока забег идёт: после паузы первый видимый кадр доверяется', () => {
  const short = trusting(0.5, 0.22)
  presence(null, 0, short, 'front')
  presence(null, 300, short, 'front')
  // Потеря короче паузы — доверие в силе, вернувшийся не там, где был, это jump.
  expect(presence(g({ x: 0.8 }), 330, short, 'front')).toEqual({ ok: false, why: 'jump' })

  const long = trusting(0.5, 0.22)
  presence(null, 0, long, 'front')
  presence(null, 800, long, 'front')
  // Потеря дольше паузы: судейства на паузе нет, и запирать забег навсегда нельзя.
  expect(presence(g({ x: 0.8 }), 830, long, 'front')).toMatchObject({ ok: true })
  expect(long.trustedCx).toBeCloseTo(0.8, 6)
})

// --- scale: нижняя граница по ширине плеч ----------------------------------

test('нижняя граница scale мерится шириной плеч — присед не роняет', () => {
  // Один и тот же торс в кадре, разная ширина плеч: фронтальная стойка годна,
  // профильная — нет. Граница по длине торса такого различить не могла бы, а
  // короткая проекция торса в приседе ею остановила бы забег.
  const squat = { torso: 0.1 }
  expect(presence(g(squat), 0, trusting(0.5, 0.1), 'front')).toMatchObject({ ok: true })
  expect(
    presence(g({ ...squat, orientation: 'profile' }), 0, trusting(0.5, 0.1), 'profile'),
  ).toEqual({ ok: false, why: 'scale' })
})

test('присед против доверенного торса СТОЯ — не jump: торс почти не меняется', () => {
  // trustedS = 0.22 (стойка), крадущийся торс 0.1 — ratio ≈ 0.4545, с явным
  // запасом от нижней границы jump (1/3 ≈ 0.333) и тем более от scale.
  const ratio = 0.1 / 0.22
  expect(ratio).toBeCloseTo(0.4545, 4)
  expect(ratio).toBeGreaterThan(1 / CONFIG.presence.jump.torsoGrowth)

  const st = trusting(0.5, 0.22)
  expect(presence(g({ torso: 0.1 }), 0, st, 'front')).toMatchObject({ ok: true })
})

test('слишком близко — по длине торса: присед её только укорачивает', () => {
  expect(presence(g({ torso: 0.44 }), 0, trusting(0.5, 0.44), 'front')).toMatchObject({ ok: true })
  expect(presence(g({ torso: 0.46 }), 0, trusting(0.5, 0.46), 'front')).toEqual({
    ok: false,
    why: 'scale',
  })
})

// --- ориентация — свойство позы --------------------------------------------

test('во фронтальном раунде боком — orientation', () => {
  expect(presence(g({ orientation: 'profile' }), 0, trusting(0.5, 0.22), 'front')).toEqual({
    ok: false,
    why: 'orientation',
  })
})

test('в профильном раунде боком — норма, фронтально — orientation', () => {
  expect(presence(g({ orientation: 'profile' }), 0, trusting(0.5, 0.22), 'profile')).toMatchObject(
    { ok: true },
  )
  expect(presence(g({ orientation: 'front' }), 0, trusting(0.5, 0.22), 'profile')).toEqual({
    ok: false,
    why: 'orientation',
  })
})

// --- edge ------------------------------------------------------------------

test('игрок у любого края кадра даёт edge', () => {
  expect(presence(g({ x: 0.1 }), 0, trusting(0.1, 0.22), 'front')).toEqual({
    ok: false,
    why: 'edge',
  })
  expect(presence(g({ x: 0.9 }), 0, trusting(0.9, 0.22), 'front')).toEqual({
    ok: false,
    why: 'edge',
  })
  expect(presence(g({ x: 0.2 }), 0, trusting(0.2, 0.22), 'front')).toMatchObject({ ok: true })
})

// --- пауза -----------------------------------------------------------------

test('отказ дольше 700 мс просит паузу, возврат через 500 мс', () => {
  const st = trusting(0.5, 0.22)

  presence(null, 1000, st, 'front')
  expect(pauseRequested(st, 1000)).toBe(false)
  presence(null, 1600, st, 'front')
  expect(pauseRequested(st, 1699)).toBe(false)
  expect(pauseRequested(st, 1700)).toBe(true)

  // Возврат отсчитывается от первого подтверждённого кадра, а не от конца отказа.
  presence(g({}), 2000, st, 'front')
  expect(pauseRequested(st, 2000)).toBe(false)
  expect(resumeReady(st, 2000)).toBe(false)
  presence(g({}), 2400, st, 'front')
  expect(resumeReady(st, 2499)).toBe(false)
  expect(resumeReady(st, 2500)).toBe(true)
})

test('один подтверждённый кадр обнуляет отсчёт отказа, один отказ — отсчёт возврата', () => {
  const st = trusting(0.5, 0.22)

  presence(null, 0, st, 'front')
  presence(g({}), 600, st, 'front')
  presence(null, 650, st, 'front')
  // Отказ начался заново на 650, а не на 0: до паузы ещё 700 мс.
  expect(pauseRequested(st, 1000)).toBe(false)
  expect(pauseRequested(st, 1350)).toBe(true)

  presence(g({}), 1400, st, 'front')
  presence(null, 1500, st, 'front')
  presence(g({}), 1600, st, 'front')
  // Отсчёт возврата начался на 1600, а не на 1400.
  expect(resumeReady(st, 2000)).toBe(false)
  expect(resumeReady(st, 2100)).toBe(true)
})

test('свежее состояние ни паузы не просит, ни возврата', () => {
  const st = newPresenceState()
  expect(pauseRequested(st, 10_000)).toBe(false)
  expect(resumeReady(st, 10_000)).toBe(false)
  expect(st.trustedS).toBeNull()
  expect(st.trustedCx).toBeNull()
})
