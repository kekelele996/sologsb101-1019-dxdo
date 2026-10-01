/**
 * 古籍 store（Pinia setup store）
 * 维护古籍列表、当前选中的古籍 / 册次与筛选条件。
 *
 * 册次档案自 v3 起拆成修复师那本与装订间那本，本 store 不再持有可写的单本 Volume，
 * 只聚合两本的只读视图（VolumeView）供台账 / 页面展示；
 * 开新册在两本上同立一页（createVolumePair），改修复字段走 repairVolumeStore，
 * 改装订字段 / 验收走 binderyStore，从根上杜绝两边互改对方的叶。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  assertVolumeOpenForRepair,
  createId,
  createVolumePair,
  db,
  readUiPrefs,
  removeBookCascade,
  removeVolumeCascade,
  writeUiPrefs
} from '@/utils/db'
import type { Book, BookDraft, BookLevel } from '@/types/book'
import {
  aggregateVolumeState,
  type BindingType,
  type VolumeView
} from '@/types/volume'
import {
  createEmptyBinderyVolumeDraft,
  type BinderyVolume
} from '@/types/binderyVolume'
import {
  createEmptyRepairVolumeDraft,
  type RepairVolume,
  type RepairVolumeDraft
} from '@/types/repairVolume'
import { useRepairVolumeStore } from './repairVolumeStore'
import { useBinderyStore } from './binderyStore'

/** 开新册时两边各填各的初始字段 */
export interface VolumePairDraft {
  bookId: string
  volumeNo: number
  // 修复师那本
  leafCount: number
  repairState: RepairVolumeDraft['repairState']
  // 装订间那本
  bindingType: BindingType
}

export interface BookFilters {
  keyword: string
  eras: string[]
  levels: BookLevel[]
}

export const DEFAULT_BOOK_FILTERS: BookFilters = { keyword: '', eras: [], levels: [] }

export function createEmptyVolumePairDraft(bookId: string, volumeNo: number): VolumePairDraft {
  return {
    bookId,
    volumeNo,
    leafCount: createEmptyRepairVolumeDraft(bookId, volumeNo).leafCount,
    repairState: createEmptyRepairVolumeDraft(bookId, volumeNo).repairState,
    bindingType: createEmptyBinderyVolumeDraft(bookId, volumeNo).bindingType
  }
}

