/**
 * 逐叶点收（LeafCheck）数据模型——装订间那本上的逐叶记录
 * 装订间收册时逐叶点收：叶号 + 点收状态。仅装订间可写（修复师那本不动）。
 * 归档前对账时，同一叶号两边都点到才算对上；对不上的叶号把册子挂起等人定。
 */

/** 点收状态：已收到 / 缺叶 / 多叶（装订点收口径） */
export type LeafCheckState = 'accepted' | 'missing' | 'extra'

export interface LeafCheck {
  id: string
  /** 所属册次 id（与修复册同 id） */
  volumeId: string
  /** 叶号，从 1 开始；同一册同一叶号只点收一次（[volumeId+leafNo] 唯一） */
  leafNo: number
  /** 点收状态 */
  state: LeafCheckState
  /** 点收备注（缺 / 多原因，可空） */
  note: string
  createdAt: number
  updatedAt: number
}

export type LeafCheckDraft = Omit<LeafCheck, 'id' | 'createdAt' | 'updatedAt'>

export const LEAF_CHECK_STATE_LABEL: Record<LeafCheckState, string> = {
  accepted: '已收到',
  missing: '缺叶',
  extra: '多叶'
}

export const LEAF_CHECK_STATE_COLOR: Record<LeafCheckState, string> = {
  accepted: '#1e8449',
  missing: '#b03a2e',
  extra: '#d68910'
}

export const LEAF_CHECK_STATE_OPTIONS: ReadonlyArray<{ value: LeafCheckState; label: string }> = [
  { value: 'accepted', label: '已收到' },
  { value: 'missing', label: '缺叶' },
  { value: 'extra', label: '多叶' }
]

export function createEmptyLeafCheckDraft(volumeId: string, leafNo: number): LeafCheckDraft {
  return {
    volumeId,
    leafNo,
    state: 'accepted',
    note: ''
  }
}
