/**
 * 契约层统一出口。
 *
 * 包名：@newjob/contracts
 * 这是主服务与所有适配器包之间**唯一**的共享依赖。
 * 新增契约时在这里补一行导出。
 */

export * from './message';
export * from './platform';
export * from './adapter';
export * from './adapter-sdk';
export * from './provider';
export * from './pipe';
export * from './errors';
