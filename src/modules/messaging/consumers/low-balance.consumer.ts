import { Injectable, Logger } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { USESHOP_EXCHANGE, LOW_BALANCE_QUEUE } from '../messaging.module';
import { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service';

export interface LowBalanceEvent {
  phoneNumber: string;
  currentBalance: number;
  currency: string;
  timestamp: string;
}

/**
 * Low Balance Notification Consumer
 *
 * Listens for wallet.low_balance events (published on deposits that leave balance low,
 * or can be published after large debits) and sends a proactive WhatsApp notification.
 */
@Injectable()
export class LowBalanceConsumer {
  private readonly logger = new Logger(LowBalanceConsumer.name);

  constructor(private readonly whatsappSender: WhatsAppSenderService) {}

  @RabbitSubscribe({
    exchange: USESHOP_EXCHANGE,
    routingKey: 'wallet.low_balance',
    queue: LOW_BALANCE_QUEUE,
    queueOptions: {
      durable: true,
    },
  })
  async handleLowBalanceAlert(event: LowBalanceEvent) {
    this.logger.log(
      `Low balance alert received for ${event.phoneNumber}: ${event.currency} ${event.currentBalance}`,
    );

    try {
      const message =
        `⚠️ Low Balance Alert\n\n` +
        `Your ${event.currency} wallet balance is now ₦${Number(event.currentBalance).toLocaleString()}.\n\n` +
        `To continue shopping smoothly, please top up your wallet using your virtual account number (check your profile or reply "balance" for details).\n\n` +
        `Thank you for using UseShop!`;

      await this.whatsappSender.sendMessage(event.phoneNumber, message);
      this.logger.log(`Low balance WhatsApp notification sent to ${event.phoneNumber}`);
    } catch (error) {
      this.logger.error(`Failed to send low balance notification to ${event.phoneNumber}`, error.stack);
      // Do not rethrow - notification failures should not block other processing
    }
  }
}
