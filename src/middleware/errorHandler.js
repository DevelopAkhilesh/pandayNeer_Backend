import { env } from '../config/env.js';

export class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

function handlePrismaError(err) {
  // Prisma known request errors carry a `code` like P2002, P2025, etc.
  if (err.code === 'P2002') {
    const fields = err.meta?.target?.join(', ') ?? 'field';
    return new AppError(`A record with this ${fields} already exists`, 409);
  }

  if (err.code === 'P2025') {
    return new AppError('Record not found', 404);
  }

  if (err.code === 'P2003') {
    return new AppError('Invalid reference to a related record', 400);
  }

  return null;
}

export function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

// Four parameters are required: Express uses arity to tell error middleware
// from ordinary middleware. Dropping `_next` silently stops this running.
export function errorHandler(err, req, res, _next) {
  let error = err;

  const prismaError = err.code ? handlePrismaError(err) : null;
  if (prismaError) {
    error = prismaError;
  }

  if (err.name === 'ZodError') {
    error = new AppError('Validation failed', 400, err.issues);
  }

  const statusCode = error.statusCode ?? 500;
  const message = error.isOperational ? error.message : 'Something went wrong';

  if (!error.isOperational) {
    console.error('🔥 Unexpected error:', err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(error.details ? { details: error.details } : {}),
    ...(env.NODE_ENV === 'development' && !error.isOperational
      ? { stack: err.stack }
      : {}),
  });
}
