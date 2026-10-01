/**
 * IndexedDB 持久化层（Dexie 封装）
 *
 * 数据结构版本与升级：
 * - v1：初版六表（books / volumes / leaves / papers / repairOrders / bindings）
 * - v2：Paper 增加 dyeRecipe 字段并按纸种回填默认配方
 * - v3：修复室与装订间合用的 volumes 一册拆两本、各写各的 ——
 *       repairVolumes（叶数、修复进度）+ binderyVolumes（装订形式、交接阶段、对账结论），
 *       新增 leafChecks（装订间逐叶点收）；旧 volumes 按现状回填两本后停用。
 *
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie'
import type { Book } from '@/types/book'
import type { Leaf } from '@/types/leaf'
import { DEFAULT_DYE_RECIPE, type Paper } from '@/types/paper'
import type { RepairOrder } from '@/types/repairOrder'
import type { Binding } from '@/types/binding'
import type { RepairVolume } from '@/types/repairVolume'
import type { BinderyVolume } from '@/types/binderyVolume'
import type { LeafCheck } from '@/types/leafCheck'
import { splitLegacyVolume, type LegacyVolume } from '@/utils/reconcile'

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbbookrestore'

/** 当前数据结构版本号（v3：册次档案拆成修复 / 装订两本） */
export const DB_VERSION = 3

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbbookrestore:db-version',
  lastBackupAt: 'gbbookrestore:last-backup-at',
  uiPrefs: 'gbbookrestore:ui-prefs'
} as const

export interface UiPrefs {
  lastBookId: string | null
  lastVolumeId: string | null
  repairSort: 'manual' | 'leaf'
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBookId: null, lastVolumeId: null, repairSort: 'manual' }

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastBookId: typeof parsed.lastBookId === 'string' ? parsed.lastBookId : null,
      lastVolumeId: typeof parsed.lastVolumeId === 'string' ? parsed.lastVolumeId : null,
      repairSort: parsed.repairSort === 'leaf' ? 'leaf' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value)
  } catch {
    /* ignore */
  }
}

