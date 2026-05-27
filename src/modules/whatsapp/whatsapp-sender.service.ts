import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

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
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('WhatsApp credentials not set. Message not sent:', text);
      return;
    }

    const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    };

    try {
      await firstValueFrom(
        this.httpService.post(url, data, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message', error.response?.data || error.message);
    }
  }
}
