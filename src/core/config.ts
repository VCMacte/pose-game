/**
 * Единственное место, где живут числовые пороги игры.
 * Источник — docs/poses-and-figure.md «Пороги» и docs/judging.md.
 *
 * Это стартовые числа, подобранные из геометрии, а не измеренные —
 * они обязаны быть откалиброваны по записанным сессиям.
 * Все пространственные величины — в долях длины торса `S`, углы — в градусах.
 */
export const CONFIG = Object.freeze({
  shoulder: Object.freeze({
    /** Допуск вокруг опорных углов up/diag-up/side/down (0°/45°/90°/180°). */
    tolerance: 30,
    /** Порог для `front`: отклонение кисти и локтя от средней линии корпуса. */
    front: 0.35,
  }),
  elbow: Object.freeze({
    straightMin: 150,
    bentMin: 70,
    bentMax: 115,
  }),
  knee: Object.freeze({
    /** Колено `straight`: угол бедро–колено–стопа больше. */
    straightMin: 150,
    /** Колено голосует за присед и считается `bent` при угле меньше. */
    crouchVoteMax: 140,
  }),
  forearm: Object.freeze({
    /** Допуск вокруг опорных углов up/down/in/front. */
    tolerance: 35,
  }),
  hands: Object.freeze({
    overHead: 0.4,
    inFront: 0.4,
  }),
  legs: Object.freeze({
    together: 0.35,
    shoulderMin: 0.45,
    shoulderMax: 0.75,
    wideMin: 0.85,
    wideMax: 1.3,
    max: 1.4,
  }),
  support: Object.freeze({
    /** Опора на одной ноге: разница высот колен. */
    kneeHeightDiff: 0.35,
  }),
  footAtKnee: Object.freeze({
    /** «Цифра 4»: расстояние стопа–колено опорной ноги. */
    distance: 0.45,
  }),
  lean: Object.freeze({
    tolerance: 20,
    horizontal: 60,
  }),
  crouch: Object.freeze({
    /** Голосование 2 из 3. */
    votesRequired: 2,
    votesTotal: 3,
    /** Просадка плеч и бёдер против нейтральной стойки, в долях `S0`. */
    drop: 0.25,
    /** Присед отвергается, если торс вырос больше, чем во столько раз. */
    torsoGrowth: 1.05,
  }),
  visibility: Object.freeze({
    /**
     * Ниже этой уверенности точка считается достроенной по модели тела, а не
     * увиденной: ось, в которой она участвует, даёт «не знаю», а не промах.
     */
    min: 0.5,
  }),
  orientation: Object.freeze({
    front: 0.70,
    profile: 0.45,
  }),
  judge: Object.freeze({
    ratio: 0.60,
    minValid: 4,
    skipBelow: 3,
    windowMs: 600,
  }),
  score: Object.freeze({
    hit: 3,
    miss: -2,
    /** Сумма упирается в ноль и ниже не уходит. */
    floor: 0,
  }),
  run: Object.freeze({
    durationsSec: [60, 90, 120] as const,
    defaultDurationSec: 90,
  }),
  strictness: Object.freeze({
    soft: 1.3,
    normal: 1.0,
    strict: 0.75,
  }),
} as const)

/**
 * Множитель, которым настройка «строгость» масштабирует допуски.
 *
 * Масштабируются полуширины полос вокруг опорных значений: углы плеча,
 * предплечья, локтя и колена `straight`, полосы разноса ног, расстояния кистей
 * и стопы у колена. НЕ масштабируются пороги-доказательства: ориентация (она
 * решает годность кадра, а не попадание), разница высот колен у опоры,
 * просадки и голос колена у приседа, `max` у ног и `horizontal` у наклона.
 * Иначе мягкий допуск налезал бы на соседнюю полосу и превращал уверенные
 * кадры в «не знаю».
 */
export function strictness(level: 'soft' | 'normal' | 'strict'): number {
  return CONFIG.strictness[level]
}
