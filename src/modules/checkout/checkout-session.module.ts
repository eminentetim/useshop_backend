import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CheckoutSessionService } from './checkout-session.service';
import { CartModule } from '../cart/cart.module';
import { MessagingModule } from '../messaging/messaging.module';
import { WalletsModule } from '../wallets/wallets.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Wallet } from '../wallets/entities/wallet.entity';
import { FraudCheckService } from '../ai/fraud-check.service';

@Module({
  imports: [
    ConfigModule,
    CartModule,
    MessagingModule,
    WalletsModule,
    TypeOrmModule.forFeature([Wallet]),
  ],
  providers: [CheckoutSessionService, FraudCheckService],
  exports: [CheckoutSessionService, FraudCheckService],
})
export class CheckoutSessionModule {}