export class BookRestoreDatabase extends Dexie {
  books!: Table<Book, string>
  /** 修复师那本（叶数、修复进度）——只有修复侧写 */
  repairVolumes!: Table<RepairVolume, string>
  /** 装订间那本（装订形式、交接阶段、对账结论）——只有装订侧写 */
  binderyVolumes!: Table<BinderyVolume, string>
  leaves!: Table<Leaf, string>
  papers!: Table<Paper, string>
  repairOrders!: Table<RepairOrder, string>
  bindings!: Table<Binding, string>
  /** 装订间逐叶点收（[volumeId+leafNo] 唯一） */
  leafChecks!: Table<LeafCheck, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      books: 'id, title, era, level, updatedAt',
      volumes: 'id, bookId, volumeNo, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, state, updatedAt',
      papers: 'id, leafId, paperType, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, state, updatedAt',
      bindings: 'id, volumeId, verdict, finishDate, updatedAt'
    })
    // v2：Paper 增加 dyeRecipe 字段，按纸种为历史记录回填默认配方
    this.version(2).stores({
      books: 'id, title, era, level, collectionNo, updatedAt',
      volumes: 'id, bookId, volumeNo, bindingType, state, updatedAt',
      leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
      papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
      repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
      bindings: 'id, volumeId, method, verdict, finishDate, updatedAt'
    })
    // v3：volumes 一册拆两本（repairVolumes / binderyVolumes），新增 leafChecks；
    // 旧库数据缺归属，先按现状回填再启用。null 表表示删除旧 volumes 表。
    this.version(DB_VERSION)
      .stores({
        books: 'id, title, era, level, collectionNo, updatedAt',
        volumes: null,
        repairVolumes: 'id, bookId, volumeNo, repairState, updatedAt',
        binderyVolumes: 'id, bookId, volumeNo, bindingType, phase, reconcileStatus, updatedAt',
        leaves: 'id, volumeId, leafNo, damageType, phValue, state, updatedAt',
        papers: 'id, leafId, paperType, laidPattern, deltaE, updatedAt',
        repairOrders: 'id, leafId, seq, name, operator, state, updatedAt',
        bindings: 'id, volumeId, method, verdict, finishDate, updatedAt',
        leafChecks: 'id, volumeId, leafNo, state, &[volumeId+leafNo], updatedAt'
      })
      .upgrade(async (tx) => {
        // v2 的 papers 补默认配方（v2 用户直升 v3 也要兜住）
        await tx
          .table<Paper>('papers')
          .toCollection()
          .modify((paper) => {
            if (!paper.dyeRecipe || paper.dyeRecipe.length === 0) {
              paper.dyeRecipe = DEFAULT_DYE_RECIPE[paper.paperType] ?? DEFAULT_DYE_RECIPE.bamboo
            }
            if (typeof paper.deltaE !== 'number') paper.deltaE = 2
            if (typeof paper.thicknessMm !== 'number') paper.thicknessMm = 0.06
          })

        // 旧 volumes 按现状拆两本；已装订 / 已归档册按修复师现有叶号回填逐叶点收
        const legacyVolumes = await tx.table<LegacyVolume>('volumes').toArray()
        const leaves = await tx.table<Leaf>('leaves').toArray()
        const now = Date.now()
        for (const legacy of legacyVolumes) {
          const leafNos = leaves
            .filter((leaf) => leaf.volumeId === legacy.id)
            .map((leaf) => leaf.leafNo)
          const { repair, bindery, checks } = splitLegacyVolume(legacy, leafNos, now)
          await tx.table<RepairVolume>('repairVolumes').put(repair)
          await tx.table<BinderyVolume>('binderyVolumes').put(bindery)
          if (checks.length > 0) await tx.table<LeafCheck>('leafChecks').bulkPut(checks)
        }
      })
  }
}

export const db = new BookRestoreDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/**
 * 写保护：装订完成后整册锁成只读，返修交回（装订册 phase=repair）才重开。
 * 修复侧写叶 / 补纸 / 工序前调用；装订阶段判定只认装订间那本。
 */
export async function assertVolumeOpenForRepair(volumeId: string): Promise<void> {
  const bindery = await db.binderyVolumes.get(volumeId)
  // 理论上两本同生；装订本缺失（极端旧数据）时按在修放行，避免卡死
  if (bindery && bindery.phase !== 'repair') {
    throw new Error(
      bindery.phase === 'suspended'
        ? '该册对账挂起，等叶号核定；返修交回前不能修改修复档案'
        : '该册已装订完成并整册锁定，需装订间验收返修后才能继续修复'
    )
  }
}

