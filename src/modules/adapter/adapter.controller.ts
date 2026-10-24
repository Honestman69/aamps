/**
 * 适配器清单接口。
 *
 * 前端"新建实例"时靠它渲染接入方式与配置表单（读 `manifest.configFields`），
 * 所以新增平台时**不需要改前端代码** —— 这是 D013 拆包设计的收益。
 */

import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { AdapterManifest } from '@newjob/contracts';

import { SessionGuard } from '../auth/session.guard';
import { AdapterRegistry } from './adapter-registry';

@Controller('api/adapters')
@UseGuards(SessionGuard)
export class AdapterController {
  constructor(@Inject(AdapterRegistry) private readonly registry: AdapterRegistry) {}

  @Get()
  async list(): Promise<AdapterManifest[]> {
    return this.registry.list();
  }
}
