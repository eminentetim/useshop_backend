import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { MessagingService } from './messaging.service';
import { WhatsAppMessageConsumer } from './consumers/whatsapp-message.consumer';
import { CheckoutConsumer } from './consumers/checkout.consumer';
import { LowBalanceConsumer } from './consumers/low-balance.consumer';
import { RefundNotificationConsumer } from './consumers/refund-notification.consumer';
import { OrdersModule } from '../orders/orders.module';
import { WalletsModule } from '../wallets/wallets.module';

export const USESHOP_EXCHANGE = 'useshop.events';
export const WHATSAPP_QUEUE = 'whatsapp.incoming';
export const CHECKOUT_QUEUE = 'checkout.sessions';
export const ORDERS_QUEUE = 'orders.created';
export const NOTIFICATIONS_QUEUE = 'notifications.send';
export const LOW_BALANCE_QUEUE = 'wallet.low_balance';
export const REFUND_QUEUE = 'order.refunded';

@Module({
  imports: [
    ConfigModule,
    OrdersModule,
    WalletsModule, // Needed for forced PIN onboarding check in WhatsApp consumer
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        exchanges: [
          {
            name: USESHOP_EXCHANGE,
            type: 'topic',
          },
        ],
        uri: configService.get<string>(
          'RABBITMQ_URI',
          'amqp://useshop:useshop_rabbitmq_password@localhost:5672/useshop',
        ),
        connectionInitOptions: {
          wait: true,
          timeout: 10000,
          reject: true,
        },
        // Enable this for better production observability
        enableControllerDiscovery: true,
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    MessagingService,
    WhatsAppMessageConsumer,
    CheckoutConsumer,
    LowBalanceConsumer,
    RefundNotificationConsumer,
  ],
  exports: [MessagingService, RabbitMQModule],
})
export class MessagingModule {}
