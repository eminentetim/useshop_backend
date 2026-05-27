import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wallet, Currency } from './entities/wallet.entity';
import { User } from '../users/entities/user.entity';

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  async createWallet(user: User, currency: Currency = Currency.NGN): Promise<Wallet> {
    const wallet = this.walletRepository.create({
      user,
      currency,
      balance: 0,
    });
    return this.walletRepository.save(wallet);
  }

  async findByUser(user: User): Promise<Wallet[]> {
    return this.walletRepository.find({ where: { user: { id: user.id } } });
  }

  async updateWallet(walletId: string, updateData: Partial<Wallet>): Promise<Wallet | null> {
    await this.walletRepository.update(walletId, updateData);
    return this.walletRepository.findOne({ where: { id: walletId } });
  }

  async findAll(phone?: string): Promise<Wallet[]> {
    const query = this.walletRepository.createQueryBuilder('wallet')
      .leftJoinAndSelect('wallet.user', 'user')
      .orderBy('wallet.createdAt', 'DESC');

    if (phone) {
      query.where('user.phoneNumber = :phone', { phone });
    }

    return query.getMany();
  }
}
