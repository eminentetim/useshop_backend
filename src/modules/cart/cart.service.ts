import { Injectable, Inject, Logger } from '@nestjs/common';

export interface CartItem {
  id: string;                    // Unique line item id
  productTitle: string;
  price: number;
  quantity: number;
  productUrl?: string;
  imageUrl?: string;
  metadata?: Record<string, any>;
}

export interface Cart {
  userId: string;
  phoneNumber: string;
  items: CartItem[];
  total: number;
  currency: string;
  updatedAt: string;
}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);
  private readonly CART_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days

  constructor(@Inject('REDIS_CLIENT') private readonly redis: any) {}

  private getCartKey(phoneNumber: string): string {
    return `cart:${phoneNumber}`;
  }

  async getCart(phoneNumber: string): Promise<Cart | null> {
    const key = this.getCartKey(phoneNumber);
    const data = await this.redis.get(key);
    if (!data) return null;

    return JSON.parse(data) as Cart;
  }

  async addItem(
    phoneNumber: string,
    item: Omit<CartItem, 'id'>,
  ): Promise<Cart> {
    const key = this.getCartKey(phoneNumber);
    let cart = await this.getCart(phoneNumber);

    if (!cart) {
      cart = {
        userId: '', // Will be populated by caller if needed
        phoneNumber,
        items: [],
        total: 0,
        currency: 'NGN',
        updatedAt: new Date().toISOString(),
      };
    }

    const newItem: CartItem = {
      ...item,
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    cart.items.push(newItem);
    cart.total = this.calculateTotal(cart.items);
    cart.updatedAt = new Date().toISOString();

    await this.redis.setex(key, this.CART_TTL_SECONDS, JSON.stringify(cart));

    this.logger.log(`Added item to cart for ${phoneNumber}: ${item.productTitle}`);
    return cart;
  }

  async removeItem(phoneNumber: string, itemId: string): Promise<Cart | null> {
    const cart = await this.getCart(phoneNumber);
    if (!cart) return null;

    cart.items = cart.items.filter((i) => i.id !== itemId);
    cart.total = this.calculateTotal(cart.items);
    cart.updatedAt = new Date().toISOString();

    const key = this.getCartKey(phoneNumber);
    await this.redis.setex(key, this.CART_TTL_SECONDS, JSON.stringify(cart));

    return cart;
  }

  async clearCart(phoneNumber: string): Promise<void> {
    const key = this.getCartKey(phoneNumber);
    await this.redis.del(key);
    this.logger.log(`Cleared cart for ${phoneNumber}`);
  }

  async updateQuantity(
    phoneNumber: string,
    itemId: string,
    quantity: number,
  ): Promise<Cart | null> {
    const cart = await this.getCart(phoneNumber);
    if (!cart) return null;

    const item = cart.items.find((i) => i.id === itemId);
    if (!item) return cart;

    if (quantity <= 0) {
      return this.removeItem(phoneNumber, itemId);
    }

    item.quantity = quantity;
    cart.total = this.calculateTotal(cart.items);
    cart.updatedAt = new Date().toISOString();

    const key = this.getCartKey(phoneNumber);
    await this.redis.setex(key, this.CART_TTL_SECONDS, JSON.stringify(cart));

    return cart;
  }

  private calculateTotal(items: CartItem[]): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  async getItemCount(phoneNumber: string): Promise<number> {
    const cart = await this.getCart(phoneNumber);
    if (!cart) return 0;
    return cart.items.reduce((sum, item) => sum + item.quantity, 0);
  }
}
