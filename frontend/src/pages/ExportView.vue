<script setup lang="ts">
/**
 * /export 装订还原与验收归档 —— 装订间那本
 * 装订间单独记账：装订方式、验收结论、验收人与叶号签收。验收合格触发两边对账，
 * 对账通过整册归档（修复师那本锁成只读）；对账失败装订间按本侧重试一遍，仍不符则挂起并摆出叶号；
 * 返修则把册子交回修复师那本重开。支持 JSON 结构版本导入导出。
 * 消费 Binding 及全部模型；复用 <StatBadge>、<EmptyPanel>、<DamageTag>。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Download, Edit, Plus, Refresh, Upload } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLeafStats } from '@/hooks/useLeafStats'
import { useBookStore } from '@/stores/bookStore'
import { useLeafStore } from '@/stores/leafStore'
import { useRepairStore } from '@/stores/repairStore'
import { useBindingStore } from '@/stores/bindingStore'
import {
  BINDING_METHOD_OPTIONS,
  BINDING_STATUS_COLOR,
  BINDING_STATUS_LABEL,
  BINDING_VERDICT_COLOR,
  BINDING_VERDICT_LABEL,
  BINDING_VERDICT_OPTIONS,
  createEmptyBindingDraft,
  type Binding,
  type BindingDraft,
  type BindingStatus,
  type BindingVerdict
} from '@/types/binding'
import { VOLUME_STATE_LABEL } from '@/types/volume'
import type { Paper } from '@/types/paper'
import { distinctLeafNos, formatReconcileResult, reconcileVolume } from '@/utils/reconcile'
import {
  DB_NAME,
  DB_VERSION,
  exportSnapshot,
  importSnapshot,
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
const bindingStore = useBindingStore()
const { totals } = useLeafStats()
const paperTable = useIdbTable<Paper>((database) => database.papers, { sortByUpdatedAt: false })

const fileInput = ref<HTMLInputElement | null>(null)
const lastBackupAt = ref<string | null>(readLastBackupAt())

const volumeOptions = computed(() =>
  bookStore.books.flatMap((book) =>
    bookStore.volumesOfBook(book.id).map((volume) => {
      const binding = bindingStore.bindingOfVolume(volume.id)
      const stateKey = bindingStore.isVolumeLocked(volume.id) ? 'archived' : volume.state
      return {
        value: volume.id,
        label: `《${book.title}》第 ${volume.volumeNo} 册 · ${binding?.method ?? '未装订'} · ${VOLUME_STATE_LABEL[stateKey]}`,
        locked: bindingStore.isVolumeLocked(volume.id)
      }
    })
  )
)

function volumeLabel(volumeId: string): string {
  const volume = bookStore.volumeById(volumeId)
  if (!volume) return '册次已删除'
  const book = bookStore.bookById(volume.bookId)
  return `${book ? `《${book.title}》` : ''}第 ${volume.volumeNo} 册`
}

const stat = computed(() => {
  const list = bindingStore.bindings
  const pass = list.filter((item) => item.verdict === 'pass').length
  const rework = list.filter((item) => item.verdict === 'rework').length
  const suspended = list.filter((item) => item.status === 'suspended').length
  const archived = list.filter((item) => item.status === 'archived').length
  const pendingBinding = bookStore.volumes.filter((volume) => !bindingStore.isVolumeLocked(volume.id)).length
  return {
    total: list.length,
    pass,
    rework,
    suspended,
    passPercent: list.length === 0 ? 0 : Math.round((pass / list.length) * 100),
    archived,
    pendingBinding
  }
})

const context = computed(() => ({
  books: bookStore.books,
  volumes: bookStore.volumes,
  leaves: leafStore.leaves,
  papers: paperTable.rows.value,
  repairOrders: repairStore.orders,
  bindings: bindingStore.bindings
}))

const archiveText = computed(() => buildArchiveReport(context.value))

/** 挂起的装订记录（对账叶号不符） */
const suspendedBindings = computed(() => bindingStore.bindings.filter((item) => item.status === 'suspended'))

