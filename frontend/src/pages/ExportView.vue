<script setup lang="ts">
/**
 * /export 装订还原与验收归档（装订间那本）
 * 登记装订方式、验收人、验收结论与逐叶点收：
 * - 验收合格 → 装订完成，两本册锁成只读（修复师那本也一起锁）
 * - 验收返修 → 把册子交回修复师那本重开（修复侧恢复可写）
 * - 归档前对账：叶数 / 工序进度只看修复师那本，装订方式 / 验收结论只看装订间那本；
 *   同一叶两边对不上 → 挂起并把叶号摆出来等人定；失败后按本侧重试，修复师那本不动。
 * 另含 JSON 结构版本导入导出（自动兼容 v2 单本备份）。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Delete,
  Download,
  Edit,
  Plus,
  Refresh,
  Upload,
  Connection,
  RefreshRight
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLeafStats } from '@/hooks/useLeafStats'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { useBinderyStore } from '@/stores/binderyStore'
import {
  BINDING_METHOD_OPTIONS,
  BINDING_VERDICT_LABEL,
  BINDING_VERDICT_OPTIONS,
  createEmptyBindingDraft,
  type BindingDraft,
  type BindingVerdict
} from '@/types/binding'
import {
  BINDERY_PHASE_COLOR,
  BINDERY_PHASE_LABEL,
  RECONCILE_STATUS_COLOR,
  RECONCILE_STATUS_LABEL,
  type BinderyVolume
} from '@/types/binderyVolume'
import {
  LEAF_CHECK_STATE_LABEL,
  LEAF_CHECK_STATE_OPTIONS,
  type LeafCheckState
} from '@/types/leafCheck'
import { BINDING_TYPE_LABEL, isVolumeLocked } from '@/types/volume'
import type { Paper } from '@/types/paper'
import type { ReconcileResult } from '@/utils/reconcile'
import {
  DB_NAME,
  DB_VERSION,
  exportSnapshot,
  importSnapshot,
  normalizeSnapshot,
  readLastBackupAt,
  resetDatabase,
  validateSnapshot,
  writeLastBackupAt,
  type RestoreSnapshot
} from '@/utils/db'
import {
  buildArchiveReport,
  copyText,
  exportArchiveReport,
  exportLeafLedgerCsv,
  exportSnapshotJson
} from '@/utils/export'

const bookStore = useBookStore()
const leafStore = useLeafStore()
const repairStore = useRepairStore()
const binderyStore = useBinderyStore()
const { totals, statOf } = useLeafStats()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const fileInput = ref<HTMLInputElement | null>(null)
const lastBackupAt = ref<string | null>(readLastBackupAt())

const volumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => ({
      value: volume.id,
      label: `《${book.title}》第 ${volume.volumeNo} 册 · ${BINDING_TYPE_LABEL[volume.bindingType]} · ${BINDERY_PHASE_LABEL[volume.phase]}`,
      locked: isVolumeLocked(volume.phase)
    }))
  )
)

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

const stat = computed(() => {
  const list = binderyStore.bindings
  const pass = list.filter((item) => item.verdict === 'pass').length
  return {
    total: list.length,
    pass,
    rework: list.length - pass,
    passPercent: list.length === 0 ? 0 : Math.round((pass / list.length) * 100),
    archived: binderyStore.archivedCount,
    pendingBinding: binderyStore.pendingBindingCount,
    suspended: binderyStore.suspendedCount
  }
})

const context = computed(() => ({
  books: bookStore.books,
  volumes: bookStore.volumes,
  leaves: leafStore.leaves,
  papers: paperTable.rows.value,
  repairOrders: repairStore.orders,
  bindings: binderyStore.bindings,
  leafChecks: binderyStore.checks
}))

const archiveText = computed(() => buildArchiveReport(context.value))

/* ----------------------------- 验收登记（只写装订本） ----------------------------- */
const dialog = ref(false)
const editing = ref<BinderyVolume | null>(null)
const form = reactive<BindingDraft>(createEmptyBindingDraft(''))

