/**
 * 册次共享层（Volume 视图模型）
 *
 * 历史上修复室与装订间合用一份册次档案（v1/v2 的 volumes 表），v3 起拆成两本、各写各的：
 * - 修复师那本：@/types/repairVolume（叶数、修复状态，leaves / papers / repairOrders 挂它）
 * - 装订间那本：@/types/binderyVolume（装订形式、交接阶段、验收结论，bindings / leafChecks 挂它）
 *
 * 本文件只保留两本共有的身份字段（id / bookId / volumeNo）与「合起来怎么看」的派生视图：
 * 旧的 VolumeState、锁定判定、标签、颜色全部由两本档案聚合得出，任何一方都不能单独改对方。
 */
import type { RepairState } from '@/types/repairVolume'
import {
  REPAIR_STATE_COLOR,
  REPAIR_STATE_LABEL
} from '@/types/repairVolume'
import type { BinderyBindingType, BinderyPhase } from '@/types/binderyVolume'
import {
  BINDERY_PHASE_COLOR,
  BINDERY_PHASE_LABEL,
  isBinderyLocked
} from '@/types/binderyVolume'

/** 两本册子的共有身份：同一 id 即同一物理册 */
export interface VolumeIdentity {
  id: string
  bookId: string
  volumeNo: number
}

/** 装订形式沿用三档，类型别名指向装订间那本（事实来源在装订侧） */
export type BindingType = BinderyBindingType

/**
 * 对外展示的册次状态（由两本聚合）：
 * 修复侧的待修复 / 修复中 / 已修复，加上装订侧的已装订 / 已归档 / 对账挂起。
 */
export type VolumeState = RepairState | 'bound' | 'archived' | 'suspended'

/** 两本聚合后的只读册次视图 */
export interface VolumeView extends VolumeIdentity {
  /** 叶数：看修复师那本 */
  leafCount: number
  repairState: RepairState
  /** 装订形式：看装订间那本 */
  bindingType: BindingType
  phase: BinderyPhase
  /** 聚合状态（装订阶段优先于修复状态） */
  state: VolumeState
}

export const BINDING_TYPE_LABEL: Record<BindingType, string> = {
  thread: '线装',
  butterfly: '蝴蝶装',
  wrapped: '包背装'
}

export const BINDING_TYPE_OPTIONS: ReadonlyArray<{ value: BindingType; label: string }> = [
  { value: 'thread', label: '线装' },
  { value: 'butterfly', label: '蝴蝶装' },
  { value: 'wrapped', label: '包背装' }
]

const EXTRA_STATE_LABEL: Record<'bound' | 'archived' | 'suspended', string> = {
  bound: '已装订',
  archived: '已归档',
  suspended: '对账挂起'
}

const EXTRA_STATE_COLOR: Record<'bound' | 'archived' | 'suspended', string> = {
  bound: BINDERY_PHASE_COLOR.bound,
  archived: BINDERY_PHASE_COLOR.archived,
  suspended: BINDERY_PHASE_COLOR.suspended
}

export const VOLUME_STATE_LABEL: Record<VolumeState, string> = {
  ...REPAIR_STATE_LABEL,
  ...EXTRA_STATE_LABEL
}

export const VOLUME_STATE_COLOR: Record<VolumeState, string> = {
  ...REPAIR_STATE_COLOR,
  ...EXTRA_STATE_COLOR
}

export const VOLUME_STATE_OPTIONS: ReadonlyArray<{ value: VolumeState; label: string }> = [
  { value: 'pending', label: VOLUME_STATE_LABEL.pending },
  { value: 'repairing', label: VOLUME_STATE_LABEL.repairing },
  { value: 'repaired', label: VOLUME_STATE_LABEL.repaired },
  { value: 'bound', label: VOLUME_STATE_LABEL.bound },
  { value: 'suspended', label: VOLUME_STATE_LABEL.suspended },
  { value: 'archived', label: VOLUME_STATE_LABEL.archived }
]

/**
 * 由装订间那本的交接阶段聚合整册状态：
 * 装订完成 / 挂起 / 已归档 → 对应锁定态；在修 → 修复册的修复状态。
 */
export function aggregateVolumeState(
  phase: BinderyPhase,
  repairState: RepairState
): VolumeState {
  if (phase === 'bound') return 'bound'
  if (phase === 'suspended') return 'suspended'
  if (phase === 'archived') return 'archived'
  return repairState
}

/**
 * 装订完成后整册锁成只读（修复师那本也一起锁）；返修交回（phase=repair）才重开。
 * 判定只认装订间那本，修复侧不允许自行解锁。
 */
export function isVolumeLocked(phase: BinderyPhase): boolean {
  return isBinderyLocked(phase)
}

/** 阶段徽标文案（装订间那本口径） */
export function binderyPhaseLabel(phase: BinderyPhase): string {
  return BINDERY_PHASE_LABEL[phase]
}

export function binderyPhaseColor(phase: BinderyPhase): string {
  return BINDERY_PHASE_COLOR[phase]
}