function suspendedText(binding: Binding): string {
  const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === binding.volumeId)
  const leafIds = new Set(leaves.map((leaf) => leaf.id))
  const orders = repairStore.orders.filter((order) => leafIds.has(order.leafId))
  const result = reconcileVolume({ volumeId: binding.volumeId, leaves, orders, binding })
  return formatReconcileResult(result)
}

/* ----------------------------- 装订表单 ----------------------------- */
const dialog = ref(false)
const editing = ref<Binding | null>(null)
const form = reactive<BindingDraft>(createEmptyBindingDraft(''))
const extraLeafNo = ref(1)
/** 编辑既有记录时，册次变化的 watch 不要覆盖已保存的叶号签收清单 */
const suppressLeafSync = ref(false)

/** 修复师那本该册的叶号（对账基准） */
const restorerLeafNos = computed(() =>
  form.volumeId ? distinctLeafNos(leafStore.leaves.filter((leaf) => leaf.volumeId === form.volumeId)) : []
)
/** 装订间签收了、但修复师账上没有的叶号 */
const extraLeafNos = computed(() =>
  form.leafChecks.filter((check) => !restorerLeafNos.value.includes(check.leafNo)).map((check) => check.leafNo)
)

/** 选册变化时，按修复师那本的叶号现状带出装订间签收清单（保留已勾选状态） */
function syncLeafChecks(volumeId: string): void {
  const restorerNos = distinctLeafNos(leafStore.leaves.filter((leaf) => leaf.volumeId === volumeId))
  const received = new Map(form.leafChecks.map((check) => [check.leafNo, check.received]))
  form.leafChecks = restorerNos.map((leafNo) => ({ leafNo, received: received.get(leafNo) ?? true }))
}

watch(
  () => form.volumeId,
  (volumeId) => {
    if (suppressLeafSync.value) return
    if (volumeId) syncLeafChecks(volumeId)
  }
)

function isReceived(leafNo: number): boolean {
  return form.leafChecks.find((check) => check.leafNo === leafNo)?.received ?? false
}

function toggleLeaf(leafNo: number, received: boolean): void {
  const index = form.leafChecks.findIndex((check) => check.leafNo === leafNo)
  if (index >= 0) form.leafChecks[index].received = received
  else form.leafChecks.push({ leafNo, received })
}

function addExtraLeaf(): void {
  if (!extraLeafNo.value || extraLeafNo.value < 1) return
  if (form.leafChecks.some((check) => check.leafNo === extraLeafNo.value)) {
    ElMessage.info(`第 ${extraLeafNo.value} 叶已在签收清单中`)
    return
  }
  form.leafChecks.push({ leafNo: extraLeafNo.value, received: true })
  extraLeafNo.value += 1
}

function removeExtraLeaf(leafNo: number): void {
  form.leafChecks = form.leafChecks.filter((check) => check.leafNo !== leafNo)
}

/** 对话框内实时预览对账结果（只提示叶号差异） */
const leafMismatchText = computed(() => {
  if (!form.volumeId) return ''
  const leaves = leafStore.leaves.filter((leaf) => leaf.volumeId === form.volumeId)
  const leafIds = new Set(leaves.map((leaf) => leaf.id))
  const orders = repairStore.orders.filter((order) => leafIds.has(order.leafId))
  const result = reconcileVolume({
    volumeId: form.volumeId,
    leaves,
    orders,
    binding: { ...form, id: editing.value?.id ?? '', createdAt: 0, updatedAt: 0 } as Binding
  })
  if (result.leafMatchPass) return ''
  const parts: string[] = []
  if (result.mismatch.missingInBinding.length > 0) {
    parts.push(`第 ${result.mismatch.missingInBinding.join('、')} 叶（修复师有、装订间未签收）`)
  }
  if (result.mismatch.missingInRestorer.length > 0) {
    parts.push(`第 ${result.mismatch.missingInRestorer.join('、')} 叶（装订间签收、修复师账上无）`)
  }
  return `叶号对不上：${parts.join('；')}，提交后将挂起该册并摆出叶号等人定`
})

function openCreate(): void {
  const first = volumeOptions.value[0]
  if (!first) {
    ElMessage.warning('请先登记古籍与册次')
    return
  }
  editing.value = null
  Object.assign(form, createEmptyBindingDraft(first.value))
  syncLeafChecks(first.value)
  dialog.value = true
}

