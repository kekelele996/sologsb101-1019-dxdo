/**
 * 册次（Volume）数据模型 —— 修复师那本
 * 一部古籍下的册，只记修复侧的状态与叶数；装订方式、验收结论归装订间那本（Binding）。
 */

/** 册次修复状态：待修复 / 修复中 / 修复完成（待装订） */
export type VolumeState = 'pending' | 'repairing' | 'repaired';

/** 展示用状态：在修复状态基础上，装订间验收合格后整册锁为「已归档」 */
export type VolumeDisplayState = VolumeState | 'archived';

export interface Volume {
  id: string;
  /** 所属古籍 id */
  bookId: string;
  /** 册次号，从 1 开始 */
  volumeNo: number;
  /** 叶数 */
  leafCount: number;
  /** 修复侧当前状态 */
  state: VolumeState;
  createdAt: number;
  updatedAt: number;
}

export type VolumeDraft = Omit<Volume, 'id' | 'createdAt' | 'updatedAt'>;

export const VOLUME_STATE_LABEL: Record<VolumeDisplayState, string> = {
  pending: '待修复',
  repairing: '修复中',
  repaired: '修复完成',
  archived: '已归档'
};

export const VOLUME_STATE_COLOR: Record<VolumeDisplayState, string> = {
  pending: '#8c8c8c',
  repairing: '#d68910',
  repaired: '#3a6ea5',
  archived: '#1e8449'
};

export const VOLUME_STATE_OPTIONS: ReadonlyArray<{ value: VolumeState; label: string }> = [
  { value: 'pending', label: '待修复' },
  { value: 'repairing', label: '修复中' },
  { value: 'repaired', label: '修复完成' }
];

export const VOLUME_STATE_FLOW: readonly VolumeState[] = ['pending', 'repairing', 'repaired'];

export function nextVolumeState(state: VolumeState): VolumeState {
  const index = VOLUME_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= VOLUME_STATE_FLOW.length - 1) return state;
  return VOLUME_STATE_FLOW[index + 1] as VolumeState;
}

export function createEmptyVolumeDraft(bookId: string, volumeNo: number): VolumeDraft {
  return {
    bookId,
    volumeNo,
    leafCount: 0,
    state: 'pending'
  };
}
