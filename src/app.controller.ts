import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppService } from './app.service';
import type { HealthCheckDto } from './app.service';

@Controller('api')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * The deploy healthcheck: a new deployment takes traffic only once this
   * answers 200, so a database it cannot reach answers 503.
   */
  @SkipThrottle()
  @Get('health')
  async getHealth(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthCheckDto> {
    const health = await this.appService.getHealth();
    if (health.status !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return health;
  }
}
