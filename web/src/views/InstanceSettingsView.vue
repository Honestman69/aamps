<script setup lang="ts">
/**
 * 实例设置。
 *
 * 这个页面存在的直接原因：多模态（D033）与素材库（D034）的字段此前**只能改库**。
 * 没有界面时，`modelVision` / `ttsCredentialId` / `ttsModel` / `imageHosts` 事实上是
 * "装了但用不上"。所以这里的重点不是"能改名字"，而是把这些开关摆出来并讲清代价。
 *
 * 保存只发**改过的字段**：PATCH 语义是"没传就别动这一列"（D037 同款约定），
 * 全量发一遍会把用户没碰的字段也按前端的理解覆盖掉。
 * 接入参数（D041）也一样：只发 `adapterConfig` 里真的变了的键 ——
 * 接入参数变化会触发重连，全量提交等于"改个温度也掉一次线"。
 */
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  changedValues,
  knownSecrets,
  valuesFromInstance,
} from '@/api/adapter-config';
import { api, errorText } from '@/api/client';
import type {
  AdapterConfigValues,
  AdapterManifest,
  Credential,
  Instance,
  InstancePatch,
} from '@/api/types';
import AdapterConfigForm from '@/components/AdapterConfigForm.vue';

const route = useRoute();
const router = useRouter();

const instanceId = computed(() => String(route.params.id ?? ''));

const loading = ref(true);
const saving = ref(false);
const connecting = ref(false);
const instance = ref<Instance | null>(null);
const credentials = ref<Credential[]>([]);

type FormState = {
  name: string;
  enabled: boolean;
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  budgetPolicy: string;
  credentialId: string;
  modelMain: string;
  modelCheap: string;
  modelFallback: string;
  modelTemperature: number;
  modelVision: string;
  ttsCredentialId: string;
  ttsModel: string;
  ttsVoice: string;
  imageHosts: string;
  /**
   * 接入配置（D041）：键来自适配器清单。
   * 敏感项（token）不回显，留空 = 不修改。
   */
  adapterConfig: AdapterConfigValues;
};

const form = reactive<FormState>({
  name: '',
  enabled: true,
  dailyBudgetCents: 0,
  monthlyBudgetCents: 0,
  budgetPolicy: 'downgrade',
  credentialId: '',
  modelMain: '',
  modelCheap: '',
  modelFallback: '',
  modelTemperature: 0.85,
  modelVision: '',
  ttsCredentialId: '',
  ttsModel: '',
  ttsVoice: 'alloy',
  imageHosts: '',
  adapterConfig: {},
});

/** 当前实例对应的适配器清单：表单字段全由它决定 */
const manifest = ref<AdapterManifest | null>(null);
/** 哪些敏感项已配置（只用于 placeholder） */
const secrets = ref<Record<string, boolean>>({});
/**
 * 载入时的接入配置快照：保存时按它算增量。
 *
 * 必须是 `ref` 而不是普通变量：`dirty` 是 computed，而它第一次求值时
 * 页面还在 loading、`origin` 还是 null，`buildPatch` 会**提前 return**。
 * 若 `origin` 不是响应式的，那次提前返回就没有收集到任何依赖，
 * 于是 `dirty` 会永远停在 false —— 表现为"改了东西但保存按钮一直灰着"。
 */
const originConfig = ref<AdapterConfigValues>({});

/** 载入时的快照：保存时按它算增量。理由同上，必须是 ref */
const origin = ref<Instance | null>(null);

