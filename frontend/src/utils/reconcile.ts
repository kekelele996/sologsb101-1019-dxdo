/**
 * 归档前两边对账（纯函数）
 * - 叶数与工序进度看修复师那本（leaves / repairOrders）
 * - 装订方式与验收结论看装订间那本（binding）
 * - 同一叶号两边对不上（修复师有、装订间未签收，或反过来）则挂起，把叶号摆出来等人定
 * 对账过程只读修复师那本，不写。
 */
import type { Leaf } from '@/types/leaf'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'

export interface LeafMismatch {
  /** 修复师账上有、装订间未签收的叶号 */
  missingInBinding: number[]
  /** 装订间签收了、修复师账上没有的叶号 */
  missingInRestorer: number[]
}

export interface ReconcileResult {
  pass: boolean
  restorerPass: boolean
  bindingPass: boolean
  leafMatchPass: boolean
  restorerReasons: string[]
  bindingReasons: string[]
  restorerLeafNos: number[]
  bindingLeafNos: number[]
  mismatch: LeafMismatch
}

export interface ReconcileInput {
  volumeId: string
  /** 修复师那本该册的书叶 */
  leaves: Leaf[]
  /** 修复师那本该册的工序（按叶汇总） */
  orders: RepairOrder[]
  /** 装订间那本该册的装订记录 */
  binding: Binding | null | undefined
}

/** 按叶号去重并升序（接受书叶对象或叶号数组） */
export function distinctLeafNos(items: Array<{ leafNo: number }> | number[]): number[] {
  const nos = items.map((item) => (typeof item === 'number' ? item : item.leafNo))
  return Array.from(new Set(nos)).sort((a, b) => a - b)
}

/** 装订间实际签收（received）的叶号 */
export function receivedLeafNos(binding: Binding | null | undefined): number[] {
  if (!binding) return []
  return distinctLeafNos(binding.leafChecks.filter((check) => check.received).map((check) => check.leafNo))
}

export function reconcileVolume(input: ReconcileInput): ReconcileResult {
  const { leaves, orders, binding } = input
  const restorerLeafNos = distinctLeafNos(leaves)
  const bindingLeafNos = receivedLeafNos(binding)

  const restorerReasons: string[] = []
  if (restorerLeafNos.length === 0) restorerReasons.push('修复师那本还没有书叶登记')
  if (leaves.some((leaf) => leaf.state !== 'repaired')) restorerReasons.push('存在未修复的书叶')
  if (orders.length === 0) restorerReasons.push('尚未记录修复工序')
  if (orders.some((order) => order.state !== 'done')) restorerReasons.push('存在未完成的修复工序')

  const bindingReasons: string[] = []
  if (!binding) {
    bindingReasons.push('装订间那本没有装订登记')
  } else {
    if (!binding.method || binding.method.trim().length === 0) bindingReasons.push('未填写装订方式')
    if (!binding.inspector || binding.inspector.trim().length === 0) bindingReasons.push('未填写验收人')
    if (binding.verdict !== 'pass') bindingReasons.push('验收结论不是合格')
  }

  const missingInBinding = restorerLeafNos.filter((no) => !bindingLeafNos.includes(no))
  const missingInRestorer = bindingLeafNos.filter((no) => !restorerLeafNos.includes(no))
  const leafMatchPass = missingInBinding.length === 0 && missingInRestorer.length === 0

  const restorerPass = restorerReasons.length === 0
  const bindingPass = bindingReasons.length === 0

  return {
    pass: restorerPass && bindingPass && leafMatchPass,
    restorerPass,
    bindingPass,
    leafMatchPass,
    restorerReasons,
    bindingReasons,
    restorerLeafNos,
    bindingLeafNos,
    mismatch: { missingInBinding, missingInRestorer }
  }
}

/** 把对账结果格式化成一句可展示的话（含对不上的叶号） */
export function formatReconcileResult(result: ReconcileResult): string {
  const parts: string[] = []
  if (result.restorerReasons.length > 0) parts.push(`修复师那本：${result.restorerReasons.join('；')}`)
  if (result.bindingReasons.length > 0) parts.push(`装订间那本：${result.bindingReasons.join('；')}`)
  const leafParts: string[] = []
  if (result.mismatch.missingInBinding.length > 0) {
    leafParts.push(`第 ${result.mismatch.missingInBinding.join('、')} 叶（修复师有、装订间未签收）`)
  }
  if (result.mismatch.missingInRestorer.length > 0) {
    leafParts.push(`第 ${result.mismatch.missingInRestorer.join('、')} 叶（装订间签收、修复师账上无）`)
  }
  if (leafParts.length > 0) parts.push(`叶号对不上：${leafParts.join('；')}`)
  return parts.join('｜')
}
