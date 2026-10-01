/**
 * 修复师那本册子（RepairVolume）——只归修复室写
 * 记逐叶破损、补纸选配、工序材料；叶数与工序进度以这本为准（归档对账的修复方口径）。
 * 装订间只读本册，不做任何写入；装订完成后整本随装订册锁定只读，返修交回时重新打开。
 */

/**
 * 修复状态：待修复 / 修复中 / 已修复（待交装订）
 * 注意：已装订 / 已归档由装订册（binderyVolume.phase）表达，修复册不关心。
 */
export type RepairState = 'pending' | 'repairing' | 'repaired'

export interface RepairVolume {
  id: string
  /** 所属古籍 id */
  bookId: string
  /** 册次号，从 1 开始（与装订册同 id、同册次号，是同一物理册的两本档案） */
  volumeNo: number
  /** 登记叶数：修复师申报的全册叶数（修复方对账口径） */
  leafCount: number
  /** 修复进度状态 */
  repairState: RepairState
  createdAt: number
  updatedAt: number
}

export type RepairVolumeDraft = Omit<RepairVolume, 'id' | 'createdAt' | 'updatedAt'>

export const REPAIR_STATE_LABEL: Record<RepairState, string> = {
  pending: '待修复',
  repairing: '修复中',
  repaired: '已修复（待装订）'
}

export const REPAIR_STATE_COLOR: Record<RepairState, string> = {
  pending: '#8c8c8c',
  repairing: '#d68910',
  repaired: '#1e8449'
}

export const REPAIR_STATE_OPTIONS: ReadonlyArray<{ value: RepairState; label: string }> = [
  { value: 'pending', label: '待修复' },
  { value: 'repairing', label: '修复中' },
  { value: 'repaired', label: '已修复（待装订）' }
]

export function createEmptyRepairVolumeDraft(bookId: string, volumeNo: number): RepairVolumeDraft {
  return {
    bookId,
    volumeNo,
    leafCount: 0,
    repairState: 'pending'
  }
}
