// Stand-in for `next/server` (OURS): a response is {status, body}; the harness reads both.
export class NextResponse {
  constructor(
    readonly body: unknown,
    readonly status: number,
  ) {}

  static json(body: unknown, init?: { status?: number }): NextResponse {
    return new NextResponse(body, init?.status ?? 200);
  }
}
