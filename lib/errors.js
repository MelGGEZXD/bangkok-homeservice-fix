// The one typed-error hierarchy. Every service and route throws AppError (or a subclass) instead
// of writing a response directly, so the JSON error shape is guaranteed consistent across all
// eight bounded contexts. lib/http/respond.js is the single place that maps these to HTTP.
export class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "bad request", details) {
    super(400, message, details);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "conflict", details) {
    super(409, message, details);
    this.name = "ConflictError";
  }
}

// A call to an extracted service failed or timed out. 502 tells the client the monolith is fine,
// but the upstream boundary is not — distinct from a 500 inside the monolith itself.
export class BadGatewayError extends AppError {
  constructor(message = "upstream service unavailable", details) {
    super(502, message, details);
    this.name = "BadGatewayError";
  }
}
