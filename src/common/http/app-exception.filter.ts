/**
 * 全局异常过滤器：把 `AppError` 映射成 HTTP 状态 + 稳定的 `code`。
 *
 * 两条硬约束：
 *   1. **不泄漏内部细节**。非 AppError 一律 500 + "内部错误"，堆栈只进服务端日志。
 *   2. **不记请求体**。登录请求体里有密码，改密请求体里有新旧密码 ——
 *      日志里只记 method / path / status / code。
 */

import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AppError } from '@newjob/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    if (exception instanceof AppError) {
      // 业务错误：code + 固定文案，不回显任何密钥片段
      void reply.status(exception.httpStatus).send({
        code: exception.code,
        message: exception.message,
      });
      if (exception.httpStatus >= 500) {
        this.logger.error(
          { event: 'http.error', method: request.method, path: request.url, code: exception.code },
          exception.message,
        );
      }
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    // 只记路径与错误摘要，绝不记 body / headers（里面有密码和 cookie）
    this.logger.error(
      { event: 'http.unhandled', method: request.method, path: request.url },
      message,
    );
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: '内部错误' });
  }
}
