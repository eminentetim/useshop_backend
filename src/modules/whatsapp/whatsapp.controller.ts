import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus, Req, Headers, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';
import { WhatsappService } from './whatsapp.service';
import { validateRequest } from 'twilio';

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const verifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (mode === 'subscribe' && token === verifyToken) {
      return challenge;
    }
    return 'Verification failed';
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() body: any,
    @Req() req: express.Request,
    @Headers('x-twilio-signature') signature?: string,
  ) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    const validateSignature = this.configService.get<string>('TWILIO_VALIDATE_SIGNATURE') === 'true';

    // If it's a Twilio request and signature validation is enabled
    if (signature && authToken && validateSignature) {
      const url = this.configService.get<string>('TWILIO_WEBHOOK_URL') ||
                  `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      
      const isValid = validateRequest(authToken, signature, url, body);
      if (!isValid) {
        throw new BadRequestException('Invalid Twilio signature');
      }
    }

    return this.whatsappService.handleIncomingMessage(body);
  }
}


