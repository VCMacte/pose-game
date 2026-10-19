import type { AxisRequirements, Orientation, PoseSpec, PoseTag } from './types'

/**
 * Набор поз: 13 названий, 18 различимых вырезов.
 *
 * Источник — docs/poses-and-figure.md «Набор: 13 названий, 18 вырезов». Из этих
 * данных строится и превью, и вырез в стене, и приговор, поэтому они одни:
 * второго описания позы в игре нет.
 *
 * Правила, на которых стоит весь набор:
 *
 * - **Различимость.** Две позы одной ориентации обязаны расходиться минимум
 *   одним ЦЕЛЫМ состоянием оси, а не его оттенком: ребёнок узнаёт позу за две
 *   секунды, вырез читается с другого конца комнаты, а судейство на 11 Гц
 *   честно. Проверяется тестом по всем парам.
 * - **Ориентация не живёт в `requires`.** Её владелец — `PoseSpec.orientation`:
 *   кадр не с той ориентацией НЕВАЛИДЕН (причина отказа присутствия), а не
 *   промахнулся. Два пути к одному факту — самый частый дефект, поэтому путь
 *   здесь один.
 * - **Профильные позы описываются только `near*`/`far*`,** фронтальные — только
 *   `left*`/`right*`. В профиль модель путает, какая сторона обращена к камере,
 *   и требовать от неё левое с правым значило бы судить монетку.
 * - **Зеркало — отдельная поза,** полученная перестановкой левого и правого.
 *   Зеркал ровно пять, и все они фронтальные: ближняя и дальняя сторона
 *   отсчитываются ОТ КАМЕРЫ, а угол конечности — в сторону взгляда, поэтому
 *   профильная поза, повёрнутая в другую сторону, даёт те же показания осей.
 *   Отдельный вырез с теми же требованиями судейство не отличало бы от
 *   исходного — ребёнок, повернувшийся не в ту сторону, получал бы попадание
 *   при силуэте, в вырез не входящем.
 * - **`tags` согласны с `requires`.** По тегам работают тумблеры словаря в
 *   настройках: тег, расходящийся с требованием, означает, что выключенная
 *   родителем категория всё равно выпадет ребёнку. Проверяется тестом.
 */

type Requires = Partial<AxisRequirements>

/** Запись набора до разворачивания зеркал. */
type Entry = {
  id: string
  name: string
  tier: 1 | 2 | 3
  /** Фронт, если не сказано иное. */
  orientation?: Orientation
  /** Есть зеркальный вариант — отдельная поза с перестановкой сторон. */
  mirrored?: boolean
  requires: Requires
  tags: PoseTag[]
}

/**
 * Стоя на двух ногах, прямо и не в приседе. Выписано у каждой такой позы, а не
 * подразумевается: ось, которую поза не требует, судейство не проверяет вовсе,
 * и присевший ребёнок иначе получал бы «Звезду» зачтённой.
 */
const STANDING = {
  support: 'both',
  lean: 'upright',
  crouch: 'no',
  knees: 'straight',
} as const satisfies Requires

