/**
 * 接口客户端。
 *
 * 三个约定：
 *
 * 1. **只用相对路径 `/api/...`**。开发期由 Vite 代理，生产期由主服务同源托管，
 *    两种情况下都是同源请求 —— 因此 cookie 自动带上，不需要任何 token 处理。
 * 2. **错误统一抛 `ApiError`**，带 `code` / `status` / `message`。
 *    服务端错误体是 `{ code, message }`（AppExceptionFilter），前端只展示 `message`，
 *    `code` 留给"401 要跳登录"这类分支判断。
 * 3. **不吞异常**。调用方必须自己 catch —— 静默失败的接口调用会让界面显示陈旧数据，
 *    那比报错更难排查。
 */

import type {
  AdapterManifest,
  Credential,
  Instance,
  InstancePatch,
  LoginResponse,
  MeResponse,
  MediaAssetList,
  Persona,
  PersonaPatch,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // 网络层失败（服务没起、代理挂掉）：给一句人话，而不是 "Failed to fetch"
    throw new ApiError(0, 'NETWORK', '无法连接服务，请确认后端在运行');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 后端异常时可能返回 HTML（反代错误页）；不要把整页 HTML 塞进提示
      payload = null;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { code?: string; message?: string };
    throw new ApiError(
      response.status,
      record.code ?? `HTTP_${response.status}`,
      record.message ?? `请求失败（${response.status}）`,
    );
  }

  return payload as T;
}

export const api = {
  auth: {
    me: (): Promise<MeResponse> => request('GET', '/api/auth/me'),
    login: (username: string, password: string): Promise<LoginResponse> =>
      request('POST', '/api/auth/login', { username, password }),
    unlock: (password: string): Promise<{ unlocked: boolean; expiresAt: string }> =>
      request('POST', '/api/auth/unlock', { password }),
    lock: (): Promise<{ unlocked: boolean }> => request('POST', '/api/auth/lock'),
    changePassword: (oldPassword: string, newPassword: string): Promise<{ ok: true }> =>
      request('POST', '/api/auth/password', { oldPassword, newPassword }),
  },

  adapters: {
    list: (): Promise<AdapterManifest[]> => request('GET', '/api/adapters'),
  },

  credentials: {
    list: (): Promise<Credential[]> => request('GET', '/api/credentials'),
    create: (input: Record<string, unknown>): Promise<Credential> =>
      request('POST', '/api/credentials', input),
    update: (id: string, input: Record<string, unknown>): Promise<Credential> =>
      request('PATCH', `/api/credentials/${encodeURIComponent(id)}`, input),
    remove: (id: string): Promise<void> =>
      request('DELETE', `/api/credentials/${encodeURIComponent(id)}`),
  },

  instances: {
    list: (): Promise<Instance[]> => request('GET', '/api/instances'),
    create: (input: Record<string, unknown>): Promise<Instance> =>
      request('POST', '/api/instances', input),
    update: (id: string, patch: InstancePatch): Promise<Instance> =>
      request('PATCH', `/api/instances/${encodeURIComponent(id)}`, patch),
    remove: (id: string): Promise<void> =>
      request('DELETE', `/api/instances/${encodeURIComponent(id)}`),
    connect: (id: string): Promise<{ ok: boolean; detail?: string }> =>
      request('POST', `/api/instances/${encodeURIComponent(id)}/connect`),
    disconnect: (id: string): Promise<{ ok: boolean; detail?: string }> =>
      request('POST', `/api/instances/${encodeURIComponent(id)}/disconnect`),
  },

  assets: {
    list: (instanceId: string, options?: { includeDeleted?: boolean; limit?: number }): Promise<MediaAssetList> => {
      const params = new URLSearchParams();
      if (options?.includeDeleted) {
        params.set('includeDeleted', '1');
      }
      if (options?.limit) {
        params.set('limit', String(options.limit));
      }
      const query = params.toString();
      return request(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/assets${query ? `?${query}` : ''}`,
      );
    },
    remove: (instanceId: string, assetId: string): Promise<{ ok: true; alias: string; alreadyDeleted: boolean }> =>
      request(
        'DELETE',
        `/api/instances/${encodeURIComponent(instanceId)}/assets/${encodeURIComponent(assetId)}`,
      ),
  },

  personas: {
    list: (instanceId: string, includeArchived = false): Promise<Persona[]> =>
      request(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/personas${includeArchived ? '?includeArchived=1' : ''}`,
      ),
    get: (id: string): Promise<Persona> => request('GET', `/api/personas/${encodeURIComponent(id)}`),
    create: (instanceId: string, input: PersonaPatch & { name: string }): Promise<Persona> =>
      request('POST', `/api/instances/${encodeURIComponent(instanceId)}/personas`, input),
    update: (id: string, patch: PersonaPatch): Promise<Persona> =>
      request('PATCH', `/api/personas/${encodeURIComponent(id)}`, patch),
    publish: (id: string): Promise<Persona> =>
      request('POST', `/api/personas/${encodeURIComponent(id)}/publish`),
    archive: (id: string): Promise<Persona> =>
      request('POST', `/api/personas/${encodeURIComponent(id)}/archive`),
    activate: (id: string): Promise<Persona> =>
      request('POST', `/api/personas/${encodeURIComponent(id)}/activate`),
  },
};

/** 统一把异常转成可展示文案（不吞异常，只是把展示逻辑收在一处） */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
