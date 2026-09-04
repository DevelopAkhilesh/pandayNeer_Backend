/**
 * Request validation from zod schemas.
 *
 * Usage — schemas live next to the module they belong to, and the middleware is
 * wired in the routes file so a reader sees what an endpoint accepts in the same
 * place they see its rate limits:
 *
 *   router.post('/orders', requireAuth, validate(createOrderSchema), createOrder);
 *
 * where createOrderSchema is `{ body?, params?, query? }` of zod schemas. Any
 * key you omit is simply not parsed.
 */

/**
 * Returns middleware that parses request input and exposes the result as
 * `req.valid`. Handlers should read from there, never from req.body again —
 * that is the whole point, and a handler that reaches back to req.body is
 * reading input nothing checked.
 *
 * Why `req.valid` rather than assigning back over req.body / req.query: in
 * Express 5 `req.query` is a getter with no setter, so `req.query = parsed`
 * throws a TypeError at runtime. req.body is writable, but writing to one and
 * not the other would leave handlers reading validated data from one place and
 * raw data from another. One place, always.
 *
 * ZodError is deliberately not caught here. errorHandler already maps it to a
 * 400 with the issue list as `details`, and Express 5 forwards throws from
 * middleware on its own, so no asyncHandler wrapper is needed.
 *
 * Note that z.object() strips keys the schema does not declare rather than
 * rejecting them. That is the behaviour you want: it means a handler can pass
 * `req.valid.body` to Prisma without a client-supplied `role` or `status`
 * riding along.
 */
export function validate({ body, params, query } = {}) {
  return (req, _res, next) => {
    req.valid = {
      // req.body is undefined when express.json() saw an empty body, and
      // `.parse(undefined)` fails with a confusing top-level type error rather
      // than naming the missing field.
      ...(body ? { body: body.parse(req.body ?? {}) } : {}),
      ...(params ? { params: params.parse(req.params) } : {}),
      ...(query ? { query: query.parse(req.query) } : {}),
    };

    next();
  };
}
