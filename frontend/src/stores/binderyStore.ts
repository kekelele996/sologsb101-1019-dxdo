/**
 * 装订间那本册子 store（Pinia setup store）
 * 管 binderyVolumes / leafChecks / bindings：装订方式、逐叶点收、验收人、验收结论与归档对账。
 * 修复师那本（repairVolumes / leaves / repairOrders）在对账中只读，任何重试都不写过去。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { assertVolumeOpenForBindery, db } from '@/utils/db'
import type { Binding } from '@/types/binding'
import type { BinderyPhase, BinderyVolume } from '@/types/binderyVolume'
import type { LeafCheck, LeafCheckState } from '@/types/leafCheck'
import { reconcileVolume, type ReconcileResult } from '@/utils/reconcile'

export const useBinderyStore = defineStore('bindery', () => {
  const volumes = ref<BinderyVolume[]>([])
  const checks = ref<LeafCheck[]>([])
  const bindings = ref<Binding[]>([])
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadAll(): Promise<void> {
    loading.value = true
    try {
      const [volumeRows, checkRows, bindingRows] = await Promise.all([
        db.binderyVolumes.toArray(),
        db.leafChecks.toArray(),
        db.bindings.toArray()
      ])
      volumeRows.sort((a, b) =>
        a.bookId === b.bookId ? a.volumeNo - b.volumeNo : a.bookId.localeCompare(b.bookId)
      )
      checkRows.sort((a, b) =>
        a.volumeId === b.volumeId ? a.leafNo - b.leafNo : a.volumeId.localeCompare(b.volumeId)
      )
      bindingRows.sort((a, b) => b.updatedAt - a.updatedAt)
      volumes.value = volumeRows
      checks.value = checkRows
      bindings.value = bindingRows
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '装订册读取失败'
    } finally {
      loading.value = false
    }
  }

  function volumesOfBook(bookId: string): BinderyVolume[] {
    return volumes.value
      .filter((volume) => volume.bookId === bookId)
      .sort((a, b) => a.volumeNo - b.volumeNo)
  }

  function volumeById(id: string): BinderyVolume | undefined {
    return volumes.value.find((volume) => volume.id === id)
  }

  function checksOfVolume(volumeId: string): LeafCheck[] {
    return checks.value
      .filter((check) => check.volumeId === volumeId)
      .sort((a, b) => a.leafNo - b.leafNo)
  }

  /** 该册最新一条验收记录（每册保留一条，返修 / 复验在原记录上更新） */
  function bindingOfVolume(volumeId: string): Binding | undefined {
    return bindings.value
      .filter((binding) => binding.volumeId === volumeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  /** 装订册自身字段更新（已归档只读） */
  async function updateVolume(id: string, patch: Partial<BinderyVolume>): Promise<void> {
    await assertVolumeOpenForBindery(id)
    await db.binderyVolumes.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadAll()
  }

  /**
   * 登记 / 更新验收结论（只写装订间那本 + bindings）：
   * - 合格 → phase='bound'：装订完成，两本册锁成只读，等待归档前对账
   * - 返修 → phase='repair'：把册子交回修复师那本重开（修复册恢复可写）
   * 不直接写 archived；归档必须先过对账。
   */
  async function submitVerdict(
    volumeId: string,
    draft: Pick<Binding, 'method' | 'finishDate' | 'verdict' | 'inspector'>
  ): Promise<void> {
    const target = volumes.value.find((volume) => volume.id === volumeId)
    if (target?.phase === 'archived') throw new Error('该册已归档，验收记录只读')
    if (target?.phase === 'suspended') throw new Error('该册对账挂起等叶号核定，不能直接登记验收')
    await assertVolumeOpenForBindery(volumeId)
    const existing = bindingOfVolume(volumeId)
    const now = Date.now()
    const phase: BinderyPhase = draft.verdict === 'pass' ? 'bound' : 'repair'
    await db.transaction('rw', [db.bindings, db.binderyVolumes], async () => {
      const binding: Binding = existing
        ? { ...existing, ...draft, updatedAt: now }
        : {
            id: `bind_${volumeId}`,
            volumeId,
            ...draft,
            createdAt: now,
            updatedAt: now
          }
      await db.bindings.put(binding)
      await db.binderyVolumes.update(volumeId, {
        phase,
        // 返修交回：清掉上轮对账挂起，等装订回来重新对
        reconcileStatus: 'none',
        reconciledAt: null,
        mismatchedLeafNos: { missing: [], extra: [] },
        updatedAt: now
      } as never)
    })
    await loadAll()
  }

  async function removeBinding(volumeId: string): Promise<void> {
    await assertVolumeOpenForBindery(volumeId)
    const existing = bindingOfVolume(volumeId)
    if (!existing) return
    await db.transaction('rw', [db.bindings, db.binderyVolumes], async () => {
      await db.bindings.delete(existing.id)
      await db.binderyVolumes.update(volumeId, {
        phase: 'repair',
        reconcileStatus: 'none',
        reconciledAt: null,
        mismatchedLeafNos: { missing: [], extra: [] },
        updatedAt: Date.now()
      } as never)
    })
    await loadAll()
  }

  /* ------------------------------ 逐叶点收（装订侧） ------------------------------ */

  async function upsertCheck(
    volumeId: string,
    leafNo: number,
    state: LeafCheckState,
    note: string
  ): Promise<void> {
    await assertVolumeOpenForBindery(volumeId)
    const existing = checks.value.find(
      (check) => check.volumeId === volumeId && check.leafNo === leafNo
    )
    const now = Date.now()
    if (existing) {
      await db.leafChecks.update(existing.id, { state, note, updatedAt: now } as never)
    } else {
      await db.leafChecks.put({
        id: `check_${volumeId}_${leafNo}_${Math.random().toString(36).slice(2, 7)}`,
        volumeId,
        leafNo,
        state,
        note,
        createdAt: now,
        updatedAt: now
      })
    }
    // 先落库再重新载入点收表，保证点收叶数按最新数据回写装订册（重试挂起册场景）
    const checkRows = await db.leafChecks.where('volumeId').equals(volumeId).toArray()
    checks.value = checkRows.sort((a, b) => a.leafNo - b.leafNo)
    await refreshCheckedCount(volumeId)
    await loadAll()
  }

  async function removeCheck(volumeId: string, leafNo: number): Promise<void> {
    await assertVolumeOpenForBindery(volumeId)
    const existing = checks.value.find(
      (check) => check.volumeId === volumeId && check.leafNo === leafNo
    )
    if (!existing) return
    await db.leafChecks.delete(existing.id)
    checks.value = checks.value.filter((check) => check.id !== existing.id)
    await refreshCheckedCount(volumeId)
    await loadAll()
  }

  async function refreshCheckedCount(volumeId: string): Promise<void> {
    const count = new Set(
      checks.value.filter((check) => check.volumeId === volumeId).map((check) => check.leafNo)
    ).size
    const current = volumes.value.find((volume) => volume.id === volumeId)
    if (current && current.checkedLeafCount !== count) {
      await db.binderyVolumes.update(volumeId, { checkedLeafCount: count, updatedAt: Date.now() } as never)
    }
  }

  /**
   * 归档前对账（核对动作只发生在装订侧）：
   * 叶数 / 工序进度读修复师那本，装订方式 / 验收结论读装订间那本。
   * - 同一叶对不上 → 挂起（suspended）并把叶号写进本册等人定；修复本不动
   * - 叶号一致但工序未完 / 验收返修 → 标 needRework（交回修复师重开）
   * - 全部通过 → archived（两本册彻底只读）
   */
  async function reconcile(volumeId: string): Promise<ReconcileResult> {
    const bindery = await db.binderyVolumes.get(volumeId)
    const repair = await db.repairVolumes.get(volumeId)
    if (!bindery) throw new Error('装订间那本册子不存在')
    if (!repair) throw new Error('修复师那本册子不存在，无法对账')
    if (bindery.phase === 'archived') {
      // 已归档再点「对账」直接按现有数据复算（只读）
    }
    const leaves = await db.leaves.where('volumeId').equals(volumeId).toArray()
    const leafIds = leaves.map((leaf) => leaf.id)
    const orders = leafIds.length > 0 ? await db.repairOrders.where('leafId').anyOf(leafIds).toArray() : []
    const checkRows = await db.leafChecks.where('volumeId').equals(volumeId).toArray()
    const binding = (await db.bindings.where('volumeId').equals(volumeId).toArray())
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]

    const result = reconcileVolume({ bindery, repair, leaves, orders, checks: checkRows, binding })
    const now = Date.now()

    let nextPhase: BinderyPhase = bindery.phase
    let nextStatus: BinderyVolume['reconcileStatus'] = bindery.reconcileStatus
    if (result.suspend) {
      nextPhase = 'suspended'
      nextStatus = 'leafMismatch'
    } else if (result.canArchive) {
      nextPhase = 'archived'
      nextStatus = 'passed'
    } else if (result.needRework) {
      // 工序未完 / 验收返修：册子交回修复师那本重开
      nextPhase = 'repair'
      nextStatus = 'needRework'
    } else {
      nextPhase = 'bound'
      nextStatus = 'none'
    }

    await db.binderyVolumes.update(volumeId, {
      phase: nextPhase,
      reconcileStatus: nextStatus,
      reconciledAt: result.suspend || result.canArchive ? now : bindery.reconciledAt,
      mismatchedLeafNos: { missing: result.missingLeafNos, extra: result.extraLeafNos },
      updatedAt: now
    } as never)
    await loadAll()
    return result
  }

  /**
   * 核对失败后装订间按本侧重试一遍：改的是装订册 / 点收表，修复师那本不动。
   * 先把挂起解除回 bound，再立即用当前点收数据重新对账。
   */
  async function retryReconcile(volumeId: string): Promise<ReconcileResult> {
    const bindery = volumes.value.find((volume) => volume.id === volumeId)
    if (bindery && bindery.phase === 'archived') throw new Error('已归档，无需重试')
    await db.binderyVolumes.update(volumeId, {
      phase: 'bound',
      reconcileStatus: 'none',
      mismatchedLeafNos: { missing: [], extra: [] },
      updatedAt: Date.now()
    } as never)
    await loadAll()
    return reconcile(volumeId)
  }

  /** 挂起等人定之后，人工裁决「按装订本交回返修」（只动装订册阶段，修复本数据仍不碰） */
  async function handBackForRework(volumeId: string): Promise<void> {
    await db.binderyVolumes.update(volumeId, {
      phase: 'repair',
      reconcileStatus: 'needRework',
      updatedAt: Date.now()
    } as never)
    await loadAll()
  }

  const archivedCount = computed(
    () => volumes.value.filter((volume) => volume.phase === 'archived').length
  )
  const suspendedCount = computed(
    () => volumes.value.filter((volume) => volume.phase === 'suspended').length
  )
  const pendingBindingCount = computed(
    () => volumes.value.filter((volume) => volume.phase === 'repair').length
  )

  return {
    volumes,
    checks,
    bindings,
    loading,
    ready,
    error,
    archivedCount,
    suspendedCount,
    pendingBindingCount,
    loadAll,
    volumesOfBook,
    volumeById,
    checksOfVolume,
    bindingOfVolume,
    updateVolume,
    submitVerdict,
    removeBinding,
    upsertCheck,
    removeCheck,
    reconcile,
    retryReconcile,
    handBackForRework
  }
})
