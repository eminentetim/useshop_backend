import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PaymentsService } from './payments.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Wallet } from '../wallets/entities/wallet.entity';
import { WalletsModule } from '../wallets/wallets.module';
import { MessagingModule } from '../messaging/messaging.module';
import { MonnifyWebhookController } from './monnify-webhook.controller';
import { MonnifyPaymentProvider } from './providers/monnify-payment.provider';
import { PAYMENT_PROVIDER } from './interfaces/payment-provider.interface';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Wallet]), WalletsModule, MessagingModule],
  controllers: [MonnifyWebhookController],
  providers: [
    PaymentsService,
    MonnifyPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useClass: MonnifyPaymentProvider,
    },
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
