import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { WalletsModule } from '../wallets/wallets.module';
import { MessagingModule } from '../messaging/messaging.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [TypeOrmModule.forFeature([Order]), FulfillmentModule, WalletsModule, MessagingModule, EscalationsModule, PaymentsModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
