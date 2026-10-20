import type { PipeTransform } from '@nestjs/common';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { HttpError } from './rooms.js';

/**
 * Validates a body or a route's parameters against a TypeBox schema, the way Fastify validated these routes before Nest:
 * unknown properties are dropped and simple types coerced, then any mismatch is a 400 naming the first problem.
 */
export class TypeBoxPipe<T extends TSchema> implements PipeTransform<unknown, Static<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): Static<T> {
    const prepared = Value.Convert(this.schema, Value.Clean(this.schema, structuredClone(value ?? {})));
    if (Value.Check(this.schema, prepared)) return prepared;
    const first = Value.Errors(this.schema, prepared).First();
    throw new HttpError(400, 'bad_request', first ? `${first.path || '/'} ${first.message}` : 'Invalid request.');
  }
}
