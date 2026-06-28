jest.mock('puppeteer', () => ({}));

import { Test, TestingModule } from '@nestjs/testing';
import { WhatsappService } from './whatsapp.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { AiService } from '../ai/ai.service';
import { CheckoutSessionService } from '../checkout/checkout-session.service';
import { OrdersService } from '../orders/orders.service';
import { ShoppingAgentService } from '../ai/shopping-agent.service';
import { PaymentsService } from '../payments/payments.service';
import { ShoppingPINService } from '../wallets/pin/shopping-pin.service';
import { of } from 'rxjs';

// Mock Twilio
const mockCreateMessage = jest.fn().mockResolvedValue({ sid: 'SM123' });
jest.mock('twilio', () => {
  return {
    Twilio: jest.fn().mockImplementation(() => {
      return {
        messages: {
          create: mockCreateMessage,
        },
      };
    }),
  };
});

describe('WhatsappService', () => {
  let service: WhatsappService;
  let usersService: jest.Mocked<UsersService>;
  let walletsService: jest.Mocked<WalletsService>;
  let aiService: jest.Mocked<AiService>;
  let configService: jest.Mocked<ConfigService>;
  let httpService: jest.Mocked<HttpService>;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'TWILIO_ACCOUNT_SID') return 'ACmock';
        if (key === 'TWILIO_AUTH_TOKEN') return 'tokenmock';
        if (key === 'TWILIO_PHONE_NUMBER') return 'whatsapp:+14155238886';
        return null;
      }),
    };

    const mockHttpService = {
      post: jest.fn().mockReturnValue(of({ data: { message_id: 'fb123' } })),
      get: jest.fn().mockReturnValue(of({ data: { url: 'https://fb-media-url.com' } })),
    };

    const mockUsersService = {
      findOrCreateByPhoneNumber: jest.fn().mockResolvedValue({
        user: { id: 1, phoneNumber: '+2348012345678' },
        isNew: false,
      }),
    };

    const mockWalletsService = {
      createWallet: jest.fn().mockImplementation((user) => ({
        id: 'wallet-uuid',
        user,
        currency: 'NGN',
        balance: 0,
      })),
      findByUser: jest.fn().mockResolvedValue([
        { currency: 'NGN', balance: 5000, monnifyAccountNumber: '1234567890', monnifyBankName: 'Test Bank' },
      ]),
      updateWallet: jest.fn().mockResolvedValue({}),
    };

    const mockAiService = {
      transcribeVoice: jest.fn().mockResolvedValue('transcribed text message'),
      analyzeImage: jest.fn().mockResolvedValue('analyzed image description'),
    };

    const mockCheckoutSessionService = {
      requestPaymentConfirmation: jest.fn(),
      confirmWithPin: jest.fn(),
    };

    const mockOrdersService = {};
    const mockShoppingAgentService = {
      processMessage: jest.fn().mockResolvedValue('AI Response message'),
    };

    const mockPaymentsService = {
      createReservedAccount: jest.fn().mockResolvedValue({
        accountReference: 'ref123',
        accounts: [
          { accountNumber: '1234567890', bankName: 'Test Bank', accountName: 'Test User' },
        ],
      }),
    };

    const mockShoppingPINService = {
      setPIN: jest.fn().mockResolvedValue({}),
      hasPINSet: jest.fn().mockReturnValue(true), // true by default to bypass onboarding in existing tests
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpService, useValue: mockHttpService },
        { provide: UsersService, useValue: mockUsersService },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: AiService, useValue: mockAiService },
        { provide: CheckoutSessionService, useValue: mockCheckoutSessionService },
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: ShoppingAgentService, useValue: mockShoppingAgentService },
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: ShoppingPINService, useValue: mockShoppingPINService },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
    usersService = module.get(UsersService);
    walletsService = module.get(WalletsService);
    aiService = module.get(AiService);
    configService = module.get(ConfigService);
    httpService = module.get(HttpService);
    
    // Grab the mocked ShoppingPINService to customize in specific tests
    (service as any).shoppingPINService = mockShoppingPINService;
    (service as any).paymentsService = mockPaymentsService;

    mockCreateMessage.mockClear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleIncomingMessage', () => {
    it('should parse Twilio text message and handle balance command', async () => {
      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: 'balance',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      // Verify user lookup used normalized number (stripped whatsapp:)
      expect(usersService.findOrCreateByPhoneNumber).toHaveBeenCalledWith('+2348012345678');
      
      // Verify balance response was sent via Twilio
      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('Your UseShop Balances:'),
        }),
      );
    });

    it('should handle Twilio audio voice transcription', async () => {
      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: '',
        NumMedia: '1',
        MediaUrl0: 'https://twilio-media.com/audio.ogg',
        MediaContentType0: 'audio/ogg',
      };

      await service.handleIncomingMessage(payload);

      expect(aiService.transcribeVoice).toHaveBeenCalledWith('https://twilio-media.com/audio.ogg');
    });

    it('should handle Twilio image analysis', async () => {
      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: 'show me this',
        NumMedia: '1',
        MediaUrl0: 'https://twilio-media.com/image.jpg',
        MediaContentType0: 'image/jpeg',
      };

      await service.handleIncomingMessage(payload);

      expect(aiService.analyzeImage).toHaveBeenCalledWith('https://twilio-media.com/image.jpg', 'show me this');
    });

    it('should initialize onboarding and create reserved account on first message', async () => {
      (service as any).shoppingPINService.hasPINSet.mockReturnValue(false);

      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: 'Hi',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      expect((service as any).paymentsService.createReservedAccount).toHaveBeenCalled();
      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('Welcome to UseShop! 🛍️'),
        }),
      );

      const state = (service as any).onboardingStates.get('+2348012345678');
      expect(state).toBeDefined();
      expect(state.step).toBe('AWAITING_PIN');
    });

    it('should reject invalid PIN and ask again', async () => {
      (service as any).shoppingPINService.hasPINSet.mockReturnValue(false);
      (service as any).onboardingStates.set('+2348012345678', { step: 'AWAITING_PIN' });

      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: '123',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('Invalid PIN. Please reply with a 4 to 6-digit numeric PIN'),
        }),
      );
      
      const state = (service as any).onboardingStates.get('+2348012345678');
      expect(state.step).toBe('AWAITING_PIN');
    });

    it('should accept valid PIN and ask for confirmation', async () => {
      (service as any).shoppingPINService.hasPINSet.mockReturnValue(false);
      (service as any).onboardingStates.set('+2348012345678', { step: 'AWAITING_PIN' });

      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: '1234',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('Please re-enter your 4 to 6-digit Shopping PIN to confirm:'),
        }),
      );

      const state = (service as any).onboardingStates.get('+2348012345678');
      expect(state.step).toBe('AWAITING_PIN_CONFIRM');
      expect(state.tempPin).toBe('1234');
    });

    it('should reject mismatching PIN confirmation and reset', async () => {
      (service as any).shoppingPINService.hasPINSet.mockReturnValue(false);
      (service as any).onboardingStates.set('+2348012345678', { step: 'AWAITING_PIN_CONFIRM', tempPin: '1234' });

      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: '5678',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('PINs did not match. Let\'s try again.'),
        }),
      );

      const state = (service as any).onboardingStates.get('+2348012345678');
      expect(state.step).toBe('AWAITING_PIN');
    });

    it('should complete setup on matching PIN confirmation', async () => {
      (service as any).shoppingPINService.hasPINSet.mockReturnValue(false);
      (service as any).onboardingStates.set('+2348012345678', { step: 'AWAITING_PIN_CONFIRM', tempPin: '1234' });

      const payload = {
        MessageSid: 'SM123',
        From: 'whatsapp:+2348012345678',
        Body: '1234',
        NumMedia: '0',
      };

      await service.handleIncomingMessage(payload);

      expect((service as any).shoppingPINService.setPIN).toHaveBeenCalledWith(expect.any(Object), '1234');
      expect(mockCreateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+2348012345678',
          body: expect.stringContaining('Setup Complete!'),
        }),
      );

      const state = (service as any).onboardingStates.get('+2348012345678');
      expect(state).toBeUndefined();
    });
  });

  describe('sendMessage', () => {
    it('should send via Twilio if account credentials are configured', async () => {
      await service.sendMessage('+2348012345678', 'Test message');

      expect(mockCreateMessage).toHaveBeenCalledWith({
        body: 'Test message',
        from: 'whatsapp:+14155238886',
        to: 'whatsapp:+2348012345678',
      });
    });

    it('should fallback to Facebook Graph API if Twilio credentials are not set', async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'WHATSAPP_PHONE_NUMBER_ID') return 'fb-phone-id';
        if (key === 'WHATSAPP_ACCESS_TOKEN') return 'fb-token';
        return null;
      });

      await service.sendMessage('+2348012345678', 'Test message');

      expect(httpService.post).toHaveBeenCalled();
    });
  });
});
