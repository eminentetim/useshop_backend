import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { User } from './modules/users/entities/user.entity';
import { Wallet } from './modules/wallets/entities/wallet.entity';
import { Transaction } from './modules/wallets/entities/transaction.entity';
import { Order } from './modules/orders/entities/order.entity';
import { UsersModule } from './modules/users/users.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AiModule } from './modules/ai/ai.module';
import { OrdersModule } from './modules/orders/orders.module';
import { FulfillmentModule } from './modules/fulfillment/fulfillment.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DATABASE_HOST'),
        port: configService.get<number>('DATABASE_PORT'),
        username: configService.get<string>('DATABASE_USER'),
        password: configService.get<string>('DATABASE_PASSWORD'),
        database: configService.get<string>('DATABASE_NAME'),
        entities: [User, Wallet, Transaction, Order],
        synchronize: true, // Only for development
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    WalletsModule,
    WhatsappModule,
    PaymentsModule,
    AiModule,
    OrdersModule,
    FulfillmentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