const ENTRIES: Entry[] = [
  // --- ступень 1: фронтальные симметричные на двух ногах -------------------
  {
    id: 'star',
    name: 'Звезда',
    tier: 1,
    requires: {
      ...STANDING,
      legs: 'max',
      leftShoulder: 'diag-up',
      rightShoulder: 'diag-up',
      leftElbow: 'straight',
      rightElbow: 'straight',
    },
    tags: [],
  },
  {
    id: 'tee',
    name: 'Буква Т',
    tier: 1,
    requires: {
      ...STANDING,
      legs: 'together',
      leftShoulder: 'side',
      rightShoulder: 'side',
      leftElbow: 'straight',
      rightElbow: 'straight',
    },
    tags: [],
  },
  {
    id: 'rocket',
    name: 'Космическая ракета',
    tier: 1,
    requires: {
      ...STANDING,
      legs: 'together',
      leftShoulder: 'up',
      rightShoulder: 'up',
      leftElbow: 'straight',
      rightElbow: 'straight',
      hands: 'over-head',
    },
    tags: [],
  },

  // --- ступень 2: + наклон корпуса, + асимметричные руки -------------------
  {
    id: 'tower',
    name: 'Наклонная башня',
    tier: 2,
    mirrored: true,
    requires: {
      ...STANDING,
      lean: 'lean-left',
      legs: 'together',
      leftShoulder: 'down',
      rightShoulder: 'down',
      leftElbow: 'straight',
      rightElbow: 'straight',
    },
    tags: ['lean'],
  },
  {
    id: 'robot',
    name: 'Плоский Робот',
    tier: 2,
    mirrored: true,
    requires: {
      ...STANDING,
      legs: 'shoulder',
      leftShoulder: 'side',
      rightShoulder: 'side',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'up',
      rightForearm: 'down',
    },
    tags: ['asymmetric'],
  },
  {
    id: 'rockstar',
    name: 'Рок-звезда',
    tier: 2,
    mirrored: true,
    requires: {
      ...STANDING,
      legs: 'wide',
      leftShoulder: 'up',
      leftElbow: 'straight',
      rightShoulder: 'down',
      rightElbow: 'bent',
      rightForearm: 'in',
    },
    tags: ['asymmetric'],
  },

  // --- ступень 3: + присед, + опора на одной ноге, + профиль ---------------
  {
    id: 'boxer',
    name: 'Боксёр на ринге',
    tier: 3,
    requires: {
      ...STANDING,
      legs: 'shoulder',
      leftShoulder: 'front',
      rightShoulder: 'front',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'up',
      rightForearm: 'up',
    },
    tags: [],
  },
  {
    id: 'barrier',
    name: 'Низкий барьер',
    tier: 3,
    requires: {
      support: 'both',
      crouch: 'yes',
      knees: 'bent',
      legs: 'wide',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'in',
      rightForearm: 'in',
      hands: 'in-front',
    },
    tags: ['crouch'],
  },
  {
    id: 'crab',
    name: 'Краб на пляже',
    tier: 3,
    requires: {
      support: 'both',
      crouch: 'yes',
      knees: 'bent',
      legs: 'wide',
      leftShoulder: 'side',
      rightShoulder: 'side',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'up',
      rightForearm: 'up',
      // Разведённые «клешни» — отдельное требование, а не умолчание: именно оно
      // разводит «Краба» с «Низким барьером», у которого кисти сведены.
      hands: 'no',
    },
    tags: ['crouch'],
  },
  {
    id: 'four',
    name: 'Цифра 4',
    tier: 3,
    mirrored: true,
    requires: {
      support: 'left',
      footAtKnee: true,
      lean: 'upright',
      crouch: 'no',
      // Кисти у поясницы: плечо вниз, локоть согнут, предплечье к средней
      // линии. Само касание поясницы — глубина, и не судится.
      leftShoulder: 'down',
      rightShoulder: 'down',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'in',
      rightForearm: 'in',
    },
    tags: ['one-leg'],
  },
  {
    id: 'flamingo',
    name: 'Фламинго на болоте',
    tier: 3,
    mirrored: true,
    requires: {
      support: 'left',
      // Поднятое колено в сторону, а НЕ стопа у колена опорной ноги: ровно это
      // разводит «Фламинго» с «Цифрой 4», у которых одинаковая опора.
      footAtKnee: false,
      lean: 'upright',
      crouch: 'no',
      leftShoulder: 'side',
      rightShoulder: 'side',
      leftElbow: 'straight',
      rightElbow: 'straight',
    },
    tags: ['one-leg'],
  },

  // --- ступень 3, профильные ----------------------------------------------
  {
    id: 'egypt',
    name: 'Египетский рисунок',
    tier: 3,
    orientation: 'profile',
    requires: {
      support: 'both',
      lean: 'upright',
      crouch: 'no',
      knees: 'straight',
      legs: 'together',
      // Зигзаг: ближняя рука вынесена вперёд с предплечьем вверх, дальняя
      // опущена с предплечьем вперёд.
      nearShoulder: 'front',
      nearElbow: 'bent',
      nearForearm: 'up',
      farShoulder: 'down',
      farElbow: 'bent',
      farForearm: 'front',
    },
    tags: ['asymmetric', 'profile'],
  },
  {
    id: 'arrow',
    name: 'Острый угол',
    tier: 3,
    orientation: 'profile',
    requires: {
      support: 'both',
      crouch: 'no',
      knees: 'straight',
      legs: 'together',
      lean: 'horizontal',
      // Руки по линии спины: в профиль это угол 90° к вертикали, то есть `front`.
      nearShoulder: 'front',
      farShoulder: 'front',
      nearElbow: 'straight',
      farElbow: 'straight',
    },
    tags: ['lean', 'profile'],
  },
]

const SWAP_SUPPORT = { left: 'right', right: 'left', both: 'both' } as const
const SWAP_LEAN = {
  'lean-left': 'lean-right',
  'lean-right': 'lean-left',
  upright: 'upright',
  horizontal: 'horizontal',
} as const

/** Перестановка левого и правого. Трогает только то, у чего есть сторона. */
function mirrorRequires(r: Requires): Requires {
  const m: Requires = { ...r }
  const swap = <A extends keyof Requires, B extends keyof Requires>(a: A, b: B): void => {
    const left = r[a]
    const right = r[b]
    if (right === undefined) delete m[a]
    else m[a] = right as Requires[A]
    if (left === undefined) delete m[b]
    else m[b] = left as Requires[B]
  }
  swap('leftShoulder', 'rightShoulder')
  swap('leftElbow', 'rightElbow')
  swap('leftForearm', 'rightForearm')
  if (r.support !== undefined) m.support = SWAP_SUPPORT[r.support]
  if (r.lean !== undefined) m.lean = SWAP_LEAN[r.lean]
  return m
}

function spec(e: Entry, mirror: boolean): PoseSpec {
  return {
    id: mirror ? `${e.id}-mirror` : e.id,
    name: e.name,
    tier: e.tier,
    orientation: e.orientation ?? 'front',
    mirror,
    requires: mirror ? mirrorRequires(e.requires) : e.requires,
    // Своя копия: оригинал и зеркало иначе делили бы один массив тегов.
    tags: [...e.tags],
  }
}

/** Все вырезы набора: оригиналы и зеркала, в порядке возрастания ступени. */
export const POSES: readonly PoseSpec[] = ENTRIES.flatMap((e) =>
  e.mirrored === true ? [spec(e, false), spec(e, true)] : [spec(e, false)],
)

/**
 * Тумблеры словаря: категория, выставленная в `false`, вычитает из пула все
 * позы с этим тегом. Не названная категория включена.
 */
export type Toggles = Partial<Record<PoseTag, boolean>>

/**
 * Пул вырезов для забега: ступень N включает всё с ней и ниже, тумблеры
 * вычитают по тегам.
 *
 * Чистая функция без состояния «пул опустел»: тумблер, уронивший бы пул ниже
 * трёх поз, блокируется в интерфейсе (см. docs/menu-and-settings.md).
 */
export function cutouts(tier: 1 | 2 | 3, toggles: Toggles = {}): PoseSpec[] {
  return POSES.filter(
    (p) => p.tier <= tier && p.tags.every((tag) => toggles[tag] !== false),
  )
}