export const useBookStore = defineStore('book', () => {
  const prefs = readUiPrefs()
  const books = ref<Book[]>([])
  const currentBookId = ref<string | null>(prefs.lastBookId)
  const currentVolumeId = ref<string | null>(prefs.lastVolumeId)
  const filters = ref<BookFilters>({ ...DEFAULT_BOOK_FILTERS })
  const loading = ref(false)
  const ready = ref(false)
  const error = ref('')

  const repairVolumeStore = useRepairVolumeStore()
  const binderyStore = useBinderyStore()

  watch([currentBookId, currentVolumeId], ([bookId, volumeId]) => {
    writeUiPrefs({ ...readUiPrefs(), lastBookId: bookId, lastVolumeId: volumeId })
  })

  const currentBook = computed<Book | null>(
    () => books.value.find((book) => book.id === currentBookId.value) ?? null
  )

  /**
   * 两本聚合视图（同 id 配对）。叶数 / 修复状态取修复册，装订形式 / 阶段取装订册。
   * 若两本因异常缺一边，用另一边兜底展示（写操作仍由各自 store 的写保护拦截）。
   */
  const volumes = computed<VolumeView[]>(() => {
    const ids = new Set<string>([
      ...repairVolumeStore.volumes.map((volume) => volume.id),
      ...binderyStore.volumes.map((volume) => volume.id)
    ])
    const views: VolumeView[] = []
    ids.forEach((id) => {
      const repair = repairVolumeStore.volumeById(id)
      const bindery = binderyStore.volumeById(id)
      const identity = repair ?? bindery
      if (!identity) return
      views.push({
        id,
        bookId: identity.bookId,
        volumeNo: identity.volumeNo,
        leafCount: repair?.leafCount ?? 0,
        repairState: repair?.repairState ?? 'pending',
        bindingType: bindery?.bindingType ?? 'thread',
        phase: bindery?.phase ?? 'repair',
        state: aggregateVolumeState(
          bindery?.phase ?? 'repair',
          repair?.repairState ?? 'pending'
        )
      })
    })
    views.sort((a, b) =>
      a.bookId === b.bookId ? a.volumeNo - b.volumeNo : a.bookId.localeCompare(b.bookId)
    )
    return views
  })

  const currentVolume = computed<VolumeView | null>(
    () => volumes.value.find((volume) => volume.id === currentVolumeId.value) ?? null
  )

  /** 年代候选：从数据中派生 */
  const eraOptions = computed<string[]>(() =>
    Array.from(new Set(books.value.map((book) => book.era).filter((era) => era.length > 0))).sort()
  )

  /** 古籍总览筛选结果（关键字 + 年代 + 保护级别） */
  const filteredBooks = computed<Book[]>(() => {
    const keyword = filters.value.keyword.trim()
    return books.value.filter((book) => {
      if (keyword.length > 0) {
        const haystack = `${book.title}${book.edition}${book.era}${book.collectionNo}`
        if (!haystack.includes(keyword)) return false
      }
      if (filters.value.eras.length > 0 && !filters.value.eras.includes(book.era)) return false
      if (filters.value.levels.length > 0 && !filters.value.levels.includes(book.level)) return false
      return true
    })
  })

  async function loadBooks(): Promise<void> {
    loading.value = true
    try {
      const rows = await db.books.toArray()
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      books.value = rows
      const stillExists = currentBookId.value !== null && rows.some((book) => book.id === currentBookId.value)
      if (!stillExists) currentBookId.value = null
      error.value = ''
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '古籍读取失败'
    } finally {
      loading.value = false
    }
  }

  function setCurrentBook(id: string | null): void {
    currentBookId.value = id
  }

  function setCurrentVolume(id: string | null): void {
    currentVolumeId.value = id
  }

  function setKeyword(keyword: string): void {
    filters.value = { ...filters.value, keyword }
  }

  function setEras(eras: string[]): void {
    filters.value = { ...filters.value, eras }
  }

  function setLevels(levels: BookLevel[]): void {
    filters.value = { ...filters.value, levels }
  }

  function resetFilters(): void {
    filters.value = { ...DEFAULT_BOOK_FILTERS }
  }

  async function createBook(draft: BookDraft): Promise<Book> {
    const now = Date.now()
    const row: Book = { ...draft, id: createId('book'), createdAt: now, updatedAt: now }
    await db.books.put(row)
    await loadBooks()
    currentBookId.value = row.id
    return row
  }

  async function updateBook(id: string, patch: Partial<Book>): Promise<void> {
    await db.books.update(id, { ...patch, updatedAt: Date.now() } as never)
    await loadBooks()
  }

  async function removeBook(id: string): Promise<void> {
    await removeBookCascade(id)
    if (currentBookId.value === id) currentBookId.value = null
    await Promise.all([loadBooks(), repairVolumeStore.loadVolumes(), binderyStore.loadAll()])
  }

  /** 开新册：修复师那本与装订间那本同立一页（同 id = 同一物理册），各写各的字段 */
  async function createVolume(draft: VolumePairDraft): Promise<string> {
    const now = Date.now()
    const id = createId('vol')
    const repair: RepairVolume = {
      id,
      bookId: draft.bookId,
      volumeNo: draft.volumeNo,
      leafCount: draft.leafCount,
      repairState: draft.repairState,
      createdAt: now,
      updatedAt: now
    }
    const bindery: BinderyVolume = {
      ...createEmptyBinderyVolumeDraft(draft.bookId, draft.volumeNo),
      id,
      bindingType: draft.bindingType,
      createdAt: now,
      updatedAt: now
    }
    await createVolumePair(repair, bindery)
    await Promise.all([repairVolumeStore.loadVolumes(), binderyStore.loadAll()])
    await syncBookVolumeCount(draft.bookId)
    return id
  }

  /**
   * 改修复师那本字段（叶数 / 修复进度）。装订锁定 / 挂起 / 归档时整册只读，直接拒。
   */
  async function updateRepairVolume(id: string, patch: Partial<RepairVolume>): Promise<void> {
    await repairVolumeStore.updateVolume(id, patch)
    await syncBookVolumeCount((repairVolumeStore.volumeById(id)?.bookId) ?? '')
  }

  /** 改装订间那本字段（装订形式等）；已归档只读。 */
  async function updateBinderyVolume(id: string, patch: Partial<BinderyVolume>): Promise<void> {
    await binderyStore.updateVolume(id, patch)
  }

  /** 册次号是两本共有的身份字段，两边同改（仅在修复师手上允许） */
  async function updateVolumeIdentity(id: string, volumeNo: number): Promise<void> {
    await assertVolumeOpenForRepair(id)
    const now = Date.now()
    await db.transaction('rw', [db.repairVolumes, db.binderyVolumes], async () => {
      await db.repairVolumes.update(id, { volumeNo, updatedAt: now } as never)
      await db.binderyVolumes.update(id, { volumeNo, updatedAt: now } as never)
    })
    await Promise.all([repairVolumeStore.loadVolumes(), binderyStore.loadAll()])
  }

  async function removeVolume(id: string): Promise<void> {
    await removeVolumeCascade(id)
    if (currentVolumeId.value === id) currentVolumeId.value = null
    await Promise.all([repairVolumeStore.loadVolumes(), binderyStore.loadAll()])
    const repair = repairVolumeStore.volumes.find((volume) => volume.id === id)
    await syncBookVolumeCount(repair?.bookId ?? '')
  }

  /** 册次增删后回写古籍的册数，保证卡片回显一致 */
  async function syncBookVolumeCount(bookId: string): Promise<void> {
    if (!bookId) return
    const count = repairVolumeStore.volumesOfBook(bookId).length
    const book = books.value.find((item) => item.id === bookId)
    if (book && book.volumeCount !== count) {
      await db.books.update(bookId, { volumeCount: count, updatedAt: Date.now() } as never)
      await loadBooks()
    }
  }

  function volumesOfBook(bookId: string): VolumeView[] {
    return volumes.value
      .filter((volume) => volume.bookId === bookId)
      .sort((a, b) => a.volumeNo - b.volumeNo)
  }

  function bookById(id: string): Book | undefined {
    return books.value.find((book) => book.id === id)
  }

  function volumeById(id: string): VolumeView | undefined {
    return volumes.value.find((volume) => volume.id === id)
  }

  return {
    books,
    volumes,
    currentBookId,
    currentVolumeId,
    currentBook,
    currentVolume,
    filters,
    loading,
    ready,
    error,
    eraOptions,
    filteredBooks,
    loadBooks,
    setCurrentBook,
    setCurrentVolume,
    setKeyword,
    setEras,
    setLevels,
    resetFilters,
    createBook,
    updateBook,
    removeBook,
    createVolume,
    updateRepairVolume,
    updateBinderyVolume,
    updateVolumeIdentity,
    removeVolume,
    syncBookVolumeCount,
    volumesOfBook,
    bookById,
    volumeById
  }
})
