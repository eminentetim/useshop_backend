import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async findOrCreateByPhoneNumber(phoneNumber: string): Promise<{ user: User; isNew: boolean }> {
    let user = await this.userRepository.findOne({ where: { phoneNumber } });
    let isNew = false;

    if (!user) {
      user = this.userRepository.create({ phoneNumber });
      user = await this.userRepository.save(user);
      isNew = true;
    }

    return { user, isNew };
  }

  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { phoneNumber }, relations: ['wallets'] });
  }
}
