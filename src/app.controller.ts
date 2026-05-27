import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import * as os from 'os';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || 'unknown',
    };
  }

  @Get('metrics')
  getMetrics() {
    const mem = process.memoryUsage();
    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      },
      system: {
        loadavg: os.loadavg(),
        freemem: Math.round(os.freemem() / 1024 / 1024),
        totalmem: Math.round(os.totalmem() / 1024 / 1024),
      },
    };
  }
}
