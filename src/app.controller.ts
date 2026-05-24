import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import type { HealthCheckDto } from './app.service';

@Controller('api')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth(): Promise<HealthCheckDto> {
    return this.appService.getHealth();
  }
}
