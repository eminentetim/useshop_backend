import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { PaymentsModule } from '../payments/payments.module';
import { AiModule } from '../ai/ai.module';
import { OrdersModule } from '../orders/orders.module';
import { CartModule } from '../cart/cart.module';
import { CheckoutSessionModule } from '../checkout/checkout-session.module';
import { MessagingModule } from '../messaging/messaging.module';

@Module({
  imports: [
    HttpModule,
    UsersModule,
    WalletsModule,
    PaymentsModule,
    AiModule,
    OrdersModule,
    CartModule,
    CheckoutSessionModule,
    MessagingModule, // For publishing messages to RabbitMQ workers
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsAppSenderService],
  exports: [WhatsappService, WhatsAppSenderService],
})
export class WhatsappModule {}
