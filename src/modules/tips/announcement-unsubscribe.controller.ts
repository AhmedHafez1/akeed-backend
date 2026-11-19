import { Controller, Get, Header, HttpCode, Post, Query } from '@nestjs/common';
import { AnnouncementUnsubscribeService } from './announcement-unsubscribe.service';
@Controller('api/announcements/unsubscribe')
export class AnnouncementUnsubscribeController {
  constructor(
    private readonly unsubscribeService: AnnouncementUnsubscribeService,
  ) {}
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  read(@Query('token') token: string | undefined) {
    return this.unsubscribeService.read(token);
  }
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  unsubscribe(@Query('token') token: string | undefined) {
    return this.unsubscribeService.unsubscribe(token);
  }
}
