jest.mock('puppeteer', () => ({}));

import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';

jest.mock('twilio', () => ({
  validateRequest: jest.fn().mockImplementation((token, signature, url, body) => {
    return signature === 'valid-signature';
  }),
}));

describe('WhatsappController', () => {
  let controller: WhatsappController;
  let whatsappService: jest.Mocked<WhatsappService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const mockWhatsappService = {
      handleIncomingMessage: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'TWILIO_ACCOUNT_SID') return 'ACmock';
        if (key === 'TWILIO_AUTH_TOKEN') return 'tokenmock';
        if (key === 'TWILIO_VALIDATE_SIGNATURE') return 'true';
        if (key === 'WHATSAPP_VERIFY_TOKEN') return 'fb-verify-token';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsappController],
      providers: [
        { provide: WhatsappService, useValue: mockWhatsappService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<WhatsappController>(WhatsappController);
    whatsappService = module.get(WhatsappService);
    configService = module.get(ConfigService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('verifyWebhook', () => {
    it('should verify Facebook webhook when challenge matches', () => {
      const result = controller.verifyWebhook('subscribe', 'fb-verify-token', 'challenge-text');
      expect(result).toBe('challenge-text');
    });

    it('should fail verification when token mismatch', () => {
      const result = controller.verifyWebhook('subscribe', 'wrong-token', 'challenge-text');
      expect(result).toBe('Verification failed');
    });
  });

  describe('handleWebhook', () => {
    it('should pass if signature is valid', async () => {
      const mockReq = {
        protocol: 'https',
        get: () => 'example.com',
        originalUrl: '/whatsapp/webhook',
      } as any;

      const body = { From: 'whatsapp:+123', Body: 'hello' };
      await controller.handleWebhook(body, mockReq, 'valid-signature');
      expect(whatsappService.handleIncomingMessage).toHaveBeenCalledWith(body);
    });

    it('should throw BadRequestException if signature is invalid', async () => {
      const mockReq = {
        protocol: 'https',
        get: () => 'example.com',
        originalUrl: '/whatsapp/webhook',
      } as any;

      const body = { From: 'whatsapp:+123', Body: 'hello' };
      await expect(
        controller.handleWebhook(body, mockReq, 'invalid-signature'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should bypass validation if validateSignature setting is false', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'TWILIO_VALIDATE_SIGNATURE') return 'false'; // disabled
        if (key === 'TWILIO_ACCOUNT_SID') return 'ACmock';
        if (key === 'TWILIO_AUTH_TOKEN') return 'tokenmock';
        return null;
      });

      const mockReq = {
        protocol: 'https',
        get: () => 'example.com',
        originalUrl: '/whatsapp/webhook',
      } as any;

      const body = { From: 'whatsapp:+123', Body: 'hello' };
      await controller.handleWebhook(body, mockReq, 'invalid-signature');
      expect(whatsappService.handleIncomingMessage).toHaveBeenCalledWith(body);
    });
  });
});
