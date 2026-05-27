import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiService } from './ai.service';
import { SearchTool } from './tools/search.tool';
import { ShoppingAgentService } from './shopping-agent.service';
import { CartModule } from '../cart/cart.module';
import { CheckoutSessionModule } from '../checkout/checkout-session.module';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersModule } from '../users/users.module';
import { AiMetricsController } from './ai-metrics.controller';
import { MessagingModule } from '../messaging/messaging.module';
import { RateLimiterService } from './rate-limiter.service';
import { LangSmithWebhookController } from './langsmith-webhook.controller';
import { OrdersModule } from '../orders/orders.module';


@Module({
  imports: [
    HttpModule,
    CartModule,
    CheckoutSessionModule,
    WalletsModule,
    UsersModule,
    MessagingModule,
    OrdersModule,
  ],
  controllers: [AiMetricsController, LangSmithWebhookController],
  providers: [AiService, SearchTool, ShoppingAgentService, RateLimiterService],
  exports: [AiService, ShoppingAgentService, RateLimiterService],
})
export class AiModule {}
