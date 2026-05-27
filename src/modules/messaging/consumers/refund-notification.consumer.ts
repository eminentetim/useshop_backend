import { Injectable, Logger } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { USESHOP_EXCHANGE, REFUND_QUEUE } from '../messaging.module';
import { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service';

export interface OrderRefundedEvent {
  orderId: string;
  phoneNumber: string;
  amount: number;
  reason?: string;
  refundedTo: 'WALLET' | 'BANK';
  timestamp: string;
  metadata?: Record<string, any>;
}

/**
 * Refund Notification Consumer
 *
 * Handles notifications for both self-service (agent tool) and admin-triggered refunds.
 * Sends the user a clear WhatsApp confirmation that funds have been credited.
 */
@Injectable()
export class RefundNotificationConsumer {
  private readonly logger = new Logger(RefundNotificationConsumer.name);

  constructor(private readonly whatsappSender: WhatsAppSenderService) {}

  @RabbitSubscribe({
    exchange: USESHOP_EXCHANGE,
    routingKey: 'order.refunded',
    queue: REFUND_QUEUE,
    queueOptions: {
      durable: true,
    },
  })
  async handleOrderRefunded(event: OrderRefundedEvent) {
    this.logger.log(
      `Refund notification for order ${event.orderId} | ${event.phoneNumber} | ₦${event.amount}`,
    );

    try {
      const method = event.refundedTo === 'WALLET' 
        ? 'instantly credited to your UseShop wallet' 
        : 'sent to your bank account';

      const reasonText = event.reason ? `\nReason: ${event.reason}` : '';

      const message =
        `✅ Refund Processed\n\n` +
        `₦${Number(event.amount).toLocaleString()} has been ${method} for order ${event.orderId.slice(0, 8)}...${reasonText}\n\n` +
        `The funds are available immediately for new purchases if credited to wallet.\n\n` +
        `Thank you for shopping with UseShop.`;

      await this.whatsappSender.sendMessage(event.phoneNumber, message);
      this.logger.log(`Refund WhatsApp notification sent to ${event.phoneNumber} for order ${event.orderId}`);
    } catch (error) {
      this.logger.error(`Failed to send refund notification for ${event.orderId}`, error.stack);
    }
  }
}