function openEdit(binding: Binding): void {
  editing.value = binding
  suppressLeafSync.value = true
  Object.assign(form, {
    volumeId: binding.volumeId,
    method: binding.method,
    finishDate: binding.finishDate,
    verdict: binding.verdict ?? 'pass',
    inspector: binding.inspector,
    status: binding.status,
    leafChecks: binding.leafChecks.map((check) => ({ ...check }))
  })
  // watch 在下次渲染前触发，随后再恢复同步能力
  void nextTick(() => {
    suppressLeafSync.value = false
  })
  dialog.value = true
}

async function submit(): Promise<void> {
  if (!form.volumeId) {
    ElMessage.warning('请选择册次')
    return
  }
  const result = await bindingStore.submitBinding({
    id: editing.value?.id,
    volumeId: form.volumeId,
    method: form.method,
    finishDate: form.finishDate,
    verdict: form.verdict ?? 'pass',
    inspector: form.inspector,
    leafChecks: form.leafChecks
  })
  if (result.rework) {
    ElMessage.success('已登记验收返修，册子交回修复师那本重开')
  } else if (result.archived) {
    ElMessage.success('两边对账通过，已验收归档，整册锁定为只读')
  } else if (result.suspended && result.result) {
    ElMessage.warning(`对账未通过，已挂起该册，待核叶号：${formatReconcileResult(result.result)}`)
  }
  dialog.value = false
}

