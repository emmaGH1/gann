import { handle } from "@/server/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Supports two bounded, identical-body PayAI settlement polls plus durable Redis commits.
export const maxDuration = 60;
export const GET = handle;
// Explicit HEAD prevents Next's automatic GET fallback on a payment resource.
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
