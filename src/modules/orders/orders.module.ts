import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { WalletsModule } from '../wallets/wallets.module';
import { MessagingModule } from '../messaging/messaging.module';
import { EscalationsModule } from '../escalations/escalations.module';
import { PaymentsModule } from '../payments/payments.module';
import { UsersModule } from '../users/users.module';
import { CheckoutSessionModule } from '../checkout/checkout-session.module';
import { Wallet } from '../wallets/entities/wallet.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Wallet]), 
    FulfillmentModule, 
    WalletsModule, 
    UsersModule,
    CheckoutSessionModule,
    forwardRef(() => MessagingModule), 
    EscalationsModule, 
    forwardRef(() => PaymentsModule)
  ],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
