/**
 * 装订（Binding）数据模型 —— 装订间那本
 * 装订间单独记账：装订方式、完工日期、验收结论、验收人，以及装订间状态与叶号签收。
 * 验收合格触发两边对账，对账通过整册归档（修复师那本锁成只读）；返修则把册子交回修复师那本重开。
 */

/** 验收结论：合格 / 返修 */
export type BindingVerdict = 'pass' | 'rework';

/** 装订间状态：装订中 / 已归档 / 挂起（对账叶号不符，等人定） */
export type BindingStatus = 'open' | 'archived' | 'suspended';

/** 装订间叶号签收：按修复师那本的叶号逐叶核对是否收到 */
export interface BindingLeafCheck {
  /** 叶号 */
  leafNo: number;
  /** 是否收到并核对无误 */
  received: boolean;
}

export interface Binding {
  id: string;
  /** 所属册次 id */
  volumeId: string;
  /** 装订方式 */
  method: string;
  /** 完工日期 yyyy-MM-dd */
  finishDate: string;
  /** 验收结论；null 表示已登记尚未验收 */
  verdict: BindingVerdict | null;
  /** 验收人 */
  inspector: string;
  /** 装订间状态 */
  status: BindingStatus;
  /** 装订间叶号签收记录 */
  leafChecks: BindingLeafCheck[];
  createdAt: number;
  updatedAt: number;
}

export type BindingDraft = Omit<Binding, 'id' | 'createdAt' | 'updatedAt'>;

export const BINDING_VERDICT_LABEL: Record<BindingVerdict, string> = {
  pass: '合格',
  rework: '返修'
};

export const BINDING_VERDICT_COLOR: Record<BindingVerdict, string> = {
  pass: '#1e8449',
  rework: '#b03a2e'
};

export const BINDING_VERDICT_OPTIONS: ReadonlyArray<{ value: BindingVerdict; label: string }> = [
  { value: 'pass', label: '合格' },
  { value: 'rework', label: '返修' }
];

export const BINDING_STATUS_LABEL: Record<BindingStatus, string> = {
  open: '装订中',
  archived: '已归档',
  suspended: '已挂起'
};

export const BINDING_STATUS_COLOR: Record<BindingStatus, string> = {
  open: '#3a6ea5',
  archived: '#1e8449',
  suspended: '#b03a2e'
};

export const BINDING_METHOD_OPTIONS: readonly string[] = [
  '四眼线装',
  '六眼线装',
  '蝴蝶装复原',
  '包背装复原',
  '金镶玉装'
];

export function createEmptyBindingDraft(volumeId: string): BindingDraft {
  return {
    volumeId,
    method: '四眼线装',
    finishDate: new Date().toISOString().slice(0, 10),
    verdict: 'pass',
    inspector: '',
    status: 'open',
    leafChecks: []
  };
}
