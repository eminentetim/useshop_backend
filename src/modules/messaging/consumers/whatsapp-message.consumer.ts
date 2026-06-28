import { Injectable, Logger } from '@nestjs/common';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { USESHOP_EXCHANGE, WHATSAPP_QUEUE } from '../messaging.module';
import { ShoppingAgentService } from '../../ai/shopping-agent.service';
import { WhatsAppSenderService } from '../../whatsapp/whatsapp-sender.service';
import { RateLimiterService } from '../../ai/rate-limiter.service';

export interface IncomingWhatsAppMessage {
  phoneNumber: string;
  messageId: string;
  type: string;
  payload: any;
  receivedAt: string;
}

/**
 * WhatsApp Message Worker (now the real brain for AI conversations)
 *
 * This worker receives messages published from the thin webhook.
 * All AI processing, cart logic, etc. should live here.
 */
@Injectable()
export class WhatsAppMessageConsumer {
  private readonly logger = new Logger(WhatsAppMessageConsumer.name);

  constructor(
    private readonly shoppingAgent: ShoppingAgentService,
    private readonly whatsappSender: WhatsAppSenderService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  @RabbitSubscribe({
    exchange: USESHOP_EXCHANGE,
    routingKey: 'whatsapp.message.received',
    queue: WHATSAPP_QUEUE,
    queueOptions: {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': `${USESHOP_EXCHANGE}.dlx`,
        'x-message-ttl': 1000 * 60 * 5,
      },
    },
    errorHandler: (channel, msg, error) => {
      console.error('Error processing WhatsApp message in worker:', error);
      channel.nack(msg, false, false);
    },
  })
  async handleIncomingMessage(msg: IncomingWhatsAppMessage) {
    this.logger.log(
      `Worker processing WhatsApp message from ${msg.phoneNumber}`,
    );

    try {
      const userInput = msg.payload?.userInput;

      if (!userInput) {
        this.logger.warn('No userInput in message payload');
        return;
      }

      // Production hardening: Rate limit per phone
      const limited = await this.rateLimiter.isRateLimited(msg.phoneNumber);
      if (limited) {
        await this.whatsappSender.sendMessage(msg.phoneNumber, "You're sending messages too quickly. Please wait a moment before trying again.");
        return;
      }

      // Use the new LangGraph Shopping Agent
      const aiResponse = await this.shoppingAgent.processMessage(userInput, msg.phoneNumber);

      await this.whatsappSender.sendMessage(msg.phoneNumber, aiResponse);
      this.logger.debug(`Worker replied to ${msg.phoneNumber}`);
    } catch (error) {
      this.logger.error(
        `Worker failed to process message ${msg.messageId}`,
        error.stack,
      );
      throw error;
    }
  }
}
