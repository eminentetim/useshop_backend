import { Test, TestingModule } from '@nestjs/testing';
import { FulfillmentService } from './fulfillment.service';
import { ConfigService } from '@nestjs/config';

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn(),
    close: jest.fn(),
  }),
}));

describe('FulfillmentService', () => {
  let service: FulfillmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FulfillmentService,
        { provide: ConfigService, useValue: { get: jest.fn((k, d) => d) } },
      ],
    }).compile();

    service = module.get<FulfillmentService>(FulfillmentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
