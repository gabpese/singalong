/** An error a route answers as is: the status, with `{ error: code, message }` (see http-error.filter.ts). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
