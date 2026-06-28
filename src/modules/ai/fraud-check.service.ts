import { Injectable, Inject, Logger, Optional } from '@nestjs/common';

export interface FraudCheckResult {
  id: string;
  phoneNumber: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  signals: string[];
  cartTotal?: number;
  timestamp: string;
  recommendation: string;
  actionTaken?: 'block_checkout' | 'force_2fa';
  actionTimestamp?: string;
}

@Injectable()
export class FraudCheckService {
  private readonly logger = new Logger(FraudCheckService.name);
  private readonly KEY = 'fraud:checks:recent';
  private readonly BLOCKED_KEY = 'fraud:blocked:phones';
  private readonly FORCE_2FA_KEY = 'fraud:force2fa:phones';

  constructor(@Optional() @Inject('REDIS_CLIENT') private readonly redis?: any) {}

  async logFraudCheck(result: Omit<FraudCheckResult, 'id' | 'timestamp'>): Promise<FraudCheckResult> {
    const fullResult: FraudCheckResult = {
      ...result,
      id: `fraud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    if (this.redis) {
      await this.redis.lpush(this.KEY, JSON.stringify(fullResult));
      await this.redis.ltrim(this.KEY, 0, 99); // keep last 100
    }

    this.logger.log(`Fraud check logged for ${result.phoneNumber}: ${result.riskLevel}`);
    return fullResult;
  }

  async getRecentChecks(limit = 20): Promise<FraudCheckResult[]> {
    const data = await this.redis.lrange(this.KEY, 0, limit - 1);
    return data.map((item: string) => JSON.parse(item));
  }

  async applyAction(id: string, action: 'block_checkout' | 'force_2fa') {
    const all = await this.redis.lrange(this.KEY, 0, -1);
    for (let i = 0; i < all.length; i++) {
      const check: FraudCheckResult = JSON.parse(all[i]);
      if (check.id === id) {
        check.actionTaken = action;
        check.actionTimestamp = new Date().toISOString();
        await this.redis.lset(this.KEY, i, JSON.stringify(check));
        this.logger.log(`Fraud check ${id} action applied: ${action}`);

        // Also apply phone-level enforcement immediately so it affects future checkouts/sessions
        if (action === 'block_checkout' && check.phoneNumber) {
          await this.blockPhone(check.phoneNumber);
        } else if (action === 'force_2fa' && check.phoneNumber) {
          await this.force2FAForPhone(check.phoneNumber);
        }

        return true;
      }
    }
    return false;
  }

  // === Phone-level enforcement (used by Checkout + Agent tools) ===

  async blockPhone(phoneNumber: string): Promise<void> {
    await this.redis.sadd(this.BLOCKED_KEY, phoneNumber);
    this.logger.warn(`Phone ${phoneNumber} BLOCKED from checkout (fraud action)`);
  }

  async unblockPhone(phoneNumber: string): Promise<void> {
    await this.redis.srem(this.BLOCKED_KEY, phoneNumber);
    this.logger.log(`Phone ${phoneNumber} unblocked from checkout`);
  }

  async force2FAForPhone(phoneNumber: string): Promise<void> {
    await this.redis.sadd(this.FORCE_2FA_KEY, phoneNumber);
    this.logger.warn(`Phone ${phoneNumber} marked for Force 2FA on future checkouts`);
  }

  async removeForce2FA(phoneNumber: string): Promise<void> {
    await this.redis.srem(this.FORCE_2FA_KEY, phoneNumber);
  }

  async isPhoneBlocked(phoneNumber: string): Promise<boolean> {
    const member = await this.redis.sismember(this.BLOCKED_KEY, phoneNumber);
    return member === 1;
  }

  async phoneRequiresForce2FA(phoneNumber: string): Promise<boolean> {
    const member = await this.redis.sismember(this.FORCE_2FA_KEY, phoneNumber);
    return member === 1;
  }
}
