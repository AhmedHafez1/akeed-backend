import express, { json, type Request, type Response } from 'express';
import request from 'supertest';
import { WOOCOMMERCE_WEBHOOK_PATH } from '../../../shared/config/woocommerce.config';
import {
  WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES,
  wooCommerceWebhookBodyParser,
} from './woocommerce-webhook.edge';

/**
 * The edge in front of the app-wide JSON parser, as `main.ts` mounts it. The
 * route answers what it was handed, so a body the JSON parser would have
 * refused is seen to reach it.
 */
function app() {
  const server = express();
  server.use(WOOCOMMERCE_WEBHOOK_PATH, wooCommerceWebhookBodyParser);
  server.use(json());
  const echo = (req: Request, res: Response) => {
    const body: unknown = req.body;
    res.json(
      Buffer.isBuffer(body)
        ? { raw: true, bytes: body.length, text: body.toString('utf8') }
        : { raw: false, body },
    );
  };
  server.post(`${WOOCOMMERCE_WEBHOOK_PATH}/:token`, echo);
  server.post('/api/other', echo);
  return server;
}

const DELIVERY = `${WOOCOMMERCE_WEBHOOK_PATH}/token`;

describe('WooCommerce webhook edge', () => {
  it.each([
    ['JSON', 'application/json', '{"id":727,"total":"10.00"}'],
    ['JSON that does not parse', 'application/json', '{"id":'],
    ['a form', 'application/x-www-form-urlencoded', 'webhook_id=7'],
    ['plain text', 'text/plain', 'ping'],
    ['an unknown type', 'application/x-something', 'whatever'],
  ])(
    'hands the route the exact bytes of %s',
    async (_label, contentType, body) => {
      const response = await request(app())
        .post(DELIVERY)
        .set('Content-Type', contentType)
        .send(body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        raw: true,
        bytes: Buffer.byteLength(body),
        text: body,
      });
    },
  );

  it('lets a request with no body through', async () => {
    const response = await request(app()).post(DELIVERY);

    expect(response.status).toBe(200);
  });

  it('refuses a body over the limit', async () => {
    const response = await request(app())
      .post(DELIVERY)
      .set('Content-Type', 'application/json')
      .send(Buffer.alloc(WOOCOMMERCE_WEBHOOK_MAX_BODY_BYTES + 1, 0x61));

    expect(response.status).toBe(413);
  });

  it('leaves every other route to the app-wide parser', async () => {
    const parsed = await request(app())
      .post('/api/other')
      .set('Content-Type', 'application/json')
      .send('{"a":1}');
    const malformed = await request(app())
      .post('/api/other')
      .set('Content-Type', 'application/json')
      .send('{"a":');

    expect(parsed.body).toEqual({ raw: false, body: { a: 1 } });
    expect(malformed.status).toBe(400);
  });
});
