import type { PipeTransform } from '@nestjs/common';
import type { Static, TSchema } from '@sinclair/typebox';
import { Ajv, type ValidateFunction } from 'ajv';
import { HttpError } from './rooms.js';

/**
 * The validator Fastify uses for its routes, with Fastify's default options: simple types are coerced (a query's "2" becomes
 * 2, but 1.5 is not an integer), unknown properties are dropped where a schema forbids them, and defaults are filled in.
 * A TypeBox schema is a JSON Schema, so the Nest routes validate exactly as the Fastify routes did.
 */
const ajv = new Ajv({ coerceTypes: 'array', useDefaults: true, removeAdditional: true, addUsedSchema: false, allErrors: false });
const compiled = new WeakMap<TSchema, ValidateFunction>();

/** Validates a body, a query or a route's parameters against a TypeBox schema; a mismatch is a 400 naming the problem. */
export class TypeBoxPipe<T extends TSchema> implements PipeTransform<unknown, Static<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): Static<T> {
    let validate = compiled.get(this.schema);
    if (!validate) {
      validate = ajv.compile(this.schema);
      compiled.set(this.schema, validate);
    }
    const data = structuredClone(value ?? {}); // Ajv coerces and drops properties in place
    if (validate(data)) return data as Static<T>;
    const [first] = validate.errors ?? [];
    throw new HttpError(400, 'bad_request', first ? `${first.instancePath || '/'} ${first.message}` : 'Invalid request.');
  }
}
