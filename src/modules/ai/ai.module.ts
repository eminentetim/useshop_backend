import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AiService } from './ai.service';
import { SearchTool } from './tools/search.tool';
import { ShoppingAgentService } from './shopping-agent.service';
import { CartModule } from '../cart/cart.module';
import { CheckoutSessionModule } from '../checkout/checkout-session.module';
import { WalletsModule } from '../wallets/wallets.module';
import { UsersModule } from '../users/users.module';
import { AiMetricsController } from './ai-metrics.controller';
import { RateLimiterService } from './rate-limiter.service';
import { LangSmithWebhookController } from './langsmith-webhook.controller';
// Temporarily removed MessagingModule + OrdersModule forwardRef to allow minimal startup for WhatsApp testing (breaks deep provider cycles)


@Module({
  imports: [
    HttpModule,
    CartModule,
    forwardRef(() => CheckoutSessionModule),
    WalletsModule,
    UsersModule,
    // forwardRef(() => MessagingModule), // removed for minimal WhatsApp test startup (circular)
    // forwardRef(() => OrdersModule),    // removed for minimal WhatsApp test startup (circular)
  ],
  controllers: [AiMetricsController, LangSmithWebhookController],
  providers: [AiService, SearchTool, ShoppingAgentService, RateLimiterService],
  exports: [AiService, ShoppingAgentService, RateLimiterService],
})
export class AiModule {}