function openCreate(): void {
  const first = volumeOptions.value.find((item) => !item.locked)
  if (!first) {
    ElMessage.warning('没有可登记验收的册次（未归档且不在挂起）')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyBindingDraft(first.value))
  dialog.value = true
}

function openEdit(bindery: BinderyVolume): void {
  if (bindery.phase === 'archived') {
    ElMessage.warning('该册已归档，验收记录只读')
    return
  }
  editing.value = bindery
  const binding = binderyStore.bindingOfVolume(bindery.id)
  Object.assign(form, {
    volumeId: bindery.id,
    method: binding?.method ?? BINDING_METHOD_OPTIONS[0],
    finishDate: binding?.finishDate ?? new Date().toISOString().slice(0, 10),
    verdict: binding?.verdict ?? 'pass',
    inspector: binding?.inspector ?? ''
  })
  dialog.value = true
}

async function submit(): Promise<void> {
  if (!form.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  try {
    await binderyStore.submitVerdict(form.volumeId, {
      method: form.method,
      finishDate: form.finishDate,
      verdict: form.verdict,
      inspector: form.inspector
    })
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '验收登记失败')
    return
  }
  if (form.verdict === 'pass') {
    ElMessage.success('验收合格，装订完成：两本册锁成只读，请做归档前对账')
  } else {
    ElMessage.success('已登记返修，册子交回修复师那本重开')
  }
  dialog.value = false
}

