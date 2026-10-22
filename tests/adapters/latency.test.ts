/**
 * Замер задержки тракта звуковой петлёй и мотивы исходов.
 *
 * Корреляция — чистая функция, и проверяется она синтетическим чирпом,
 * сдвинутым на известное число миллисекунд, с шумом поверх. Это весь смысл
 * выбора чирпа вместо щелчка: порог громкости в жилой комнате ловит хлопок
 * двери, а корреляция — нет.
 *
 * WebAudio приходит зависимостью: `AudioContext` в node нет, а мотивы — мой
 * код, не чужой синтезатор.
 *
 * Разбор: `docs/audio-and-latency.md`.
 */
import { describe, expect, test } from 'vitest'

import { createAudio } from '../../src/adapters/audio'
import { LATENCY, correlate, makeChirp, measureLatency } from '../../src/adapters/latency'

const SR = 8000

/** Детерминированный шум: случайный падал бы раз в сто прогонов. */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((x / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

/**
 * Запись, в которой чирп начинается через `delayMs`, под шумом амплитуды
 * `noiseAmp` относительно чирпа.
 */
function heardAt(chirp: Float32Array, delayMs: number, sr: number, noiseAmp = 0, tailMs = 200): Float32Array {
  const lead = Math.round((delayMs / 1000) * sr)
  const n = lead + chirp.length + Math.round((tailMs / 1000) * sr)
  const out = noise(n, noiseAmp, 7)
  for (let i = 0; i < chirp.length; i++) out[lead + i] += chirp[i]
  return out
}

describe('корреляция', () => {
  test('находит сдвиг чирпа с точностью до 2 мс', () => {
    const chirp = makeChirp(SR)
    for (const delay of [0, 37, 120, 250]) {
      const got = correlate(chirp, heardAt(chirp, delay, SR), SR)
      expect(Math.abs(got - delay)).toBeLessThanOrEqual(2)
    }
  })

  test('устойчива к шуму ВДВОЕ громче полезного сигнала', () => {
    // Жилая комната: телевизор, второй ребёнок, улица за окном. Порог
    // громкости здесь поймал бы что угодно, кроме чирпа.
    const chirp = makeChirp(SR)
    const got = correlate(chirp, heardAt(chirp, 250, SR, 2), SR)
    expect(Math.abs(got - 250)).toBeLessThanOrEqual(2)
  })

  test('тишина в ответ — отказ, а не случайное число', () => {
    // Случайное число здесь хуже отказа: оно уехало бы в настройку сдвига и
    // сломало бы судейство молча.
    const chirp = makeChirp(SR)
    const silence = new Float32Array(SR)
    expect(Number.isFinite(correlate(chirp, silence, SR))).toBe(false)
  })

  test('один шум без чирпа — тоже отказ', () => {
    const chirp = makeChirp(SR)
    expect(Number.isFinite(correlate(chirp, noise(SR, 1, 3), SR))).toBe(false)
  })

  test('запись короче чирпа — отказ, а не выход за массив', () => {
    const chirp = makeChirp(SR)
    expect(Number.isFinite(correlate(chirp, new Float32Array(10), SR))).toBe(false)
    expect(Number.isFinite(correlate(chirp, new Float32Array(0), SR))).toBe(false)
  })

  test('тишина отличается от чирпа НЕ громкостью: громкий шум не проходит', () => {
    // Сторож, который валит только тишину, пропустил бы хлопок двери.
    const chirp = makeChirp(SR)
    const loud = noise(SR * 2, 5, 11)
    expect(Number.isFinite(correlate(chirp, loud, SR))).toBe(false)
  })
})

describe('чирп', () => {
  test('это свип, а не нота: частота растёт', () => {
    // Нота коррелирует сама с собой на каждом периоде — сдвиг из такой
    // корреляции неоднозначен.
    const chirp = makeChirp(SR)
    const zero = (from: number, to: number): number => {
      let n = 0
      for (let i = from + 1; i < to; i++) if (chirp[i - 1] <= 0 && chirp[i] > 0) n++
      return n
    }
    const half = Math.floor(chirp.length / 2)
    expect(zero(half, chirp.length)).toBeGreaterThan(zero(0, half))
  })

  test('длина чирпа и есть объявленная', () => {
    expect(makeChirp(SR).length).toBe(Math.round((LATENCY.chirpMs / 1000) * SR))
  })

  test('края сведены к нулю: щелчок на старте слышен и портит корреляцию', () => {
    const chirp = makeChirp(SR)
    expect(Math.abs(chirp[0])).toBeLessThan(0.05)
    expect(Math.abs(chirp[chirp.length - 1])).toBeLessThan(0.05)
  })
})

describe('серия выстрелов', () => {
  /** Петля, отдающая заданные задержки по порядку. */
  const loop = (delays: Array<number | null>, sr = SR) => {
    let i = 0
    return {
      sampleRate: sr,
      shoot: async (chirp: Float32Array): Promise<Float32Array> => {
        const d = delays[i++]
        return d === null ? new Float32Array(sr) : heardAt(chirp, d, sr, 0.3)
      },
    }
  }

  test('берёт МЕДИАНУ серии, не среднее', async () => {
    // Один выброс — обычное дело: телевизор на миг ушёл в буферизацию.
    // Среднее такой выброс втягивает, медиана нет.
    const r = await measureLatency({ shots: 5, loopback: loop([100, 102, 101, 103, 900]) })
    expect(r.medianMs).toBeGreaterThanOrEqual(99)
    expect(r.medianMs).toBeLessThanOrEqual(104)
  })

  test('отдаёт разброс серии: большой разброс сам по себе диагноз', async () => {
    const tight = await measureLatency({ shots: 5, loopback: loop([100, 101, 100, 101, 100]) })
    const loose = await measureLatency({ shots: 5, loopback: loop([100, 180, 100, 190, 100]) })
    expect(loose.spreadMs).toBeGreaterThan(tight.spreadMs)
  })

  test('все выстрелы серии видны в ответе, а не только итог', async () => {
    // Иначе разбор журнала не отличит «тракт ровный» от «медиана совпала».
    const r = await measureLatency({ shots: 4, loopback: loop([100, 101, 102, 103]) })
    expect(r.shots.length).toBe(4)
  })

  test('один выстрел — это два: медиана по одному не медиана', async () => {
    // `shots: 1` раньше отказывал ВСЕГДА, даже на идеальной петле: потолок
    // «услышать не меньше двух» был выше числа выстрелов.
    const r = await measureLatency({ shots: 1, loopback: loop([100, 100]) })
    expect(r.shots.length).toBe(2)
    expect(r.medianMs).toBe(100)
  })

  test('тишина в ОТВЕТ НА ВСЁ — отказ, а не случайное число', async () => {
    await expect(measureLatency({ shots: 4, loopback: loop([null, null, null, null]) })).rejects.toThrow()
  })

  test('часть выстрелов пропала — считаем по уцелевшим', async () => {
    // Один проглоченный выстрел не повод гнать ребёнка мерить заново.
    const r = await measureLatency({ shots: 5, loopback: loop([100, null, 101, 100, null]) })
    expect(r.shots.length).toBe(3)
    expect(r.medianMs).toBeGreaterThanOrEqual(99)
    expect(r.medianMs).toBeLessThanOrEqual(102)
  })

  test('уцелело слишком мало — отказ: медиана по одному это не медиана', async () => {
    await expect(
      measureLatency({ shots: 6, loopback: loop([100, null, null, null, null, null]) }),
    ).rejects.toThrow()
  })

  test('выстрелы разбежались — отказ: медиана не опирается ни на что', async () => {
    /*
     * Случай из живого замера 22.10.2026: услышано 5 выстрелов из 12, медиана
     * 1166 мс, разброс 544 мс — и `ok: true`. Такое число уехало бы в
     * настройку сдвига как замер, а это не замер: при разбежавшейся серии
     * медиана — просто середина мусора.
     *
     * Отказ считается по СОГЛАСИЮ выстрелов, а не по полному разбросу:
     * один выброс при четырёх сошедшихся — норма (тест про медиану выше), и
     * полный разброс забраковал бы именно его.
     */
    await expect(
      measureLatency({ shots: 5, loopback: loop([700, 1166, 300, 1300, 900]) }),
    ).rejects.toThrow(/разброс|согл/i)
  })

  test('один выброс при сошедшейся серии замер НЕ отменяет', async () => {
    // Телевизор на миг ушёл в буферизацию — это не повод гнать ребёнка мерить
    // заново: четыре выстрела из пяти легли рядом.
    const r = await measureLatency({ shots: 5, loopback: loop([100, 102, 101, 103, 900]) })
    expect(r.medianMs).toBeLessThanOrEqual(104)
  })

  test('записанный звук НИГДЕ не остаётся в ответе', async () => {
    // Игра про ребёнка в его комнате: запись из неё не уходит, и в
    // возвращаемом объекте ей тоже не место — оттуда она попала бы в журнал.
    const r = await measureLatency({ shots: 3, loopback: loop([100, 100, 100]) })
    const json = JSON.stringify(r)
    expect(json).not.toContain('Float32Array')
    expect(Object.keys(r).sort()).toEqual(['medianMs', 'shots', 'spreadMs'])
  })
})

describe('мотивы исходов', () => {
  /** Поддельный WebAudio: записывает, какие частоты и когда зазвучали. */
  function fakeCtx(): { ctx: AudioContext; notes: Array<{ f: number; t: number; gain: number }> } {
    const notes: Array<{ f: number; t: number; gain: number }> = []
    let pendingGain = 1
    const ctx = {
      currentTime: 0,
      sampleRate: 48000,
      state: 'running',
      destination: {},
      resume: async () => {},
      createGain: () => ({
        connect: () => {},
        gain: {
          value: 1,
          setValueAtTime: (v: number) => {
            pendingGain = v
          },
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
      }),
      createOscillator: () => {
        const self = {
          type: 'sine',
          frequency: { value: 0, setValueAtTime: () => {} },
          connect: () => {},
          start: (t: number) => {
            notes.push({ f: self.frequency.value, t, gain: pendingGain })
          },
          stop: () => {},
        }
        return self
      },
    }
    return { ctx: ctx as unknown as AudioContext, notes }
  }

  test('успех — три ноты ВВЕРХ, провал — три ноты ВНИЗ', () => {
    // Ребёнок 7 лет различает направление мотива раньше, чем читает счёт.
    const up = fakeCtx()
    createAudio({ ctx: up.ctx }).hit()
    const down = fakeCtx()
    createAudio({ ctx: down.ctx }).miss()

    expect(up.notes.length).toBe(3)
    expect(down.notes.length).toBe(3)
    expect(up.notes[2].f).toBeGreaterThan(up.notes[0].f)
    expect(down.notes[2].f).toBeLessThan(down.notes[0].f)
  })

  test('подсказка превью — одна нота, несудимый раунд — свой короткий', () => {
    const cue = fakeCtx()
    createAudio({ ctx: cue.ctx }).cue()
    expect(cue.notes.length).toBe(1)

    const neutral = fakeCtx()
    createAudio({ ctx: neutral.ctx }).neutral()
    expect(neutral.notes.length).toBeGreaterThan(0)
  })

  test('несудимый раунд звучит НЕ как провал', () => {
    // Тот же инвариант, что у цвета стены: ребёнок не должен услышать провал
    // за раунд, который игра не судила.
    const miss = fakeCtx()
    createAudio({ ctx: miss.ctx }).miss()
    const skip = fakeCtx()
    createAudio({ ctx: skip.ctx }).neutral()
    expect(skip.notes.map((n) => n.f)).not.toEqual(miss.notes.map((n) => n.f))
  })

  test('громкость зажата в полосу: мусор снаружи не рвёт звук', () => {
    const { ctx, notes } = fakeCtx()
    const a = createAudio({ ctx })
    a.setVolume(50)
    a.cue()
    expect(notes[0].gain).toBeLessThanOrEqual(1)
    expect(notes[0].gain).toBeGreaterThan(0)

    const b = fakeCtx()
    const bb = createAudio({ ctx: b.ctx })
    bb.setVolume(-3)
    bb.cue()
    expect(b.notes[0].gain).toBeGreaterThanOrEqual(0)
  })

  test('нет WebAudio — игра играется молча, а не падает', () => {
    // Телефон на штативе: беззвучная игра хуже звучащей, но несравнимо лучше
    // упавшей.
    const a = createAudio({ ctx: null })
    expect(() => {
      a.cue()
      a.hit()
      a.miss()
      a.neutral()
      a.setVolume(0.5)
    }).not.toThrow()
  })
})
