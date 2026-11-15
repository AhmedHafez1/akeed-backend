import type { Server } from 'node:http';
import {
  Controller,
  Get,
  Injectable,
  Module,
  UnauthorizedException,
  UseGuards,
  type INestApplication,
  type CanActivate,
  type NestModule,
  type MiddlewareConsumer,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RequestContextMiddleware } from './request-context.middleware';
import { currentRequestContext, recordQuery } from './request-context';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ServerTimingInterceptor } from '../interceptors/server-timing.interceptor';

@Injectable()
class RejectGuard implements CanActivate {
  canActivate(): boolean {
    recordQuery('select 1', 12);
    currentRequestContext()!.authMs = 13;
    throw new UnauthorizedException();
  }
}
@Controller()
class TimingController {
  @Get('ok') ok() {
    recordQuery('select 1', 8);
    return { ok: true };
  }
  @Get('denied') @UseGuards(RejectGuard) denied() {
    return {};
  }
  @Get('error') error() {
    throw new UnauthorizedException();
  }
}
@Module({
  controllers: [TimingController],
  providers: [
    RejectGuard,
    { provide: APP_INTERCEPTOR, useClass: ServerTimingInterceptor },
  ],
})
class TimingModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
describe('request timings across the HTTP pipeline', () => {
  let app: INestApplication<Server>;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TimingModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each([
    ['ok', 200],
    ['denied', 401],
    ['error', 401],
    ['missing', 404],
  ])('sets numeric timings on %s', async (path, status) => {
    const result = await request(app.getHttpServer())
      .get(`/${path}`)
      .expect(status);
    const header = result.headers['server-timing'];
    expect(header).toMatch(/^(?:[a-z]+;dur=\d+)(?:, [a-z]+;dur=\d+)*$/);
    if (path === 'denied') expect(header).toContain('auth;dur=13');
    if (path === 'denied') expect(header).toContain('db;dur=12');
  });
});
