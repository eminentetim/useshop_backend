import { Injectable, Logger } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { USESHOP_EXCHANGE, CHECKOUT_QUEUE } from '../messaging.module';
import { OrdersService } from '../../orders/orders.service';
import { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service';
import { EscalationService } from '../../escalations/escalation.service';

export interface CheckoutEvent {
  sessionId: string;
  phoneNumber: string;
  action: 'created' | 'confirmed' | 'expired' | 'failed';
  totalAmount?: number;
  cartSnapshot?: any;
  metadata?: Record<string, any>;
}

/**
 * Checkout Worker
 *
 * This is now connected to real payment processing.
 */
@Injectable()
export class CheckoutConsumer {
  private readonly logger = new Logger(CheckoutConsumer.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly whatsappSender: WhatsAppSenderService,
    private readonly escalationService: EscalationService,
  ) {}

  @RabbitSubscribe({
    exchange: USESHOP_EXCHANGE,
    routingKey: 'checkout.session.updated',
    queue: CHECKOUT_QUEUE,
    queueOptions: {
      durable: true,
    },
  })
  async handleCheckoutEvent(event: CheckoutEvent) {
    this.logger.log(
      `Checkout event received: ${event.action} for ${event.phoneNumber} (session: ${event.sessionId})`,
    );

    switch (event.action) {
      case 'confirmed':
        this.logger.log(
          `→ Starting atomic payment processing for session ${event.sessionId}`,
        );

        try {
          await this.ordersService.processCheckoutSessionPayment(event);
          this.logger.log(`Payment successfully processed for session ${event.sessionId}`);

          await this.whatsappSender.sendMessage(
            event.phoneNumber,
            `✅ Payment successful! Your order(s) totaling ₦${event.totalAmount?.toLocaleString()} have been placed.\n\n` +
            `We're now processing fulfillment. You'll get tracking updates shortly.`
          );
        } catch (error) {
          this.logger.error(`Payment processing failed for session ${event.sessionId}`, error.stack);
          await this.whatsappSender.sendMessage(
            event.phoneNumber,
            `❌ Sorry, we couldn't complete your payment. Please try again or contact support.`
          );
        }
        break;

      case 'expired':
        this.logger.warn(
          `Checkout session expired for ${event.phoneNumber}. Consider sending recovery message.`,
        );
        // TODO: Publish to notifications queue for abandoned cart recovery
        break;

      case 'failed':
        this.logger.error(
          `Checkout failed for ${event.phoneNumber}. Session: ${event.sessionId}`,
        );
        if (event.metadata?.type === 'human_escalation') {
          await this.escalationService.createEscalation(
            event.phoneNumber,
            event.metadata.reason || 'Agent escalated conversation',
            event.metadata
          );
          await this.whatsappSender.sendMessage(
            event.phoneNumber,
            "Your request has been escalated to our support team. A human agent will contact you shortly."
          );
        }
        break;

      default:
        this.logger.debug(`Unhandled checkout action: ${event.action}`);
    }
  }
}
