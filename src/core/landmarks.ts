import type { Landmark, Landmarks } from './types'

/**
 * Индексы 33 точек MediaPipe Pose — единственное место, где они перечислены.
 * Порядок задан моделью `pose_landmarker_lite.task` и менять его нельзя.
 */
export const LM = Object.freeze({
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const)

export type LandmarkName = keyof typeof LM

export const LANDMARK_COUNT = 33
/** Полей на точку в плоском массиве: x, y, z, visibility. */
export const LANDMARK_STRIDE = 4

/** Читает одну точку из плоского массива. Границы не проверяет — звать с индексом из `LM`. */
export function pointAt(lm: Landmarks, i: number): Landmark {
  const base = i * LANDMARK_STRIDE
  return {
    x: lm[base],
    y: lm[base + 1],
    z: lm[base + 2],
    visibility: lm[base + 3],
  }
}
