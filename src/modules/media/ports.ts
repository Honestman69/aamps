/**
 * 媒体模块的端口。
 *
 * 只有一个端口：**取语音合成用的凭据**。它必须是 owner 维度的查询
 * （硬性规则 5：凭据类数据只暴露 `findForUser`），指向一个"按 id 拿密文"的通用方法。
 *
 * 为什么不复用 `IGatewayRepository`：那个端口的语义是"列出发消息可用的 Key 并按优先级排序"，
 * 是给路由用的。语音合成要的是"这一把 Key 的 baseUrl 是什么"，两件事混在一个接口里，
 * 以后加 TTS 的 Key 池就要改网关的接口。
 */

export type TtsCredential = {
  id: string;
  provider: string;
  baseUrl: string | null;
  authStyle: string;
  /** 用户 DEK 加密的密文，只在本进程内存里解 */
  apiKeyEnc: string;
};

export interface ITtsCredentialRepository {
  /** 带 ownerUserId 过滤：拿到别人的 credentialId 也只得到 null */
  findForUser(ownerUserId: string, credentialId: string): Promise<TtsCredential | null>;
}
