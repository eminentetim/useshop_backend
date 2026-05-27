import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessagingService } from '../messaging/messaging.service';

/**
 * Scheduled background jobs for UseShop.
 * Includes reconciliation and abandoned cart recovery as per Phase B plan.
 */
@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  constructor(private readonly messagingService: MessagingService) {}

  /**
   * Runs every hour - basic reconciliation stub.
   * In production this would compare Monnify balances vs internal ledger.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleReconciliation() {
    this.logger.log('Running hourly reconciliation job (stub)');
    // TODO: Call Monnify balance API and compare with sum of all wallets
    // For now just a log
  }

  /**
   * Runs every 4 hours - abandoned cart recovery.
   * Publishes events that can be handled by a future recovery consumer.
   */
  @Cron(CronExpression.EVERY_4_HOURS)
  async handleAbandonedCartRecovery() {
    this.logger.log('Running abandoned cart recovery job');

    // In a real implementation we would query CheckoutSessionService for
    // sessions older than X minutes that are still PENDING.
    // For now we publish a generic event that can be consumed later.
    await this.messagingService.publishCheckoutEvent({
      sessionId: 'recovery-batch',
      phoneNumber: 'system',
      action: 'expired',
      metadata: { type: 'abandoned_cart_sweep' },
    });
  }
}
