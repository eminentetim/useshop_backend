import { Injectable, Logger } from '@nestjs/common';
// RabbitMQ types removed for minimal startup (no AmqpConnection in graph to avoid circular inside MessagingModule)
import {
  USESHOP_EXCHANGE,
  WHATSAPP_QUEUE,
  CHECKOUT_QUEUE,
  ORDERS_QUEUE,
} from './messaging.module';

export interface WhatsAppMessageEvent {
  phoneNumber: string;
  messageId: string;
  type: string;
  payload: any;
  receivedAt: string;
}

export interface CheckoutSessionEvent {
  sessionId: string;
  phoneNumber: string;
  action: 'created' | 'confirmed' | 'expired' | 'failed';
  totalAmount?: number;
  cartSnapshot?: any;
  metadata?: Record<string, any>;
}

export interface OrderCreatedEvent {
  orderId: string;
  phoneNumber: string;
  totalAmount: number;
  items: any[];
  paymentReference?: string;
}

export interface OrderRefundedEvent {
  orderId: string;
  phoneNumber: string;
  amount: number;
  reason?: string;
  refundedTo: 'WALLET' | 'BANK';
  timestamp: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly amqpConnection: any = null; // Always null in minimal startup (RabbitMQ disabled to break cycles)

  constructor() {
    this.logger.warn('MessagingService running in NO-RABBIT mode for clean WhatsApp test startup. All publish* are no-ops.');
  }

  /**
   * Publish an incoming WhatsApp message for async processing (AI, cart, etc.)
   */
  private async safePublish(routingKey: string, payload: any, logMsg?: string) {
    // Rabbit disabled for minimal startup — no-op is intentional
    this.logger.debug(`[NO-RABBIT] Suppressed publish to ${routingKey}: ${logMsg || JSON.stringify(payload).slice(0, 80)}`);
  }

  async publishWhatsAppMessage(event: WhatsAppMessageEvent) {
    await this.safePublish('whatsapp.message.received', event, `Published WhatsApp message for ${event.phoneNumber}`);
  }

  /**
   * Publish checkout session lifecycle events
   */
  async publishCheckoutEvent(event: CheckoutSessionEvent) {
    await this.safePublish('checkout.session.updated', event, `Published checkout event: ${event.action} for ${event.phoneNumber}`);
  }

  /**
   * Publish when an order has been successfully created (after payment)
   */
  async publishOrderCreated(event: OrderCreatedEvent) {
    await this.safePublish('order.created', event, `Published OrderCreated event for order ${event.orderId}`);
  }

  async publishLowBalanceAlert(phoneNumber: string, currentBalance: number, currency: string) {
    await this.safePublish('wallet.low_balance', {
      phoneNumber,
      currentBalance,
      currency,
      timestamp: new Date().toISOString(),
    }, `Published low balance alert for ${phoneNumber}`);
  }

  // Example of how to publish to a specific queue directly if needed
  async sendToQueue(queue: string, payload: any) {
    this.logger.debug(`[NO-RABBIT] Suppressed sendToQueue ${queue}`);
  }

  /**
   * Publish when a refund has been issued (wallet credit or bank disbursement).
   * Enables decoupled notifications, audit, and future workflows.
   */
  async publishOrderRefunded(event: OrderRefundedEvent) {
    await this.safePublish('order.refunded', event, `Published OrderRefunded event for order ${event.orderId}`);
  }
}
