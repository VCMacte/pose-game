/** Одна точка скелета MediaPipe: нормализованные координаты плюс видимость. */
export type Landmark = { x: number; y: number; z: number; visibility: number }

/** 33 точки × 4 поля (x, y, z, visibility), плоско — выход MediaPipe без копирования. */
export type Landmarks = Float32Array

/** Один кадр видео: отметка времени и скелет, либо `null`, если поза не распознана. */
export type Frame = { t: number; lm: Landmarks | null }

export type Orientation = 'front' | 'profile'

export type ShoulderState = 'up' | 'diag-up' | 'side' | 'down' | 'front'
export type ElbowState = 'straight' | 'bent'
export type ForearmState = 'up' | 'down' | 'in' | 'front'
export type HandsState = 'no' | 'over-head' | 'in-front'
export type LegsState = 'together' | 'shoulder' | 'wide' | 'max'
export type SupportState = 'both' | 'left' | 'right'
export type LeanState = 'upright' | 'lean-left' | 'lean-right' | 'horizontal'

/** Значение оси, либо `'unknown'`, если измерить её на кадре не удалось. */
export type AxisValue<T> = T | 'unknown'

/**
 * Все девять осей плюс присед/колени/«Цифра 4», которых в таблице осей нет
 * (см. docs/poses-and-figure.md «Девять осей» и «Пороги»).
 *
 * Фронтальные позы описывают левое/правое плечо-локоть-предплечье;
 * профильные — ближнюю/дальнюю конечность, потому что в профиль модель
 * путает левое с правым и судить их нельзя.
 */
export type AxisRequirements = {
  orientation: Orientation
  leftShoulder: ShoulderState
  rightShoulder: ShoulderState
  leftElbow: ElbowState
  rightElbow: ElbowState
  leftForearm: ForearmState
  rightForearm: ForearmState
  nearShoulder: ShoulderState
  farShoulder: ShoulderState
  nearElbow: ElbowState
  farElbow: ElbowState
  nearForearm: ForearmState
  farForearm: ForearmState
  hands: HandsState
  legs: LegsState
  support: SupportState
  lean: LeanState
  crouch: 'no' | 'yes'
  knees: 'straight' | 'bent'
  footAtKnee: boolean
}

export type PoseTag = 'crouch' | 'lean' | 'asymmetric' | 'profile' | 'one-leg'

/** Описание одной позы: какие оси она требует судить, остальные не проверяются. */
export type PoseSpec = {
  id: string
  name: string
  tier: 1 | 2 | 3
  orientation: Orientation
  mirror: boolean
  requires: Partial<AxisRequirements>
  tags: PoseTag[]
}

/** Снимок нейтральной стойки ребёнка, снятый в начале забега. */
export type Calibration = {
  S0: number
  shoulderWidth: number
  neutralX: number
  neutralShoulderY: number
  neutralHipY: number
  aspect: number
  at: number
}
