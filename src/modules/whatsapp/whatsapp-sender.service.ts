import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Twilio } from 'twilio';

/**
 * Lightweight service whose only job is sending WhatsApp messages.
 * This helps avoid circular dependencies between modules.
 */
@Injectable()
export class WhatsAppSenderService {
  private readonly logger = new Logger(WhatsAppSenderService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async sendMessage(to: string, text: string) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');

    if (accountSid && authToken) {
      const fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') || 'whatsapp:+14155238886';
      
      // Twilio format requires "whatsapp:<phone_number>"
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const formattedFrom = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;

      try {
        const client = new Twilio(accountSid, authToken);
        await client.messages.create({

          body: text,
          from: formattedFrom,
          to: formattedTo,
        });
        this.logger.log(`WhatsApp message sent via Twilio to ${formattedTo}`);
        return;
      } catch (error) {
        this.logger.error(`Failed to send WhatsApp message via Twilio: ${error.message}`);
        return;
      }
    }

    // Fallback to Facebook Graph API
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('Neither Twilio nor Facebook WhatsApp credentials are set. Message not sent:', text);
      return;
    }

    const cleanTo = to.replace('whatsapp:', ''); // Facebook API expects raw number
    const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: { body: text },
    };

    try {
      await firstValueFrom(
        this.httpService.post(url, data, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      this.logger.log(`WhatsApp message sent via Facebook Graph API to ${cleanTo}`);
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message via Facebook Graph API', error.response?.data || error.message);
    }
  }
}

