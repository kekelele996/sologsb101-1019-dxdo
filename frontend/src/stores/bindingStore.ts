/**
 * 装订间 store（Pinia setup store）
 * 装订间那本单独记账：装订方式、验收人、验收结论、装订间状态与叶号签收。
 * 验收合格触发两边对账；对账失败装订间按本侧重试一遍（修复师那本不动），仍不符则挂起并摆出叶号；
 * 返修则把册子交回修复师那本重开。页面只读 store，跨页状态不留在组件内部 ref。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db } from '@/utils/db'
import { reconcileVolume, type ReconcileResult } from '@/utils/reconcile'
import type { Binding, BindingLeafCheck } from '@/types/binding'
import { useBookStore } from './bookStore'
import { useLeafStore } from './leafStore'
import { useRepairStore } from './repairStore'

export interface BindingSubmit {
  /** 编辑时带装订记录 id；新建留空（同一册已有记录则更新） */
  id?: string
  volumeId: string
  method: string
  finishDate: string
  verdict: 'pass' | 'rework'
  inspector: string
  leafChecks: BindingLeafCheck[]
}

export interface BindingSubmitResult {
  ok: boolean
  /** 验收合格且对账通过，已归档 */
  archived?: boolean
  /** 验收返修，册子已交回修复师那本重开 */
  rework?: boolean
  /** 对账未通过，已挂起 */
  suspended?: boolean
  result?: ReconcileResult
}

export const useBindingStore = defineStore('binding', () => {
  const bindings = ref<Binding[]>([])
  const loading = ref(false)
  const ready = ref(false)

  async function loadBindings(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.bindings.toArray()
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      bindings.value = rows
      ready.value = true
    } catch {
      /* 读取失败保持空表，页面走空态 */
    } finally {
      loading.value = false
    }
  }

  function bindingOfVolume(volumeId: string): Binding | undefined {
    return bindings.value.find((item) => item.volumeId === volumeId)
  }

  /** 整册锁成只读：装订间那本已归档 */
  function isVolumeLocked(volumeId: string): boolean {
    return bindings.value.some((item) => item.volumeId === volumeId && item.status === 'archived')
  }

  /** 组装对账输入：修复师那本（书叶 + 工序）只读，装订间那本用当前记录 */
  function buildReconcileInput(volumeId: string, binding: Binding) {
    const leafStore = useLeafStore()
    const repairStore = useRepairStore()
    const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === volumeId)
    const leafIds = new Set(leaves.map((leaf) => leaf.id))
    const orders = repairStore.orders.filter((order) => leafIds.has(order.leafId))
    return { volumeId, leaves, orders, binding }
  }

  /**
   * 装订间提交验收：只写装订间那本。
   * 合格 → 两边对账；对账失败装订间按本侧重试一遍（修复师那本不动）；仍不符 → 挂起。
   * 返修 → 把册子交回修复师那本重开（修复师那本改回修复中）。
   */
  async function submitBinding(payload: BindingSubmit): Promise<BindingSubmitResult> {
    const bookStore = useBookStore()
    const now = Date.now()

    const existing = payload.id
      ? bindings.value.find((item) => item.id === payload.id)
      : bindings.value.find((item) => item.volumeId === payload.volumeId)

    const record: Binding = {
      id: existing?.id ?? createId('bind'),
      volumeId: payload.volumeId,
      method: payload.method,
      finishDate: payload.finishDate,
      verdict: payload.verdict,
      inspector: payload.inspector,
      leafChecks: payload.leafChecks,
      // 提交后先回到装订中；合格对账通过再置为已归档，对账不符置为挂起，返修保持装订中
      status: 'open',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    // 装订间那本只写自己的记录
    await db.bindings.put(record)
    await loadBindings()

    if (payload.verdict !== 'pass') {
      // 返修：把册子交回修复师那本重开（修复师那本改回修复中）
      await bookStore.updateVolume(payload.volumeId, { state: 'repairing' })
      return { ok: true, rework: true }
    }

    // 验收合格 → 归档前两边对账（只读修复师那本）
    let result = reconcileVolume(buildReconcileInput(payload.volumeId, record))
    if (!result.pass) {
      // 核对失败后装订间按本侧重试一遍，修复师那本不动
      await retryBindingVerification(record.id)
      const fresh = await db.bindings.get(record.id)
      result = reconcileVolume(buildReconcileInput(payload.volumeId, fresh ?? record))
    }

    if (result.pass) {
      await db.bindings.update(record.id, { status: 'archived', updatedAt: Date.now() } as never)
      await loadBindings()
      return { ok: true, archived: true, result }
    }

    await db.bindings.update(record.id, { status: 'suspended', updatedAt: Date.now() } as never)
    await loadBindings()
    return { ok: false, suspended: true, result }
  }

  /**
   * 装订间本侧重试：只重读并重写装订间自己的记录，不碰修复师那本。
   */
  async function retryBindingVerification(bindingId: string): Promise<void> {
    const fresh = await db.bindings.get(bindingId)
    if (!fresh) return
    await db.bindings.update(bindingId, { updatedAt: Date.now() } as never)
  }

  async function removeBinding(id: string): Promise<void> {
    await db.bindings.delete(id)
    await loadBindings()
  }

  return {
    bindings,
    loading,
    ready,
    loadBindings,
    bindingOfVolume,
    isVolumeLocked,
    submitBinding,
    retryBindingVerification,
    removeBinding
  }
})

export default useBindingStore
