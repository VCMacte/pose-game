import { kinematics, type KinematicDesc } from '../core/kinematics'
import { LANDMARK_COUNT, LANDMARK_STRIDE, LM, type LandmarkName } from '../core/landmarks'
import type { Landmarks, Pt } from '../core/types'

/**
 * Синтетический скелет: прямая кинематика из состояний осей в 33 точки
 * MediaPipe. Нужен тестам ядра — настоящих записей камеры в них нет.
 *
 * Это НЕ ядро: `src/fake/` снаружи границы слоёв, импортировать его из
 * `src/core/` нельзя. Направление импорта обратное и законное: стенд
 * импортирует ядро.
 *
 * **Форму тела этот файл не считает** — её считает `core/kinematics.ts` в долях
 * торса, и оттуда же её берёт рисованная фигура `core/figure.ts`. Здесь
 * остаётся проекция в кадр: деление `x` на отношение сторон, постановка тела
 * на пол, раскладка лица и ладоней по точкам MediaPipe и `visibility`. Копия
 * кинематики здесь уже была — дословный двойник `figure()` на ~120 строк, —
 * и её расхождение с рисунком дало бы ребёнку промах за верную позу.
 *
 * Единицы те же, в которых судит ядро (см. docs/camera-and-pose.md): доли
 * длины торса `S`, углы в градусах от вертикали. Точки сразу нормированы как у
 * MediaPipe — `x` по ширине кадра, `y` по высоте, — поэтому
 * `geometry(stick({ aspect }), aspect)` возвращает ровно те доли торса,
 * которые были заданы.
 *
 * Соглашения о форме (камера не зеркалит, углы растут наружу, near/far
 * разрешаются из `facing`, боковые состояния в профиль падают) живут в
 * doc-комментарии `kinematics()` — здесь они не повторяются, чтобы не
 * разъехаться с ним.
 *
 * Своё у этого файла одно: **тело стоит на полу** — опорная стопа всегда на
 * `ground`, поэтому присед сам опускает бёдра и плечи в кадре, не меняя длины
 * торса. И `z` всех точек — 0: игра плоская и глубину не судит.
 */
export type StickDesc = KinematicDesc & {
  /** Отношение сторон кадра, под которое нормируется `x`. */
  aspect: number
  /** Длина торса в долях высоты кадра — ею задаётся дистанция до камеры. */
  torso: number
  /** Середина бёдер по горизонтали, в долях ширины кадра. */
  x: number
  /** Пол: `y` опорной стопы в долях высоты кадра. */
  ground: number
  /**
   * Опускает всю фигуру в кадре на столько долей торса, не меняя кинематики
   * (опорная стопа уезжает с `ground` — это сознательное исключение из
   * «тело стоит на полу»). Так голоса приседа по высоте бёдер и плеч
   * отвязываются от угла в колене: присед судится голосованием 2 из 3, и
   * кадр ровно с одним голосом иначе не собрать. Отрицательное — поднимает.
   */
  bodyDrop?: number
  /** `visibility` всех точек. */
  visibility: number
  /** `visibility` отдельных точек — ею проверяются «не знаю» и уход стоп из кадра. */
  visibilityOf: Partial<Record<LandmarkName, number>>
}

/** Рамка кадра: всё, чего кинематика не знает. Форма берёт умолчания у неё. */
const DEFAULTS: Pick<
  StickDesc,
  'aspect' | 'torso' | 'x' | 'ground' | 'visibility' | 'visibilityOf'
> = {
  aspect: 16 / 9,
  torso: 0.22,
  x: 0.5,
  ground: 0.95,
  visibility: 1,
  visibilityOf: {},
}

export function stick(desc: Partial<StickDesc> = {}): Landmarks {
  const d = { ...DEFAULTS, ...desc }
  if (!Number.isFinite(d.aspect) || d.aspect <= 0) {
    throw new Error('stick: aspect обязан быть положительным числом')
  }

  const j = kinematics(desc)

  // --- кисти относительно головы ------------------------------------------
  // Проверка живёт здесь, а не в кинематике: она про линию ГЛАЗ, то есть про
  // раскладку лица по точкам MediaPipe, которая есть только у скелета.
  if (desc.hands === 'over-head') {
    const eyeY = j.head(0.45, 0, 0).y
    if (j.wrist.left.y > eyeY || j.wrist.right.y > eyeY) {
      throw new Error('stick: кисти over-head требуют поднятых рук — так они ниже головы')
    }
  }
  if (desc.hands === 'in-front') {
    for (const side of ['left', 'right'] as const) {
      if (j.wrist[side].y < j.shoulderMid.y || j.wrist[side].y > j.hipMid.y + 0.1) {
        throw new Error('stick: кисти in-front требуют рук на высоте груди')
      }
    }
  }

  // --- проекция в кадр ----------------------------------------------------
  const floor =
    j.support === 'both' ? Math.max(j.ankle.left.y, j.ankle.right.y) : j.ankle[j.support].y
  const y0 = d.ground - (floor - (d.bodyDrop ?? 0)) * d.torso
  const out = new Float32Array(LANDMARK_COUNT * LANDMARK_STRIDE)
  const put = (i: number, p: Pt): void => {
    const base = i * LANDMARK_STRIDE
    out[base] = d.x + (p.x * d.torso) / d.aspect
    out[base + 1] = y0 + p.y * d.torso
    out[base + 2] = 0
    out[base + 3] = d.visibility
  }

  put(LM.nose, j.head(0.37, 0, 0.22))
  put(LM.leftEyeInner, j.head(0.45, 0.03, 0.16))
  put(LM.leftEye, j.head(0.45, 0.06, 0.14))
  put(LM.leftEyeOuter, j.head(0.45, 0.09, 0.1))
  put(LM.rightEyeInner, j.head(0.45, -0.03, 0.16))
  put(LM.rightEye, j.head(0.45, -0.06, 0.14))
  put(LM.rightEyeOuter, j.head(0.45, -0.09, 0.1))
  put(LM.leftEar, j.head(0.43, 0.12, -0.05))
  put(LM.rightEar, j.head(0.43, -0.12, -0.05))
  put(LM.mouthLeft, j.head(0.3, 0.05, 0.18))
  put(LM.mouthRight, j.head(0.3, -0.05, 0.18))

  put(LM.leftShoulder, j.shoulder.left)
  put(LM.rightShoulder, j.shoulder.right)
  put(LM.leftElbow, j.elbow.left)
  put(LM.rightElbow, j.elbow.right)
  put(LM.leftWrist, j.wrist.left)
  put(LM.rightWrist, j.wrist.right)
  put(LM.leftPinky, j.palm.left[0])
  put(LM.rightPinky, j.palm.right[0])
  put(LM.leftIndex, j.palm.left[1])
  put(LM.rightIndex, j.palm.right[1])
  put(LM.leftThumb, j.palm.left[2])
  put(LM.rightThumb, j.palm.right[2])

  put(LM.leftHip, j.hip.left)
  put(LM.rightHip, j.hip.right)
  put(LM.leftKnee, j.knee.left)
  put(LM.rightKnee, j.knee.right)
  put(LM.leftAnkle, j.ankle.left)
  put(LM.rightAnkle, j.ankle.right)
  put(LM.leftHeel, j.heel.left)
  put(LM.rightHeel, j.heel.right)
  put(LM.leftFootIndex, j.toe.left)
  put(LM.rightFootIndex, j.toe.right)

  for (const [name, value] of Object.entries(d.visibilityOf)) {
    if (value !== undefined) out[LM[name as LandmarkName] * LANDMARK_STRIDE + 3] = value
  }

  return out
}
