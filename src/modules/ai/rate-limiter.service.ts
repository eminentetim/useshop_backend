import { Injectable, Inject, Logger } from '@nestjs/common';

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly WINDOW_SECONDS = 60;
  private readonly MAX_REQUESTS = 20; // 20 requests per minute per phone

  constructor(@Inject('REDIS_CLIENT') private readonly redis: any) {}

  async isRateLimited(phoneNumber: string): Promise<boolean> {
    const key = `rate:agent:${phoneNumber}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, this.WINDOW_SECONDS);
    }

    if (current > this.MAX_REQUESTS) {
      this.logger.warn(`Rate limit exceeded for ${phoneNumber}`);
      return true;
    }
    return false;
  }
}
