/**
 * 归档前两本对账（修复师那本 × 装订间那本）
 *
 * 口径（不可颠倒）：
 * - 叶数、工序进度 → 只看修复师那本（repairVolumes + leaves + repairOrders）
 * - 装订方式、验收结论 → 只看装订间那本（binderyVolumes + bindings）
 * - 同一叶号两边对不上（修复有 / 装订无，或装订有 / 修复无）→ 先挂起这一册，
 *   把对不上的叶号摆出来等人定；核对失败后装订间只重试本册（改 leafChecks），
 *   修复师那本一律不动。
 *
 * 另含 v2 → v3 旧册次档案按现状拆两本的纯函数，供 Dexie 升级与旧版备份导入共用。
 */
import type { Leaf } from '@/types/leaf'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { BinderyVolume } from '@/types/binderyVolume'
import type { RepairVolume } from '@/types/repairVolume'
import type { LeafCheck, LeafCheckState } from '@/types/leafCheck'
import type { VolumeState } from '@/types/volume'

/** v2 及以前的单本册次档案结构（升级时按现状读） */
export interface LegacyVolume {
  id: string
  bookId: string
  volumeNo: number
  leafCount: number
  bindingType: BinderyVolume['bindingType']
  state: VolumeState | string
  createdAt?: number
  updatedAt?: number
}

/** 旧库数据缺归属：先按现状回填再启用 —— 单本拆两本 */
export interface SplitLegacyResult {
  repair: RepairVolume
  bindery: BinderyVolume
  /** 已合格（已装订 / 已归档）旧册按修复师那本现有叶号回填逐叶点收 */
  checks: LeafCheck[]
}

/**
 * 按现状拆 v2 单本册：
 * - 修复册拿 id / bookId / volumeNo / leafCount，修复状态按旧 state 回填
 *   （bound / archived 视为已修复，pending / repairing 原样）。
 * - 装订册拿 id / bookId / volumeNo / bindingType，交接阶段按旧 state 回填：
 *   bound → bound，archived → archived（对账直接判通过，旧库默认两边一致），
 *   pending / repairing → repair（含旧的 rework 验收已把状态打回 repairing 的情况）。
 * - 已装订 / 已归档的旧册，按修复师那本现有叶号回填 accepted 点收，
 *   叶号由调用方传入（Dexie upgrade 时查 leaves）。
 */
export function splitLegacyVolume(
  legacy: LegacyVolume,
  repairLeafNos: number[],
  now: number
): SplitLegacyResult {
  const createdAt = legacy.createdAt ?? now
  const updatedAt = legacy.updatedAt ?? now
  const oldState = legacy.state
  const archived = oldState === 'archived'
  const bound = oldState === 'bound'

  const repairState: RepairVolume['repairState'] =
    oldState === 'repairing'
      ? 'repairing'
      : oldState === 'pending'
        ? 'pending'
        : 'repaired'

  const phase: BinderyVolume['phase'] = archived
    ? 'archived'
    : bound
      ? 'bound'
      : 'repair'

  const repair: RepairVolume = {
    id: legacy.id,
    bookId: legacy.bookId,
    volumeNo: legacy.volumeNo,
    leafCount: legacy.leafCount,
    repairState,
    createdAt,
    updatedAt
  }

  const leafNos = Array.from(new Set(repairLeafNos)).sort((a, b) => a - b)
  const checks: LeafCheck[] =
    archived || bound
      ? leafNos.map((leafNo) => ({
          id: `check_${legacy.id}_${leafNo}`,
          volumeId: legacy.id,
          leafNo,
          state: 'accepted' satisfies LeafCheckState,
          note: '旧档案按现状回填',
          createdAt,
          updatedAt
        }))
      : []

  const bindery: BinderyVolume = {
    id: legacy.id,
    bookId: legacy.bookId,
    volumeNo: legacy.volumeNo,
    bindingType: legacy.bindingType ?? 'thread',
    phase,
    checkedLeafCount: leafNos.length,
    reconcileStatus: archived ? 'passed' : 'none',
    reconciledAt: archived ? updatedAt : null,
    mismatchedLeafNos: { missing: [], extra: [] },
    createdAt,
    updatedAt
  }

  return { repair, bindery, checks }
}

/* ------------------------------ 归档前对账 ------------------------------ */

export interface ReconcileInput {
  /** 装订间那本（要回写的那本；修复侧资料只作只读输入） */
  bindery: BinderyVolume
  /** 修复师那本（叶数申报口径，只读） */
  repair: RepairVolume
  /** 修复师那本的逐叶破损记录（只读） */
  leaves: Leaf[]
  /** 修复师那本的工序（只读，工序进度口径） */
  orders: RepairOrder[]
  /** 装订间那本的逐叶点收（装订侧可改、重试的对象） */
  checks: LeafCheck[]
  /** 装订间那本最近一次验收记录（装订方式 / 验收结论口径） */
  binding?: Binding
}

