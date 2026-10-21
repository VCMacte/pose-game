/**
 * Камера: лестница ограничений, отношение сторон кадра и оценка кадрирования.
 *
 * Живая камера здесь НЕ проверяется — `getUserMedia` в node нет. Но лестница
 * ограничений, порядок источников `aspect` и арифметика кадрирования — это
 * мой код, а не чужое железо, и он проверяется: `getUserMedia` приходит
 * зависимостью, и подменяется именно она, а не MediaPipe или драйвер.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */
import { describe, expect, test } from 'vitest'

import { CAMERA, CONSTRAINTS, frameAspect, framing, openCamera } from '../../src/adapters/camera'
import type { Calibration } from '../../src/core/types'

/** Дорожка-пустышка: `openCamera` трогает у неё только `getSettings`/`stop`. */
function fakeTrack(settings: MediaTrackSettings = {}): MediaStreamTrack {
  return {
    kind: 'video',
    getSettings: () => settings,
    stop: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaStreamTrack
}

function fakeStream(track: MediaStreamTrack = fakeTrack()): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
}

/** Калибровка с одним значимым здесь полем — длиной торса. */
function cal(S0: number): Calibration {
  return {
    S0,
    shoulderWidth: S0 * 0.86,
    neutralX: 0.5,
    neutralShoulderY: 0.3,
    neutralHipY: 0.6,
    aspect: 16 / 9,
    at: 0,
  }
}

describe('лестница ограничений', () => {
  test('перечислена в объявленном порядке', () => {
    // Сверху — то, что целевой телефон отдаёт дешевле всего; снизу `true`,
    // то есть «любая камера, какая есть»: отказаться от кадра совсем хуже,
    // чем взять кадр не того размера.
    expect(CONSTRAINTS.length).toBe(5)
    expect(CONSTRAINTS[0]).toMatchObject({ width: { ideal: 640 }, height: { ideal: 360 } })
    expect(CONSTRAINTS[1]).toMatchObject({ width: { ideal: 480 }, height: { ideal: 270 } })
    expect(CONSTRAINTS[2]).toEqual({ facingMode: { exact: 'user' } })
    expect(CONSTRAINTS[3]).toEqual({ facingMode: { ideal: 'user' } })
    expect(CONSTRAINTS[4]).toBe(true)
  })

  test('заморожена: подправить её на ходу нельзя', () => {
    expect(Object.isFrozen(CONSTRAINTS)).toBe(true)
  })

  /*
   * Камера игры — ВСЕГДА фронтальная. Прежде `facingMode` не задавался вовсе,
   * и выбор оставался за браузером: в первом живом прогоне он взял ту камеру,
   * какую счёл нужной, и записал в журнал `facing: "user"` — угадал. Полагаться
   * на угадывание нельзя, на другом телефоне оно даст заднюю камеру, а с ней
   * ребёнок не видит себя на телевизоре.
   */
  test('каждая ступень, кроме последней, просит ФРОНТАЛЬНУЮ камеру', () => {
    const steps = CONSTRAINTS.slice(0, -1) as ReadonlyArray<MediaTrackConstraints>
    expect(steps.length).toBeGreaterThan(0)
    for (const c of steps) expect(c.facingMode).toBeDefined()
  })

  test('верхние ступени требуют её ЖЁСТКО: браузеру не оставлено выбора', () => {
    const top = CONSTRAINTS[0] as MediaTrackConstraints
    expect(top.facingMode).toEqual({ exact: 'user' })
  })

  test('последняя ступень — всё равно любая камера: без кадра игры нет', () => {
    expect(CONSTRAINTS[CONSTRAINTS.length - 1]).toBe(true)
  })
})