function fill(row: Instance): void {
  origin.value = row;
  instance.value = row;
  form.name = row.name;
  form.enabled = row.enabled;
  form.dailyBudgetCents = row.dailyBudgetCents;
  form.monthlyBudgetCents = row.monthlyBudgetCents;
  form.budgetPolicy = row.budgetPolicy;
  form.credentialId = row.credentialId ?? '';
  form.modelMain = row.modelMain ?? '';
  form.modelCheap = row.modelCheap ?? '';
  form.modelFallback = row.modelFallback ?? '';
  form.modelTemperature = row.modelTemperature;
  form.modelVision = row.modelVision ?? '';
  form.ttsCredentialId = row.ttsCredentialId ?? '';
  form.ttsModel = row.ttsModel ?? '';
  form.ttsVoice = row.ttsVoice || 'alloy';
  form.imageHosts = row.imageHosts;
  // 接入参数按清单反查（靠 mapsTo，不靠字段名）；token 永远不回显
  form.adapterConfig = valuesFromInstance(manifest.value, row);
  originConfig.value = { ...form.adapterConfig };
  secrets.value = knownSecrets(manifest.value, row);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, creds, adapters] = await Promise.all([
      api.instances.list(),
      api.credentials.list(),
      api.adapters.list(),
    ]);
    credentials.value = creds;
    const row = list.find((item) => item.id === instanceId.value) ?? null;
    if (!row) {
      ElMessage.error('实例不存在或不属于当前账号');
      await router.replace({ name: 'instances' });
      return;
    }
    // 清单要在 fill 之前就位：接入参数的当前值是按 `mapsTo` 反查出来的
    manifest.value =
      adapters.find((item) => item.platform === row.platform && item.protocol === row.adapterType) ??
      null;
    fill(row);
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 空串 → null（"清空这一列"），有值则 trim */
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPatch(): InstancePatch {
  const patch: InstancePatch = {};
  const base = origin.value;
  if (!base) {
    return patch;
  }

  if (form.name.trim() !== base.name) patch.name = form.name.trim();
  if (form.enabled !== base.enabled) patch.enabled = form.enabled;
  if (form.dailyBudgetCents !== base.dailyBudgetCents) patch.dailyBudgetCents = form.dailyBudgetCents;
  if (form.monthlyBudgetCents !== base.monthlyBudgetCents) {
    patch.monthlyBudgetCents = form.monthlyBudgetCents;
  }
  if (form.budgetPolicy !== base.budgetPolicy) patch.budgetPolicy = form.budgetPolicy;

  if (nullable(form.credentialId) !== base.credentialId) patch.credentialId = nullable(form.credentialId);
  if (nullable(form.modelMain) !== base.modelMain) patch.modelMain = nullable(form.modelMain);
  if (nullable(form.modelCheap) !== base.modelCheap) patch.modelCheap = nullable(form.modelCheap);
  if (nullable(form.modelFallback) !== base.modelFallback) {
    patch.modelFallback = nullable(form.modelFallback);
  }
  if (form.modelTemperature !== base.modelTemperature) patch.modelTemperature = form.modelTemperature;

  if (nullable(form.modelVision) !== base.modelVision) patch.modelVision = nullable(form.modelVision);
  if (nullable(form.ttsCredentialId) !== base.ttsCredentialId) {
    patch.ttsCredentialId = nullable(form.ttsCredentialId);
  }
  if (nullable(form.ttsModel) !== base.ttsModel) patch.ttsModel = nullable(form.ttsModel);
  // ttsVoice 是非空字符串：清空就不提交，避免把 zod 的 min(1) 撞成 400
  if (form.ttsVoice.trim() && form.ttsVoice.trim() !== base.ttsVoice) {
    patch.ttsVoice = form.ttsVoice.trim();
  }
  if (form.imageHosts.trim() !== base.imageHosts) patch.imageHosts = form.imageHosts.trim();

  // 接入参数：只发真的变了的键。没变就不发 —— 发了会触发一次不必要的重连
  const configPatch = changedValues(manifest.value, originConfig.value, form.adapterConfig);
  if (Object.keys(configPatch).length > 0) {
    patch.adapterConfig = configPatch;
  }

  return patch;
}

const dirty = computed(() => Object.keys(buildPatch()).length > 0);

async function save(): Promise<void> {
  const patch = buildPatch();
  if (Object.keys(patch).length === 0) {
    ElMessage.info('没有改动');
    return;
  }
  saving.value = true;
  try {
    const updated = await api.instances.update(instanceId.value, patch);
    fill(updated);
    ElMessage.success('已保存');
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    saving.value = false;
  }
}

