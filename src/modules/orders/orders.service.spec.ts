import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './orders.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { DataSource } from 'typeorm';
import { UsersService } from '../users/users.service';
import { CheckoutSessionService } from '../checkout/checkout-session.service';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';
import { ConfigService } from '@nestjs/config';
import { FraudCheckService } from '../ai/fraud-check.service';
import { EscalationService } from '../escalations/escalation.service';
import { PaymentsService } from '../payments/payments.service';
import { MessagingService } from '../messaging/messaging.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { Wallet } from '../wallets/entities/wallet.entity';

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn(),
    close: jest.fn(),
  }),
}));

describe('OrdersService - Refund Logic', () => {
  let service: OrdersService;

  const mockOrderRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    manager: {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    },
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(() => mockQueryRunner),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: mockOrderRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: FulfillmentService, useValue: {} },
        { provide: UsersService, useValue: { findOrCreateByPhoneNumber: jest.fn() } },
        { provide: CheckoutSessionService, useValue: {} },
        { provide: WalletLedgerService, useValue: { recordEntry: jest.fn() } },
        { provide: getRepositoryToken(Wallet), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn((k, d) => d) } },
        { provide: FraudCheckService, useValue: { isPhoneBlocked: jest.fn().mockResolvedValue(false), getRecentChecks: jest.fn().mockResolvedValue([]) } },
        { provide: EscalationService, useValue: { createEscalation: jest.fn() } },
        { provide: PaymentsService, useValue: { initiateMonnifyDisbursement: jest.fn() } },
        { provide: MessagingService, useValue: { publishOrderRefunded: jest.fn() } },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('refundToWallet should reject already refunded orders', async () => {
    mockQueryRunner.manager.findOne.mockResolvedValue({ 
      status: 'REFUNDED', 
      user: { phoneNumber: '123' },
      createdAt: new Date().toISOString(),
      price: 100,
    });
    const result = await service.refundToWallet('some-id');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already been refunded');
  });

  it('should have refundToBank method defined', () => {
    expect(typeof service.refundToBank).toBe('function');
  });
});