async function remove(binding: Binding): Promise<void> {
  try {
    await ElMessageBox.confirm('将删除该装订验收记录。', '删除验收记录', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await bindingStore.removeBinding(binding.id)
  ElMessage.success('已删除')
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
  await importSnapshot(parsed as RestoreSnapshot)
  await Promise.all([
    bookStore.loadBooks(),
    bookStore.loadVolumes(),
    leafStore.loadLeaves(),
    repairStore.loadOrders(),
    bindingStore.loadBindings()
  ])
  ElMessage.success('导入完成，数据已覆盖')
}

async function handleReset(): Promise<void> {
  try {
    await ElMessageBox.confirm('会删除当前浏览器中的全部档案并恢复演示数据，不可撤销。', '清空并重播种', {
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
    bookStore.loadVolumes(),
    leafStore.loadLeaves(),
    repairStore.loadOrders(),
    bindingStore.loadBindings()
  ])
  ElMessage.success('已清空并重新载入演示数据')
}

async function copyArchive(): Promise<void> {
  const ok = await copyText(archiveText.value)
  if (ok) ElMessage.success('归档清单已复制到剪贴板')
  else ElMessage.warning('浏览器未授权剪贴板')
}

function verdictLabel(verdict: BindingVerdict | null): string {
  return verdict ? BINDING_VERDICT_LABEL[verdict] : '未验收'
}

function verdictColor(verdict: BindingVerdict | null): string {
  return verdict ? BINDING_VERDICT_COLOR[verdict] : '#6b6257'
}

function statusLabel(status: BindingStatus): string {
  return BINDING_STATUS_LABEL[status] ?? status
}

function statusColor(status: BindingStatus): string {
  return BINDING_STATUS_COLOR[status] ?? '#6b6257'
}
</script>

<template>
  <div>
    <div class="gb-page-head">
      <div>
        <h2>装订还原与验收归档</h2>
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
      <StatBadge label="装订记录" :value="stat.total" suffix="条" tone="primary" />
      <StatBadge label="验收合格率" :value="`${stat.passPercent}%`" :percent="stat.passPercent" tone="success" />
      <StatBadge label="返修" :value="stat.rework" suffix="条" tone="danger" />
      <StatBadge label="挂起" :value="stat.suspended" suffix="册" tone="danger" />
      <StatBadge label="已归档册次" :value="stat.archived" suffix="册" tone="info" />
      <StatBadge label="待装订册次" :value="stat.pendingBinding" suffix="册" tone="warning" />
      <StatBadge label="工序完成率" :value="`${totals.orderPercent}%`" :percent="totals.orderPercent" />
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>装订验收登记</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新增验收</el-button>
            </div>
          </template>

          <EmptyPanel
            v-if="bindingStore.bindings.length === 0"
            title="还没有装订验收记录"
            description="登记装订方式、验收结论与叶号签收；验收合格后两边对账，通过后整册自动归档并锁定为只读。"
            action-text="新增验收"
            size="small"
            @action="openCreate"
          />
          <template v-else>
            <el-alert
              v-for="item in suspendedBindings"
              :key="item.id"
              type="error"
              show-icon
              :closable="false"
              style="margin-bottom: 10px"
              :title="`${volumeLabel(item.volumeId)} 已挂起：叶号对不上，等人定`"
              :description="`待核叶号 —— ${suspendedText(item)}`"
            />
            <el-table :data="bindingStore.bindings" size="small" border>
              <el-table-column label="册次" min-width="180">
                <template #default="{ row }">{{ volumeLabel(row.volumeId) }}</template>
              </el-table-column>
              <el-table-column prop="method" label="装订方式" width="130" />
              <el-table-column prop="finishDate" label="完工日期" width="120" sortable />
              <el-table-column label="结论" width="100">
                <template #default="{ row }">
                  <el-tag :style="{ color: verdictColor(row.verdict), borderColor: `${verdictColor(row.verdict)}66` }" effect="plain" round>
                    {{ verdictLabel(row.verdict) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :style="{ color: statusColor(row.status), borderColor: `${statusColor(row.status)}66` }" effect="plain" round>
                    {{ statusLabel(row.status) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="inspector" label="验收人" width="110" />
              <el-table-column label="操作" width="150">
                <template #default="{ row }">
                  <el-button size="small" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
                  <el-button size="small" text type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>
      </el-col>

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

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>整库导出</template>
          <p class="gb-muted">
            导出文件包含 6 张业务表全量数据与结构版本号，可在其他设备通过「导入 JSON」还原。
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

    <el-dialog v-model="dialog" :title="editing ? '编辑装订验收' : '新增装订验收'" width="720px">
      <el-form label-width="100px">
        <el-form-item label="册次" required>
          <el-select v-model="form.volumeId" :disabled="!!editing" style="width: 100%">
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
        <el-form-item label="叶号签收">
          <div style="width: 100%">
            <div v-if="restorerLeafNos.length === 0" class="gb-muted">
              修复师那本该册还没有书叶登记，签收清单为空；提交后会因叶数不符挂起。
            </div>
            <div v-else style="display: flex; flex-wrap: wrap; gap: 10px">
              <el-checkbox
                v-for="no in restorerLeafNos"
                :key="no"
                :model-value="isReceived(no)"
                @change="(val: boolean) => toggleLeaf(no, val)"
              >
                第 {{ no }} 叶
              </el-checkbox>
            </div>
            <div v-if="extraLeafNos.length > 0" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px">
              <el-tag
                v-for="no in extraLeafNos"
                :key="no"
                type="warning"
                effect="plain"
                closable
                @close="removeExtraLeaf(no)"
              >
                第 {{ no }} 叶（修复师账上无）
              </el-tag>
            </div>
            <div style="margin-top: 10px; display: flex; gap: 8px; align-items: center">
              <el-input-number v-model="extraLeafNo" :min="1" :max="999" size="small" controls-position="right" style="width: 120px" />
              <el-button size="small" @click="addExtraLeaf">增加叶号</el-button>
              <span class="gb-muted">装订间按修复师那本的叶号逐叶签收；对不上会挂起等人定</span>
            </div>
            <el-alert
              v-if="leafMismatchText"
              type="warning"
              show-icon
              :closable="false"
              style="margin-top: 10px"
              :title="leafMismatchText"
            />
          </div>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="form.verdict === 'pass'"
        type="success"
        show-icon
        :closable="false"
        title="验收合格将触发两边对账：叶数与工序进度看修复师那本，装订方式与验收结论看装订间那本；通过后整册归档锁定为只读"
      />
      <el-alert
        v-else
        type="warning"
        show-icon
        :closable="false"
        title="验收返修将把册子交回修复师那本重开，可继续调整工序"
      />
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