export interface ReconcileResult {
  /** 是否可以归档（叶号一致 + 全部工序完成 + 已验收合格） */
  canArchive: boolean
  /** 是否需要把册子挂起（同一叶两边对不上） */
  suspend: boolean
  /** 是否需要返修交回（叶号对得上，但工序没做完） */
  needRework: boolean
  /** 修复师那本的叶号集合 */
  repairLeafNos: number[]
  /** 装订间点收到的叶号集合（含 accepted / extra 都算装订这边见到的叶） */
  binderyLeafNos: number[]
  /** 修复有、装订无（按修复师叶号对装订点收，缺叶） */
  missingLeafNos: number[]
  /** 装订有、修复无（多叶） */
  extraLeafNos: number[]
  /** 工序未完成涉及的叶号（返修提示用） */
  unfinishedLeafNos: number[]
  /** 工序进度汇总 x/y */
  ordersDone: number
  ordersTotal: number
  /** 验收结论是否合格；无验收记录视为未验收 */
  verdictPassed: boolean
  /** 给人看的逐条结论 */
  messages: string[]
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

/**
 * 归档前对账。纯函数，不触碰任何表；回写由装订间 store 只改 bindery / leafChecks 侧。
 */
export function reconcileVolume(input: ReconcileInput): ReconcileResult {
  const messages: string[] = []
  const repairLeafNos = uniqueSorted(input.leaves.map((leaf) => leaf.leafNo))
  const binderyLeafNos = uniqueSorted(input.checks.map((check) => check.leafNo))

  // 同一叶两边对不上：修复有、装订无 → 缺叶；装订有、修复无 → 多叶
  const repairSet = new Set(repairLeafNos)
  const binderySet = new Set(binderyLeafNos)
  const missingLeafNos = repairLeafNos.filter((no) => !binderySet.has(no))
  const extraLeafNos = binderyLeafNos.filter((no) => !repairSet.has(no))
  const leafMismatch = missingLeafNos.length > 0 || extraLeafNos.length > 0

  // 工序进度只看修复师那本：逐叶判定该叶的工序是否全部完成
  const leafIds = new Set(input.leaves.map((leaf) => leaf.id))
  const leafNoByLeafId = new Map(input.leaves.map((leaf) => [leaf.id, leaf.leafNo]))
  const ordersOfVolume = input.orders.filter((order) => leafIds.has(order.leafId))
  const ordersDone = ordersOfVolume.filter((order) => order.state === 'done').length
  const ordersTotal = ordersOfVolume.length
  const unfinishedLeafNos = uniqueSorted(
    input.leaves
      .filter((leaf) => {
        const list = input.orders.filter((order) => order.leafId === leaf.id)
        // 该叶一道工序都没登也算未完成
        return list.length === 0 || list.some((order) => order.state !== 'done')
      })
      .map((leaf) => leafNoByLeafId.get(leaf.id) as number)
  )
  const workFinished = unfinishedLeafNos.length === 0

  // 装订方式 / 验收结论只看装订间那本
  const verdictPassed = input.binding?.verdict === 'pass'
  const methodMatchesType = input.binding
    ? methodMatchesBindingType(input.binding.method, input.bindery.bindingType)
    : false

  if (leafMismatch) {
    if (missingLeafNos.length > 0) {
      messages.push(`修复师那本有、装订点收缺叶：第 ${missingLeafNos.join('、')} 叶`)
    }
    if (extraLeafNos.length > 0) {
      messages.push(`装订点收有、修复师那本无：第 ${extraLeafNos.join('、')} 叶`)
    }
    messages.push('同一叶两边对不上，先挂起这一册，把叶号摆出来等人定。')
  } else {
    messages.push(`叶号一致：两边都是 ${repairLeafNos.length} 叶（修复册登记 ${input.repair.leafCount} 叶）。`)
  }

  if (!workFinished) {
    messages.push(`工序未全部完成：第 ${unfinishedLeafNos.join('、')} 叶（${ordersDone}/${ordersTotal} 道完成），需返修交回修复师。`)
  } else {
    messages.push(`工序全部完成（${ordersDone}/${ordersTotal} 道）。`)
  }

  if (!input.binding) {
    messages.push('装订间尚未登记验收记录（无验收人 / 验收结论）。')
  } else if (!verdictPassed) {
    messages.push('验收结论为返修，册子应交回修复师那本重开。')
  } else if (!methodMatchesType) {
    messages.push(`装订方式「${input.binding.method}」与装订册登记形式不一致，请装订间核对本册。`)
  } else {
    messages.push(`验收合格：${input.binding.method}，验收人 ${input.binding.inspector || '未填'}。`)
  }

  const suspend = leafMismatch
  const needRework = !leafMismatch && (!workFinished || !verdictPassed)
  const canArchive = !leafMismatch && workFinished && verdictPassed && methodMatchesType

  return {
    canArchive,
    suspend,
    needRework,
    repairLeafNos,
    binderyLeafNos,
    missingLeafNos,
    extraLeafNos,
    unfinishedLeafNos,
    ordersDone,
    ordersTotal,
    verdictPassed,
    messages
  }
}

/** 装订方式文本与装订形式的对应（装订册自洽校验，不涉及修复本） */
export function methodMatchesBindingType(
  method: string,
  bindingType: BinderyVolume['bindingType']
): boolean {
  if (bindingType === 'thread') return method.includes('线装') || method.includes('金镶玉')
  if (bindingType === 'butterfly') return method.includes('蝴蝶')
  if (bindingType === 'wrapped') return method.includes('包背')
  return false
}
