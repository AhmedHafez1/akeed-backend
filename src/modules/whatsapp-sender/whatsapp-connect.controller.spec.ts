import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WhatsappConnectController } from './whatsapp-connect.controller';
import { whatsappConnectError } from './whatsapp-connect.errors';
import { WhatsappConnectService } from './whatsapp-connect.service';

const TICKET = 'A'.repeat(43);
const CODE = 'AQD-fake-login-code';

const http = (app: INestApplication) =>
  request(app.getHttpServer() as Parameters<typeof request>[0]);

describe('/api/whatsapp-connect', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  const connect = { claimTicket: jest.fn(), completeSignup: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [WhatsappConnectController],
      providers: [{ provide: WhatsappConnectService, useValue: connect }],
    }).compile();
    app = module.createNestApplication();
    // The app-wide pipe from main.ts, which the route pipes must win over.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    connect.claimTicket.mockReset();
    connect.completeSignup.mockReset();
  });

  it('needs no session: the ticket in the body is the only credential', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WhatsappConnectController),
    ).toBeUndefined();
  });

  it('claims with the ticket from the body, uncached', async () => {
    connect.claimTicket.mockResolvedValue({ signupTicket: 'B'.repeat(43) });
    await http(app)
      .post('/api/whatsapp-connect/claim')
      .send({ ticket: TICKET })
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(connect.claimTicket).toHaveBeenCalledWith(TICKET);
  });

  it.each([
    {},
    { ticket: 'short' },
    { ticket: `${'A'.repeat(42)}=` },
    { ticket: TICKET, orgId: 'x' },
  ])('refuses claim body %o with the connect code', async (body) => {
    const response = await http(app)
      .post('/api/whatsapp-connect/claim')
      .send(body)
      .expect(400);
    expect(response.body).toMatchObject({
      code: 'WHATSAPP_CONNECT_INVALID_REQUEST',
    });
    expect(JSON.stringify(response.body)).not.toContain('short');
    expect(connect.claimTicket).not.toHaveBeenCalled();
  });

  it('passes the service’s coded refusal through unchanged', async () => {
    connect.claimTicket.mockRejectedValue(
      whatsappConnectError('WHATSAPP_CONNECT_TICKET_INVALID'),
    );
    const response = await http(app)
      .post('/api/whatsapp-connect/claim')
      .send({ ticket: TICKET })
      .expect(401);
    expect(response.body).toMatchObject({
      code: 'WHATSAPP_CONNECT_TICKET_INVALID',
    });
  });

  it('completes with typed hints', async () => {
    connect.completeSignup.mockResolvedValue({
      state: 'connecting',
      displayPhoneNumber: '+20 100',
      signupPath: 'coexistence',
    });
    const body = {
      signupTicket: TICKET,
      code: CODE,
      wabaIds: ['102290129340398'],
      phoneNumberId: '106540352242922',
      isOnBusinessApp: true,
    };
    const response = await http(app)
      .post('/api/whatsapp-connect/complete')
      .send(body)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(connect.completeSignup).toHaveBeenCalledWith(
      expect.objectContaining(body),
    );
    expect(response.body).toEqual({
      state: 'connecting',
      displayPhoneNumber: '+20 100',
      signupPath: 'coexistence',
    });
  });

  it.each([
    { signupTicket: TICKET },
    { signupTicket: TICKET, code: '' },
    { signupTicket: TICKET, code: 'has space' },
    { signupTicket: TICKET, code: 'x'.repeat(2049) },
    { signupTicket: TICKET, code: CODE, wabaIds: ['not-an-id'] },
    { signupTicket: TICKET, code: CODE, wabaIds: Array(11).fill('1') },
    { signupTicket: TICKET, code: CODE, phoneNumberId: '1; drop' },
    { signupTicket: TICKET, code: CODE, isOnBusinessApp: 'yes' },
    { signupTicket: TICKET, code: CODE, accessToken: 'EAAG' },
  ])('refuses complete body %# with the connect code', async (body) => {
    const response = await http(app)
      .post('/api/whatsapp-connect/complete')
      .send(body)
      .expect(400);
    expect(response.body).toMatchObject({
      code: 'WHATSAPP_CONNECT_INVALID_REQUEST',
    });
    expect(connect.completeSignup).not.toHaveBeenCalled();
  });
});
