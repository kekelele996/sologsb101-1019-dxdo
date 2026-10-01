/**
 * 装订间那本册子（BinderyVolume）——只归装订间写
 * 记装订方式、验收人、验收结论与逐叶点收；装订方式与验收结论以这本为准。
 * 修复师只读本册；验收合格即整册锁定只读，返修把册子交回修复师那本重开。
 * 归档前对账：叶号两边对不上 → 挂起（suspended）并把对不上的叶号列出等人定；
 * 核对失败后装订间只重试 / 改本册（点收），修复师那本不动。
 */

/** 装订形式：线装 / 蝴蝶装 / 包背装（装订方字段，与修复册拆开） */
export type BinderyBindingType = 'thread' | 'butterfly' | 'wrapped'

/**
 * 交接阶段（装订间那本的流转状态）：
 * - repair    在修复师手上（待装订 / 返修交回重开），修复册可写、本册只登记验收
 * - bound     装订完成、整册锁成只读，等待归档前对账
 * - suspended 对账发现同一叶两边对不上，先挂起这一册，叶号列出等人定
 * - archived  对账通过并归档，两本册都只读
 */
export type BinderyPhase = 'repair' | 'bound' | 'suspended' | 'archived'

export interface BinderyVolume {
  id: string
  /** 所属古籍 id（与修复册同 id 同书） */
  bookId: string
  /** 册次号，从 1 开始 */
  volumeNo: number
  /** 装订形式（装订方口径） */
  bindingType: BinderyBindingType
  /** 交接阶段 */
  phase: BinderyPhase
  /** 点收叶数：装订间逐叶点收的叶数（装订方对账口径） */
  checkedLeafCount: number
  /** 对账状态：未对账 / 通过 / 叶号不符挂起 / 待返修 */
  reconcileStatus: 'none' | 'passed' | 'leafMismatch' | 'needRework'
  /** 最近一次对账时间（未对账为 null） */
  reconciledAt: number | null
  /** 挂起时对不上的叶号（缺叶：修复有、装订无；多叶：装订有、修复无），等人定 */
  mismatchedLeafNos: { missing: number[]; extra: number[] }
  createdAt: number
  updatedAt: number
}

export type BinderyVolumeDraft = Omit<BinderyVolume, 'id' | 'createdAt' | 'updatedAt'>

export const BINDERY_PHASE_LABEL: Record<BinderyPhase, string> = {
  repair: '待装订 / 返修在修',
  bound: '已装订（待对账）',
  suspended: '对账挂起',
  archived: '已归档'
}

export const BINDERY_PHASE_COLOR: Record<BinderyPhase, string> = {
  repair: '#d68910',
  bound: '#3a6ea5',
  suspended: '#b03a2e',
  archived: '#1e8449'
}

export const BINDERY_PHASE_OPTIONS: ReadonlyArray<{ value: BinderyPhase; label: string }> = [
  { value: 'repair', label: '待装订 / 返修在修' },
  { value: 'bound', label: '已装订（待对账）' },
  { value: 'suspended', label: '对账挂起' },
  { value: 'archived', label: '已归档' }
]

export const RECONCILE_STATUS_LABEL: Record<BinderyVolume['reconcileStatus'], string> = {
  none: '未对账',
  passed: '对账通过',
  leafMismatch: '叶号不符，已挂起',
  needRework: '工序未完，待返修'
}

export const RECONCILE_STATUS_COLOR: Record<BinderyVolume['reconcileStatus'], string> = {
  none: '#8c8c8c',
  passed: '#1e8449',
  leafMismatch: '#b03a2e',
  needRework: '#d68910'
}

/** 装订完成（验收合格）→ 修复师那本与本册都整册锁成只读；归档同样只读 */
export function isBinderyLocked(phase: BinderyPhase): boolean {
  return phase === 'bound' || phase === 'archived' || phase === 'suspended'
}

/** 返修交回修复师重开：本册回到在修，修复册恢复可写 */
export function isReopened(phase: BinderyPhase): boolean {
  return phase === 'repair'
}

export function createEmptyBinderyVolumeDraft(
  bookId: string,
  volumeNo: number
): BinderyVolumeDraft {
  return {
    bookId,
    volumeNo,
    bindingType: 'thread',
    phase: 'repair',
    checkedLeafCount: 0,
    reconcileStatus: 'none',
    reconciledAt: null,
    mismatchedLeafNos: { missing: [], extra: [] }
  }
}
