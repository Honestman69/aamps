/**
 * 接入层装配。
 *
 * 这里只做一件事：把已安装的适配器包**显式**注册进 `AdapterRegistry`。
 * 新增平台 = 在主服务 package.json 加一行依赖 + 这里加一行 register，
 * 业务代码与前端配置表单都不用改（表单读 manifest.configFields）。
 */

import { Module } from '@nestjs/common';
import { adapterFactory as qqAdapterFactory } from '@newjob/adapter-qq';

import { AuthModule } from '../auth/auth.module';
import { AdapterController } from './adapter.controller';
import { AdapterRegistry } from './adapter-registry';

@Module({
  imports: [AuthModule],
  controllers: [AdapterController],
  providers: [
    {
      provide: AdapterRegistry,
      useFactory: (): AdapterRegistry => {
        const registry = new AdapterRegistry();
        registry.register(qqAdapterFactory);
        return registry;
      },
    },
  ],
  exports: [AdapterRegistry],
})
export class AdapterModule {}
