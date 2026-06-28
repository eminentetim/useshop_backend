import { Injectable, Inject, Logger, Optional } from '@nestjs/common';

export interface Escalation {
  id: string;
  phoneNumber: string;
  reason: string;
  timestamp: string;
  status: 'pending' | 'resolved';
  metadata?: Record<string, any>;
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);
  private readonly REDIS_KEY = 'escalations:pending';
  private inMemoryEscalations: Escalation[] = [];

  constructor(@Optional() @Inject('REDIS_CLIENT') private readonly redis?: any) {}

  async createEscalation(phoneNumber: string, reason: string, metadata: Record<string, any> = {}): Promise<Escalation> {
    const escalation: Escalation = {
      id: `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      phoneNumber,
      reason,
      timestamp: new Date().toISOString(),
      status: 'pending',
      metadata,
    };

    if (this.redis) {
      await this.redis.lpush(this.REDIS_KEY, JSON.stringify(escalation));
    } else {
      this.inMemoryEscalations.unshift(escalation);
    }
    this.logger.log(`New escalation created for ${phoneNumber}: ${reason} (redis ${this.redis ? 'enabled' : 'disabled'})`);

    return escalation;
  }

  async getPendingEscalations(): Promise<Escalation[]> {
    if (!this.redis) {
      return this.inMemoryEscalations.filter((e) => e.status === 'pending');
    }
    const data = await this.redis.lrange(this.REDIS_KEY, 0, -1);
    return data.map((item: string) => JSON.parse(item)).filter((e: Escalation) => e.status === 'pending');
  }

  async resolveEscalation(id: string): Promise<boolean> {
    if (!this.redis) {
      const esc = this.inMemoryEscalations.find(e => e.id === id);
      if (esc) {
        esc.status = 'resolved';
        this.logger.log(`Escalation ${id} marked as resolved (in-memory)`);
        return true;
      }
      return false;
    }
    const all = await this.redis.lrange(this.REDIS_KEY, 0, -1);
    for (let i = 0; i < all.length; i++) {
      const esc: Escalation = JSON.parse(all[i]);
      if (esc.id === id) {
        esc.status = 'resolved';
        // Remove old and push updated (simple approach)
        await this.redis.lset(this.REDIS_KEY, i, JSON.stringify(esc));
        this.logger.log(`Escalation ${id} marked as resolved`);
        return true;
      }
    }
    return false;
  }

  async getAllEscalations(limit = 50): Promise<Escalation[]> {
    if (!this.redis) {
      return this.inMemoryEscalations.slice(0, limit);
    }
    const data = await this.redis.lrange(this.REDIS_KEY, 0, limit - 1);
    return data.map((item: string) => JSON.parse(item));
  }
}
