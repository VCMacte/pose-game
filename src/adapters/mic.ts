/**
 * Звуковая петля через микрофон: проиграть чирп и записать, что услышал
 * телефон из динамиков телевизора.
 *
 * Разбор замера и его ограничений — `docs/audio-and-latency.md`. Здесь только
 * обвязка над WebAudio: вся арифметика (чирп, корреляция, медиана серии) живёт
 * в `./latency.ts` и проверяется тестами без браузера.
 *
 * **Записанный звук нигде не сохраняется** — только корреляция в памяти. Это
 * обещано в тексте запроса разрешения и соблюдается здесь: массив отсчётов
 * живёт до конца выстрела и больше никуда не уходит.
 */

import { LATENCY } from './latency'
import type { Loopback } from './latency'
import { camFail } from './log/events'
import { write } from './log/store'

export type MicLoopback = Loopback & {
  /** Отпустить микрофон. Звать обязательно: иначе индикатор горит дальше. */
  close(): Promise<void>
}

type Ctor = { new (): AudioContext }

/**
 * Открывает петлю. Бросает, если микрофона нет или разрешение не дали —
 * служебный экран скажет об этом вслух, а не покажет случайное число.
 */
export async function micLoopback(): Promise<MicLoopback> {
  const Ctx = (globalThis as { AudioContext?: Ctor }).AudioContext
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices
  if (!Ctx || !md?.getUserMedia) throw new Error('WebAudio или микрофон недоступны')

  /*
   * ОБРАБОТКА ЗВУКА ВЫКЛЮЧЕНА, и это не предпочтение, а условие замера.
   * Подавление эха существует ровно для того, чтобы убрать из записи то, что
   * играет само устройство, — то есть именно наш чирп. С ним замер измерял бы
   * тишину. Автоусиление и шумодав туда же: они меняют форму сигнала, по
   * которой корреляция и работает.
   */
  const stream = await md.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })

  const ctx = new Ctx()
  if (ctx.state === 'suspended') await ctx.resume()

  const source = ctx.createMediaStreamSource(stream)

  /*
   * `createScriptProcessor` объявлен устаревшим, и всё же он здесь.
   * AudioWorklet требует отдельного файла модуля, который надо вендорить и
   * кэшировать офлайн, — ради ОДНОГО замера, который взрослый делает раз в
   * жизни устройства. Chrome для Android, единственный целевой браузер,
   * ScriptProcessor поддерживает; когда перестанет, замер отвалится громко, а
   * не тихо: `micLoopback` бросит, и служебный экран это скажет.
   */
  const node = ctx.createScriptProcessor(4096, 1, 1)
  let recording: number[] | null = null

  node.onaudioprocess = (e: AudioProcessingEvent): void => {
    if (!recording) return
    const input = e.inputBuffer.getChannelData(0)
    for (let i = 0; i < input.length; i++) recording.push(input[i])
  }

  source.connect(node)
  /*
   * `ScriptProcessor` не вызывает `onaudioprocess`, пока не подключён к
   * выходу. Подключается он через глушитель: без него запись с микрофона
   * уходила бы обратно в динамик и давала бы свист.
   */
  const mute = ctx.createGain()
  mute.gain.value = 0
  node.connect(mute)
  mute.connect(ctx.destination)

  /** Чирп в выход: один буфер, один проигрыш. */
  function play(chirp: Float32Array): void {
    const buf = ctx.createBuffer(1, chirp.length, ctx.sampleRate)
    // Копируется поэлементно, а не `copyToChannel`: тот требует буфер, за
    // которым стоит именно `ArrayBuffer`, а чирп приходит типизированным
    // массивом без такой гарантии.
    const channel = buf.getChannelData(0)
    for (let i = 0; i < chirp.length; i++) channel[i] = chirp[i]
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start()
  }

  return {
    sampleRate: ctx.sampleRate,

    shoot: async (chirp) => {
      recording = []
      play(chirp)
      await new Promise((r) => setTimeout(r, LATENCY.recordMs))
      const got = recording
      recording = null
      return new Float32Array(got)
    },

    close: async () => {
      try {
        node.onaudioprocess = null
        node.disconnect()
        source.disconnect()
        mute.disconnect()
        for (const t of stream.getTracks()) t.stop()
        await ctx.close()
      } catch (e) {
        // Не отпустилось — записать и идти дальше: игре это не мешает.
        write(camFail({ name: 'MicClose', message: e instanceof Error ? e.message : String(e) }))
      }
    },
  }
}
