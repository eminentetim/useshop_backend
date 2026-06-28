import { Controller, Post, Body, Logger, Inject, Optional } from '@nestjs/common';

@Controller('langsmith')
export class LangSmithWebhookController {
  private readonly logger = new Logger(LangSmithWebhookController.name);
  private readonly ALERTS_KEY = 'langsmith:alerts';

  constructor(@Optional() @Inject('REDIS_CLIENT') private readonly redis?: any) {}

  @Post('webhook')
  async handleWebhook(@Body() payload: any) {
    this.logger.log('Received LangSmith webhook');

    if (payload.run && payload.run.total_cost && payload.run.total_cost > 0.5) {
      const alert = {
        id: Date.now().toString(),
        type: 'high_cost',
        runId: payload.run.id,
        cost: payload.run.total_cost,
        timestamp: new Date().toISOString(),
        message: `High cost run detected: $${payload.run.total_cost}`,
        project: payload.project_name || 'useshop-agent',
      };

      if (this.redis) {
        await this.redis.lpush(this.ALERTS_KEY, JSON.stringify(alert));
        await this.redis.ltrim(this.ALERTS_KEY, 0, 49); // keep last 50
      }

      this.logger.warn(alert.message);
    }

    return { received: true };
  }

  async getRecentAlerts(limit = 10): Promise<any[]> {
    const data = await this.redis.lrange(this.ALERTS_KEY, 0, limit - 1);
    return data.map((item: string) => JSON.parse(item));
  }
}