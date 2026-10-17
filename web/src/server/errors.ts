export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function unavailable(): never {
  throw new ApiError(503, "service_unavailable");
}
