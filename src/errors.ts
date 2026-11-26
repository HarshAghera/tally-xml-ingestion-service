// An error that is safe to show to API clients as { error: { code, message } }.
// Never put raw XML, stack traces or file paths in the message.
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
