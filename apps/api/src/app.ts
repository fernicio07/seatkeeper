import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  CheckoutService,
  type CheckoutDeps,
  type ServiceErrorCode,
  type ServiceResult,
  type Surface,
} from './domain/checkout-service';
import type { StubInventoryService, StubPaymentGateway, OffsetClock, StubClock } from './services/stubs';

// HTTP is a thin adapter: validate input, call the service, map the result.
// No business rules live in this file.

// Error code → HTTP status. 409 means "your view is stale, here's the truth";
// 410 Gone means the session can never proceed.
const HTTP_STATUS: Record<ServiceErrorCode, number> = {
  NOT_FOUND: 404,
  LISTING_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  PRICE_MISMATCH: 409,
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_KEY_MISMATCH: 422,
  SESSION_EXPIRED: 410,
  SEAT_UNAVAILABLE: 409,
  BUSY: 503,
};

// Every response — success or failure — carries the current session when one
// exists, so a client can always re-render from server truth. `serverTime` is
// the API's clock (the one that decides expiry), so clients can render a
// countdown against the authority instead of their own possibly-wrong clock.
function send(reply: FastifyReply, result: ServiceResult, serverTime: number, okStatus = 200) {
  if (result.ok) {
    return reply.code(okStatus).send({
      session: result.session,
      listing: result.listing,
      serverTime,
      ...(result.replayed ? { replayed: true } : {}),
    });
  }
  return reply.code(HTTP_STATUS[result.error]).send({
    error: result.error,
    session: result.session ?? null,
    listing: result.listing ?? null,
    serverTime,
  });
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export interface DevControls {
  inventory: StubInventoryService;
  payments: StubPaymentGateway;
  clock: OffsetClock | StubClock;
}

export function buildApp(deps: CheckoutDeps, opts: { dev?: DevControls; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const checkout = new CheckoutService(deps);
  const now = () => deps.clock.now();

  app.post<{ Body: { listingId: string } }>('/checkout', {
    schema: {
      body: {
        type: 'object',
        required: ['listingId'],
        additionalProperties: false,
        properties: { listingId: { type: 'string', minLength: 1 } },
      },
    },
    handler: async (req, reply) => send(reply, await checkout.create(req.body.listingId), now(), 201),
  });

  // Resume. Safe to call from any surface, any number of times: it only
  // reconciles the session with the world (expiry, price, hold).
  app.get<{ Params: { id: string }; Querystring: { surface?: Surface } }>('/checkout/:id', {
    schema: {
      params: idParams,
      querystring: { type: 'object', properties: { surface: { enum: ['web', 'mobile'] } } },
    },
    handler: async (req, reply) =>
      send(reply, await checkout.resume(req.params.id, req.query.surface ?? 'web'), now()),
  });

  app.post<{ Params: { id: string }; Body: { expectedVersion: number; acceptedPrice: number } }>(
    '/checkout/:id/pay',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['expectedVersion', 'acceptedPrice'],
          additionalProperties: false,
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            acceptedPrice: { type: 'integer', minimum: 0 },
          },
        },
      },
      handler: async (req, reply) => send(reply, await checkout.pay(req.params.id, req.body), now()),
    },
  );

  app.post<{
    Params: { id: string };
    Body: { expectedVersion: number; idempotencyKey: string; acceptedPrice: number };
  }>(
    '/checkout/:id/complete',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['expectedVersion', 'idempotencyKey', 'acceptedPrice'],
          additionalProperties: false,
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            idempotencyKey: { type: 'string', minLength: 1 },
            acceptedPrice: { type: 'integer', minimum: 0 },
          },
        },
      },
      handler: async (req, reply) => send(reply, await checkout.complete(req.params.id, req.body), now()),
    },
  );

  // Read-only helper so the landing page can show the event before a session exists.
  app.get<{ Params: { id: string } }>('/listings/:id', {
    schema: { params: idParams },
    handler: async (req, reply) => {
      const listing = await deps.inventory.getListing(req.params.id);
      if (!listing) return reply.code(404).send({ error: 'LISTING_NOT_FOUND' });
      return { listing, available: await deps.inventory.isAvailable(listing.id) };
    },
  });

  // Client-side analytics (moments only the UI sees). Whitelisted names, so
  // this can't become a free-form write endpoint. 204: fire-and-forget.
  app.post<{
    Body: { name: string; sessionId: string; surface: Surface; props?: Record<string, unknown> };
  }>('/events', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'sessionId', 'surface'],
        additionalProperties: false,
        properties: {
          name: { enum: ['price_banner_shown', 'price_banner_acknowledged'] },
          sessionId: { type: 'string', minLength: 1, maxLength: 64 },
          surface: { enum: ['web', 'mobile'] },
          props: { type: 'object' },
        },
      },
    },
    handler: async (req, reply) => {
      const { name, sessionId, surface, props } = req.body;
      deps.analytics.track({ name, sessionId, at: now(), props: { ...props, surface } });
      return reply.code(204).send();
    },
  });

  if (opts.dev) registerDevRoutes(app, opts.dev);
  return app;
}

// Demo levers. Only registered when explicitly enabled — never in production.
function registerDevRoutes(app: FastifyInstance, dev: DevControls) {
  app.post<{ Params: { listingId: string }; Body: { price: number } }>('/dev/listings/:listingId/price', {
    schema: {
      body: { type: 'object', required: ['price'], properties: { price: { type: 'integer', minimum: 0 } } },
    },
    handler: async (req) => {
      dev.inventory.setPrice(req.params.listingId, req.body.price);
      return { listingId: req.params.listingId, price: req.body.price };
    },
  });

  app.post<{ Body: { ms: number } }>('/dev/clock/advance', {
    schema: { body: { type: 'object', required: ['ms'], properties: { ms: { type: 'integer' } } } },
    handler: async (req) => {
      dev.clock.advance(req.body.ms);
      return { now: dev.clock.now() };
    },
  });

  app.post<{ Body: { outcome: 'succeeded' | 'declined' } }>('/dev/payments/next-outcome', {
    schema: {
      body: {
        type: 'object',
        required: ['outcome'],
        properties: { outcome: { enum: ['succeeded', 'declined'] } },
      },
    },
    handler: async (req) => {
      dev.payments.nextOutcome = req.body.outcome;
      return { nextOutcome: req.body.outcome };
    },
  });

  app.post<{ Params: { holdId: string } }>('/dev/holds/:holdId/revoke', {
    schema: { params: { type: 'object', required: ['holdId'], properties: { holdId: { type: 'string' } } } },
    handler: async (req) => {
      dev.inventory.revokeHold(req.params.holdId);
      return { revoked: req.params.holdId };
    },
  });

  // Seats back on sale at seed prices — so the demo can be run repeatedly.
  app.post('/dev/reset', async () => {
    dev.inventory.reset();
    dev.payments.nextOutcome = 'succeeded';
    return { reset: true };
  });
}
