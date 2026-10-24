/**
 * QQ 平台适配器清单。
 *
 * 这个文件是「平台自描述」的范例：
 *   - 主服务靠它知道该平台支持什么（capabilities）
 *   - 前端靠它自动渲染配置表单（configFields），不需要为新平台改一行前端代码
 *   - 看板靠它知道要展示哪些平台特有指标（metrics）
 */

import { PLATFORM_CAPABILITIES, type AdapterManifest } from '@newjob/contracts';

export const manifest: AdapterManifest = {
  platform: 'qq',
  protocol: 'onebot',
  displayName: 'QQ（OneBot 11）',
  description: '通过 NapCat 连接，拥有与正常 QQ 用户一致的完整能力',
  version: '0.1.0',
  capabilities: PLATFORM_CAPABILITIES.qq,

  configFields: [
    {
      key: 'mode',
      label: '接入方向',
      type: 'select',
      required: true,
      default: 'server',
      options: [
        { label: 'NapCat 连本服务（反向，推荐）', value: 'server' },
        { label: '本服务连 NapCat（正向）', value: 'client' },
      ],
      help:
        '反向模式由本服务校验 token（握手阶段拒绝），且云端部署无需开放入站端口；' +
        'NapCat 4.18.41 的正向模式 token 校验存在缺陷，等于无鉴权',
    },
    {
      key: 'wsUrl',
      label: 'WebSocket 地址',
      type: 'text',
      required: true,
      placeholder: 'ws://127.0.0.1:3002',
      help:
        '反向模式填本端监听地址（如 ws://127.0.0.1:3002，需与 NapCat 的「反向 WebSocket」一致）；' +
        '正向模式填 NapCat 的服务端地址（常见 3001）。不要填公网地址',
    },
    {
      key: 'accessToken',
      label: 'Access Token',
      type: 'password',
      required: false,
      secret: true,
      help: '与 NapCat 网络配置中的 token 保持一致；留空表示不鉴权',
    },
    {
      key: 'selfId',
      label: '机器人 QQ 号',
      type: 'text',
      required: true,
      help: '该实例对应的 QQ 账号，用于过滤自身消息',
    },
  ],

  metrics: [
    { key: 'disconnectCount', label: '掉线次数', unit: '次', source: 'adapter' },
    { key: 'sendBlockedCount', label: '发送被拦截', unit: '次', source: 'adapter' },
  ],
};
