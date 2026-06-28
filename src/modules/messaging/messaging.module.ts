import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessagingService } from './messaging.service';

// Constants still exported for any legacy consumer references (not used in minimal startup)
export const USESHOP_EXCHANGE = 'useshop.events';
export const WHATSAPP_QUEUE = 'whatsapp.incoming';
export const CHECKOUT_QUEUE = 'checkout.sessions';
export const ORDERS_QUEUE = 'orders.created';
export const NOTIFICATIONS_QUEUE = 'notifications.send';
export const LOW_BALANCE_QUEUE = 'wallet.low_balance';
export const REFUND_QUEUE = 'order.refunded';

@Module({
  imports: [ConfigModule],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
