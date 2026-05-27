import { Injectable, Logger } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
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

  constructor(private readonly amqpConnection: AmqpConnection) {}

  /**
   * Publish an incoming WhatsApp message for async processing (AI, cart, etc.)
   */
  async publishWhatsAppMessage(event: WhatsAppMessageEvent) {
    await this.amqpConnection.publish(
      USESHOP_EXCHANGE,
      'whatsapp.message.received',
      event,
    );
    this.logger.debug(`Published WhatsApp message for ${event.phoneNumber}`);
  }

  /**
   * Publish checkout session lifecycle events
   */
  async publishCheckoutEvent(event: CheckoutSessionEvent) {
    await this.amqpConnection.publish(
      USESHOP_EXCHANGE,
      'checkout.session.updated',
      event,
    );
    this.logger.log(`Published checkout event: ${event.action} for ${event.phoneNumber}`);
  }

  /**
   * Publish when an order has been successfully created (after payment)
   */
  async publishOrderCreated(event: OrderCreatedEvent) {
    await this.amqpConnection.publish(
      USESHOP_EXCHANGE,
      'order.created',
      event,
    );
    this.logger.log(`Published OrderCreated event for order ${event.orderId}`);
  }

  async publishLowBalanceAlert(phoneNumber: string, currentBalance: number, currency: string) {
    await this.amqpConnection.publish(USESHOP_EXCHANGE, 'wallet.low_balance', {
      phoneNumber,
      currentBalance,
      currency,
      timestamp: new Date().toISOString(),
    });
    this.logger.log(`Published low balance alert for ${phoneNumber}`);
  }

  // Example of how to publish to a specific queue directly if needed
  async sendToQueue(queue: string, payload: any) {
    await this.amqpConnection.publish('', queue, payload, {
      persistent: true,
    });
  }

  /**
   * Publish when a refund has been issued (wallet credit or bank disbursement).
   * Enables decoupled notifications, audit, and future workflows.
   */
  async publishOrderRefunded(event: OrderRefundedEvent) {
    await this.amqpConnection.publish(
      USESHOP_EXCHANGE,
      'order.refunded',
      event,
    );
    this.logger.log(`Published OrderRefunded event for order ${event.orderId}`);
  }
}
