import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const correlationId = req.headers['x-request-id'] || randomUUID();
    req.headers['x-request-id'] = correlationId as string;

    const { method, originalUrl, ip } = req;
    const userAgent = req.get('user-agent') || '';

    const start = Date.now();

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - start;

      const logMessage = `${method} ${originalUrl} ${statusCode} - ${duration}ms - ${ip} - ${userAgent}`;

      if (statusCode >= 500) {
        this.logger.error(`[${correlationId}] ${logMessage}`);
      } else if (statusCode >= 400) {
        this.logger.warn(`[${correlationId}] ${logMessage}`);
      } else {
        this.logger.log(`[${correlationId}] ${logMessage}`);
      }
    });

    next();
  }
}
