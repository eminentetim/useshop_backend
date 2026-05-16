import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { User } from '../users/entities/user.entity';
import { Wallet, Currency } from '../wallets/entities/wallet.entity';
import { Transaction, TransactionType, TransactionStatus } from '../wallets/entities/transaction.entity';
import { FulfillmentService } from '../fulfillment/fulfillment.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly fulfillmentService: FulfillmentService,
  ) {}

  async createOrder(user: User, productData: any): Promise<Order> {
    const order = this.orderRepository.create({
      user,
      productTitle: productData.title,
      price: productData.price,
      productUrl: productData.link,
      imageUrl: productData.image,
      status: OrderStatus.PENDING_PAYMENT,
    });
    return this.orderRepository.save(order);
  }

  async checkout(orderId: string): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id: orderId },
        relations: ['user'],
      });

      if (!order) throw new BadRequestException('Order not found');
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new BadRequestException('Order is already processed or paid');
      }

      // 1. Find NGN Wallet
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { user: { id: order.user.id }, currency: Currency.NGN },
      });

      if (!wallet || wallet.balance < order.price) {
        throw new BadRequestException('Insufficient balance in NGN wallet');
      }

      // 2. Deduct Balance
      wallet.balance = Number(wallet.balance) - Number(order.price);
      await queryRunner.manager.save(wallet);

      // 3. Create Transaction Record
      const transaction = queryRunner.manager.create(Transaction, {
        wallet,
        amount: order.price,
        type: TransactionType.PURCHASE,
        status: TransactionStatus.SUCCESS,
        reference: `ORDER_${order.id}`,
        metadata: { orderId: order.id, product: order.productTitle },
      });
      await queryRunner.manager.save(transaction);

      // 4. Update Order Status
      order.status = OrderStatus.PAID;
      const savedOrder = await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();
      
      this.logger.log(`Order ${order.id} paid successfully. Triggering fulfillment...`);
      // Fire and forget fulfillment for now
      this.fulfillmentService.processAutomatedPurchase(order.id, order.productUrl).then(result => {
        if (result.success) {
            this.orderRepository.update(order.id, { 
                status: OrderStatus.PURCHASING, 
                thirdPartyOrderId: result.thirdPartyOrderId 
            });
        }
      });
      
      return savedOrder;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Checkout failed for order ${orderId}`, err.stack);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async findByUser(user: User): Promise<Order[]> {
    return this.orderRepository.find({
      where: { user: { id: user.id } },
      order: { createdAt: 'DESC' },
    });
  }
}