async function remove(bindery: BinderyVolume): Promise<void> {
  if (bindery.phase === 'archived') {
    ElMessage.warning('该册已归档，不能删除验收记录')
    return
  }
  try {
    await ElMessageBox.confirm('删除验收记录后装订册回到待装订，修复师那本不受影响。', '删除验收记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await binderyStore.removeBinding(bindery.id)
  ElMessage.success('已删除')
}

/* ----------------------------- 逐叶点收（装订侧） ----------------------------- */
const checkDialog = ref(false)
const checkVolume = ref<BinderyVolume | null>(null)
const checkForm = reactive({ leafNo: 1, state: 'accepted' as LeafCheckState, note: '' })

function openChecks(bindery: BinderyVolume): void {
  checkVolume.value = bindery
  checkForm.leafNo = repairLeafNos(bindery.id)[0] ?? 1
  checkForm.state = 'accepted'
  checkForm.note = ''
  checkDialog.value = true
}

/** 修复师那本的叶号（只读口径，给点收页对照） */
function repairLeafNos(volumeId: string): number[] {
  return Array.from(
    new Set(
      leafStore.leaves
        .filter((leaf) => leaf.volumeId === volumeId)
        .map((leaf) => leaf.leafNo)
    )
  ).sort((a, b) => a - b)
}

async function submitCheck(): Promise<void> {
  if (!checkVolume.value) return
  try {
    await binderyStore.upsertCheck(
      checkVolume.value.id,
      checkForm.leafNo,
      checkForm.state,
      checkForm.note
    )
    ElMessage.success(`已点收第 ${checkForm.leafNo} 叶`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '点收失败')
  }
}

async function removeCheck(volumeId: string, leafNo: number): Promise<void> {
  await binderyStore.removeCheck(volumeId, leafNo)
  ElMessage.success(`已撤销第 ${leafNo} 叶点收`)
}

/** 一键按修复师那本叶号全部点为「已收到」（装订侧自己的动作，不写修复本） */
async function acceptAllFromRepair(bindery: BinderyVolume): Promise<void> {
  const leafNos = repairLeafNos(bindery.id)
  if (leafNos.length === 0) {
    ElMessage.warning('修复师那本还没有任何叶号')
    return
  }
  for (const leafNo of leafNos) {
    await binderyStore.upsertCheck(bindery.id, leafNo, 'accepted', '')
  }
  ElMessage.success(`已按修复师那本点收 ${leafNos.length} 叶`)
}

/* ----------------------------- 归档前对账 ----------------------------- */
const reconcileResult = ref<ReconcileResult | null>(null)
const reconcilingId = ref('')

async function runReconcile(bindery: BinderyVolume): Promise<void> {
  reconcilingId.value = bindery.id
  try {
    const result = await binderyStore.reconcile(bindery.id)
    reconcileResult.value = result
    if (result.canArchive) {
      ElMessage.success('对账通过，已归档（两本册只读）')
    } else if (result.suspend) {
      ElMessage.error(`叶号对不上，第 ${[...result.missingLeafNos, ...result.extraLeafNos].join('、')} 叶挂起等人定`)
    } else if (result.needRework) {
      ElMessage.warning('装订侧核对完，但工序未完 / 验收返修，册子交回修复师重开')
    } else {
      ElMessage.warning('还不能归档，请按对账提示处理')
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '对账失败')
  } finally {
    reconcilingId.value = ''
  }
}

/** 核对失败后装订间按本侧重试：只改点收 / 装订册，修复师那本不动 */
async function retryReconcile(bindery: BinderyVolume): Promise<void> {
  reconcilingId.value = bindery.id
  try {
    const result = await binderyStore.retryReconcile(bindery.id)
    reconcileResult.value = result
    if (result.canArchive) ElMessage.success('重试对账通过，已归档')
    else if (result.suspend) ElMessage.error('仍然对不上，继续挂起')
    else ElMessage.warning('重试完成，但仍未满足归档条件')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重试失败')
  } finally {
    reconcilingId.value = ''
  }
}

async function handBack(bindery: BinderyVolume): Promise<void> {
  await binderyStore.handBackForRework(bindery.id)
  ElMessage.success('挂起册已交回修复师那本重开（修复数据由修复师处理）')
}

/* ----------------------------- 数据导入导出 ----------------------------- */
async function handleExport(): Promise<void> {
  const snapshot = await exportSnapshot()
  const filename = exportSnapshotJson(snapshot)
  const stamp = new Date().toISOString()
  writeLastBackupAt(stamp)
  lastBackupAt.value = stamp
  ElMessage.success(`已导出 ${filename}（结构版本 v${snapshot.schemaVersion}）`)
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function handleFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ElMessage.error('JSON 解析失败，请确认文件格式')
    return
  }
  const invalid = validateSnapshot(parsed)
  if (invalid) {
    ElMessage.error(invalid)
    return
  }
  try {
    await ElMessageBox.confirm('导入会清空当前浏览器中的全部档案，再写入备份内容，不可撤销。', '覆盖导入本地数据', {
      type: 'warning',
      confirmButtonText: '确认导入',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  // 旧版（v2 单本）备份：缺归属先按现状回填拆两本再启用
  const snapshot: RestoreSnapshot = await normalizeSnapshot(parsed)
  await importSnapshot(snapshot)
  await Promise.all([
    bookStore.loadBooks(),
    binderyStore.loadAll(),
    leafStore.loadLeaves(),
    repairStore.loadOrders()
  ])
  ElMessage.success(`导入完成（已按 v${snapshot.schemaVersion} 结构就绪），数据已覆盖`)
}

async function handleReset(): Promise<void> {
  try {
    await ElMessageBox.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。', '清空重播种', {
      type: 'warning',
      confirmButtonText: '确认重置',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await resetDatabase()
  await Promise.all([
    bookStore.loadBooks(),
    binderyStore.loadAll(),
    leafStore.loadLeaves(),
    repairStore.loadOrders()
  ])
  ElMessage.success('已清空并重新载入演示数据')
}

async function copyArchive(): Promise<void> {
  const ok = await copyText(archiveText.value)
  if (ok) ElMessage.success('归档清单已复制到剪贴板')
  else ElMessage.warning('浏览器未授权剪贴板')
}

function verdictLabel(verdict: string): string {
  return BINDING_VERDICT_LABEL[verdict as BindingVerdict] ?? verdict
}

function phaseLabel(phase: string): string {
  return BINDERY_PHASE_LABEL[phase as keyof typeof BINDERY_PHASE_LABEL] ?? phase
}

function phaseColor(phase: string): string {
  return BINDERY_PHASE_COLOR[phase as keyof typeof BINDERY_PHASE_COLOR] ?? '#6b6257'
}

function statusLabel(status: string): string {
  return RECONCILE_STATUS_LABEL[status as keyof typeof RECONCILE_STATUS_LABEL] ?? status
}

function statusColor(status: string): string {
  return RECONCILE_STATUS_COLOR[status as keyof typeof RECONCILE_STATUS_COLOR] ?? '#6b6257'
}

function checkStateLabel(state: string): string {
  return LEAF_CHECK_STATE_LABEL[state as LeafCheckState] ?? state
}

/** 表格行：装订册 + 最新验收 + 修复侧只读统计 */
const rows = computed(() =>
  binderyStore.volumes.map((bindery) => {
    const binding = binderyStore.bindingOfVolume(bindery.id)
    const leafStat = statOf(bindery.id)
    return { bindery, binding, leafStat }
  })
)
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>装订还原与验收归档（装订间那本）</h2>
        <p>
          本地库 {{ DB_NAME }} · 结构版本 v{{ DB_VERSION }}
          <span class="gb-muted">{{ lastBackupAt ? `· 最近导出 ${new Date(lastBackupAt).toLocaleString('zh-CN')}` : '· 尚未导出备份' }}</span>
        </p>
      </div>
      <div class="gb-toolbar">
        <el-button :icon="Download" @click="handleExport">导出 JSON</el-button>
        <el-button :icon="Upload" @click="triggerImport">导入 JSON</el-button>
        <el-button type="danger" plain :icon="Refresh" @click="handleReset">清空重播种</el-button>
        <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="handleFile" />
      </div>
    </div>

    <div class="gb-stat-row">
      <StatBadge label="验收记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="验收合格率" :value="`${stat.passPercent}%`" :percent="stat.passPercent" tone="success" />
      <StatBadge label="返修" :value="stat.rework" suffix="条" tone="danger" />
      <StatBadge label="已归档册次" :value="stat.archived" suffix="册" tone="info" />
      <StatBadge label="待装订册次" :value="stat.pendingBinding" suffix="册" tone="warning" />
      <StatBadge label="对账挂起" :value="stat.suspended" suffix="册" tone="danger" />
      <StatBadge label="工序完成率（修复本）" :value="`${totals.orderPercent}%`" :percent="totals.orderPercent" />
    </div>

    <el-card shadow="never">
      <template #header>
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span>装订验收与归档对账</span>
          <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新增验收</el-button>
        </div>
      </template>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有册次"
        description="先在古籍台账开册（修复 / 装订各立一本），修复完成后这里登记装订与验收。"
        size="small"
      />

      <el-table v-else :data="rows" size="small" border>
        <el-table-column label="册次" min-width="170">
          <template #default="{ row }">{{ volumeLabel(row.bindery.id) }}</template>
        </el-table-column>
        <el-table-column label="阶段（装订本）" width="140">
          <template #default="{ row }">
            <el-tag
              :style="{ color: phaseColor(row.bindery.phase), borderColor: `${phaseColor(row.bindery.phase)}66` }"
              effect="plain"
              round
            >
              {{ phaseLabel(row.bindery.phase) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="叶数（修复/点收）" width="130">
          <template #default="{ row }">
            {{ row.bindery.phase === 'repair' ? '—' : `${row.leafStat.leafCount} / ${row.bindery.checkedLeafCount}` }}
          </template>
        </el-table-column>
        <el-table-column label="工序（修复本）" width="100">
          <template #default="{ row }">
            {{ row.leafStat.orderDoneCount }}/{{ row.leafStat.orderCount }}
          </template>
        </el-table-column>
        <el-table-column label="验收" min-width="220">
          <template #default="{ row }">
            <template v-if="row.binding">
              {{ row.binding.method }} · {{ verdictLabel(row.binding.verdict) }} · {{ row.binding.inspector || '验收人未填' }}
            </template>
            <span v-else class="gb-muted">尚未验收</span>
          </template>
        </el-table-column>
        <el-table-column label="对账" width="120">
          <template #default="{ row }">
            <el-tag
              :style="{ color: statusColor(row.bindery.reconcileStatus), borderColor: `${statusColor(row.bindery.reconcileStatus)}66` }"
              effect="plain"
              size="small"
              round
            >
              {{ statusLabel(row.bindery.reconcileStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="300">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="primary"
              :icon="Connection"
              :disabled="row.bindery.phase === 'archived'"
              @click="openChecks(row.bindery)"
            >
              逐叶点收
            </el-button>
            <el-button
              size="small"
              text
              type="success"
              :loading="reconcilingId === row.bindery.id"
              :disabled="row.bindery.phase === 'repair' || row.bindery.phase === 'archived'"
              @click="runReconcile(row.bindery)"
            >
              {{ row.bindery.phase === 'suspended' ? '查看挂起' : '归档对账' }}
            </el-button>
            <el-button size="small" text :icon="Edit" :disabled="row.bindery.phase === 'archived'" @click="openEdit(row.bindery)">验收</el-button>
            <el-button size="small" text type="danger" :icon="Delete" :disabled="row.bindery.phase === 'archived'" @click="remove(row.bindery)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 挂起册的叶号清单：摆出来等人定 -->
      <div
        v-for="bindery in binderyStore.volumes.filter((item) => item.phase === 'suspended')"
        :key="`sus-${bindery.id}`"
        class="gb-suspend-box"
      >
        <el-alert type="error" show-icon :closable="false" style="margin-bottom: 8px">
          <template #title>
            《{{ bookStore.bookById(bindery.bookId)?.title ?? '未知古籍' }}》第 {{ bindery.volumeNo }} 册对账挂起，等叶号核定
          </template>
          <template #default>
            <div v-if="bindery.mismatchedLeafNos.missing.length">
              修复师那本有、装订点收缺叶：
              <el-tag v-for="no in bindery.mismatchedLeafNos.missing" :key="`m-${no}`" type="danger" effect="plain" round style="margin: 2px">
                第 {{ no }} 叶
              </el-tag>
            </div>
            <div v-if="bindery.mismatchedLeafNos.extra.length">
              装订点收有、修复师那本无：
              <el-tag v-for="no in bindery.mismatchedLeafNos.extra" :key="`e-${no}`" type="warning" effect="plain" round style="margin: 2px">
                第 {{ no }} 叶
              </el-tag>
            </div>
            <div class="gb-toolbar" style="margin-top: 8px">
              <el-button size="small" type="primary" :loading="reconcilingId === bindery.id" @click="openChecks(bindery)">
                改本侧点收
              </el-button>
              <el-button size="small" :icon="RefreshRight" :loading="reconcilingId === bindery.id" @click="retryReconcile(bindery)">
                按本侧重试对账（修复师那本不动）
              </el-button>
              <el-button size="small" type="warning" plain @click="handBack(bindery)">
                核定后交回修复师重开
              </el-button>
            </div>
          </template>
        </el-alert>
      </div>
    </el-card>

    <!-- 最近一次对账结论 -->
    <el-card v-if="reconcileResult" shadow="never" style="margin-top: 16px">
      <template #header>最近一次对账结论（{{ reconcileResult.canArchive ? '通过归档' : reconcileResult.suspend ? '挂起' : '未通过' }}）</template>
      <ul style="margin: 0; padding-left: 18px">
        <li v-for="(msg, index) in reconcileResult.messages" :key="index" style="margin-bottom: 4px">{{ msg }}</li>
      </ul>
    </el-card>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :xs="24" :xl="10">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>归档清单</span>
              <div>
                <el-button size="small" :icon="Download" @click="exportArchiveReport(context)">导出清单</el-button>
                <el-button size="small" @click="copyArchive">复制</el-button>
              </div>
            </div>
          </template>
          <pre style="max-height: 320px; overflow: auto; font-size: 12px; margin: 0; white-space: pre-wrap">{{ archiveText }}</pre>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>整库导出</template>
          <p class="gb-muted">
            导出文件包含 8 张业务表（含修复 / 装订两本册与逐叶点收）全量数据与结构版本号；导入旧版 v2 备份时会先按现状把旧单本拆成两本再启用。
          </p>
          <div class="gb-toolbar">
            <el-button :icon="Download" @click="handleExport">JSON 备份</el-button>
            <el-button @click="exportLeafLedgerCsv(context)">书叶破损台账 CSV</el-button>
          </div>
          <el-alert
            style="margin-top: 10px"
            type="info"
            show-icon
            :closable="false"
            title="无状态容器"
            description="服务端不保存任何数据；清理浏览器站点数据会丢失档案，请定期导出备份。"
          />
        </el-card>
      </el-col>
    </el-row>

    <!-- 验收登记对话框 -->
    <el-dialog v-model="dialog" :title="editing ? '编辑装订验收' : '新增装订验收'" width="560px">
      <el-form label-width="100px">
        <el-form-item label="册次" required>
          <el-select v-model="form.volumeId" style="width: 100%" :disabled="!!editing">
            <el-option v-for="item in volumeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="装订方式" required>
          <el-select v-model="form.method" style="width: 100%">
            <el-option v-for="item in BINDING_METHOD_OPTIONS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="完工日期">
          <el-input v-model="form.finishDate" type="date" />
        </el-form-item>
        <el-form-item label="验收结论" required>
          <el-select v-model="form.verdict" style="width: 100%">
            <el-option v-for="item in BINDING_VERDICT_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="验收人">
          <el-input v-model="form.inspector" placeholder="如：程砚" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="form.verdict === 'pass'"
        type="success"
        show-icon
        :closable="false"
        title="验收合格：装订完成，两本册锁成只读，随后须做归档前对账"
      />
      <el-alert
        v-else
        type="warning"
        show-icon
        :closable="false"
        title="验收返修：册子交回修复师那本重开，修复师可继续改破损 / 补纸 / 工序"
      />
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 逐叶点收对话框（装订侧） -->
    <el-dialog v-model="checkDialog" title="逐叶点收（装订间那本）" width="680px">
      <div v-if="checkVolume">
        <el-alert
          type="info"
          show-icon
          :closable="false"
          style="margin-bottom: 10px"
          :title="`修复师那本叶号（只读）：${repairLeafNos(checkVolume.id).join('、') || '暂无叶号'}`"
          description="点收只写装订间这一本；同一叶两边对不上时归档对账会挂起该册。"
        />
        <el-form :inline="true" label-width="70px">
          <el-form-item label="叶号">
            <el-input-number v-model="checkForm.leafNo" :min="1" :max="999" />
          </el-form-item>
          <el-form-item label="点收">
            <el-select v-model="checkForm.state" style="width: 120px">
              <el-option v-for="item in LEAF_CHECK_STATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="checkForm.note" placeholder="缺 / 多原因（可空）" style="width: 180px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="submitCheck">登记 / 更新</el-button>
            <el-button @click="acceptAllFromRepair(checkVolume)">按修复本全部点收</el-button>
          </el-form-item>
        </el-form>

        <el-table :data="binderyStore.checksOfVolume(checkVolume.id)" size="small" border>
          <el-table-column prop="leafNo" label="叶号" width="80" sortable />
          <el-table-column label="点收状态" width="110">
            <template #default="{ row }">{{ checkStateLabel(row.state) }}</template>
          </el-table-column>
          <el-table-column prop="note" label="备注" />
          <el-table-column label="修复本对照" width="120">
            <template #default="{ row }">
              <el-tag
                v-if="repairLeafNos(checkVolume.id).includes(row.leafNo)"
                type="success"
                size="small"
                effect="plain"
                round
              >
                修复本有
              </el-tag>
              <el-tag v-else type="danger" size="small" effect="plain" round>修复本无</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button size="small" text type="danger" @click="removeCheck(checkVolume.id, row.leafNo)">撤销</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="checkDialog = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.gb-suspend-box {
  margin-top: 12px;
}
</style>
