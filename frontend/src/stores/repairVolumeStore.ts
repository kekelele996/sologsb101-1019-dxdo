/**
 * 修复师那本册子 store（Pinia setup store）
 * 只管 repairVolumes：登记叶数、修复进度；逐叶破损 / 补纸 / 工序的写操作以本册开放为前提。
 * 装订间的 phase 决定这本是否锁定：phase !== 'repair' 时整册只读，返修交回后重开。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { assertVolumeOpenForRepair, db } from '@/utils/db'
import type { BinderyVolume } from '@/types/binderyVolume'
import type { Leaf } from '@/types/leaf'
import type { RepairOrder } from '@/types/repairOrder'
import type { RepairState, RepairVolume } from '@/types/repairVolume'

export const useRepairVolumeStore = defineStore('repairVolume', () => {
  const volumes = ref<RepairVolume[]>([])
  const binderyPhases = ref<Map<string, BinderyVolume['phase']>>(new Map())
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  async function loadVolumes(): Promise<void> {
    loading.value = true
    try {
      const [rows, binderies] = await Promise.all([
        db.repairVolumes.toArray(),
        db.binderyVolumes.toArray()
      ])
      rows.sort((a, b) =>
        a.bookId === b.bookId ? a.volumeNo - b.volumeNo : a.bookId.localeCompare(b.bookId)
      )
      volumes.value = rows
      binderyPhases.value = new Map(binderies.map((item) => [item.id, item.phase]))
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '修复册读取失败'
    } finally {
      loading.value = false
    }
  }

  /** 装订间那本是否在修（在修才能写修复册） */
  function isOpen(volumeId: string): boolean {
    return binderyPhases.value.get(volumeId) === 'repair' || !binderyPhases.value.has(volumeId)
  }

  function volumesOfBook(bookId: string): RepairVolume[] {
    return volumes.value
      .filter((volume) => volume.bookId === bookId)
      .sort((a, b) => a.volumeNo - b.volumeNo)
  }

  function volumeById(id: string): RepairVolume | undefined {
    return volumes.value.find((volume) => volume.id === id)
  }

  /** 修复师那本字段更新（仅在册子交回修复师时允许） */
  async function updateVolume(id: string, patch: Partial<RepairVolume>): Promise<void> {
    await assertVolumeOpenForRepair(id)
    await db.repairVolumes.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadVolumes()
  }

  /**
   * 依据逐叶破损与工序回写修复进度（只写修复册）：
   * 全部叶已修复 → repaired；有在修 / 待修 → repairing / pending。
   * 装订阶段（非 repair）不回写，返修交回后由工序动作再次触发。
   */
  async function syncRepairState(
    volumeId: string,
    leavesOfVolume: Leaf[],
    orders: RepairOrder[]
  ): Promise<void> {
    if (!isOpen(volumeId)) return
    const current = volumes.value.find((volume) => volume.id === volumeId)
    if (!current) return
    let next: RepairState = 'pending'
    if (leavesOfVolume.length > 0) {
      const allRepaired = leavesOfVolume.every((leaf) => leaf.state === 'repaired')
      const anyStarted = leavesOfVolume.some((leaf) => leaf.state !== 'pending') || orders.length > 0
      next = allRepaired ? 'repaired' : anyStarted ? 'repairing' : 'pending'
    }
    if (next !== current.repairState) {
      await db.repairVolumes.update(volumeId, { repairState: next, updatedAt: Date.now() })
      await loadVolumes()
    }
  }

  const pendingCount = computed(
    () => volumes.value.filter((volume) => volume.repairState !== 'repaired').length
  )

  return {
    volumes,
    loading,
    ready,
    error,
    pendingCount,
    loadVolumes,
    isOpen,
    volumesOfBook,
    volumeById,
    updateVolume,
    syncRepairState
  }
})
