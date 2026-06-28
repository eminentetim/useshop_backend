import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PaymentsService } from './payments.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Wallet } from '../wallets/entities/wallet.entity';
import { WalletsModule } from '../wallets/wallets.module';
import { MonnifyWebhookController } from './monnify-webhook.controller';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([Wallet]), WalletsModule],
  controllers: [MonnifyWebhookController],
  providers: [
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
