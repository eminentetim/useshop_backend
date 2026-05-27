import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';
import { MessagingService } from '../messaging/messaging.service';

describe('PaymentsService - Disbursements & Refunds', () => {
  let service: PaymentsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: ConfigService, useValue: { get: jest.fn((k, d) => d) } },
        { provide: HttpService, useValue: { post: jest.fn() } },
        { provide: WalletLedgerService, useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('handleDisbursementUpdate should not throw on valid input', async () => {
    await expect(
      service.handleDisbursementUpdate({ reference: 'test-ref-123', status: 'SUCCESS' })
    ).resolves.not.toThrow();
  });

  it('initiateMonnifyDisbursement should exist', () => {
    expect(typeof service.initiateMonnifyDisbursement).toBe('function');
  });
});
