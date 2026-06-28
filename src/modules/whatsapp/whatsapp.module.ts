import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AiModule } from '../ai/ai.module';
import { CartModule } from '../cart/cart.module';
import { CheckoutSessionModule } from '../checkout/checkout-session.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    HttpModule,
    UsersModule,
    WalletsModule,
    PaymentsModule,
    AiModule,
    // forwardRef(() => OrdersModule), // removed for minimal WhatsApp test startup (prevents loading Orders + transitive cycles)
    CartModule,
    CheckoutSessionModule,
    // MessagingModule, // Temporarily removed - consumer disabled for startup testing
  ],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsAppSenderService],
  exports: [WhatsappService, WhatsAppSenderService],
})
export class WhatsappModule {}