async function connect(): Promise<void> {
  connecting.value = true;
  try {
    const result = await api.instances.connect(instanceId.value);
    if (result.ok) {
      ElMessage.success(result.detail ?? '已发起连接');
    } else {
      ElMessage.warning(result.detail ?? '连接未建立');
    }
  } catch (err) {
    ElMessage.error(errorText(err));
  } finally {
    connecting.value = false;
  }
}

const textCredential = computed(
  () => credentials.value.filter((item) => item.provider.toLowerCase() !== 'placeholder'),
);

/** 语音/看图是否真的可用：三样齐全才算开 */
const visionReady = computed(() => Boolean(form.modelVision.trim()));
const voiceReady = computed(
  () => Boolean(form.ttsCredentialId.trim()) && Boolean(form.ttsModel.trim()) && Boolean(form.ttsVoice.trim()),
);
</script>

<template>
  <section v-loading="loading" class="page">
    <header class="page-head">
      <div>
        <div class="crumb">
          <router-link :to="{ name: 'instances' }">实例</router-link>
          <span>/</span>
          <span>{{ instance?.name ?? instanceId }}</span>
        </div>
        <h1 class="page-title">设置</h1>
        <p class="page-desc">
          改完点保存；改名、开关、模型都不需要重连，只影响后续消息。
        </p>
      </div>
      <div class="head-actions">
        <el-button :disabled="!dirty || saving" @click="load">放弃改动</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty" @click="save">保存</el-button>
      </div>
    </header>

    <!-- 基础 -->
    <div class="card card-pad">
      <h2 class="section-title">基础</h2>
      <p class="section-desc">实例名只影响后台显示；账号与接入地址决定它控制哪个平台账号。</p>

      <div class="grid-2">
        <el-form-item label="实例名">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
          <span class="inline-hint">关掉后不再处理任何消息（人设与记忆保留）</span>
        </el-form-item>

        <el-form-item label="日预算（分，0 = 不限）">
          <el-input-number v-model="form.dailyBudgetCents" :min="0" :step="100" style="width: 100%" />
        </el-form-item>
        <el-form-item label="月预算（分，0 = 不限）">
          <el-input-number v-model="form.monthlyBudgetCents" :min="0" :step="1000" style="width: 100%" />
        </el-form-item>

        <el-form-item label="超限策略">
          <el-select v-model="form.budgetPolicy" style="width: 100%">
            <el-option label="降级到便宜模型继续聊" value="downgrade" />
            <el-option label="直接不出声" value="block" />
          </el-select>
          <div class="hint">预算按目录价累计；凭据里没填价格时永远不会触发。</div>
        </el-form-item>
      </div>
    </div>

    <!-- 模型 -->
    <div class="card card-pad">
      <h2 class="section-title">模型</h2>
      <p class="section-desc">
        换模型只改这几项，人设与记忆零迁移 —— 它们挂在这个实例上，不挂 Provider。
      </p>

      <div class="grid-2">
        <el-form-item label="API Key">
          <el-select v-model="form.credentialId" clearable placeholder="未绑定" style="width: 100%">
            <el-option
              v-for="cred in textCredential"
              :key="cred.id"
              :label="`${cred.label} · ${cred.provider} · ${cred.keyMasked}`"
              :value="cred.id"
            >
              <span>{{ cred.label }}</span>
              <span class="opt-sub">{{ cred.provider }} · {{ cred.keyMasked }}</span>
            </el-option>
          </el-select>
          <div class="hint">
            列表里没有？去 <router-link :to="{ name: 'credentials' }">密钥</router-link> 添加。
          </div>
        </el-form-item>

        <el-form-item label="温度">
          <el-input-number
            v-model="form.modelTemperature"
            :min="0"
            :max="1.5"
            :step="0.05"
            :precision="2"
            style="width: 100%"
          />
        </el-form-item>

        <el-form-item label="主模型">
          <el-input v-model="form.modelMain" placeholder="deepseek-chat" />
        </el-form-item>
        <el-form-item label="便宜模型（思考/摘要）">
          <el-input v-model="form.modelCheap" placeholder="同主模型可留空" />
        </el-form-item>
        <el-form-item label="兜底模型">
          <el-input v-model="form.modelFallback" placeholder="主模型失败时用" />
        </el-form-item>
      </div>
    </div>

    <!-- 多模态 -->
    <div class="card card-pad">
      <h2 class="section-title">多模态</h2>
      <p class="section-desc">
        看图、发语音各自独立开关。<strong>没配就是"能力不存在"</strong>：
        prompt 里不会出现对应通道，模型也不会假装要发。
      </p>

      <div class="grid-2">
        <el-form-item label="看图模型">
          <el-input v-model="form.modelVision" placeholder="例如 glm-4v / qwen-vl-max" />
          <div class="hint">
            必须是支持视觉的模型。主模型（如 deepseek-chat）看不见图，硬塞会让整条请求 400。
          </div>
        </el-form-item>

        <el-form-item label="收到的图片">
          <el-tag :type="visionReady ? 'success' : 'info'" size="small">
            {{ visionReady ? '会下载并交给视觉模型' : '只留「[图片]」占位' }}
          </el-tag>
        </el-form-item>

        <el-form-item label="语音合成 Key">
          <el-select v-model="form.ttsCredentialId" clearable placeholder="未绑定" style="width: 100%">
            <el-option
              v-for="cred in credentials"
              :key="cred.id"
              :label="`${cred.label} · ${cred.provider}`"
              :value="cred.id"
            />
          </el-select>
          <div class="hint">
            可以和聊天用同一把，也可以单独一把 —— 多数厂商不能既聊天又合成。
          </div>
        </el-form-item>

        <el-form-item label="语音模型">
          <el-input v-model="form.ttsModel" placeholder="tts-1" />
        </el-form-item>

        <el-form-item label="音色">
          <el-input v-model="form.ttsVoice" placeholder="alloy" />
          <div class="hint">取值由厂商决定，填错只影响音色，不影响能否发出。</div>
        </el-form-item>

        <el-form-item label="语音状态">
          <el-tag :type="voiceReady ? 'success' : 'info'" size="small">
            {{ voiceReady ? '可用（Key + 模型 + 音色齐全）' : '未开启' }}
          </el-tag>
        </el-form-item>

        <el-form-item label="图片域名白名单（可留空）" class="span-2">
          <el-input v-model="form.imageHosts" placeholder="example.com,img.example.com" />
          <div class="hint">
            留空 = 允许任意公网 https 图片；填了就只允许这些域名。内网地址与 http 出站一律拒绝。
          </div>
        </el-form-item>
      </div>
    </div>

    <!-- 素材库入口：多模态把它接进来，管理是另一页的事 -->
    <div class="card card-pad">
      <h2 class="section-title">素材库</h2>
      <p class="section-desc">
        模型可以把你发的图片/表情存下来，之后按名字再发出去。存了什么、占多少、要不要删，都在这里。
      </p>
      <el-button @click="router.push({ name: 'instance-assets', params: { id: instanceId } })">
        打开素材库
      </el-button>
    </div>

    <!-- 接入 -->
    <div class="card card-pad">
      <h2 class="section-title">接入</h2>
      <p class="section-desc">
        协议端的登录态永远留在协议端。这里只存"连哪儿、用什么 token"，不存任何登录凭据。
      </p>

      <!-- 接入参数：字段来自适配器清单（D041），这一页不认识任何平台字段 -->
      <AdapterConfigForm
        v-model="form.adapterConfig"
        :manifest="manifest"
        :known-secrets="secrets"
      />
      <div v-if="!manifest" class="hint">
        没有找到这个实例的适配器清单（平台 {{ instance?.platform }} / 协议
        {{ instance?.adapterType }}），接入参数暂时无法编辑。
      </div>

      <div class="connect-row">
        <el-button :loading="connecting" @click="connect">发起连接</el-button>
        <span class="hint">需先保存改动；反向模式下要求 NapCat 已在运行并指向本服务。</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.crumb {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--text-faint);
  font-size: 12px;
  margin-bottom: 4px;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.inline-hint {
  margin-left: 10px;
  color: var(--text-faint);
  font-size: 11.5px;
}

.opt-sub {
  float: right;
  color: var(--text-faint);
  font-size: 11px;
}

.readonly {
  align-self: center;
  color: var(--text-muted);
}

.connect-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
  margin-top: 4px;
}
</style>