describe('открытие камеры', () => {
  test('первая удавшаяся ступень и выигрывает', async () => {
    const asked: MediaStreamConstraints[] = []
    const cam = await openCamera({
      getUserMedia: async (c) => {
        asked.push(c)
        return fakeStream()
      },
    })
    expect(asked.length).toBe(1)
    expect(cam.stream.getVideoTracks().length).toBe(1)
  })

  test('отказ ступени ведёт к следующей, а не наружу', async () => {
    const asked: MediaStreamConstraints[] = []
    const cam = await openCamera({
      getUserMedia: async (c) => {
        asked.push(c)
        if (asked.length < 3) throw new Error('OverconstrainedError')
        return fakeStream()
      },
    })
    expect(asked.length).toBe(3)
    expect(cam.stream).toBeTruthy()
  })

  test('отказ ВСЕХ ступеней — одна ошибка наружу, а не тишина', async () => {
    // Молчащий отказ выглядел бы на штативе как «игра не видит ребёнка», и
    // отличить его от мёртвого распознавателя было бы нечем.
    const asked: MediaStreamConstraints[] = []
    await expect(
      openCamera({
        getUserMedia: async (c) => {
          asked.push(c)
          throw new Error('NotAllowedError')
        },
      }),
    ).rejects.toThrow()
    expect(asked.length).toBe(CONSTRAINTS.length)
  })

  test('молчащая ступень не держит игру: потолок ожидания свой у КАЖДОЙ', async () => {
    // Иначе первая же зависшая ступень съела бы весь потолок, и до `video:
    // true` — той, что открывается почти всегда, — очередь бы не дошла.
    const asked: MediaStreamConstraints[] = []
    const cam = await openCamera({
      timeoutMs: 20,
      getUserMedia: async (c) => {
        asked.push(c)
        if (asked.length === 1) return await new Promise<MediaStream>(() => {})
        return fakeStream()
      },
    })
    expect(asked.length).toBe(2)
    expect(cam.stream).toBeTruthy()
  })

  test('дорожка гасится, если ступень открылась уже после своего потолка', async () => {
    // Поздний поток — утечка: индикатор камеры горит, а игра этого потока уже
    // не держит и погасить его некому.
    let stopped = 0
    const track = {
      kind: 'video',
      getSettings: () => ({}),
      stop: () => {
        stopped++
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaStreamTrack

    const asked: MediaStreamConstraints[] = []
    const cam = await openCamera({
      timeoutMs: 20,
      getUserMedia: async (c) => {
        asked.push(c)
        if (asked.length === 1) {
          await new Promise((r) => setTimeout(r, 60))
          return fakeStream(track)
        }
        return fakeStream()
      },
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(cam.stream).toBeTruthy()
    expect(stopped).toBe(1)
  })

  test('`stop` гасит все дорожки и звать его можно повторно', async () => {
    let stopped = 0
    const track = {
      kind: 'video',
      getSettings: () => ({}),
      stop: () => {
        stopped++
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaStreamTrack

    const cam = await openCamera({ getUserMedia: async () => fakeStream(track) })
    cam.stop?.()
    cam.stop?.()
    expect(stopped).toBe(1)
  })

  test('нет самого `getUserMedia` — ошибка, а не падение на undefined', async () => {
    await expect(openCamera({ getUserMedia: null })).rejects.toThrow()
  })
})

describe('отношение сторон кадра', () => {
  test('источники берутся по убыванию достоверности', () => {
    // Размер кадра из воркера — то, что реально ушло в MediaPipe; `video`
    // врёт до первого кадра; `getSettings()` врёт про ПРОСИМОЕ, а не про
    // выданное. Поэтому порядок именно такой, и он проверяется подменой
    // каждого источника по очереди.
    const all = {
      frame: { w: 640, h: 360 },
      video: { videoWidth: 480, videoHeight: 270 },
      track: fakeTrack({ width: 320, height: 240 }),
    }
    expect(frameAspect(all)).toBeCloseTo(640 / 360)
    expect(frameAspect({ ...all, frame: null })).toBeCloseTo(480 / 270)
    expect(frameAspect({ ...all, frame: null, video: null })).toBeCloseTo(320 / 240)
  })

  test('null, пока ни один источник не ответил', () => {
    // Review Focus 2: отношение сторон приходит ПОЗЖЕ первых кадров.
    // Нормализация обязана отказаться считать, а не считать неверно и молча.
    expect(frameAspect({})).toBeNull()
    expect(frameAspect({ frame: null, video: null, track: null })).toBeNull()
  })

  test('нулевой и нечисловой размер — не ответ, а молчание источника', () => {
    // `videoWidth` равен нулю до первого кадра, и это ровно тот случай:
    // поделить на ноль значит выдать Infinity за отношение сторон.
    expect(frameAspect({ video: { videoWidth: 0, videoHeight: 0 } })).toBeNull()
    expect(frameAspect({ frame: { w: 640, h: 0 } })).toBeNull()
    expect(frameAspect({ frame: { w: Number.NaN, h: 360 } })).toBeNull()
    expect(frameAspect({ track: fakeTrack({}) })).toBeNull()
  })

  test('негодный источник уступает место следующему, а не гасит ответ', () => {
    // Воркер ещё не отдал ни кадра, а `video` уже отдал: ответ есть.
    expect(frameAspect({ frame: { w: 0, h: 0 }, video: { videoWidth: 640, videoHeight: 360 } })).toBeCloseTo(
      640 / 360,
    )
  })
})

describe('кадрирование', () => {
  /** Геометрия, у которой значим только размер торса. */
  const g = (S: number): Parameters<typeof framing>[0] => ({ S }) as Parameters<typeof framing>[0]

  test('заполнение — доля ВЫСОТЫ кадра, занятая игроком', () => {
    // Торс мерится в единицах `y`, то есть уже в долях высоты кадра; целый
    // человек — около `BODY_PER_TORSO` торсов.
    expect(framing(g(0.2), null).fill).toBeCloseTo(0.2 * CAMERA.bodyPerTorso)
  })

  test('без калибровки годность судится абсолютной полосой', () => {
    const tooFar = framing(g(CAMERA.fillMin / CAMERA.bodyPerTorso / 2), null)
    const tooClose = framing(g((CAMERA.fillMax / CAMERA.bodyPerTorso) * 2), null)
    const good = framing(g((CAMERA.fillMin + CAMERA.fillMax) / 2 / CAMERA.bodyPerTorso), null)
    expect(tooFar.ok).toBe(false)
    expect(tooClose.ok).toBe(false)
    expect(good.ok).toBe(true)
  })

  test('с калибровкой полоса берётся ВОКРУГ снятого торса', () => {
    // Смысл `ok` один и тот же в оба случая: «кадрирован так, как ждёт
    // судейство». Калиброванный игрок мог встать дальше, чем когда сдавал
    // калибровку, — и тогда `S0` и есть та правда, от которой мерить.
    const S0 = 0.2
    expect(framing(g(S0), cal(S0)).ok).toBe(true)
    expect(framing(g(S0 * (1 + CAMERA.calibratedTolerance / 2)), cal(S0)).ok).toBe(true)
    expect(framing(g(S0 * (1 + CAMERA.calibratedTolerance * 2)), cal(S0)).ok).toBe(false)
    expect(framing(g(S0 / (1 + CAMERA.calibratedTolerance * 2)), cal(S0)).ok).toBe(false)
  })

  test('калибровка с негодным `S0` не превращает полосу в деление на ноль', () => {
    // Падать здесь нельзя: экран калибровки зовёт это на каждом кадре.
    expect(framing(g(0.2), cal(0)).ok).toBe(framing(g(0.2), null).ok)
    expect(Number.isFinite(framing(g(0.2), cal(0)).fill)).toBe(true)
  })

  test('нет позы — нет и суждения о кадрировании', () => {
    // Иначе «игрок не в кадре» было бы не отличить от «игрок стоит плохо».
    expect(framing(null, null)).toEqual({ fill: 0, ok: false })
  })
})
