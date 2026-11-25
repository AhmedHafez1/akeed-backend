import { Controller, Get, Header } from '@nestjs/common';
import type { PublicStatsDto } from './dto/public-stats.dto';
import { PublicStatsService } from './public-stats.service';

/** Unauthenticated on purpose: the homepage shows these aggregates. */
@Controller('api/public')
export class PublicStatsController {
  constructor(private readonly publicStats: PublicStatsService) {}

  @Get('stats')
  @Header('Cache-Control', 'public, max-age=300')
  getStats(): Promise<PublicStatsDto> {
    return this.publicStats.getStats();
  }
}