/** 装订侧写保护：已归档的册子装订间也只能看，不再登记 / 改验收 */
export async function assertVolumeOpenForBindery(volumeId: string): Promise<void> {
  const bindery = await db.binderyVolumes.get(volumeId)
  if (bindery && bindery.phase === 'archived') {
    throw new Error('该册已归档，装订档案只读')
  }
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open()
  stampDbVersion()
  if ((await db.books.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 修复师那本 → Leaf →（Paper / RepairOrder）；装订间那本 →（Binding / LeafCheck） */

export async function seedDatabase(): Promise<void> {
  const now = Date.now()
  const day = 86400000

  const books: Book[] = [
    {
      id: 'book_01',
      title: '昌黎先生集',
      edition: '明万历刻本',
      era: '明',
      volumeCount: 2,
      collectionNo: 'GJ-0017',
      level: 'first',
      createdAt: now - day * 40,
      updatedAt: now - day * 3
    },
    {
      id: 'book_02',
      title: '梦溪笔谈',
      edition: '清乾隆写刻',
      era: '清',
      volumeCount: 1,
      collectionNo: 'GJ-0042',
      level: 'second',
      createdAt: now - day * 32,
      updatedAt: now - day * 2
    },
    {
      id: 'book_03',
      title: '重刊巢氏诸病源候总论',
      edition: '元至正刻本（残）',
      era: '元',
      volumeCount: 1,
      collectionNo: 'GJ-0008',
      level: 'first',
      createdAt: now - day * 60,
      updatedAt: now - day * 5
    }
  ]

  // —— 修复师那本：叶数与修复进度 ——
  const repairVolumes: RepairVolume[] = [
    { id: 'vol_0101', bookId: 'book_01', volumeNo: 1, leafCount: 24, repairState: 'repairing', createdAt: now - day * 38, updatedAt: now - day * 3 },
    { id: 'vol_0102', bookId: 'book_01', volumeNo: 2, leafCount: 18, repairState: 'pending', createdAt: now - day * 38, updatedAt: now - day * 6 },
    { id: 'vol_0201', bookId: 'book_02', volumeNo: 1, leafCount: 30, repairState: 'repaired', createdAt: now - day * 30, updatedAt: now - day * 2 },
    { id: 'vol_0301', bookId: 'book_03', volumeNo: 1, leafCount: 12, repairState: 'repaired', createdAt: now - day * 55, updatedAt: now - day * 5 }
  ]

  // —— 装订间那本：装订形式与交接阶段（各写各的，字段不再与修复本混用）——
  const binderyVolumes: BinderyVolume[] = [
    // vol_0101 上轮验收返修：装订本保留装订方式，册子交回修复师那本重开（phase=repair）
    {
      id: 'vol_0101', bookId: 'book_01', volumeNo: 1, bindingType: 'thread', phase: 'repair',
      checkedLeafCount: 0, reconcileStatus: 'none', reconciledAt: null,
      mismatchedLeafNos: { missing: [], extra: [] }, createdAt: now - day * 38, updatedAt: now - day * 2
    },
    {
      id: 'vol_0102', bookId: 'book_01', volumeNo: 2, bindingType: 'wrapped', phase: 'repair',
      checkedLeafCount: 0, reconcileStatus: 'none', reconciledAt: null,
      mismatchedLeafNos: { missing: [], extra: [] }, createdAt: now - day * 38, updatedAt: now - day * 6
    },
    {
      id: 'vol_0201', bookId: 'book_02', volumeNo: 1, bindingType: 'thread', phase: 'archived',
      checkedLeafCount: 2, reconcileStatus: 'passed', reconciledAt: now - day * 2,
      mismatchedLeafNos: { missing: [], extra: [] }, createdAt: now - day * 30, updatedAt: now - day * 2
    },
    {
      id: 'vol_0301', bookId: 'book_03', volumeNo: 1, bindingType: 'butterfly', phase: 'archived',
      checkedLeafCount: 2, reconcileStatus: 'passed', reconciledAt: now - day * 5,
      mismatchedLeafNos: { missing: [], extra: [] }, createdAt: now - day * 55, updatedAt: now - day * 5
    }
  ]

  const leaves: Leaf[] = [
    { id: 'leaf_010101', volumeId: 'vol_0101', leafNo: 3, damageType: 'worm', damageAreaCm2: 6.5, phValue: 6.4, state: 'repairing', createdAt: now - day * 20, updatedAt: now - day * 3 },
    { id: 'leaf_010102', volumeId: 'vol_0101', leafNo: 8, damageType: 'acid', damageAreaCm2: 12.2, phValue: 5.1, state: 'pending', createdAt: now - day * 20, updatedAt: now - day * 4 },
    { id: 'leaf_010103', volumeId: 'vol_0101', leafNo: 8, damageType: 'stain', damageAreaCm2: 4.8, phValue: 6.1, state: 'pending', createdAt: now - day * 19, updatedAt: now - day * 4 },
    { id: 'leaf_010201', volumeId: 'vol_0102', leafNo: 2, damageType: 'loss', damageAreaCm2: 9.4, phValue: 6.7, state: 'pending', createdAt: now - day * 18, updatedAt: now - day * 6 },
    { id: 'leaf_020101', volumeId: 'vol_0201', leafNo: 5, damageType: 'fibrin', damageAreaCm2: 15.6, phValue: 6.9, state: 'repaired', createdAt: now - day * 25, updatedAt: now - day * 2 },
    { id: 'leaf_020102', volumeId: 'vol_0201', leafNo: 11, damageType: 'worm', damageAreaCm2: 7.2, phValue: 6.6, state: 'repaired', createdAt: now - day * 24, updatedAt: now - day * 3 },
    { id: 'leaf_030101', volumeId: 'vol_0301', leafNo: 1, damageType: 'acid', damageAreaCm2: 20.5, phValue: 4.8, state: 'repaired', createdAt: now - day * 50, updatedAt: now - day * 5 },
    { id: 'leaf_030102', volumeId: 'vol_0301', leafNo: 6, damageType: 'loss', damageAreaCm2: 11.1, phValue: 5.6, state: 'repaired', createdAt: now - day * 49, updatedAt: now - day * 6 }
  ]

  // 已归档两册按修复师那本叶号点收（同一叶号一条 accepted）
  const leafChecks: LeafCheck[] = [
    { id: 'check_seed_0201_5', volumeId: 'vol_0201', leafNo: 5, state: 'accepted', note: '', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'check_seed_0201_11', volumeId: 'vol_0201', leafNo: 11, state: 'accepted', note: '', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'check_seed_0301_1', volumeId: 'vol_0301', leafNo: 1, state: 'accepted', note: '', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'check_seed_0301_6', volumeId: 'vol_0301', leafNo: 6, state: 'accepted', note: '', createdAt: now - day * 8, updatedAt: now - day * 5 }
  ]

  const papers: Paper[] = [
    { id: 'paper_0101', leafId: 'leaf_010101', paperType: 'bamboo', laidPattern: '二指帘纹', thicknessMm: 0.06, deltaE: 1.4, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0102', leafId: 'leaf_010101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.07, deltaE: 3.6, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'paper_0103', leafId: 'leaf_010102', paperType: 'xuan', laidPattern: '细帘纹', thicknessMm: 0.05, deltaE: 2.1, dyeRecipe: DEFAULT_DYE_RECIPE.xuan, createdAt: now - day * 12, updatedAt: now - day * 12 },
    { id: 'paper_0201', leafId: 'leaf_020101', paperType: 'bamboo', laidPattern: '三指帘纹', thicknessMm: 0.06, deltaE: 0.9, dyeRecipe: DEFAULT_DYE_RECIPE.bamboo, createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'paper_0301', leafId: 'leaf_030101', paperType: 'bark', laidPattern: '二指帘纹', thicknessMm: 0.08, deltaE: 5.2, dyeRecipe: DEFAULT_DYE_RECIPE.bark, createdAt: now - day * 45, updatedAt: now - day * 45 }
  ]

  const repairOrders: RepairOrder[] = [
    { id: 'order_010101', leafId: 'leaf_010101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '沈玉', date: '2026-03-04', state: 'done', createdAt: now - day * 16, updatedAt: now - day * 14 },
    { id: 'order_010102', leafId: 'leaf_010101', seq: 2, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-03-06', state: 'doing', createdAt: now - day * 15, updatedAt: now - day * 3 },
    { id: 'order_010103', leafId: 'leaf_010101', seq: 3, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-03-09', state: 'todo', createdAt: now - day * 15, updatedAt: now - day * 15 },
    { id: 'order_010201', leafId: 'leaf_010201', seq: 1, name: 'mend', material: '补纸 0.05mm + 小麦淀粉糊', operator: '陆敏', date: '2026-03-08', state: 'todo', createdAt: now - day * 10, updatedAt: now - day * 10 },
    { id: 'order_020101', leafId: 'leaf_020101', seq: 1, name: 'mend', material: '补纸 0.06mm + 小麦淀粉糊', operator: '陆敏', date: '2026-02-26', state: 'done', createdAt: now - day * 22, updatedAt: now - day * 20 },
    { id: 'order_020102', leafId: 'leaf_020101', seq: 2, name: 'corner', material: '溜口纸条 + 稠浆糊', operator: '陆敏', date: '2026-02-28', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 19 },
    { id: 'order_020103', leafId: 'leaf_020101', seq: 3, name: 'trim', material: '裁板 + 竹起子', operator: '陆敏', date: '2026-03-01', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 18 },
    { id: 'order_020104', leafId: 'leaf_020101', seq: 4, name: 'press', material: '压书板 + 宣纸吸水层', operator: '陆敏', date: '2026-03-02', state: 'done', createdAt: now - day * 21, updatedAt: now - day * 17 },
    { id: 'order_030101', leafId: 'leaf_030101', seq: 1, name: 'mount', material: '托纸 + 稀浆糊', operator: '沈玉', date: '2026-02-12', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 38 },
    { id: 'order_030102', leafId: 'leaf_030101', seq: 2, name: 'press', material: '压书板 + 宣纸吸水层', operator: '沈玉', date: '2026-02-15', state: 'done', createdAt: now - day * 40, updatedAt: now - day * 36 }
  ]

  const bindings: Binding[] = [
    { id: 'bind_0201', volumeId: 'vol_0201', method: '六眼线装', finishDate: '2026-03-03', verdict: 'pass', inspector: '程砚', createdAt: now - day * 3, updatedAt: now - day * 2 },
    { id: 'bind_0301', volumeId: 'vol_0301', method: '蝴蝶装复原', finishDate: '2026-02-18', verdict: 'pass', inspector: '程砚', createdAt: now - day * 8, updatedAt: now - day * 5 },
    { id: 'bind_0101', volumeId: 'vol_0101', method: '四眼线装', finishDate: '2026-03-10', verdict: 'rework', inspector: '程砚', createdAt: now - day * 2, updatedAt: now - day * 2 }
  ]

  await db.transaction(
    'rw',
    [
      db.books,
      db.repairVolumes,
      db.binderyVolumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.leafChecks
    ],
    async () => {
      await db.books.bulkPut(books)
      await db.repairVolumes.bulkPut(repairVolumes)
      await db.binderyVolumes.bulkPut(binderyVolumes)
      await db.leaves.bulkPut(leaves)
      await db.leafChecks.bulkPut(leafChecks)
      await db.papers.bulkPut(papers)
      await db.repairOrders.bulkPut(repairOrders)
      await db.bindings.bulkPut(bindings)
    }
  )
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface RestoreSnapshot {
  app: typeof DB_NAME
  schemaVersion: number
  exportedAt: string
  books: Book[]
  repairVolumes: RepairVolume[]
  binderyVolumes: BinderyVolume[]
  leaves: Leaf[]
  papers: Paper[]
  repairOrders: RepairOrder[]
  bindings: Binding[]
  leafChecks: LeafCheck[]
}

export async function exportSnapshot(): Promise<RestoreSnapshot> {
  const [books, repairVolumes, binderyVolumes, leaves, papers, repairOrders, bindings, leafChecks] =
    await Promise.all([
      db.books.toArray(),
      db.repairVolumes.toArray(),
      db.binderyVolumes.toArray(),
      db.leaves.toArray(),
      db.papers.toArray(),
      db.repairOrders.toArray(),
      db.bindings.toArray(),
      db.leafChecks.toArray()
    ])
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    repairVolumes,
    binderyVolumes,
    leaves,
    papers,
    repairOrders,
    bindings,
    leafChecks
  }
}

/** 旧版（v2）备份结构：修复 / 装订合用 volumes，无 leafChecks */
interface LegacySnapshot {
  app?: unknown
  volumes?: LegacyVolume[]
  leafChecks?: unknown
  repairVolumes?: unknown
  binderyVolumes?: unknown
}

/** 校验导入文件结构，返回错误文案（空串表示通过）；v2 旧备份放行，导入时按现状拆分回填 */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象'
  const snapshot = input as Partial<RestoreSnapshot> & LegacySnapshot
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`

  const requiredV3: Array<keyof RestoreSnapshot> = [
    'books',
    'leaves',
    'papers',
    'repairOrders',
    'bindings'
  ]
  for (const key of requiredV3) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`
  }

  const hasSplit = Array.isArray(snapshot.repairVolumes) && Array.isArray(snapshot.binderyVolumes)
  const hasLegacy = Array.isArray(snapshot.volumes)
  if (!hasSplit && !hasLegacy) return '备份文件缺少册次档案（repairVolumes/binderyVolumes 或旧版 volumes）'
  return ''
}

/**
 * 规整备份为 v3 结构：旧库数据缺归属，先按现状回填再启用（与 Dexie 升级同一套拆分逻辑）。
 */
export async function normalizeSnapshot(input: unknown): Promise<RestoreSnapshot> {
  const snapshot = input as Partial<RestoreSnapshot> & LegacySnapshot
  const base = {
    app: DB_NAME as typeof DB_NAME,
    exportedAt: new Date().toISOString(),
    books: (snapshot.books ?? []) as Book[],
    leaves: (snapshot.leaves ?? []) as Leaf[],
    papers: (snapshot.papers ?? []) as Paper[],
    repairOrders: (snapshot.repairOrders ?? []) as RepairOrder[],
    bindings: (snapshot.bindings ?? []) as Binding[]
  }

  if (Array.isArray(snapshot.repairVolumes) && Array.isArray(snapshot.binderyVolumes)) {
    return {
      ...base,
      schemaVersion: typeof snapshot.schemaVersion === 'number' ? snapshot.schemaVersion : DB_VERSION,
      repairVolumes: snapshot.repairVolumes as RepairVolume[],
      binderyVolumes: snapshot.binderyVolumes as BinderyVolume[],
      leafChecks: Array.isArray(snapshot.leafChecks) ? (snapshot.leafChecks as LeafCheck[]) : []
    }
  }

  // 旧版单本：按现状拆两本、已合格册按修复叶号回填点收
  const legacyVolumes = (snapshot.volumes ?? []) as LegacyVolume[]
  const now = Date.now()
  const repairVolumes: RepairVolume[] = []
  const binderyVolumes: BinderyVolume[] = []
  const leafChecks: LeafCheck[] = []
  for (const legacy of legacyVolumes) {
    const leafNos = base.leaves
      .filter((leaf) => leaf.volumeId === legacy.id)
      .map((leaf) => leaf.leafNo)
    const split = splitLegacyVolume(legacy, leafNos, now)
    repairVolumes.push(split.repair)
    binderyVolumes.push(split.bindery)
    leafChecks.push(...split.checks)
  }
  return {
    ...base,
    schemaVersion: DB_VERSION,
    repairVolumes,
    binderyVolumes,
    leafChecks
  }
}

export async function importSnapshot(snapshot: RestoreSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.repairVolumes,
      db.binderyVolumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.leafChecks
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.repairVolumes.clear(),
        db.binderyVolumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.leafChecks.clear()
      ])
      await db.books.bulkPut(snapshot.books)
      await db.repairVolumes.bulkPut(snapshot.repairVolumes)
      await db.binderyVolumes.bulkPut(snapshot.binderyVolumes)
      await db.leaves.bulkPut(snapshot.leaves)
      await db.papers.bulkPut(snapshot.papers)
      await db.repairOrders.bulkPut(snapshot.repairOrders)
      await db.bindings.bulkPut(snapshot.bindings)
      await db.leafChecks.bulkPut(snapshot.leafChecks)
    }
  )
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.books,
      db.repairVolumes,
      db.binderyVolumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.leafChecks
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.repairVolumes.clear(),
        db.binderyVolumes.clear(),
        db.leaves.clear(),
        db.papers.clear(),
        db.repairOrders.clear(),
        db.bindings.clear(),
        db.leafChecks.clear()
      ])
    }
  )
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [books, repairVolumes, binderyVolumes, leaves, papers, repairOrders, bindings, leafChecks] =
    await Promise.all([
      db.books.count(),
      db.repairVolumes.count(),
      db.binderyVolumes.count(),
      db.leaves.count(),
      db.papers.count(),
      db.repairOrders.count(),
      db.bindings.count(),
      db.leafChecks.count()
    ])
  return { books, repairVolumes, binderyVolumes, leaves, papers, repairOrders, bindings, leafChecks }
}

