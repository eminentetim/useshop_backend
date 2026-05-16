import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class SearchTool {
  private readonly logger = new Logger(SearchTool.name);

  constructor(private readonly configService: ConfigService) {}

  async searchProducts(query: string) {
    const apiKey = this.configService.get<string>('SERPAPI_API_KEY');
    if (!apiKey) {
      this.logger.warn('SERPAPI_API_KEY not set. Returning empty search results.');
      return [];
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

      return response.data.shopping_results || [];
    } catch (error) {
      this.logger.error('Failed to search products via SerpAPI', error.message);
      return [];
    }
  }
}
