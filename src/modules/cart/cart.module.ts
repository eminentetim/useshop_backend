import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CartService } from './cart.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: async (configService: ConfigService) => {
        const Redis = require('ioredis');
        const client = new Redis({
          host: configService.get<string>('REDIS_HOST', '127.0.0.1'),
          port: configService.get<number>('REDIS_PORT', 6379),
          retryStrategy: (times: number) => Math.min(times * 50, 2000),
        });
        client.on('error', (err: Error) => console.error('Redis Client Error', err));
        return client;
      },
      inject: [ConfigService],
    },
    CartService,
  ],
  exports: [CartService],
})
export class CartModule {}