/** 级联删除古籍 → 两本册子 → 书叶 → 补纸 / 工序 / 装订 / 点收 */
export async function removeBookCascade(bookId: string): Promise<void> {
  const volumeIds = (await db.repairVolumes.where('bookId').equals(bookId).toArray()).map((row) => row.id)
  const leafIds = volumeIds.length
    ? (await db.leaves.where('volumeId').anyOf(volumeIds).toArray()).map((row) => row.id)
    : []
  await db.transaction(
    'rw',
    [
      db.books,
      db.repairVolumes,
      db.binderyVolumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.leafChecks
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      if (volumeIds.length > 0) {
        await db.leaves.where('volumeId').anyOf(volumeIds).delete()
        await db.bindings.where('volumeId').anyOf(volumeIds).delete()
        await db.leafChecks.where('volumeId').anyOf(volumeIds).delete()
      }
      await db.repairVolumes.where('bookId').equals(bookId).delete()
      await db.binderyVolumes.where('bookId').equals(bookId).delete()
      await db.books.delete(bookId)
    }
  )
}

/** 级联删除册次 → 两本册子 + 书叶 → 补纸 / 工序 / 装订 / 点收 */
export async function removeVolumeCascade(volumeId: string): Promise<void> {
  const leafIds = (await db.leaves.where('volumeId').equals(volumeId).toArray()).map((row) => row.id)
  await db.transaction(
    'rw',
    [
      db.repairVolumes,
      db.binderyVolumes,
      db.leaves,
      db.papers,
      db.repairOrders,
      db.bindings,
      db.leafChecks
    ],
    async () => {
      if (leafIds.length > 0) {
        await db.papers.where('leafId').anyOf(leafIds).delete()
        await db.repairOrders.where('leafId').anyOf(leafIds).delete()
      }
      await db.leaves.where('volumeId').equals(volumeId).delete()
      await db.bindings.where('volumeId').equals(volumeId).delete()
      await db.leafChecks.where('volumeId').equals(volumeId).delete()
      await db.repairVolumes.delete(volumeId)
      await db.binderyVolumes.delete(volumeId)
    }
  )
}

/** 级联删除书叶 → 补纸 / 工序（修复师那本上的资料；装订点收不跟着删，留作对账凭证） */
export async function removeLeafCascade(leafId: string): Promise<void> {
  await db.transaction('rw', [db.leaves, db.papers, db.repairOrders], async () => {
    await db.papers.where('leafId').equals(leafId).delete()
    await db.repairOrders.where('leafId').equals(leafId).delete()
    await db.leaves.delete(leafId)
  })
}

/** 开新册：同一身份在两本上各立一页（事务保证同生） */
export async function createVolumePair(
  repair: RepairVolume,
  bindery: BinderyVolume
): Promise<void> {
  await db.transaction('rw', [db.repairVolumes, db.binderyVolumes], async () => {
    await db.repairVolumes.put(repair)
    await db.binderyVolumes.put(bindery)
  })
}
