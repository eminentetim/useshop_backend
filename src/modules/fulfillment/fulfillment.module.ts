import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [ConfigModule],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
