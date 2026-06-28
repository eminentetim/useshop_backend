import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const MOCK_PRODUCTS = [
  { title: 'Eva Water (75cl)', price: 150, link: 'https://useshop.ai/products/eva-water', image: 'https://useshop.ai/images/eva-water.jpg' },
  { title: 'Coca-Cola Can (33cl)', price: 300, link: 'https://useshop.ai/products/coke', image: 'https://useshop.ai/images/coke.jpg' },
  { title: 'Pepsi Bottle (50cl)', price: 250, link: 'https://useshop.ai/products/pepsi', image: 'https://useshop.ai/images/pepsi.jpg' },
  { title: 'Indomie Instant Noodles Hungry Man Size', price: 1500, link: 'https://useshop.ai/products/indomie', image: 'https://useshop.ai/images/indomie.jpg' },
  { title: 'Golden Penny Spaghetti (500g)', price: 900, link: 'https://useshop.ai/products/spaghetti', image: 'https://useshop.ai/images/spaghetti.jpg' },
  { title: 'iPhone 15 Pro Max (256GB)', price: 1850000, link: 'https://useshop.ai/products/iphone15', image: 'https://useshop.ai/images/iphone15.jpg' },
  { title: 'Nike Air Max Sneakers', price: 120000, link: 'https://useshop.ai/products/nike-air-max', image: 'https://useshop.ai/images/nike.jpg' },
  { title: 'Sony WH-1000XM5 Wireless Headphones', price: 420000, link: 'https://useshop.ai/products/sony-headphones', image: 'https://useshop.ai/images/sony.jpg' },
];

@Injectable()
export class SearchTool {
  private readonly logger = new Logger(SearchTool.name);

  constructor(private readonly configService: ConfigService) {}

  async searchProducts(query: string) {
    const apiKey = this.configService.get<string>('SERPAPI_API_KEY');
    if (!apiKey) {
      this.logger.warn('SERPAPI_API_KEY not set. Returning mock search results.');
      return this.fallbackSearch(query);
    }

    try {
      const response = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google_shopping',
          q: query,
          api_key: apiKey,
          hl: 'en',
          gl: 'ng', // Targeting Nigeria
        },
      });

      return response.data.shopping_results || this.fallbackSearch(query);
    } catch (error) {
      this.logger.error(
        'Failed to search products via SerpAPI. Fallback to mock search.',
        error.response?.data ? JSON.stringify(error.response.data) : error.message,
      );
      return this.fallbackSearch(query);
    }
  }

  private fallbackSearch(query: string) {
    const normalized = query.toLowerCase().trim();
    const matches = MOCK_PRODUCTS.filter(p => 
      p.title.toLowerCase().includes(normalized) || 
      normalized.includes(p.title.toLowerCase().split(' ')[0])
    );
    return matches.length > 0 ? matches : MOCK_PRODUCTS.slice(0, 3);
  }
}
